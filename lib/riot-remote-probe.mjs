const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_URL = 'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid';
const PLATFORM = btoa(JSON.stringify({ platformType: 'PC', platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' }));
class ProbeError extends Error {}

export async function runRemoteProbe(env, mode, fetcher = fetch, collect = () => {}) {
  const steps = [];
  const stop = message => { throw new ProbeError(message); };
  // Raw errors, response bodies, cookies and redirects never reach the caller.
  async function call(endpoint, url, options = {}, allow404 = false) {
    const start = Date.now();
    let response;
    try {
      response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } catch { stop(`${endpoint}: network request failed`); }
    const step = { endpoint, status: response.status, elapsedMs: Date.now() - start };
    steps.push(step);
    if (allow404 && response.status === 404) return { data: null, step };
    if (!response.ok) stop(`${endpoint}: upstream request rejected`);
    let data;
    try { data = await response.json(); } catch { stop(`${endpoint}: invalid JSON`); }
    collect(endpoint, data);
    return { data, step };
  }
  try {
    if (!['auth', 'content', 'player', 'custom'].includes(mode)) stop('Invalid mode');
    const expected = env.RIOT_EXPECTED_RIOT_ID?.trim() || '';
    const separator = expected.lastIndexOf('#');
    if (separator <= 0 || separator === expected.length - 1) stop('Missing dedicated account identity');
    const cookie = env.RIOT_AUTH_COOKIES || (env.RIOT_SSID ? `ssid=${env.RIOT_SSID}` : '');
    if (!cookie || /[\r\n]/.test(cookie)) stop('Missing or invalid auth cookie');
    if (!env.RIOT_AUTH_COOKIES && (/^\s|\s$/.test(env.RIOT_SSID) || /^ssid=/i.test(env.RIOT_SSID) || /[;"']/.test(env.RIOT_SSID))) {
      stop('RIOT_SSID must contain only the cookie value, without ssid=, quotes, spaces, or other cookies');
    }
    const shard = env.RIOT_SHARD || 'eu';
    if (!['na', 'eu', 'ap', 'kr', 'pbe'].includes(shard)) stop('Invalid shard');
    const target = env.RIOT_TARGET_PUUID || 'self';
    if (target !== 'self' && !UUID.test(target)) stop('Invalid target PUUID');
    if (mode !== 'auth' && !env.RIOT_CLIENT_VERSION) stop('Missing client version');

    let auth;
    try {
      auth = await fetcher(AUTH_URL, { headers: { Cookie: cookie }, redirect: 'manual',
        signal: AbortSignal.timeout(15000) });
    } catch { stop('cookie-renewal: network request failed'); }
    const authStep = { endpoint: 'cookie-renewal', status: auth.status };
    steps.push(authStep);
    let destination;
    const location = auth.headers.get('location');
    if (!location) { authStep.redirectKind = 'missing'; stop('Cookie renewal returned no redirect'); }
    try { destination = new URL(location, AUTH_URL); }
    catch { authStep.redirectKind = 'invalid'; stop('Cookie renewal returned an invalid redirect'); }
    // Only fixed classifications are exposed; URLs can contain credentials.
    const callback = destination.origin === 'https://playvalorant.com' && destination.pathname === '/opt_in';
    const login = destination.origin === 'https://authenticate.riotgames.com' && destination.pathname === '/login';
    authStep.redirectKind = callback ? 'token-callback' : login ? 'interactive-login' : 'unexpected';
    if (auth.status < 300 || auth.status >= 400) stop('Cookie renewal returned a non-redirect response');
    if (login) stop('Riot did not accept this session for cookie renewal; interactive sign-in is required');
    if (!callback) stop('Cookie renewal returned an unexpected redirect; probe stopped');
    const accessToken = new URLSearchParams(destination.hash.slice(1)).get('access_token');
    if (!accessToken) stop('Cookie renewal returned no access token');
    const authorization = { Authorization: `Bearer ${accessToken}` };
    const { data: identity } = await call('userinfo', 'https://auth.riotgames.com/userinfo', { headers: authorization });
    if (!UUID.test(identity.sub || '') ||
        identity.acct?.game_name?.toLowerCase() !== expected.slice(0, separator).toLowerCase() ||
        identity.acct?.tag_line?.toLowerCase() !== expected.slice(separator + 1).toLowerCase()) {
      stop('Authenticated account differs from dedicated test account');
    }
    steps.push({ endpoint: 'identity-check', verified: true });
    const { data: entitlement } = await call('entitlement', 'https://entitlements.auth.riotgames.com/api/token/v1', {
      method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!entitlement.entitlements_token) stop('Entitlement response missing token');
    if (mode === 'auth') return { ok: true, mode, steps };
    const headers = { ...authorization, 'X-Riot-Entitlements-JWT': entitlement.entitlements_token,
      'X-Riot-ClientVersion': env.RIOT_CLIENT_VERSION, 'X-Riot-ClientPlatform': PLATFORM, Accept: 'application/json' };
    const pd = `https://pd.${shard}.a.pvp.net`;
    const puuid = target === 'self' ? identity.sub : target;
    if (mode !== 'custom') {
      const { data, step } = await call('content', `https://shared.${shard}.a.pvp.net/content-service/v3/content`, { headers });
      step.summary = { seasons: data.Seasons?.length ?? 0, acts: data.Seasons?.filter(s => s.Type === 'act').length ?? 0 };
      if (mode === 'content') return { ok: true, mode, steps };
      const mmr = await call('mmr', `${pd}/mmr/v1/players/${puuid}`, { headers });
      if (mmr.data.Subject?.toLowerCase() !== puuid.toLowerCase()) stop('MMR response target mismatch');
      mmr.step.summary = { competitiveSeasons: Object.keys(mmr.data.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {}).length };
    }
    const queue = mode === 'custom' ? 'custom' : 'competitive';
    const history = await call(`history-${queue}`, `${pd}/match-history/v1/history/${puuid}?startIndex=0&endIndex=20&queue=${queue}`, { headers }, true);
    if (!history.data) return { ok: true, mode, steps, note: 'History returned 404; data availability is unverified' };
    history.step.summary = { total: history.data.Total ?? null, returned: history.data.History?.length ?? 0 };
    const entries = history.data.History || [];
    if (mode === 'player' && entries.length) {
      const updates = await call('competitive-updates', `${pd}/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=20&queue=competitive`, { headers });
      updates.step.summary = { returned: updates.data.Matches?.length ?? 0,
        overlapWithHistory: updates.data.Matches?.filter(m => entries.some(h => h.MatchID === m.MatchID)).length ?? 0 };
    }
    const matchId = entries.find(m => UUID.test(m.MatchID || ''))?.MatchID;
    if (matchId) {
      const detail = await call('match-details', `${pd}/match-details/v1/matches/${matchId}`, { headers });
      detail.step.summary = { players: detail.data.players?.length ?? 0, rounds: detail.data.roundResults?.length ?? 0,
        kills: detail.data.kills?.length ?? 0, hasPartyIds: !!detail.data.players?.some(p => p.partyId),
        hasSeasonId: !!detail.data.matchInfo?.seasonId, isCustom: detail.data.matchInfo?.provisioningFlowID === 'CustomGame' };
    }
    return { ok: true, mode, steps };
  } catch (error) {
    return { ok: false, mode, steps, error: error instanceof ProbeError ? error.message : 'Unexpected upstream response; probe stopped' };
  }
}
