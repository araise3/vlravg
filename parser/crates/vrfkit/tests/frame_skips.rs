//! The frame-walk tallies -- frames, skipped section bytes and non-finite
//! frame times -- followed from the DemoFrame walk to every output.
//!
//! Five passes carry `walk_demo_frames`' tallies to an output with one line
//! of glue each: export's main and checkpoint passes (summary and manifest),
//! `validate`, and `diag`'s two passes. The values are 0 on every replay
//! measured, so no corpus guard sees a cut line. This runs the real binary on
//! an uncompressed replay whose frames carry both sections, two chunks per
//! pass. The two passes differ on every value, and each pass's frame count
//! differs from its chunk count, so a swapped pass or a per-chunk frame count
//! cannot match by accident: each output must report its own pass's totals,
//! not zeros, the other pass's or its last chunk's. With no packets,
//! `validate` ends in exit 2 (no content blocks), asserted so a crash (exit 1)
//! cannot pass for it. Between the main chunks sit one chunk of an unknown type
//! and a second Header, so every `Unknown chunks` output must read 1, not 0 or 2.

mod common;

use std::path::PathBuf;

use common::*;

/// What the ReplayData pass must report: `(blobs, bytes, game-specific
/// bytes)`, summed over its two chunks -- (2, 5, 4) and (1, 1, 7).
const MAIN: (u64, u64, u64) = (3, 6, 11);
/// What the checkpoint pass must report, summed over (1, 2, 3) and (0, 0, 2).
const CHECKPOINT: (u64, u64, u64) = (1, 2, 5);
/// Frames with a NaN or infinite time: one per main chunk, and one in the
/// first checkpoint only, so a pass reporting its last chunk shows.
const MAIN_NON_FINITE: u64 = 2;
const CHECKPOINT_NON_FINITE: u64 = 1;
/// Frames walked, neither equal to the other nor to the two chunks per pass.
const MAIN_FRAMES: u64 = 3;
const CHECKPOINT_FRAMES: u64 = 4;

/// The whole file: info, header, then ReplayData and Checkpoint chunks
/// interleaved, two of each, with the totals the constants above name.
fn replay(dir: &std::path::Path) -> PathBuf {
    let main_chunk = |frames: &[u8]| chunk(1, &replay_data(frames, frames.len()));
    let checkpoint_chunk =
        |index, frames: &[u8]| chunk(2, &checkpoint(index, &checkpoint_tables(frames), 0));
    let mut data = replay_info(&Info::default());
    data.extend(chunk(0, &header_payload()));
    data.extend(main_chunk(&frame(f32::NAN, &[(12, 6), (17, 9)], 4, &[])));
    data.extend(checkpoint_chunk(
        0,
        &frame(f32::NEG_INFINITY, &[(9, 5)], 3, &[]),
    ));
    data.extend(chunk(4, &[0; 64]));
    data.extend(chunk(0, &header_payload()));
    let mut frames = frame(f32::INFINITY, &[(1, 4)], 7, &[]);
    frames.extend(frame(2.5, &[], 0, &[]));
    data.extend(main_chunk(&frames));
    let mut frames = frame(2.0, &[], 2, &[]);
    for time in [3.0, 3.5] {
        frames.extend(frame(time, &[], 0, &[]));
    }
    data.extend(checkpoint_chunk(1, &frames));
    let path = dir.join("frame_skips.vrf");
    std::fs::write(&path, data).expect("write the synthetic replay");
    path
}

fn rendered((blobs, bytes, game): (u64, u64, u64)) -> String {
    format!("{blobs} external blobs / {bytes} external bytes / {game} game-specific bytes")
}

fn json_skips(json: &str, prefix: &str) -> (u64, u64, u64) {
    (
        json_u64(json, &format!("{prefix}external_data_blobs")),
        json_u64(json, &format!("{prefix}external_data_bytes")),
        json_u64(json, &format!("{prefix}game_specific_bytes")),
    )
}

/// `validate` walks ReplayData only; its lines must carry the main totals.
#[test]
fn validate_reports_the_replay_data_frame_skips() {
    let dir = scratch("frame_skips", "validate");
    let run = vrfkit(&["validate", path_arg(&replay(&dir))]);

    assert_eq!(
        run.code,
        Some(2),
        "a replay with no content blocks ends in the no-content verdict, not an error\n{}\n{}",
        run.stdout,
        run.stderr
    );
    assert_eq!(
        line_value(&run.stdout, "ReplayData frames:"),
        MAIN_FRAMES.to_string()
    );
    assert_eq!(line_value(&run.stdout, "Frame skips:"), rendered(MAIN));
    assert_eq!(
        line_value(&run.stdout, "Frame times:"),
        format!("{MAIN_NON_FINITE} non-finite")
    );
    assert_eq!(line_value(&run.stdout, "Unknown chunks:"), "1");
    std::fs::remove_dir_all(dir).ok();
}

/// `diag` reports the main pass under `chunks` with a `replay_data_` prefix,
/// the checkpoint pass under `checkpoint_meta` with none.
#[test]
fn diag_reports_each_pass_frame_skips() {
    let dir = scratch("frame_skips", "diag");
    let json_path = dir.join("diag.json");
    let run = vrfkit(&[
        "diag",
        path_arg(&replay(&dir)),
        "--json",
        path_arg(&json_path),
    ]);
    assert_eq!(run.code, Some(0), "{}\n{}", run.stdout, run.stderr);

    let json = std::fs::read_to_string(&json_path).expect("diag wrote its JSON");
    assert_eq!(json_u64(&json, "replay_data_frames"), MAIN_FRAMES);
    assert_eq!(json_skips(&json, "replay_data_"), MAIN);
    assert_eq!(json_u64(&json, "frames"), CHECKPOINT_FRAMES);
    assert_eq!(json_skips(&json, ""), CHECKPOINT);
    assert_eq!(
        json_u64(&json, "replay_data_non_finite_frame_times"),
        MAIN_NON_FINITE
    );
    assert_eq!(
        json_u64(&json, "non_finite_frame_times"),
        CHECKPOINT_NON_FINITE
    );
    assert_eq!(json_u64(&json, "unknown"), 1);
    std::fs::remove_dir_all(dir).ok();
}

/// `export --checkpoints` reports each pass twice: a summary line on stderr
/// and a manifest key set. Both must carry the pass's own totals.
#[cfg(feature = "export")]
#[test]
fn export_reports_each_pass_frame_skips_in_summary_and_manifest() {
    let dir = scratch("frame_skips", "export");
    let out = dir.join("out");
    let run = vrfkit(&[
        "export",
        path_arg(&replay(&dir)),
        "--out",
        path_arg(&out),
        "--checkpoints",
    ]);
    assert_eq!(run.code, Some(0), "{}\n{}", run.stdout, run.stderr);

    let summary = |label| line_value(&run.stderr, label);
    assert_eq!(summary("ReplayData frames:"), MAIN_FRAMES.to_string());
    assert_eq!(summary("Frames:"), CHECKPOINT_FRAMES.to_string());
    assert_eq!(summary("Frame skips:"), rendered(MAIN));
    assert_eq!(summary("Checkpoint frame skips:"), rendered(CHECKPOINT));
    assert_eq!(
        summary("Frame times:"),
        format!("{MAIN_NON_FINITE} non-finite")
    );
    assert_eq!(
        summary("Checkpoint frame times:"),
        format!("{CHECKPOINT_NON_FINITE} non-finite")
    );
    assert_eq!(summary("Unknown chunks:"), "1");

    let manifest =
        std::fs::read_to_string(out.join("manifest.json")).expect("export wrote a manifest");
    assert_eq!(json_skips(&manifest, "frame_"), MAIN);
    assert_eq!(json_skips(&manifest, "checkpoint_frame_"), CHECKPOINT);
    assert_eq!(json_u64(&manifest, "checkpoint_frames"), CHECKPOINT_FRAMES);
    assert_eq!(
        json_u64(&manifest, "frame_non_finite_times"),
        MAIN_NON_FINITE
    );
    assert_eq!(
        json_u64(&manifest, "checkpoint_frame_non_finite_times"),
        CHECKPOINT_NON_FINITE
    );
    assert_eq!(json_u64(&manifest, "unknown_chunks"), 1);
    std::fs::remove_dir_all(dir).ok();
}
