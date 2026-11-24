import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestGet} from '../functions/api/[[path]].js';
import {PUBLIC_BORROW_RESERVE,PUBLIC_PROFILE_RESERVE} from '../lib/upstream-pacing.mjs';
import {createRequestScheduler} from '../.github/scripts/request-scheduler.mjs';
import {main as refresh,requestJSON,createStorageBreaker} from '../.github/scripts/refresh-rr-history.mjs';
import {assertD1Headroom} from '../.github/scripts/d1-query.mjs';
import {rowidRanges,migrateRange} from '../.github/scripts/migrate-match-archive.mjs';
import {main as collect,collectPlayers} from '../.github/scripts/collect-rr-corpus.mjs';
import {main as backfill} from '../.github/scripts/backfill-all-names.mjs';

const origin='https://site.test',url=origin+'/api/rank/eu/pc/Alpha/EU';
const publicKey='HDEV-public-fixture',workflowKey='HDEV-workflow-fixture';
function fixture(t){
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const APP_DB={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async all(){return {results:sql.prepare(query).all(...values)};},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  const env={APP_DB,HENRIK_KEY:publicKey,HENRIK_WORKFLOW_KEY:workflowKey};
  const upstream=[],cacheReads=[],cacheWrites=[];
  const oldCaches=globalThis.caches;
  globalThis.caches={default:{async match(key){cacheReads.push(key);return null;},async put(key){cacheWrites.push(key);}}};
  t.after(()=>{if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;});
  const f={respond:()=>Response.json({data:{}},{headers:{'x-ratelimit-remaining':'7','x-ratelimit-reset':'60'}})};
  t.mock.method(globalThis,'fetch',async (target,options)=>{
    upstream.push({target,options});
    return f.respond(target,options);
  });
  async function request(key,target=url,headers={}){
    const jobs=[];
    const response=await onRequestGet({env,request:new Request(target,{headers:key===undefined?headers:{...headers,'X-Workflow-Key':key}}),waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs);return response;
  }
  return Object.assign(f,{sql,env,upstream,cacheReads,cacheWrites,request});
}

test('authenticated workflows use the dedicated upstream key, bypass caches, and cannot change public quota',async t=>{
  const f=fixture(t);
  f.sql.prepare('UPDATE rate_quota SET remaining=0,reset_at=? WHERE id=1').run(Date.now()+60000);
  const response=await f.request(workflowKey);
  assert.equal(response.status,200);
  assert.equal(f.upstream[0].options.headers.Authorization,workflowKey);
  assert.equal(f.upstream[0].options.headers['X-Workflow-Key'],undefined);
  assert.equal(f.cacheReads.length,0);assert.equal(f.cacheWrites.length,0);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('X-Workflow-Pacing'),'upstream-v1');
  assert.equal(response.headers.get('x-ratelimit-remaining'),null);
  assert.equal(f.sql.prepare('SELECT remaining FROM rate_quota').get().remaining,0);
  assert.equal(f.sql.prepare('SELECT remaining FROM workflow_rate_quota').get().remaining,7);
});

test('public requests retain their key and cache even if workflow quota is exhausted',async t=>{
  const f=fixture(t);
  f.sql.prepare('INSERT INTO workflow_rate_quota (id,remaining,reset_at,last_request_at) VALUES(1,0,?,0)').run(Date.now()+60000);
  const response=await f.request();
  assert.equal(response.status,200);
  assert.equal(f.upstream[0].options.headers.Authorization,publicKey);
  assert.equal(f.cacheReads.length,1);assert.equal(f.cacheWrites.length,1);
  assert.equal(f.cacheReads[0].headers.get('X-Workflow-Key'),null);
  assert.equal(f.sql.prepare('SELECT remaining FROM workflow_rate_quota').get().remaining,0);
  assert.equal(f.sql.prepare('SELECT remaining FROM rate_quota').get().remaining,7);
});

test('public cache hits and D1-only routes bypass exhausted quota without advancing its slot',async t=>{
  const f=fixture(t);
  f.sql.prepare('UPDATE rate_quota SET remaining=0,reset_at=?,next_start_at=?').run(Date.now()+60000,Date.now()+30000);
  const before=f.sql.prepare('SELECT * FROM rate_quota').get();
  globalThis.caches.default.match=async()=>Response.json({data:{cached:true}});
  const cached=await f.request();
  assert.equal(cached.status,200);assert.equal(cached.headers.get('X-Proxy-Cache'),'HIT');
  assert.equal((await f.request(undefined,origin+'/api/calib-model')).status,200);
  assert.deepEqual(f.sql.prepare('SELECT * FROM rate_quota').get(),before);
  assert.equal(f.upstream.length,0);
});

test('public exhaustion and failed gate storage never issue an upstream request',async t=>{
  const f=fixture(t);
  f.sql.prepare('UPDATE rate_quota SET remaining=0,reset_at=?').run(Date.now()+60000);
  const response=await f.request(),body=await response.json();
  assert.equal(response.status,429);assert.ok(body.retryAfterMs>0);
  assert.deepEqual(Object.keys(body).sort(),['error','retryAfterMs']);
  assert.equal(response.headers.get('ratelimit'),null);
  f.env.APP_DB={prepare(){throw new Error('D1 unavailable');}};
  assert.equal((await f.request()).status,503);
  assert.equal(f.upstream.length,0);
});

test('real public 429 with HTTP-date Retry-After pauses only the public pool and hides headers',async t=>{
  const f=fixture(t);const retryAt=Math.ceil(Date.now()/1000)*1000+90000;
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:'upstream'},
    {status:429,headers:{'Retry-After':new Date(retryAt).toUTCString(),'x-ratelimit-remaining':'0'}}));
  const response=await f.request(),body=await response.json();
  assert.equal(response.status,429);assert.ok(body.retryAfterMs>85000);
  for(const header of ['ratelimit','x-ratelimit-remaining','x-ratelimit-reset','retry-after'])assert.equal(response.headers.get(header),null);
  assert.equal(f.sql.prepare('SELECT remaining,reset_at FROM rate_quota').get().reset_at,retryAt);
  assert.equal(f.sql.prepare('SELECT * FROM workflow_rate_quota').get(),undefined);
});

test('exhausted workflow quota with no idle site slot returns only retryAfterMs without contacting upstream',async t=>{
  const f=fixture(t);
  f.sql.prepare('INSERT INTO workflow_rate_quota (id,remaining,reset_at,last_request_at) VALUES(1,0,?,0)').run(Date.now()+60000);
  f.sql.prepare('UPDATE rate_quota SET remaining=?,reset_at=? WHERE id=1').run(PUBLIC_BORROW_RESERVE-1,Date.now()+60000);
  const response=await f.request(workflowKey),body=await response.json();
  assert.equal(response.status,429);assert.ok(body.retryAfterMs>0);
  assert.deepEqual(Object.keys(body).sort(),['error','retryAfterMs']);
  assert.equal(response.headers.get('x-ratelimit-remaining'),null);
  assert.equal(f.upstream.length,0);
});

test('a busy workflow pool borrows an idle site-key slot through the public schedule',async t=>{
  const f=fixture(t);
  f.sql.prepare('INSERT INTO workflow_rate_quota VALUES(1,NULL,0,0,?)').run(Date.now()+60000);
  const workflowBefore=f.sql.prepare('SELECT * FROM workflow_rate_quota').get();
  const response=await f.request(workflowKey);
  assert.equal(response.status,200);
  assert.equal(f.upstream[0].options.headers.Authorization,publicKey);
  assert.equal(response.headers.get('X-Workflow-Upstream-Pool'),'public');
  assert.equal(response.headers.get('x-ratelimit-remaining'),null);
  assert.equal(f.cacheReads.length,0);assert.equal(f.cacheWrites.length,0);
  assert.equal(f.sql.prepare('SELECT remaining FROM rate_quota').get().remaining,7,'site quota learns from the borrowed call');
  assert.deepEqual(f.sql.prepare('SELECT * FROM workflow_rate_quota').get(),workflowBefore);
});

test('collector calls never borrow below the site reserve or when their own slot is free',async t=>{
  const f=fixture(t);
  f.sql.prepare('INSERT INTO workflow_rate_quota VALUES(1,NULL,0,0,?)').run(Date.now()+60000);
  f.sql.prepare('UPDATE rate_quota SET remaining=?,reset_at=? WHERE id=1').run(PUBLIC_BORROW_RESERVE-1,Date.now()+60000);
  const busy=await f.request(workflowKey);
  assert.equal(busy.status,429);assert.equal(f.upstream.length,0);
  assert.equal(f.sql.prepare('SELECT remaining FROM rate_quota').get().remaining,PUBLIC_BORROW_RESERVE-1);
  const g=fixture(t);
  const own=await g.request(workflowKey);
  assert.equal(g.upstream[0].options.headers.Authorization,workflowKey);
  assert.equal(own.headers.get('X-Workflow-Upstream-Pool'),'workflow');
  assert.equal(g.sql.prepare('SELECT remaining FROM rate_quota').get().remaining,null);
});

test('workflow quota storage is created automatically for existing databases',async t=>{
  const f=fixture(t);f.sql.exec('DROP TABLE workflow_rate_quota');
  assert.equal((await f.request(workflowKey)).status,200);
  assert.equal(f.sql.prepare('SELECT remaining FROM workflow_rate_quota').get().remaining,7);
});

test('D1-only routes bypass an exhausted workflow gate without advancing its next slot',async t=>{
  const f=fixture(t);
  f.sql.prepare('INSERT INTO workflow_rate_quota VALUES(1,0,?,0,?)').run(Date.now()+60000,Date.now()+30000);
  const before=f.sql.prepare('SELECT * FROM workflow_rate_quota').get();
  assert.equal((await f.request(workflowKey,origin+'/api/calib-model')).status,200);
  assert.deepEqual(f.sql.prepare('SELECT * FROM workflow_rate_quota').get(),before);
  assert.equal(f.upstream.length,0);
});

test('bad or unconfigured credentials are rejected before any storage, cache or upstream access',async t=>{
  const f=fixture(t);
  f.env.APP_DB={prepare(){throw new Error('Unauthorized database access');}};
  for(const key of ['',publicKey,workflowKey+'bad'])assert.equal((await f.request(key)).status,401);
  delete f.env.HENRIK_WORKFLOW_KEY;
  assert.equal((await f.request(workflowKey)).status,503);
  assert.equal(f.upstream.length,0);assert.equal(f.cacheReads.length,0);
});

test('workflows never fall back to the site key when quota storage fails',async t=>{
  const f=fixture(t);f.env.APP_DB={prepare(){throw new Error('D1 unavailable');}};
  assert.equal((await f.request(workflowKey)).status,503);
  assert.equal(f.upstream.length,0);
});

test('the scheduler sends credentials only to its HTTPS API origin and refuses redirects',async()=>{
  const calls=[];
  const fetchImpl=createRequestScheduler({workflowKey,origin,fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
  }});
  await fetchImpl(url,{headers:{Accept:'application/json'}});
  assert.equal(calls[0].options.headers.get('X-Workflow-Key'),workflowKey);
  assert.equal(calls[1].options.headers.get('Accept'),'application/json');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].url,origin+'/api/calib-model');
  for(const target of ['https://other.test/api/test','http://site.test/api/test',origin+'/not-api']){
    await assert.rejects(fetchImpl(target),/Workflow key may only be sent/);
  }
  assert.equal(calls.length,2);
});

test('workflow process identity is sent only to the authenticated proxy',async()=>{
  const calls=[];
  const scheduled=createRequestScheduler({workflowKey,origin,runId:'123:1:process-a',fetchImpl:async(target,options)=>{
    calls.push({target,options});return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
  }});
  await scheduled(url);
  assert.equal(calls.at(-1).options.headers.get('X-Workflow-Run'),'123:1:process-a');
  await assert.rejects(scheduled('https://other.test/api/rr-collect'),/Workflow key may only be sent/);
  assert.equal(calls.length,2);
});

test('an older proxy cannot receive unpaced workflow requests',async()=>{
  const calls=[];
  const scheduled=createRequestScheduler({workflowKey,origin,fetchImpl:async target=>{
    calls.push(target);return Response.json({data:{}});
  }});
  await assert.rejects(scheduled(url),/Central workflow pacing is not ready/);
  assert.deepEqual(calls,[origin+'/api/calib-model']);
});

test('concurrent workflow callers share one readiness probe and then proceed without client pacing',async()=>{
  const calls=[];
  const scheduled=createRequestScheduler({workflowKey,origin,fetchImpl:async target=>{
    calls.push(target);return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
  }});
  await Promise.all([scheduled(url),scheduled(url),scheduled(url)]);
  assert.equal(calls.filter(target=>target.endsWith('/api/calib-model')).length,1);
  assert.equal(calls.filter(target=>target===url).length,3);
});

test('credential mismatch reaches the collector as a configuration error without retries or per-player masking',async()=>{
  const calls=[];
  const scheduled=createRequestScheduler({workflowKey,origin,fetchImpl:async target=>{
    calls.push(target);return Response.json({error:'Unauthorized workflow request'},{status:401});
  }});
  await assert.rejects(collectPlayers([{puuid:'a',region:'eu',platform:'pc'}],{
    origin,fetchImpl:scheduled,log:()=>{},concurrency:1,
  }),error=>error.code==='WORKFLOW_CONFIGURATION'&&/HTTP 401.*must match/.test(error.message));
  assert.deepEqual(calls,[origin+'/api/calib-model']);
});

test('a transient readiness failure can recover on the next retry',async()=>{
  let probes=0,requests=0;
  const scheduled=createRequestScheduler({workflowKey,origin,fetchImpl:async target=>{
    if(target.endsWith('/api/calib-model')){
      if(++probes===1)throw new TypeError('fetch failed');
      return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
    }
    requests++;return Response.json({data:{recovered:true}});
  }});
  const result=await requestJSON(url,scheduled,async()=>{});
  assert.equal(result.ok,true);assert.equal(probes,2);assert.equal(requests,1);
});

test('collector FIFO requests share quota cooldowns and cannot starve competing workers',async()=>{
  let clock=0,active=0,maximum=0;const starts=[],waits=[];
  const scheduled=createRequestScheduler({workflowKey,origin,serialize:true,now:()=>clock,
    sleepImpl:async ms=>{waits.push(ms);clock+=ms;},fetchImpl:async target=>{
      if(target.endsWith('/api/calib-model'))return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
      active++;maximum=Math.max(maximum,active);starts.push(clock);await Promise.resolve();active--;
      return starts.length===1?Response.json({retryAfterMs:9000},{status:429}):Response.json({data:{}});
    }});
  const results=await Promise.all([scheduled(url),scheduled(url),scheduled(url)]);
  assert.equal(maximum,1);assert.deepEqual(starts,[0,9000,9000]);assert.deepEqual(waits,[9000]);
  assert.equal(results[0].status,429);assert.equal(results[2].status,200);
});

test('collector scheduler keeps FIFO order with a bounded number of calls in flight and counts pools',async()=>{
  let active=0,maximum=0;const order=[];const gates=[];
  const scheduled=createRequestScheduler({workflowKey,origin,serialize:true,inFlight:3,fetchImpl:async target=>{
    if(target.endsWith('/api/calib-model'))return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
    active++;maximum=Math.max(maximum,active);order.push(new URL(target).searchParams.get('n'));
    await new Promise(resolve=>gates.push(resolve));active--;
    return Response.json({data:{}},{headers:{'X-Workflow-Upstream-Pool':order.length%2?'workflow':'public'}});
  }});
  const jobs=Array.from({length:7},(_,i)=>scheduled(`${url}?n=${i}`));
  while(order.length<7){await new Promise(resolve=>setImmediate(resolve));gates.splice(0).forEach(open=>open());}
  await Promise.all(jobs);
  assert.equal(maximum,3);
  assert.deepEqual(order,['0','1','2','3','4','5','6']);
  assert.equal(scheduled.pools.workflow+scheduled.pools.public,7);
  assert.throws(()=>createRequestScheduler({inFlight:0}),/positive integer/);
});

test('quota cooldown cannot hold a collector past its run budget',async()=>{
  let clock=0,calls=0;
  const scheduled=createRequestScheduler({workflowKey,origin,serialize:true,deadline:1000,now:()=>clock,
    sleepImpl:async ms=>{clock+=ms;},fetchImpl:async target=>{
      if(target.endsWith('/api/calib-model'))return Response.json({data:{}},{headers:{'X-Workflow-Pacing':'upstream-v1'}});
      calls++;return Response.json({retryAfterMs:60000},{status:429});
    }});
  await scheduled(url);
  await assert.rejects(requestJSON(url,scheduled,async()=>{}),error=>error.code==='WORKFLOW_BUDGET');
  assert.equal(clock,1000);assert.equal(calls,1);
});

test('HTTP retry waits stop at the collection deadline',async()=>{
  let clock=0,calls=0;
  await assert.rejects(requestJSON(url,async()=>{calls++;return Response.json({retryAfterMs:60000},{status:429});},
    async ms=>{clock+=ms;},{deadline:1000,now:()=>clock}),error=>error.code==='WORKFLOW_BUDGET');
  assert.equal(clock,1000);assert.equal(calls,1);
});

test('all Henrik workflows require the new secret before doing any network work',async()=>{
  const env={CF_API_TOKEN:'fixture',CF_ACCOUNT_ID:'fixture',CF_D1_DATABASE_ID:'fixture'};
  for(const main of [refresh,collect,backfill])await assert.rejects(main(env),/Missing required secret: HENRIK_WORKFLOW_KEY/);
});

test('storage 503s are not retried and a run of them stops the collector',async()=>{
  let calls=0;
  const full=async()=>{calls++;return Response.json({error:'RR corpus could not be saved',storage:'unavailable'},{status:503});};
  const ok=async()=>Response.json({data:{ok:true}});
  const breaker=createStorageBreaker(3);
  const first=await requestJSON('https://test/api/rr-collect',full,async()=>{},{storageBreaker:breaker});
  assert.equal(calls,1);assert.equal(first.ok,false);assert.equal(first.retryable,true);
  // A success in between resets the streak: one D1 hiccup must not end a run.
  assert.equal((await requestJSON('https://test/api/rr-collect',ok,async()=>{},{storageBreaker:breaker})).ok,true);
  await requestJSON('https://test/api/rr-collect',full,async()=>{},{storageBreaker:breaker});
  await requestJSON('https://test/api/rr-collect',full,async()=>{},{storageBreaker:breaker});
  await assert.rejects(requestJSON('https://test/api/rr-collect',full,async()=>{},{storageBreaker:breaker}),
    error=>error.code==='WORKFLOW_STORAGE');
  assert.equal(calls,4);
});

test('the D1 headroom check reads the database size and refuses a nearly full database',async()=>{
  const env={CF_API_TOKEN:'t',CF_ACCOUNT_ID:'a',CF_D1_DATABASE_ID:'d'};
  const sized=size=>async()=>Response.json({success:true,result:[{success:true,results:[{1:1}],meta:{size_after:size}}]});
  assert.equal(await assertD1Headroom(env,{fetchImpl:sized(5e9)}),5e9);
  await assert.rejects(assertD1Headroom(env,{fetchImpl:sized(9999998976)}),error=>error.code==='WORKFLOW_STORAGE'&&/10 GB limit/.test(error.message));
  // An API that omits the size cannot block collection on a guess.
  assert.equal(await assertD1Headroom(env,{fetchImpl:sized(undefined)}),null);
});

test('archive migration ranges cover every rowid once and a range resumes from the last row',async()=>{
  for(const [max,workers] of [[1,4],[10,4],[245454,4],[7,7]]){
    const ranges=rowidRanges(max,workers),seen=[];
    for(const r of ranges)for(let id=r.after+1;id<r.before;id++)seen.push(id);
    assert.deepEqual(seen,Array.from({length:max},(_,i)=>i+1),`${max}/${workers}`);
  }
  assert.deepEqual(rowidRanges(0,4),[]);
  const calls=[];let fail=1;
  const fetchImpl=async url=>{
    const u=new URL(url);calls.push(u.searchParams.get('after'));
    if(fail-->0)return Response.json({error:'D1 overloaded'},{status:503});
    const after=Number(u.searchParams.get('after'));
    return Response.json({data:{moved:2,skipped:0,last:after+2,done:after+2>=6}});
  };
  const result=await migrateRange({after:0,before:7},{origin:'https://site',key:'k',fetchImpl,sleepImpl:async()=>{},log(){}});
  assert.deepEqual(calls,['0','0','2','4']);
  assert.deepEqual(result,{after:0,before:7,moved:6,last:6,done:true});
  await assert.rejects(migrateRange({after:0,before:7},{origin:'https://site',key:'k',sleepImpl:async()=>{},
    fetchImpl:async()=>Response.json({error:'Unauthorized'},{status:401})}),/refused the workflow key/);
});

test('with the public window down to its reserve, a search still resolves its account',async t=>{
  const f=fixture(t);
  delete f.env.HENRIK_WORKFLOW_KEY; // teammate names fall back to the public key, as in local dev
  const reserve=()=>f.sql.prepare('INSERT OR REPLACE INTO rate_quota (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,?,?,0,0)')
    .run(PUBLIC_PROFILE_RESERVE,Date.now()+60000);
  reserve();
  const rank=await f.request(undefined);
  assert.equal(rank.status,429);
  assert.ok((await rank.json()).retryAfterMs>50000,'told to return at the reset');
  reserve();
  const teammate=await f.request(undefined,origin+'/api/account-by-puuid/11111111-1111-4111-8111-111111111111',{'X-Name-Lookup':'teammate'});
  assert.equal(teammate.status,429,'teammate names cannot spend the reserve');
  assert.equal(f.upstream.length,0);
  reserve();
  const account=await f.request(undefined,origin+'/api/account/Alpha/EU');
  assert.equal(account.status,200);
  assert.equal(f.upstream.length,1);
  assert.equal(f.upstream[0].options.headers.Authorization,publicKey);
});

const savedPuuid='22222222-2222-4222-8222-222222222222';
function saveIdentity(f,{puuid=savedPuuid,name='Alpha',tag='EU',region='eu',lastSeen=new Date().toISOString(),ended=null}={}){
  f.sql.prepare('INSERT INTO player_name_history (puuid,name,tag,first_seen,last_seen,ended_at) VALUES(?,?,?,?,?,?)')
    .run(puuid,name,tag,lastSeen,lastSeen,ended);
  f.sql.prepare('INSERT OR REPLACE INTO rr_players (puuid,region,platform,name,tag,updated_at) VALUES(?,?,?,?,?,?)')
    .run(puuid,region,'pc',name,tag,lastSeen);
}
const spendPublicWindow=f=>f.sql.prepare('INSERT OR REPLACE INTO rate_quota (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,0,?,0,0)')
  .run(Date.now()+45000);
const auditRows=f=>f.sql.prepare('SELECT event,route,profile,gate_remaining,header_remaining,served_saved FROM public_quota_audit ORDER BY id').all()
  .map(row=>({...row}));

test('with the public window spent, a saved profile resolves its account from D1',async t=>{
  const f=fixture(t);
  saveIdentity(f);
  spendPublicWindow(f);
  const response=await f.request(undefined,origin+'/api/account/alpha/eu');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('X-Account-Source'),'saved');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const {data}=await response.json();
  assert.deepEqual({puuid:data.puuid,name:data.name,tag:data.tag,region:data.region,source:data.vlravg_source},
    {puuid:savedPuuid,name:'Alpha',tag:'EU',region:'eu',source:'saved-account'});
  assert.equal(f.upstream.length,0);
  assert.equal(f.cacheWrites.length,0,'a saved answer is never edge-cached');
  assert.deepEqual(auditRows(f),[{event:'profile-refused',route:'account',profile:1,gate_remaining:0,header_remaining:null,served_saved:1}]);

  const byPuuid=await f.request(undefined,origin+`/api/account-by-puuid/${savedPuuid.toUpperCase()}`);
  assert.equal(byPuuid.status,200);
  assert.equal((await byPuuid.json()).data.name,'Alpha');
});

test('saved account answers need one recent current identity with a region',async t=>{
  const cases=[
    ['unknown player',()=>{}],
    ['renamed away',f=>saveIdentity(f,{ended:new Date().toISOString()})],
    ['not seen for 40 days',f=>saveIdentity(f,{lastSeen:new Date(Date.now()-40*86400000).toISOString()})],
    ['no saved region',f=>saveIdentity(f,{region:null})],
    ['two accounts claim the Riot ID',f=>{saveIdentity(f);saveIdentity(f,{puuid:'33333333-3333-4333-8333-333333333333',name:'ALPHA'});}],
  ];
  for(const [label,seed] of cases){
    await t.test(label,async t=>{
      const f=fixture(t);
      seed(f);
      spendPublicWindow(f);
      const response=await f.request(undefined,origin+'/api/account/Alpha/EU');
      assert.equal(response.status,429);
      assert.ok((await response.json()).retryAfterMs>40000);
      assert.equal(auditRows(f)[0].served_saved,0);
    });
  }
});

test('teammate names and other routes never get the saved account answer',async t=>{
  const f=fixture(t);
  delete f.env.HENRIK_WORKFLOW_KEY;
  saveIdentity(f);
  spendPublicWindow(f);
  const teammate=await f.request(undefined,origin+`/api/account-by-puuid/${savedPuuid}`,{'X-Name-Lookup':'teammate'});
  assert.equal(teammate.status,429);
  assert.equal((await f.request(undefined)).status,429);
  assert.deepEqual(auditRows(f),[],'only search account lookups are audited as refused');
});

test('a real upstream 429 on an account lookup falls back to the saved account and is audited',async t=>{
  const f=fixture(t);
  saveIdentity(f);
  f.respond=()=>Response.json({errors:[{code:0}]},{status:429,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'40','retry-after':'40'}});
  f.sql.prepare('INSERT OR REPLACE INTO rate_quota (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,20,?,0,0)').run(Date.now()+40000);
  const response=await f.request(undefined,origin+'/api/account/Alpha/EU');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('X-Account-Source'),'saved');
  assert.equal(f.upstream.length,1);
  assert.deepEqual(auditRows(f).map(r=>[r.event,r.gate_remaining,r.header_remaining,r.served_saved]),
    [['upstream-429',19,0,null],['profile-refused',0,null,1]]);
});

test('public responses in the reserve are audited with our count beside the header',async t=>{
  const f=fixture(t);
  f.respond=()=>Response.json({data:{}},{headers:{'x-ratelimit-remaining':'3','x-ratelimit-reset':'30'}});
  f.sql.prepare('INSERT OR REPLACE INTO rate_quota (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,12,?,0,0)').run(Date.now()+30000);
  assert.equal((await f.request(undefined)).status,200);
  assert.deepEqual(auditRows(f),[{event:'low-window',route:'rank',profile:0,gate_remaining:11,header_remaining:3,served_saved:null}]);
  f.respond=()=>Response.json({data:{}},{headers:{'x-ratelimit-remaining':'40','x-ratelimit-reset':'30'}});
  f.sql.prepare('UPDATE rate_quota SET remaining=50,next_start_at=0').run();
  assert.equal((await f.request(undefined,origin+'/api/rank/eu/pc/Beta/EU')).status,200);
  assert.equal(auditRows(f).length,1,'responses with quota to spare write nothing');
});
