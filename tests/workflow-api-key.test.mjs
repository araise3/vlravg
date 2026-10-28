import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestGet} from '../functions/api/[[path]].js';
import {PUBLIC_BORROW_RESERVE} from '../lib/upstream-pacing.mjs';
import {createRequestScheduler} from '../.github/scripts/request-scheduler.mjs';
import {main as refresh,requestJSON} from '../.github/scripts/refresh-rr-history.mjs';
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
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  const env={APP_DB,HENRIK_KEY:publicKey,HENRIK_WORKFLOW_KEY:workflowKey};
  const upstream=[],cacheReads=[],cacheWrites=[];
  const oldCaches=globalThis.caches;
  globalThis.caches={default:{async match(key){cacheReads.push(key);return null;},async put(key){cacheWrites.push(key);}}};
  t.after(()=>{if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;});
  t.mock.method(globalThis,'fetch',async (target,options)=>{
    upstream.push({target,options});
    return Response.json({data:{}},{headers:{'x-ratelimit-remaining':'7','x-ratelimit-reset':'60'}});
  });
  async function request(key,target=url){
    const jobs=[];
    const response=await onRequestGet({env,request:new Request(target,{headers:key===undefined?{}:{'X-Workflow-Key':key}}),waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs);return response;
  }
  return {sql,env,upstream,cacheReads,cacheWrites,request};
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
