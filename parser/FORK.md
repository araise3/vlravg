# vlravg fork of vrfkit

This directory is [vrfkit](https://github.com/yakisoba0728/vrfkit) v0.3.0
(`b9496df61c40fa304d4f539689c1dd627804946e`, Apache-2.0; see `LICENSE` and
`NOTICE.md`), with upstream PR #37 at `e86a376` applied (the 13.09 transform
line and RoundResults changes; SHA-256 of that patch `715ba5f8…`), modified by
the vlravg project. Design, measurements and limits:
[`docs/replay-parser.md`](../docs/replay-parser.md).

## Changes by vlravg (2026-11-26)

- Line endings normalised to LF. Upstream's `tools/`, `docs/` and Python
  harness are not carried, so the `tools/extract_component_classes` workspace
  member and `crates/vrfkit/tests/adapter_contract.rs` (which pins
  `tools/to_valplay_bundle.py`) are dropped. `Cargo.lock` is updated for that
  and for `serde_json`.
- `crates/vrf-transform`:
  - `src/spec.rs` (new): `TransformSpec`, a transform as a registry line,
    parsed against the 8-slot template and interpreted.
  - `src/solve.rs` (new): recovers a build's transform from its own replay.
  - `src/lib.rs`: `TransformVersion::Custom`, a runtime registry
    (`register`/`registered`), and `TransformVersion::spec()`.
- `crates/vrf-net/src/pipeline`: `ReplicationReader::with_transform`, and a
  capture mode that keeps RepLayout payloads still encoded for the solver.
- `crates/vrfkit`:
  - `src/solve.rs` (new): the `solve` and `builds` subcommands, the compiled
    `transforms.txt` registry and transform provenance.
  - `src/driver/compact.rs` (new): `export --compact`, the site's compact
    document in the export pass.
  - `src/cli.rs`, `src/driver/mod.rs`, `src/pass.rs`, `src/oracle.rs`,
    `src/main.rs`: the global `--transform` option and `export --require-pass`,
    `--solve-unknown` and `--compact` with their exit codes.
- `transforms.txt` (new): builds added as data.
