import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {acquireWorkflowPermit,observeWorkflowQuota,WORKFLOW_SPACING_MS} from '../lib/workflow-pacing.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function database(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  return {db,sql};
}

test('atomic reservations serialize concurrent callers and keep every rolling minute below 30 starts',async t=>{
  const {db}=database(t);
  let clock=100000;const waiting=[],permits=[];
  const jobs=Array.from({length:40},()=>acquireWorkflowPermit(db,{
    now:()=>clock,maxWaitMs:100000,sleepImpl:ms=>new Promise(resolve=>waiting.push({at:clock+ms,resolve})),
  }).then(p=>permits.push(p)));
  for(let iteration=0;permits.length<40&&iteration<100;iteration++){
    await tick();
    if(!waiting.length)continue;
    clock=Math.min(...waiting.map(w=>w.at));
    const ready=waiting.filter(w=>w.at<=clock),later=waiting.filter(w=>w.at>clock);
    waiting.splice(0,waiting.length,...later);ready.forEach(w=>w.resolve());
  }
  await Promise.all(jobs);
  assert.equal(permits.length,40);
  const starts=permits.map(p=>p.startedAt);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=WORKFLOW_SPACING_MS);
  for(const start of starts)assert.ok(starts.filter(time=>time>=start&&time<start+60000).length<=29);
});

test('quota reservations include in-flight calls and headers stretch spacing when budget is scarce',async t=>{
  const {db,sql}=database(t);let clock=100000;
  sql.prepare('INSERT INTO workflow_rate_quota VALUES(1,2,110000,0,0)').run();
  const first=await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0});
  assert.equal(first.quota.remaining,1);
  assert.equal(sql.prepare('SELECT next_start_at FROM workflow_rate_quota').get().next_start_at,105000);
  clock=102100;
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs,2900);
  clock=105000;
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).quota.remaining,0);
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs,5000);
  clock=110000;
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).quota.remaining,null);
});

test('out-of-order responses cannot restore reserved quota or move the next slot backwards',async t=>{
  const {db,sql}=database(t);let clock=100000;
  const first=await acquireWorkflowPermit(db,{now:()=>clock});
  clock+=2100;const second=await acquireWorkflowPermit(db,{now:()=>clock});
  await observeWorkflowQuota(db,{remaining:10,resetAt:120000},{startedAt:second.startedAt,now:()=>clock,status:200});
  const before=sql.prepare('SELECT * FROM workflow_rate_quota').get();
  await observeWorkflowQuota(db,{remaining:29,resetAt:160000},{startedAt:first.startedAt,now:()=>clock,status:200});
  assert.deepEqual(sql.prepare('SELECT * FROM workflow_rate_quota').get(),before);
  await observeWorkflowQuota(db,{remaining:20,resetAt:120000},{startedAt:second.startedAt,now:()=>clock,status:200});
  assert.equal(sql.prepare('SELECT remaining FROM workflow_rate_quota').get().remaining,10);
});

test('even a late 429 pauses all upstream callers for Retry-After',async t=>{
  const {db}=database(t);let clock=100000;
  const first=await acquireWorkflowPermit(db,{now:()=>clock});
  clock+=2100;await acquireWorkflowPermit(db,{now:()=>clock});
  const wait=await observeWorkflowQuota(db,{remaining:null,resetAt:null},
    {startedAt:first.startedAt,now:()=>clock,status:429,retryAfterMs:9000});
  assert.equal(wait,9000);
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs,9000);
  clock+=9000;
  assert.ok((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).quota);
});

test('busy gates return a bounded retry and missing or failed storage never grants admission',async t=>{
  const {db}=database(t);
  await acquireWorkflowPermit(db,{now:()=>100000});
  assert.equal((await acquireWorkflowPermit(db,{now:()=>100000,maxWaitMs:0})).retryAfterMs,2100);
  await assert.rejects(acquireWorkflowPermit(null),/requires APP_DB/);
  await assert.rejects(acquireWorkflowPermit({prepare(){throw new Error('D1 unavailable');}}),/D1 unavailable/);
});

test('existing four-column quota tables are upgraded without losing exhaustion state',async t=>{
  const {db,sql}=database(t);
  sql.exec('DROP TABLE workflow_rate_quota; CREATE TABLE workflow_rate_quota(id INTEGER PRIMARY KEY,remaining INTEGER,reset_at INTEGER,last_request_at INTEGER); INSERT INTO workflow_rate_quota VALUES(1,0,110000,100000)');
  assert.equal((await acquireWorkflowPermit(db,{now:()=>100000,maxWaitMs:0})).retryAfterMs,10000);
  assert.equal(sql.prepare('SELECT next_start_at FROM workflow_rate_quota').get().next_start_at,0);
});
