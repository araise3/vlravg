//! Checkpoint archive bytes the Oodle codec never read, followed to the export
//! summary and manifest and to the diag JSON.
//!
//! They are 0 in every corpus checkpoint archive, so no corpus guard can see a
//! call site that drops the count. This builds a compressed replay whose
//! archives are single uncompressed Kraken blocks with bytes left after each,
//! and requires every output to report them with the framing residual after
//! the archive, and apart from the ReplayData archive's own unread bytes,
//! which `ReplayData unread` already counts.

mod common;

use std::path::{Path, PathBuf};

use common::*;

/// Bytes after the block in each of the two checkpoint archives.
const CHECKPOINT_UNREAD: [usize; 2] = [7, 5];
/// Bytes after the first checkpoint's archive, inside its chunk.
const CHECKPOINT_CHUNK_TRAILING: usize = 2;
/// Everything the checkpoint pass must report: 7 + 5 + 2.
const CHECKPOINT_TOTAL: u64 = 14;
/// Bytes after the block in the one ReplayData archive.
const REPLAY_DATA_UNREAD: u64 = 3;

fn replay(dir: &Path) -> PathBuf {
    let empty_frame = frame(1.0, &[], 0, &[]);
    let checkpoint_chunk = |index: u32, trailing| {
        let plain = checkpoint_tables(&empty_frame);
        let archive = archive_with_unread_input(&plain, CHECKPOINT_UNREAD[index as usize]);
        chunk(2, &checkpoint(index, &archive, trailing))
    };
    let mut data = replay_info(&Info {
        compressed: true,
        ..Info::default()
    });
    data.extend(chunk(0, &header_payload()));
    let frames = archive_with_unread_input(&empty_frame, REPLAY_DATA_UNREAD as usize);
    data.extend(chunk(1, &replay_data(&frames, empty_frame.len())));
    data.extend(checkpoint_chunk(0, CHECKPOINT_CHUNK_TRAILING));
    data.extend(checkpoint_chunk(1, 0));
    let path = dir.join("checkpoint_unread.vrf");
    std::fs::write(&path, data).expect("write the synthetic replay");
    path
}

#[test]
fn diag_counts_checkpoint_bytes_the_codec_never_read() {
    let dir = scratch("checkpoint_unread", "diag");
    let json_path = dir.join("diag.json");
    let run = vrfkit(&[
        "diag",
        path_arg(&replay(&dir)),
        "--json",
        path_arg(&json_path),
    ]);
    assert_eq!(run.code, Some(0), "{}\n{}", run.stdout, run.stderr);

    let json = std::fs::read_to_string(&json_path).expect("diag wrote its JSON");
    assert_eq!(json_u64(&json, "trailing_bytes"), CHECKPOINT_TOTAL);
    assert_eq!(
        json_u64(&json, "replay_data_trailing_bytes"),
        REPLAY_DATA_UNREAD
    );
    std::fs::remove_dir_all(dir).ok();
}

#[cfg(feature = "export")]
#[test]
fn export_counts_checkpoint_bytes_the_codec_never_read() {
    let dir = scratch("checkpoint_unread", "export");
    let out = dir.join("out");
    let run = vrfkit(&[
        "export",
        path_arg(&replay(&dir)),
        "--out",
        path_arg(&out),
        "--checkpoints",
    ]);
    assert_eq!(run.code, Some(0), "{}\n{}", run.stdout, run.stderr);

    assert_eq!(
        line_value(&run.stderr, "Trailing bytes:"),
        CHECKPOINT_TOTAL.to_string()
    );
    assert_eq!(
        line_value(&run.stderr, "ReplayData unread:"),
        format!("{REPLAY_DATA_UNREAD} bytes")
    );

    let manifest =
        std::fs::read_to_string(out.join("manifest.json")).expect("export wrote a manifest");
    assert_eq!(
        json_u64(&manifest, "checkpoint_trailing_bytes"),
        CHECKPOINT_TOTAL
    );
    assert_eq!(
        json_u64(&manifest, "replay_data_trailing_bytes"),
        REPLAY_DATA_UNREAD
    );
    std::fs::remove_dir_all(dir).ok();
}
