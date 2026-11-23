import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { onRequestGet } from '../functions/api/[[path]].js';
import { memoryBucket } from './helpers/r2-memory.mjs';

const html=readFileSync(new URL('../src/engine/core.mjs',import.meta.url),'utf8');
const extract=(a,b)=>{
  const start=html.indexOf(a),end=html.indexOf(b,start);
  assert.ok(start>=0&&end>start);
  return html.slice(start,end);
};
const transportSource=extract('function sleep(ms,signal)', '\nasync function waitForRateLimit(');
const apiSource=extract('function parseApiError(', '\n// Back-compat alias');
const archiveSource=extract('async function readServerMatchArchive(', '\nasync function readSavedMatchCounts(');
const puuid='11111111-1111-4111-8111-111111111111';
const season='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const abortingFetch=(_url,{signal})=>new Promise((_,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});

function transport(fetch,extra={}){
  return runInNewContext(transportSource+apiSource+'\n({apiGet,fetchApiJson,sleep,createRequestPool})',{
    fetch,AbortController,DOMException,setTimeout,clearTimeout,
    RL_WAIT_FLOOR_MS:1,MAX_WAIT_MS:100,setStatus(){},waitForRateLimit:async()=>{},...extra,
  });
}

test('cancellation aborts an active fetch without retrying',async()=>{
  let calls=0;
  const client=transport((...args)=>{calls++;return abortingFetch(...args);});
  const controller=new AbortController();
  const pending=client.apiGet('/api/example',{signal:controller.signal,quiet:true});
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(calls,1);
});

for(const status of [429,503]){
  test(`cancellation interrupts a ${status} retry wait`,async()=>{
    let calls=0;
    const client=transport(async()=>{calls++;return Response.json({retryAfterMs:100},{status});});
    const controller=new AbortController();
    const pending=client.apiGet('/api/example',{signal:controller.signal,quiet:true});
    await tick();
    controller.abort();
    await assert.rejects(pending,{name:'AbortError'});
    assert.equal(calls,1);
  });
}

test('a storage 503 is not retried because the proxy already spent the upstream call',async()=>{
  let calls=0;
  const client=transport(async()=>{calls++;return Response.json({error:'RR corpus could not be saved',storage:'unavailable'},{status:503});});
  await assert.rejects(client.apiGet('/api/example',{quiet:true}),/API 503/);
  assert.equal(calls,1);
});

test('the timeout covers a stalled JSON body as well as a stalled connection',async()=>{
  const client=transport(async(_url,{signal})=>({ok:true,json:()=>abortingFetch('',{signal})}));
  await assert.rejects(client.fetchApiJson('/api/example',{timeoutMs:10}),{name:'TimeoutError'});
});

test('the request pool caps concurrency and removes cancelled queued work',async()=>{
  const client=transport(async()=>Response.json({}));
  const pool=client.createRequestPool(2);
  const release1=await pool.acquire(),release2=await pool.acquire();
  const controller=new AbortController();
  const queued=pool.acquire(controller.signal);
  controller.abort();
  await assert.rejects(queued,{name:'AbortError'});
  let started=false;
  const next=pool.acquire().then(release=>{started=true;return release;});
  await tick();
  assert.equal(started,false);
  release1();
  const release3=await next;
  release2();release3();
  const release4=await pool.acquire();release4();
});

// Payloads live in R2 with an empty D1 payload; inline:true keeps the
// pre-R2 layout, which must stay readable until the migration finishes.
async function archiveDb(matches,{inline=false}={}){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE match_archive (puuid TEXT,season_id TEXT,match_id TEXT,started_at TEXT,payload BLOB,bytes INTEGER)');
  db.exec('CREATE INDEX archive_order ON match_archive(puuid,season_id,started_at DESC,match_id DESC)');
  const insert=db.prepare('INSERT INTO match_archive VALUES (?,?,?,?,?,?)');
  const bucket=memoryBucket();
  for(const [i,match] of matches.entries()){
    const stream=new Blob([JSON.stringify(match)]).stream().pipeThrough(new CompressionStream('gzip'));
    const payload=new Uint8Array(await new Response(stream).arrayBuffer());
    const id=String(i).padStart(4,'0');
    if(!inline)await bucket.put(`matches/${id}.json.gz`,payload);
    insert.run(puuid,season,id,new Date(2000000000000-i*1000).toISOString(),inline?payload:new Uint8Array(0),inline?null:payload.byteLength);
  }
  return{db,bucket,binding:{bucket,prepare(sql){return{bind(...args){return{async all(){return{results:db.prepare(sql).all(...args)};}};}};}}};
}

async function archiveRequest(binding,query){
  return onRequestGet({request:new Request(`https://example.test/api/match-archive/${puuid}/${season}${query}`),
    env:{APP_DB:binding,MATCH_BUCKET:binding.bucket},waitUntil(){}});
}

// A client over the real proxy handler; `hold` lets a test pause chosen requests.
function archiveClient(binding,{hold=()=>null}={}){
  const calls=[],done=[];let inFlight=0,peak=0;
  const context={_analysisGen:1,API_BASE:'/api',...transport(async()=>Response.json({}))};
  context.fetchApiJson=async url=>{
    const target=new URL(url,'https://example.test'),query=target.search;
    calls.push(query);inFlight++;peak=Math.max(peak,inFlight);
    try{
      await hold(query);
      const r=await onRequestGet({request:new Request(target),env:{APP_DB:binding,MATCH_BUCKET:binding.bucket},waitUntil(){}});
      const j=await r.json();done.push(query);
      return{r,j};
    }finally{inFlight--;}
  };
  return{calls,done,peak:()=>peak,context,read:runInNewContext(archiveSource+'\nreadServerMatchArchive',context)};
}

// archiveClient records the plan request (match-archive-pages) as ''.
const PLAN='';

test('a 200-match archive loads its planned pages in parallel and publishes them in order',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:200},(_,id)=>({id})));
  t.after(()=>db.close());
  const client=archiveClient(binding),pages=[];
  let complete=false;
  const rows=await client.read(puuid,season,1,()=>true,{onPage:page=>pages.push([...page.map(row=>row.id)]),onComplete:()=>{complete=true;}});
  assert.deepEqual([...rows.map(row=>row.id)],Array.from({length:200},(_,id)=>id));
  // Published batches follow each other with no gap or overlap.
  assert.deepEqual(pages.flat(),Array.from({length:200},(_,id)=>id));
  assert.ok(complete);
  // The plan and the first page load together, then the other three pages
  // at once: no request is spent past the end.
  assert.deepEqual(client.calls.slice(0,2),['?start=0&size=50',PLAN]);
  assert.deepEqual(client.calls.slice(2).sort(),['?start=100&size=50','?start=150&size=50','?start=50&size=50']);
  assert.ok(client.peak()>=3&&client.peak()<=7,`peak ${client.peak()}`);
});

test('an archive that fits one page costs one page request beside the plan',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:30},(_,id)=>({id})));
  t.after(()=>db.close());
  const client=archiveClient(binding);
  let complete=false;
  assert.equal((await client.read(puuid,season,1,()=>true,{onComplete:()=>{complete=true;}})).length,30);
  assert.deepEqual(client.calls,['?start=0&size=50',PLAN]);
  assert.equal(client.peak(),2,'the plan does not delay the first page');
  assert.ok(complete);
});

test('the page plan cuts pages exactly where cursor paging does',async t=>{
  // Mixed compressed sizes: random padding does not compress.
  const sizes=[0,40,300,0,0,250,120,0,90,0];
  const {db,binding}=await archiveDb(Array.from({length:130},(_,id)=>({id,padding:randomBytes(sizes[id%10]*512).toString('base64')})));
  t.after(()=>db.close());
  const plan=(await (await onRequestGet({request:new Request(`https://example.test/api/match-archive-pages/${puuid}/${season}`),
    env:{APP_DB:binding,MATCH_BUCKET:binding.bucket},waitUntil(){}})).json()).data;
  const cursor=[];
  for(let start=0;start!==null;){
    const page=await (await archiveRequest(binding,`?start=${start}&size=50`)).json();
    cursor.push([start,page.data.length]);
    start=page.nextStart;
  }
  assert.equal(plan.total,130);
  assert.deepEqual(plan.pages,cursor);
  assert.ok(plan.pages.length>3,'the compressed budget cuts some pages short');
  const empty=await onRequestGet({request:new Request(`https://example.test/api/match-archive-pages/${puuid}/${randomUUID()}`),
    env:{APP_DB:binding,MATCH_BUCKET:binding.bucket},waitUntil(){}});
  assert.deepEqual((await empty.json()).data,{total:0,pages:[]});
});

test('an empty archive reports completion after the first page and the plan',async t=>{
  const {db,binding}=await archiveDb([]);
  t.after(()=>db.close());
  const client=archiveClient(binding);
  let complete=false;
  assert.equal((await client.read(puuid,season,1,()=>true,{onComplete:()=>{complete=true;}})).length,0);
  assert.deepEqual(client.calls,['?start=0&size=50',PLAN]);
  assert.ok(complete);
});

test('a later page that answers first is held until the earlier pages publish',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:150},(_,id)=>({id})));
  t.after(()=>db.close());
  const slow=deferred();
  const client=archiveClient(binding,{hold:query=>query==='?start=50&size=50'?slow.promise:null});
  const pages=[];
  const result=client.read(puuid,season,1,()=>true,{onPage:page=>pages.push(page[0].id)});
  for(let i=0;i<400&&!client.done.includes('?start=100&size=50');i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(client.done.includes('?start=100&size=50'));
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(pages,[0],'chunk 100 must wait for chunk 50');
  slow.resolve();
  assert.equal((await result).length,150);
  // Chunks 50 and 100 are then both ready and publish as one update.
  assert.deepEqual(pages,[0,50]);
});

test('budget-cut chunks are finished from the cursor without gaps or overlap',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:120},(_,id)=>({id,padding:id%7===0?'x'.repeat(3*1024*1024):''})));
  t.after(()=>db.close());
  const client=archiveClient(binding);
  const rows=await client.read(puuid,season,1);
  assert.deepEqual([...rows.map(row=>row.id)],Array.from({length:120},(_,id)=>id));
  assert.ok(client.calls.some(query=>!query.endsWith('size=50')),'a short chunk is refilled with a smaller size');
});

test('a failed later page keeps the published prefix and does not report completion',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:150},(_,id)=>({id})));
  t.after(()=>db.close());
  const client=archiveClient(binding);
  const real=client.context.fetchApiJson;
  client.context.fetchApiJson=async(url,opts)=>url.includes('start=100&')?{r:{ok:false},j:{}}:real(url,opts);
  let complete=false;
  const rows=await client.read(puuid,season,1,()=>true,{onComplete:()=>{complete=true;}});
  assert.deepEqual([...rows.map(row=>row.id)],Array.from({length:100},(_,id)=>id));
  assert.equal(complete,false);
  client.context.fetchApiJson=async()=>({r:{ok:false},j:{}});
  await assert.rejects(client.read(puuid,season,1),/Match archive unavailable/);
});

test('bounded archive pages continue even when fewer than fifty rows fit',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:4},(_,id)=>({id,padding:'x'.repeat(3*1024*1024)})));
  t.after(()=>db.close());
  const first=await (await archiveRequest(binding,'?start=0&size=50')).json();
  assert.equal(first.data.length,2);
  assert.equal(first.nextStart,2);
  const second=await (await archiveRequest(binding,`?start=${first.nextStart}&size=50`)).json();
  assert.equal(second.data.length,2);
  assert.equal(second.nextStart,null);
  assert.deepEqual([...first.data,...second.data].map(row=>row.id),[0,1,2,3]);
});

test('a single oversized compressed row makes progress without loading the rest',async t=>{
  const {db,binding}=await archiveDb([{id:0,padding:randomBytes(600000).toString('hex')},{id:1}]);
  t.after(()=>db.close());
  const first=await (await archiveRequest(binding,'?start=0&size=50')).json();
  assert.equal(first.data.length,1);
  assert.equal(first.nextStart,1);
  const second=await (await archiveRequest(binding,'?start=1&size=50')).json();
  assert.equal(second.data[0].id,1);
  assert.equal(second.nextStart,null);
});

test('pre-R2 inline payloads still read until the migration empties them',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:3},(_,id)=>({id})),{inline:true});
  t.after(()=>db.close());
  const page=await (await archiveRequest(binding,'?start=0&size=50')).json();
  assert.deepEqual(page.data.map(row=>row.id),[0,1,2]);
  assert.equal(binding.bucket.stats.gets,0);
});

test('archive pagination preserves old clients and validates page sizes',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:11},(_,id)=>({id})));
  t.after(()=>db.close());
  const first=await (await archiveRequest(binding,'?start=0')).json();
  assert.equal(first.data.length,10);
  assert.equal(first.nextStart,10);
  assert.equal((await archiveRequest(binding,'?size=100')).status,400);
  assert.equal((await archiveRequest(binding,'?size=0')).status,400);
  assert.equal((await archiveRequest(binding,'?start=-1&size=50')).status,400);
});

test('the archive client can talk to an older proxy and ignores superseded responses',async()=>{
  let calls=0;
  const context={_analysisGen:1,API_BASE:'/api',fetchApiJson:async()=>{
    calls++;return{r:{ok:true},j:{data:calls===1?Array.from({length:10},(_,id)=>({id})):[]}};
  }};
  const read=runInNewContext(archiveSource+'\nreadServerMatchArchive',context);
  assert.equal((await read(puuid,season,1)).length,10);
  // The first page, the plan request it does not understand, then the
  // empty page that ends a cursorless archive.
  assert.equal(calls,3);
  const pending=deferred();
  context.fetchApiJson=()=>pending.promise;
  const pages=[];
  const result=read(puuid,season,1,()=>true,{onPage:page=>pages.push(page)});
  context._analysisGen=2;
  pending.resolve({r:{ok:true},j:{data:[{id:'stale'}],nextStart:null}});
  assert.equal((await result).length,0);
  assert.equal(pages.length,0);
});

function analysisClient({count=200,archiveWait=null,rrWait=null,storedFailure=false,backend={coverage:new Map(),archives:new Map()}}={}){
  const urls=[],renders=[];
  const makeRows=n=>Array.from({length:n},(_,i)=>({metadata:{match_id:`match-${i}`,season:{id:season},
    started_at:new Date(2000000000000-i*1000).toISOString()},players:[{puuid}]}));
  const state={rows:makeRows(count),region:'eu',storedFailure};
  const scans=new Map();
  const key=()=>state.region+':pc:'+season;
  const context={
    seasonOptions:[{value:season,label:'',games:0,countKind:null}],seasonValue:season,searchText:'Example#123',
    trackerHref:'',errorMessage:null,analysisState:'loading',emit(){},
    console,AbortController,Date,Set,Map,Promise,API_BASE:'/api',BATCH:10,PLAYER:'Example',TAG:'123',REGION:'eu',PLATFORM:'pc',
    TARGET_SEASON:season,PUUID:puuid,_analysisGen:0,_analysisController:null,PUUID_RE:/^[0-9a-f-]{36}$/,
    allMatches:[],headerRevealPending:true,_rrChangeByMatchId:{},_refundedRRByMatchId:{},_derankProtectedByMatchId:{},
    _preRRByMatchId:{},_postRRByMatchId:{},_postTierByMatchId:{},_preTierByMatchId:{},
    setTimeout:()=>0,setProgress(){},setStatus(){},setSeasonMatchCount(){},showSeasonSelect(){},showSeasonIdle(){},
    writePlayerRoute(){},finalizeHeader(){},updateSeasonDropdown(){},updateSeasonTriggerLabel(){},updateDetailPages(){},
    accountUrlFor:()=>'/api/account/Example/123',loadNameHistory:async()=>{},readSavedMatchCounts:async()=>({}),
    refreshTeammateNames:()=>{},lookupTeammateRows:()=>[],
    currentActId:()=>season,loadSeasonDates:async()=>{},getActInfoByUuid:()=>({start:1000}),getSeasonOrder:()=>[],
    parseSearchInput:()=>({key:'Example#123'}),isSeason:row=>row.metadata?.season?.id===season,
    actOptionLabel:()=>'',renderSeasonOptions(){},
    tagActPlacements:rows=>rows,tagPostResetPlacements:rows=>rows,
    createRequestPool:()=>({}),
    processMatch:row=>({id:row.metadata.match_id,startedAtMs:Date.parse(row.metadata.started_at),myRR:context._rrChangeByMatchId[row.metadata.match_id]??null}),
    renderAll:()=>renders.push(context.allMatches.map(row=>({...row}))),
    readServerMatchArchive:async(_id,_act,_gen,_relevant,opts)=>{
      if(archiveWait){opts.onPage([state.rows[0]]);await archiveWait.promise;}
      const saved=[...(backend.archives.get(key())||[])];
      if(saved.length)opts.onPage(saved);
      opts.onComplete();return saved;
    },
    fetchApiJson:async(_url,opts={})=>{
      if(opts.method==='POST'){
        if(!state.storedFailure){
          backend.archives.set(key(),[...state.rows]);
          backend.coverage.set(key(),{matchIds:state.rows.map(m=>m.metadata.match_id),liveIds:state.rows.map(m=>m.metadata.match_id)});
        }
        return{r:{ok:true},j:{data:{verified:!state.storedFailure}}};
      }
      const scanId=randomUUID();scans.set(scanId,true);
      const coverage=backend.coverage.get(key())||null;
      return{r:{ok:true},j:{data:{scanId,coverage}}};
    },
    apiGet:async url=>{
      urls.push(url);
      if(url.includes('/account/'))return{j:{data:{puuid,name:'Example',tag:'123',region:state.region}}};
      if(url.includes('/rank/'))return{j:{data:{seasonal:[],current:{tier:{id:10},rr:30}}}};
      if(url.includes('/mmr-history/')){
        if(rrWait)await rrWait.promise;
        return{j:{data:{history:[{match_id:state.rows[0]?.metadata.match_id,last_change:20,elo:720,
          date:'2026-01-01',season:{short:'test'},tier:{id:10}}]}}};
      }
      if((url.includes('/history/')||url.includes('/history-by-puuid/'))||url.includes('/history-by-puuid/')){
        const start=Number(new URL(url,'https://example.test').searchParams.get('start'));
        return{j:{data:state.rows.slice(start,start+10)}};
      }
      if(url.includes('/stored-matches/')){
        if(state.storedFailure)throw new Error('Unavailable');
        const page=Number(new URL(url,'https://example.test').searchParams.get('page'));
        const rows=state.rows.slice((page-1)*100,page*100);
        return{j:{data:rows.map(row=>({meta:{id:row.metadata.match_id,season:{id:season},
          started_at:row.metadata.started_at},stats:{puuid}})),results:{after:page*100>=state.rows.length?0:100}}};
      }
      throw new Error('Unexpected URL '+url);
    },
  };
  context.fetchWithRetry=(...args)=>context.apiGet(...args);
  const source=extract('async function beginServerActScan(', '\n/* ── RENDER ALL');
  const api=runInNewContext(source+'\n({loadAll})',context);
  return{...api,context,urls,renders,state,makeRows,backend};
}

test('live matches load before the archive and RR finish, then RR is attached',async()=>{
  const archiveWait=deferred(),rrWait=deferred();
  const client=analysisClient({count:30,archiveWait,rrWait});
  const pending=client.loadAll();
  await tick();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,4);
  assert.equal(client.context.allMatches.length,30);
  assert.equal(client.context.allMatches.find(row=>row.id==='match-0').myRR,null);
  archiveWait.resolve();rrWait.resolve();
  await pending;
  assert.equal(client.context.allMatches.find(row=>row.id==='match-0').myRR,20);
});

test('verified repeat searches refresh only new pages and retain all matches',async()=>{
  const client=analysisClient();
  await client.loadAll();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,21);
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,2);
  assert.equal(client.context.allMatches.length,200);
  const newRows=client.makeRows(3).map((row,i)=>({...row,metadata:{...row.metadata,match_id:`new-${i}`,
    started_at:new Date(2000000010000-i*1000).toISOString()}}));
  client.state.rows.unshift(...newRows);
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,3);
  assert.equal(client.context.allMatches.length,203);
});

test('old-format archive refresh scans once, then explicit null PS retains incremental loading',async()=>{
  const client=analysisClient({count:50});
  await client.loadAll();
  const key='eu:pc:'+season;
  client.backend.archives.set(key,client.state.rows.map(row=>({...row,_performanceRefreshNeeded:true})));
  client.state.rows=client.state.rows.map(row=>({...row,players:[{puuid,performance:null}]}));
  client.urls.length=0;
  await client.loadAll();
  assert.ok(client.urls.filter(url=>url.includes('/history-by-puuid/')).length>=5,
    'saved coverage must not stop before old-format payloads have been refreshed');
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>url.includes('/history-by-puuid/')).length,2,
    'genuinely unavailable scores must not trigger another full scan');
});

test('partial scans and a region transfer cannot enable incremental early stopping',async()=>{
  const client=analysisClient({count:30,storedFailure:true});
  await client.loadAll();
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,4);
  client.state.storedFailure=false;
  await client.loadAll();
  client.state.region='na';
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,4);
  assert.ok(client.urls.some(url=>url.includes('/history-by-puuid/na/')));
});

test('the stored-matches index loads beside the live scan, not after it',async()=>{
  const client=analysisClient();
  await client.loadAll();
  const firstStored=client.urls.findIndex(url=>url.includes('/stored-matches/'));
  const lastLive=client.urls.findLastIndex(url=>url.includes('/history-by-puuid/'));
  assert.ok(firstStored>=0&&firstStored<lastLive,client.urls.join('\n'));
  // Recovery still requests nothing it already has, and the scan certifies.
  assert.equal(client.urls.filter(url=>url.includes('/match-detail/')).length,0);
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>url.includes('/history-by-puuid/')).length,2);
});

test('another tab reuses durable coverage without a time window',async()=>{
  const first=analysisClient({count:30});
  await first.loadAll();
  const next=analysisClient({count:30,backend:first.backend});
  next.context.Date=class extends Date{static now(){return Date.now()+30*86400000;}};
  await next.loadAll();
  assert.equal(next.urls.filter(url=>url.includes('/history-by-puuid/')).length,2);
  assert.equal(next.context.allMatches.length,30);
});

test('a partial archive read falls back to a full live scan despite durable coverage',async()=>{
  const first=analysisClient();
  await first.loadAll();
  const next=analysisClient({backend:first.backend});
  next.context.readServerMatchArchive=async(_id,_act,_gen,_relevant,opts)=>{
    const page=first.state.rows.slice(0,50);opts.onPage(page);return page;
  };
  await next.loadAll();
  assert.equal(next.urls.filter(url=>url.includes('/history-by-puuid/')).length,21);
  assert.equal(next.context.allMatches.length,200);
});

test('a superseded account response cannot change the active player or region',async()=>{
  const client=analysisClient({count:20});
  const oldAccount=deferred();
  const original=client.context.apiGet;
  let accounts=0,firstSignal;
  client.context.apiGet=(url,opts)=>{
    if(!url.includes('/account/'))return original(url,opts);
    if(++accounts===1){firstSignal=opts.signal;return oldAccount.promise;}
    return Promise.resolve({j:{data:{puuid,name:'New',tag:'456',region:'na'}}});
  };
  const oldRun=client.loadAll();
  await tick();
  await client.loadAll();
  assert.equal(firstSignal.aborted,true);
  oldAccount.resolve({j:{data:{puuid,name:'Old',tag:'123',region:'eu'}}});
  await oldRun;
  assert.equal(client.context.PLAYER,'New');
  assert.equal(client.context.REGION,'na');
});

test('late RR from a superseded search cannot overwrite the active RR maps',async()=>{
  const client=analysisClient({count:20});
  const oldRR=deferred();
  const original=client.context.apiGet;
  let requests=0;
  client.context.apiGet=(url,opts)=>{
    if(url.includes('/mmr-history/')&&++requests===1)return oldRR.promise;
    return original(url,opts);
  };
  const oldRun=client.loadAll();
  await tick();
  await client.loadAll();
  oldRR.resolve({j:{data:{history:[{match_id:'match-0',last_change:999,date:'2026-01-01'}]}}});
  await oldRun;
  assert.equal(client.context._rrChangeByMatchId['match-0'],20);
  assert.equal(client.context.allMatches.find(row=>row.id==='match-0').myRR,20);
});
