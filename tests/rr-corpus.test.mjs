import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {collectRR,matchFeatures,saveFeatures} from '../lib/rr-corpus.mjs';
import {collectPlayers,collectMatchFeatures,corpusReport} from '../.github/scripts/collect-rr-corpus.mjs';
import {onRequestGet} from '../functions/api/[[path]].js';
import {pollingPolicy,selectPollingPlayers,selectDiscoveryCandidates,discoverMatchPlayers} from '../lib/rr-activity.mjs';
import {loadActivity,loadCandidates} from '../.github/scripts/rr-activity-query.mjs';

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

test('upstream missing match returns a durable deferred receipt; repeat calls respect cooldown and retain RR',async t=>{
  const {db,sql}=database(t);
  await collectRR(db,payload([entry()]),{puuid,region:'eu',platform:'pc'});
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;let calls=0;
  globalThis.caches={default:{}};
  globalThis.fetch=async()=>{calls++;return Response.json({errors:[{code:26,message:'Match not found'}]},{status:404});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  async function request(){const jobs=[];const response=await onRequestGet({request:new Request(`https://test/api/rr-feature/eu/${puuid}/${mid}`),
    env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);return response;}
  const first=await request();assert.equal(first.status,200);assert.equal((await first.json()).data.deferred,true);
  const second=await request();assert.equal((await second.json()).data.saved,false);assert.equal(calls,1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,1);
  assert.equal(sql.prepare('SELECT attempts FROM rr_feature_retry').get().attempts,1);
  // Once due again, repeated upstream absence backs off to three days.
  sql.prepare("UPDATE rr_feature_retry SET next_attempt_at=datetime('now','-1 minute')").run();
  await request();assert.equal(calls,2);
  assert.equal(sql.prepare('SELECT attempts FROM rr_feature_retry').get().attempts,2);
  assert.ok(sql.prepare("SELECT julianday(next_attempt_at)-julianday('now') AS days FROM rr_feature_retry").get().days>2.99);
});

test('a failure to persist the missing-match retry remains an actual storage error',async t=>{
  const {db}=database(t);await collectRR(db,payload([entry()]),{puuid,region:'eu',platform:'pc'});
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches={default:{}};globalThis.fetch=async()=>Response.json({}, {status:404});
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const broken={...db,prepare(query){if(query.startsWith('INSERT INTO rr_feature_retry'))throw new Error('storage full');return db.prepare(query);}};
  const jobs=[];
  const response=await onRequestGet({request:new Request(`https://test/api/rr-feature/eu/${puuid}/${mid}`),
    env:{APP_DB:broken,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);assert.equal(response.status,503);
});

test('feature sweep separates saved details, upstream deferrals and malformed errors',async()=>{
  const rows=['saved','deferred','invalid'].map(match_id=>({puuid,region:'eu',match_id}));
  const logs=[];
  const result=await collectMatchFeatures(rows,{origin:'https://test',log:s=>logs.push(s),fetchImpl:async url=>{
    const id=new URL(url).pathname.split('/').at(-1);
    return Response.json({data:{puuid,match_id:id,saved:id==='saved',
      ...(id==='deferred'?{deferred:true,reason:'upstream_match_not_found',retry_at:'2030-01-01 00:00:00'}:{})}});
  }});
  assert.deepEqual(result,{saved:1,deferred:1,failed:1});
  assert.ok(logs.some(s=>s.includes('Detail deferred')&&s.includes('RR retained')));
  assert.ok(logs.some(s=>s.includes('Detail FAILED')));
});

test('activity policy stops inactive accounts and assigns 4/12/24-hour intervals',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z'),ago=h=>new Date(now-h*3600000).toISOString();
  const player={puuid,last_played_at:ago(1),checked_at:ago(5),games_7d:12};
  assert.equal(pollingPolicy(player,now).intervalHours,4);assert.equal(pollingPolicy(player,now).due,true);
  assert.equal(pollingPolicy({...player,games_7d:4},now).intervalHours,12);
  assert.equal(pollingPolicy({...player,games_7d:1},now).intervalHours,24);
  assert.equal(pollingPolicy({...player,last_played_at:ago(200)},now).due,false);
  assert.equal(pollingPolicy({...player,last_played_at:null},now).due,false);
  assert.equal(pollingPolicy({puuid},now).due,true);
  assert.equal(selectPollingPlayers([{...player,last_played_at:ago(200)},player],now).length,1);
});

test('a paused account wakes once for a newly observed recent roster match',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const player={puuid,last_played_at:'2026-09-01',checked_at:'2026-10-03T05:00:00Z',
    candidate_played_at:'2026-10-03T04:00:00Z',candidate_observed_at:'2026-10-03T10:00:00Z'};
  assert.equal(pollingPolicy(player,now).due,true);
  assert.equal(pollingPolicy({...player,checked_at:'2026-10-03T11:00:00Z'},now).due,false);
});

test('bounded polling favors relative overdue time so active cohorts cannot starve each other',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const players=[{puuid:'frequent',games_7d:20,last_played_at:'2026-10-03T01:00:00Z',checked_at:'2026-10-03T07:00:00Z'},
    {puuid:'occasional',games_7d:1,last_played_at:'2026-10-01T01:00:00Z',checked_at:'2026-10-01T01:00:00Z'}];
  assert.equal(selectPollingPlayers(players,now,1)[0].puuid,'occasional');
});

test('discovery prioritizes activity within thin rank bands and bounds probes',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const base={platform:'pc',last_played_at:'2026-10-03T00:00:00Z',games_7d:5};
  const candidates=[{...base,puuid:'weak',tier:3,games_7d:1},{...base,puuid:'strong',tier:3,games_7d:4},
    {...base,puuid:'high',tier:24,games_7d:20},{...base,puuid:'known',tier:24}];
  const players=[{...base,puuid:'known',tier:24}];
  const chosen=selectDiscoveryCandidates(candidates,players,2,now);
  assert.deepEqual(chosen.map(p=>p.puuid),['strong','weak']);
  assert.equal(selectDiscoveryCandidates(candidates,players,25,now).some(p=>p.puuid==='known'),false);
});

test('trusted roster evidence deduplicates fetches and ignores stale matches',async t=>{
  const {db,sql}=database(t),m=match();
  const opponent='44444444-4444-4444-8444-444444444444';m.players[1].puuid=opponent;
  await discoverMatchPlayers(db,m,{puuid,region:'eu',platform:'pc'},'2026-10-03T12:00:00Z');
  await discoverMatchPlayers(db,m,{puuid,region:'eu',platform:'pc'},'2026-10-03T13:00:00Z');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_candidate_games').get().n,1);
  assert.equal(sql.prepare('SELECT observed_at FROM rr_candidate_games').get().observed_at,'2026-10-03T12:00:00Z');
  assert.equal(await discoverMatchPlayers(db,m,{puuid,region:'eu',platform:'pc'},'2026-10-10T00:00:00Z'),0);
});

test('activity queries see durable latest RR, count unique candidate games, and honor failed probe cooldown',async t=>{
  const {db,sql}=database(t);
  const fresh={...entry(),date:new Date().toISOString()};
  await collectRR(db,payload([fresh]),{puuid,region:'eu',platform:'pc'});
  const query=async(_env,query,params=[])=>{const s=db.prepare(query);return (await s.bind(...params).all()).results;};
  const rows=await loadActivity({},[{puuid,region:'eu',platform:'pc'}],query);
  assert.equal(rows[0].games_7d,1);assert.equal(rows[0].tier,12);
  const m=match();m.metadata.started_at=fresh.date;m.players[1].puuid='44444444-4444-4444-8444-444444444444';
  await discoverMatchPlayers(db,m,{puuid,region:'eu',platform:'pc'});
  assert.equal((await loadCandidates({},query))[0].games_7d,1);
  sql.prepare('INSERT INTO rr_candidate_checks VALUES(?,?,?)').run(m.players[1].puuid,'pc',new Date().toISOString());
  assert.deepEqual(await loadCandidates({},query),[]);
});
