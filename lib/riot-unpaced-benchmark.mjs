import { runRemoteProbe } from './riot-remote-probe.mjs';
import { rateDiagnostics } from './riot-rate-diagnostics.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A finite workload, with no sleep/retry and one session shared by the batch.
// Three players * (rank + history + RR + ten details) + four setup calls <= 43.
export async function benchmarkUnpaced(env, players, concurrency, fetcher = fetch) {
  if (![1, 2, 4].includes(concurrency) || !players.length || players.length > 3 ||
      players.some(p => !UUID.test(p.puuid) || !['eu','na','ap','kr'].includes(p.region))) {
    throw new Error('Invalid bounded workload');
  }
  const metrics = [], pages = [], histories = new Map();
  let headers, stopped = false, active = 0, peakConcurrency = 0;
  const started = performance.now();
  async function measured(url, options = {}) {
    if (stopped) throw new Error('Stopped');
    const path = new URL(url).pathname;
    const endpoint = path.includes('match-history') ? 'history' : path.includes('competitiveupdates') ? 'rr'
      : path.includes('match-details') ? 'detail' : path.includes('/mmr/') ? 'rank'
      : path.includes('content-service') ? 'content' : 'auth';
    if (options.headers?.['X-Riot-Entitlements-JWT']) headers = { ...options.headers };
    const startMs = performance.now() - started;
    active++; peakConcurrency = Math.max(peakConcurrency, active);
    try {
      const response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      metrics.push({ endpoint, status: response.status, startMs: Math.round(startMs),
        elapsedMs: Math.round(performance.now() - started - startMs), bytes: bytes.length,
        rate: rateDiagnostics(response.headers) });
      if (!response.ok && !(endpoint === 'auth' && response.status >= 300 && response.status < 400)) stopped = true;
      return new Response(bytes.length ? bytes : null, { status: response.status, headers: response.headers });
    } catch {
      stopped = true;
      metrics.push({ endpoint, status: 0, startMs: Math.round(startMs),
        elapsedMs: Math.round(performance.now() - started - startMs), bytes: 0 });
      throw new Error('Network request failed');
    } finally { active--; }
  }
  async function pool(tasks) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (!stopped && next < tasks.length) {
        const task = tasks[next++];
        try { await task(); } catch { stopped = true; }
      }
    }));
  }
  const setup = await runRemoteProbe({ ...env, RIOT_TARGET_PUUID: 'self' }, 'content', measured);
  const dataStart = performance.now();
  if (setup.ok && headers && !stopped) {
    const tasks = [];
    for (let index = 0; index < players.length; index++) {
      const p = players[index], pd = `https://pd.${p.region}.a.pvp.net`;
      const page = { index, region: p.region, requested: 0, returned: 0, detailBytes: 0, detailTransferMs: 0 };
      pages.push(page);
      for (const [label, path] of [
        ['rank', `/mmr/v1/players/${p.puuid}`],
        ['history', `/match-history/v1/history/${p.puuid}?startIndex=0&endIndex=20&queue=competitive`],
        ['rr', `/mmr/v1/players/${p.puuid}/competitiveupdates?startIndex=0&endIndex=20&queue=competitive`],
      ]) tasks.push(async () => {
        const r = await measured(pd + path, { headers });
        if (!r.ok) return;
        const data = await r.json();
        if (label === 'history') histories.set(index, (data.History || []).filter(m => UUID.test(m.MatchID || '')).slice(0, 10));
      });
    }
    await pool(tasks);
    const detailTasks = [];
    for (const page of pages) {
      const p = players[page.index], matches = histories.get(page.index) || [];
      page.requested = matches.length;
      for (const match of matches) detailTasks.push(async () => {
        const begin = performance.now();
        page.firstStart ??= begin;
        const r = await measured(`https://pd.${p.region}.a.pvp.net/match-details/v1/matches/${match.MatchID}`, { headers });
        page.lastEnd = performance.now();
        if (!r.ok) return;
        const bytes = new Uint8Array(await r.arrayBuffer());
        page.returned++; page.detailBytes += bytes.length;
        page.detailTransferMs += Math.round(performance.now() - begin);
      });
    }
    await pool(detailTasks);
  }
  for (const page of pages) {
    page.detailWallMs = page.firstStart == null ? null : Math.round(page.lastEnd - page.firstStart);
    delete page.firstStart; delete page.lastEnd;
  }
  const dataWallMs = Math.round(performance.now() - dataStart);
  const dataRequests = metrics.filter(m => !['auth','content'].includes(m.endpoint));
  return { ok: setup.ok && !stopped, setupOk: setup.ok, setupError: setup.ok ? undefined : setup.error,
    concurrency, peakConcurrency, pacingMs: 0, elapsedMs: Math.round(performance.now() - started),
    dataWallMs, dataRequests: dataRequests.length, dataSuccesses: dataRequests.filter(m => m.status === 200).length,
    dataRequestsPerSecond: dataWallMs ? +(dataRequests.filter(m => m.status === 200).length * 1000 / dataWallMs).toFixed(2) : 0,
    stopped, rateLimited: metrics.some(m => m.status === 429), metrics, pages };
}
