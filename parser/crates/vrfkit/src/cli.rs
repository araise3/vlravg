//! Argument parsing -- hand-rolled, no external dependencies.

use crate::error::CliError;
use crate::inspect;
use crate::oracle;

const USAGE: &str = "\
vrfkit -- VALORANT replay (.vrf) toolkit

USAGE:
    vrfkit inspect  <file.vrf> [--redact-identifiers]
    vrfkit validate <file.vrf> [--diagnostics]
    vrfkit diag     <file.vrf> [--json <path>] [--include-payloads]
    vrfkit export   <file.vrf> --out <dir> [--checkpoints]
                    [--compact <file> --match-id <uuid> --source-bytes <n>
                     --source-sha256 <hex> --decoder-revision <hex>
                     [--decoder-patch <hex>]]
    vrfkit solve    <file.vrf> [--threads <n>]
    vrfkit builds

GLOBAL OPTIONS:
    --transform <build>=<line>  Use this payload transform for that build,
                                e.g. 13.10=0x2c24_9eb3 0x33: sub 8, not, ...
                                (overrides the compiled registry and
                                transforms.txt for this run)

SUBCOMMANDS:
    inspect   Print replay info, header, branch, and chunk summary
              --redact-identifiers  Suppress the replay's friendly name
    validate  Run the RepLayout grammar oracle on every ReplayData content
              block. Exits 0 on a pass, 1 on any counted failure, and 2
              when the file carried no content blocks to check.
              --diagnostics  Print full context for every malformed/skipped event
    diag      Walk ReplayData and every Checkpoint chunk and aggregate every
              stream failure (kind, cause, group, function count, handle)
              into one bounded JSON document. Writes no table.
              --json  Write the aggregate to a file instead of stdout
              --include-payloads  Include bounded raw payload samples
    export    Write six Parquet tables (fields, movement, actors,
              net_guids, events, partials) + manifest.json into --out,
              which must be new, empty or hold only export output:
              anything else in it is refused, never deleted
              --checkpoints  Also parse Checkpoint chunks into
                             checkpoint_fields, checkpoint_actors,
                             checkpoint_net_guids, checkpoint_blocks,
                             checkpoint_guid_entries, checkpoint_export_groups and
                             checkpoint_export_fields
                             Parquet tables. Off by default: the
                             snapshots are ~10% of the file and a separate
                             read. fields, movement, actors, net_guids and
                             events are unaffected either way; checkpoint
                             partial rejections, if any, are added to
                             partials.
    solve     Recover the replay build's payload transform from the replay
              itself (no game code), then run the validate oracle with it.
              Exits 0 only when the oracle passes.
              --threads  Worker threads (default: all cores)
    builds    Print the builds this decoder registers as a JSON array
              (compiled, transforms.txt and --transform)
";

/// Dispatch one command line and return its exit code: 0, except that
/// `validate` is an oracle and returns its own, so `Ok` does not mean "clean".
/// See [`oracle::Verdict`].
pub fn run(args: &[String]) -> Result<u8, CliError> {
    crate::solve::load_registry()?;
    let args = &take_transform_overrides(args)?;
    if args.len() < 2 {
        return Err(CliError::Usage(USAGE.to_string()));
    }

    match args[1].as_str() {
        "inspect" => {
            let (file, [redact_identifiers], []) = parse(args, ["--redact-identifiers"], [])?;
            inspect::run(file, redact_identifiers).map(|()| 0)
        }
        "validate" => {
            let (file, [diagnostics], []) = parse(args, ["--diagnostics"], [])?;
            oracle::run(file, diagnostics).map(oracle::Verdict::exit_code)
        }
        "diag" => {
            let (file, [include_payloads], [json]) = parse(
                args,
                ["--include-payloads"],
                [("--json", "--json requires a file path")],
            )?;
            crate::diagnose::run(file, json, include_payloads).map(|()| 0)
        }
        "export" => export(args),
        "builds" => {
            println!("{}", crate::solve::builds_json());
            Ok(0)
        }
        "solve" => {
            let (file, [], [threads]) =
                parse(args, [], [("--threads", "--threads requires a number")])?;
            let threads = threads
                .map(|t| t.parse::<usize>())
                .transpose()
                .map_err(|_| CliError::Usage("--threads requires a number".into()))?;
            crate::solve::run(file, threads)
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(0)
        }
        other => Err(CliError::Usage(format!(
            "unknown subcommand: {other}\n{USAGE}"
        ))),
    }
}

/// `export` exit codes the parse sandbox maps to error codes: the replay's
/// build cannot be decoded (or does not pass the oracle), or the compact
/// document was refused.
pub const EXIT_DECODER: u8 = 10;
pub const EXIT_COMPACT: u8 = 12;

/// Remove every `--transform <build>=<line>` pair, registering each.
fn take_transform_overrides(args: &[String]) -> Result<Vec<String>, CliError> {
    let mut out = Vec::with_capacity(args.len());
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--transform" {
            let entry = rest
                .next()
                .ok_or_else(|| CliError::Usage("--transform requires <build>=<line>".into()))?;
            let (branch, spec) = crate::solve::parse_entry(entry)?;
            crate::solve::register(&branch, spec, "override");
        } else {
            out.push(arg.clone());
        }
    }
    Ok(out)
}

/// The input path, whether each flag was given, and each valued option's value.
type Parsed<'a, const F: usize, const V: usize> = (&'a str, [bool; F], [Option<&'a str>; V]);

/// Split `<subcommand> <file.vrf> [options]`. Each of `flags` may appear
/// once. Each of `valued` may appear once and takes the next argument as its
/// value, whatever it looks like; the pair's second element is the message
/// when there is none. Anything else is refused.
fn parse<'a, const F: usize, const V: usize>(
    args: &'a [String],
    flags: [&str; F],
    valued: [(&str, &str); V],
) -> Result<Parsed<'a, F, V>, CliError> {
    let file = args
        .get(2)
        .ok_or_else(|| CliError::Usage(format!("{} requires <file.vrf>", args[1])))?;
    let (mut set, mut values) = ([false; F], [None; V]);
    let mut rest = args[3..].iter();
    while let Some(arg) = rest.next() {
        let duplicate = || CliError::Usage(format!("duplicate option: {arg}"));
        if let Some(i) = flags.iter().position(|flag| arg == flag) {
            if set[i] {
                return Err(duplicate());
            }
            set[i] = true;
        } else if let Some(i) = valued.iter().position(|(option, _)| arg == option) {
            if values[i].is_some() {
                return Err(duplicate());
            }
            let value = rest
                .next()
                .ok_or_else(|| CliError::Usage(valued[i].1.to_string()))?;
            values[i] = Some(value.as_str());
        } else {
            return Err(CliError::Usage(format!(
                "unknown {} option or surplus argument: {arg}",
                args[1]
            )));
        }
    }
    Ok((file, set, values))
}

#[cfg(feature = "export")]
fn export(args: &[String]) -> Result<u8, CliError> {
    let (
        file,
        [with_checkpoints, require_pass, solve_unknown],
        [out_dir, compact, match_id, bytes, sha, revision, patch],
    ) = parse(
            args,
            ["--checkpoints", "--require-pass", "--solve-unknown"],
            [
                ("--out", "--out requires a directory path"),
                ("--compact", "--compact requires a file path"),
                ("--match-id", "--match-id requires a UUID"),
                ("--source-bytes", "--source-bytes requires a number"),
                ("--source-sha256", "--source-sha256 requires a hash"),
                ("--decoder-revision", "--decoder-revision requires a hash"),
                ("--decoder-patch", "--decoder-patch requires a hash"),
            ],
        )?;
    let out_dir =
        out_dir.ok_or_else(|| CliError::Usage("export requires --out <dir>".to_string()))?;
    // An unknown build: solve it from the replay itself when asked, and let
    // `--require-pass` (this pass's own oracle verdict) be the proof.
    let data = std::fs::read(file)?;
    let branch = vrf_container::parse_preamble(&data)?.header.replay_version.branch.clone();
    if vrf_transform::TransformVersion::from_branch(&branch).is_none() {
        if !solve_unknown {
            eprintln!("error: no payload transform is registered for {branch}");
            return Ok(EXIT_DECODER);
        }
        eprintln!("{branch} is not registered: solving its transform from the replay");
        match crate::solve::derive(&data, None)? {
            Some(best) => crate::solve::register(&branch, best.spec, "solved"),
            None => return Ok(EXIT_DECODER),
        }
    }
    drop(data);
    let transform = crate::solve::provenance(&branch)
        .map(|(source, spec)| (source.to_owned(), spec.to_string()));
    let compact = match compact {
        None => None,
        Some(out) => {
            let need = |v: Option<&str>, name: &str| {
                v.map(str::to_owned)
                    .ok_or_else(|| CliError::Usage(format!("--compact requires {name}")))
            };
            Some(crate::driver::compact::CompactMeta {
                out: out.to_owned(),
                match_id: need(match_id, "--match-id")?.to_ascii_lowercase(),
                source_bytes: need(bytes, "--source-bytes")?
                    .parse()
                    .map_err(|_| CliError::Usage("--source-bytes requires a number".into()))?,
                source_sha256: need(sha, "--source-sha256")?.to_ascii_lowercase(),
                decoder_revision: need(revision, "--decoder-revision")?.to_ascii_lowercase(),
                decoder_patch: patch.filter(|p| !p.is_empty()).map(str::to_ascii_lowercase),
                transform: transform.clone(),
            })
        }
    };
    crate::driver::run(file, out_dir, with_checkpoints, compact, require_pass)
}

/// Refusal, not silence: without the `export` feature there are no writers,
/// and printing nothing with exit 0 would look like the files were written.
#[cfg(not(feature = "export"))]
fn export(_args: &[String]) -> Result<u8, CliError> {
    Err(CliError::Usage(
        "export is not available: this binary was built without the `export` feature".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Refusals are usage errors raised before the file is opened; an
    /// accepted command line gets as far as opening the missing file.
    #[test]
    fn unknown_surplus_and_duplicate_arguments_are_refused_before_the_file() {
        const REDACT: &str = "--redact-identifiers";
        const CP: &str = "--checkpoints";
        let mut cases: Vec<(&[&str], bool)> = vec![
            (&["inspect", "m.vrf", "extra"], true),
            (&["inspect", "m.vrf", REDACT], false),
            (&["inspect", "m.vrf", REDACT, REDACT], true),
            (&["validate", "m.vrf", "--unknown"], true),
            (&["validate", "m.vrf", "other.vrf"], true),
        ];
        if cfg!(feature = "export") {
            cases.push((&["export", "m.vrf", "--out", "a", "--out", "b"], true));
            cases.push((&["export", "m.vrf", "--out", "o", CP, CP], true));
        }
        for (args, refused) in cases {
            let argv: Vec<String> = ["vrfkit"]
                .iter()
                .chain(args)
                .map(|a| a.to_string())
                .collect();
            match run(&argv) {
                Err(CliError::Usage(_)) if refused => {}
                Err(CliError::Io(_)) if !refused => {}
                other => panic!("{args:?}: {other:?}"),
            }
        }
    }
}
