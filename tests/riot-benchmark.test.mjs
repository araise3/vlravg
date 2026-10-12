import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkPlayer, compareDetails, SAMPLE_SQL } from '../lib/riot-benchmark.mjs';
import { readFile } from 'node:fs/promises';
const routeSource=await readFile(new URL('../functions/riot-probe/benchmark.js',import.meta.url),'utf8');
const {onRequest}=await import('data:text/javascript;base64,'+Buffer.from(routeSource.replace(
  "'../../lib/riot-benchmark.mjs'",JSON.stringify(new URL('../lib/riot-benchmark.mjs',import.meta.url).href))).toString('base64'));
const id='11111111-1111-4111-8111-111111111111';
test('sampling is bounded, PC-only and spreads regions',()=>{
  assert.match(SAMPLE_SQL,/LIMIT 24/); assert.match(SAMPLE_SQL,/PARTITION BY region/); assert.match(SAMPLE_SQL,/platform='pc'/);
});
test('benchmark requires authorization before reading cached identities',async()=>{
  const request=new Request('https://example.test/riot-probe/benchmark?index=0',{method:'POST'});
  const APP_DB={prepare(){throw Error('Must not read cache');}};
  assert.equal((await onRequest({request,env:{APP_DB}})).status,404);
  assert.equal((await onRequest({request,env:{APP_DB,RIOT_PROBE_ENABLED:'true',RIOT_PROBE_KEY:'x'.repeat(32)}})).status,401);
});
test('self damage exclusion is checked separately from enemy-only filtering',()=>{
  const p={subject:id,teamId:'Blue',stats:{kills:1},roundDamage:[{receiver:id,damage:999},{receiver:'enemy',damage:100},{receiver:'ally',damage:26}]};
  const result=compareDetails({players:[p,{subject:'enemy',teamId:'Red'},{subject:'ally',teamId:'Blue'}]},
    {players:[{puuid:id,stats:{kills:1,damage:{dealt:126}}}]});
  assert.equal(result.damageMismatches,1);assert.equal(result.noSelfDamageMismatches,0);
  assert.deepEqual(result.damageMismatchSamples[0],{rawTotal:1125,noSelfTotal:126,enemyTotal:100,henrikTotal:126});
});
test('paired detail stats are joined by identity rather than roster order',()=>{
  const stats={kills:1,deaths:2,assists:3,score:100};
  const result=compareDetails({players:[{subject:id,stats}],roundResults:[{playerStats:[{}]}]},
    {players:[{puuid:id,stats:{...stats,score:99}}],rounds:[{player_stats:[{}]}]});
  assert.equal(result.statPlayersCompared,1);assert.equal(result.statMismatches.score,1);assert.equal(result.statMismatches.kills,0);
});
test('a Riot 429 halts all later provider calls and leaks no raw headers or secrets',async()=>{
  let calls=0;
  const result=await benchmarkPlayer({RIOT_EXPECTED_RIOT_ID:'Test#EU',RIOT_SSID:'private-cookie',RIOT_CLIENT_VERSION:'v'},
    {puuid:id,region:'eu'},0,async()=>{calls++;return new Response(null,{status:429,headers:{'x-ratelimit-remaining':'secret-quota'}});},async()=>{});
  assert.equal(calls,1);assert.equal(result.rateLimited,true);
  assert.doesNotMatch(JSON.stringify(result),/private-cookie|secret-quota|11111111/);
});
