import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {collectRR,matchFeatures,saveFeatures,trackRRAccount} from '../lib/rr-corpus.mjs';
import {collectPlayers,collectMatchFeatures,corpusReport} from '../.github/scripts/collect-rr-corpus.mjs';
import {onRequestGet} from '../functions/api/[[path]].js';
import {pollingPolicy,selectPollingPlayers,selectDiscoveryCandidates,discoverMatchPlayers,DISCOVERY_BAND_TARGET} from '../lib/rr-activity.mjs';
import {loadActivity,loadCandidates} from '../.github/scripts/rr-activity-query.mjs';
import {loadFeaturePlan} from '../.github/scripts/rr-feature-plan.mjs';

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

test('D1 feature plan skips saved evidence and prioritizes archives over upstream requests',async t=>{
  const {sql,db}=database(t);
  await collectRR(db,payload(['saved','archived','waiting','ready'].map(id=>entry(id))),{puuid,region:'eu',platform:'pc'});
  sql.prepare('INSERT INTO rr_match_features VALUES (?,?,?,?,?,?)').run(puuid,'saved',season,null,'{}',new Date().toISOString());
  sql.prepare('INSERT INTO match_archive VALUES (?,?,?,?,?)').run(puuid,season,'archived',null,new Uint8Array([1]));
  for(const id of ['archived','waiting'])sql.prepare('INSERT INTO rr_feature_retry VALUES (?,?,1,?)').run(puuid,id,'2099-01-01');
  sql.prepare('INSERT INTO rr_history VALUES (?,?,?,?)').run('unknown','no-region','{}',entry().date);
  const query=async(_env,text,params=[]) => (await db.prepare(text).bind(...params).all()).results;
  const plan=await loadFeaturePlan({},10,query);
  assert.deepEqual({...plan.inventory},{total:5,saved:1,missing:4,missingRegion:1,archived:1,waitingRetry:1});
  assert.deepEqual(plan.rows.map(r=>r.match_id),['archived','ready']);
  assert.equal(plan.rows[0].archived,1);
  assert.deepEqual((await loadFeaturePlan({},1,query)).rows.map(r=>r.match_id),['archived']);
  assert.deepEqual((await loadFeaturePlan({},0,query)).rows,[]);
});

test('empty D1 inventory reports zeros and no pending features',async t=>{
  const {db}=database(t);
  const query=async(_env,text,params=[]) => (await db.prepare(text).bind(...params).all()).results;
  const plan=await loadFeaturePlan({},10,query);
  assert.deepEqual({...plan.inventory},{total:0,saved:0,missing:0,missingRegion:0,archived:0,waitingRetry:0});
  assert.deepEqual(plan.rows,[]);
});
test('collector commits raw entries and witnessed predecessors, corrects existing IDs',async t=>{
  const {sql,db}=database(t),old={...entry('old'),date:'2026-10-02T00:00:00Z'};
  await collectRR(db,payload([entry(),old]),{puuid,region:'eu',platform:'pc'});
  assert.equal(sql.prepare('SELECT previous_match_id FROM rr_predecessors').get().previous_match_id,'old');
  await collectRR(db,payload([{...entry(),last_change:18},old]),{puuid,region:'eu',platform:'pc'});
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,2);
  assert.equal(JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get(mid).data).last_change,18);
  assert.equal(sql.prepare('SELECT checks FROM rr_collection').get().checks,2);
});

test('collector retains new competitive fields when a later response is missing them',async t=>{
  const {sql,db}=database(t),scope={puuid,region:'eu',platform:'pc'};
  await collectRR(db,payload([{...entry(),rr_performance_bonus:5,rr_penalty:.25,
    tier_before_update:{id:11},rr_before_update:95,is_placement_match:true}]),scope);
  await collectRR(db,payload([{...entry(),last_change:18,rr_performance_bonus:null}]),scope);
  let saved=JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get(mid).data);
  assert.equal(saved.rr_performance_bonus,5);
  assert.equal(saved.rr_penalty,.25);
  assert.equal(saved.rr_before_update,95);
  assert.equal(saved.last_change,18);
  await collectRR(db,payload([{...entry(),rr_performance_bonus:0,is_placement_match:false}]),scope);
  saved=JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get(mid).data);
  assert.equal(saved.rr_performance_bonus,0);
  assert.equal(saved.is_placement_match,false);
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

test('new-act placement windows preserve old payouts and never link RR across acts',async t=>{
  const {db,sql}=database(t),scope={puuid,region:'eu',platform:'pc'};
  const previous={...entry('old-act'),date:'2026-10-12T00:00:00Z'};
  const placement={...entry('placement'),date:'2026-10-13T00:00:00Z',is_placement_match:true,last_change:0,
    season:{id:'44444444-4444-4444-8444-444444444444',short:'new'}};
  const next={...placement,match_id:'new-game',date:'2026-10-13T01:00:00Z',last_change:18,is_placement_match:false};
  await collectRR(db,payload([previous]),scope);
  // Simulate the cross-act edge left by the previous collector.
  sql.prepare('INSERT INTO rr_predecessors VALUES(?,?,?)').run(puuid,'placement','old-act');
  await collectRR(db,payload([next,placement,previous]),scope);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,3);
  assert.equal(sql.prepare('SELECT previous_match_id FROM rr_predecessors WHERE match_id=?').get('placement'),undefined);
  assert.equal(sql.prepare('SELECT previous_match_id FROM rr_predecessors WHERE match_id=?').get('new-game').previous_match_id,'placement');
  assert.equal(JSON.parse(sql.prepare('SELECT data FROM rr_history WHERE match_id=?').get('placement').data).is_placement_match,true);
  await collectRR(db,payload([]),scope);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,3);
});

test('a full RR window uses a bounded number of D1 statements and commits atomically',async t=>{
  const {db,sql}=database(t);let prepares=0;
  const counted={...db,prepare(query){prepares++;return db.prepare(query);}};
  const history=Array.from({length:20},(_,i)=>({...entry(`game-${i}`),date:new Date(Date.parse(entry().date)+i*60000).toISOString()}));
  await collectRR(counted,payload(history),{puuid,region:'eu',platform:'pc'});
  assert.ok(prepares<=8,`${prepares} statements leave headroom for the proxy quota gate`);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,20);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_predecessors').get().n,19);
  await collectRR(db,payload(history.slice(1)),{puuid,region:'eu',platform:'pc'});
  assert.equal(sql.prepare('SELECT previous_match_id FROM rr_predecessors WHERE match_id=?').get('game-1').previous_match_id,'game-0',
    'sliding windows retain previously witnessed same-act predecessors');
});

test('a new season reassesses inactive players once, without turning searches into activity',async t=>{
  const now=Date.now(),iso=hours=>new Date(now-hours*3600000).toISOString();
  const player={puuid,platform:'pc',checked_at:iso(48),last_played_at:iso(240),games_7d:0,season_started_at:iso(24)};
  assert.equal(pollingPolicy(player,now).cohort,'season-assessment');
  assert.equal(selectPollingPlayers([player],now).length,1);
  assert.equal(pollingPolicy({...player,checked_at:iso(1)},now).cohort,'dormant');
  const {db}=database(t);
  await collectRR(db,payload([{...entry(),date:iso(240)}]),{puuid,region:'eu',platform:'pc'},iso(48));
  const other='55555555-5555-4555-8555-555555555555';
  await collectRR(db,{data:{account:{puuid:other},history:[{...entry('season-start'),date:iso(24),season:{id:'new-act',short:'new'}}]}},
    {puuid:other,region:'eu',platform:'pc'});
  const query=async(_env,text,params=[]) => (await db.prepare(text).bind(...params).all()).results;
  const rows=await loadActivity({},[{puuid,platform:'pc'}],query);
  assert.equal(rows[0].season_started_at,iso(24));
  assert.equal(pollingPolicy(rows[0],now).cohort,'season-assessment');
});

test('new-act Unrated placement rosters still supply trusted competitive discovery',async t=>{
  const {db,sql}=database(t),other='55555555-5555-4555-8555-555555555555';
  const stamp=new Date().toISOString();
  const record={metadata:{match_id:mid,started_at:stamp,queue:{id:'competitive'}},players:[{puuid:other,tier:{id:0}}]};
  assert.equal(await discoverMatchPlayers(db,record,{puuid,region:'eu',platform:'pc'},stamp),1);
  assert.equal(sql.prepare('SELECT tier FROM rr_candidate_games').get().tier,0);
  record.metadata.match_id='unranked';record.metadata.queue.id='unrated';
  assert.equal(await discoverMatchPlayers(db,record,{puuid,region:'eu',platform:'pc'},stamp),0);
});

test('run deadlines preserve unattempted capture and enrichment as deferred work',async()=>{
  const players=[1,2,3].map(n=>({puuid:String(n),region:'eu',platform:'pc',match_id:String(n)}));
  let now=0,calls=0;
  const refresh=await collectPlayers(players,{origin:'https://test',log:()=>{},concurrency:1,deadline:1,now:()=>now,
    fetchImpl:async url=>{calls++;now=1;return Response.json({data:{puuid:url.split('/').at(-1),checked_at:'now'}});}});
  assert.equal(calls,1);assert.equal(refresh.checked,1);assert.equal(refresh.deferred,2);assert.equal(refresh.failures.length,0);
  const features=await collectMatchFeatures(players,{origin:'https://test',deadline:1,now:()=>now,fetchImpl:()=>{throw new Error('budget exhausted');}});
  assert.equal(features.budgetDeferred,3);assert.equal(features.failed,0);
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
test('sweep checks every account and reports confirmed unavailable accounts separately',async()=>{
  const players=[1,2,3,4,5].map(n=>({puuid:String(n),region:'eu',platform:'pc'}));
  const result=await collectPlayers(players,{origin:'https://test',log:()=>{},fetchImpl:async url=>url.endsWith('/2')
    ?Response.json({}, {status:404}):Response.json({data:{puuid:url.split('/').at(-1),checked_at:'now'}})});
  assert.equal(result.checked,4);assert.equal(result.failures.length,0);
  assert.equal(result.unavailable.length,1);assert.equal(result.deferred,0);
});

test('404 re-resolves the immutable account and collects a transferred Brazilian account',async t=>{
  const {sql,db}=database(t),calls=[];
  await collectRR(db,payload([entry('old-na-match')]),{puuid,region:'na',platform:'pc'});
  const result=await collectPlayers([{puuid,region:'na',platform:'pc'}],{origin:'https://test',log:()=>{},fetchImpl:async url=>{
    calls.push(url);
    if(url.includes('/rr-collect/na/'))return Response.json({}, {status:404});
    if(url.includes('/account-by-puuid/'))return Response.json({data:{puuid,region:'br'}});
    assert.ok(url.includes('/rr-collect/br/pc/'));
    return Response.json({data:await collectRR(db,payload([entry('new-br-match')]),{puuid,region:'br',platform:'pc'})});
  }});
  assert.equal(calls.length,3);assert.equal(result.checked,1);assert.equal(result.failures.length,0);
  assert.equal(sql.prepare('SELECT region FROM rr_players').get().region,'br');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,2);
});

test('unchanged or still unavailable regions stop after one account check and one bounded retry',async()=>{
  for(const fresh of ['na','br']){
    const calls=[];
    const result=await collectPlayers([{puuid,region:'na',platform:'pc'}],{origin:'https://test',log:()=>{},fetchImpl:async url=>{
      calls.push(url);
      return url.includes('/account-by-puuid/')?Response.json({data:{puuid,region:fresh}}):Response.json({}, {status:404});
    }});
    assert.equal(calls.length,fresh==='na'?2:3);
    assert.equal(result.checked,0);assert.equal(result.failures.length,0);
    assert.equal(result.unavailable.length,1);assert.equal(result.deferred,0);
  }
});

test('region recovery rejects a mismatched PUUID and preserves transient failures',async()=>{
  for(const response of [()=>Response.json({data:{puuid:mid,region:'br'}}),()=>Response.json({}, {status:503})]){
    const result=await collectPlayers([{puuid,region:'na',platform:'pc'}],{origin:'https://test',log:()=>{},retryPass:false,sleepImpl:async()=>{},
      fetchImpl:async url=>url.includes('/account-by-puuid/')?response():Response.json({}, {status:404})});
    assert.equal(result.failures.length,1);assert.equal(result.unavailable.length,0);assert.equal(result.checked,0);
  }
});

test('D1 failed probe survives runs, applies a one-day cooldown and clears after successful collection',async t=>{
  const {db,sql}=database(t),now=Date.now(),iso=h=>new Date(now-h*3600000).toISOString();
  await collectRR(db,payload([{...entry(),date:iso(240)}]),{puuid,region:'na',platform:'pc'},iso(48));
  sql.prepare('INSERT INTO rr_candidate_checks VALUES (?,?,?)').run(puuid,'pc',iso(1));
  const query=async(_env,text,params=[]) => (await db.prepare(text).bind(...params).all()).results;
  const [player]=await loadActivity({},[{puuid,platform:'pc'}],query);
  assert.equal(pollingPolicy(player,now).cohort,'region-recheck');
  assert.equal(pollingPolicy(player,now).due,false);
  assert.equal(pollingPolicy(player,now+24*3600000).due,true);
  assert.equal(pollingPolicy({...player,candidate_observed_at:iso(.5),candidate_played_at:iso(.5)},now).due,true);
  assert.equal(pollingPolicy({...player,checked_at:iso(0)},now).cohort,'dormant');
  const report=await corpusReport({},query);
  assert.equal(report.health.stale,0);
});

test('transient capture failures get one final retry before optional enrichment',async()=>{
  let calls=0;
  const result=await collectPlayers([{puuid,region:'eu',platform:'pc'}],{origin:'https://test',log:()=>{},
    sleepImpl:async()=>{},
    fetchImpl:async()=>{
      if(++calls<=3)return Response.json({}, {status:503});
      return Response.json({data:{puuid,checked_at:'now'}});
    }});
  assert.equal(result.checked,1);assert.equal(result.failures.length,0);
  assert.equal(calls,4);
});
test('coverage SQL reports staleness using UTC timestamps and returns act sample counts',async t=>{
  const {db}=database(t);
  await collectRR(db,payload([entry()]),{puuid,region:'eu',platform:'pc'});
  const report=await corpusReport({},async(_env,query,params=[])=>{const s=db.prepare(query);return (await s.bind(...params).all()).results;});
  assert.equal(report.health.stale,0);assert.equal(report.ranks[0].payouts,1);
  assert.equal(report.competitiveUpdates.bonus_known,0);
  await collectRR(db,payload([{...entry(),tier_before_update:{id:12},rr_before_update:30,
    rr_performance_bonus:0,afk_penalty:0,rr_penalty:.25,is_placement_match:false}]),{puuid,region:'eu',platform:'pc'});
  const enriched=await corpusReport({},async(_env,query,params=[])=>{const s=db.prepare(query);return (await s.bind(...params).all()).results;});
  assert.equal(enriched.competitiveUpdates.reported_start,1);
  assert.equal(enriched.competitiveUpdates.bonus_known,1);
  assert.equal(enriched.competitiveUpdates.bonus_nonzero,0);
  assert.equal(enriched.competitiveUpdates.afk_penalty_known,1);
  assert.equal(enriched.competitiveUpdates.rr_penalty_known,1);
  assert.equal(enriched.competitiveUpdates.map_forgiveness_known,0);
  assert.equal(enriched.competitiveUpdates.placement_known,1);
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

test('profile account lookups enrol visitors on cache misses and hits without ranked games',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  const account={puuid,name:'Alpha',tag:'EU',region:'eu'};
  let upstreamCalls=0,cached=false;
  globalThis.caches={default:{async match(){return cached?Response.json({data:account}):null;},async put(){}}};
  globalThis.fetch=async()=>{upstreamCalls++;return Response.json({data:account});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  for(const path of ['account/Alpha/EU',`account-by-puuid/${puuid}`]){
    const jobs=[];
    const response=await onRequestGet({request:new Request(`https://test/api/${path}`),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
    assert.equal(response.status,200);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_players').get().n,1);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,0);
    await Promise.all(jobs);
    sql.exec('DELETE FROM rr_players');cached=true;
  }
  assert.equal(upstreamCalls,1);
});

test('current PUUID identities retire old cache keys and share a five-minute forced refresh',async t=>{
  const {db}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  let saved=null,calls=0;
  globalThis.caches={default:{
    async match(key){
      const url=new URL(key.url);
      assert.equal(url.pathname,`/api/account-by-puuid/${puuid}`);
      assert.equal(url.search,'?_identity=current-v1');
      return saved?.clone()||null;
    },
    async put(_key,response){
      assert.equal(response.headers.get('Cache-Control'),'public, max-age=300');
      saved=response.clone();
    },
  }};
  globalThis.fetch=async url=>{
    calls++;
    assert.equal(String(url),`https://api.henrikdev.xyz/valorant/v1/by-puuid/account/${puuid}?force=true`);
    return Response.json({data:{puuid,name:'Renamed',tag:'NEW',region:'eu'}},{headers:{'x-ratelimit-remaining':'55'}});
  };
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  for(const suffix of [puuid,`${puuid.toUpperCase()}?force=false&random=123`]){
    const jobs=[];
    const response=await onRequestGet({request:new Request(`https://test/api/account-by-puuid/${suffix}`),
      env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
    assert.equal(response.status,200);
    assert.equal((await response.json()).data.name,'Renamed');
    assert.equal(response.headers.get('x-ratelimit-remaining'),null);
    await Promise.all(jobs);
  }
  assert.equal(calls,1);
});

test('cached account enrolment cannot overwrite a newer identity or invent ranked activity',async t=>{
  const {db,sql}=database(t);
  await trackRRAccount(db,{puuid:puuid.toUpperCase(),name:'Current',tag:'NEW',region:'eu'});
  const original=sql.prepare('SELECT * FROM rr_players').get();
  await trackRRAccount(db,{puuid,name:'Old',tag:'OLD',region:'na'});
  assert.deepEqual(sql.prepare('SELECT * FROM rr_players').get(),original);
  const query=async(_env,query,params=[])=>{const s=db.prepare(query);return (await s.bind(...params).all()).results;};
  const [player]=await loadActivity({},[{puuid,region:'eu',platform:null}],query);
  assert.equal(player.games_7d,0);assert.equal(player.last_played_at,null);
  assert.equal(pollingPolicy(player).due,true);
});

test('public RR lookups atomically collect fresh windows and return all previously saved payouts',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  const earlier={...entry('earlier'),date:'2026-10-01T00:00:00Z'};
  await collectRR(db,payload([earlier]),{puuid,region:'eu',platform:'pc'});
  let fresh=[{...entry(),rr_performance_bonus:5,rr_penalty:.25,tier_before_update:{id:12},rr_before_update:30},
    {...entry('previous'),date:'2026-10-02T00:00:00Z'}];
  let cachedResponse=null,cachePuts=0,upstreamCalls=0;
  globalThis.caches={default:{async match(){return null;},async put(_key,response){cachePuts++;cachedResponse=response.clone();}}};
  globalThis.fetch=async url=>{assert.equal(new URL(url).origin,'https://api.henrikdev.xyz');upstreamCalls++;return Response.json(payload(fresh),{headers:{'x-ratelimit-remaining':'55'}});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  for(const path of ['mmr-history/eu/pc/Alpha/EU',`mmr-history-by-puuid/eu/pc/${puuid}`]){
    const jobs=[];
    const response=await onRequestGet({request:new Request(`https://test/api/${path}`),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
    assert.equal(response.status,200);assert.equal(response.headers.get('x-ratelimit-remaining'),null);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,3);
    assert.equal(sql.prepare('SELECT previous_match_id FROM rr_predecessors WHERE match_id=?').get(mid).previous_match_id,'previous');
    // The older database neighbour was not witnessed in this upstream window.
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_predecessors WHERE match_id=?').get('previous').n,0);
    const returned=(await response.json()).data.history;
    assert.deepEqual(returned.map(h=>h.match_id),[mid,'previous','earlier']);
    assert.equal(returned[0].rr_performance_bonus,5);
    assert.equal(returned[0].rr_penalty,.25);
    assert.equal(returned[0].rr_before_update,30);
    fresh=fresh.map(h=>({...h,rr_performance_bonus:null,rr_penalty:null,rr_before_update:null}));
    await Promise.all(jobs);
  }
  assert.equal(sql.prepare('SELECT checks FROM rr_collection').get().checks,3);
  // An accumulated cached response is display data, not a new rolling window.
  globalThis.caches.default.match=async()=>cachedResponse.clone();
  const response=await onRequestGet({request:new Request('https://test/api/mmr-history/eu/pc/Alpha/EU'),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil(){}});
  assert.equal(response.status,200);assert.equal(upstreamCalls,2);assert.equal(cachePuts,2);
  assert.equal(sql.prepare('SELECT checks FROM rr_collection').get().checks,3);
});

test('empty public RR windows enrol accounts and checkpoint successful checks',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches={default:{async match(){return null;},async put(){}}};globalThis.fetch=async()=>Response.json(payload([]));
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const jobs=[];
  const response=await onRequestGet({request:new Request('https://test/api/mmr-history/eu/console/Alpha/EU'),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
  assert.equal(response.status,200);assert.equal(sql.prepare('SELECT platform FROM rr_players').get().platform,'console');
  assert.equal(sql.prepare('SELECT checks FROM rr_collection').get().checks,1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,0);await Promise.all(jobs);
});

test('profile persistence failures return 503 without caching success or committing partial RR',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;let cachePuts=0;
  globalThis.caches={default:{async match(){return null;},async put(){cachePuts++;}}};
  globalThis.fetch=async url=>url.includes('/account/')?Response.json({data:{puuid,name:'Alpha',tag:'EU',region:'eu'}}):Response.json(payload([entry()]));
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const broken={...db,prepare(query){if(query.startsWith('INSERT OR IGNORE INTO rr_players'))throw new Error('storage full');return db.prepare(query);},
    async batch(){throw new Error('storage full');}};
  for(const path of ['account/Alpha/EU','mmr-history/eu/pc/Alpha/EU']){
    const jobs=[];
    const response=await onRequestGet({request:new Request(`https://test/api/${path}`),env:{APP_DB:broken,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
    assert.equal(response.status,503);await Promise.all(jobs);
  }
  assert.equal(cachePuts,0);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_players').get().n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_collection').get().n,0);
});

test('public PUUID lookup rejects mismatched upstream identity before saving evidence',async t=>{
  const {db,sql}=database(t),oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches={default:{async match(){return null;},async put(){throw new Error('must not cache');}}};
  globalThis.fetch=async()=>Response.json(payload([entry()]));
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const jobs=[];
  const response=await onRequestGet({request:new Request(`https://test/api/mmr-history-by-puuid/eu/pc/${season}`),env:{APP_DB:db,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
  assert.equal(response.status,503);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n,0);await Promise.all(jobs);
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
  assert.deepEqual(result,{saved:1,deferred:1,failed:1,budgetDeferred:0});
  assert.ok(logs.some(s=>s.includes('Detail deferred')&&s.includes('RR retained')));
  assert.ok(logs.some(s=>s.includes('Detail FAILED')));
});

test('activity policy polls before a 20-game window can roll over: 6/8/24/72-hour intervals',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z'),ago=h=>new Date(now-h*3600000).toISOString();
  const player={puuid,last_played_at:ago(1),checked_at:ago(7),games_7d:12};
  assert.deepEqual([pollingPolicy(player,now).cohort,pollingPolicy(player,now).intervalHours],['frequent',6]);
  assert.equal(pollingPolicy(player,now).due,true);
  assert.equal(pollingPolicy({...player,checked_at:ago(5)},now).due,false);
  // Anyone who played in the last week is polled every 8 hours, however few games.
  for(const games_7d of [1,4,9])assert.deepEqual([pollingPolicy({...player,games_7d},now).cohort,pollingPolicy({...player,games_7d},now).intervalHours],['active',8]);
  assert.equal(pollingPolicy({...player,games_7d:1,last_played_at:ago(150)},now).intervalHours,8);
  // Quiet accounts are still checked so a return from a break is noticed.
  const dormant={...player,last_played_at:ago(200)};
  assert.deepEqual([pollingPolicy(dormant,now).cohort,pollingPolicy(dormant,now).intervalHours],['dormant',24]);
  assert.equal(pollingPolicy(dormant,now).due,false);
  assert.equal(pollingPolicy({...dormant,checked_at:ago(25)},now).due,true);
  const old={...player,last_played_at:ago(40*24)};
  assert.deepEqual([pollingPolicy(old,now).cohort,pollingPolicy(old,now).intervalHours],['inactive',72]);
  assert.equal(pollingPolicy({...old,checked_at:ago(71)},now).due,false);
  assert.equal(pollingPolicy({...old,checked_at:ago(73)},now).due,true);
  assert.equal(pollingPolicy({...player,last_played_at:null},now).due,false);
  assert.equal(pollingPolicy({...player,last_played_at:null,checked_at:ago(73)},now).due,true);
  assert.equal(pollingPolicy({puuid},now).due,true);
  assert.equal(selectPollingPlayers([dormant,player],now).length,1);
});

test('polling selection has no count cap; the run deadline bounds capture',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const players=Array.from({length:2500},(_,i)=>({puuid:`p${i}`,games_7d:12,last_played_at:'2026-10-03T10:00:00Z',checked_at:'2026-10-03T01:00:00Z'}));
  assert.equal(selectPollingPlayers(players,now).length,2500);
  assert.equal(selectPollingPlayers(players,now,10).length,10);
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
  const players=[{...base,puuid:'known',tier:24,games_7d:12}];
  const chosen=selectDiscoveryCandidates(candidates,players,2,now);
  assert.deepEqual(chosen.map(p=>p.puuid),['strong','weak']);
  assert.equal(selectDiscoveryCandidates(candidates,players,25,now).some(p=>p.puuid==='known'),false);
});

test('discovery balances rank bands by frequent players and stops at the band target',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const recent={platform:'pc',last_played_at:'2026-10-03T00:00:00Z'};
  // Many casual Iron players do not count as coverage; one frequent Radiant player does.
  const players=[...Array.from({length:30},(_,i)=>({...recent,puuid:`casual${i}`,tier:4,games_7d:2})),
    {...recent,puuid:'grinder',tier:27,games_7d:30}];
  const candidates=[{...recent,puuid:'iron',tier:4,games_7d:6},{...recent,puuid:'radiant',tier:27,games_7d:9}];
  assert.deepEqual(selectDiscoveryCandidates(candidates,players,1,now).map(p=>p.puuid),['iron']);
  // A band at the target draws no probes, even when nothing else is left.
  const full=Array.from({length:DISCOVERY_BAND_TARGET},(_,i)=>({...recent,puuid:`imm${i}`,tier:25,games_7d:15}));
  assert.deepEqual(selectDiscoveryCandidates([{...recent,puuid:'imm-new',tier:25,games_7d:20}],full,40,now),[]);
  // A band reaching the target mid-selection stops there.
  const almost=full.slice(1);
  const many=Array.from({length:5},(_,i)=>({...recent,puuid:`imm-new${i}`,tier:25,games_7d:10+i}));
  assert.equal(selectDiscoveryCandidates(many,almost,40,now).length,1);
  assert.equal(selectDiscoveryCandidates(many.map(p=>({...p,tier:6})),almost,40,now).length,5);
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
