import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {upstreamCost,MATCH_LIST_MAX_SIZE} from '../lib/upstream-cost.mjs';
import {recordPublicQuotaEvent} from '../lib/public-quota-audit.mjs';

const u=q=>new URL('https://site.test/x'+q);

test('upstream calls are estimated in HenrikDev units: 1 per request plus 1 per Riot fetch',()=>{
  assert.equal(upstreamCost({trackAccount:true},[],u(''),'/account/Alpha/EU'),2);
  assert.equal(upstreamCost({accountByPuuid:true},[],u('?force=true'),'/account-by-puuid/x'),2);
  assert.equal(upstreamCost({},[],u(''),'/rank/eu/pc/Alpha/EU'),2);
  assert.equal(upstreamCost({persistRRHistory:true},[],u(''),'/mmr-history-by-puuid/eu/pc/x'),2);
  assert.equal(upstreamCost({matchDetail:true},[],u(''),'/match-detail/eu/x'),2);
  for(const route of [{storedMatches:true},{storedMmr:true},{rrHeal:true}])assert.equal(upstreamCost(route,[],u('?page=1&size=100'),'/stored'),1,'HenrikDev answers from its store');
  assert.equal(upstreamCost({},[],u('?mode=competitive&size=10&start=0'),'/history/eu/pc/Alpha/EU'),11);
  assert.equal(upstreamCost({},[],u('?mode=competitive&size=1&start=30'),'/history/eu/pc/Alpha/EU'),2,'a one-match seek');
  assert.equal(upstreamCost({},[],u(''),'/history/eu/pc/Alpha/EU'),1+MATCH_LIST_MAX_SIZE,'no size: assume a full page');
  assert.equal(upstreamCost({},[],u('?size=500'),'/history/eu/pc/Alpha/EU'),1+MATCH_LIST_MAX_SIZE,'pages are capped');
  assert.equal(upstreamCost({historyByPuuid:true},[],u('?mode=competitive&size=10&start=0'),'/history-by-puuid/eu/pc/x'),11);
  const backfill=phase=>upstreamCost({nameBackfill:true},Object.assign([],{state:{phase}}),u(''),'/name-backfill/x');
  assert.deepEqual([backfill('live'),backfill('stored'),backfill('stored-detail')],[11,1,2]);
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
