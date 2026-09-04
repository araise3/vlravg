import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { observeName, readNameHistory } from '../lib/name-history.mjs';
import { refreshPlayer, requestJSON, backfillPlayer } from '../.github/scripts/refresh-rr-history.mjs';
import { backfillState, saveBackfillPage, matchNameEvidence, mergeNameTimeline } from '../lib/name-backfill.mjs';
import { onRequestGet } from '../functions/api/[[path]].js';

const puuid = '11111111-1111-4111-8111-111111111111';
const account = (name='Alpha',tag='EU') => ({puuid,name,tag,region:'eu'});
const day = n => `2026-09-${String(n).padStart(2,'0')}T05:17:00.000Z`;
const migration = readFileSync(new URL('../migrations/0001_name_history.sql',import.meta.url),'utf8');
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
  assert.equal((await backfillState(db,puuid)).complete,true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM player_name_matches').first()).n,1);
});

test('malformed pages do not advance the cursor and blank names are skipped',async t=>{
  const {db}=await trackedDatabase(t);const state=await backfillState(db,puuid);
  await assert.rejects(saveBackfillPage(db,puuid,state,[{metadata:{match_id:'x'},players:[]}]));
  assert.equal((await backfillState(db,puuid)).next_start,0);
  assert.equal(matchNameEvidence([historicalMatch('1','','',day(1))],puuid).length,0);
  assert.throws(()=>matchNameEvidence([historicalMatch('2','A','EU','2099-01-01')],puuid));
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
