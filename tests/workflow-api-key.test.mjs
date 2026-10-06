import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestGet} from '../functions/api/[[path]].js';
import {createRequestScheduler} from '../.github/scripts/request-scheduler.mjs';
import {main as refresh} from '../.github/scripts/refresh-rr-history.mjs';
import {main as collect} from '../.github/scripts/collect-rr-corpus.mjs';
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

test('exhausted workflow quota returns only retryAfterMs without contacting upstream',async t=>{
  const f=fixture(t);
  f.sql.prepare('INSERT INTO workflow_rate_quota (id,remaining,reset_at,last_request_at) VALUES(1,0,?,0)').run(Date.now()+60000);
  const response=await f.request(workflowKey),body=await response.json();
  assert.equal(response.status,429);assert.ok(body.retryAfterMs>0);
  assert.deepEqual(Object.keys(body).sort(),['error','retryAfterMs']);
  assert.equal(response.headers.get('x-ratelimit-remaining'),null);
  assert.equal(f.upstream.length,0);
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

test('all Henrik workflows require the new secret before doing any network work',async()=>{
  const env={CF_API_TOKEN:'fixture',CF_ACCOUNT_ID:'fixture',CF_D1_DATABASE_ID:'fixture'};
  for(const main of [refresh,collect,backfill])await assert.rejects(main(env),/Missing required secret: HENRIK_WORKFLOW_KEY/);
});
