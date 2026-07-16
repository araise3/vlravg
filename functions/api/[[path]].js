/**
 * Cloudflare Pages Function — proxies a small, explicit set of routes to the
 * HenrikDev API with the key injected server-side. Lives at
 * functions/api/[[path]].js so it catches every request under /api/ on the
 * same domain as your page.
 *
 * REQUIRED BINDINGS (Pages project → Settings → Variables and Secrets):
 *   HENRIK_KEY   (Secret)         your HDEV-... key
 *   RATE_LIMIT_KV (KV namespace)  create a namespace (any name) and bind it
 *                                 to the variable name RATE_LIMIT_KV
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
 * RATE LIMITING — fully server-side now, nothing exposed to the browser:
 * HenrikDev's real rate-limit headers (remaining/reset/retry-after) used to
 * be forwarded straight to the client so it could pace itself. Two problems
 * with that: it leaks live details about this key's quota to anyone with
 * devtools open, and — worse — it's a usable DoS vector, since watching
 * `remaining` approach zero tells you exactly when to push it over the edge
 * for every other user of the app. Fixed by moving all quota awareness here:
 *   - Quota state {remaining, resetAt} is tracked in RATE_LIMIT_KV, a single
 *     shared record read/written on every live (cache-miss) request — so
 *     pacing is coordinated across every concurrent user of the app hitting
 *     this one HenrikDev key, not just per browser tab like before.
 *   - Before making an upstream call, if KV says quota is already exhausted
 *     this window, the request is declined immediately (no upstream call at
 *     all) with a plain JSON body: {error, retryAfterMs}. No headers, no raw
 *     numbers — just how long to wait.
 *   - Otherwise, a small pacing delay may be applied server-side (same
 *     "glide only if it actually helps" logic the client used to do, just
 *     using shared state instead of one browser's private view) before the
 *     real upstream call, so concurrent users don't all burst at once.
 *   - After a live call, HenrikDev's real headers are parsed and written back
 *     to KV, but never forwarded to the response — the client only ever sees
 *     success, or a 429 with a retryAfterMs it should wait out.
 *
 * CONSISTENCY CAVEAT: Workers KV is eventually consistent (writes can take
 * up to ~60s to propagate globally), so this pacing is best-effort, not a
 * hard guarantee — under heavy concurrent load from multiple edge locations,
 * a real 429 from HenrikDev can still occasionally slip through despite the
 * KV check. That's handled gracefully (relayed to the client as a computed
 * retryAfterMs, same as any other 429), so it degrades safely rather than
 * breaking. For airtight, race-free coordination a Durable Object would be
 * the correct upgrade — more setup (its own class + migration + binding)
 * than felt justified for a first pass, since "occasionally still gets a
 * real 429, but never leaks real quota to the browser" already satisfies the
 * actual goal here.
 */

const UPSTREAM = "https://api.henrikdev.xyz";
const PREFIX = "/api";
const QUOTA_KEY = "quota"; // single shared record — HenrikDev's limit is one pool across all endpoints

// Pacing tuning — mirrors the client's old planDelay() logic, just now
// operating on state shared across every concurrent user instead of one
// browser's private view.
const MIN_SPACING_MS = 150;   // floor between any two upstream calls
const GLIDE_BELOW = 10;       // only start spacing out once this few requests remain in the window
const GLIDE_CAP_MS = 4000;    // don't glide if the resulting spacing would be absurdly long — just fire

// Public route -> real upstream HenrikDev path + this route's cache TTL.
const ROUTES = [
  {
    // /api/account/{name}/{tag}
    match: /^\/account\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v1/account/${m[1]}/${m[2]}`,
    cacheTtl: 86400, // name/tag -> puuid: only changes on a Riot ID rename
  },
  {
    // /api/rank/{region}/{platform}/{name}/{tag}
    match: /^\/rank\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v3/mmr/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
    cacheTtl: 90, // current rank/RR: changes the moment a match finishes
  },
  {
    // /api/history/{region}/{platform}/{name}/{tag} (query string passed through as-is)
    match: /^\/history\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    upstream: (m) => `/valorant/v4/matches/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
    cacheTtl: 150, // individual matches are immutable, but the list grows as new ones finish
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getQuota(env) {
  try {
    const raw = await env.RATE_LIMIT_KV.get(QUOTA_KEY);
    if (!raw) return { remaining: null, resetAt: 0, lastRequestAt: 0 };
    const parsed = JSON.parse(raw);
    return {
      remaining: parsed.remaining ?? null,
      resetAt: parsed.resetAt ?? 0,
      lastRequestAt: parsed.lastRequestAt ?? 0,
    };
  } catch (e) {
    // KV unavailable/misconfigured — fail open (treat as unknown quota)
    // rather than blocking every request.
    return { remaining: null, resetAt: 0, lastRequestAt: 0 };
  }
}

async function putQuota(env, state) {
  try {
    await env.RATE_LIMIT_KV.put(QUOTA_KEY, JSON.stringify(state));
  } catch (e) {
    // Non-fatal — worst case, pacing is a little less accurate next request.
  }
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const requestPath = url.pathname.slice(PREFIX.length);

  let route = null, match = null;
  for (const r of ROUTES) {
    const m = requestPath.match(r.match);
    if (m) { route = r; match = m; break; }
  }
  if (!route) return json({ error: "Unknown route" }, 404);
  if (!env.HENRIK_KEY) return json({ error: "Proxy misconfigured: HENRIK_KEY secret not set" }, 500);
  if (!env.RATE_LIMIT_KV) return json({ error: "Proxy misconfigured: RATE_LIMIT_KV binding not set" }, 500);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("X-Proxy-Cache", "HIT");
    return res;
  }

  // Quota check BEFORE touching HenrikDev at all — if the shared state says
  // we're already out for this window, decline immediately with a plain
  // wait-time signal instead of burning a real upstream call we know will
  // just 429.
  let quota = await getQuota(env);
  if (quota.remaining != null && quota.remaining <= 0 && quota.resetAt > Date.now()) {
    return json({ error: "Rate limited", retryAfterMs: quota.resetAt - Date.now() }, 429);
  }

  const delay = planDelay(quota);
  if (delay > 0) await sleep(delay);

  const upstreamUrl = UPSTREAM + route.upstream(match) + url.search;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Authorization: env.HENRIK_KEY, Accept: "application/json" },
    });
  } catch (e) {
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
  context.waitUntil(putQuota(env, nextQuota));

  if (upstream.status === 429) {
    const headerRetry = upstream.headers.get("retry-after");
    const retryMs = headerRetry != null ? Math.max(parseInt(headerRetry, 10), 0) * 1000 : 0;
    const resetMs = nextQuota.resetAt ? Math.max(0, nextQuota.resetAt - Date.now()) : 0;
    return json({ error: "Rate limited", retryAfterMs: Math.max(retryMs, resetMs, 1000) }, 429);
  }

  const bodyText = await upstream.text();
  const contentType = upstream.headers.get("Content-Type") || "application/json";

  const res = new Response(bodyText, {
    status: upstream.status,
    headers: { "Content-Type": contentType },
  });
  res.headers.set("X-Proxy-Cache", "MISS");
  // Deliberately no rate-limit headers of any kind on the response — that's
  // the whole point of this rewrite. The client only ever sees success or a
  // 429 with retryAfterMs in the body.

  if (upstream.status === 200) {
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
