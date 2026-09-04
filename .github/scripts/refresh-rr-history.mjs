// Both calls go through the site's proxy: no HenrikDev key is needed here,
// and daily checks share the live site's quota pacing and persistence.
import { pathToFileURL } from 'node:url';

const DELAY_MS = 2500;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function requestJSON(url, fetchImpl = fetch, sleepImpl = sleep) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => null);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) {
          const retry = res.status === 429 ? body?.retryAfterMs : 2500 * 2 ** attempt;
          await sleepImpl(Number.isFinite(retry) ? Math.max(1000, Math.min(retry, 120000)) : 30000);
          continue;
        }
      }
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      if (!body?.data) return { ok: false, reason: 'invalid JSON response' };
      return { ok: true, data: body.data };
    } catch {
      if (attempt === 2) return { ok: false, reason: 'network error or timeout' };
      await sleepImpl(2500 * 2 ** attempt);
    }
  }
  return { ok: false, reason: 'retries exhausted' };
}

export async function refreshPlayer(player, { origin, fetchImpl = fetch, sleepImpl = sleep }) {
  const id = encodeURIComponent(player.puuid);
  const name = await requestJSON(`${origin}/api/name-history/${id}`, fetchImpl, sleepImpl);
  if (name.ok && (!Array.isArray(name.data.history) || !name.data.history.length ||
      name.data.puuid !== player.puuid.toLowerCase())) {
    name.ok = false; name.reason = 'invalid name history response';
  }
  // A failed name check must not prevent RR refreshes. The immutable PUUID
  // also lets RR continue working after a rename or a stale stored Riot ID.
  const region = name.ok ? name.data.region || player.region : player.region;
  let rr = { ok: true, skipped: true };
  if (region && player.platform) {
    await sleepImpl(DELAY_MS);
    rr = await requestJSON(`${origin}/api/mmr-history-by-puuid/${encodeURIComponent(region)}/${encodeURIComponent(player.platform)}/${id}`, fetchImpl, sleepImpl);
    if (rr.ok && (!Array.isArray(rr.data.history) || rr.data.account?.puuid?.toLowerCase() !== player.puuid.toLowerCase())) {
      rr.ok = false; rr.reason = 'invalid RR response';
    }
  }
  return { name, rr, ok: name.ok && rr.ok };
}

async function listPlayers(env) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
  const players = [];
  let cursor = '';
  for (;;) {
    const res = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT puuid,region,platform,name,tag FROM rr_players WHERE puuid>?1 ORDER BY puuid LIMIT 500', params: [cursor] }),
    });
    const body = await res.json();
    if (!res.ok || !body.success || !body.result?.[0]?.success) throw new Error(`D1 player query failed (${res.status})`);
    const rows = body.result[0].results || [];
    players.push(...rows);
    if (rows.length < 500) return players;
    cursor = rows.at(-1).puuid;
  }
}

export async function main(env = process.env) {
  for (const key of ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_D1_DATABASE_ID']) {
    if (!env[key]) throw new Error(`Missing required secret: ${key}`);
  }
  const origin = new URL(env.SITE_ORIGIN || 'https://vlravg.pages.dev').origin;
  const maxPlayers = Number(env.MAX_PLAYERS || 0);
  if (!Number.isSafeInteger(maxPlayers) || maxPlayers < 0) throw new Error('MAX_PLAYERS must be a nonnegative integer');
  const allPlayers = await listPlayers(env);
  const players = maxPlayers ? allPlayers.slice(0, maxPlayers) : allPlayers;
  console.log(`Checking names and RR for ${players.length} tracked player(s).`);
  let failed = 0;
  for (const [i, player] of players.entries()) {
    const result = await refreshPlayer(player, { origin });
    if (!result.ok) failed++;
    const current = result.name.ok ? result.name.data.history.find(h => h.ended_at == null) : null;
    const renamed = current && (current.name !== player.name || current.tag !== player.tag);
    console.log(`[${i + 1}/${players.length}] ${player.puuid}: name ${result.name.ok ? renamed ? 'changed' : 'checked' : 'FAILED: ' + result.name.reason}; RR ${result.rr.ok ? result.rr.skipped ? 'not tracked yet' : result.rr.data.history.length + ' matches' : 'FAILED: ' + result.rr.reason}`);
    if (i < players.length - 1) await sleep(DELAY_MS);
  }
  console.log(`Done: ${players.length - failed} succeeded, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
