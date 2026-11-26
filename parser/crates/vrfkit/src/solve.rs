//! `solve` subcommand and the text transform registry (vlravg fork).
//!
//! `solve` recovers the payload transform of a build from one of its own
//! replays ([`vrf_transform::solve`]), then proves it by running the whole
//! `validate` oracle with it. Nothing is executed but this decoder.
//!
//! The registry is `parser/transforms.txt`, compiled in: one line per build,
//! `<build> <registry line>`, e.g.
//! `13.10 0x2c24_9eb3 0x33: sub 8, not, rotl 6, swap, xor 3, not, sub 1`.
//! `--transform <build>=<line>` adds or overrides one for a single run.

use std::fs;
use std::time::Instant;

use vrf_container::parse_preamble;
use vrf_net::pipeline::ReplicationReader;
use vrf_transform::{TransformSpec, TransformVersion, solve};

use crate::error::CliError;
use crate::oracle;
use crate::pass::{Chunk, Pass, Replay, for_each_chunk};
use crate::sink::ExportStats;

const BRANCH_PREFIX: &str = "++Ares-Core+release-";

/// The compiled text registry.
pub const REGISTRY: &str = include_str!("../../../transforms.txt");

/// Where each registered branch's line came from: `registry`
/// (transforms.txt), `override` (--transform) or `solved`.
static SOURCES: std::sync::Mutex<Vec<(String, &'static str)>> = std::sync::Mutex::new(Vec::new());

/// Register `spec` for `branch`, remembering where it came from.
pub fn register(branch: &str, spec: TransformSpec, source: &'static str) {
    vrf_transform::register(branch, spec);
    let mut table = SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    table.retain(|(b, _)| b != branch);
    table.push((branch.to_owned(), source));
}

/// The transform `branch` decodes with and its provenance: `compiled`, or
/// the source [`register`] recorded.
pub fn provenance(branch: &str) -> Option<(&'static str, TransformSpec)> {
    let version = TransformVersion::from_branch(branch)?;
    let source = match version {
        TransformVersion::Custom(_) => {
            let table = SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            table.iter().find(|(b, _)| b == branch).map_or("override", |(_, s)| *s)
        }
        _ => "compiled",
    };
    Some((source, version.spec()))
}

/// Parse one `<build> <line>` registry entry (or `<build>=<line>`).
pub fn parse_entry(entry: &str) -> Result<(String, TransformSpec), CliError> {
    let entry = entry.trim();
    let (build, line) = entry
        .split_once('=')
        .or_else(|| entry.split_once(char::is_whitespace))
        .ok_or_else(|| CliError::Usage(format!("transform entry needs '<build> <line>': {entry}")))?;
    let build = build.trim();
    if build.is_empty() || !build.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(CliError::Usage(format!("bad build '{build}' in transform entry")));
    }
    let spec = TransformSpec::parse(line.trim()).map_err(|e| CliError::Usage(e.to_string()))?;
    Ok((format!("{BRANCH_PREFIX}{build}"), spec))
}

/// Register every line of [`REGISTRY`]. A malformed line is a build error in
/// waiting, so it is refused here and by the unit test below.
pub fn load_registry() -> Result<(), CliError> {
    for line in REGISTRY.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (branch, spec) = parse_entry(line)?;
        register(&branch, spec, "registry");
    }
    Ok(())
}

/// Every build with a transform, as a sorted JSON array of strings.
pub fn builds_json() -> String {
    let mut builds: Vec<String> = vrf_transform::ALL_VERSIONS
        .iter()
        .map(|v| v.branch().trim_start_matches(BRANCH_PREFIX).to_owned())
        .collect();
    let table = SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    builds.extend(table.iter().map(|(b, _)| b.trim_start_matches(BRANCH_PREFIX).to_owned()));
    let key = |b: &String| -> Vec<u32> { b.split('.').filter_map(|p| p.parse().ok()).collect() };
    builds.sort_by_key(key);
    builds.dedup();
    let quoted: Vec<String> = builds.iter().map(|b| format!("\"{b}\"")).collect();
    format!("[{}]", quoted.join(","))
}

/// Whether two specs compute the same transform, on random blocks of every
/// staging shape. Different step lists can be the same function.
fn same_function(a: TransformVersion, b: TransformVersion) -> bool {
    let mut x: u64 = 0x0123_4567_89ab_cdef;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for bits in [1usize, 7, 8, 9, 15, 31, 32, 33, 63, 64, 65, 72, 100, 127, 128, 300] {
        for _ in 0..64 {
            let seed = next() as u32;
            let mut p: Vec<u8> = (0..bits.div_ceil(8)).map(|_| next() as u8).collect();
            let mut q = p.clone();
            if a.apply(&mut p, bits, seed).is_err() || b.apply(&mut q, bits, seed).is_err() || p != q
            {
                return false;
            }
        }
    }
    true
}

/// Recover the transform of `data`'s build: the best candidate, or `None`.
/// Not yet proven: the caller runs the oracle with it.
pub fn derive(data: &[u8], threads: Option<usize>) -> Result<Option<solve::Scored>, CliError> {
    let start = Instant::now();
    let preamble = parse_preamble(data)?;
    let replay = Replay::new(&preamble);

    // Capture: framing is plaintext, so any transform frames the stream.
    let mut reader = ReplicationReader::with_transform(TransformVersion::V1301);
    reader.enable_capture();
    let mut pass = Pass::with_reader(&replay, reader);
    let mut sink = ExportStats::default();
    for_each_chunk(data, &replay, |chunk| {
        if let Chunk::ReplayData(frames, _) = chunk {
            pass.walk(&frames, &mut sink, |_| Ok(()))?;
        }
        Ok(())
    })?;
    let capture = pass
        .reader
        .take_capture()
        .ok_or_else(|| CliError::Usage("capture was not enabled".into()))?;
    eprintln!(
        "captured {} encoded RepLayout blocks ({} not kept) in {:.2}s",
        capture.blocks.len(),
        capture.dropped,
        start.elapsed().as_secs_f64()
    );

    let mut opts = solve::Options::default();
    if let Some(n) = threads {
        opts.threads = n.max(1);
    }
    let outcome = solve::solve(&capture.blocks, &opts)
        .map_err(|e| CliError::Usage(format!("solve failed: {e}")))?;
    eprintln!(
        "solved in {:.1}s: {} candidate(s) from {} step list(s)",
        start.elapsed().as_secs_f64(),
        outcome.candidates.len(),
        outcome.step_lists.len()
    );
    for c in outcome.candidates.iter().take(5) {
        eprintln!("  {}  walks {}/{}", c.spec, c.walked, c.sampled);
    }
    Ok(outcome.candidates.into_iter().next())
}

/// Run `solve`. Exit 0 only when a candidate passes the whole oracle.
pub fn run(path: &str, threads: Option<usize>) -> Result<u8, CliError> {
    let start = Instant::now();
    let data = fs::read(path)?;
    let branch = parse_preamble(&data)?.header.replay_version.branch.clone();
    eprintln!("branch: {branch}");
    let known = TransformVersion::from_branch(&branch);
    let best = derive(&data, threads)?;
    let Some(best) = best else {
        println!("NO CANDIDATE");
        return Ok(1);
    };

    // Proof: the whole ReplayData stream through the oracle.
    register(&branch, best.spec, "solved");
    let verdict = oracle::run(path, false)?;
    let build = branch.trim_start_matches(BRANCH_PREFIX);
    println!();
    println!("=== Transform solve ===");
    println!("  Line:      {build} {}", best.spec);
    println!("  Walks:     {}/{} sampled blocks", best.walked, best.sampled);
    println!("  Oracle:    {verdict:?}");
    if let Some(known) = known {
        let same = same_function(known, TransformVersion::Custom(best.spec));
        println!("  Registered transform for this branch: {}", if same { "identical" } else { "DIFFERENT" });
    }
    println!("  Elapsed:   {:.1}s", start.elapsed().as_secs_f64());
    Ok(if verdict == oracle::Verdict::Passed { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compiled_registry_parses() {
        for line in REGISTRY.lines().map(str::trim) {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            parse_entry(line).unwrap();
        }
    }

    #[test]
    fn entries_take_either_separator() {
        let line = "0x2c24_9eb3 0x33: sub 8, not, rotl 6, swap, xor 3, not, sub 1";
        let a = parse_entry(&format!("13.10 {line}")).unwrap();
        let b = parse_entry(&format!("13.10={line}")).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.0, "++Ares-Core+release-13.10");
        assert!(parse_entry("x.y 0x1 0x0: not").is_err());
        assert!(parse_entry("13.10").is_err());
    }
}
