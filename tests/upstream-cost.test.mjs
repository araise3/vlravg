import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {costKey,maxUnits,recordCostSample,MATCH_LIST_MAX_SIZE} from '../lib/upstream-cost.mjs';
import {acquirePublicPermit,observePublicQuota,measuredSample,SAME_WINDOW_MS} from '../lib/upstream-pacing.mjs';
import {recordPublicQuotaEvent} from '../lib/public-quota-audit.mjs';

function database(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async all(){return {results:sql.prepare(query).all(...values)};},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  return {db,sql};
}
const u=q=>new URL('https://site.test/x'+q);
const samples=sql=>sql.prepare('SELECT pool,route,cache_status,status,cost FROM quota_cost_samples ORDER BY id').all().map(r=>({...r}));

test('maximum cost per call follows HenrikDev\'s rule: 1 per request plus 1 per Riot fetch it can make',()=>{
  assert.equal(maxUnits({trackAccount:true},[],u(''),'/account/Alpha/EU'),2);
  assert.equal(maxUnits({accountByPuuid:true},[],u('?force=true'),'/account-by-puuid/x'),2);
  assert.equal(maxUnits({},[],u(''),'/rank/eu/pc/Alpha/EU'),2);
  assert.equal(maxUnits({persistRRHistory:true},[],u(''),'/mmr-history-by-puuid/eu/pc/x'),2);
  assert.equal(maxUnits({matchDetail:true},[],u(''),'/match-detail/eu/x'),2);
  for(const route of [{storedMatches:true},{storedMmr:true},{rrHeal:true}])assert.equal(maxUnits(route,[],u('?page=1&size=100'),'/stored'),1,'answered from HenrikDev\'s store');
  assert.equal(maxUnits({},[],u('?mode=competitive&size=10&start=0'),'/history/eu/pc/Alpha/EU'),11);
  assert.equal(maxUnits({},[],u('?size=1&start=30'),'/history/eu/pc/Alpha/EU'),2,'a one-match seek');
  assert.equal(maxUnits({},[],u(''),'/history/eu/pc/Alpha/EU'),1+MATCH_LIST_MAX_SIZE,'no size: a full page');
  assert.equal(maxUnits({},[],u('?size=500'),'/history/eu/pc/Alpha/EU'),1+MATCH_LIST_MAX_SIZE,'pages are capped');
  assert.equal(maxUnits({historyByPuuid:true},[],u('?size=10'),'/history-by-puuid/eu/pc/x'),11);
  const backfill=phase=>maxUnits({nameBackfill:true},Object.assign([],{state:{phase}}),u(''),'/name-backfill/x');
  assert.deepEqual([backfill('live'),backfill('stored'),backfill('stored-detail')],[11,1,2]);
});

test('samples are keyed by route, with page size for match lists and phase for name backfill',()=>{
  assert.equal(costKey({trackAccount:true},[],u(''),'/account/Alpha/EU'),'account');
  assert.equal(costKey({},[],u(''),'/rank/eu/pc/Alpha/EU'),'rank');
  assert.equal(costKey({},[],u('?mode=competitive&size=10&start=0'),'/history/eu/pc/Alpha/EU'),'history:10');
  assert.equal(costKey({},[],u(''),'/history/eu/pc/Alpha/EU'),'history:default');
  assert.equal(costKey({historyByPuuid:true},[],u('?size=10'),'/history-by-puuid/eu/pc/x'),'history-by-puuid:10');
  assert.equal(costKey({nameBackfill:true},Object.assign([],{state:{phase:'stored'}}),u(''),'/name-backfill/x'),'name-backfill:stored');
});

test('a call that had the key to itself in one window is measured; anything else is not',()=>{
  const base={clean:true,remaining:50,resetAt:160000};
  assert.equal(measuredSample(base,{remaining:48,resetAt:160400}),2);
  assert.equal(measuredSample(base,{remaining:50,resetAt:160000}),0,'a free answer');
  assert.equal(measuredSample({...base,clean:false},{remaining:48,resetAt:160000}),null,'another call ran in between');
  assert.equal(measuredSample(base,{remaining:58,resetAt:160000+SAME_WINDOW_MS+1}),null,'a new window');
  assert.equal(measuredSample(base,{remaining:52,resetAt:160000}),null,'the count cannot rise in a window');
  assert.equal(measuredSample({...base,remaining:null},{remaining:48,resetAt:160000}),null);
});

test('the gate records serial calls as samples and skips overlapping ones',async t=>{
  const {db,sql}=database(t);let clock=100000;
  const call=async(remaining,{key='rank',cache='HIT'}={})=>{
    const permit=await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:600000,sleepImpl:async ms=>{clock+=ms;}});
    return {permit,answer:()=>observePublicQuota(db,{remaining,resetAt:160000},
      {startedAt:permit.startedAt,now:()=>clock,status:200,baseline:permit.baseline,costKey:key,cacheStatus:cache})};
  };
  await (await call(50)).answer();
  assert.deepEqual(samples(sql),[],'the first call has no header before it');
  await (await call(48,{cache:'NONE'})).answer();
  await (await call(47,{key:'account',cache:'HIT'})).answer();
  assert.deepEqual(samples(sql),[{pool:'public',route:'rank',cache_status:'NONE',status:200,cost:2},
    {pool:'public',route:'account',cache_status:'HIT',status:200,cost:1}]);
  const first=await call(44),second=await call(43);
  await first.answer();await second.answer();
  assert.equal(samples(sql).length,2,'overlapping calls are not measured');
  await (await call(41)).answer();
  assert.deepEqual(samples(sql).at(-1),{pool:'public',route:'rank',cache_status:'HIT',status:200,cost:2});
});

test('samples older than the keep window are pruned',async t=>{
  const {db,sql}=database(t);const day=86400000,now=1_000_000_000_000;
  await recordCostSample(db,{pool:'public',route:'rank',cost:9,now:now-20*day});
  await recordCostSample(db,{pool:'public',route:'rank',cost:2,now});
  assert.deepEqual(samples(sql).map(r=>r.cost),[2]);
});

test('audit tables created before the cost column gain it on the next write',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE public_quota_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,observed_at TEXT NOT NULL,event TEXT NOT NULL,
    route TEXT NOT NULL,profile INTEGER NOT NULL DEFAULT 0,gate_remaining INTEGER,header_remaining INTEGER,reset_in_ms INTEGER,
    retry_after_ms INTEGER,served_saved INTEGER)`);
  const db={prepare(query){let values=[];const s={bind(...v){values=v;return s;},async run(){return sql.prepare(query).run(...values);}};return s;}};
  await recordPublicQuotaEvent(db,{event:'low-window',route:'rank',gateRemaining:9,headerRemaining:4,cost:2});
  assert.deepEqual({...sql.prepare('SELECT event,route,gate_remaining,header_remaining,cost FROM public_quota_audit').get()},
    {event:'low-window',route:'rank',gate_remaining:9,header_remaining:4,cost:2});
});
