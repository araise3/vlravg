# AGENTS.md

This file provides guidance to Codex when working with code in this repository. `CLAUDE.md` (local, gitignored) carries the same body for Claude Code; keep the two in sync.

## What this is

vlravg is a Valorant stats site: average lobby rank, RR gains/losses and trends, duos and encounters, servers and a ping map, clutches, match history and name history. Data comes from the HenrikDev API. It is a static `index.html` plus one Cloudflare Pages Function, backed by a D1 database, deployed on Cloudflare Pages.

The repo also holds two long-running research workstreams that are not part of the shipped site:

- **RR corpus**: an act-long per-account RR payout dataset collected by a GitHub Actions workflow. See [docs/rr-corpus.md](docs/rr-corpus.md).
- **Replay line of sight**: offline VALORANT replay parsing, plus native reverse engineering of the game client toward validated exact LOS. See [docs/replay-progress.md](docs/replay-progress.md).

Replay research moved on 2026-10-18 to the private standalone repository
`araise3/valorant-replay-los`, with its local checkout at
`D:\Dokumente\Repositories\valorant-replay-los`. Continue replay work there and use
that repository's `AGENTS.md`/`CLAUDE.md`; this workspace is retained as historical
migration evidence and as the stats site's project.

## Repo layout

- [index.html](index.html): the entire frontend, about 6,500 lines. It has an inline `<style>` (to ~line 850), body markup, then one inline `<script>` (~line 1151 on). There is no framework, bundler or modules: plain globals and direct DOM manipulation. Charts are hand-built SVG; there is no Chart.js.
- [functions/api/[[path]].js](functions/api/[[path]].js): the API proxy, rate limiter and persistence layer (see Architecture).
- [functions/riot-probe/](functions/riot-probe/) and [riot-probe.html](riot-probe.html): an isolated Riot-client experiment. It is disabled unless `RIOT_PROBE_ENABLED` and its keys are set. See [docs/cloudflare-riot-probe.md](docs/cloudflare-riot-probe.md).
- [lib/](lib/): server-side modules imported by the Function and the workflow scripts. They cover upstream pacing, the workflow auth and quota audit, the RR corpus and activity policy, name history/backfill, match coverage and the Riot probe.
- [schema.sql](schema.sql) and [migrations/](migrations/): the D1 schema (database `vlravg-calib`, bound as `APP_DB`).
- [.github/workflows/collect-rr-corpus.yml](.github/workflows/collect-rr-corpus.yml) and [.github/scripts/](.github/scripts/): the only workflow, an RR corpus collector triggered hourly that runs back to back.
- [_redirects](_redirects): page routes (`/duos`, `/lobbyrank`, `/servers`, `/rr`, `/matches`, `/names`, `/player/*`) all serve `index.html`.
- [assets/ping-map/](assets/ping-map/): the EU ping map (D3, lazy-loaded by `loadServerPingMap()`); its data sources are in `SOURCES.md`. [assets/ranks/](assets/ranks/) holds the 256px rank icons.
- [pro-players.json](pro-players.json): the static pro-player search index ([docs/pro-player-library.md](docs/pro-player-library.md)). [showcase.html](showcase.html) is a standalone product film.
- [tests/](tests/): Node and Python tests. [scripts/](scripts/): replay tooling, RR analysis, UI stress harness and exporters. [docs/](docs/): feature notes and research reports.
- [artifacts/](artifacts/): screenshots and analysis outputs that back docs.

Local-only, gitignored: `.local/` (research evidence, replay exports, REA ledgers), `.tools/`, `.venv-replay/`, `.dev.vars`, `.wrangler/`, `hidden-mmr-research/`, `CLAUDE.md`, `HANDOFF.md` (stale; describes the long-removed hidden-MMR card).

## Commands

Tests (no package.json; Node 24 built-ins):

```bash
node --test --test-isolation=none tests/*.test.mjs tests/*.test.cjs
```

Python tests use the replay venv, one file at a time (e.g. `.venv-replay/Scripts/python.exe tests/rendered_los_validation_test.py`; also `tests/*_test.py` and `scripts/test-*.py`).

Many Node tests slice functions out of `index.html` by literal text markers and run them in `vm` (e.g. `function rrBucketStats(` … `// ── Column renderer`). Renaming or removing such comments and function headers breaks tests. Grep `tests/` before touching them.

Local dev server (`.claude/launch.json` entry `vlravg`):

```bash
npx wrangler pages dev . --compatibility-date=2026-07-13 --port=8788
```

The installed `workerd` lags the calendar. If wrangler rejects the date, use the "newest date supported" from its error. `.dev.vars` supplies `HENRIK_KEY`. Without an `APP_DB` D1 binding, every upstream cache miss returns 503: the quota gate needs D1 and fails closed. A local D1 is required to exercise live fetching.

UI stress harness: `python scripts/serve-ui-stress.py` (localhost, synthetic fixtures, no live API; see [docs/ui-stress-report.md](docs/ui-stress-report.md)).

## Deployment

Cloudflare Pages is connected to the `araise3/vlravg` GitHub repo (default origin `vlravg1.pages.dev`). There is no `wrangler.toml`; bindings live in the dashboard:

- `HENRIK_KEY` (secret): the public site's HenrikDev key.
- `HENRIK_WORKFLOW_KEY` (secret): a separate key for the workflow. It must also be set in GitHub Actions ([docs/workflow-api-key.md](docs/workflow-api-key.md)).
- `APP_DB` (D1): apply `schema.sql`/migrations before deploying schema-dependent code, e.g. `npx wrangler d1 execute vlravg-calib --remote --file=schema.sql`.

GitHub Actions needs `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID` and `HENRIK_WORKFLOW_KEY`, plus optional variables `SITE_ORIGIN` and `RR_REPORT_EXPORT_ENABLED`.

## Architecture

### Proxy (`functions/api/[[path]].js`)

Only routes in the `ROUTES` array reach HenrikDev. Everything else 404s. The public paths include `account`, `account-by-puuid`, `rank`, `mmr-history`, `mmr-history-by-puuid`, `history`, `history-by-puuid`, `stored-matches`, `match-detail`, `name-history` and `name-backfill`. The workflow-only paths are `rr-collect` and `rr-feature`. D1-only routes are handled before `ROUTES`: `match-archive`, `match-archive-counts`, `match-coverage` (GET plus a POST that accepts only a scan ID) and `calib-model`.

Invariants to preserve:

- **No quota leakage.** Real HenrikDev rate-limit headers are read server-side only. Clients see success, or a 429 body `{error, retryAfterMs}`. A prior version leaked live quota, which was a DoS vector.
- **Atomic D1 admission** (`lib/upstream-pacing.mjs`). Public and workflow keys have independent pools (`rate_quota`, `workflow_rate_quota`), and the workflow pool keeps ≥2.1 s spacing. Conditional writes, not reads, grant slots. Gate storage failure means 503, never unpaced traffic. Edge-cache hits and D1-only routes bypass the gate.
- **Trusted-data only.** Shared D1 evidence (match archive, RR history, corpus, name history, coverage) is written only from server-fetched HenrikDev responses. It is never written from browser-supplied payloads or counts.
- **Workflow requests** authenticate with `X-Workflow-Key` (`lib/workflow-auth.mjs`) and bypass the edge cache. They use the public key only by borrowing an idle public slot when their own pool has no free slot. Borrowing goes through the public pool's atomic admission, and only while that window is fresh or has at least `PUBLIC_BORROW_RESERVE` (30) calls left. Missing secrets or gate storage failures never fall back to the public key.

Persistence highlights: `mergeRRHistory` accumulates every `mmr-history` entry ever seen per PUUID, beyond upstream's ~20-game window. `match_archive` stores gzip match payloads per player and act. Account lookups enrol players into `rr_players` for the corpus. `foldCalibration`/`calib-model` are leftovers of the removed hidden-MMR card; nothing in the client reads them.

### Frontend flow (`index.html`)

`runAnalysis()` resets state and calls `loadAll()`. That resolves the account, starts the saved-archive read, `mmr-history` and rank in parallel, then paginates live history (`BATCH=10`, upstream caps pages at 10) and recovers stored-season matches. Each raw match goes through `processMatch()`. `publishMatches()` re-renders progressively via `renderAll()` and the `render*` family. `apiGet()` retries network/5xx errors with backoff and sleeps for `retryAfterMs` on a 429. Requests per search go through a 2-slot `createRequestPool`. State is top-level globals (`PLAYER, TAG, REGION, PLATFORM, TARGET_SEASON, PUUID`, `allMatches`, the `_rr*ByMatchId` maps, …); grep to find readers and writers. Pages (`applyPage`) share one loaded dataset.

Domain rules worth knowing:

- **RR eligibility** (`isRREligible`): RR present, tier ≥3, not a placement (reported `is_placement_match` first, act-opening heuristic second), party size <5. Payout is Riot's `last_change`; reported bonus/penalty/forgiveness fields are shown verbatim, never re-added ([docs/rr-update-details.md](docs/rr-update-details.md)). Win rate everywhere is wins / (wins + losses).
- **Overview RR** uses up to the last 20 matches (`overviewRecentMatches`). The RR page has all-time/50/30/20 ranges.
- **Lobby rank** needs `MIN_RATED=7` rated players. Immortal+ RR uses a continuous axis rooted at 2100.
- **Rank Shield**: `was_derank_protected` gives a blue shield on the match card's RR chip (`.match-rr-change.shielded`). There is no aggregate note.
- **MVP**: shown only for the searched player on their collapsed match card, as a quiet `.mc-accolade` (trophy plus "Match MVP"/"Team MVP" text, no badge). Louder treatments were tried and rejected.
- **Clutch detection** (`computeRealDeaths`/`detectClutch`/`classifyClutchOutcome`): its timing constants (`POST_ROUND_PHASE_MS`, `CLOVE_REVIVE_*_BOUNDARY_MS`, `MAX_CLOVE_SELF_REVIVE_WINDOW_MS`, …) are empirically derived and documented inline. Don't change them without equivalent evidence.
- `RANK_ICONS` (~line 1152) holds embedded data URIs on very long lines. Grep; don't read it directly.

## Research workstreams

### RR corpus

The workflow captures accounts by activity tier, enriches payouts with trusted match features and stores everything in D1. Analysis and benchmarking are run locally at act end (`scripts/export-rr-corpus.mjs`, `scripts/benchmark-rr-corpus.py`). Nothing is auto-published to the frontend.

### Replay line of sight

Goal ([docs/replay-visibility-goal.md](docs/replay-visibility-goal.md)): load a replay and determine when an observer could actually see an enemy. Contact means the **first rendered enemy pixels** (user decision), validated against synchronized first-person recordings with enemy x-ray off. The work is **offline only**: never load replays through the game client or execute or emulate game code.

- Replay decoding, viewers and the estimated breakdown are under `scripts/replay*` and `.local/replay-transcripts/`. Historical exports are pinned to 13.06; two 13.08 replays are preserved under `.local/rea-replay-13.08-20261015/`.
- Native analysis uses the REA MCP server (`rea-agents`, Ghidra 12.1.4 and Temurin JDK 21 under `C:\Users\leona\.codex\tools\rea\`). Whole-executable Ghidra analysis times out, so work proceeds on source-bound function "slices": `.local/rea-native-los-13.08-df3286e0-2026-10-14/los-slice-vNN.exe` plus a manifest. Findings are bound to the exe hash (current 13.08 `df3286e0…`). Re-verify the hash first, and never reuse addresses across builds.
- Each pass: export the REA evidence bundle (`rea-slice-vNN-*-evidence.json`), run `.local/rea-setup/audit-native-los.py --root <namespace>`, then save `source-audit-vNN-<date>.json`. Write a ledger JSON and a `docs/replay-*.md` report, add the doc and audit to `.local/rea-setup/check-replay-progress-20261014.py`, archive and re-pin `.local/rea-native-los-2026-10-12/overall-progress-20261014.json`, and rerun the checker.
- Every ledger keeps `native_visibility_verified` and `validated_exact_los` (and related achieved-state flags) false until rendered-frame validation actually passes.

## Working conventions

- Claims are evidence-bound. Keep unknowns as unknown, label inferences as such, and never present estimates or model contacts as exact. Docs separate "reconstruction verified" from "native/real accuracy validated".
- Behavior changes come with tests. Features and research passes get a `docs/` report. UI changes are checked in the browser at phone and desktop widths.
- Commits are small, with imperative titles, straight to `main`. Commit or push only when asked.
