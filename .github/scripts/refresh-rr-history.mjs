// Walks every player in the rr_players D1 table and re-pings the site's own
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
  CF_D1_DATABASE_ID,
  SITE_ORIGIN = "https://vlravg.pages.dev",
} = process.env;

// Pacing. HenrikDev allows ~60 req/min on this key and the live site shares
// it, so stay well under: one player per ~2.5s leaves plenty of headroom.
// No player-count ceiling — D1's Free-plan cap (100k rows written/day) has
// no trouble with the full player list; the run just takes longer as the
// list grows (bounded by the workflow's own timeout-minutes instead).
const DELAY_MS = 2500;
const RETRY_429_MS = 30000;

for (const [k, v] of Object.entries({ CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID })) {
  if (!v) {
    console.error(`Missing required secret: ${k}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One query against the rr_players table (see schema.sql) — populated by
// mergeRRHistory() on every real lookup — gives every player's identity in
// one round trip, no paging needed the way KV's key-list API required.
async function listPlayers() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql: "SELECT puuid, region, platform, name, tag, updated_at FROM rr_players" }),
  });
  if (!res.ok) {
    throw new Error(`D1 query failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`D1 query error: ${JSON.stringify(body.errors)}`);
  }
  const rows = body.result?.[0]?.results || [];
  return rows
    .filter((r) => r.region && r.platform && r.name && r.tag)
    .map((r) => ({
      puuid: r.puuid,
      region: r.region,
      platform: r.platform,
      name: r.name,
      tag: r.tag,
      updatedAt: r.updated_at || null,
    }));
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
console.log(`Found ${players.length} tracked player(s) in D1.`);

if (!players.length) {
  console.log("Nothing to refresh — rr_players is empty, or no row carries identity fields yet.");
  process.exit(0);
}

let ok = 0, failed = 0;
for (const [i, p] of players.entries()) {
  const r = await refresh(p);
  if (r.ok) {
    ok++;
    console.log(`  [${i + 1}/${players.length}] ${p.name}#${p.tag} (${p.region}) -> ${r.matches ?? "?"} matches${r.cache ? ` [${r.cache}]` : ""}`);
  } else {
    failed++;
    console.log(`  [${i + 1}/${players.length}] ${p.name}#${p.tag} (${p.region}) -> FAILED: ${r.reason}`);
  }
  if (i < players.length - 1) await sleep(DELAY_MS);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nDone in ${mins} min — ${ok} refreshed, ${failed} failed.`);

// A few individual failures (a renamed Riot ID, a transient upstream blip) are
// expected and shouldn't redden the run; a wholesale failure should.
if (failed > 0 && ok === 0) {
  console.error("Every refresh failed — check SITE_ORIGIN and that /api/mmr-history is reachable.");
  process.exit(1);
}
