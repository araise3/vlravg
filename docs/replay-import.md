# Replay import

The Replays page (`/replays`, `/player/<name>/<tag>/replays`) lists every loaded match of the searched player with its map, score, date and match ID. Each row accepts that match's VALORANT replay (`.vrf`). The file goes to R2. A sandboxed GitHub Actions job parses it with vrfkit, and three things are kept:

- **the raw `.vrf`**, the only lossless source. A future decoder can extract more from it
- **the full vrfkit export**: every table `vrfkit export --checkpoints` writes, stored unchanged under `export/<match>/`. This is the tier meant for future exact line-of-sight work. It holds full-rate movement with pitch, velocity and movement state, every replicated field and RPC (including the typed overlay, raw payloads for unknown properties, crouch, equips, ability state, `VisibleCharacterOverrides` and `ActiveBlinds`), actor opens and closes with spawn transforms, net GUIDs, events and all checkpoint tables
- **a compact timeline** for the site: rounds, kills, spike events, ultimates, and player positions every 250 ms

The Function stores the export and the timeline in R2 and indexes them in D1.

Uploaded replays are **user-supplied data**. They are stored in `replay_*` tables and the `REPLAY_BUCKET` only. Nothing is written to `match_archive`, `rr_history`, the RR corpus or name history, and every API response that serves replay data says `source: "user-upload"` or `X-Replay-Source: user-upload`.

## Status (2026-10-28)

| Part | State |
| --- | --- |
| Upload routes, quotas, header check, multipart R2 storage | Verified on a local `wrangler pages dev` with local D1 and R2 (real replays `79397d00…` at 41,961,720 B and `97d3b0af…` at 50,811,516 B), and by `tests/replay-import.test.mjs` |
| Parser routes (claim, raw download, result, export files, compact blob) and the HenrikDev player cross-check | Verified locally. All 10 HenrikDev players were found in `79397d00…`, and the status became `parsed`. All 14 export files (24,814,693 B) reached local R2 unchanged: 13 single objects matched by SHA-256, and `movement.parquet` matched as two multipart blobs, part by part |
| Tar output and allowlist unpack | Verified locally on that replay's real export, and against hostile archives by `tests/replay_unpack_test.py` |
| Browser upload with Turnstile | Verified locally with Cloudflare's always-pass test keys at desktop and 375 px widths. Real keys are untested |
| `fetch` and `submit` scripts | Verified locally against the dev server, and by `tests/replay-parser-workflow.test.mjs` |
| `parse` job (Docker sandbox) and the GitHub Actions workflow | **Not run.** There is no Docker on the development PC, and the workflow has never executed. The local runs replaced the container with the same commands, run natively on the user's own replays. The sandbox flags are checked statically by tests |
| 13.08 replays | Decoded by vrfkit v0.3.0 (validate passes, 0 malformed packets, on `79397d00…` and `a27d4487…`) |
| 13.09 replays | Patched decoder, **not verified here**. Plain v0.3.0 rejects all three local 13.09 replays (`no payload transform is registered for replay branch '++Ares-Core+release-13.09'`); such uploads end as `failed` / `decoder_validate_failed`, verified end to end with `97d3b0af…`. The workflow now applies the 13.09 code from upstream PR #37 (see [Decoder support](#decoder-support)). This session's sandbox refused to build that unmerged code on the development PC, so its first build and run are the workflow's |
| Retry after a decoder change | Verified by `tests/replay-import.test.mjs` |

## Decoder support

VALORANT changes the replay payload transform with every patch. Each of upstream's 26 registry lines has its own seed and operation list, so no decoder can read a build released after it. Each new build needs a new transform line. vrfkit derives those from the game client's reader function; this project does not do that work itself. What is automated instead:

- **Retry.** A failure a newer decoder could fix (`decoder_validate_failed`, `decoder_export_failed`) keeps its raw file and records the decoder build (`decoder_id`). Every parser run names its decoder build when it claims jobs. The Function re-queues those uploads exactly once per new build, and never for other failures or when the raw file is gone. Pushing a decoder change runs the parser (`push` trigger on the workflow and `.github/replay-decoder/`), so pending uploads are retried at once. The page tells the uploader this.
- **Watch.** `.github/workflows/vrfkit-watch.yml` checks daily whether upstream released a vrfkit newer than the pin. If so, it opens one issue naming the builds the release adds. Bumping the pin stays a reviewed change, because new upstream code is read before it runs.

Current decoder: upstream [vrfkit](https://github.com/yakisoba0728/vrfkit) v0.3.0, `b9496df61c40fa304d4f539689c1dd627804946e` (2026-10-16, Apache-2.0, 11.06–13.08). Its 13.08 registry line is identical to the one the `valorant-replay-los` research build carries. On `79397d00…` its compact output is byte-identical to that build's, apart from the `decoder` field. Upstream's own verification lists 13.08 as 1 of 2 replays clean. The failing one fails the checkpoint GUID cross-check on a case-only name difference.

On top of it, the workflow applies [`.github/replay-decoder/vrfkit-13.09.patch`](../.github/replay-decoder/vrfkit-13.09.patch) (SHA-256 `715ba5f8…`, checked before `git apply`). The patch is the complete `crates/` diff of upstream's open PR [yakisoba0728/vrfkit#37](https://github.com/yakisoba0728/vrfkit/pull/37) at `e86a376` (2026-10-27). Every code line was read before it was taken:

- the 13.09 registry line `0x7e8c_b50f 0x0f: add 8, add 7, sbox, sub 5, swap, sub 3, sbox, rev`
- the RoundResults decoder learning 13.09's new `WinningTeamMode` byte and skipping the nested `TeamResults` array
- the matching export column, and test data

It applies cleanly to v0.3.0. Upstream's PR reports 4 of 4 13.09 replays meeting every criterion (validation 1,883,501/1,883,501, checkpoint export with no transform, framing, field-stream, array, struct-blob or typed-overlay failure). Its 79 native vectors were captured by emulating the 13.09 client's reader: that is upstream's method, not one this project runs. None of this was reproduced here. Once a vrfkit release includes 13.09, the watcher opens an issue, and the patch should be dropped for the release pin.

A clean `validate` is container and net-stream decoding, not semantic validation of every field. Records name their decoder in `decoder {revision, patch}`, and the submit job refuses a record from any other build.

## Flow

1. **Browser.** The client checks the size (1–150 MiB). It reads the first 2 KiB and requires the embedded match UUID to equal the row's match. It then gets a Turnstile token and calls `POST /api/replays/upload/<match>`, followed by `PUT …/part/<n>` in 10 MiB parts and `POST …/complete`.
2. **Function** (`functions/api/replays/[[path]].js` → `lib/replay-import.mjs`). Starting an upload requires all of these:
   - a valid Turnstile token
   - a match already in `match_archive`, which is written only from server-fetched HenrikDev responses
   - no existing replay for that match (re-upload is allowed only after `failed`/`rejected`, or after a stale upload older than 24 h, up to 4 uploads per match)
   - room in the per-connection and global daily budgets and in the raw-storage cap

   The conditional D1 upsert acts as the lock. Part 1 must carry the replay magic `0x43F4EFDD` and the same embedded match UUID, or nothing is written to R2. On completion the Function starts `parse-replays.yml` via `workflow_dispatch` with no inputs.
3. **`fetch` job** (holds `HENRIK_WORKFLOW_KEY`). It claims up to 2 pending replays and downloads them. It records each file's size and SHA-256 in a `claims` artifact that the parse job never receives.
4. **`parse` job** (`permissions: {}`, no secrets, no checkout, no cache). For each replay, `replay-parse-sandbox.sh` runs `vrfkit validate`, `vrfkit export --checkpoints` and `scripts/replay-compact.py` in a throwaway container (see the next section). The only output is a tar on stdout, capped at 640 MiB. `.github/scripts/replay-unpack.py` accepts only `compact.json` and the 14 known export file names, as regular files within size limits. Any link, path, unknown name or duplicate rejects the whole archive (`output_rejected`). Failures map to fixed exit codes.
5. **`submit` job** (holds the key). It parses each output with the strict validator in `lib/replay-compact.mjs` and requires its source size and hash to match the fetch job's record. It requires an export containing `manifest.json` and `movement.parquet` with only allowlisted names (`export_missing` otherwise). It gzips the document and posts a summary (`POST /result/<match>`). It then declares the export files with their sizes and SHA-256 (`POST /result/<match>/export`), uploads each in 10 MiB parts, and finally sends the compact blob (`PUT /result/<match>/compact`). The export tables are never opened in this job.
6. **Function.** It validates the summary strictly and requires every PUUID that HenrikDev lists for the match (read from `match_archive`) to appear among the replay's subjects. Otherwise the upload becomes `rejected`/`players_mismatch` and its raw file is deleted. The export is accepted only after the summary, only for allowlisted names, up to 256 MiB per file and 512 MiB in total. Every declared file must be complete before the compact blob is accepted. The blob is stored only if its size, gzip magic and SHA-256 equal the summary's, and storing it is what marks the replay `parsed`.

## Threat model

An uploaded `.vrf` is hostile input to a binary decoder. vrfkit forbids `unsafe` in its own crates, but its Oodle dependency `oozextract` contains `unsafe` code. A crafted file could crash it, exhaust memory, or in the worst case execute code. The design assumes that can happen.

- **Never on a personal machine.** Production parsing runs only on GitHub-hosted, single-use VMs.
- **The parser holds nothing worth stealing.** The parse job has no secrets and an empty token scope. Claim IDs and source hashes stay in the fetch/submit artifacts. The container runs with:
  - `--network none` and `--read-only`
  - `--cap-drop ALL` and `no-new-privileges`
  - user `65534` and an init process
  - a 6 GB memory cap (no swap), 256 PIDs, 2 CPUs and a 15-minute timeout
  - tmpfs scratch space and no writable bind mount

  The base images are pinned by digest, and vrfkit is built `--locked` at a pinned revision.
- **The export is opaque, untrusted data.** No part of the site or the Function reads the parquet tables. Their SHA-256s come from the trusted submit job and are kept in D1 and in each object's metadata, but R2 multipart uploads are not re-hashed server-side. Research tooling must check the hashes and open the tables in a sandbox: they are parser output from hostile input, and parquet readers are themselves parsers.
- **Output is data, not trusted.** The submit job and the Function validate every key, type, range and length, and unknown keys are rejected. Error codes outside a fixed list become `parser_failed`. The page renders all replay-derived text with `textContent`.
- **Abuse and cost.** The controls are:
  - Turnstile on every upload start
  - 6 uploads / 600 MiB per connection per day (a day-salted SHA-256 of the IP)
  - 60 uploads / 4 GiB globally per day
  - an 8 GiB cap on raw files plus full exports held in R2
  - 4 uploads per match
  - `REPLAY_UPLOADS_DISABLED=1` as a kill switch
- **Workflow injection.** The dispatch carries no inputs. The dispatch token needs only *Actions: write* on this repository, not *Contents*.

Residual risks, stated plainly:

- A container escape (a kernel exploit) would reach the parse VM's Actions runtime token. That token could upload artifacts or caches within the run. The submit job still validates everything it reads.
- The IP hash is brute-forceable over the IPv4 space. It is kept only per day.
- Someone holding a replay of a match can upload it before the player does. The replay itself is genuine, and the player cross-check rejects a replay from another match.
- A forged header can still pass the upload checks and use up a match's attempts until the parser rejects it.

## Why the Function does not re-parse the compact document

Measured in Node on this PC for the 731 KB document of `a27d4487…`: gunzip took about 5 ms, `JSON.parse` 2.5–3 ms, full validation 0.6–2.7 ms, and re-gzipping about 37 ms. That is right at, or past, the Workers Free-plan 10 ms CPU limit this project has hit before. So the trusted submit job validates the full document, and the Function validates the small summary and checks the blob's hash.

## Compact format, version 1

The format is JSON (`compact/<match>.json.gz` in R2), produced by `scripts/replay-compact.py` from vrfkit's `manifest.json`, `events.parquet` and `movement.parquet`:

- `match_id`. The replay's `friendly_name` must equal it.
- `source {bytes, sha256}` and `decoder {name: "vrfkit", revision, patch}`. `patch` is the SHA-256 of the patch applied on top of upstream, or `null` for an unpatched build.
- `replay {build, map_path, duration_ms, recorded_ticks}`. `recorded_ticks` is UE `FDateTime` ticks, not a Windows FILETIME.
- `quality`: content blocks lost, movement/event rows, malformed packets, transform failures.
- `players[] {subject, character_id}`: account and agent UUIDs from the manifest and `playerLoadouts`. Indices below refer to this array. `-1` means an unresolved character.
- `events`:
  - `rounds [[t_ms, round]]`, where the round is vrfkit's zero-based `word0`
  - `kills [[t_ms, killer, killed]]`, from vrfkit's documented `characterDeath` order: `word0` killer, `word1` killed
  - `ultimates [[t_ms, player]]`. vrfkit warns these events outnumber real casts, so they are only a cross-check
  - `plants`, `defuses`, `detonations`, `switch_teams` as lists of `t_ms`
- `movement {interval_ms: 250, encoding: "delta-v1", tracks[] {player, samples}}`. `samples` is a flat integer list of 5-tuples `(tick, x, y, z, yaw)`, each a delta from the previous tuple. The first tuple is a delta from zero, and `t_ms = tick × 250`. Each tuple is the last finite sample of any of the player's pawns in that 250 ms bucket, in whole cm and whole degrees (0–359). Buckets without samples, for example while dead, are absent.

Nothing in this format is HenrikDev data, and it is not a rendered view. Positions are replicated movement samples, not line-of-sight evidence. For line-of-sight work, use the full export, which keeps every movement sample (pitch included) and every replicated field.

Measured sizes:

| Replay | Raw | Compact JSON | gzip |
| --- | ---: | ---: | ---: |
| `a27d4487…` (13.08, Duality, 29.7 min) | 62,913,109 B | 731,358 B | 210,581 B |
| `79397d00…` (13.08, Sunset, 20.8 min) | 41,961,720 B | 522,118 B | 140,389 B |

The full export of `79397d00…` from v0.3.0 is 24,814,693 B in 14 files. The largest are `movement.parquet` (14,181,725 B), `fields.parquet` (8,496,820 B), `manifest.json` (705,030 B) and `checkpoint_fields.parquet` (633,137 B). That is 59 % of the raw replay. Each parsed replay therefore holds about 1.6× its raw size in R2 until the raw file moves to Google Drive.

In both replays every kill resolved to two players: 156/156 kills, and 99 kills in `79397d00…`.

## Setup

Cloudflare Pages:

- an R2 bucket bound as `REPLAY_BUCKET`
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`, from a Turnstile widget for the site's hostname
- optionally `GITHUB_DISPATCH_TOKEN`: a fine-grained token with only *Actions: read and write* on `araise3/vlravg`. Without it, the daily 04:23 UTC sweep is the only trigger
- the existing `HENRIK_WORKFLOW_KEY`, which authenticates the parser routes

Apply the migrations first, in order (0008 adds `decoder_id`; deploy code that writes it only after it):

```bash
npx wrangler d1 execute vlravg-calib --remote --file=migrations/0007_replay_imports.sql
npx wrangler d1 execute vlravg-calib --remote --file=migrations/0008_replay_decoder_id.sql
```

Without the R2 binding or the Turnstile keys, `/api/replays/config` reports `enabled: false` and the page shows the matches without upload buttons.

Raw files stay under `raw/` until they are moved out. Moving them to Google Drive is planned and not built. Until then, the 8 GiB cap on raw files plus exports is what bounds R2 storage (roughly 70–80 parsed replays of this size). Exports stay in R2. Reading them is not exposed through the site; use `wrangler r2 object get`. Lifecycle rules for incomplete multipart uploads are worth adding in the R2 dashboard.

Local development uses the `vlravg-replays` entry in `.claude/launch.json` (port 8789). It runs with local D1 and R2 under `.wrangler/replay-import-state` and Cloudflare's always-pass Turnstile test keys. Apply `schema.sql` to the local D1 file once it exists. A local parser run uses the same `fetch` and `submit` scripts with `SITE_ORIGIN=http://localhost:8789` and `HENRIK_WORKFLOW_KEY=local-replay-parser`. Only parse replays you recorded yourself outside the sandbox.

## Tests

- `tests/replay-import.test.mjs`: routes, gating, quotas, claims, cross-check, export file list and multipart storage, the storage cap, blob hash, and isolation from the trusted tables
- `tests/replay-import-ui.test.mjs`: row building, browser header check, status labels, routing
- `tests/replay-parser-workflow.test.mjs`: artifact separation, untrusted-output validation, static checks of the sandbox and workflow, the pinned 13.09 patch, the vrfkit watcher
- `tests/replay_compact_test.py`: kill order, pawn joins, bucketing, rounding and delta encoding
- `tests/replay_unpack_test.py`: traversal, absolute paths, links, unknown and duplicate names, missing compact
