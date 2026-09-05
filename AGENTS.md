# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

vlravg — a Valorant stats tool that shows a player's average lobby rank, RR gains/losses, K/D breakdowns, clutch stats, most-played duos, and playtime, sourced from the HenrikDev Valorant API. It's a static site with one small serverless proxy, deployed on Cloudflare Pages.

## Repo layout

- [index.html](index.html) — the entire frontend: inline `<style>` (~500 lines of CSS) followed by one inline `<script>` (~3,400 lines of JS). No framework, no build step, no modules — plain globals and direct DOM manipulation.
- [functions/api/[[path]].js](functions/api/[[path]].js) — a Cloudflare Pages Function. Catches all `/api/*` requests on the same origin and proxies a fixed allowlist of routes to `https://api.henrikdev.xyz`, injecting the API key server-side.
- [favicon.svg](favicon.svg)

There is no `package.json`, no bundler, no linter, and no test suite — this is intentionally a zero-build static deploy.

## Commands

Run locally with Cloudflare's dev server (needed because `/api/*` only works through the Pages Function, not a plain static file server):

```bash
npx wrangler pages dev . --compatibility-date=<date>
```

The installed `wrangler` binary's `workerd` runtime supports compatibility dates only up to a certain point (it lags the calendar) — if you omit `--compatibility-date`, wrangler defaults to *today's* date and the runtime will refuse to start with `This Worker requires compatibility date "X", but the newest date supported by this server binary is "Y"`. Use the `Y` from that error message.

No build, lint, or test commands exist in this repo.

## Deployment

Cloudflare Pages, connected to the `araise3/vlravg` GitHub repo. There's no `wrangler.toml` in the repo, so project-level config (build settings, the `HENRIK_KEY` secret, the `RATE_LIMIT_KV` binding) lives in the Cloudflare dashboard, not in version control. Both bindings are required for `/api/*` to work — see the header comment in [functions/api/[[path]].js](functions/api/[[path]].js) for exact names.

## Architecture

### API proxy (`functions/api/[[path]].js`)

Only three routes are reachable — `/api/account/{name}/{tag}`, `/api/rank/{region}/{platform}/{name}/{tag}`, `/api/history/{region}/{platform}/{name}/{tag}` — each mapped to a specific upstream HenrikDev endpoint with its own edge-cache TTL (see the `ROUTES` array). Anything else 404s rather than forwarding arbitrary paths upstream.

Rate-limit coordination is entirely server-side: quota state (`{remaining, resetAt}`) is kept in `RATE_LIMIT_KV`, shared across every concurrent visitor hitting the one HenrikDev key. Before calling upstream, the worker checks that shared state and declines immediately (429 with `retryAfterMs` in the JSON body, no headers) if quota is already exhausted; otherwise it may add a small pacing delay so concurrent users don't burst at once. Real HenrikDev rate-limit headers are read and persisted back to KV but are **never forwarded to the client** — this was a deliberate fix for a prior version that leaked live quota numbers to anyone with devtools open (a usable DoS vector). If you touch this file, preserve that: the client should only ever see success or a 429 body with `retryAfterMs`.

KV is eventually consistent, so this pacing is best-effort, not a hard guarantee — that's a known, accepted tradeoff (see the file's top comment for why a Durable Object wasn't used instead).

### Frontend flow (`index.html`)

Entry point is `runAnalysis()`, triggered by the search UI. It resets UI state and calls `loadAll()`, which orchestrates, in order: resolve the account (`/api/account`) → fetch season/MMR data (`/api/rank`) → paginate through match history (`/api/history`, `BATCH=10` per call, matches capped at 10 per page by the upstream API regardless of requested size). Each match is parsed by `processMatch()`, then a family of `render*()` functions (`renderStats`, `renderAll`, `renderMatches`, `renderTeammates`, `renderRankTrend`, `renderPlaytime`, `renderClutchCard`, `renderRRCard`, …) update the DOM and the two Chart.js instances (`chartInstances.rankTrend`, `chartInstances.playtime`).

`apiGet()` is the shared fetch wrapper: retries network errors and 5xx with exponential backoff, and on a 429 sleeps for the `retryAfterMs` the worker provides (it holds no quota state of its own — that all moved server-side, see above).

App state is plain top-level `let`/`const` globals (e.g. `PLAYER, TAG, REGION, PLATFORM, TARGET_SEASON, PUUID` near line 802, plus `allMatches`, `chartInstances`, `rankModeRows`, etc. scattered near their usage) — there's no store/framework, so grep for a variable name to find everywhere it's read/written.

### RR gains

RR / Win, RR / Loss, Games, and Win Rate are four of the eight pills in the Stats card's `.stat-pill-row` (a fixed 4-column grid, so they fall on the second row alongside Avg K/D/ACS/ADR/Playtime on the first) — there's no separate RR Gains card any more; that column used to sit opposite Avg Lobby (`#rr-col`, current rank not duplicated there — it lives in the header badge) but was merged into the Stats card so all 4 could sit on one row instead of a cramped half-width grid. `computeRRStats()` / `renderRRCard()` average Riot's own `last_change` values over matches that Riot pays by the ordinary RR rules (RR data present, tier 3+, not the act-opening placement, not a full 5-stack; draws counted in the net but not in the per-outcome averages). Games/Win Rate (`res.n` / `res.winRate`, from the shared `rrBucketStats()` helper) reflect that same RR-eligible set, not the plain all-match count elsewhere in the Stats card. There's no minimum-matches gate: with too few matches the pills just show "—". Nothing here is fitted or inferred.

Lobbies vs Rank (the old `#lobby-gap-pill`, a mean lobby-vs-my-rank gap in RR) was removed entirely, not just relocated — `computeRRStats()` no longer computes a `gap`/`meanGap`/`gapN` at all, and `processMatch()` no longer sets `lobbyAvgTier` on the match object (only `avgRankRaw`, itself otherwise unread, remains).

The Avg Lobby card (`.rank-card`) is back to its original two-column `.rank-compare` layout: Avg Lobby (title + left-aligned icon/name/RR, `setRankValue()`, 44px icon) on the left, a `.rank-compare-divider`, and `#lobby-rank-col` on the right — but that right column is no longer RR Gains or Lobbies vs Rank, it's K/D by Lobby Rank, extracted out of the K/D By card below (see next section). `renderLobbyRankCard()` hides both `#lobby-rank-col` and `#lobby-rank-divider` when `rankModeRows.lobby` is empty, so Avg Lobby falls back to full width rather than leaving a stray divider with nothing beside it.

RR Gains always uses every eligible match saved for the current act, uncapped — a `'recent'` vs `'act'` toggle (`#rr-scope-toggle`) used to let the reader switch between the last 20 eligible matches and the full act; it was removed and the card now always behaves like the old `'act'` mode. This is possible because `allMatches` already holds more than the live `/api/mmr-history` endpoint's own ~20-game window: the server persists every match it's ever seen for this player (see `mergeRRHistory` in [functions/api/[[path]].js](functions/api/[[path]].js)), so repeated searches accumulate a real act-long history beyond any single fetch. `allMatches` is already scoped to the current act via `TARGET_SEASON` filtering in `loadAll()`, so no extra filtering is needed.

This replaced a hidden-MMR estimate card that inverted Riot's payout formula to infer where hidden MMR sat relative to displayed rank. Its band constants, `c→elo` conversion, double-promotion evidence and `/api/calib-model` fetch are all gone from the client — but the worker still folds calibration on every `/history` call and still serves `/api/calib-model`, and nothing reads either any more.

The Lobbies vs Rank pill went through a richer win/loss/net breakdown split by lobbies above vs at/below your rank, then a single mean-gap pill, before being removed outright. That richer version is still parked verbatim in [reference/lobby-gap.js](reference/lobby-gap.js) if it's ever worth reattaching as its own card again, but note it reuses `m.lobbyAvgTier`, a field `processMatch()` no longer sets — reattaching it needs that field restored too.

`was_derank_protected` — a real flag on the same `/api/mmr-history` entries `myRR` comes from (see `_derankProtectedByMatchId`), not derived — tags the individual match card in Match History (`buildMatchCard()`'s `shieldTag`, `.mc-shield-tag`) with a small "SHIELDED" badge next to that match's RR change chip, on a Rank Shield loss where `last_change` still applies its normal negative payout but the displayed tier/RR doesn't drop. There's no aggregate note for this on the RR Gains card — that was tried and removed.

### Match MVP / Team MVP

`matchMvpPuuid` (highest ACS in the whole match) and `teamMvpPuuids` (highest ACS per team, one per side) are computed once in `processMatch()`, but only shown for the searched user (`myPuuid`), and only on their own collapsed match card (`buildMatchCard()`) — not in the expanded roster, and not for other players. The indicator is the WIN/LOSS tag itself (`.m-result-tag.mvp-match` / `.mvp-team`): a gold or silver ring (`box-shadow`) plus a matching gradient tint layered on top of the tag's existing win/loss color via `background-image` (the `.win`/`.loss`/`.draw` rules only set `background-color` via the shorthand, so this doesn't get reset — it just has to come later in the cascade). One element doing double duty, rather than a second badge or icon bolted on beside it.

Two louder treatments were tried here and dropped, in order: a whole-card gold/silver wash + glow, then a corner-ribbon banner, then a bare crown/star glyph next to the map name, then a foil-gradient badge in the expanded roster next to every relevant player's name. All were removed as too much for what's meant to be a quiet detail — multiple stacked or separate cues competing with the rest of the collapsed card.

### Match history day headers

Each day's header (`buildMatchRows()`) shows two aggregate figures, both computed once in `renderMatches()` over the full `mhData` set (not just the currently-paginated slice, so the numbers don't shift as more pages load): avg lobby rank (`mhDayStats[day].sum/count`, unchanged) and total RR change that day (`mhDayStats[day].rrTotal`, reusing the same `.match-rr-change` gain/loss pill style as the per-match chips). The RR total is a plain sum of `m.myRR` (Riot's `last_change`) across every match that day with RR data — no special-casing for Rank Shield needed, since `last_change` already carries the real payout on a shielded loss even though the displayed badge didn't drop, unlike naively diffing displayed ranks day-to-day would.

### Clutch detection (~lines 1192–1900+)

Riot's match API doesn't expose a "clutch" flag, so clutch rounds are reconstructed from raw kill-feed timestamps, round-phase timing constants, and per-agent revive-ability quirks (Sage resurrect, Clove's Not Dead Yet). The constants and boundary logic here (`ROUND_TIMER_MS`, `CLOVE_REVIVE_*_BOUNDARY_MS`, `IDLE_RATIO_THRESHOLD`, `MAX_CLOVE_SELF_REVIVE_WINDOW_MS`, etc.) were derived empirically from HAR-captured match data and cross-checked against dozens of confirmed real cases — the surrounding comments document the specific measurements that justify each value. Treat these as load-bearing: don't adjust them without the same kind of empirical justification, and read the adjacent comment block before changing anything in `computeRealDeaths()` / `detectClutch()` / `classifyClutchOutcome()`.

### Rank data

`RANK_ICONS` (line 532) embeds every rank icon as an inline data URI in one very long line — expect it to blow past normal line-read limits; search/grep rather than reading it directly. `RANK_MAP` / `RANK_MAP_SHORT` / `RANK_COLORS` hold the tier name/color tables used throughout rendering.
