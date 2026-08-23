// Walks every player in the RR-history KV cache and re-pings the site's own
// /api/mmr-history endpoint for each, so persisted history keeps growing
// without anyone visiting the site. See the workflow file for required
// secrets.
//
// Deliberately goes through the PUBLIC endpoint rather than calling HenrikDev
// directly: that reuses the worker's rate limiting, shared quota pacing and
// mergeRRHistory persistence, so this job needs no API key of its own and
// can't out-run the quota the live site is also sharing.

const {
  CF_API_TOKEN,
  CF_ACCOUNT_ID,
  CF_KV_NAMESPACE_ID,
  SITE_ORIGIN = "https://vlravg.pages.dev",
} = process.env;

// Pacing. HenrikDev allows ~60 req/min on this key and the live site shares
// it, so stay well under: one player per ~2.5s leaves plenty of headroom.
const DELAY_MS = 2500;
const MAX_PLAYERS = 400;      // safety bound on a single run
const RETRY_429_MS = 30000;

for (const [k, v] of Object.entries({ CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID })) {
  if (!v) {
    console.error(`Missing required secret: ${k}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// KV list returns each key's metadata inline, so one paged walk gives us
// every player's region/platform/name/tag without reading the values.
async function listPlayers() {
  const players = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/keys`
    );
    url.searchParams.set("prefix", "rrhist:");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`KV list failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    if (!body.success) {
      throw new Error(`KV list error: ${JSON.stringify(body.errors)}`);
    }

    for (const entry of body.result || []) {
      const m = entry.metadata || {};
      if (!m.region || !m.platform || !m.name || !m.tag) continue; // pre-metadata record
      players.push({
        puuid: entry.name.slice("rrhist:".length),
        region: m.region,
        platform: m.platform,
        name: m.name,
        tag: m.tag,
        updatedAt: m.updatedAt || null,
      });
    }

    cursor = body.result_info?.cursor || "";
    if (!cursor) break;
  }
  return players;
}

async function refresh(p) {
  const url =
    `${SITE_ORIGIN}/api/mmr-history/${encodeURIComponent(p.region)}/${encodeURIComponent(p.platform)}` +
    `/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      return { ok: false, reason: `network: ${e.message}` };
    }

    if (res.status === 429) {
      // Worker declined on shared quota — wait out the window it gives us.
      let waitMs = RETRY_429_MS;
      try {
        const b = await res.json();
        if (typeof b.retryAfterMs === "number") waitMs = Math.min(b.retryAfterMs, 120000);
      } catch {}
      if (attempt === 0) {
        await sleep(waitMs);
        continue;
      }
      return { ok: false, reason: "rate limited" };
    }

    if (!res.ok) return { ok: false, reason: `http ${res.status}` };

    try {
      const body = await res.json();
      const n = body?.data?.history?.length ?? 0;
      return { ok: true, matches: n, cache: res.headers.get("X-Proxy-Cache") };
    } catch {
      return { ok: true, matches: null };
    }
  }
  return { ok: false, reason: "retries exhausted" };
}

const started = Date.now();
const players = await listPlayers();
console.log(`Found ${players.length} cached player(s) in KV.`);

if (!players.length) {
  console.log("Nothing to refresh — the cache is empty, or no record carries identity metadata yet.");
  console.log("Records written before metadata was added are skipped; they self-heal the next time");
  console.log("that player is searched on the site.");
  process.exit(0);
}

const targets = players.slice(0, MAX_PLAYERS);
if (players.length > MAX_PLAYERS) {
  console.log(`Capping this run at ${MAX_PLAYERS} players.`);
}

let ok = 0, failed = 0;
for (const [i, p] of targets.entries()) {
  const r = await refresh(p);
  if (r.ok) {
    ok++;
    console.log(`  [${i + 1}/${targets.length}] ${p.name}#${p.tag} (${p.region}) -> ${r.matches ?? "?"} matches${r.cache ? ` [${r.cache}]` : ""}`);
  } else {
    failed++;
    console.log(`  [${i + 1}/${targets.length}] ${p.name}#${p.tag} (${p.region}) -> FAILED: ${r.reason}`);
  }
  if (i < targets.length - 1) await sleep(DELAY_MS);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nDone in ${mins} min — ${ok} refreshed, ${failed} failed.`);

// A few individual failures (a renamed Riot ID, a transient upstream blip) are
// expected and shouldn't redden the run; a wholesale failure should.
if (failed > 0 && ok === 0) {
  console.error("Every refresh failed — check SITE_ORIGIN and that /api/mmr-history is reachable.");
  process.exit(1);
}
