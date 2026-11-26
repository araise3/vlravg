//! Partial rows from the checkpoint pass, which runs on its own thread and
//! hands them back for the main thread to write into `partials.parquet`.
//! Every measured replay has none, so no corpus guard sees a dropped hand-off.

#![cfg(feature = "export")]

mod common;

use common::*;

/// The only unfinished bunch is in a checkpoint frame, so `partials.parquet`
/// holds a row with `--checkpoints` and none without, and the summary counts
/// the row the file received.
#[test]
fn checkpoint_partial_rows_reach_the_partials_table() {
    let dir = scratch("checkpoint_partials", "export");
    let frames = frame(1.0, &[], 0, &[]);
    let packet = unfinished_partial_packet();
    let snapshot = checkpoint_tables(&frame(1.5, &[], 0, &[&packet]));
    let mut data = replay_info(&Info::default());
    data.extend(chunk(0, &header_payload()));
    data.extend(chunk(1, &replay_data(&frames, frames.len())));
    data.extend(chunk(2, &checkpoint(0, &snapshot, 0)));
    let replay = dir.join("checkpoint_partials.vrf");
    std::fs::write(&replay, data).expect("write the synthetic replay");

    let export = |name: &str, extra: &[&str]| {
        let out = dir.join(name);
        let mut args = vec!["export", path_arg(&replay), "--out", path_arg(&out)];
        args.extend(extra);
        let run = vrfkit(&args);
        assert_eq!(run.code, Some(0), "{}\n{}", run.stdout, run.stderr);
        let table = std::fs::read(out.join("partials.parquet")).expect("partials.parquet");
        (run, table)
    };
    let (plain, without) = export("plain", &[]);
    let (checkpoints, with) = export("checkpoints", &["--checkpoints"]);

    assert_eq!(line_value(&plain.stderr, "Partial raw rows:"), "0 (0 bits)");
    assert_eq!(
        line_value(&checkpoints.stderr, "Partial raw rows:"),
        "0 (0 bits)"
    );
    assert_eq!(
        line_value(&checkpoints.stderr, "Checkpoint partial raw:"),
        "1 rows / 8 bits"
    );
    assert_ne!(
        with, without,
        "the checkpoint row never reached partials.parquet"
    );
    std::fs::remove_dir_all(dir).ok();
}
