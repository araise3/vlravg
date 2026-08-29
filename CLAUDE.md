# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

The right side of the headline rank-compare card (`#rr-col`, opposite Avg Lobby — current rank is not duplicated there; it lives in the header badge): a 2-column pill grid (`.rr-pill-grid`), RR / Win and RR / Loss on top, Lobby vs Rank spanning both columns on its own row underneath (`.rr-pill-wide`) since it's a single value where Win/Loss are a pair. The gap pill prints "0.3 harder" / "0.3 easier" / "Even" rather than a bare signed number — a `title=""` tooltip adds the precise definition, and the full-width row has room for a visible caption too (`#rr-gap-explain`, set in `renderRRCard()`): match count plus the caveat that this measures the lobbies you were placed in, not a change in your own rank. No net RR/match figure, win rate, match counts, or above/below-rank RR split — those all got cut down to just the three pills. `computeRRStats()` / `renderRRCard()` average Riot's own `last_change` values over matches that Riot pays by the ordinary RR rules (RR data present, tier 3+, not the act-opening placement, not a full 5-stack; draws counted in the net but not in the per-outcome averages), capped to the most recent `RR_RECENT_WINDOW` (20) eligible matches — recent form, not a season-long average. There's no minimum-matches gate: with too few matches the pills just show "—". Nothing here is fitted or inferred.

This replaced a hidden-MMR estimate card that inverted Riot's payout formula to infer where hidden MMR sat relative to displayed rank. Its band constants, `c→elo` conversion, double-promotion evidence and `/api/calib-model` fetch are all gone from the client — but the worker still folds calibration on every `/history` call and still serves `/api/calib-model`, and nothing reads either any more.

The Lobby Gap pill used to carry a richer breakdown — the same win/loss/net RR split broken out between lobbies that averaged above your rank and those at or below it — before being condensed to a single mean-gap pill. That richer version is parked verbatim in [reference/lobby-gap.js](reference/lobby-gap.js) if it's ever worth reattaching as its own card again; it reuses `m.lobbyAvgTier` (computed in `processMatch()`).

Below the pills, `#rr-shield-note` surfaces `was_derank_protected` — a real flag on the same `/api/mmr-history` entries `myRR` comes from (see `_derankProtectedByMatchId`), not derived. On a Rank Shield loss, `last_change` still applies its normal negative payout but the displayed tier/RR doesn't drop, so the badge can undercount real losses. The note only renders when `computeRRStats()`'s `shieldedLosses` is nonzero. The same flag also tags the individual match card in Match History (`buildMatchCard()`'s `shieldTag`, `.mc-shield-tag`) — a small "SHIELDED" badge next to that match's RR change chip.

### Match MVP / Team MVP

`matchMvpPuuid` (highest ACS in the whole match) and `teamMvpPuuids` (highest ACS per team, one per side) are computed once in `processMatch()` and consumed in two places, sharing one pair of icon constants (`MVP_CROWN_SVG`, `MVP_STAR_SVG`, defined just above `buildPlayersGrid()`) so the two surfaces can't visually drift apart:

- **Expanded roster** (`buildPlayersGrid()`): every matching player, not just the searched user, gets an inline `.mvp-badge` pill next to their name — crown+"MVP" (gold foil gradient) for the match MVP, star+"TEAM" (silver foil gradient) for each team's MVP.
- **Collapsed match card** (`buildMatchCard()`): only checked for the searched user (`myPuuid`), and only when it's *their* match. Two reinforcing, independently-toggleable cues: the whole-card gold/silver wash + glow (`.match-card.mvp-match` / `.mvp-team`, answers "is this card special" while scanning a long list) and a diagonal corner-ribbon banner (`.mc-mvp-ribbon`, answers "why" — the crown/star + label — without expanding the card). The ribbon is a classic "on sale" banner construction: an oversized strip rotated 45° inside a small `overflow:hidden` box, relying on `.match-card`'s own `overflow:hidden` to clip it into the rounded corner for free. `.mc-right` gets extra `padding-right` on both MVP variants so the ribbon's diagonal sweep never overlaps the avg-lobby badge or match date. The gold ribbon (rarer of the two — literally the best game in the whole 10-man lobby) gets a slow shimmer sweep reusing the existing `rankMaxShimmer` keyframe rather than a new one.

### Clutch detection (~lines 1192–1900+)

Riot's match API doesn't expose a "clutch" flag, so clutch rounds are reconstructed from raw kill-feed timestamps, round-phase timing constants, and per-agent revive-ability quirks (Sage resurrect, Clove's Not Dead Yet). The constants and boundary logic here (`ROUND_TIMER_MS`, `CLOVE_REVIVE_*_BOUNDARY_MS`, `IDLE_RATIO_THRESHOLD`, `MAX_CLOVE_SELF_REVIVE_WINDOW_MS`, etc.) were derived empirically from HAR-captured match data and cross-checked against dozens of confirmed real cases — the surrounding comments document the specific measurements that justify each value. Treat these as load-bearing: don't adjust them without the same kind of empirical justification, and read the adjacent comment block before changing anything in `computeRealDeaths()` / `detectClutch()` / `classifyClutchOutcome()`.

### Rank data

`RANK_ICONS` (line 532) embeds every rank icon as an inline data URI in one very long line — expect it to blow past normal line-read limits; search/grep rather than reading it directly. `RANK_MAP` / `RANK_MAP_SHORT` / `RANK_COLORS` hold the tier name/color tables used throughout rendering.
