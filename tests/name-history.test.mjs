import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { observeName, readNameHistory } from '../lib/name-history.mjs';
import { refreshPlayer, requestJSON, backfillPlayer } from '../.github/scripts/refresh-rr-history.mjs';
import { backfillState, saveBackfillPage, saveStoredBackfillPage, saveStoredMatchDetail, matchNameEvidence, storedNameEvidence, compactMatchEvidence, mergeNameTimeline } from '../lib/name-backfill.mjs';
import { onRequestGet } from '../functions/api/[[path]].js';

const puuid = '11111111-1111-4111-8111-111111111111';
const account = (name='Alpha',tag='EU') => ({puuid,name,tag,region:'eu'});
const day = n => `2026-09-${String(n).padStart(2,'0')}T05:17:00.000Z`;
const migration = readFileSync(new URL('../migrations/0001_name_history.sql',import.meta.url),'utf8');
const compactMigration = readFileSync(new URL('../migrations/0003_compact_name_evidence.sql',import.meta.url),'utf8');
const storedMigration = readFileSync(new URL('../migrations/0004_stored_name_backfill.sql',import.meta.url),'utf8');
function database(t) {
  const sql = new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db = { prepare(query) {
    let values=[];
    const statement={bind(...args){values=args;return statement;},async all(){return{results:run(true)};},async run(){return run(false);},async first(){return run(true)[0]||null;}};
    function run(rows){const args=Object.fromEntries(values.map((v,i)=>['?'+(i+1),v]));const s=sql.prepare(query);return rows?s.all(args):s.run(args);}
    return statement;
  }, async batch(statements) {
    sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}
  }};
  return {sql,db};
}
test('unchanged IDs extend one period; renames, tag-only changes and reused names create separate periods',async t=>{
  const {db}=database(t);
  await observeName(db,account(),day(1));await observeName(db,account(),day(2));
  assert.equal((await readNameHistory(db,puuid)).length,1);
  await observeName(db,account('Beta'),day(3));
  await observeName(db,account('Beta','NEW'),day(4));
  const rows=await observeName(db,account(),day(5));
  assert.deepEqual(rows.map(r=>r.name+'#'+r.tag),['Alpha#EU','Beta#NEW','Beta#EU','Alpha#EU']);
  assert.equal(rows[3].first_seen,day(1));assert.equal(rows[3].last_seen,day(2));assert.equal(rows[3].ended_at,day(3));
  assert.equal(rows[0].ended_at,null);
});
test('duplicate and out-of-order checks cannot roll the current name back',async t=>{
  const {db}=database(t);
  await observeName(db,account(),day(1));await observeName(db,account('Beta'),day(3));
  await observeName(db,account(),day(2));await observeName(db,account('Beta'),day(3));
  const rows=await readNameHistory(db,puuid);
  assert.equal(rows.length,2);assert.equal(rows[0].name,'Beta');
  assert.equal((await db.prepare('SELECT name FROM rr_players WHERE puuid=?1').bind(puuid).first()).name,'Beta');
});
test('migration preserves only known dates and is safe to re-run',t=>{
  const {sql}=database(t);
  sql.prepare('INSERT INTO rr_players(puuid,name,tag,updated_at) VALUES (?,?,?,?)').run(puuid,'Old','EU',day(1));
  sql.exec(migration);sql.exec(migration);
  const rows=sql.prepare('SELECT * FROM player_name_history').all();
  assert.equal(rows.length,1);assert.equal(rows[0].first_seen,day(1));assert.equal(rows[0].last_seen,day(1));
});
test('compact evidence migration preserves existing backfill cursors',t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE player_name_backfill(puuid TEXT NOT NULL,region TEXT NOT NULL,platform TEXT NOT NULL,
    next_start INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
    PRIMARY KEY(puuid,region,platform));
    INSERT INTO player_name_backfill VALUES('${puuid}','eu','pc',420,0,'${day(1)}');`);
  sql.exec(compactMigration);
  const row=sql.prepare('SELECT next_start,evidence FROM player_name_backfill').get();
  assert.equal(row.next_start,420);assert.equal(row.evidence,'[]');
});
test('stored archive migration enrolls already completed cursors without repeating full matches',t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE player_name_backfill(puuid TEXT NOT NULL,region TEXT NOT NULL,platform TEXT NOT NULL,
    next_start INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(puuid,region,platform));
    INSERT INTO player_name_backfill(puuid,region,platform,next_start,complete,updated_at)
    VALUES('${puuid}','eu','pc',2564,1,'${day(1)}');`);
  sql.exec(storedMigration);
  const row=sql.prepare('SELECT next_start,complete,stored_page,stored_scanned,stored_complete,stored_pending FROM player_name_backfill').get();
  assert.equal(row.next_start,2564);assert.equal(row.complete,1);assert.equal(row.stored_page,1);
  assert.equal(row.stored_scanned,0);assert.equal(row.stored_complete,0);assert.equal(row.stored_pending,'[]');
});
test('invalid observations do not write history',async t=>{
  const {db}=database(t);await assert.rejects(observeName(db,account(''),day(1)));
  assert.equal((await readNameHistory(db,puuid)).length,0);
});
test('daily job checks by permanent ID and uses it for RR after a rename',async()=>{
  const urls=[];
  const result=await refreshPlayer({...account(),platform:'pc'},{origin:'https://example.test',sleepImpl:async()=>{},fetchImpl:async url=>{
    urls.push(url);return Response.json({data:url.includes('/name-history/')?{puuid,region:'na',history:[{name:'New',tag:'ID',ended_at:null}]}:{account:{puuid},history:[]}});
  }});
  assert.equal(result.ok,true);assert.equal(urls[1],`https://example.test/api/mmr-history-by-puuid/na/pc/${puuid}`);
});
test('RR still refreshes when a name check fails, and the run reports failure',async()=>{
  const urls=[];const result=await refreshPlayer({...account(),platform:'pc'},{origin:'https://example.test',sleepImpl:async()=>{},fetchImpl:async url=>{
    urls.push(url);return url.includes('/name-history/')?Response.json({}, {status:404}):Response.json({data:{account:{puuid},history:[]}});
  }});
  assert.equal(urls.length,2);assert.equal(result.rr.ok,true);assert.equal(result.ok,false);
});
test('429 retries use the proxy wait; malformed successes are failures',async()=>{
  let calls=0;const waits=[];
  const result=await requestJSON('https://example.test',async()=>++calls===1?Response.json({retryAfterMs:4500},{status:429}):Response.json({data:{}}),async ms=>waits.push(ms));
  assert.equal(result.ok,true);assert.deepEqual(waits,[4500]);
  assert.equal((await requestJSON('https://example.test',async()=>new Response('bad json'),async()=>{})).ok,false);
});
test('proxy forces a fresh account check, canonicalizes cache keys, persists, and hides quota headers',async t=>{
  const {db}=database(t);let upstreamCalls=0;let upstreamURL;
  const cache=new Map();const oldCaches=globalThis.caches,oldFetch=globalThis.fetch;
  globalThis.caches={default:{async match(req){return cache.get(req.url)?.clone();},async put(req,res){cache.set(req.url,res.clone());}}};
  globalThis.fetch=async url=>{upstreamCalls++;upstreamURL=url;return Response.json({data:account()},{headers:{'x-ratelimit-remaining':'59','x-ratelimit-reset':'60'}});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  async function request(query=''){const jobs=[];const res=await onRequestGet({request:new Request(`https://example.test/api/name-history/${puuid}${query}`),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);return res;}
  const res=await request('?name=FAKE&force=false');assert.equal(res.status,200);
  assert.equal(upstreamURL,`https://api.henrikdev.xyz/valorant/v1/by-puuid/account/${puuid}?force=true`);
  assert.equal((await res.json()).data.history[0].name,'Alpha');assert.equal(res.headers.get('x-ratelimit-remaining'),null);
  await request('?other=123');assert.equal(upstreamCalls,1);
});

const historicalMatch=(id,name,tag,stamp)=>({metadata:{match_id:id,started_at:stamp},players:[{puuid,name,tag}]});
const storedMatch=(id,name,tag,stamp)=>({meta:{id,started_at:stamp},stats:{puuid,name,tag}});
async function trackedDatabase(t){
  const data=database(t);
  await observeName(data.db,account('Current'),day(4));
  await data.db.prepare('UPDATE rr_players SET platform=?1 WHERE puuid=?2').bind('pc',puuid).run();
  return data;
}

test('backfill merges historical ranges, preserves name reuse, and never changes the current identity',async t=>{
  const {db}=await trackedDatabase(t);
  const state=await backfillState(db,puuid);
  const page=[historicalMatch('1','Alpha','EU',day(1)),historicalMatch('2','Beta','EU',day(2)),historicalMatch('3','Alpha','EU',day(3))];
  await saveBackfillPage(db,puuid,state,page);
  let rows=await readNameHistory(db,puuid);
  assert.deepEqual(rows.map(r=>r.name),['Current','Alpha','Beta','Alpha']);
  assert.equal(rows[0].ended_at,null);assert.equal(rows[1].source,'Matches');
  assert.equal((await db.prepare('SELECT name FROM rr_players WHERE puuid=?1').bind(puuid).first()).name,'Current');
  // Matches from after live checks began are not permitted to overwrite them.
  await saveBackfillPage(db,puuid,await backfillState(db,puuid),[historicalMatch('4','Wrong','EU',day(5))],Date.parse(day(6)));
  rows=await readNameHistory(db,puuid);assert.equal(rows.some(r=>r.name==='Wrong'),false);
});

test('legacy rows and compact evidence form one historical timeline',async t=>{
  const {db}=await trackedDatabase(t);
  await db.prepare(`INSERT INTO player_name_matches(puuid,match_id,name,tag,played_at)
    VALUES(?1,?2,?3,?4,?5)`).bind(puuid,'legacy','Beta','EU',day(2)).run();
  await saveBackfillPage(db,puuid,await backfillState(db,puuid),[historicalMatch('compact','Alpha','EU',day(1))]);
  assert.deepEqual((await readNameHistory(db,puuid)).map(row=>row.name),['Current','Beta','Alpha']);
});

test('matching historical names extend the current range without assuming a 90-day start date',()=>{
  const live=[{name:'A',tag:'EU',first_seen:day(4),last_seen:day(5),ended_at:null}];
  const rows=mergeNameTimeline(live,[{name:'A',tag:'EU',played_at:day(1)},{name:'A',tag:'EU',played_at:day(3)}]);
  assert.equal(rows.length,1);assert.equal(rows[0].first_seen,day(1));assert.equal(rows[0].last_seen,day(5));assert.equal(rows[0].source,'Matches + checks');
});

test('backfill retries deduplicate evidence and concurrent old pages cannot advance or rewind progress',async t=>{
  const {db}=await trackedDatabase(t);const initial=await backfillState(db,puuid);
  const page=[historicalMatch('1','Old','EU',day(1))];
  await saveBackfillPage(db,puuid,initial,page);
  await saveBackfillPage(db,puuid,initial,page);
  assert.equal((await backfillState(db,puuid)).next_start,1);
  assert.equal((await backfillState(db,puuid)).complete,false); // A short page is not the end.
  const next=await backfillState(db,puuid);
  await saveBackfillPage(db,puuid,next,[]);
  await saveBackfillPage(db,puuid,initial,page);
  let state=await backfillState(db,puuid);
  assert.equal(state.matchlist_complete,true);assert.equal(state.complete,false);assert.equal(state.phase,'stored');
  await saveStoredBackfillPage(db,puuid,state,{data:[],results:{after:0}});
  assert.equal((await backfillState(db,puuid)).complete,true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM player_name_matches').first()).n,0);
  const saved=await db.prepare('SELECT evidence FROM player_name_backfill WHERE puuid=?1').bind(puuid).first();
  assert.deepEqual(JSON.parse(saved.evidence),[{name:'Old',tag:'EU',played_at:day(1)}]);
});

test('malformed pages do not advance the cursor and blank names are skipped',async t=>{
  const {db}=await trackedDatabase(t);const state=await backfillState(db,puuid);
  await assert.rejects(saveBackfillPage(db,puuid,state,[{metadata:{match_id:'x'},players:[]}]));
  assert.equal((await backfillState(db,puuid)).next_start,0);
  assert.equal(matchNameEvidence([historicalMatch('1','','',day(1))],puuid).length,0);
  assert.throws(()=>matchNameEvidence([historicalMatch('2','A','EU','2099-01-01')],puuid));
});

test('stored pages add named identities and queue older blank records for match details',async t=>{
  const {db}=await trackedDatabase(t);
  let state=await backfillState(db,puuid);
  await saveBackfillPage(db,puuid,state,[]);state=await backfillState(db,puuid);
  const page=[storedMatch('blank',null,null,day(1)),storedMatch('named','Cereal Killer','007',day(2))];
  assert.deepEqual(storedNameEvidence(page,puuid).map(row=>row.name),['Cereal Killer']);
  state=await saveStoredBackfillPage(db,puuid,state,{data:page,results:{after:0}});
  assert.equal(state.complete,false);assert.equal(state.phase,'stored-detail');assert.equal(state.stored_pending_count,1);
  state=await backfillState(db,puuid,true);
  state=await saveStoredMatchDetail(db,puuid,state,historicalMatch('blank','Earlier','EU',day(1)));
  assert.equal(state.complete,true);assert.equal(state.stored_scanned,2);
  assert.deepEqual((await readNameHistory(db,puuid)).map(row=>row.name),['Current','Cereal Killer','Earlier']);
});

test('unchanged match pages retain range endpoints instead of every redundant row',()=>{
  const page=Array.from({length:10},(_,i)=>historicalMatch(String(i),'Same','EU',
    `2026-08-${String(i+1).padStart(2,'0')}T05:17:00.000Z`));
  const evidence=matchNameEvidence(page,puuid,Date.parse(day(6)));
  assert.deepEqual(evidence.map(e=>e.match_id),['0','9']);
  const changed=matchNameEvidence([
    historicalMatch('a','First','EU','2026-08-01T00:00:00Z'),
    historicalMatch('b','Second','EU','2026-08-02T00:00:00Z'),
    historicalMatch('c','First','EU','2026-08-03T00:00:00Z'),
  ],puuid,Date.parse(day(6)));
  assert.deepEqual(changed.map(e=>e.match_id),['a','b','c']);
});

test('compact evidence merges page boundaries while preserving reused names',()=>{
  const rows=compactMatchEvidence([
    {name:'A',tag:'EU',played_at:day(1)},{name:'A',tag:'EU',played_at:day(2)},
    {name:'B',tag:'EU',played_at:day(3)},{name:'A',tag:'EU',played_at:day(4)},
    {name:'A',tag:'EU',played_at:day(5)},
  ]);
  assert.deepEqual(rows,[
    {name:'A',tag:'EU',played_at:day(1)},{name:'A',tag:'EU',played_at:day(2)},
    {name:'B',tag:'EU',played_at:day(3)},
    {name:'A',tag:'EU',played_at:day(4)},{name:'A',tag:'EU',played_at:day(5)},
  ]);
});

test('compact evidence removes a one-match rapid name bounce',()=>{
  const rows=compactMatchEvidence([
    {name:'smoking opps',tag:'Von',played_at:'2025-09-16T20:00:00.000Z'},
    {name:'Kurdistan peek',tag:'musun',played_at:'2025-09-17T01:00:00.000Z'},
    {name:'smoking opps',tag:'Von',played_at:'2025-09-17T06:00:00.000Z'},
    {name:'smoking opps',tag:'Von',played_at:'2025-12-13T20:00:00.000Z'},
  ]);
  assert.deepEqual(rows,[
    {name:'smoking opps',tag:'Von',played_at:'2025-09-16T20:00:00.000Z'},
    {name:'smoking opps',tag:'Von',played_at:'2025-12-13T20:00:00.000Z'},
  ]);
});

test('completed backfill evidence is corrected when the timeline is read',async t=>{
  const {db}=database(t);
  await observeName(db,account('Kurdistan peek','musun'),'2026-04-28T05:17:00.000Z');
  await db.prepare('UPDATE rr_players SET platform=?1 WHERE puuid=?2').bind('pc',puuid).run();
  const evidence=[
    {name:'smoking opps',tag:'Von',played_at:'2025-08-12T20:00:00.000Z'},
    {name:'smoking opps',tag:'Von',played_at:'2025-09-16T20:00:00.000Z'},
    {name:'Kurdistan peek',tag:'musun',played_at:'2025-09-17T01:00:00.000Z'},
    {name:'smoking opps',tag:'Von',played_at:'2025-09-17T06:00:00.000Z'},
    {name:'smoking opps',tag:'Von',played_at:'2025-12-13T20:00:00.000Z'},
  ];
  await db.prepare(`INSERT INTO player_name_backfill
    (puuid,region,platform,next_start,complete,updated_at,evidence)
    VALUES(?1,?2,?3,?4,1,?5,?6)`).bind(puuid,'eu','pc',2564,day(6),JSON.stringify(evidence)).run();
  const rows=await readNameHistory(db,puuid);
  assert.deepEqual(rows.map(row=>row.name+'#'+row.tag),[
    'Kurdistan peek#musun','smoking opps#Von',
  ]);
  assert.equal(rows[1].first_seen,'2025-08-12T20:00:00.000Z');
  assert.equal(rows[1].last_seen,'2025-12-13T20:00:00.000Z');
});

test('compact evidence keeps a one-match name reuse outside the rapid-bounce window',()=>{
  const rows=compactMatchEvidence([
    {name:'A',tag:'EU',played_at:'2026-01-01T00:00:00.000Z'},
    {name:'B',tag:'EU',played_at:'2026-02-01T00:00:00.000Z'},
    {name:'A',tag:'EU',played_at:'2026-04-15T00:00:00.000Z'},
  ]);
  assert.equal(rows.length,3);
  assert.equal(rows[1].name,'B');
});

test('scheduled backfill stops when complete and reports failed pages for a later retry',async()=>{
  let calls=0;
  const result=await backfillPlayer({puuid},{origin:'https://example.test',pages:20,sleepImpl:async()=>{},fetchImpl:async()=>{
    calls++;return Response.json({data:{puuid,backfill:{available:true,next_start:10,complete:calls===2}}});
  }});
  assert.equal(calls,2);assert.equal(result.complete,true);
  assert.equal((await backfillPlayer({puuid},{origin:'https://example.test',sleepImpl:async()=>{},fetchImpl:async()=>Response.json({},{status:404})})).ok,false);
});

test('proxy backfill uses the saved cursor, omits roster data, and cached name history sees new evidence',async t=>{
  const {db}=await trackedDatabase(t);let calls=0;const urls=[];
  const cache=new Map();const oldCaches=globalThis.caches,oldFetch=globalThis.fetch;
  globalThis.caches={default:{async match(req){return cache.get(req.url)?.clone();},async put(req,res){cache.set(req.url,res.clone());}}};
  globalThis.fetch=async url=>{urls.push(url);calls++;return Response.json({data:url.includes('/account/')?account('Current'):[historicalMatch('old','Old','EU',day(1))]});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  async function request(path){const jobs=[];const res=await onRequestGet({request:new Request('https://example.test/api/'+path),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);return res;}
  await request('name-history/'+puuid);
  const response=await request('name-backfill/'+puuid+'?start=999&name=FAKE');
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const body=await response.json();assert.equal(body.data.backfill.next_start,1);assert.equal(body.data.players,undefined);
  assert.ok(urls[1].endsWith('?mode=competitive&size=10&start=0'));
  const fresh=await request('name-history/'+puuid);
  assert.equal((await fresh.json()).data.history.at(-1).name,'Old');assert.equal(calls,2);
});

test('proxy supplements a completed full scan from stored matches',async t=>{
  const {db}=await trackedDatabase(t);
  await saveBackfillPage(db,puuid,await backfillState(db,puuid),[]);
  const urls=[];const oldCaches=globalThis.caches,oldFetch=globalThis.fetch;
  globalThis.caches={default:{async match(){return null;},async put(){}}};
  globalThis.fetch=async url=>{
    urls.push(url);
    return Response.json({data:[storedMatch('archive','Cereal Killer','007',day(1))],results:{after:0}});
  };
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const jobs=[];
  const response=await onRequestGet({request:new Request(`https://example.test/api/name-backfill/${puuid}`),
    env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);
  assert.equal(response.status,200);
  assert.ok(urls[0].includes(`/valorant/v1/by-puuid/stored-matches/eu/${puuid}?mode=competitive&size=100&page=1`));
  const body=await response.json();
  assert.equal(body.data.backfill.complete,true);
  assert.equal(body.data.backfill.next_start,0);
  assert.equal(body.data.backfill.stored_scanned,1);
  assert.equal(body.data.history.at(-1).name,'Cereal Killer');
});

test('proxy resolves blank old archive records through full match details',async t=>{
  const {db}=await trackedDatabase(t);
  await saveBackfillPage(db,puuid,await backfillState(db,puuid),[]);
  const urls=[];const oldCaches=globalThis.caches,oldFetch=globalThis.fetch;
  globalThis.caches={default:{async match(){return null;},async put(){}}};
  globalThis.fetch=async url=>{
    urls.push(url);
    return url.includes('/stored-matches/')
      ?Response.json({data:[storedMatch('archive',null,null,day(1))],results:{after:0}})
      :Response.json({data:historicalMatch('archive','Cereal Killer','007',day(1))});
  };
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  async function request(){
    const jobs=[];const response=await onRequestGet({request:new Request(`https://example.test/api/name-backfill/${puuid}`),
      env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);return response;
  }
  let body=await (await request()).json();
  assert.equal(body.data.backfill.phase,'stored-detail');assert.equal(body.data.backfill.stored_match,undefined);
  body=await (await request()).json();
  assert.ok(urls[1].endsWith('/valorant/v4/match/eu/archive'));
  assert.equal(body.data.backfill.complete,true);
  assert.equal(body.data.history.at(-1).name,'Cereal Killer');
});

test('an unavailable archived match detail is skipped without stalling the player',async t=>{
  const {db}=await trackedDatabase(t);
  await saveBackfillPage(db,puuid,await backfillState(db,puuid),[]);
  const oldCaches=globalThis.caches,oldFetch=globalThis.fetch;let calls=0;
  globalThis.caches={default:{async match(){return null;},async put(){}}};
  globalThis.fetch=async()=>++calls===1
    ?Response.json({data:[storedMatch('gone',null,null,day(1))],results:{after:0}})
    :Response.json({errors:[{message:'Match not found'}]},{status:404});
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  async function request(){
    const jobs=[];const response=await onRequestGet({request:new Request(`https://example.test/api/name-backfill/${puuid}`),
      env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);return response;
  }
  await request();const response=await request();const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.data.backfill.complete,true);
  assert.equal(body.data.backfill.stored_pending_count,0);
});

test('a player with no stored archive completes when Henrik returns 404',async t=>{
  const {db}=await trackedDatabase(t);
  await saveBackfillPage(db,puuid,await backfillState(db,puuid),[]);
  const oldCaches=globalThis.caches,oldFetch=globalThis.fetch;
  globalThis.caches={default:{async match(){return null;},async put(){}}};
  globalThis.fetch=async()=>Response.json({errors:[{message:'No stored matches'}]},{status:404});
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const jobs=[];const response=await onRequestGet({request:new Request(`https://example.test/api/name-backfill/${puuid}`),
    env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);
  const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.data.backfill.complete,true);
  assert.equal(body.data.backfill.stored_scanned,0);
});
