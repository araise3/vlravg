//! Container-level smoke test over a local replay corpus: every file's
//! preamble, full chunk walk, Event chunks against the measured layouts, and
//! first ReplayData decompression. It never reaches a field; the decode sweeps
//! are listed in CONTRIBUTING.md. `VRFKIT_CORPUS_DIR` names the machine-local
//! corpus, and `VRFKIT_REQUIRE_CORPUS` turns the skip when it is absent into a
//! failure.

use std::path::{Path, PathBuf};

use vrf_container::{
    ChunkIterator, ChunkType, KNOWN_EVENT_GROUPS, decompress_replay_data_with_trailing,
    event_payload_seconds_matches_time, parse_event_chunk, parse_known_event_payload,
    parse_preamble,
};

/// What one file contributed to the tally.
#[derive(Default)]
struct FileReport {
    /// Branch string from the header, when the preamble parsed.
    branch: Option<String>,
    /// A ReplayData chunk was found and decompressed.
    oodle_ok: bool,
    /// Every problem found in this file; empty means clean.
    problems: Vec<String>,
    /// Chunks whose type is none of Header, ReplayData, Checkpoint, Event.
    unknown_chunks: u64,
    event_rows: u64,
    unknown_event_groups: u64,
    /// Event payloads that matched their group's measured layout.
    known_events: u64,
    /// Largest `|payload seconds * 1000 - Time1|` among them, in ms.
    max_event_time_delta_ms: f64,
}

/// Parse one replay as far as the container layer goes, collecting problems
/// rather than stopping at the first.
fn scan_file(data: &[u8]) -> FileReport {
    let mut report = FileReport::default();
    let problems = &mut report.problems;

    let preamble = match parse_preamble(data) {
        Ok(p) => p,
        Err(e) => {
            problems.push(format!("preamble: {e}"));
            return report;
        }
    };

    report.branch = Some(preamble.header.replay_version.branch.clone());
    if preamble.header.trailing_bytes != 0 {
        problems.push(format!(
            "header: {} bytes past the parsed layout",
            preamble.header.trailing_bytes
        ));
    }

    let mut iter = ChunkIterator::new(data, preamble.remaining_offset);
    loop {
        // A chunk-header error is a malformed file, not the end of the stream.
        let chunk = match iter.next_chunk() {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                problems.push(format!("chunk: {e}"));
                break;
            }
        };

        if let ChunkType::Unknown(raw) = chunk.chunk_type {
            report.unknown_chunks += 1;
            problems.push(format!("unknown chunk type {raw}"));
            continue;
        }
        let payload = &data[chunk.data_offset..chunk.data_offset + chunk.size_in_bytes as usize];
        if chunk.chunk_type == ChunkType::Event {
            report.event_rows += 1;
            let event = match parse_event_chunk(payload) {
                Ok(event) => event,
                Err(error) => {
                    problems.push(format!("event chunk: {error}"));
                    continue;
                }
            };
            if event.trailing_bytes != 0 {
                problems.push(format!(
                    "event chunk leaves {} byte(s) after its declared payload",
                    event.trailing_bytes
                ));
                continue;
            }
            if event.time1 != event.time2 {
                problems.push("event chunk Time1 and Time2 no longer agree".to_string());
                continue;
            }
            // Keep the table's `&'static str`, never the wire string.
            let Some(known) = KNOWN_EVENT_GROUPS.iter().find(|k| k.group == event.group) else {
                report.unknown_event_groups += 1;
                continue;
            };
            // The driver's check for events.parquet: arity, tag, name and time.
            match parse_known_event_payload(known.group, event.payload)
                .filter(|parsed| event_payload_seconds_matches_time(event.time1, parsed.seconds))
            {
                Some(parsed) => {
                    report.known_events += 1;
                    let delta = (f64::from(parsed.seconds) * 1000.0 - f64::from(event.time1)).abs();
                    report.max_event_time_delta_ms = report.max_event_time_delta_ms.max(delta);
                }
                None => problems.push(format!(
                    "known event group {} no longer fits its measured layout",
                    known.group
                )),
            }
            continue;
        }

        if chunk.chunk_type != ChunkType::ReplayData || report.oodle_ok {
            continue;
        }

        // First ReplayData chunk only: this test is a container smoke test, and
        // the whole-stream pass belongs to the driver.
        match decompress_replay_data_with_trailing(
            payload,
            preamble.info.compressed,
            preamble.info.encrypted,
        ) {
            Ok((_, trailing)) => {
                report.oodle_ok = true;
                if trailing != 0 {
                    problems.push(format!(
                        "replay data: {trailing} payload bytes no reader consumed"
                    ));
                }
            }
            Err(e) => problems.push(format!("oodle: {e}")),
        }
    }
    if !report.oodle_ok {
        problems.push("no ReplayData chunk decompressed".to_string());
    }
    report
}

#[test]
fn parse_all_vrf_files() {
    // Unset means an empty path, which is not a directory: the test skips.
    let corpus = std::env::var_os("VRFKIT_CORPUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_default();
    if !corpus.is_dir() {
        let message = format!(
            "corpus directory not found at {}; set VRFKIT_CORPUS_DIR to point at one",
            corpus.display()
        );
        assert!(
            std::env::var_os("VRFKIT_REQUIRE_CORPUS").is_none(),
            "VRFKIT_REQUIRE_CORPUS is set but {message}"
        );
        eprintln!("SKIP (body not executed): {message}");
        return;
    }

    let dir: &Path = &corpus;
    let mut total = 0u32;
    let mut clean = 0u32;
    let mut branches: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut oodle_ok = 0u32;
    let mut failures: Vec<(String, String)> = Vec::new();
    let mut unknown_chunks = 0u64;
    let mut event_rows = 0u64;
    let mut unknown_event_groups = 0u64;
    let mut known_events = 0u64;
    let mut max_event_time_delta_ms = 0.0f64;

    for entry in std::fs::read_dir(dir).expect("read corpus dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("vrf") {
            continue;
        }
        total += 1;
        let filename = path.file_name().unwrap().to_string_lossy().to_string();

        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                failures.push((filename, format!("read error: {e}")));
                continue;
            }
        };

        let report = scan_file(&data);
        if let Some(branch) = report.branch {
            *branches.entry(branch).or_insert(0) += 1;
        }
        if report.oodle_ok {
            oodle_ok += 1;
        }
        if report.problems.is_empty() {
            clean += 1;
        }
        unknown_chunks += report.unknown_chunks;
        event_rows += report.event_rows;
        unknown_event_groups += report.unknown_event_groups;
        known_events += report.known_events;
        max_event_time_delta_ms = max_event_time_delta_ms.max(report.max_event_time_delta_ms);
        for problem in report.problems {
            failures.push((filename.clone(), problem));
        }
    }

    eprintln!("=== VRF Corpus Test Results ===");
    eprintln!("Total .vrf files: {total}");
    eprintln!("Clean: {clean}/{total}");
    eprintln!("Branch distribution:");
    let mut branch_list: Vec<_> = branches.iter().collect();
    branch_list.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    for (branch, count) in &branch_list {
        eprintln!("  {branch}: {count}");
    }
    eprintln!("Oodle decompress OK: {oodle_ok}");
    eprintln!("Unknown-type chunks: {unknown_chunks}");
    eprintln!(
        "Event payloads: {known_events}/{event_rows} known layouts; \
         {unknown_event_groups} unknown group(s)"
    );
    eprintln!(
        "Event payload seconds vs Time1 max absolute delta: \
         {max_event_time_delta_ms:.6} ms"
    );
    if !failures.is_empty() {
        eprintln!("Failures ({}):", failures.len());
        for (file, err) in &failures {
            eprintln!("  {file}: {err}");
        }
    }
    eprintln!("===============================");

    // An empty directory must not pass as `0 == 0`.
    assert!(
        total > 0,
        "corpus directory {} contains no .vrf files; an empty corpus is not a pass",
        dir.display()
    );
    // With files present, a clean run implies every file decompressed a
    // ReplayData chunk and every Event row was known or an unknown group.
    assert!(
        failures.is_empty(),
        "{} problem(s) across {total} files: {failures:#?}",
        failures.len()
    );
    // The unknown-group check holds as 0 == 0 if the Event path stopped
    // running (a renumbered discriminant, say); this requires that it ran.
    assert!(
        event_rows > 0,
        "no Event chunk was seen across {total} corpus files -- the Event-timeline \
         assertion below would pass vacuously"
    );
    assert_eq!(
        unknown_event_groups, 0,
        "{unknown_event_groups} Event chunk(s) use a group outside the measured vocabulary"
    );
}

/// A minimal but structurally valid replay: only enough to reach the chunk walk.
mod fixture {
    use vrf_testkit::{
        Info, add_f32, add_fstring, add_i32, add_u32, chunk, header_payload, replay_info,
    };

    /// Replay info followed by a single Header chunk, and nothing else.
    pub fn header_only_replay() -> Vec<u8> {
        with_header_residual(0)
    }

    /// `header_only_replay` with `residual` bytes after the header's layout,
    /// inside its chunk.
    pub fn with_header_residual(residual: usize) -> Vec<u8> {
        let mut header = header_payload();
        header.resize(header.len() + residual, 0);
        let mut data = replay_info(&Info::default());
        data.extend(chunk(0, &header));
        data
    }

    /// The header-only replay plus one ReplayData chunk. The info section
    /// says uncompressed, so its data is stored as-is: SizeInBytes equals
    /// MemorySizeInBytes.
    pub fn minimal_replay() -> Vec<u8> {
        with_replay_data_residual(0)
    }

    /// `minimal_replay` with `residual` bytes after the ReplayData chunk's
    /// data, inside the chunk.
    pub fn with_replay_data_residual(residual: usize) -> Vec<u8> {
        let mut payload = Vec::new();
        add_u32(&mut payload, 0); // Time1
        add_u32(&mut payload, 47); // Time2
        add_i32(&mut payload, 4); // SizeInBytes
        add_i32(&mut payload, 4); // MemorySizeInBytes
        payload.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        payload.resize(payload.len() + residual, 0xCD);
        let mut data = header_only_replay();
        data.extend(chunk(1, &payload));
        data
    }

    /// `minimal_replay` plus one `roundStarted` Event chunk at 62 ms whose
    /// payload carries `tag`; 2 is the measured one.
    pub fn with_round_start_tag(tag: u32) -> Vec<u8> {
        let mut body = Vec::new();
        add_u32(&mut body, tag);
        add_u32(&mut body, 0); // the group's one word
        add_fstring(&mut body, "EReplayEventGroup::RoundStart");
        add_f32(&mut body, 0.062); // seconds
        let mut event = Vec::new();
        for field in ["id", "roundStarted", "0"] {
            add_fstring(&mut event, field);
        }
        add_u32(&mut event, 62); // Time1
        add_u32(&mut event, 62); // Time2
        add_i32(&mut event, body.len() as i32);
        event.extend(body);
        let mut data = minimal_replay();
        data.extend(chunk(3, &event));
        data
    }
}

/// The fixture itself must be clean, or the defect cases below prove nothing.
#[test]
fn the_fixture_replay_scans_without_problems() {
    let report = scan_file(&fixture::with_round_start_tag(2));
    assert!(
        report.problems.is_empty(),
        "fixture should be clean, got {:?}",
        report.problems
    );
    assert_eq!(report.branch.as_deref(), Some("++Ares-Core+release-12.10"));
    assert_eq!(report.known_events, 1);
}

/// Each defect is a problem, not a note. Real replays have shown no header or
/// ReplayData residual, so these fixtures are the only inputs those checks see.
#[test]
fn each_defect_is_reported() {
    let mut stray_bytes = fixture::minimal_replay();
    stray_bytes.extend_from_slice(&[0; 4]);
    let mut unknown_type = fixture::minimal_replay();
    unknown_type.extend(vrf_testkit::chunk(4, &[]));
    for (data, expected) in [
        (
            fixture::header_only_replay(),
            "no ReplayData chunk decompressed",
        ),
        (
            fixture::with_header_residual(2),
            "header: 2 bytes past the parsed layout",
        ),
        (
            fixture::with_replay_data_residual(3),
            "replay data: 3 payload bytes no reader consumed",
        ),
        (
            fixture::with_round_start_tag(99),
            "known event group roundStarted no longer fits its measured layout",
        ),
        (stray_bytes, "chunk:"),
        (unknown_type, "unknown chunk type 4"),
    ] {
        let problems = scan_file(&data).problems;
        assert!(
            problems.iter().any(|p| p.starts_with(expected)),
            "{expected:?} not reported, got {problems:?}"
        );
    }
}
