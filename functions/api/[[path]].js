/**
 * Cloudflare Pages Function — proxies a small, explicit set of routes to the
 * HenrikDev API with the key injected server-side. Lives at
 * functions/api/[[path]].js so it catches every request under /api/ on the
 * same domain as your page.
 *
 * REQUIRED BINDINGS (Pages project → Settings → Variables and Secrets):
 *   HENRIK_KEY (Secret)       your HDEV-... key
 *   HENRIK_WORKFLOW_KEY (Secret) separate HDEV-... key for GitHub Actions;
 *                             save the same secret in GitHub Actions too.
 *                             Optional for the public site. Authenticated jobs
 *                             use their own quota row and bypass edge caching.
 *   APP_DB     (D1 database)  create a D1 database, run schema.sql against
 *                             it, bind it to APP_DB. Holds every piece of
 *                             persistent state this Function keeps: rate-
 *                             limit quota, RR-history persistence, match
 *                             archive, and live calibration — see schema.sql.
 *                             Nothing here uses KV; there is no KV binding.
 *
 * Because the page and this function share one origin, no CORS or Origin
 * allowlist is needed — the browser just calls /api/... normally.
 *
 * ROUTES: the public path scheme (/api/account/..., /api/rank/...,
 * /api/history/...) is deliberately its own thing, not a 1:1 mirror of
 * HenrikDev's versioned endpoints. See ROUTES below for the mapping — keeps
 * the public contract decoupled from HenrikDev's own versioning, and means
 * only these explicit routes are reachable (anything else 404s, instead of
 * blindly forwarding arbitrary paths upstream with the key attached).
 *
 * EDGE CACHING: successful (200) GET responses are cached at Cloudflare's edge
 * per exact request URL, shared across ALL visitors (not per-session). TTL
 * varies by endpoint (see ROUTES). This runs independently of rate limiting
 * below — a cache hit never touches HenrikDev or the quota state at all.
 *
 * RR-HISTORY PERSISTENCE: mmr-history's upstream only ever returns a
 * player's most recent ~20 games. Routes flagged persistRRHistory merge
 * every live fetch into durable rows in APP_DB (table rr_history, one row
 * per match — see mergeRRHistory), so the response — and what gets edge-
 * cached — grows to cover everything ever seen for that player, not just
 * today's rolling window. rr_players tracks identity (region/platform/
 * name/tag) per puuid. Profile account lookups enrol players even before RR
 * loads; fresh RR windows commit corpus checkpoints and witnessed predecessors
 * before a successful response can be cached. The activity-based corpus job
 * continues capturing these players and enriching their match evidence.
 *
 * HIDDEN-MMR LIVE CALIBRATION: the /history route (flagged foldCalibration)
 * derives per-match payout-model rows from HenrikDev's own trusted response
 * and folds them into a running per-rank-band accumulator in APP_DB (table
 * calib_bands — see schema.sql) — see foldCalibration/handleCalibModel and
 * the big comment above FROZEN_BANDS. GET /api/calib-model serves the
 * current fit, blended with the frozen research constants until each band
 * has enough live data. No Cron Trigger (Pages Functions don't support
 * them) — recalibration happens inline on every real lookup via
 * context.waitUntil, same zero-added-latency pattern as RR-history above.
 *
 * WHY D1 AND NOT KV: this Function used to keep all of the above in a KV
 * namespace. KV's Free-plan write cap (1,000/day) got hit fast once live
 * calibration started folding on every /history page, and separately once
 * the 24h refresh job's rrhist writes grew past a few hundred tracked
 * players. D1's Free-plan cap is 100,000 rows written/day, and its UPDATEs
 * are atomic (no KV-style get-then-put race) — see CONSISTENCY CAVEAT below
 * for the one caveat that carries over.
 *
 * RATE LIMITING — fully server-side now, nothing exposed to the browser:
 * HenrikDev's real rate-limit headers (remaining/reset/retry-after) used to
 * be forwarded straight to the client so it could pace itself. Two problems
 * with that: it leaks live details about this key's quota to anyone with
 * devtools open, and — worse — it's a usable DoS vector, since watching
 * `remaining` approach zero tells you exactly when to push it over the edge
 * for every other user of the app. Fixed by moving all quota awareness here:
 *   - Quota state {remaining, resetAt} is tracked in APP_DB (table
 *     rate_quota, a single row), read/written on every live (cache-miss)
 *     request — so pacing is coordinated across every concurrent user of
 *     the app hitting this one HenrikDev key, not just per browser tab.
 *   - Before making an upstream call, if that row says quota is already
 *     exhausted this window, the request is declined immediately (no
 *     upstream call at all) with a plain JSON body: {error, retryAfterMs}.
 *     No headers, no raw numbers — just how long to wait.
 *   - Otherwise, a small pacing delay may be applied server-side (same
 *     "glide only if it actually helps" logic the client used to do, just
 *     using shared state instead of one browser's private view) before the
 *     real upstream call, so concurrent users don't all burst at once.
 *   - After a live call, HenrikDev's real headers are parsed and written
 *     back to that row, but never forwarded to the response — the client
 *     only ever sees success, or a 429 with a retryAfterMs it should wait out.
 *
 * CONSISTENCY CAVEAT: D1 has a primary instance plus read replicas (see D1's
 * read-replication docs), so a read immediately after another edge location's
 * write can still occasionally see slightly stale state — tighter than KV's
 * up-to-~60s propagation, but not an absolute guarantee. Under heavy
 * concurrent load from multiple edge locations, a real 429 from HenrikDev
 * can still occasionally slip through despite the quota-row check. That's
 * handled gracefully (relayed to the client as a computed retryAfterMs, same
 * as any other 429), so it degrades safely rather than breaking. For
 * airtight, race-free coordination a Durable Object would be the correct
 * upgrade — more setup (its own class + migration + binding) than felt
 * justified for a first pass, since "occasionally still gets a real 429, but
 * never leaks real quota to the browser" already satisfies the actual goal.
 */

import { observeName, readNameHistory } from "../../lib/name-history.mjs";
import { backfillState, saveBackfillPage, saveStoredBackfillPage, saveStoredMatchDetail, skipStoredMatchDetail } from "../../lib/name-backfill.mjs";
import { beginCoverageScan, readCoverageScan, recordCoveragePage, finishCoverageScan } from "../../lib/match-coverage.mjs";
import { collectRR, saveFeatures, trackRRAccount } from "../../lib/rr-corpus.mjs";
import { discoverMatchPlayers } from "../../lib/rr-activity.mjs";
import { workflowAuthorized } from "../../lib/workflow-auth.mjs";

const UPSTREAM = "https://api.henrikdev.xyz";
const PREFIX = "/api";
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MATCH_ARCHIVE_ROUTE = new RegExp(`^/match-archive/(${UUID})/(${UUID})$`, 'i');
const MATCH_ARCHIVE_PAGE_SIZE = 10;
const MATCH_ARCHIVE_MAX_PAGE_SIZE = 50;
const MATCH_ARCHIVE_COMPRESSED_BUDGET = 512 * 1024;
const MATCH_ARCHIVE_JSON_BUDGET = 8 * 1024 * 1024;
const MATCH_ARCHIVE_COUNTS_ROUTE = new RegExp(`^/match-archive-counts/(${UUID})$`, 'i');
const MATCH_COVERAGE_ROUTE = new RegExp(`^/match-coverage/(eu|na|ap|kr|latam|br)/(pc|console)/(${UUID})/(${UUID})$`, 'i');
const coverageScope=m=>({region:m[1].toLowerCase(),platform:m[2].toLowerCase(),puuid:m[3].toLowerCase(),season_id:m[4].toLowerCase()});

async function observeCoverageResponse(env,scanId,route,match,url,bodyText){
  if(!scanId||!env.APP_DB)return;
  const scan=await readCoverageScan(env.APP_DB,scanId);
  if(!scan)return;
  const payload=JSON.parse(bodyText);
  if(route.historyByPuuid&&match[1]===scan.region&&match[2]===scan.platform&&match[3].toLowerCase()===scan.puuid){
    await saveMatchArchivePage(env,bodyText,scan.puuid);
    await recordCoveragePage(env.APP_DB,scan,'live',Number(url.searchParams.get('start')||0),payload);
  }else if(route.storedMatches&&match[1]===scan.region&&match[2].toLowerCase()===scan.puuid){
    await recordCoveragePage(env.APP_DB,scan,'stored',Number(url.searchParams.get('page')),payload);
  }else if(route.matchDetail){
    const row=payload?.data;
    if(row?.metadata?.match_id===match[2]&&(row.metadata.season?.id||row.metadata.season_id)?.toLowerCase()===scan.season_id){
      await saveMatchArchivePage(env,JSON.stringify({data:[row]}),scan.puuid);
    }
  }
}

async function gzipMatch(match) {
  const source = new Blob([JSON.stringify(match)]).stream();
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

async function gunzipMatch(payload) {
  const bytes = new Uint8Array(payload);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

async function saveMatchArchivePage(env, bodyText, puuid) {
  if (!env.APP_DB || !puuid) return;
  let rows;
  try { rows = JSON.parse(bodyText)?.data; } catch { return; }
  if (!Array.isArray(rows)) return;
  const eligible = rows.filter(row => row?.metadata?.match_id
    && (row.metadata.season?.id || row.metadata.season_id)
    && row?.players?.some(p => p.puuid?.toLowerCase() === puuid));
  if (!eligible.length) return;
  const ids = [...new Set(eligible.map(row => row.metadata.match_id))];
  const placeholders = ids.map(() => '?').join(',');
  const { results: existing } = await env.APP_DB.prepare(
    `SELECT match_id FROM match_archive WHERE puuid=? AND match_id IN (${placeholders})`
  ).bind(puuid, ...ids).all();
  const known = new Set((existing || []).map(row => row.match_id));
  const statements = [];
  for (const row of eligible) {
    const meta = row?.metadata;
    const matchId = meta?.match_id;
    const seasonId = meta?.season?.id || meta?.season_id;
    if (known.has(matchId)) continue;
    known.add(matchId);
    const payload = await gzipMatch(row);
    // D1 caps a row at 2 MB. An oversized match still reaches the caller.
    if (payload.byteLength >= 1900000) continue;
    statements.push(env.APP_DB.prepare(
      'INSERT OR IGNORE INTO match_archive (puuid,season_id,match_id,started_at,payload) VALUES (?1,?2,?3,?4,?5)'
    ).bind(puuid, seasonId.toLowerCase(), matchId, meta.started_at || null, payload));
  }
  if (statements.length) await env.APP_DB.batch(statements);
}

async function readMatchArchive(env, puuid, seasonId, start, size) {
  if (!env.APP_DB) return json({ error: 'Match archive unavailable' }, 503);
  try {
    const { results } = await env.APP_DB.prepare(
      'WITH candidates AS (SELECT payload, started_at, match_id FROM match_archive '
      + 'WHERE puuid=?1 AND season_id=?2 ORDER BY started_at DESC, match_id DESC LIMIT ?3 OFFSET ?4), '
      + 'page AS (SELECT payload, ROW_NUMBER() OVER (ORDER BY started_at DESC, match_id DESC) AS n, '
      + 'COUNT(*) OVER () AS total, SUM(length(payload)) OVER '
      + '(ORDER BY started_at DESC, match_id DESC ROWS UNBOUNDED PRECEDING) AS bytes FROM candidates) '
      + 'SELECT payload, total FROM page WHERE n<=?5 AND (bytes<=?6 OR n=1) ORDER BY n'
    ).bind(puuid, seasonId, size + 1, start, size,
      size === MATCH_ARCHIVE_PAGE_SIZE ? Number.MAX_SAFE_INTEGER : MATCH_ARCHIVE_COMPRESSED_BUDGET).all();
    const matches = [];
    let jsonBytes = 0;
    // Decode sequentially: 50 large kill feeds must not all inflate at once.
    // The first row always makes progress even if it exceeds the page budget.
    for (const row of results || []) {
      const match = await gunzipMatch(row.payload);
      const bytes = new TextEncoder().encode(JSON.stringify(match)).byteLength;
      if (size !== MATCH_ARCHIVE_PAGE_SIZE && matches.length && jsonBytes + bytes > MATCH_ARCHIVE_JSON_BUDGET) break;
      matches.push(match);
      jsonBytes += bytes;
    }
    const nextStart = matches.length < (results?.[0]?.total || 0) ? start + matches.length : null;
    const res = json({ data: matches, nextStart }, 200);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch {
    return json({ error: 'Match archive unavailable' }, 503);
  }
}

async function readMatchArchiveCounts(env, puuid) {
  if (!env.APP_DB) return json({ error: 'Match archive unavailable' }, 503);
  try {
    const { results } = await env.APP_DB.prepare(
      'SELECT season_id, COUNT(*) AS matches FROM match_archive WHERE puuid=?1 GROUP BY season_id'
    ).bind(puuid).all();
    const counts = Object.fromEntries((results || []).map(row => [row.season_id, row.matches]));
    const res = json({ data: counts }, 200);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch {
    return json({ error: 'Match archive unavailable' }, 503);
  }
}

// mmr-history's upstream only ever returns the most recent ~20 games. Every
// live (cache-miss) fetch is merged into per-match rows in APP_DB (table
// rr_history) — keyed by puuid, not name/tag, since a Riot ID rename
// shouldn't orphan history — so the client's view accumulates past that
// window across repeated
// searches instead of being capped at whatever upstream feels like handing
// back today. One row per match, so there's no single-value size cap to
// manage the way the old KV blob needed — storage is cheap (D1's 5 GB free
// tier) and unbounded per-player growth here is a non-issue at this scale.

// ── HIDDEN-MMR LIVE CALIBRATION ──────────────────────────────────────────
// The Hidden MMR card (index.html) predicts each match's RR payout from
// per-rank-band constants {Bw,Bl,S,K,P} — see index.html's HMM_BANDS comment
// for the model. Those were fit OFFLINE from a one-time 355-player research
// corpus (hidden-mmr-research/). This block lets Bw/Bl/P (NOT the round-margin
// shape S/K — see below) keep improving from real traffic: every real
// /history cache-miss folds that match into a running per-band accumulator
// (foldCalibration, below), and /api/calib-model serves the current fit
// blended with the frozen constants. No Cron Trigger involved (Pages
// Functions don't support them) — this recalibrates inline, on every lookup,
// via context.waitUntil so it never adds latency to the response.
//
// KEEP FROZEN_BANDS' lo/hi/S/K/U IN SYNC WITH index.html's HMM_BANDS — Bw/Bl/P
// here are just the same starting point; S/K (the round-margin blowout
// shape) and U (the underdog slope) are NEVER refit online (identifying a
// hinge location isn't a simple linear update, and doesn't need to be — only
// the level constants should drift as the game's RR economy potentially
// changes over time; U is a slope like S, not a level).
// Refit again with an UNDERDOG term added for Iron-Ascendant — Riot lists it
// as an RR factor outright ("whether or not you're the underdog in a match")
// in the Iron-through-Ascendant article, and the model had everything else on
// their list. It is 0 from tier 24 up, because the Immortal/Radiant article's
// own "What affects my RR?" section names only wins, losses and round
// differential; see UNDERDOG_FREE_MIN_TIER below and index.html's HMM_BANDS
// comment for the full evidence. U is frozen here and folded into the
// regressand below, so the accumulator's shape is unchanged.
// NOTE FOR ANY FUTURE CONSTANT CHANGE: calib_bands holds running sums built
// from the OLD S/K/U, so those sums are stale the moment this table moves.
// Reset them on deploy — see the "Resetting the live calibration" note at
// the bottom of schema.sql.
// Refit for ALL bands (hidden-mmr-research/refit_immortal_split.py, 10,985
// combined rows) after finding a band-attribution bug: a match was being
// filed under the tier it RESULTED in rather than the tier it was actually
// played at, so any match that promoted/demoted got credited to the wrong
// band's Bw/Bl. Confirmed on real data — 176/575 same-season tier
// transitions show the account's underlying elo moving further than
// last_change reports, by 3-10 RR, matching Riot's documented "minimum 10 RR
// buffer" floor on promotion (hidden-mmr-research/riot-docs/...). last_change
// itself was never wrong (it's the clean performance payout, unaffected by
// that floor) — only which band's fit a transition match counted toward
// was. Also split Immortal+/Radiant (was one 24-27 band) into three: a
// live-traffic top-up showed a real, well-powered step-change Imm1->Imm2->
// Imm3 that the merged band was averaging away, but Imm3 and Radiant turned
// out statistically indistinguishable even at the larger sample, so 26-27
// stays merged.
const FROZEN_BANDS = [
  { lo: 3, hi: 5, Bw: 18.12, Bl: 16.49, S: 0.58, K: 3, P: 6.07, U: 2.75 }, // Iron
  { lo: 6, hi: 8, Bw: 18.68, Bl: 17.15, S: 0.45, K: 3, P: 6.09, U: 2.77 }, // Bronze
  { lo: 9, hi: 11, Bw: 18.30, Bl: 16.45, S: 0.55, K: 4, P: 4.29, U: 2.06 }, // Silver
  { lo: 12, hi: 14, Bw: 18.88, Bl: 16.53, S: 0.60, K: 5, P: 2.87, U: 1.30 }, // Gold
  { lo: 15, hi: 17, Bw: 18.18, Bl: 17.19, S: 0.47, K: 4, P: 2.02, U: 0.96 }, // Platinum
  { lo: 18, hi: 20, Bw: 17.90, Bl: 16.70, S: 0.50, K: 4, P: 1.16, U: 0.79 }, // Diamond
  { lo: 21, hi: 23, Bw: 17.70, Bl: 17.94, S: 0.35, K: 4, P: 0.29, U: 0.48 }, // Ascendant
  { lo: 24, hi: 24, Bw: 17.29, Bl: 18.19, S: 0.54, K: 5, P: 0, U: 0 }, // Immortal 1
  { lo: 25, hi: 25, Bw: 18.40, Bl: 17.46, S: 0.54, K: 5, P: 0, U: 0 }, // Immortal 2
  { lo: 26, hi: 27, Bw: 19.96, Bl: 16.05, S: 0.54, K: 5, P: 0, U: 0 }, // Immortal 3+/Radiant
];
// From this tier up the performance term P is pinned to 0 and never refit,
// exactly like S/K. Riot: "Immortal and Radiant players' RR is completely
// reliant on the outcome of the match" (riot-docs/...immortal-and-radiant-
// ranks). The small P those bands used to carry (0.15/0.12/0.08) was within
// noise for the corpus behind it, and leaving it free let the online fit
// keep re-deriving a phantom carry bonus that eats into the convergence
// signal the card actually reports. KEEP IN SYNC with index.html's
// HMM_PERF_FREE_MIN_TIER.
const PERF_FREE_MIN_TIER = 24;
const isPerfFree = (b) => b.lo >= PERF_FREE_MIN_TIER;
// The underdog term is pinned to 0 from the same tier up — the docs place it
// only in Iron-Ascendant ("whether or not you're the underdog in a match",
// riot-docs/...iron-through-ascendant), while the Immortal/Radiant article's
// matching "What affects my RR?" section lists only wins, losses and round
// differential, and the canonical four-factor breakdown never mentions it at
// all. FROZEN_BANDS already carries U:0 for those bands; this is the belt-and-
// braces enforcement of it in foldCalibration, so a future edit to that table
// can't quietly reintroduce an Immortal underdog term into the live fit.
// KEEP IN SYNC with index.html's HMM_UNDERDOG_FREE_MIN_TIER.
const UNDERDOG_FREE_MIN_TIER = 24;
const underdogFor = (b, tierId) => (tierId >= UNDERDOG_FREE_MIN_TIER ? 0 : b.U || 0);
const CALIB_MIN_N = 400;          // per-band n before the live fit fully replaces the frozen one
const CALIB_PER_PLAYER_CAP = 500; // lifetime matches one puuid can contribute per band-set
const CALIB_DECAY = 0.9999;       // per-fold decay on existing sums — lets the model move with
                                   // a future RR-economy patch instead of accumulating forever

function calibBandFor(tierId) {
  return FROZEN_BANDS.find((b) => tierId >= b.lo && tierId <= b.hi) || FROZEN_BANDS[FROZEN_BANDS.length - 1];
}

function emptyBandAccum(b) {
  return { lo: b.lo, hi: b.hi, n_win: 0, n_loss: 0, Sww: 0, Sll: 0, Swz: 0, Slz: 0, Szz: 0, Swy: 0, Sly: 0, Szy: 0 };
}

// Solves the 3x3 normal-equations system for one band's {Bw,Bl,P} via
// Cramer's rule (fine at this scale — 3 unknowns). The Bw/Bl cross-term is
// always exactly 0 (a row is never both a win and a loss), so this is exact,
// not approximate, whenever both n_win>0 and n_loss>0.
function solveBand(a, noP) {
  const out = {};
  const haveW = a.n_win > 0 && a.Sww > 1e-9;
  const haveL = a.n_loss > 0 && a.Sll > 1e-9;
  if (noP) {
    // P pinned to 0 (see PERF_FREE_MIN_TIER): fit Bw/Bl alone. Their normal
    // equations are already orthogonal to each other, so each is just its
    // own ratio — solving the 3x3 and discarding P instead would leave
    // Bw/Bl conditioned on a coefficient the model doesn't use.
    if (haveW) out.Bw = a.Swy / a.Sww;
    if (haveL) out.Bl = a.Sly / a.Sll;
    return out;
  }
  if (haveW && haveL) {
    // [[Sww,0,Swz],[0,Sll,Slz],[Swz,Slz,Szz]] . [Bw,Bl,P] = [Swy,Sly,Szy]
    const { Sww, Sll, Swz, Slz, Szz, Swy, Sly, Szy } = a;
    const M = [
      [Sww, 0, Swz],
      [0, Sll, Slz],
      [Swz, Slz, Szz],
    ];
    const sol = solve3x3(M, [Swy, Sly, Szy]);
    if (sol) { out.Bw = sol[0]; out.Bl = sol[1]; out.P = sol[2]; }
  } else if (haveW) {
    // No loss rows yet for this band — solve the reduced 2x2 (Bw,P) system.
    const sol = solve2x2(a.Sww, a.Swz, a.Swz, a.Szz, a.Swy, a.Szy);
    if (sol) { out.Bw = sol[0]; out.P = sol[1]; }
  } else if (haveL) {
    const sol = solve2x2(a.Sll, a.Slz, a.Slz, a.Szz, a.Sly, a.Szy);
    if (sol) { out.Bl = sol[0]; out.P = sol[1]; }
  }
  return out;
}

function solve2x2(a11, a12, a21, a22, y1, y2) {
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-9) return null;
  return [(y1 * a22 - a12 * y2) / det, (a11 * y2 - y1 * a21) / det];
}

function solve3x3(M, y) {
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return null;
  const withCol = (col) => M.map((row, i) => row.map((v, j) => (j === col ? y[i] : v)));
  return [det3(withCol(0)) / D, det3(withCol(1)) / D, det3(withCol(2)) / D];
}

// Calibration storage lives in APP_DB's calib_bands table — see schema.sql.
async function getCalibModel(env) {
  try {
    const { results } = await env.APP_DB.prepare("SELECT * FROM calib_bands").all();
    if (results?.length) {
      const updatedAt = results.reduce((a, r) => (r.updated_at && (!a || r.updated_at > a) ? r.updated_at : a), null);
      return { bands: results, updatedAt };
    }
  } catch (e) {
    // D1 unbound/unreachable — fall back to frozen-only rather than failing.
  }
  return { bands: FROZEN_BANDS.map(emptyBandAccum), updatedAt: null };
}

// GET /api/calib-model — blends each band's live fit with the frozen research
// constants, weighted by how much live data that band has (see CALIB_MIN_N).
// S/K/U are always the frozen values; only Bw/Bl/P ever move. U is echoed
// back rather than omitted so the client doesn't have to reconcile a live
// band against its own frozen table (hmmBand still guards for it, since a
// response cached from before U existed won't carry one).
async function handleCalibModel(env) {
  const model = await getCalibModel(env);
  const bands = FROZEN_BANDS.map((frozen) => {
    const acc = model.bands.find((x) => x.lo === frozen.lo && x.hi === frozen.hi) || emptyBandAccum(frozen);
    const noP = isPerfFree(frozen);
    const live = solveBand(acc, noP);
    const wBw = Math.min(1, acc.n_win / CALIB_MIN_N);
    const wBl = Math.min(1, acc.n_loss / CALIB_MIN_N);
    const wP = Math.min(1, (acc.n_win + acc.n_loss) / CALIB_MIN_N);
    const blend = (frozenVal, liveVal, w) => (liveVal == null ? frozenVal : frozenVal * (1 - w) + liveVal * w);
    return {
      lo: frozen.lo, hi: frozen.hi,
      Bw: blend(frozen.Bw, live.Bw, wBw),
      Bl: blend(frozen.Bl, live.Bl, wBl),
      S: frozen.S, K: frozen.K, U: underdogFor(frozen, frozen.lo),
      P: noP ? 0 : blend(frozen.P, live.P, wP),
      live: wP >= 1,
      n: acc.n_win + acc.n_loss,
    };
  });
  return new Response(JSON.stringify({ bands, updatedAt: model.updatedAt }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// A single HenrikDev v4 match object (full kill-feed + round-by-round economy)
// runs ~350-400KB; a real /history page (size=10) is 3.5MB+. JSON.parse-ing
// the whole body here once blew this project's 10ms Workers CPU budget and
// 503'd the ENTIRE request — confirmed empirically against production:
// 2 matches (~780KB) parses fine, 3+ (~1.3MB+) reliably exceeds the limit,
// and context.waitUntil's CPU counts against the same request budget, so it
// takes the client-facing response down with it, not just this fold. So we
// never JSON.parse the full body — only cheaply scan (plain char comparisons,
// no object allocation) for the first MAX_FOLD_MATCHES top-level array
// elements and parse just that tiny slice. bodyText itself is never touched,
// so the client still gets every match in the real response regardless —
// this only limits how many matches calibration gets to learn from per call,
// same "nice to have, not load-bearing" tradeoff already made elsewhere here.
const MAX_FOLD_MATCHES = 1;
// Bounding by match COUNT alone turned out not to be enough: real match
// payloads vary a lot in size (longer/overtime games carry much bigger
// kill-feed and round-economy blocks), so "1 match" can still be large
// enough, on top of an already-multi-MB total response, to tip a request
// over the CPU budget for some accounts even though it never does for
// others — confirmed empirically (same request, same code, fails for one
// real player's matches and not another's). So this is a second, blunter
// gate on the RAW body size before doing any scanning/parsing at all —
// skip folding entirely once the response is already large, regardless of
// what's inside it. This trades away calibration folding on most real
// (multi-match) page loads in exchange for guaranteeing /history itself
// never regresses again, which matters more than the fold running.
const MAX_FOLD_BODY_BYTES = 900_000;
function extractLeadingMatchesRaw(bodyText, maxN) {
  if (bodyText.length > MAX_FOLD_BODY_BYTES) return null;
  const keyIdx = bodyText.search(/"data"\s*:\s*\[/);
  if (keyIdx === -1) return null;
  const start = bodyText.indexOf("[", keyIdx);
  if (start === -1) return null;
  const slices = [];
  let depth = 0, inStr = false, esc = false, elemStart = -1;
  for (let i = start + 1; i < bodyText.length; i++) {
    const c = bodyText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") {
      if (depth === 0) elemStart = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && elemStart !== -1) {
        slices.push(bodyText.slice(elemStart, i + 1));
        elemStart = -1;
        if (slices.length >= maxN) return slices;
      } else if (depth < 0) {
        return slices; // hit the data array's own closing bracket
      }
    }
  }
  return slices;
}

// Folds one /history response's matches into the live calibration model.
// Mirrors index.html's hmmMatchRow() row-by-row — KEEP IN SYNC WITH IT.
// Derives everything server-side from HenrikDev's own trusted response
// (never from client-submitted numbers), so a real account can only ever
// contribute its own real matches.
async function foldCalibration(env, bodyText, routeInfo) {
  let matches;
  try {
    const raw = extractLeadingMatchesRaw(bodyText, MAX_FOLD_MATCHES);
    if (!raw || !raw.length) return;
    matches = raw.map((s) => JSON.parse(s));
  } catch (e) {
    return;
  }
  if (!matches.length) return;

  // Identify "me" the same way processMatch() does: puuid isn't known to
  // this route (only name/tag/region/platform are), so match on name+tag —
  // fine here since we only need approximate identity for finding rrhist,
  // not exact cross-rename continuity like the client's PUUID-first lookup.
  const wantName = (routeInfo.name || "").toLowerCase().trim();
  const wantTag = (routeInfo.tag || "").toLowerCase().trim();

  let puuid = null;
  for (const m of matches) {
    const me = (m.players || []).find(
      (p) => p.name?.toLowerCase().trim() === wantName && p.tag?.toLowerCase().trim() === wantTag
    );
    if (me?.puuid) { puuid = me.puuid; break; }
  }
  if (!puuid) return; // can't find this player in their own match list — bail quietly

  const candidateIds = [...new Set(
    matches.map((m) => (m.metadata || {}).match_id ?? m.match_id ?? null).filter(Boolean)
  )];
  if (!candidateIds.length) return;

  let seenSet = new Set(), seenCount = 0;
  try {
    const placeholders = candidateIds.map((_, i) => `?${i + 2}`).join(",");
    const [seenRows, countRow] = await Promise.all([
      env.APP_DB.prepare(`SELECT match_id FROM calib_seen WHERE puuid=?1 AND match_id IN (${placeholders})`)
        .bind(puuid, ...candidateIds).all(),
      env.APP_DB.prepare("SELECT COUNT(*) AS c FROM calib_seen WHERE puuid=?1").bind(puuid).first(),
    ]);
    seenSet = new Set((seenRows.results || []).map((r) => r.match_id));
    seenCount = countRow?.c ?? 0;
  } catch (e) {
    // D1 unbound/unreachable — nothing to fold against, bail quietly.
    return;
  }
  if (seenCount >= CALIB_PER_PLAYER_CAP) return; // lifetime cap reached — stop contributing, card still works fine

  let rrHist = new Map();
  try {
    const placeholders = candidateIds.map((_, i) => `?${i + 2}`).join(",");
    const { results } = await env.APP_DB
      .prepare(`SELECT match_id, data FROM rr_history WHERE puuid=?1 AND match_id IN (${placeholders})`)
      .bind(puuid, ...candidateIds).all();
    for (const r of results || []) {
      try { rrHist.set(r.match_id, JSON.parse(r.data)); } catch (e) {}
    }
  } catch (e) {
    // D1 unbound/unreachable — proceed with no RR data (every row below skips).
  }

  const bandDeltas = new Map(); // key "lo:hi" -> partial accumulator delta
  const newSeenIds = [];

  for (const m of matches) {
    const meta = m.metadata || {};
    const matchId = meta.match_id ?? m.match_id ?? null;
    if (!matchId || seenSet.has(matchId)) continue;
    const players = m.players || [];
    const me = players.find((p) => p.puuid === puuid);
    if (!me) continue;

    const myTierId = me.tier?.id ?? me.currenttier ?? 0;
    if (!myTierId || myTierId < 3) continue; // placements excluded, same as hmmMatchRow

    const histEntry = rrHist.get(matchId);
    const actualRR = histEntry?.last_change;
    if (actualRR == null || Math.abs(actualRR) > 200) continue; // no RR data yet, or implausible — sanity bound, not abuse guard

    const myTeamId = me.team_id?.toLowerCase();
    let myR, opR;
    const teamsRaw = m.teams;
    if (Array.isArray(teamsRaw)) {
      const myT = teamsRaw.find((t) => t.team_id?.toLowerCase() === myTeamId);
      const opT = teamsRaw.find((t) => t.team_id?.toLowerCase() !== myTeamId);
      myR = myT?.rounds?.won ?? myT?.rounds_won;
      opR = opT?.rounds?.won ?? opT?.rounds_won;
    } else if (teamsRaw && typeof teamsRaw === "object") {
      const myT = myTeamId ? teamsRaw[myTeamId] : null;
      const opTeamId = myTeamId === "red" ? "blue" : "red";
      const opT = teamsRaw[opTeamId] || null;
      if (typeof myT === "number") { myR = myT; opR = typeof opT === "number" ? opT : null; }
      else if (myT && typeof myT === "object") { myR = myT.rounds_won ?? myT.rounds?.won; opR = opT?.rounds_won ?? opT?.rounds?.won; }
    }
    if (myR == null || opR == null || myR === opR) continue; // no round data, or a genuine draw — excluded same as hmmMatchRow
    const won = myR > opR;
    const rd = Math.abs(myR - opR);
    if (rd > 13) continue; // sanity bound

    const myPartyId = me.party_id ?? null;
    const pen = (meta.party_rr_penaltys || []).find((p) => p.party_id === myPartyId)?.penalty ?? 0;

    const acss = players
      .map((p) => { const s = p.stats || p; const score = s.score ?? s.combat_score ?? 0; const rp = s.rounds_played ?? s.roundsPlayed ?? (myR + opR); return rp > 0 ? score / rp : null; })
      .filter((a) => a != null && a > 0);
    if (acss.length < 5) continue;
    const mean = acss.reduce((x, y) => x + y, 0) / acss.length;
    const sd = Math.sqrt(acss.reduce((s, a) => s + (a - mean) ** 2, 0) / acss.length);
    if (sd <= 0) continue;
    const meStats = me.stats || me;
    const myScore = meStats.score ?? meStats.combat_score ?? 0;
    const myRp = meStats.rounds_played ?? meStats.roundsPlayed ?? (myR + opR);
    const myAcs = myRp > 0 ? myScore / myRp : null;
    if (myAcs == null) continue;
    const z = (myAcs - mean) / sd;
    if (Math.abs(z) > 6) continue; // sanity bound

    // Underdog gap, same definition as index.html's lobbyAvgTier: mean tier
    // over the rated players in the lobby (unrated excluded, me included),
    // minus my own tier. Skip the match if nobody in it is rated — U can't be
    // applied, and folding the row without it would let the online fit push
    // Bw/Bl back toward absorbing the underdog effect. (Immortal+ rows have
    // U=0 and so are unaffected either way; the client skips them too, which
    // is what keeps the two row sets identical.)
    const lobbyTiers = players.map((p) => p.tier?.id ?? p.currenttier ?? 0).filter((n) => n >= 3);
    if (!lobbyTiers.length) continue;
    const gap = lobbyTiers.reduce((x, y2) => x + y2, 0) / lobbyTiers.length - myTierId;
    if (Math.abs(gap) > 10) continue; // sanity bound

    const b = calibBandFor(myTierId);
    const bandKey = `${b.lo}:${b.hi}`;
    const base0 = b.S * Math.max(0, rd - b.K);
    // U is frozen, so its contribution is a known constant — subtract it from
    // the regressand rather than adding a fourth unknown, exactly as S/K are
    // already handled. Keeps the calib_bands accumulator's shape unchanged.
    const y = actualRR - (won ? 1 : -1) * (1 - pen) * base0 - underdogFor(b, myTierId) * gap;

    let d = bandDeltas.get(bandKey);
    if (!d) { d = { lo: b.lo, hi: b.hi, n_win: 0, n_loss: 0, Sww: 0, Sll: 0, Swz: 0, Slz: 0, Szz: 0, Swy: 0, Sly: 0, Szy: 0 }; bandDeltas.set(bandKey, d); }
    d.Szz += z * z;
    d.Szy += z * y;
    if (won) { d.n_win++; d.Sww += (1 - pen) ** 2; d.Swz += (1 - pen) * z; d.Swy += (1 - pen) * y; }
    else { d.n_loss++; d.Sll += (1 - pen) ** 2; d.Slz += -(1 - pen) * z; d.Sly += -(1 - pen) * y; }

    newSeenIds.push(matchId);
  }

  if (!newSeenIds.length) return; // nothing new — don't touch D1

  const nowIso = new Date().toISOString();
  // One atomic UPDATE per touched band: decay + add in a single statement
  // (D1/SQLite numbered params let ?1 — the decay factor — repeat across all
  // ten sums), so there's no get-then-put race the way KV had.
  const bandStmts = [...bandDeltas.values()].map((d) =>
    env.APP_DB.prepare(
      `UPDATE calib_bands SET
         n_win=n_win*?1+?2, n_loss=n_loss*?1+?3,
         Sww=Sww*?1+?4, Sll=Sll*?1+?5, Swz=Swz*?1+?6, Slz=Slz*?1+?7,
         Szz=Szz*?1+?8, Swy=Swy*?1+?9, Sly=Sly*?1+?10, Szy=Szy*?1+?11,
         updated_at=?12
       WHERE lo=?13`
    ).bind(CALIB_DECAY, d.n_win, d.n_loss, d.Sww, d.Sll, d.Swz, d.Slz, d.Szz, d.Swy, d.Sly, d.Szy, nowIso, d.lo)
  );
  const seenStmts = newSeenIds.map((matchId) =>
    env.APP_DB.prepare("INSERT OR IGNORE INTO calib_seen (puuid, match_id, seen_at) VALUES (?1,?2,?3)")
      .bind(puuid, matchId, nowIso)
  );

  try {
    await env.APP_DB.batch([...bandStmts, ...seenStmts]);
  } catch (e) {
    // Non-fatal — worst case this fold's contribution is lost, same
    // best-effort tradeoff already accepted for the rate limiter's own KV use.
  }
}

// Pacing tuning — mirrors the client's old planDelay() logic, just now
// operating on state shared across every concurrent user instead of one
// browser's private view.
const MIN_SPACING_MS = 150;   // floor between any two upstream calls
const GLIDE_BELOW = 10;       // only start spacing out once this few requests remain in the window
const GLIDE_CAP_MS = 4000;    // don't glide if the resulting spacing would be absurdly long — just fire

// Public route -> real upstream HenrikDev path + this route's cache TTL.
const ROUTES = [
  {
    match: new RegExp(`^/rr-collect/(eu|na|ap|kr|latam|br)/(pc|console)/(${UUID})$`,'i'),
    upstream: m=>`/valorant/v2/by-puuid/mmr-history/${m[1]}/${m[2]}/${m[3]}`,
    rrCollect: true,
  },
  {
    match: new RegExp(`^/rr-feature/(eu|na|ap|kr|latam|br)/(${UUID})/(${UUID})$`,'i'),
    upstream: m=>`/valorant/v4/match/${m[1]}/${m[3]}`,
    rrFeature: true,
  },
  {
    match: new RegExp(`^/history-by-puuid/([^/]+)/([^/]+)/(${UUID})$`, 'i'),
    upstream: m=>`/valorant/v4/by-puuid/matches/${m[1]}/${m[2]}/${m[3]}`,
    cacheTtl:150,
    historyByPuuid:true,
    foldCalibration:true,
  },
  {
    match: /^\/name-backfill\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    upstream: (m) => m.state.phase==='stored-detail'
      ? `/valorant/v4/match/${m.state.region}/${encodeURIComponent(m.state.stored_match.match_id)}`
      : m.state.phase==='stored'
        ? `/valorant/v1/by-puuid/stored-matches/${m.state.region}/${m[1]}?mode=competitive&size=100&page=${m.state.stored_page}`
        : `/valorant/v4/by-puuid/matches/${m.state.region}/${m.state.platform}/${m[1]}?mode=competitive&size=10&start=${m.state.next_start}`,
    nameBackfill: true,
  },
  {
    // Fresh Riot ID by permanent account ID, then persist and return its timeline.
    match: /^\/name-history\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    upstream: (m) => `/valorant/v1/by-puuid/account/${m[1]}?force=true`,
    cacheTtl: 3600,
    nameHistory: true,
  },
  {
    match: /^\/mmr-history-by-puuid\/([^/]+)\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    upstream: (m) => `/valorant/v2/by-puuid/mmr-history/${m[1]}/${m[2]}/${m[3]}`,
    cacheTtl: 150,
    persistRRHistory: true,
    byPuuid: true,
  },
  {
    // /api/account/{name}/{tag}
    match: /^\/account\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v1/account/${m[1]}/${m[2]}`,
    cacheTtl: 86400, // name/tag -> puuid: only changes on a Riot ID rename
    trackAccount: true,
  },
  {
    // /api/account-by-puuid/{puuid}
    match: /^\/account-by-puuid\/([^/]+)$/,
    upstream: (m) => `/valorant/v1/by-puuid/account/${m[1]}`,
    cacheTtl: 86400, // puuid -> name/tag: only changes on a Riot ID rename
    trackAccount: true,
    accountByPuuid: true,
  },
  {
    // /api/rank/{region}/{platform}/{name}/{tag}
    match: /^\/rank\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v3/mmr/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
    cacheTtl: 90, // current rank/RR: changes the moment a match finishes
  },
  {
    // /api/mmr-history/{region}/{platform}/{name}/{tag} — per-match RR gained/
    // lost (the `last_change` field), correlated to a match via `match_id`.
    // Upstream only ever returns the most recent ~20 games regardless of any
    // size/start param (confirmed empirically). persistRRHistory below is
    // what lets the client see further back than that.
    match: /^\/mmr-history\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v2/mmr-history/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
    cacheTtl: 150, // matches /history's TTL: the "latest 20" window shifts as new games finish
    persistRRHistory: true,
  },
  {
    // /api/history/{region}/{platform}/{name}/{tag} (query string passed through as-is)
    match: /^\/history\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v4/matches/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
    cacheTtl: 150, // individual matches are immutable, but the list grows as new ones finish
    foldCalibration: true,
  },
  {
    // Compact stored records provide IDs and season IDs for games missing
    // from the live v4 match list. Page and size are fixed below so callers
    // cannot turn this into an unbounded upstream query.
    match: /^\/stored-matches\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    upstream: (m) => `/valorant/v1/by-puuid/stored-matches/${m[1]}/${m[2]}`,
    cacheTtl: 3600,
    storedMatches: true,
  },
  {
    // A stored record is only a summary. The existing stats UI needs the
    // full match payload, fetched only for archived IDs absent from v4.
    match: /^\/match-detail\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    upstream: (m) => `/valorant/v4/match/${m[1]}/${m[2]}`,
    cacheTtl: 86400,
    matchDetail: true,
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getQuota(env, workflow=false) {
  const table=workflow?'workflow_rate_quota':'rate_quota';
  try {
    let row;
    try {
      row=await env.APP_DB.prepare(`SELECT remaining, reset_at, last_request_at FROM ${table} WHERE id=1`).first();
    } catch(error) {
      if(!workflow)throw error;
      // Existing deployments need no manual schema migration. Only attempt
      // this when the first read fails; normal requests do no schema writes.
      await env.APP_DB.prepare("CREATE TABLE IF NOT EXISTS workflow_rate_quota (id INTEGER PRIMARY KEY CHECK (id=1), remaining INTEGER, reset_at INTEGER, last_request_at INTEGER)").run();
      row=await env.APP_DB.prepare(`SELECT remaining, reset_at, last_request_at FROM ${table} WHERE id=1`).first();
    }
    if (row) {
      return {
        remaining: row.remaining ?? null,
        resetAt: row.reset_at ?? 0,
        lastRequestAt: row.last_request_at ?? 0,
      };
    }
  } catch (e) {
    if(workflow)throw e;
    // D1 unavailable/misconfigured — fail open (treat as unknown quota)
    // rather than blocking every request.
  }
  return { remaining: null, resetAt: 0, lastRequestAt: 0 };
}

async function putQuota(env, state, workflow=false) {
  try {
    await env.APP_DB.prepare(
      workflow
        ? "INSERT INTO workflow_rate_quota (id,remaining,reset_at,last_request_at) VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET remaining=excluded.remaining,reset_at=excluded.reset_at,last_request_at=excluded.last_request_at"
        : "UPDATE rate_quota SET remaining=?1, reset_at=?2, last_request_at=?3 WHERE id=1"
    ).bind(state.remaining, state.resetAt, state.lastRequestAt).run();
  } catch (e) {
    // Non-fatal — worst case, pacing is a little less accurate next request.
  }
}

// Successful profile resolution enrols the permanent account even when
// the subsequent RR request is unavailable or the account has no games.
async function trackAccountResponse(env,bodyText,route,match){
  if(!env.APP_DB)return;
  const account=JSON.parse(bodyText)?.data;
  if(route.accountByPuuid&&account?.puuid?.toLowerCase()!==match[1].toLowerCase())throw new Error('Wrong account');
  await trackRRAccount(env.APP_DB,account);
}

// Merges a fresh mmr-history response with whatever's already persisted in
// APP_DB (table rr_history) for this player, returns the (possibly
// rewritten) body text to send to both the client and the edge cache.
// Only fresh upstream windows establish predecessor/collection evidence;
// the accumulated response may contain gaps and must never be recollected.
async function mergeRRHistory(env, bodyText, route) {
  if(!env.APP_DB)return bodyText; // Local development without dashboard bindings.
  const parsed=JSON.parse(bodyText);
  const puuid=parsed?.data?.account?.puuid?.toLowerCase();
  if(route.puuid&&puuid!==route.puuid)throw new Error('Wrong RR account');
  await collectRR(env.APP_DB,parsed,{puuid,region:route.region,platform:route.platform});

  const stored = new Map();
  const { results } = await env.APP_DB
      .prepare("SELECT match_id, data FROM rr_history WHERE puuid=?1")
      .bind(puuid).all();
  for (const r of results || [])stored.set(r.match_id,JSON.parse(r.data));
  // Keep this response current even if a D1 read replica trails the write.
  for(const h of parsed.data.history)stored.set(h.match_id,h);

  // Always hand back the full accumulated set (could already be more than
  // these ~20 from a prior visit). The fresh window has already committed.
  parsed.data.history = [...stored.values()].sort(
    (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
  );

  return JSON.stringify(parsed);
}

// Parses HenrikDev's real rate-limit headers into {remaining, resetAt}.
// Same header set as before, just read server-side now instead of forwarded.
function parseUpstreamQuota(headers) {
  let remaining = null, resetSeconds = null;
  const rl = headers.get("ratelimit");
  if (rl) {
    const mr = rl.match(/(?:^|[;\s])r=(\d+)/i);
    const mt = rl.match(/(?:^|[;\s])t=(\d+)/i);
    if (mr) remaining = parseInt(mr[1], 10);
    if (mt) resetSeconds = parseInt(mt[1], 10);
  }
  if (remaining == null) {
    const legacy = headers.get("x-ratelimit-remaining");
    if (legacy != null) remaining = parseInt(legacy, 10);
  }
  if (resetSeconds == null) {
    const reset = headers.get("x-ratelimit-reset");
    if (reset != null) {
      const n = parseInt(reset, 10);
      if (!Number.isNaN(n)) resetSeconds = n > 1e6 ? Math.max(0, Math.round(n - Date.now() / 1000)) : n;
    }
  }
  return {
    remaining: Number.isNaN(remaining) ? null : remaining,
    resetAt: resetSeconds != null && !Number.isNaN(resetSeconds) ? Date.now() + resetSeconds * 1000 : null,
  };
}

// How long to wait before firing the upstream call, given shared quota
// state — glide only when a handful of remaining requests, spaced out,
// would roughly bridge to the reset; otherwise fire immediately, since
// gliding wouldn't meaningfully help.
function planDelay(quota) {
  const since = Date.now() - (quota.lastRequestAt || 0);
  let want = MIN_SPACING_MS;
  if (quota.remaining != null && quota.remaining > 0 && quota.remaining <= GLIDE_BELOW && quota.resetAt > Date.now()) {
    const spread = Math.floor((quota.resetAt - Date.now()) / quota.remaining);
    if (spread <= GLIDE_CAP_MS) want = Math.max(spread, MIN_SPACING_MS);
  }
  return since >= want ? 0 : want - since;
}

const NAME_HISTORY_REFRESH_MS = 24 * 60 * 60 * 1000;

async function savedNameHistory(env, puuid) {
  const history = await readNameHistory(env.APP_DB, puuid);
  const backfill = await backfillState(env.APP_DB, puuid);
  return { puuid, region: backfill.region || null, history, backfill };
}

function hasFreshCurrentName(snapshot, now = Date.now()) {
  const current = snapshot.history.find((row) => row.ended_at == null);
  const lastSeen = Date.parse(current?.last_seen);
  return Number.isFinite(lastSeen) && lastSeen >= now - NAME_HISTORY_REFRESH_MS;
}

function savedNameHistoryResponse(snapshot, source, refreshDeferred = false) {
  const data = refreshDeferred ? { ...snapshot, refreshDeferred: true } : snapshot;
  const res = json({ data }, 200);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Name-History-Source', source);
  return res;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const workflow=request.headers.has('X-Workflow-Key');
  if(workflow){
    if(!env.HENRIK_WORKFLOW_KEY)return json({error:'Workflow proxy misconfigured: HENRIK_WORKFLOW_KEY secret not set'},503);
    if(!await workflowAuthorized(request,env.HENRIK_WORKFLOW_KEY))return json({error:'Unauthorized workflow request'},401);
  }
  const henrikKey=workflow?env.HENRIK_WORKFLOW_KEY:env.HENRIK_KEY;
  const url = new URL(request.url);
  const requestPath = url.pathname.slice(PREFIX.length);
  const coverageMatch=requestPath.match(MATCH_COVERAGE_ROUTE);
  if(coverageMatch){
    if(!env.APP_DB)return json({error:'Coverage storage unavailable'},503);
    try{
      const res=json({data:await beginCoverageScan(env.APP_DB,coverageScope(coverageMatch))},200);
      res.headers.set('Cache-Control','no-store');return res;
    }catch{return json({error:'Coverage storage unavailable'},503);}
  }
  // No HenrikDev counterpart — a pure local D1 read, so it's handled before
  // the upstream ROUTES matching below rather than shoehorned into it. No
  // hard-fail on a missing CALIB_DB binding: getCalibModel() already falls
  // back to the frozen constants, which is a perfectly good response.
  if (requestPath === "/calib-model") return handleCalibModel(env);

  const archiveCountsMatch = requestPath.match(MATCH_ARCHIVE_COUNTS_ROUTE);
  if (archiveCountsMatch) return readMatchArchiveCounts(env, archiveCountsMatch[1].toLowerCase());

  const archiveMatch = requestPath.match(MATCH_ARCHIVE_ROUTE);
  if (archiveMatch) {
    const startText = url.searchParams.get('start') || '0';
    const sizeText = url.searchParams.get('size') || String(MATCH_ARCHIVE_PAGE_SIZE);
    const start = Number(startText);
    const size = Number(sizeText);
    if (!/^\d+$/.test(startText) || !Number.isSafeInteger(start) || start > 5000) {
      return json({ error: 'Invalid archive offset' }, 400);
    }
    if (!/^\d+$/.test(sizeText) || !Number.isInteger(size) || ![MATCH_ARCHIVE_PAGE_SIZE, MATCH_ARCHIVE_MAX_PAGE_SIZE].includes(size)) {
      return json({ error: 'Invalid archive page size' }, 400);
    }
    return readMatchArchive(env, archiveMatch[1].toLowerCase(), archiveMatch[2].toLowerCase(), start, size);
  }

  let route = null, match = null;
  for (const r of ROUTES) {
    const m = requestPath.match(r.match);
    if (m) { route = r; match = m; break; }
  }
  if (!route) return json({ error: "Unknown route" }, 404);
  if(route.rrCollect||route.rrFeature){
    match.discover=route.rrFeature&&url.searchParams.get('discover')==='1';
    for(let i=1;i<match.length;i++)match[i]=match[i].toLowerCase();
    url.search='';
    if(!env.APP_DB)return json({error:'RR corpus storage unavailable'},503);
    if(route.rrFeature){
      try{
        // Callers can only request trusted RR match IDs already in our database.
        const known=await env.APP_DB.prepare('SELECT h.match_id,p.region,p.platform FROM rr_history h LEFT JOIN rr_players p ON p.puuid=h.puuid WHERE h.puuid=?1 AND h.match_id=?2').bind(match[2],match[3]).first();
        if(!known)return json({error:'Unknown RR match'},404);
        match.discoveryScope={puuid:match[2],region:known.region,platform:known.platform};
        const saved=await env.APP_DB.prepare('SELECT match_id FROM rr_match_features WHERE puuid=?1 AND match_id=?2').bind(match[2],match[3]).first();
        if(saved&&!match.discover)return json({data:{puuid:match[2],match_id:match[3],saved:true}},200);
        const archived=await env.APP_DB.prepare('SELECT payload FROM match_archive WHERE puuid=?1 AND match_id=?2').bind(match[2],match[3]).first();
        if(archived){
          const record=await gunzipMatch(archived.payload);
          await saveFeatures(env.APP_DB,record,match[2]);
          if(match.discover)await discoverMatchPlayers(env.APP_DB,record,match.discoveryScope);
          return json({data:{puuid:match[2],match_id:match[3],saved:true}},200);
        }
        const deferred=await env.APP_DB.prepare("SELECT next_attempt_at FROM rr_feature_retry WHERE puuid=?1 AND match_id=?2 AND julianday(next_attempt_at)>julianday('now')")
          .bind(match[2],match[3]).first();
        if(deferred){
          const res=json({data:{puuid:match[2],match_id:match[3],saved:false,deferred:true,
            reason:'upstream_match_not_found',retry_at:deferred.next_attempt_at}},200);
          res.headers.set('Cache-Control','no-store');return res;
        }
      }catch{return json({error:'RR feature storage unavailable'},503);}
    }
  }
  // The player ID selects trusted match rows for shared storage. It is never
  // sent to HenrikDev and never lets a caller supply match contents.
  const scanId=new RegExp(`^${UUID}$`,'i').test(url.searchParams.get('scan')||'')?url.searchParams.get('scan'):null;
  url.searchParams.delete('scan');
  const archivePuuid = route.historyByPuuid?match[3].toLowerCase():route.foldCalibration && url.searchParams.get('mode') === 'competitive'
    && new RegExp(`^${UUID}$`, 'i').test(url.searchParams.get('puuid') || '')
    ? url.searchParams.get('puuid').toLowerCase() : null;
  if (route.foldCalibration) url.searchParams.delete('puuid');
  if(route.historyByPuuid){
    const startText=url.searchParams.get('start')||'0';
    const start=Number(startText);
    if(!/^\d+$/.test(startText)||!Number.isSafeInteger(start)||start>5000)return json({error:'Invalid history offset'},400);
    url.search=`?mode=competitive&size=10&start=${start}`;
  }else if (route.storedMatches) {
    const pageText = url.searchParams.get('page') || '1';
    const page = Number(pageText);
    if (!/^\d+$/.test(pageText) || !Number.isInteger(page) || page < 1 || page > 100) {
      return json({ error: "Invalid stored match page" }, 400);
    }
    url.search = `?mode=competitive&size=100&page=${page}`;
  } else if (route.matchDetail) {
    url.search = '';
  }
  // One cache key per PUUID: arbitrary query strings must not bypass the
  // hourly refresh or supply their own force/name/timestamp parameters.
  let storedNameHistory = null;
  if (route.nameHistory || route.nameBackfill) {
    if (route.nameHistory) match.platform = ['pc','console'].includes(url.searchParams.get('platform'))
      ? url.searchParams.get('platform') : null;
    match[1] = match[1].toLowerCase();
    url.pathname = PREFIX + (route.nameBackfill ? '/name-backfill/' : '/name-history/') + match[1];
    url.search = '';
    if (!env.APP_DB) return json({ error: "Name history storage unavailable" }, 503);
  }
  if (route.nameHistory) {
    try {
      if (match.platform) await env.APP_DB.prepare(
        'UPDATE rr_players SET platform=?2 WHERE puuid=?1 AND platform IS NULL'
      ).bind(match[1],match.platform).run();
      storedNameHistory = await savedNameHistory(env, match[1]);
      // D1 is the display source. A current identity observed within the last
      // day needs no upstream refresh, so never hold its saved timeline behind
      // quota pacing or an account API call.
      if (storedNameHistory.history.length && hasFreshCurrentName(storedNameHistory)) {
        return savedNameHistoryResponse(storedNameHistory, 'SAVED-FRESH');
      }
    } catch {
      return json({ error: "Name history storage unavailable" }, 503);
    }
  }
  if (route.nameBackfill) {
    try {
      match.state = await backfillState(env.APP_DB,match[1],true);
      if (!match.state.available || match.state.complete || match.state.limited) {
        const res=json({data:{puuid:match[1],backfill:match.state,history:await readNameHistory(env.APP_DB,match[1])}},200);
        res.headers.set('Cache-Control','no-store');return res;
      }
    } catch { return json({error:'Name backfill storage unavailable'},503); }
  }
  if (!henrikKey) return json({ error: "Proxy misconfigured: HENRIK_KEY secret not set" }, 500);
  // No hard-fail on a missing APP_DB binding — every function that touches it
  // (getQuota/putQuota/mergeRRHistory/foldCalibration/handleCalibModel) already
  // fails open on its own, so the proxy still works correctly without it, just
  // without cross-request rate-limit coordination, RR-history persistence, or
  // live calibration.

  const cache = caches.default;
  // Never put workflow credentials in an edge-cache key or cached request.
  const cacheKey = new Request(url.toString());
  const cached = workflow || route.rrCollect || route.rrFeature || route.nameBackfill || (route.nameHistory && !storedNameHistory.history.length)
    ? null : await cache.match(cacheKey);
  if (cached) {
    if(route.trackAccount){
      try{await trackAccountResponse(env,await cached.clone().text(),route,match);}
      catch{return json({error:'RR account could not be tracked'},503);}
    }
    if(scanId){
      try{await observeCoverageResponse(env,scanId,route,match,url,await cached.clone().text());}
      catch{/* Never certify a page whose archive/evidence write failed. */}
    }
    // The upstream account check can stay cached, but newly backfilled names
    // and progress must be visible immediately rather than an hour later.
    if (route.nameHistory && storedNameHistory.history.length) {
      try {
        const body = await cached.json();
        body.data.history = storedNameHistory.history;
        body.data.backfill = storedNameHistory.backfill;
        const res = json(body,200); res.headers.set('X-Proxy-Cache','HIT');res.headers.set('Cache-Control','no-store');return res;
      } catch { return json({error:'Name history storage unavailable'},503); }
    }
    if (route.foldCalibration && archivePuuid && !scanId) {
      context.waitUntil(cached.clone().text().then(body => saveMatchArchivePage(env, body, archivePuuid)).catch(() => {}));
    }
    const res = new Response(cached.body, cached);
    res.headers.set("X-Proxy-Cache", "HIT");
    return res;
  }

  // Quota check BEFORE touching HenrikDev at all — if the shared state says
  // we're already out for this window, decline immediately with a plain
  // wait-time signal instead of burning a real upstream call we know will
  // just 429.
  let quota;
  try{quota=await getQuota(env,workflow);}
  catch{return json({error:'Workflow quota storage unavailable'},503);}
  if (quota.remaining != null && quota.remaining <= 0 && quota.resetAt > Date.now()) {
    if (route.nameHistory && storedNameHistory.history.length) {
      return savedNameHistoryResponse(storedNameHistory, 'SAVED-REFRESH-DEFERRED', true);
    }
    return json({ error: "Rate limited", retryAfterMs: quota.resetAt - Date.now() }, 429);
  }

  const delay = planDelay(quota);
  if (delay > 0) await sleep(delay);

  const upstreamUrl = UPSTREAM + route.upstream(match) + url.search;
  const observedAt = new Date().toISOString();
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Authorization: henrikKey, Accept: "application/json" },
    });
  } catch (e) {
    if (route.nameHistory && storedNameHistory.history.length) {
      return savedNameHistoryResponse(storedNameHistory, 'SAVED-REFRESH-DEFERRED', true);
    }
    return json({ error: "Upstream fetch failed" }, 502);
  }

  // Learn from this call's real headers regardless of outcome, and persist
  // for every other concurrent/future request to read.
  const parsed = parseUpstreamQuota(upstream.headers);
  const nextQuota = {
    remaining: parsed.remaining ?? quota.remaining,
    resetAt: parsed.resetAt ?? quota.resetAt,
    lastRequestAt: Date.now(),
  };
  context.waitUntil(putQuota(env, nextQuota, workflow));

  if (upstream.status === 429) {
    if (route.nameHistory && storedNameHistory.history.length) {
      return savedNameHistoryResponse(storedNameHistory, 'SAVED-REFRESH-DEFERRED', true);
    }
    const headerRetry = upstream.headers.get("retry-after");
    const retryMs = headerRetry != null ? Math.max(parseInt(headerRetry, 10), 0) * 1000 : 0;
    const resetMs = nextQuota.resetAt ? Math.max(0, nextQuota.resetAt - Date.now()) : 0;
    return json({ error: "Rate limited", retryAfterMs: Math.max(retryMs, resetMs, 1000) }, 429);
  }

  let bodyText = await upstream.text();
  const contentType = upstream.headers.get("Content-Type") || "application/json";
  if(route.rrCollect&&[400,403,404].includes(upstream.status)){
    try{await env.APP_DB.prepare('INSERT INTO rr_candidate_checks(puuid,platform,checked_at) VALUES(?1,?2,?3) ON CONFLICT(puuid,platform) DO UPDATE SET checked_at=excluded.checked_at')
      .bind(match[3],match[2],new Date().toISOString()).run();}
    catch{return json({error:'RR discovery retry could not be saved'},503);}
  }
  if(route.rrFeature&&upstream.status===404){
    try{
      await env.APP_DB.prepare("INSERT INTO rr_feature_retry(puuid,match_id,next_attempt_at) VALUES(?1,?2,datetime('now','+1 day')) ON CONFLICT(puuid,match_id) DO UPDATE SET attempts=rr_feature_retry.attempts+1,next_attempt_at=datetime('now',CASE WHEN rr_feature_retry.attempts=1 THEN '+3 days' ELSE '+7 days' END)")
        .bind(match[2],match[3]).run();
      const deferred=await env.APP_DB.prepare('SELECT next_attempt_at FROM rr_feature_retry WHERE puuid=?1 AND match_id=?2').bind(match[2],match[3]).first();
      const res=json({data:{puuid:match[2],match_id:match[3],saved:false,deferred:true,
        reason:'upstream_match_not_found',retry_at:deferred.next_attempt_at}},200);
      res.headers.set('Cache-Control','no-store');return res;
    }
    catch{return json({error:'RR retry could not be saved'},503);}
  }

  if (route.nameHistory && upstream.status >= 500 && storedNameHistory.history.length) {
    return savedNameHistoryResponse(storedNameHistory, 'SAVED-REFRESH-DEFERRED', true);
  }

  if (upstream.status === 404 && route.nameBackfill && match.state.phase!=='matches') {
    try {
      const backfill=match.state.phase==='stored-detail'
        ?await skipStoredMatchDetail(env.APP_DB,match[1],match.state)
        :await saveStoredBackfillPage(env.APP_DB,match[1],match.state,{data:[],results:{after:0}});
      const history=await readNameHistory(env.APP_DB,match[1]);
      const res=json({data:{puuid:match[1],backfill,history}},200);
      res.headers.set('Cache-Control','no-store');return res;
    } catch {
      console.error('Unavailable stored history could not be completed');
      return json({error:'Name backfill page unavailable'},503);
    }
  }

  if (upstream.status === 200 && route.nameBackfill) {
    let payload;
    try { payload=JSON.parse(bodyText); } catch {}
    if (match.state.phase==='stored-detail'?!payload?.data||Array.isArray(payload.data):!Array.isArray(payload?.data))
      return json({error:'Invalid match history response'},502);
    try {
      const backfill=match.state.phase==='stored-detail'
        ?await saveStoredMatchDetail(env.APP_DB,match[1],match.state,payload.data)
        :match.state.phase==='stored'
          ?await saveStoredBackfillPage(env.APP_DB,match[1],match.state,payload)
          :await saveBackfillPage(env.APP_DB,match[1],match.state,payload.data);
      const history=await readNameHistory(env.APP_DB,match[1]);
      const res=json({data:{puuid:match[1],backfill,history}},200);
      res.headers.set('Cache-Control','no-store');return res;
    } catch {
      console.error('Name backfill page could not be saved');
      return json({error:'Name backfill page unavailable'},503);
    }
  }

  if (upstream.status === 200 && route.nameHistory) {
    let account;
    try { account = JSON.parse(bodyText).data; } catch {}
    if (account?.puuid?.toLowerCase() !== match[1] || !account?.name || !account?.tag) {
      return json({ error: "Invalid account response" }, 502);
    }
    try {
      const history = await observeName(env.APP_DB, { ...account, puuid: match[1], platform: match.platform }, observedAt);
      const backfill = await backfillState(env.APP_DB,match[1]);
      bodyText = JSON.stringify({ data: { puuid: match[1], region: account.region, history, backfill } });
    } catch {
      // Do not report a successful daily check if the observation wasn't saved.
      console.error('Name history persistence failed');
      return json({ error: "Name history storage unavailable" }, 503);
    }
  }

  if (upstream.status === 200 && route.foldCalibration) {
    if (archivePuuid && !scanId) context.waitUntil(saveMatchArchivePage(env, bodyText, archivePuuid).catch(() => {}));
    // Fire-and-forget: never touches bodyText/the response, so this adds
    // zero latency to the user-facing request either way.
    context.waitUntil(
      foldCalibration(env, bodyText, {
        region: match[1], platform: match[2], name: route.historyByPuuid?null:decodeURIComponent(match[3]), tag: route.historyByPuuid?null:match[4],
      }).catch(() => {})
    );
  }

  if(upstream.status===200&&scanId){
    try{await observeCoverageResponse(env,scanId,route,match,url,bodyText);}
    catch{/* Match fetching remains available; failed evidence cannot certify coverage. */}
  }

  if (upstream.status === 200 && route.persistRRHistory) {
    try{
      bodyText = await mergeRRHistory(env, bodyText, {
        region: match[1], platform: match[2],puuid:route.byPuuid?match[3].toLowerCase():null,
      });
    }catch{
      console.error('Profile RR corpus persistence failed');
      return json({error:'RR corpus could not be saved'},503);
    }
  }

  if(upstream.status===200&&route.trackAccount){
    try{await trackAccountResponse(env,bodyText,route,match);}
    catch{return json({error:'RR account could not be tracked'},503);}
  }

  if(upstream.status===200&&(route.rrCollect||route.rrFeature)){
    try{
      const payload=JSON.parse(bodyText);
      let data;
      if(route.rrCollect)data=await collectRR(env.APP_DB,payload,{region:match[1],platform:match[2],puuid:match[3]});
      else{
        if(payload.data?.metadata?.match_id?.toLowerCase()!==match[3])throw new Error('Wrong match');
        await saveFeatures(env.APP_DB,payload.data,match[2]);
        if(match.discover)await discoverMatchPlayers(env.APP_DB,payload.data,match.discoveryScope);
        data={puuid:match[2],match_id:match[3],saved:true};
      }
      const res=json({data},200);res.headers.set('Cache-Control','no-store');return res;
    }catch{
      console.error('RR corpus persistence failed');
      return json({error:'RR corpus could not be saved'},503);
    }
  }

  const res = new Response(bodyText, {
    status: upstream.status,
    headers: { "Content-Type": contentType },
  });
  res.headers.set("X-Proxy-Cache", "MISS");
  if (workflow || route.nameHistory || route.nameBackfill) res.headers.set('Cache-Control','no-store');
  // Deliberately no rate-limit headers of any kind on the response — that's
  // the whole point of this rewrite. The client only ever sees success or a
  // 429 with retryAfterMs in the body.

  if (upstream.status === 200 && !workflow && !route.nameBackfill && !route.rrCollect && !route.rrFeature) {
    const cacheRes = new Response(bodyText, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${route.cacheTtl}`,
      },
    });
    context.waitUntil(cache.put(cacheKey, cacheRes));
  }

  return res;
}

export async function onRequestPost({request,env}){
  const match=new URL(request.url).pathname.slice(PREFIX.length).match(MATCH_COVERAGE_ROUTE);
  if(!match)return json({error:'Unknown route'},404);
  if(!env.APP_DB)return json({error:'Coverage storage unavailable'},503);
  let body;
  try{
    // No match data, counts, or browser assertions are accepted here.
    const reader=request.body?.getReader();
    if(!reader)return json({error:'Invalid coverage request'},400);
    const decoder=new TextDecoder();
    let text='',bytes=0;
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        bytes+=value.byteLength;
        if(bytes>256){await reader.cancel();return json({error:'Invalid coverage request'},400);}
        text+=decoder.decode(value,{stream:true});
      }
      text+=decoder.decode();
    }finally{reader.releaseLock();}
    body=JSON.parse(text);
  }catch{return json({error:'Invalid coverage request'},400);}
  if(!new RegExp(`^${UUID}$`,'i').test(body?.scanId||'')||Object.keys(body).some(key=>key!=='scanId'))
    return json({error:'Invalid coverage request'},400);
  try{
    const res=json({data:await finishCoverageScan(env.APP_DB,coverageScope(match),body.scanId)},200);
    res.headers.set('Cache-Control','no-store');return res;
  }catch{return json({error:'Coverage storage unavailable'},503);}
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
