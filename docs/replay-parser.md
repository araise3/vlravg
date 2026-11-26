# Replay parser (`parser/`)

The replay pipeline ([replay-import.md](replay-import.md)) no longer depends on upstream vrfkit releases. `parser/` is this repository's own fork of the decoder, and it can recover the payload transform of a game build it has never seen **from the uploaded replay itself**. No game client, no reverse engineering of a new build, and no waiting for an upstream release are needed. One `vrfkit export` call now validates, exports and writes the site's compact document in a single pass, so the parse container no longer runs Python or DuckDB.

Status (2026-11-26):

| Part | State |
| --- | --- |
| Fork builds and passes its Rust tests (`cargo test --release -p vrf-transform -p vrfkit`) | Verified locally (Rust 1.98.1) |
| Data-driven transforms equal every compiled build | Verified by `interpreter_matches_every_compiled_build` (all 26 lines, 16 bit lengths, random seeds) |
| Solver recovers a known build blind | Verified: 13.09 replay `97d3b0af`, exact registry line |
| Solver recovers an unknown build | Verified: 13.10 replays `41403afd` and `ef8f37e5`, independently, the same line; oracle PASS on every ReplayData block of both |
| The 13.10 line matches upstream | Verified: same addend and offset as vrfkit v0.7.0; same function (`solved_1310_equals_upstreams_spelling`) |
| Single-pass `export` over all 18 local replays (13.08 ×7, 13.09 ×9, 13.10 ×2) | Verified: oracle PASS, exit 0, record accepted by `validateCompact` (`scripts/replay-parser-corpus.sh`) |
| `export --solve-unknown` on a build with no line | Verified: a build without the 13.10 line solved `41403afd` inside the export (stage A 2.1 s, stage B 113.6 s, 12 threads), exit 0; its record equals the registry-path record apart from `transform.source: "solved"` |
| Rust compact document equals the Python one | Verified on `97d3b0af` except 79 of 48,359 movement samples, all ties (see [Compact document](#compact-document)) |
| The new workflow on GitHub Actions | **Not run yet.** It runs on the first push to `main` that touches `parser/` |
| Solve time on a GitHub runner | **Not measured.** Locally 4 min 16 s with 2 threads |

## Layout and provenance

`parser/` is upstream [vrfkit](https://github.com/yakisoba0728/vrfkit) v0.3.0 (`b9496df61c40fa304d4f539689c1dd627804946e`, Apache-2.0) with the reviewed 13.09 patch applied (upstream PR #37 at `e86a376`, SHA-256 `715ba5f8…`, which this repository previously applied at build time from `.github/replay-decoder/`). Line endings are normalised to LF and the `tools/` workspace member is dropped. Everything vlravg changed on top is listed in [`parser/FORK.md`](../parser/FORK.md) and marked "(vlravg fork)" in the code.

Records name the decoder as before: `decoder.revision` is the upstream base, and `decoder.patch` is now the SHA-256 of `git ls-files -s parser` (every tracked path, mode and blob ID). Any change under `parser/` is therefore a new decoder build. The Function's retry logic (re-queue `decoder_*` failures once per new build) works unchanged.

## Transforms are data

VALORANT changes the content-block payload transform with every patch. Every one of the 27 known builds fits one template:

```text
<SEED_ADDEND> <±INIT_A_OFFSET>: <steps>
```

There are eight slots, run from 8 down to 1. Slot *k* holds nothing, `not`, `rev`, `swap`, `sbox`, or one of `add`/`sub`/`xor`/`rotl`/`rotr` keyed by *k*. `TransformSpec` (`parser/crates/vrf-transform/src/spec.rs`) parses that line, refuses anything outside the template, and interprets it. Compiled builds keep their monomorphised fast path, and `TransformVersion::Custom(spec)` carries a runtime one.

- **`parser/transforms.txt`** is compiled in. One line per build: `13.10 0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1`. Adding a build is a one-line, reviewed change, and it overrides a compiled line of the same build.
- **`--transform <build>=<line>`** overrides the transform for one run.
- **`vrfkit builds`** prints every registered build, which the toolchain job writes to `supported-builds.json` for the page.
- Every compact record says what it was decoded with: `decoder.transform {source, line}`, where `source` is `compiled`, `registry` or `solved`.

## Solving a build from its own replay

`vrfkit solve <file.vrf>`, and `export --solve-unknown` for a build with no line, recover the transform with nothing but the replay and this decoder (`parser/crates/vrf-transform/src/solve.rs`).

**Input.** Framing is plaintext: block headers, bit counts and actor GUIDs are not transformed, so the stream frames under any transform. In capture mode the reader keeps every RepLayout block's payload still encoded, up to 400,000 blocks of at most 8,192 bits, with its seed (`bit_count ^ actor GUID`). That takes about 0.2–0.4 s.

**Oracle.** A RepLayout payload is self-describing:

```text
checksum: 1 bit
loop { handle: IntPacked (0 ends), bits: IntPacked, payload: bits }
```

A correct transform makes the records fit their block. A wrong one decodes noise, which rarely does.

**Stage A: the steps.** A block's first stage (its first 64-bit word, 32-bit word or byte) is keyed by the seed alone. `SEED_ADDEND` and `INIT_A_OFFSET` only key the PRNG for later stages. So all 10⁸ step lists in the template are tested on first words, with no PRNG constants. A list is kept when ≥ 97 % of 4,096 first words walk as records, and the same holds on 32-bit first words and on the opening byte of blocks too short to hold a record (bits 1–7 must start the zero terminator). Lists that compute the same function on random inputs at all three widths are merged.

**Stage B: the PRNG constants.** When a block's decoded records end exactly 8 bits before its end, those 8 bits must be the zero terminator. That is known plaintext in a later stage ("probes"). Only the low 7 bits of `seed ± offset` reach the PRNG (it is multiplied by 2²⁵ in 32 bits), so offset and sign fold into one value *c* in 0..128, and the search is `addend × c` = 2³⁹ candidates. For one addend the 128 offsets differ only in bits 25–31 of the mixed seed, so `prng_a = (x & 0x1ffffff)·M + y·(M≪25)`: one addition per candidate. The search scans a 7-bit probe first and checks survivors against every probe (10,000–14,000 probes, 18,000–26,000 known bits on the two 13.10 replays).

**Proof.** A candidate is only a candidate. `solve` then runs the whole `validate` oracle with it. `export --solve-unknown --require-pass` uses its own pass's verdict, and nothing is published unless it passes.

### Measured

| Replay | Build | Registered? | Result | Time |
| --- | --- | --- | --- | --- |
| `97d3b0af` | 13.09 | yes (solved blind) | `0x7e8c_b50f 0x0f: add 8, add 7, sbox, sub 5, swap, sub 3, sbox, rev`, identical to the registry; oracle 598,121/598,121 blocks | 190 s, 12 threads, first stage B |
| `41403afd` | 13.10 | no | `0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1`; oracle PASS | 280 s, 12 threads, first stage B |
| `ef8f37e5` | 13.10 | no | the same line; oracle PASS | 127 s, 12 threads; **256 s, 2 threads** (final stage B) |

Upstream vrfkit v0.7.0 (released 2026-11-22) spells 13.10 as `0x2c24_9eb3 0x33: sub 8, not, rotl 6, swap, xor 3, not, sub 1`. Its two `not`s commute with `rotl`, `swap` and `xor` and cancel, so it is the same function. Upstream's line was read only to compare with after the solve.

### What this does not establish

- **The template.** The solver searches only the 8-slot template every known build fits. If a future build changes the skeleton (new step kinds, a different PRNG, transformed headers), stage A finds nothing, `export` exits with `decoder_validate_failed`, and the upload waits for a decoder change, as before. The static method in `valorant-replay-los` (`docs/decoder-13.09-20261029.md`) still works then.
- **Field semantics.** As before, the oracle is framing and grammar, not semantic validation of every field. A build that changes a replicated layout can pass the oracle while some typed fields change meaning.
- **Uniqueness beyond the sample.** The best candidate is accepted when it walks ≥ 99.9 % of a 50,000-block sample and then passes the full oracle. On the three 13.10 runs, 8 step lists passed stage A, all one function, and exactly one candidate survived stage B. The 13.09 run's candidate count was not kept.

## Single-pass export

The sandbox makes one call:

```bash
vrfkit export /in/replay.vrf --out /work/export --checkpoints --require-pass --solve-unknown \
  --compact /work/compact.json --match-id … --source-bytes … --source-sha256 … \
  --decoder-revision … --decoder-patch …
```

- `--require-pass`: the `validate` verdict, computed from this pass's own counters (`oracle::verdict_from_stats` over the same ReplayData stream). It replaces the separate `validate` run, a second full decode. Exit 10 if it fails.
- `--solve-unknown`: solve first if the build has no transform. Exit 10 if no candidate is found.
- `--compact`: the site's compact document, built from the rows the export already holds. Exit 12 if it is refused, for example when the embedded match ID differs.

This removed the Python reducer (`scripts/replay-compact.py`), the DuckDB wheel the toolchain job installed, and the read-back of `events.parquet`/`movement.parquet`. The runtime image is unchanged (the pinned Debian bookworm image, now used only for its glibc).

On this PC (12 threads, NVMe), the call takes 0.9–2.4 s per replay for the 18 local replays, including checkpoints and the compact document. Before, `validate` alone took 1.05 s on `97d3b0af`, and the Python reducer 1.4 s after the export. Production timings have not been measured.

### Compact document

`parser/crates/vrfkit/src/driver/compact.rs` writes the same format, version 1, as the Python reducer. Measured on `97d3b0af`, every key is identical except `movement`. There, 79 of 48,359 samples differ, and every one is a tie. Several rows share the bucket's latest `(time_ms, packet_id)`. The Rust writer keeps the last of them in stream order, deterministically; DuckDB's `arg_max` kept another tied row. All 79 were checked against the export's rows: both values are among the tied rows, and the Rust value is the last one. The Python reducer's unit cases were ported to Rust (`driver::compact::tests`). One field is new: `decoder.transform`.

## Pipeline changes

- `parse-replays.yml` builds `parser/` from the checkout. There is no clone of upstream and no patch step. The cache key is the tree digest plus the Rust image, and a push touching `parser/**` runs the parser.
- The parse container's timeout rose from 15 to 30 minutes, and the job's from 60 to 90 minutes, to leave room for a solve on 2 CPUs.
- When a record was decoded with a solved transform, the submit job prints a `::notice` and a step-summary line with the `transforms.txt` line to add. The line is validated by `validateCompact` (an exact grammar) before it is printed. Adding it is a reviewed commit, checked on a second replay of the build first. A solved transform is used for that one replay only, and nothing from an upload persists.
- `vrfkit-watch.yml`, `.github/scripts/vrfkit-watch.mjs` and `.github/replay-decoder/vrfkit-13.09.patch` were removed.

## Threat model additions

The solver runs inside the same sandbox, on the same hostile input. It is pure integer arithmetic over the captured blocks, with bounded memory (at most 400,000 blocks of ≤ 1 KiB) and bounded time (the container timeout). A crafted replay can at most make its own solve fail or pass with a transform that decodes only itself. The match cross-check against HenrikDev still applies to whatever it decodes.

## Tests

- `parser/crates/vrf-transform`: spec parsing and template refusal, the interpreter against every compiled build, compiled `spec()` against the source lines, the solved 13.10 line against upstream's spelling, the candidate index, folded offsets, the offset scan against the direct check, the prefix walk
- `parser/crates/vrfkit`: the registry file parses; entry syntax; the compact document (players and loadouts, kill order, bucketing, rounding half away from zero, yaw wrap, ties, wrong match ID, ASCII JSON)
- `tests/replay-parser-workflow.test.mjs`: decoder identity from the tree digest, `decoder.transform` validation, the solved-transform notice, the single sandbox call, the registered 13.09/13.10 lines, the toolchain cache key
- `scripts/replay-parser-corpus.sh <vrfkit> <out> <replays…>`: the local end-to-end check above
