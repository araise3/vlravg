/**
 * Bounded, read-only probe of the VALORANT client's player-data endpoints.
 *
 * Set RIOT_AUTH_SOURCE=local to get tokens from a running Windows Riot Client.
 * The remote cookie/token flow remains available for comparison. No
 * credentials are saved or printed. Run with --help for usage.
 */

import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';

const SHARDS = new Set(['na', 'eu', 'ap', 'kr', 'pbe']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PLATFORM = Buffer.from(JSON.stringify({
  platformType: 'PC',
  platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit',
  platformChipset: 'Unknown',
})).toString('base64');
const AUTH_URL = 'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid';

function parseArgs(args) {
  if (args.includes('--help')) return { help: true };
  if ((args.length !== 2 && args.length !== 3) ||
      (args.length === 3 && !['--auth-only', '--content-only', '--custom-only', '--current-only'].includes(args[2])) ||
      !SHARDS.has(args[0]) ||
      (args[1] !== 'self' && !UUID.test(args[1]))) {
    throw new Error('Usage: node scripts/probe-riot-client.mjs <na|eu|ap|kr|pbe> <self|target-puuid> [--auth-only|--content-only|--custom-only|--current-only]');
  }
  return { shard: args[0], puuid: args[1], mode: args[2] || 'player' };
}

function rateHeaders(headers) {
  const result = {};
  for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
    const value = headers.get(name);
    if (value != null) result[name] = value;
  }
  // The full `ratelimit` header can contain an opaque partition key.
  const limit = headers.get('ratelimit');
  if (limit) {
    const quota = limit.match(/(?:^|;)q=(\d+)/);
    const remaining = limit.match(/(?:^|;)r=(\d+)/);
    const resetSeconds = limit.match(/(?:^|;)t=(\d+)/);
    if (quota) result.quota = Number(quota[1]);
    if (remaining) result.remaining = Number(remaining[1]);
    if (resetSeconds) result.resetSeconds = Number(resetSeconds[1]);
  }
  return result;
}

async function read(label, url, headers, summarize, allow404 = false) {
  const start = performance.now();
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const data = response.ok ? await response.json() : null;
  const result = {
    endpoint: label,
    status: response.status,
    elapsedMs: Math.round(performance.now() - start),
    rate: rateHeaders(response.headers),
    ...(data ? { summary: summarize(data) } : {}),
  };
  console.log(JSON.stringify(result));
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}; probe stopped`);
  return data;
}

async function credentials() {
  if (process.env.RIOT_AUTH_SOURCE === 'local') return localCredentials();
  if (process.env.RIOT_AUTH_SOURCE && process.env.RIOT_AUTH_SOURCE !== 'remote') {
    throw new Error('RIOT_AUTH_SOURCE must be local or remote');
  }
  const accessToken = process.env.RIOT_ACCESS_TOKEN;
  const entitlement = process.env.RIOT_ENTITLEMENTS_JWT;
  if (accessToken && entitlement) return { accessToken, entitlement };
  if (accessToken || entitlement) throw new Error('Supply both RIOT_ACCESS_TOKEN and RIOT_ENTITLEMENTS_JWT, or neither');

  const cookie = process.env.RIOT_AUTH_COOKIES ||
    (process.env.RIOT_SSID ? `ssid=${process.env.RIOT_SSID}` : '');
  if (!cookie) throw new Error('Missing RIOT_AUTH_COOKIES or RIOT_SSID');
  if (/[\r\n]/.test(cookie)) throw new Error('Auth cookie must contain no newline');

  const auth = await fetch(AUTH_URL, {
    headers: { Cookie: cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const location = auth.headers.get('location');
  if (!location) throw new Error(`Cookie renewal returned HTTP ${auth.status} without redirect`);
  let redirect;
  try {
    redirect = new URL(location, AUTH_URL);
  } catch {
    throw new Error('Cookie renewal returned an invalid redirect');
  }
  if (auth.status < 300 || auth.status >= 400 ||
      redirect.origin !== 'https://playvalorant.com' || redirect.pathname !== '/opt_in') {
    throw new Error('Cookie renewal requires interactive sign-in again');
  }
  const renewedToken = new URLSearchParams(redirect.hash.slice(1)).get('access_token');
  if (!renewedToken) throw new Error('Cookie renewal returned no access token');
  console.log(JSON.stringify({ endpoint: 'cookie-renewal', status: auth.status, success: true }));

  const response = await fetch('https://entitlements.auth.riotgames.com/api/token/v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${renewedToken}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Entitlement request returned HTTP ${response.status}`);
  const data = await response.json();
  if (!data.entitlements_token) throw new Error('Entitlement response has no token');
  console.log(JSON.stringify({ endpoint: 'entitlement', status: response.status, success: true }));
  return { accessToken: renewedToken, entitlement: data.entitlements_token };
}

async function localCredentials() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('Local mode requires a Windows host running Riot Client');
  }
  const lockfile = join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
  let raw;
  try {
    raw = (await readFile(lockfile, 'utf8')).trim();
  } catch {
    throw new Error('Riot Client lockfile not found; sign in to the test account in Riot Client first');
  }
  const parts = raw.split(':');
  if (parts.length !== 5 || !/^\d+$/.test(parts[2]) ||
      Number(parts[2]) < 1 || Number(parts[2]) > 65535 ||
      !parts[3] || parts[4] !== 'https') {
    throw new Error('Riot Client lockfile format is unexpected');
  }
  const port = Number(parts[2]);
  const basic = Buffer.from(`riot:${parts[3]}`).toString('base64');
  const data = await new Promise((resolve, reject) => {
    // Riot Client uses a local certificate. This exception applies only to
    // 127.0.0.1; the remote Riot requests retain normal TLS verification.
    const request = https.get({
      hostname: '127.0.0.1', port, path: '/entitlements/v1/token',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      rejectUnauthorized: false, timeout: 15000,
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          request.destroy();
          reject(new Error('Local entitlement response exceeded size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Local entitlement endpoint returned HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Local entitlement endpoint returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => reject(new Error('Could not read the local Riot Client entitlement endpoint')));
  });
  if (!data.accessToken || !data.token || !UUID.test(data.subject || '')) {
    throw new Error('Local entitlement response is missing required fields');
  }
  console.log(JSON.stringify({ endpoint: 'local-entitlements', status: 200, success: true }));
  return { accessToken: data.accessToken, entitlement: data.token, subject: data.subject };
}

async function main() {
  let { help, shard, puuid, mode } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log('Usage: node scripts/probe-riot-client.mjs <na|eu|ap|kr|pbe> <self|target-puuid> [--auth-only|--content-only|--custom-only|--current-only]');
    console.log('Required environment: RIOT_EXPECTED_RIOT_ID');
    console.log('Local mode: RIOT_AUTH_SOURCE=local with Riot Client signed in on this Windows host');
    console.log('Remote mode: RIOT_AUTH_COOKIES or RIOT_SSID');
    console.log('RIOT_CLIENT_VERSION is also required for content and player-data stages');
    console.log('Token alternative: RIOT_ACCESS_TOKEN and RIOT_ENTITLEMENTS_JWT (identity still required)');
    console.log('Optional environment: RIOT_CLIENT_PLATFORM (base64 client-platform JSON)');
    console.log('Local mode makes one loopback token request; remote mode makes at most two auth requests.');
    console.log('Normal mode makes at most six remote GET requests; custom-only makes at most three; current-only makes two.');
    console.log('Current-only: run during an organizer-approved match; RIOT_REGION defaults to the shard (pbe uses na).');
    console.log('Prints only status, timing, rate headers, and field counts; current-only also prints the live match ID.');
    return;
  }
  const expectedId = process.env.RIOT_EXPECTED_RIOT_ID?.trim() || '';
  const tagSeparator = expectedId.lastIndexOf('#');
  if (tagSeparator <= 0 || tagSeparator === expectedId.length - 1) {
    throw new Error('Set RIOT_EXPECTED_RIOT_ID to the dedicated account name#tag before running');
  }
  if (mode !== '--auth-only' && !process.env.RIOT_CLIENT_VERSION) {
    throw new Error('Missing RIOT_CLIENT_VERSION');
  }
  const { accessToken, entitlement, subject } = await credentials();
  const info = await read('userinfo', 'https://auth.riotgames.com/userinfo',
    { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    data => ({ hasPuuid: UUID.test(data.sub || '') }));
  const actualName = info.acct?.game_name || '';
  const actualTag = info.acct?.tag_line || '';
  if (!UUID.test(info.sub || '') || (subject && subject.toLowerCase() !== info.sub.toLowerCase()) ||
      actualName.toLocaleLowerCase() !== expectedId.slice(0, tagSeparator).toLocaleLowerCase() ||
      actualTag.toLocaleLowerCase() !== expectedId.slice(tagSeparator + 1).toLocaleLowerCase()) {
    throw new Error('Authenticated Riot ID differs from the dedicated test account; probe stopped');
  }
  console.log(JSON.stringify({ endpoint: 'identity-check', verified: true }));
  if (mode === '--auth-only') return;
  if (puuid === 'self') puuid = info.sub;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Riot-Entitlements-JWT': entitlement,
    'X-Riot-ClientVersion': process.env.RIOT_CLIENT_VERSION,
    'X-Riot-ClientPlatform': process.env.RIOT_CLIENT_PLATFORM || DEFAULT_PLATFORM,
    Accept: 'application/json',
  };
  const pd = `https://pd.${shard}.a.pvp.net`;
  const shared = `https://shared.${shard}.a.pvp.net`;
  const player = encodeURIComponent(puuid);

  if (mode === '--current-only') {
    const region = process.env.RIOT_REGION || (shard === 'pbe' ? 'na' : shard);
    if (!new Set(['na', 'eu', 'ap', 'kr', 'latam', 'br']).has(region) ||
        (shard === 'na' && !['na', 'latam', 'br'].includes(region)) ||
        (shard !== 'na' && shard !== 'pbe' && region !== shard) ||
        (shard === 'pbe' && region !== 'na')) {
      throw new Error('RIOT_REGION does not match the selected shard');
    }
    const glz = `https://glz-${region}-1.${shard}.a.pvp.net`;
    await read('current-game-player', `${glz}/core-game/v1/players/${player}`, headers, data => {
      if (data.Subject?.toLowerCase() !== puuid.toLowerCase()) {
        throw new Error('Current-game response subject differs from target; probe stopped');
      }
      return { subjectMatchesTarget: true, matchId: UUID.test(data.MatchID || '') ? data.MatchID : null };
    }, true);
    return;
  }

  if (mode === '--custom-only') {
    const custom = await read('history-custom', `${pd}/match-history/v1/history/${player}?startIndex=0&endIndex=20&queue=custom`, headers, data => ({
      total: data.Total ?? null,
      returned: data.History?.length ?? null,
      queues: [...new Set(data.History?.map(match => match.QueueID) || [])],
    }), true);
    if (!custom) {
      console.log(JSON.stringify({ endpoint: 'history-custom', result: 'HTTP 404; no custom history verified' }));
      return;
    }
    const customMatchId = custom.History?.find(match => UUID.test(match.MatchID))?.MatchID;
    if (!customMatchId) {
      console.log(JSON.stringify({ endpoint: 'custom-match-details', skipped: 'No match ID returned' }));
      return;
    }
    await read('custom-match-details', `${pd}/match-details/v1/matches/${customMatchId}`, headers, data => ({
      provisioningFlow: data.matchInfo?.provisioningFlowID ?? null,
      queue: data.matchInfo?.queueID ?? null,
      completed: data.matchInfo?.isCompleted ?? null,
      hasCustomGameName: !!data.matchInfo?.customGameName,
      players: data.players?.length ?? null,
      rounds: data.roundResults?.length ?? null,
    }));
    return;
  }

  await read('content', `${shared}/content-service/v3/content`, headers, data => ({
    seasons: data.Seasons?.length ?? null,
    acts: data.Seasons?.filter(season => season.Type === 'act').length ?? null,
  }));
  if (mode === '--content-only') return;
  await read('mmr', `${pd}/mmr/v1/players/${player}`, headers, data => ({
    subjectMatchesTarget: data.Subject?.toLowerCase() === puuid.toLowerCase(),
    queues: Object.keys(data.QueueSkills || {}),
    competitiveSeasons: Object.keys(data.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {}).length,
  }));
  const history = await read('history-competitive', `${pd}/match-history/v1/history/${player}?startIndex=0&endIndex=20&queue=competitive`, headers, data => ({
    total: data.Total ?? null,
    returned: data.History?.length ?? null,
  }), true);
  if (!history) {
    const allHistory = await read('history-all-queues', `${pd}/match-history/v1/history/${player}?startIndex=0&endIndex=20`, headers, data => ({
      total: data.Total ?? null,
      returned: data.History?.length ?? null,
      queues: [...new Set(data.History?.map(match => match.QueueID) || [])],
    }), true);
    if (!allHistory) throw new Error('History returned 404 with and without a queue filter; probe stopped');
    console.log(JSON.stringify({ endpoint: 'history-diagnostic', competitiveHistoryUnavailable: true }));
    return;
  }
  if (!history.History?.length) {
    console.log(JSON.stringify({ endpoint: 'competitive-updates', skipped: 'No competitive match in history' }));
    return;
  }
  await read('competitive-updates', `${pd}/mmr/v1/players/${player}/competitiveupdates?startIndex=0&endIndex=20&queue=competitive`, headers, data => ({
    returned: data.Matches?.length ?? null,
    overlapWithHistory: data.Matches?.filter(match => history.History?.some(item => item.MatchID === match.MatchID)).length ?? null,
  }));
  const matchId = history.History?.find(match => UUID.test(match.MatchID))?.MatchID;
  if (!matchId) {
    console.log(JSON.stringify({ endpoint: 'match-details', skipped: 'No valid match ID in history' }));
    return;
  }
  await read('match-details', `${pd}/match-details/v1/matches/${matchId}`, headers, data => ({
    players: data.players?.length ?? null,
    rounds: data.roundResults?.length ?? null,
    kills: data.kills?.length ?? null,
    hasPartyIds: !!data.players?.some(player => player.partyId),
    hasSeasonId: !!data.matchInfo?.seasonId,
  }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
