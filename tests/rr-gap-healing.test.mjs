import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {collectRR,healRR,rankBreaks,rankCoordinate,storedGapEntries,HEAL_ATTEMPTS,HEAL_MAX_PAGES,HEAL_PAGE_SIZE} from '../lib/rr-corpus.mjs';
import {scanGaps,loadOpenGaps,gapSummary} from '../.github/scripts/rr-gap-queries.mjs';
import {onRequestGet} from '../functions/api/[[path]].js';

const puuid='11111111-1111-4111-8111-111111111111',season='33333333-3333-4333-8333-333333333333';
const scope={puuid,region:'eu',platform:'pc'};
const at=i=>new Date(Date.UTC(2026,10,20)+i*3600000).toISOString();
const id=i=>`aaaaaaaa-0000-4000-8000-${String(i).padStart(12,'0')}`;
// Game i ends at 100+20*i... RR: each game +20 from the previous one, so the
// reported start of game i equals the end of game i-1 (rank coordinate chain).
const end=i=>1000+20*i;
const coordinate=value=>({tier:{id:Math.floor(value/100)+3},rr:value%100});
const game=(i,extra={})=>({match_id:id(i),date:at(i),last_change:20,season:{id:season,short:'e11a6'},
  ...coordinate(end(i)),tier_before_update:coordinate(end(i-1)).tier,rr_before_update:coordinate(end(i-1)).rr,...extra});
const payload=history=>({data:{account:{puuid,name:'Alpha',tag:'EU'},history}});
const newestFirst=(from,to)=>Array.from({length:to-from+1},(_,k)=>game(to-k));

function database(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const s={bind(...v){values=v;return s;},async first(){return execute(true)[0]||null;},async all(){return {results:execute(true)};},async run(){return execute(false);}};
    function execute(rows){const statement=sql.prepare(query);const args=Object.fromEntries(values.map((v,i)=>['?'+(i+1),v]));return rows?statement.all(args):statement.run(args);}return s;},
    async batch(statements){sql.exec('BEGIN');try{for(const s of statements)await s.run();sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const query=async(_env,text,params=[])=>(await db.prepare(text).bind(...params).all()).results;
  const gapRow=after=>({...sql.prepare('SELECT * FROM rr_gaps WHERE puuid=? AND after_match_id=?').get(puuid,after)});
  return {sql,db,query,gapRow};
}
// Saves games 0-19, then a window of games 25-44: games 20-24 dropped out.
async function missedFive(db){
  await collectRR(db,payload(newestFirst(0,19)),scope,at(19.5));
  const receipt=await collectRR(db,payload(newestFirst(25,44)),scope,at(44.5));
  return receipt.gap;
}

test('rank coordinates put Immortal and up on one RR axis; breaks need a known, same-act start',()=>{
  assert.equal(rankCoordinate(3,0),0);
  assert.equal(rankCoordinate(23,99),2099);
  assert.equal(rankCoordinate(26,618),rankCoordinate(27,618),'a Radiant label change is not a rank change');
  assert.equal(rankCoordinate(0,0),null);assert.equal(rankCoordinate(12,null),null);
  const a={match_id:'a',date:at(0),season:{id:season},tier:{id:27},rr:618};
  assert.deepEqual(rankBreaks([{...a,match_id:'b',date:at(1),tier_before_update:{id:26},rr_before_update:618},a]),[]);
  assert.deepEqual(rankBreaks([a,{...a,match_id:'b',date:at(1),tier_before_update:{id:27},rr_before_update:600}]),
    [{after_match_id:'a',before_match_id:'b'}]);
  assert.deepEqual(rankBreaks([a,{...a,match_id:'b',date:at(1),season:{id:'next'},tier_before_update:{id:3},rr_before_update:0}]),[],'a new act resets rank');
  assert.deepEqual(rankBreaks([a,{...a,match_id:'b',date:at(1)}]),[],'unknown start');
});

test('stored history fills the dropped games, marks them, verifies the chain and closes the gap',async t=>{
  const {db,sql,gapRow}=database(t);
  const gap=await missedFive(db);
  assert.deepEqual(gap,{after_match_id:id(19),after_date:at(19),before_match_id:id(25),before_date:at(25)});
  // Stored history, newest first, reaching back past the gap.
  const result=await healRR(db,{...gapRow(id(19))},newestFirst(10,44),{stamp:at(50)});
  assert.equal(result.done,true);assert.equal(result.status,'healed');
  assert.equal(result.recovered,5);assert.equal(result.breaks,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,45);
  const healed=JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get(id(22)).data);
  assert.equal(healed.vlravg_source,'stored-mmr-history');
  assert.equal(healed.rr_before_update,game(22).rr_before_update,'stored entries keep every reported field');
  assert.equal(JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get(id(30)).data).vlravg_source,undefined,
    'live payouts are never replaced by stored ones');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_predecessors WHERE match_id=?').get(id(22)).n,0,'stored adjacency is not witnessed');
  const row=gapRow(id(19));
  assert.deepEqual([row.status,row.recovered,row.attempts,row.resolved_at],['healed',5,1,at(50)]);
});

test('a gap with nothing missing in stored history is marked connected',async t=>{
  const {db,gapRow}=database(t);
  // Exactly 20 games since the last poll: the window starts right after the head.
  await collectRR(db,payload(newestFirst(0,19)),scope);
  const gap=(await collectRR(db,payload(newestFirst(20,39)),scope)).gap;
  assert.equal(gap.after_match_id,id(19));
  const result=await healRR(db,gapRow(id(19)),newestFirst(0,39),{stamp:at(50)});
  assert.deepEqual([result.status,result.recovered],['connected',0]);
});

test('a chain stored history cannot close is retried after 1 and 3 days, then left unresolved',async t=>{
  const {db,gapRow}=database(t);
  await missedFive(db);
  const partial=newestFirst(10,44).filter(h=>h.match_id!==id(22));// stored lacks game 22
  let result=await healRR(db,gapRow(id(19)),partial,{stamp:at(50)});
  assert.deepEqual([result.status,result.recovered,result.breaks],['incomplete',4,1]);
  assert.equal(result.next_attempt_at,new Date(Date.parse(at(50))+86400000).toISOString());
  result=await healRR(db,gapRow(id(19)),partial,{stamp:at(80)});
  assert.equal(result.status,'incomplete');
  assert.equal(result.next_attempt_at,new Date(Date.parse(at(80))+3*86400000).toISOString());
  assert.equal(gapRow(id(19)).recovered,4,'recovered payouts are counted once');
  // Stored history catches up later: the last attempt heals the gap.
  result=await healRR(db,gapRow(id(19)),newestFirst(10,44),{stamp:at(200)});
  assert.deepEqual([result.status,gapRow(id(19)).recovered],['healed',5]);
  assert.equal(HEAL_ATTEMPTS,3);
});

test('a discontinuity without missing games (decay) ends unresolved after the last attempt',async t=>{
  const {db,gapRow}=database(t);
  await collectRR(db,payload(newestFirst(0,19)),scope);
  const decayed=newestFirst(20,39).map(h=>({...h,rr_before_update:h.match_id===id(20)?h.rr_before_update-10:h.rr_before_update}));
  await collectRR(db,payload(decayed),scope);
  for(const [i,expected] of ['incomplete','incomplete','unresolved'].entries()){
    const result=await healRR(db,gapRow(id(19)),[...decayed,...newestFirst(0,19)],{stamp:at(100+i*200)});
    assert.equal(result.status,expected);
  }
  assert.equal(gapRow(id(19)).resolved_at,at(500));
});

test('long gaps page through stored history until it reaches the gap start',async t=>{
  const {db,gapRow}=database(t);
  await collectRR(db,payload(newestFirst(0,19)),scope);
  await collectRR(db,payload(newestFirst(60,79)),scope);// games 20-59 dropped out
  const pages=[newestFirst(45,79).slice(0,25),newestFirst(10,54)];
  let result=await healRR(db,gapRow(id(19)),pages[0],{page:1,size:25,stamp:at(90)});
  assert.deepEqual([result.done,result.next_page,result.recovered],[false,2,5]);// games 55-59
  assert.equal(gapRow(id(19)).status,'open');
  result=await healRR(db,gapRow(id(19)),pages[1],{page:2,size:25,stamp:at(90)});
  assert.deepEqual([result.done,result.status,result.total_recovered],[true,'healed',40]);
  // The last allowed page ends the attempt even when it has not reached the start.
  assert.equal(HEAL_MAX_PAGES,10);
  assert.equal(storedGapEntries(newestFirst(0,4),{after_match_id:id(0),after_date:at(0),before_match_id:id(4),before_date:at(4)},5).reached,true);
  assert.equal(storedGapEntries(newestFirst(1,5),{after_match_id:id(0),after_date:at(0),before_date:at(9)},5).reached,false);
});

test('an empty live window is verified against stored history up to the check time',async t=>{
  const {db,sql,gapRow}=database(t);
  await collectRR(db,payload(newestFirst(0,19)),scope);
  const {gap}=await collectRR(db,payload([]),scope,at(23.5));
  assert.deepEqual(gap,{after_match_id:id(19),after_date:at(19),before_match_id:null,before_date:at(23.5)});
  const result=await healRR(db,gapRow(id(19)),newestFirst(10,23),{stamp:at(24)});
  assert.deepEqual([result.status,result.recovered],['healed',4]);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,24);
});

test('a malformed stored page writes nothing',async t=>{
  const {db,sql,gapRow}=database(t);
  await missedFive(db);
  await assert.rejects(healRR(db,gapRow(id(19)),[{...game(22),last_change:'x'}]),/Invalid stored RR history/);
  await assert.rejects(healRR(db,gapRow(id(19)),null),/Invalid stored RR history/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,40);
  assert.equal(gapRow(id(19)).attempts,0);
});

test('the heal route is collector-only, uses the gap row for region and platform, and stops once resolved',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  await collectRR(db,payload(newestFirst(0,19)),{puuid,region:'ap',platform:'console'});
  await collectRR(db,payload(newestFirst(25,44)),{puuid,region:'ap',platform:'console'});
  const urls=[];
  globalThis.caches={default:{async match(){throw new Error('no cache');},async put(){throw new Error('no cache');}}};
  globalThis.fetch=async url=>{urls.push(String(url));return Response.json({status:200,data:newestFirst(10,44)});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const env={APP_DB:db,HENRIK_KEY:'public',HENRIK_WORKFLOW_KEY:'collector'};
  const call=(path,headers={'X-Workflow-Key':'collector'})=>onRequestGet({request:new Request(`https://test/api/${path}`,{headers}),env,waitUntil(){}});
  assert.equal((await call(`rr-heal/${puuid}/${id(19)}`,{})).status,404,'public callers cannot reach it');
  assert.equal((await call(`rr-heal/${puuid}/${id(3)}`)).status,404,'no gap recorded after game 3');
  assert.equal((await call(`rr-heal/${puuid}/${id(19)}?page=0`)).status,400);
  assert.equal(urls.length,0);
  const response=await call(`rr-heal/${puuid}/${id(19)}`);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual([body.data.status,body.data.recovered,body.data.done],['healed',5,true]);
  assert.equal(urls[0],`https://api.henrikdev.xyz/valorant/v2/by-puuid/stored-mmr-history/ap/console/${puuid}?page=1&size=${HEAL_PAGE_SIZE}`);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await call(`rr-heal/${puuid}/${id(19)}`)).status,404,'a healed gap is not fetched again');
  assert.equal(urls.length,1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,45);
});

test('the heal route treats a missing stored history as an empty page and rejects malformed ones',async t=>{
  const {db,gapRow}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  await missedFive(db);
  let answer=()=>Response.json({errors:[{message:'Not found'}]},{status:404});
  globalThis.caches={default:{async match(){return null;},async put(){}}};
  globalThis.fetch=async()=>answer();
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const env={APP_DB:db,HENRIK_KEY:'public',HENRIK_WORKFLOW_KEY:'collector'};
  const call=()=>onRequestGet({request:new Request(`https://test/api/rr-heal/${puuid}/${id(19)}`,{headers:{'X-Workflow-Key':'collector'}}),env,waitUntil(){}});
  const missing=await call();
  assert.equal(missing.status,200);
  assert.equal((await missing.json()).data.status,'incomplete');
  answer=()=>Response.json({data:[{match_id:id(22)}]});
  const reset=async()=>{for(const table of ['rate_quota','workflow_rate_quota'])try{(await db.prepare(`UPDATE ${table} SET next_start_at=0`).run());}catch{}};
  await reset();
  await db.prepare("UPDATE rr_gaps SET next_attempt_at='2000-01-01'").run();
  assert.equal((await call()).status,502);
  assert.equal(gapRow(id(19)).attempts,1);
});

test('the daily scan queues unwitnessed rank discontinuities once and matches one whole-table statement',async t=>{
  const {db,sql,query}=database(t);
  const other='ffffffff-1111-4111-8111-111111111111';
  // Player 1: games 0-9, then 15-19 saved by a visitor on another day (never witnessed together).
  await collectRR(db,payload(newestFirst(0,9)),scope);
  sql.prepare('INSERT INTO rr_history(puuid,match_id,data,date) VALUES(?,?,?,?)').run(puuid,id(15),JSON.stringify(game(15)),at(15));
  // Player 2: a witnessed decay (one window lists both payouts) is not a gap.
  const decayed=[game(1),{...game(0)}].map(h=>h.match_id===id(1)?{...h,rr_before_update:h.rr_before_update-10}:h);
  await collectRR(db,{data:{account:{puuid:other,name:'B',tag:'EU'},history:decayed}},{puuid:other,region:'eu',platform:'pc'});
  const whole=await scanGaps({},query,{slices:1,pauseMs:0,sleep:async()=>{}});
  assert.equal(whole.found,1);
  const row={...sql.prepare('SELECT puuid,after_match_id,before_match_id,source,status,region,platform FROM rr_gaps').get()};
  assert.deepEqual(row,{puuid,after_match_id:id(9),before_match_id:id(15),source:'scan',status:'open',region:'eu',platform:'pc'});
  assert.equal((await scanGaps({},query,{slices:16,pauseMs:0,sleep:async()=>{}})).found,0,'an existing gap is not queued again');
  sql.exec('DELETE FROM rr_gaps');
  assert.equal((await scanGaps({},query,{slices:16,pauseMs:0,sleep:async()=>{}})).found,1,'slices find the same gap');
  const open=await loadOpenGaps({},10,query);
  assert.deepEqual(open.map(g=>g.after_match_id),[id(9)]);
  const summary=await gapSummary({},query);
  assert.deepEqual([summary.total,summary.byStatus.open,summary.bySource.scan],[1,1,1]);
});

test('open gaps wait for their next attempt',async t=>{
  const {db,query}=database(t);
  await missedFive(db);
  assert.equal((await loadOpenGaps({},10,query)).length,1);
  await db.prepare("UPDATE rr_gaps SET status='incomplete',next_attempt_at='2999-01-01T00:00:00.000Z'").run();
  assert.equal((await loadOpenGaps({},10,query)).length,0);
});
