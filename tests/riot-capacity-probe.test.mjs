import test from 'node:test';
import assert from 'node:assert/strict';
import {rateDiagnostics} from '../lib/riot-rate-diagnostics.mjs';
import {startCapacitySession,runCapacityFrame,FALLBACK_COOLDOWN_MS} from '../lib/riot-capacity-probe.mjs';
import {readFile} from 'node:fs/promises';
const routeSource=await readFile(new URL('../functions/riot-probe/capacity.js',import.meta.url),'utf8');
const {onRequest}=await import('data:text/javascript;base64,'+Buffer.from(routeSource.replace(
  "'../../lib/riot-capacity-probe.mjs'",JSON.stringify(new URL('../lib/riot-capacity-probe.mjs',import.meta.url).href))).toString('base64'));
const id='11111111-1111-4111-8111-111111111111';
const env={RIOT_EXPECTED_RIOT_ID:'Test#EU',RIOT_SSID:'cookie-secret',RIOT_CLIENT_VERSION:'v'};
test('capacity route rejects disabled/unauthorized callers before cache or upstream work',async()=>{
  const request=new Request('https://example.test/riot-probe/capacity?op=start',{method:'POST'});
  assert.equal((await onRequest({request,env:{}})).status,404);
  assert.equal((await onRequest({request,env:{RIOT_PROBE_ENABLED:'true',RIOT_PROBE_KEY:'x'.repeat(32)}})).status,401);
});
test('all Riot rate headers are captured while opaque fields and credentials are excluded',()=>{
  const headers=new Headers({'X-App-Rate-Limit':'500:10,30000:600','X-App-Rate-Limit-Count':'1:10,2:600',
    'X-Method-Rate-Limit':'100:60','X-Method-Rate-Limit-Count':'3:60','X-Rate-Limit-Type':'method',
    'RateLimit':'"opaque-secret";r=3;t=20;pk="private-partition"','Retry-After':'125',
    'Set-Cookie':'ssid=cookie-secret','Location':'https://secret.test/token','Server':'cloudflare'});
  const result=rateDiagnostics(headers);
  assert.equal(result.values['x-app-rate-limit'],'500:10,30000:600');
  assert.equal(result.values['x-method-rate-limit-count'],'3:60');
  assert.equal(result.retryAfterMs,125000);
  assert.deepEqual(result.values.ratelimit,[{parameter:'r',value:3},{parameter:'t',value:20}]);
  assert.doesNotMatch(JSON.stringify(result),/opaque-secret|private-partition|cookie-secret|secret.test/);
});
test('HTTP-date Retry-After works and arbitrary values are not returned',()=>{
  assert.equal(rateDiagnostics(new Headers({'Retry-After':'Wed, 30 Sep 2026 00:01:00 GMT'}),Date.parse('2026-09-30T00:00:00Z')).retryAfterMs,60000);
  const result=rateDiagnostics(new Headers({'X-App-Rate-Limit':'Bearer secret','X-Rate-Limit-Type':'secret','Retry-After':'secret'}));
  assert.deepEqual(result.values,{});assert.equal(result.retryAfterMs,null);
});
async function setup() {
  let auth=0;
  const fetcher=async url=>{
    if(url.includes('/authorize?')){auth++;return new Response(null,{status:302,headers:{location:'https://playvalorant.com/opt_in#access_token=token-secret'}});}
    if(url.endsWith('/userinfo'))return Response.json({sub:id,acct:{game_name:'Test',tag_line:'EU'}});
    if(url.includes('entitlements.auth'))return Response.json({entitlements_token:'entitlement-secret'});
    if(url.includes('match-history'))return Response.json({History:[{MatchID:id},{MatchID:id}]});
    return Response.json({});
  };
  return {result:await startCapacitySession(env,{puuid:id,region:'eu'},fetcher),auth:()=>auth};
}
test('session is reused across frames without auth calls or raw data in reports',async()=>{
  const s=await setup();assert.equal(s.result.ok,true);assert.equal(s.result.state.matchIds.length,1);
  let calls=0;
  const f=async(url,options)=>{calls++;assert.ok(url.startsWith('https://pd.eu.a.pvp.net/match-details/'));
    assert.equal(options.headers.Authorization,'Bearer token-secret');return Response.json({private:id});};
  const a=await runCapacityFrame(s.result.state,'burst1',f),b=await runCapacityFrame(s.result.state,'burst1',f);
  assert.equal(calls,80);assert.equal(s.auth(),1);assert.equal(b.phaseAttempted,80);
  assert.doesNotMatch(JSON.stringify([a,b,s.result.setupMetrics]),/token-secret|cookie-secret|entitlement-secret|11111111/);
});
test('429 halts immediately, honors longer cooldown and prevents calls during it',async()=>{
  const s=await setup();let calls=0;
  const report=await runCapacityFrame(s.result.state,'burst1',async()=>{calls++;return new Response('Too Many Requests',{status:429,headers:{'Retry-After':'180','X-Rate-Limit-Type':'service'}});});
  assert.equal(calls,1);assert.equal(report.rateLimited,true);
  assert.ok(s.result.state.cooldownUntil-Date.now()>179000);
  await runCapacityFrame(s.result.state,'burst2',async()=>{calls++;});assert.equal(calls,1);
  assert.ok(FALLBACK_COOLDOWN_MS>=120000);
});
test('non-rate failures stop without being treated as a rate limit',async()=>{
  const s=await setup();let calls=0;
  const report=await runCapacityFrame(s.result.state,'steady',async()=>{calls++;return new Response(null,{status:403});});
  assert.equal(calls,1);assert.equal(report.ok,false);assert.equal(report.rateLimited,false);
});
