import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {collectRR,matchFeatures,saveFeatures} from '../lib/rr-corpus.mjs';
import {collectPlayers,corpusReport} from '../.github/scripts/collect-rr-corpus.mjs';
import {onRequestGet} from '../functions/api/[[path]].js';

const puuid='11111111-1111-4111-8111-111111111111',mid='22222222-2222-4222-8222-222222222222',season='33333333-3333-4333-8333-333333333333';
const entry=(id=mid)=>({match_id:id,date:'2026-10-03T00:00:00Z',last_change:20,tier:{id:12},rr:50,season:{id:season,short:'test'}});
const payload=history=>({data:{account:{puuid,name:'Alpha',tag:'EU'},history}});
const match=()=>({metadata:{match_id:mid,season:{id:season},started_at:entry().date,party_rr_penaltys:[{party_id:'party',penalty:0}]},
  players:[{puuid,team_id:'Red',party_id:'party',tier:{id:12},stats:{score:3000,kills:20,deaths:10}},{puuid:'other',team_id:'Blue',tier:{id:13},stats:{score:2000}}],
  teams:[{team_id:'Red',won:true,rounds:{won:13,lost:7}}]});
function database(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const s={bind(...v){values=v;return s;},async first(){return execute(true)[0]||null;},async all(){return {results:execute(true)};},async run(){return execute(false);}};
    function execute(rows){const statement=sql.prepare(query);const args=Object.fromEntries(values.map((v,i)=>['?'+(i+1),v]));return rows?statement.all(args):statement.run(args);}return s;},
    async batch(statements){sql.exec('BEGIN');try{for(const s of statements)await s.run();sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,db};
}
test('collector commits raw entries and witnessed predecessors, corrects existing IDs',async t=>{
  const {sql,db}=database(t),old={...entry('old'),date:'2026-10-02T00:00:00Z'};
  await collectRR(db,payload([entry(),old]),{puuid,region:'eu',platform:'pc'});
  assert.equal(sql.prepare('SELECT previous_match_id FROM rr_predecessors').get().previous_match_id,'old');
  await collectRR(db,payload([{...entry(),last_change:18},old]),{puuid,region:'eu',platform:'pc'});
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,2);
  assert.equal(JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get(mid).data).last_change,18);
  assert.equal(sql.prepare('SELECT checks FROM rr_collection').get().checks,2);
});
test('a non-overlapping full window is flagged, initial or empty windows are not',async t=>{
  const {db,sql}=database(t),scope={puuid,region:'eu',platform:'pc'};
  const windows=n=>Array.from({length:20},(_,i)=>({...entry(`${n}-${i}`),date:new Date(1790985600000+i*60000).toISOString()}));
  assert.equal((await collectRR(db,payload(windows(1)),scope)).possible_gap,false);
  assert.equal((await collectRR(db,payload(windows(2)),scope)).possible_gap,true);
  assert.equal((await collectRR(db,payload([]),scope)).possible_gap,false);
  assert.equal(sql.prepare('SELECT possible_gaps FROM rr_collection').get().possible_gaps,1);
});
test('wrong account or a failed batch never records a successful check',async t=>{
  const {db,sql}=database(t);
  await assert.rejects(collectRR(db,{data:{account:{puuid:'wrong'},history:[]}},{puuid,region:'eu',platform:'pc'}));
  await assert.rejects(collectRR({...db,batch:async()=>{throw new Error('storage full');}},payload([entry()]),{puuid,region:'eu',platform:'pc'}));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_collection').get().n,0);
});
test('compact evidence retains unknown party values, shields stay in raw payouts',async t=>{
  const {sql,db}=database(t),m=match();
  assert.equal(matchFeatures(m,puuid).party,1);assert.equal(matchFeatures(m,puuid).pen,0);
  delete m.players[0].party_id;
  delete m.metadata.party_rr_penaltys;
  assert.equal(matchFeatures(m,puuid).party,null);assert.equal(matchFeatures(m,puuid).pen,null);
  await saveFeatures(db,m,puuid);await saveFeatures(db,m,puuid);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_match_features').get().n,1);
});
test('sweep checks every account even when one fails and counts committed receipts',async()=>{
  const players=[1,2,3,4,5].map(n=>({puuid:String(n),region:'eu',platform:'pc'}));
  const result=await collectPlayers(players,{origin:'https://test',log:()=>{},fetchImpl:async url=>url.endsWith('/2')
    ?Response.json({}, {status:404}):Response.json({data:{puuid:url.split('/').at(-1),checked_at:'now'}})});
  assert.equal(result.checked,4);assert.equal(result.failures.length,1);
});
test('coverage SQL reports staleness using UTC timestamps and returns act sample counts',async t=>{
  const {db}=database(t);
  await collectRR(db,payload([entry()]),{puuid,region:'eu',platform:'pc'});
  const report=await corpusReport({},async(_env,query,params=[])=>{const s=db.prepare(query);return (await s.bind(...params).all()).results;});
  assert.equal(report.health.stale,0);assert.equal(report.ranks[0].payouts,1);
});
test('feature route reuses trusted archive; unknown RR IDs never call upstream',async t=>{
  const {db,sql}=database(t);await collectRR(db,payload([entry()]),{puuid,region:'eu',platform:'pc'});
  const bytes=await new Response(new Blob([JSON.stringify(match())]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  sql.prepare('INSERT INTO match_archive(puuid,match_id,season_id,payload) VALUES(?,?,?,?)').run(puuid,mid,season,new Uint8Array(bytes));
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No upstream needed');};t.after(()=>{globalThis.fetch=oldFetch;});
  const request=id=>onRequestGet({request:new Request(`https://test/api/rr-feature/eu/${puuid}/${id}`),env:{APP_DB:db},waitUntil(){}});
  assert.equal((await request(mid)).status,200);assert.equal((await request(season)).status,404);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_match_features').get().n,1);
});

test('collector bypasses edge cache, commits before receipt, and hides upstream quota',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches={default:{async match(){throw new Error('must not serve stale collection receipts');},async put(){throw new Error('must not cache receipt');}}};
  globalThis.fetch=async()=>Response.json(payload([entry()]),{headers:{'x-ratelimit-remaining':'55'}});
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const jobs=[];
  const response=await onRequestGet({request:new Request(`https://test/api/rr-collect/eu/pc/${puuid}`),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
  assert.equal(response.status,200);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,1);
  assert.equal(response.headers.get('x-ratelimit-remaining'),null);await Promise.all(jobs);
});

test('collector storage failure returns 503 instead of an apparent saved payout',async t=>{
  const {db}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches={default:{}};globalThis.fetch=async()=>Response.json(payload([entry()]));
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const jobs=[];
  const response=await onRequestGet({request:new Request(`https://test/api/rr-collect/eu/pc/${puuid}`),
    env:{APP_DB:{...db,batch:async()=>{throw new Error('D1 full');}},HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);assert.equal(response.status,503);
});
