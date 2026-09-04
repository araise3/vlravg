import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestScheduler} from '../.github/scripts/request-scheduler.mjs';
import {drainBackfill} from '../.github/scripts/backfill-all-names.mjs';

const player=(id,extra={})=>({puuid:id,region:'eu',platform:'pc',next_start:0,backfill_complete:0,...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('concurrent request starts share one 60/minute gate',async()=>{
  let clock=0;const starts=[];
  const scheduled=createRequestScheduler({now:()=>clock,sleepImpl:async ms=>{await tick();clock+=ms;},fetchImpl:async()=>{
    starts.push(clock);return Response.json({data:{}});
  }});
  await Promise.all(Array.from({length:4},()=>scheduled('https://example.test')));
  assert.deepEqual(starts,[0,1000,2000,3000]);
});

test('a 429 pauses every subsequent worker for the proxy reset duration',async()=>{
  let clock=0;let calls=0;const starts=[];
  const scheduled=createRequestScheduler({now:()=>clock,sleepImpl:async ms=>{await tick();clock+=ms;},fetchImpl:async()=>{
    starts.push(clock);return ++calls===1?Response.json({retryAfterMs:7000},{status:429}):Response.json({data:{}});
  }});
  await scheduled('https://example.test');
  await Promise.all([scheduled('https://example.test'),scheduled('https://example.test')]);
  assert.deepEqual(starts,[0,7000,8000]);
});

test('pages run round-robin, completed players are skipped and all remaining players finish',async()=>{
  const calls=[];const counts=new Map();
  const result=await drainBackfill([player('a'),player('done',{backfill_complete:1}),player('b')],{concurrency:1,log:()=>{},runPage:async p=>{
    calls.push(p.puuid);const n=(counts.get(p.puuid)||0)+1;counts.set(p.puuid,n);
    return {ok:true,available:true,next_start:n*10,complete:n===2};
  }});
  assert.deepEqual(calls,['a','b','a','b']);assert.equal(result.completed,2);assert.equal(result.continue,false);assert.equal(result.remaining,0);
});

test('at most four players are in flight and a player never overlaps itself',async()=>{
  const active=new Set();let peak=0;
  const result=await drainBackfill(Array.from({length:8},(_,i)=>player(String(i))),{log:()=>{},runPage:async p=>{
    assert.equal(active.has(p.puuid),false);active.add(p.puuid);peak=Math.max(peak,active.size);
    await tick();active.delete(p.puuid);
    return {ok:true,available:true,next_start:p.next_start+10,complete:p.next_start>=10};
  }});
  assert.equal(peak,4);assert.equal(result.completed,8);assert.equal(result.matches,160);
});

test('a deadline queues continuation and oldest-touched players receive priority after restart',async()=>{
  let clock=0;const calls=[];
  const result=await drainBackfill([player('a',{backfill_updated_at:'2026-09-04'}),player('b'),player('c',{backfill_updated_at:'2026-09-03'})],{
    concurrency:1,deadline:2,now:()=>clock,log:()=>{},runPage:async p=>{
      calls.push(p.puuid);clock++;return {ok:true,available:true,next_start:10,complete:false};
    }
  });
  assert.deepEqual(calls,['b','c']);assert.equal(result.continue,true);assert.equal(result.remaining,3);
});

test('permanent errors or stalled cursors cannot create an endless chain without progress',async()=>{
  const result=await drainBackfill([player('a'),player('b')],{log:()=>{},runPage:async p=>p.puuid==='a'?{ok:false,reason:'http 404'}:{ok:true,available:true,next_start:0,complete:false}});
  assert.equal(result.continue,false);assert.equal(result.remaining,2);assert.equal(result.errors.length,2);
});
