/**
 * Cloudflare Pages Function — proxies /api/valorant/* to the HenrikDev API
 * with the key injected server-side. Lives at functions/api/[[path]].js so it
 * catches every request under /api/ on the same domain as your page.
 *
 * Set the key as a SECRET in your Pages project:
 *   Dashboard → your project → Settings → Variables and Secrets → add
 *     HENRIK_KEY = your HDEV-... key   (choose the "Secret" / encrypted type)
 *   or:  wrangler pages secret put HENRIK_KEY --project-name=<your-project>
 *
 * Because the page and this function share one origin, no CORS or Origin
 * allowlist is needed — the browser just calls /api/... normally.
 */

const UPSTREAM = "https://api.henrikdev.xyz";
const PREFIX = "/api";

// Rate-limit / cache headers the browser client needs to read off each response.
// These are forwarded verbatim from upstream and exposed to page JS below.
const RATELIMIT_HEADERS = [
  "ratelimit",              // IETF combined header (v4.5+): "per1min";r=..;t=..
  "ratelimit-policy",       // companion policy header, if sent
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",      // <- the reset time; this is what was missing
  "retry-after",
  "x-cache-status",         // upstream cache state (HIT/MISS), if sent
  "x-cache-ttl",
];

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);

  // /api/valorant/... -> https://api.henrikdev.xyz/valorant/...
  const upstreamUrl = UPSTREAM + url.pathname.slice(PREFIX.length) + url.search;

  // Edge cache: identical player/act lookups are served from cache instead of
  // spending your rate budget. Past acts basically never change; 120s is safe.
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("X-Proxy-Cache", "HIT");
    // A cache hit spent no rate budget, so its stored ratelimit headers are
    // stale/misleading — strip them so the client doesn't act on old numbers.
    for (const h of RATELIMIT_HEADERS) r.headers.delete(h);
    exposeHeaders(r.headers);
    return r;
  }

  if (!env.HENRIK_KEY) {
    return json({ error: "Proxy misconfigured: HENRIK_KEY secret not set" }, 500);
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Authorization: env.HENRIK_KEY, Accept: "application/json" },
    });
  } catch (e) {
    return json({ error: "Upstream fetch failed" }, 502);
  }

  const res = new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    },
  });

  // Forward every rate-limit / cache header the client's pacing logic reads,
  // verbatim from upstream (case-insensitive get, so "RateLimit" etc. all work).
  for (const name of RATELIMIT_HEADERS) {
    const v = upstream.headers.get(name);
    if (v != null) res.headers.set(name, v);
  }
  res.headers.set("X-Proxy-Cache", "MISS");
  exposeHeaders(res.headers);

  // Only cache genuinely cacheable successful responses. Note we cache the body
  // WITH the ratelimit headers attached, but the HIT branch above deletes them
  // on the way out, so a replay never feeds the client stale quota numbers.
  if (upstream.ok) {
    res.headers.set("Cache-Control", "public, max-age=120");
    waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

// Tell the browser these response headers are readable by page JavaScript.
// (Even same-origin, non-safelisted response headers must be opted-in here for
// fetch()'s Headers.get() to return them.)
function exposeHeaders(headers) {
  headers.set(
    "Access-Control-Expose-Headers",
    [...RATELIMIT_HEADERS, "x-proxy-cache"].join(", ")
  );
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
