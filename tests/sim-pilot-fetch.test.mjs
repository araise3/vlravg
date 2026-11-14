import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {run,loadKast,MAX_ATTEMPTS} from '../.github/scripts/sim-pilot-fetch.mjs';

// In-memory queue tables with just the statements the script sends.
const TABLES={sim_pilot_players:'puuid',sim_pilot_rr:'puuid',sim_pilot_prev:'puuid',sim_pilot_kast:'match_id'};
function fakeD1(seed,{failFirst=0,down=false}={}){
  const db=Object.fromEntries(Object.keys(TABLES).map(t=>[t,new Map()]));
  for(const [t,rows] of Object.entries(seed))for(const [id,region] of rows)db[t].set(id,{id,region,status:null,n:null,data:null,attempts:null});
  let calls=0;
  const d1=async(sql,params=[])=>{
    calls++;
    if(down||calls<=failFirst)throw new TypeError('fetch failed',{cause:Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})});
    const table=sql.match(/(?:FROM|UPDATE) (sim_pilot_\w+)/)?.[1],rows=db[table];
    if(!rows)throw new Error(`unexpected SQL ${sql}`);
    if(sql.startsWith('SELECT SUM(status IS NULL)'))return[{left:[...rows.values()].filter(r=>r.status===null).length}];
    if(sql.startsWith('SELECT'))return[...rows.values()].filter(r=>r.status===null)
      .sort((a,b)=>(a.attempts??0)-(b.attempts??0)||a.id.localeCompare(b.id)).slice(0,60).map(r=>({id:r.id,region:r.region,attempts:r.attempts??0}));
    if(sql.includes('SET status=?1')){Object.assign(rows.get(params[4]),{status:params[0],n:params[1],data:params[2]});return[];}
    if(sql.includes('SET attempts=?1,status=0')){Object.assign(rows.get(params[2]),{attempts:params[0],status:0});return[];}
    if(sql.includes('SET attempts=?1')){rows.get(params[2]).attempts=params[0];return[];}
    throw new Error(`unexpected SQL ${sql}`);
  };
  return{d1,db};
}
const unzip=v=>JSON.parse(gunzipSync(Buffer.from(v,'base64')));
const match=(id,act='e11a6')=>({meta:{id,started_at:'2026-11-01T00:00:00Z',season:{short:act}},stats:{team:'Red',kills:10,deaths:8,assists:2,score:3000,character:{id:'A'},damage:{made:2000,received:1800},shots:{head:5,body:20,leg:1},tier:24},teams:{red:13,blue:9}});
const pageOf=(items,after)=>({status:200,data:items.map(i=>typeof i==='string'?match(i):i),results:{after}});
// Scripted upstream: key = path without /api/ and query page -> responses consumed in order; the last repeats.
function fakeFetch(script){
  const seen=new Map();
  return async url=>{
    const u=new URL(url),key=`${u.pathname.replace('/api/','')}${u.searchParams.get('page')?`:${u.searchParams.get('page')}`:''}`;
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
const H='stored-matches/eu/',HN='stored-matches/na/';

test('history: saves complete act histories, stops at the previous act, and reports what is left',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu'],['p2','na'],['p3','eu']]});
  const fetchImpl=fakeFetch({
    [`${H}p1:1`]:[{status:200,body:pageOf(hundred('a'),40)}],[`${H}p1:2`]:[{status:200,body:pageOf([...hundred('b').slice(0,30),match('old','e11a5')],0)}],
    [`${HN}p2:1`]:[{status:200,body:pageOf(['x','y'],0)}],
  });
  const r=await run({env,fetchImpl,d1,...clock(),log:quiet,kastOf:null});
  const p1=db.sim_pilot_players.get('p1');
  assert.equal(p1.status,200);assert.equal(p1.n,130);assert.equal(unzip(p1.data).length,130);
  assert.equal(db.sim_pilot_players.get('p2').n,2);
  assert.equal(db.sim_pilot_players.get('p3').status,null,'a first 404 stays open');
  assert.equal(db.sim_pilot_players.get('p3').attempts,1);
  assert.equal(r.remaining,1);assert.equal(r.progressed,3);assert.equal(r.fatal,false);
  const r2=await run({env,fetchImpl,d1,...clock(),log:quiet});
  assert.equal(db.sim_pilot_players.get('p3').status,404,'a 404 in a later run closes it');
  assert.equal(r2.remaining,0);
});

test('a 404 that later turns into data is fetched, not closed (HenrikDev answered 404 once, then 41 matches)',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu']]});
  const fetchImpl=fakeFetch({[`${H}p1:1`]:[{status:404,body:{error:'not found'}},{status:200,body:pageOf(['x','y'],0)}]});
  await run({env,fetchImpl,d1,...clock(),log:quiet});
  assert.equal(db.sim_pilot_players.get('p1').status,null);
  await run({env,fetchImpl,d1,...clock(),log:quiet});
  assert.equal(db.sim_pilot_players.get('p1').status,200);assert.equal(db.sim_pilot_players.get('p1').n,2);
});

test('a connection reset on D1 or upstream is retried instead of crashing the run',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu']]},{failFirst:3});
  const fetchImpl=fakeFetch({[`${H}p1:1`]:['reset','reset',{status:200,body:pageOf(['x'],0)}]});
  const r=await run({env,fetchImpl,d1,...clock(),log:quiet});
  assert.equal(db.sim_pilot_players.get('p1').status,200);assert.equal(r.d1Retries,3);assert.equal(r.remaining,0);
});

test('429 waits for retryAfterMs and then succeeds',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu']]});
  const c=clock(),t0=c.now();
  const fetchImpl=fakeFetch({[`${H}p1:1`]:[{status:429,body:{error:'busy',retryAfterMs:30000}},{status:200,body:pageOf(['x'],0)}]});
  const r=await run({env,fetchImpl,d1,...c,log:quiet});
  assert.equal(db.sim_pilot_players.get('p1').status,200);assert.equal(r.rateLimited,1);
  assert.ok(c.now()-t0>=30000,'waited out the 429');
});

test('a failed later page is never saved as a partial history; after the attempt limit the row is closed',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu']]});
  const fetchImpl=fakeFetch({[`${H}p1:1`]:[{status:200,body:pageOf(hundred('a'),50)}],[`${H}p1:2`]:[{status:503,body:null}]});
  for(let i=1;i<=MAX_ATTEMPTS;i++){
    const r=await run({env,fetchImpl,d1,...clock(),log:quiet});
    if(i<MAX_ATTEMPTS){assert.equal(db.sim_pilot_players.get('p1').status,null);assert.equal(db.sim_pilot_players.get('p1').attempts,i);assert.equal(r.remaining,1);}
  }
  assert.equal(db.sim_pilot_players.get('p1').status,0);assert.equal(db.sim_pilot_players.get('p1').data,null,'no partial data stored');
});

test('D1 down for good: the run ends without throwing and reports no progress',async()=>{
  const {d1}=fakeD1({sim_pilot_players:[['p1','eu']]},{down:true});
  const r=await run({env,fetchImpl:fakeFetch({}),d1,...clock(),log:quiet});
  assert.equal(r.fatal,true);assert.equal(r.progressed,0);assert.equal(r.remaining,null);
});

test('the run budget ending mid-item leaves it for the next run',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu']]});
  const fetchImpl=fakeFetch({[`${H}p1:1`]:[{status:429,body:{retryAfterMs:120000}}]});
  const r=await run({env:{...env,RUNTIME_MINUTES:'1'},fetchImpl,d1,...clock(),log:quiet});
  assert.equal(db.sim_pilot_players.get('p1').status,null);assert.equal(db.sim_pilot_players.get('p1').attempts,null,'budget is not a failed attempt');
  assert.equal(r.remaining,1);
});

test('many items with two workers: each saved once, at most 40 requests a minute',async()=>{
  const ids=Array.from({length:150},(_,i)=>[`p${String(i).padStart(3,'0')}`,'eu']);
  const {d1,db}=fakeD1({sim_pilot_players:ids});
  const script={};for(const [u] of ids)script[`${H}${u}:1`]=[{status:200,body:pageOf(['x'],0)}];
  const c=clock(),t0=c.now();
  const r=await run({env,fetchImpl:fakeFetch(script),d1,...c,log:quiet});
  assert.equal(r.saved,150);assert.equal([...db.sim_pilot_players.values()].every(x=>x.status===200),true);
  assert.ok((c.now()-t0)/60000>=150/40-0.1,'paced to 40/min');
});

test('queues run in order: history, then RR history, previous-act games and KAST',async()=>{
  const {d1,db}=fakeD1({sim_pilot_players:[['p1','eu']],sim_pilot_rr:[['p1','eu']],sim_pilot_prev:[['p1','eu']],sim_pilot_kast:[['m1','eu']]});
  const rr=(id,date,rr)=>({match_id:id,date,tier:{id:25},ranking_in_tier:rr,last_mmr_change:18,season:{short:'e11a6'}});
  const order=[];
  const base=fakeFetch({
    [`${H}p1:1`]:[{status:200,body:pageOf([...hundred('a').slice(0,5),...hundred('o').slice(0,30).map(i=>match(i,'e11a5'))],0)}],
    'stored-mmr-history/eu/p1:1':[{status:200,body:{status:200,data:[...Array.from({length:99},(_,i)=>rr(`r${i}`,'2026-10-20T00:00:00Z',i)),rr('old','2026-07-01T00:00:00Z',5)]}}],
    'match-detail/eu/m1':[{status:200,body:{data:{metadata:{started_at:'2026-10-20T00:00:00Z'}}}}],
  });
  const fetchImpl=async url=>{order.push(new URL(url).pathname.split('/')[2]);return base(url);};
  const kastOf=m=>({t:m.metadata.started_at,R:20,old:1,p:[['p1',14,2500]]});
  const r=await run({env,fetchImpl,d1,...clock(),log:quiet,kastOf});
  assert.deepEqual([...new Set(order)],['stored-matches','stored-mmr-history','match-detail']);
  assert.equal(unzip(db.sim_pilot_players.get('p1').data).length,5,'history keeps the act only');
  const rrs=unzip(db.sim_pilot_rr.get('p1').data);
  assert.equal(rrs.length,99,'RR entries before August are left out and end the paging');
  assert.deepEqual([rrs[0].tier,rrs[0].rr],[25,0]);
  assert.equal(unzip(db.sim_pilot_prev.get('p1').data).length,20,'last 20 games before the act');
  assert.deepEqual(unzip(db.sim_pilot_kast.get('m1').data).p,[['p1',14,2500]]);
  assert.equal(r.remaining,0);
});

test('KAST: a payload without round data is retried, never saved; without the rules the queue is left alone',async()=>{
  const seed={sim_pilot_kast:[['m1','eu']]};
  const {d1,db}=fakeD1(seed);
  const fetchImpl=fakeFetch({'match-detail/eu/m1':[{status:200,body:{data:{metadata:{}}}}]});
  await run({env,fetchImpl,d1,...clock(),log:quiet,kastOf:()=>null});
  assert.equal(db.sim_pilot_kast.get('m1').status,null);assert.equal(db.sim_pilot_kast.get('m1').attempts,1);
  const fresh=fakeD1(seed);
  const r=await run({env,fetchImpl,d1:fresh.d1,...clock(),log:quiet,kastOf:null});
  assert.equal(fresh.db.sim_pilot_kast.get('m1').attempts,null);assert.equal(r.requests,0);
});

// The job loads the KAST rules from index.html at commit f2dd31f (the workflow pins it), not the
// working tree, so later site edits can't change the pilot's numbers.
test('loadKast reproduces tracker on a pinned fixture match (current and older trade rule)',t=>{
  let html;try{html=execFileSync('git',['show','f2dd31f:index.html'],{cwd:new URL('..',import.meta.url),encoding:'utf8',maxBuffer:1<<26});}catch{t.skip('commit f2dd31f not available');return;}
  const kastOf=loadKast(html);
  // Two players per team; e1 kills me at 1.0 s, mate kills e1 at 4.0 s: a trade only under the
  // older 5 s rule (the current rule allows 3 s).
  const players=[['me','Red'],['mate','Red'],['r3','Red'],['r4','Red'],['r5','Red'],['e1','Blue'],['e2','Blue'],['e3','Blue'],['e4','Blue'],['e5','Blue']]
    .map(([puuid,team_id])=>({puuid,team_id}));
  const loc=puuid=>({player:{puuid},location:{x:0,y:0}});
  const m=t=>({metadata:{started_at:t},players,rounds:[{stats:players.map(p=>({player:{puuid:p.puuid},damage_events:[]}))}],
    kills:[{round:0,time_in_round_in_ms:1000,killer:{puuid:'e1'},victim:{puuid:'me'},assistants:[],weapon:{type:'Weapon'},player_locations:players.map(p=>loc(p.puuid))},
      {round:0,time_in_round_in_ms:4000,killer:{puuid:'mate'},victim:{puuid:'e1'},assistants:[],weapon:{type:'Weapon'},player_locations:players.filter(p=>p.puuid!=='me').map(p=>loc(p.puuid))}]});
  const ks=(r,u)=>r.p.find(x=>x[0]===u)[1];
  // The rules themselves are checked against tracker.gg on real matches (docs/adr-kast.md; 40/40 on
  // archive matches in docs/ml-sim-pilot.md); here: each era gets its rule, every player gets a value.
  const before=kastOf(m('2026-10-20T00:00:00Z')),after=kastOf(m('2026-11-05T00:00:00Z'));
  assert.equal(before.old,1);assert.equal(after.old,0);
  assert.equal(ks(before,'me'),1,'older rule: traded within 5 s');
  assert.equal(before.p.length,10);assert.ok(after.p.every(x=>Number.isInteger(x[1])));
  assert.equal(kastOf({metadata:{started_at:'2026-11-05T00:00:00Z'},players,rounds:[],kills:[]}),null,'no rounds: no KAST');
});
