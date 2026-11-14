import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {run,MAX_ATTEMPTS} from '../.github/scripts/sim-pilot-fetch.mjs';

// In-memory sim_pilot_players with just the statements the script sends.
function fakeD1(players,{failFirst=0,down=false}={}){
  const rows=new Map(players.map(([puuid,region])=>[puuid,{puuid,region,status:null,n:null,data:null,attempts:null}]));
  let calls=0;
  const d1=async(sql,params=[])=>{
    calls++;
    if(down||calls<=failFirst)throw new TypeError('fetch failed',{cause:Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})});
    if(sql.startsWith('SELECT puuid,region'))return[...rows.values()].filter(r=>r.status===null)
      .sort((a,b)=>(a.attempts??0)-(b.attempts??0)||a.puuid.localeCompare(b.puuid)).slice(0,60).map(r=>({puuid:r.puuid,region:r.region,attempts:r.attempts??0}));
    if(sql.startsWith('UPDATE sim_pilot_players SET status=?1')){const r=rows.get(params[4]);Object.assign(r,{status:params[0],n:params[1],data:params[2]});return[];}
    if(sql.startsWith('UPDATE sim_pilot_players SET attempts=?1,status=0')){Object.assign(rows.get(params[2]),{attempts:params[0],status:0});return[];}
    if(sql.startsWith('UPDATE sim_pilot_players SET attempts=?1')){rows.get(params[2]).attempts=params[0];return[];}
    if(sql.startsWith('SELECT SUM(status IS NULL)'))return[{left:[...rows.values()].filter(r=>r.status===null).length}];
    throw new Error(`unexpected SQL ${sql}`);
  };
  return{d1,rows};
}
const match=(id,act='e11a6')=>({meta:{id,started_at:'2026-11-01T00:00:00Z',season:{short:act}},stats:{team:'Red',kills:10,deaths:8,assists:2,score:3000,character:{id:'A'},damage:{made:2000,received:1800},shots:{head:5,body:20,leg:1},tier:24},teams:{red:13,blue:9}});
const pageOf=(ids,after)=>({status:200,data:ids.map(i=>typeof i==='string'?match(i):i),results:{after}});
// Scripted upstream: key `${puuid}:${page}` -> list of responses (status/body or 'reset'), consumed in order; the last repeats.
function fakeFetch(script){
  const seen=new Map();
  return async url=>{
    const m=url.match(/stored-matches\/[^/]+\/([^?]+)\?page=(\d+)/);const key=`${m[1]}:${m[2]}`;
    const list=script[key]??[{status:404,body:{error:'not found'}}],i=seen.get(key)??0;seen.set(key,i+1);
    const r=list[Math.min(i,list.length-1)];
    if(r==='reset')throw new TypeError('fetch failed',{cause:Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})});
    return{status:r.status,json:async()=>r.body};
  };
}
function clock(){let t=Date.parse('2026-11-14T00:00:00Z');return{now:()=>t,sleep:async ms=>{t+=Math.max(0,ms);}};}
const env={RUNTIME_MINUTES:'60',SIM_ACT:'e11a6'};
const quiet=()=>{};
const hundred=p=>Array.from({length:100},(_,i)=>`${p}-${i}`);

test('saves complete histories, stops at the previous act, and reports what is left',async()=>{
  const {d1,rows}=fakeD1([['p1','eu'],['p2','na'],['p3','eu']]);
  const fetchImpl=fakeFetch({
    'p1:1':[{status:200,body:pageOf(hundred('a'),40)}],'p1:2':[{status:200,body:pageOf([...hundred('b').slice(0,30),match('old','e11a5')],0)}],
    'p2:1':[{status:200,body:pageOf(['x','y'],0)}],
  });
  const r=await run({env,fetchImpl,d1,...clock(),log:quiet});
  assert.equal(rows.get('p1').status,200);assert.equal(rows.get('p1').n,130);
  assert.equal(JSON.parse(gunzipSync(Buffer.from(rows.get('p1').data,'base64'))).length,130);
  assert.equal(rows.get('p2').n,2);
  assert.equal(rows.get('p3').status,404,'unknown account is closed as 404');
  assert.equal(r.remaining,0);assert.equal(r.progressed,3);assert.equal(r.fatal,false);
});

test('a connection reset on D1 or upstream is retried instead of crashing the run',async()=>{
  const {d1,rows}=fakeD1([['p1','eu']],{failFirst:3});
  const fetchImpl=fakeFetch({'p1:1':['reset','reset',{status:200,body:pageOf(['x'],0)}]});
  const r=await run({env,fetchImpl,d1,...clock(),log:quiet});
  assert.equal(rows.get('p1').status,200);assert.equal(r.d1Retries,3);assert.equal(r.remaining,0);
});

test('429 waits for retryAfterMs and then succeeds',async()=>{
  const {d1,rows}=fakeD1([['p1','eu']]);
  const c=clock(),t0=c.now();
  const fetchImpl=fakeFetch({'p1:1':[{status:429,body:{error:'busy',retryAfterMs:30000}},{status:200,body:pageOf(['x'],0)}]});
  const r=await run({env,fetchImpl,d1,...c,log:quiet});
  assert.equal(rows.get('p1').status,200);assert.equal(r.rateLimited,1);
  assert.ok(c.now()-t0>=30000,'waited out the 429');
});

test('a failed later page is never saved as a partial history; after the attempt limit the row is closed',async()=>{
  const {d1,rows}=fakeD1([['p1','eu']]);
  const fetchImpl=fakeFetch({'p1:1':[{status:200,body:pageOf(hundred('a'),50)}],'p1:2':[{status:503,body:null}]});
  for(let i=1;i<=MAX_ATTEMPTS;i++){
    const r=await run({env,fetchImpl,d1,...clock(),log:quiet});
    if(i<MAX_ATTEMPTS){assert.equal(rows.get('p1').status,null);assert.equal(rows.get('p1').attempts,i);assert.equal(r.remaining,1);}
  }
  assert.equal(rows.get('p1').status,0);assert.equal(rows.get('p1').data,null,'no partial data stored');
});

test('D1 down for good: the run ends without throwing and reports no progress',async()=>{
  const {d1}=fakeD1([['p1','eu']],{down:true});
  const r=await run({env,fetchImpl:fakeFetch({}),d1,...clock(),log:quiet});
  assert.equal(r.fatal,true);assert.equal(r.progressed,0);assert.equal(r.remaining,null);
});

test('the run budget ending mid-player leaves that player for the next run',async()=>{
  const {d1,rows}=fakeD1([['p1','eu']]);
  // Each page reply costs a 429 wait longer than the 1-minute budget.
  const fetchImpl=fakeFetch({'p1:1':[{status:429,body:{retryAfterMs:120000}}]});
  const r=await run({env:{...env,RUNTIME_MINUTES:'1'},fetchImpl,d1,...clock(),log:quiet});
  assert.equal(rows.get('p1').status,null);assert.equal(rows.get('p1').attempts,null,'budget is not a failed attempt');
  assert.equal(r.remaining,1);
});

test('many players with two workers: each saved once, at most 40 requests a minute',async()=>{
  const ids=Array.from({length:150},(_,i)=>[`p${String(i).padStart(3,'0')}`,'eu']);
  const {d1,rows}=fakeD1(ids);
  const script={};for(const [u] of ids)script[`${u}:1`]=[{status:200,body:pageOf(['x'],0)}];
  const c=clock(),t0=c.now();
  const r=await run({env,fetchImpl:fakeFetch(script),d1,...c,log:quiet});
  assert.equal(r.saved,150);assert.equal([...rows.values()].every(x=>x.status===200),true);
  assert.ok((c.now()-t0)/60000>=150/40-0.1,'paced to 40/min');
});
