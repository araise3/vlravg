import { runRemoteProbe } from './riot-remote-probe.mjs';
import { rateDiagnostics } from './riot-rate-diagnostics.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FALLBACK_COOLDOWN_MS = 120000;

export async function capacityRequest(url, headers, label, fetcher = fetch) {
  const at = Date.now(), start = performance.now();
  try {
    const response = await fetcher(url, {headers, redirect:'manual', signal:AbortSignal.timeout(15000)});
    const rate = rateDiagnostics(response.headers);
    // Stream full match bodies to a counter; never retain raw player records.
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) { const {done,value} = await reader.read(); if (done) break; bytes += value.byteLength; }
    }
    return { label, at, elapsedMs:Math.round(performance.now()-start), status:response.status, bytes, rate };
  } catch { return { label, at, elapsedMs:Math.round(performance.now()-start), status:0, bytes:0, error:'Network request failed' }; }
}

export async function startCapacitySession(env, player, fetcher = fetch) {
  if (player.region !== 'eu' || !UUID.test(player.puuid)) throw Error('Invalid EU sample');
  const setupMetrics = [];
  let headers;
  const measured = async (url, options = {}) => {
    const at = Date.now(), start = performance.now();
    const r = await fetcher(url, { ...options, redirect:'manual', signal:AbortSignal.timeout(15000) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    const label = url.includes('/authorize?') ? 'cookie-renewal' : url.includes('/userinfo') ? 'userinfo'
      : url.includes('entitlements.auth') ? 'entitlement' : 'content';
    setupMetrics.push({label,at,elapsedMs:Math.round(performance.now()-start),status:r.status,bytes:bytes.length,rate:rateDiagnostics(r.headers)});
    if (options.headers?.['X-Riot-Entitlements-JWT']) headers = {...options.headers};
    return new Response(bytes.length ? bytes : null, { status:r.status, headers:r.headers });
  };
  const setup = await runRemoteProbe({...env,RIOT_SHARD:'eu',RIOT_TARGET_PUUID:'self'},'content',measured);
  if (!setup.ok || !headers) return {ok:false,error:setup.error,setupMetrics};
  try {
    const at = Date.now(), start = performance.now();
    const r = await fetcher(`https://pd.eu.a.pvp.net/match-history/v1/history/${player.puuid}?startIndex=0&endIndex=20&queue=competitive`,
      {headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
    const bytes = new Uint8Array(await r.arrayBuffer());
    setupMetrics.push({label:'history-discovery',at,status:r.status,elapsedMs:Math.round(performance.now()-start),bytes:bytes.length,rate:rateDiagnostics(r.headers)});
    if (!r.ok) return {ok:false,error:'History discovery rejected',setupMetrics};
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const matchIds = [...new Set((data.History || []).map(m=>m.MatchID).filter(id=>UUID.test(id || '')))].slice(0,20);
    if (!matchIds.length) return {ok:false,error:'No accessible match IDs',setupMetrics};
    return {ok:true,setupMetrics,state:{headers,matchIds,createdAt:Date.now(),expiresAt:Date.now()+15*60000,
      attempted:0,successes:0,nextDispatchAt:0,cooldownUntil:0,phases:{}}};
  } catch { return {ok:false,error:'History discovery failed',setupMetrics}; }
}

export async function runCapacityFrame(state, phase, fetcher = fetch, pause = ms=>new Promise(r=>setTimeout(r,ms))) {
  if (!['burst1','burst2','steady'].includes(phase)) throw Error('Invalid phase');
  const spacingMs = phase === 'steady' ? 1000 : 0;
  const now = Date.now();
  if (now >= state.expiresAt) return {ok:false,error:'Session expired',metrics:[]};
  if (now < state.cooldownUntil) return {ok:false,error:'Cooldown active',retryAfterMs:state.cooldownUntil-now,metrics:[]};
  const progress = state.phases[phase] ||= {attempted:0,successes:0,stopped:false};
  if (progress.stopped || progress.attempted >= 200 || state.attempted >= 600) return {ok:true,done:true,metrics:[]};
  const metrics = [], start = Date.now();
  for (let i=0;i<40 && progress.attempted<200 && state.attempted<600;i++) {
    if (Date.now() >= state.expiresAt) break;
    if (spacingMs && state.nextDispatchAt>Date.now()) await pause(state.nextDispatchAt-Date.now());
    const id = state.matchIds[state.attempted % state.matchIds.length];
    state.nextDispatchAt = Date.now()+spacingMs;
    const metric = await capacityRequest(`https://pd.eu.a.pvp.net/match-details/v1/matches/${id}`,state.headers,'match-details',fetcher);
    metric.sequence = ++state.attempted; metric.phaseSequence = ++progress.attempted;
    metrics.push(metric);
    if (metric.status !== 200) {
      progress.stopped = true;
      if (metric.status === 429) state.cooldownUntil = Date.now()+Math.max(FALLBACK_COOLDOWN_MS,metric.rate?.retryAfterMs || 0);
      break;
    }
    progress.successes++; state.successes++;
  }
  return {ok:!progress.stopped,done:progress.stopped || progress.attempted>=200,phase,spacingMs,
    elapsedMs:Date.now()-start,phaseAttempted:progress.attempted,phaseSuccesses:progress.successes,
    sessionAttempted:state.attempted,sessionSuccesses:state.successes,
    cooldownUntil:state.cooldownUntil,rateLimited:metrics.some(m=>m.status===429),metrics};
}
