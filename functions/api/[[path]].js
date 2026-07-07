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
 *
 * This is a plain pass-through: it injects the key and forwards HenrikDev's
 * response (status, body, and the rate-limit / reset headers the client paces
 * off) verbatim. No edge caching — the client relies on HenrikDev's own
 * server-side cache, and every request goes upstream so rate-limit headers are
 * always live and accurate.
 */

const UPSTREAM = "https://api.henrikdev.xyz";
const PREFIX = "/api";

// Rate-limit / reset headers the browser client needs to read off each response.
// Forwarded verbatim from upstream and exposed to page JS below.
const RATELIMIT_HEADERS = [
  "ratelimit",              // IETF combined header (v4.5+): "per1min";r=..;t=..
  "ratelimit-policy",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",      // reset time — client paces off this
  "retry-after",
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // /api/valorant/... -> https://api.henrikdev.xyz/valorant/...
  const upstreamUrl = UPSTREAM + url.pathname.slice(PREFIX.length) + url.search;

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

  // Forward the rate-limit / reset headers verbatim so the client can pace.
  for (const name of RATELIMIT_HEADERS) {
    const v = upstream.headers.get(name);
    if (v != null) res.headers.set(name, v);
  }
  // Make them readable by page JavaScript (non-safelisted response headers must
  // be opted-in even same-origin).
  res.headers.set("Access-Control-Expose-Headers", RATELIMIT_HEADERS.join(", "));

  return res;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
