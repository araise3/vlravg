//! What the binary-level tests share: the real `vrfkit` binary, scratch
//! directories, readers for its text and JSON, and [`replay`]'s pieces.

// Each test crate uses a different subset.
#![allow(dead_code, unused_imports)]

mod replay;

use std::path::{Path, PathBuf};
use std::process::Command;

pub use replay::*;
pub use vrf_testkit::*;

pub struct Run {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn vrfkit(args: &[&str]) -> Run {
    let output = Command::new(env!("CARGO_BIN_EXE_vrfkit"))
        .args(args)
        .output()
        .expect("run the vrfkit binary");
    Run {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

pub fn path_arg(path: &Path) -> &str {
    path.to_str().expect("scratch paths are UTF-8")
}

/// A fresh directory under Cargo's per-target scratch area.
pub fn scratch(test: &str, name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("{test}-{name}-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).expect("clear a stale scratch directory");
    }
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    dir
}

/// The text after `label` on the one line that starts with it (after its
/// indent), spacing normalised: padding differs between outputs, the numbers
/// must not.
pub fn line_value(output: &str, label: &str) -> String {
    let lines: Vec<&str> = output
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix(label))
        .collect();
    assert_eq!(lines.len(), 1, "expected one `{label}` line:\n{output}");
    lines[0].split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The unsigned integer after `"key": `, which must occur exactly once; the
/// leading quote keeps `"frames"` from matching inside `"replay_data_frames"`.
pub fn json_u64(json: &str, key: &str) -> u64 {
    let needle = format!("\"{key}\": ");
    let hits: Vec<usize> = json.match_indices(&needle).map(|(at, _)| at).collect();
    assert_eq!(hits.len(), 1, "expected one {needle:?} in:\n{json}");
    json[hits[0] + needle.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or_else(|_| panic!("{needle:?} is not followed by an integer in:\n{json}"))
}
