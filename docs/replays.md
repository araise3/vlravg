# Local VALORANT replay research

For the local vrfkit bullet extractor, experimental reaction-time engine, and the visibility evidence still needed before publishing averages, see [reaction-time analysis](reaction-time.md).

The current offline metric measures modeled visual contact to the first
observed gun discharge, hit or miss. It includes per-player reports, sampling
bounds, coverage and exclusion audits. See [estimated visual response](estimated-replay-response.md)
for its reproducible corpus build. Native LOS remains unverified.

## Findings

- A `.vrf` is a VALORANT/Unreal network replay container, not a video. Riot's replay feature records match state for in-client review. Riot does not document a public VRF parser. The supplied 92,147,740-byte sample starts with `DD EF F4 43`, the little-endian Unreal replay magic `0x43F4EFDD`, and its header names `Ares-Core+release-13.05`.
- [ValorantReplayParser](https://github.com/michel-giehl/ValorantReplayParser) is a C#/.NET 10 event parser. Its first release is explicitly experimental. It recognizes specific VALORANT branches and exposes a metadata-only read, but its stream reader buffers whole files for full parsing.
- [vrfkit](https://github.com/yakisoba0728/vrfkit) is a Rust parser with an `inspect` command and Parquet exports for movement, events, replicated fields and actors. It preserves unknown fields and names supported builds explicitly. It needs Oodle decompression and should be run as a separate process, not inside this Pages Function.
- [ValorantWebReplayer](https://github.com/talhakoek/ValorantWebReplayer) runs a C# parser locally, extracts positions, round events and ability spawns with Node scripts, then renders a browser minimap. Its raw decode can exceed 1 GB for one replay. It labels gameplay information unavailable without Riot's authoritative match details.

The September replay upload prototype was removed from the website. Public uploads now go through the separate, sandboxed pipeline in [replay import](replay-import.md). The workflow below operates on local files only.

## Local parse proof (sample replay, 2026-09-21)

Built `vrfkit` from source at commit `88b7199707d6d411fec059d8bfb028ae6c892f4c` with Rust 1.86.0, then ran `inspect --redact-identifiers`, `validate --diagnostics`, and `export --checkpoints` against the supplied file. All tooling and Parquet output were kept in a temporary local folder; the raw replay was never sent to a parser service.

- Build `13.05`, map Abyss (`/Game/Maps/Infinity/Infinity`), duration 3,449,794 ms (57m 29.794s), compressed and not encrypted.
- 32 round starts and 32 decoded outcomes. Final score from `RoundResults`: Blue 17, Red 15.
- 241 character-death events, 19 spike plants, 8 defuses, 2 detonations; every death event's killer and victim joined to one of the ten player characters.
- 3,767,398 movement rows in the full export. Numeric movement features sample them every 500 ms. Account UUIDs remain intact; Riot IDs require a verified local match-data join because the VRF does not contain them.
- Validation: 1,195,257 of 1,195,257 framed ReplayData blocks passed; zero malformed framing, transform failures, field stream failures, or lost RPC payloads. The full export also decoded 32 checkpoints without reported checkpoint loss. It preserved 6,444 unresolved RPC payloads as raw data, so a clean structural parse does not mean every gameplay field is understood.

The numeric candidate extractor uses post-plant last-survivor windows, kill outcomes, timestamps and 500 ms movement samples. Its Blue/Red mapping is cross-checked against the first round's `Wins` update and decoded `RoundResults`. Abyss and Split have verified coordinate transforms; on other maps, path values remain in raw replay coordinates and must not be compared across maps.

## Reproducible local workflow

The Windows workflow keeps the vrfkit checkout, Rust toolchain, virtual environment and replay exports inside gitignored project directories. It pins the parser revision used for the validation above and never copies or modifies the source `.vrf`.

```powershell
.\scripts\setup-replay-analysis.ps1
.\scripts\parse-replay.ps1 -ReplayPath 'C:\path\to\match.vrf'
.\scripts\batch-replays.ps1 -ReplayDirectory 'C:\Users\leona\AppData\Local\VALORANT\Saved\Demos'
```

When a manually verified positive is known, identify it by the generated replay slot and rank other post-plant last-survivor kill sequences against it:

```powershell
.\scripts\parse-replay.ps1 -ReplayPath 'C:\path\to\match.vrf' -Positive '9:P1'
```

Outputs live under `.local/replays/<match-id>/`: validation/export logs, the complete Parquet export and `exit-candidates.json`. The batch command writes `.local/replays/exit-candidates.csv`, `numeric-summary.json`, `batch-status.json`, the historical 30-row numeric `review-queue.csv`, and the newer `focused-review-queue.csv`; it continues past individual failures and can retry them from existing exports with `-RetryFailedOnly`. A local `labels.jsonl` file, when present, annotates numeric candidates. The CSV retains Riot IDs only when verified by a user label or the project's local match-scoped name archive; otherwise it displays the full replay account UUID. Candidate similarity is only a retrieval aid, not a trained classifier or a claim about intent. The initial life-state pass uses raw death events and therefore marks agent-revive handling as an explicit caveat. Missing round-start events are recorded as gaps, and those spans are excluded rather than shifting round numbers.

Manual labels separate `exit_behavior` (`exit_play`, `not_exit`, `ambiguous`) from `observed_kills` in the last-survivor window. An `exit_play` with at least one observed kill is `exit_with_kill`; an `exit_play` with none is `exit_attempt_only`. Non-exit fights can still have kills, and a zero-kill candidate is not automatically an exit attempt. The candidate extractor now includes both kill and zero-kill post-plant last-survivor windows so the latter can be reviewed and labeled rather than silently excluded. All judgments remain user-verified; no TypeSafe API call or supervised classifier is part of this local retrieval pass.

## Terminal candidate review

Run the Python reviewer directly from PowerShell, so no `.ps1` execution-policy change is needed. Each run chooses **one match**: by default the next game in the focused queue, or the match specified by `--match`. It presents only that game's focused rounds in round order and stops, never switching games mid-session. The focused screen favors multiple last-survivor kills, plus one-kill cases where the player has been the lone survivor for at least 10 seconds and gets an elimination-round kill at least 25 seconds after planting. This is an explainable *kill-exit triage*, not an intent classifier; zero-kill exit attempts and any missed exits remain in the exhaustive pool. Use `--all` to see every unreviewed round in the selected game. On the current small, non-random labeled set, the screen includes all four confirmed exits and one of 27 confirmed non-exits; that is an in-sample check, **not** a prospective accuracy estimate. The match header shows map, Blue–Red final score, and replay-header date/time. The replay format does not identify that timestamp's timezone, so the displayed time is explicitly unlabeled rather than guessed as UTC or local time. Open the replay in VALORANT separately and use its match ID to find it.

```powershell
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --games --limit 10
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --match 56b16a36
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --match 56b16a36 --all
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --all --games --limit 10
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --list
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --skipped
& .\.venv-replay\Scripts\python.exe .\scripts\review-exit-candidates.py --unskip-match 56b16a36
```

For each candidate, enter `e` for an exit (automatically categorized as with-kill or attempt-only from the observed kill count), `n` for not exit, `a` for ambiguous, `s` to skip just that round, `m` to skip the entire match, or `q` to stop. An optional Riot ID and note can be entered after a label. Each answer is appended immediately to that match's local `labels.jsonl`; numeric exports and both queues then refresh. Re-running skips already labeled candidates, so stopping mid-session is safe. A match skip is stored separately in `.local/replays/skipped-matches.json`; it does not label any remaining rounds or train a negative example. The next default run chooses another game. Use `--skipped` to list skipped matches or `--unskip-match ID_OR_PREFIX` to restore one; `--skip-match ID_OR_PREFIX` also skips a game without opening a review session. `--games` lists unskipped matches with focused candidates; `--all --games` lists the exhaustive pool. `--match` accepts a unique prefix. `--list` prints one game's selected candidates without labeling or modifying anything.
