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

  // Forward the headers the client's retry logic reads.
  const rem = upstream.headers.get("x-ratelimit-remaining");
  if (rem != null) res.headers.set("x-ratelimit-remaining", rem);
  const retry = upstream.headers.get("retry-after");
  if (retry != null) res.headers.set("retry-after", retry);
  res.headers.set("X-Proxy-Cache", "MISS");

  if (upstream.ok) {
    res.headers.set("Cache-Control", "public, max-age=120");
    waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
