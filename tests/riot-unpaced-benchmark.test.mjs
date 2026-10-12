import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkUnpaced } from '../lib/riot-unpaced-benchmark.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const env = { RIOT_EXPECTED_RIOT_ID: 'Test#EU', RIOT_SSID: 'secret-cookie', RIOT_CLIENT_VERSION: 'v' };
const players = Array.from({length:3}, () => ({ puuid:id, region:'eu' }));
function fake(rejectDetails = false) {
  let active = 0, peak = 0, auth = 0, details = 0;
  return { counts: () => ({peak, auth, details}), fetcher: async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (url.includes('/authorize?')) { auth++; return new Response(null, {status:302, headers:{location:'https://playvalorant.com/opt_in#access_token=secret-token'}}); }
    if (url.endsWith('/userinfo')) return Response.json({sub:id, acct:{game_name:'Test', tag_line:'EU'}});
    if (url.includes('entitlements.auth')) return Response.json({entitlements_token:'secret-entitlement'});
    if (url.includes('match-history')) return Response.json({History:Array.from({length:20}, () => ({MatchID:id}))});
    if (url.includes('match-details')) { details++; return rejectDetails ? new Response(null,{status:429}) : Response.json({players:[]}); }
    return Response.json({});
  }};
}
test('unpaced data shares one login, stays within concurrency and caps details', async () => {
  const f = fake(), result = await benchmarkUnpaced(env, players, 4, f.fetcher);
  assert.equal(result.ok,true); assert.equal(result.pacingMs,0);
  assert.equal(f.counts().auth,1); assert.equal(f.counts().details,30);
  assert.equal(result.metrics.length,43); assert.equal(result.dataSuccesses,39);
  assert.equal(result.peakConcurrency,4); assert.ok(f.counts().peak <= 4);
  assert.deepEqual(result.pages.map(p=>p.returned),[10,10,10]);
  assert.doesNotMatch(JSON.stringify(result),/secret-cookie|secret-token|secret-entitlement|11111111/);
});
test('first 429 stops scheduling; only already in-flight requests can finish', async () => {
  const f = fake(true), result = await benchmarkUnpaced(env, players, 4, f.fetcher);
  assert.equal(result.rateLimited,true); assert.equal(result.ok,false);
  assert.ok(f.counts().details <= 4); assert.equal(result.pages.reduce((n,p)=>n+p.returned,0),0);
});
test('sequential workload has no overlapping calls and rejects invalid bounds', async () => {
  const f = fake(), result = await benchmarkUnpaced(env,players.slice(0,1),1,f.fetcher);
  assert.equal(result.peakConcurrency,1); assert.equal(result.ok,true);
  await assert.rejects(()=>benchmarkUnpaced(env,players,8,f.fetcher),/Invalid/);
  await assert.rejects(()=>benchmarkUnpaced(env,[...players,...players],1,f.fetcher),/Invalid/);
});
