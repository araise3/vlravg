import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {maxUnits,MATCH_LIST_MAX_SIZE,FORCED_ACCOUNT_UNITS} from '../lib/upstream-cost.mjs';
import {recordPublicQuotaEvent} from '../lib/public-quota-audit.mjs';

const u=q=>new URL('https://site.test/x'+q);

test('maximum cost per call: 1 per request plus 1 per Riot fetch it can make, 3 for forced account lookups',()=>{
  assert.equal(maxUnits({trackAccount:true},[],u(''),'/account/Alpha/EU'),2);
  assert.equal(FORCED_ACCOUNT_UNITS,3);
  assert.equal(maxUnits({trackAccount:true,accountByPuuid:true},[],u('?force=true'),'/account-by-puuid/x'),3,'measured, above the rule');
  assert.equal(maxUnits({nameHistory:true},[],u(''),'/name-history/x'),3,'the same forced lookup');
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
