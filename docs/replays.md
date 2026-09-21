# VALORANT replay research and storage prototype

## Findings

- A `.vrf` is a VALORANT/Unreal network replay container, not a video. Riot's replay feature records match state for in-client review. Riot does not document a public VRF parser. The supplied 92,147,740-byte sample starts with `DD EF F4 43`, the little-endian Unreal replay magic `0x43F4EFDD`, and its header names `Ares-Core+release-13.05`.
- [ValorantReplayParser](https://github.com/michel-giehl/ValorantReplayParser) is a C#/.NET 10 event parser. Its first release is explicitly experimental. It recognizes specific VALORANT branches and exposes a metadata-only read, but its stream reader buffers whole files for full parsing.
- [vrfkit](https://github.com/yakisoba0728/vrfkit) is a Rust parser with an `inspect` command and Parquet exports for movement, events, replicated fields and actors. It preserves unknown fields and names supported builds explicitly. It needs Oodle decompression and should be run as a separate process, not inside this Pages Function.
- [ValorantWebReplayer](https://github.com/talhakoek/ValorantWebReplayer) runs a C# parser locally, extracts positions, round events and ability spawns with Node scripts, then renders a browser minimap. Its raw decode can exceed 1 GB for one replay. It labels gameplay information unavailable without Riot's authoritative match details.
- Raw files exceed [D1's 2 MB row limit](https://developers.cloudflare.com/d1/platform/limits/). R2 holds original VRFs while D1 holds an index. On Cloudflare Free and Pro plans, the [request body cap is 100 MB](https://developers.cloudflare.com/workers/platform/limits/); this prototype caps a single streamed upload at 95 MB. Some replays will need [multipart R2 upload](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/).

## Current prototype

`/replays.html` targets one match already present in vlravg's trusted `match_archive`. The server reads a bounded 2 KB prefix, extracts the match UUID embedded in the Unreal replay header, requires it to equal the target route ID, and verifies that ID against the archive before streaming the file to the private `REPLAY_BUCKET` R2 binding. Renaming a different VRF cannot satisfy this check. D1 stores the match ID, object key, size, time and parser status. Testers with the shared code can list and download originals. The source file is preserved; no gameplay metrics are inferred yet.

This is a **restricted prototype**. A shared code gives every tester access to every saved replay, which can include all players' match data. Uploaders do not need to be participants in the match: sharing a friend's replay is an intended use case. Before opening uploads more broadly, add abuse controls such as rate/storage quotas and a deletion policy. The match gate proves that vlravg observed the match and that the selected ID agrees with the ID embedded in the VRF. Existing HenrikDev match data should be joined by the verified match ID after the parser stage, not accepted from an uploader as trusted gameplay data.

## Setup

1. Create a **private** R2 bucket and bind it to the existing Pages project as `REPLAY_BUCKET` (production and preview separately as needed).
2. Set a long random Pages secret `REPLAY_UPLOAD_CODE` for test access. Do not commit it or put it in frontend source.
3. Apply `migrations/0006_replay_uploads.sql` to the existing `APP_DB` D1 database before deploying the new code. For example, `npx wrangler d1 execute vlravg-calib --remote --file=migrations/0006_replay_uploads.sql`.
4. Deploy through the existing GitHub-connected Pages flow. No public R2 domain is needed.

For local development, bind a local R2 bucket and D1 database in Wrangler and supply `REPLAY_UPLOAD_CODE` through a local secret file. Keep the bucket private. The existing site has no tracked Wrangler config; bindings currently live in the Pages dashboard.

## Analysis next step

Use **vrfkit** as the authoritative background parser in a container or other compute service with Oodle support. The small Pages header reader remains only a cheap pre-upload gate; it is not the gameplay parser and does not replace vrfkit. Feed vrfkit the R2 original by object key, run structural validation, and record its version, VALORANT branch, diagnostics, and a compact structured summary. Store large event/timeline output back in R2 and only summary/index rows in D1. Mark unknown builds `unsupported` rather than silently analyzing them as a known build. First useful view: per-round deaths/trades, positioning at first contact, economy and ability timing. Verify derived statistics against several replays plus authoritative match details before surfacing them as facts. Keep the original VRF so improved parsers can reprocess it.

## Local parse proof (sample replay, 2026-09-21)

Built `vrfkit` from source at commit `88b7199707d6d411fec059d8bfb028ae6c892f4c` with Rust 1.86.0, then ran `inspect --redact-identifiers`, `validate --diagnostics`, and `export --checkpoints` against the supplied file. All tooling and Parquet output were kept in a temporary local folder; the raw replay was never sent to a parser service.

- Build `13.05`, map Abyss (`/Game/Maps/Infinity/Infinity`), duration 3,449,794 ms (57m 29.794s), compressed and not encrypted.
- 32 round starts and 32 decoded outcomes. Final score from `RoundResults`: Blue 17, Red 15.
- 241 character-death events, 19 spike plants, 8 defuses, 2 detonations; every death event's killer and victim joined to one of the ten player characters.
- 3,767,398 movement rows in the full export. The local review samples them every 500 ms and omits account IDs and names.
- Validation: 1,195,257 of 1,195,257 framed ReplayData blocks passed; zero malformed framing, transform failures, field stream failures, or lost RPC payloads. The full export also decoded 32 checkpoints without reported checkpoint loss. It preserved 6,444 unresolved RPC payloads as raw data, so a clean structural parse does not mean every gameplay field is understood.

The reproducible local review generator is `scripts/build-replay-review.py`; its HTML template is `scripts/replay-review-template.html`. Run it with `python scripts/build-replay-review.py EXPORT_DIR OUTPUT_HTML` after installing DuckDB in a separate local Python environment. The generated HTML loads only public Abyss minimap artwork from valorant-api.com; it does not make a request with replay data. It includes planted-spike positions, defuse start/stop events and conservative possible-exit review windows. The view is an exploration prototype, not yet part of the upload service. Its Blue/Red mapping is cross-checked against the first round's `Wins` update and decoded `RoundResults`. It deliberately refuses other maps until their coordinate transforms and joins are verified.
