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
  assert.equal(client.peak(),3,`peak ${client.peak()}`);
});

test('the other planned pages wait for the first page, so it is not slowed down',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:120},(_,id)=>({id})));
  t.after(()=>db.close());
  const first=deferred();
  const client=archiveClient(binding,{hold:query=>query==='?start=0&size=50'?first.promise:null});
  const result=client.read(puuid,season,1);
  for(let i=0;i<400&&!client.done.includes(PLAN);i++)await new Promise(r=>setTimeout(r,5));
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(client.calls,['?start=0&size=50',PLAN],'the plan has arrived, but no other page starts yet');
  first.resolve();
  assert.equal((await result).length,120);
  assert.deepEqual(client.calls.slice(2).sort(),['?start=100&size=20','?start=50&size=50']);
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
  // Three pages and the empty end page, plus the two look-ahead pages past it.
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,6);
  assert.equal(client.context.allMatches.length,30);
  assert.equal(client.context.allMatches.find(row=>row.id==='match-0').myRR,null);
  archiveWait.resolve();rrWait.resolve();
  await pending;
  assert.equal(client.context.allMatches.find(row=>row.id==='match-0').myRR,20);
});

// Counts live history requests in flight; each answer waits a few turns so
// requests issued together overlap.
function trackLivePages(client){
  const apiGet=client.context.apiGet;
  const live={now:0,max:0};
  client.context.apiGet=async(url,...rest)=>{
    if(!url.includes('/history-by-puuid/')&&!url.includes('/history/'))return apiGet(url,...rest);
    live.now++;live.max=Math.max(live.max,live.now);
    try{await tick();await tick();return await apiGet(url,...rest);}finally{live.now--;}
  };
  client.context.fetchWithRetry=(...args)=>client.context.apiGet(...args);
  return live;
}
const livePageStarts=urls=>urls.filter(url=>url.includes('/history-by-puuid/'))
  .map(url=>Number(new URL(url,'https://example.test').searchParams.get('start')));

test('a full scan keeps three live pages in flight and still publishes every match once',async()=>{
  const client=analysisClient();
  const live=trackLivePages(client);
  await client.loadAll();
  assert.equal(live.max,3);
  assert.equal(client.context.allMatches.length,200);
  assert.deepEqual([...client.context.allMatches.map(m=>m.id)],client.state.rows.map(m=>m.metadata.match_id));
});

test('a verified search looks one page ahead and costs no extra live request',async()=>{
  const client=analysisClient();
  await client.loadAll();
  const live=trackLivePages(client);
  client.urls.length=0;
  await client.loadAll();
  assert.equal(live.max,2);
  assert.deepEqual(livePageStarts(client.urls),[0,10]);
});

test('look-ahead pauses at the previous act, so a full scan asks for one page past it',async()=>{
  const client=analysisClient({count:25});
  const older=client.makeRows(40).map((row,i)=>({...row,metadata:{...row.metadata,match_id:`older-${i}`,
    season:{id:'99999999-9999-4999-8999-999999999999'},started_at:new Date(2000000000000-(100+i)*1000).toISOString()}}));
  client.state.rows.push(...older);
  await client.loadAll();
  // Page 20 reaches the previous act and page 30 ends the scan; page 40 was
  // already requested when page 20 arrived, nothing after it.
  assert.deepEqual(livePageStarts(client.urls),[0,10,20,30,40]);
  assert.equal(client.context.allMatches.length,25);
});

// Holds the rank response until released, to see what starts before it.
function holdRank(client){
  const rank=deferred(),apiGet=client.context.apiGet;
  client.context.apiGet=async(url,...rest)=>{
    if(url.includes('/rank/'))await rank.promise;
    return apiGet(url,...rest);
  };
  client.context.fetchWithRetry=(...args)=>client.context.apiGet(...args);
  return rank;
}
const settle=async()=>{for(let i=0;i<20;i++)await tick();};

test('a current-act search starts its live scan before the rank request answers',async()=>{
  const client=analysisClient();
  await client.loadAll();
  const rank=holdRank(client);
  client.urls.length=0;
  const pending=client.loadAll();
  await settle();
  assert.deepEqual(livePageStarts(client.urls),[0,10]);
  rank.resolve();await pending;
  // The scan reused both early pages and requested nothing more.
  assert.deepEqual(livePageStarts(client.urls),[0,10]);
  assert.equal(client.context.allMatches.length,200);
});

test('without a chosen act, saved current-act matches start the scan early; none, and it waits for rank',async()=>{
  const client=analysisClient({count:30});
  client.context.TARGET_SEASON='';
  let rank=holdRank(client);
  const first=client.loadAll();
  await settle();
  assert.deepEqual(livePageStarts(client.urls),[],'nothing saved yet: the act is not certain before rank');
  rank.resolve();await first;
  client.context.TARGET_SEASON='';
  client.context.readSavedMatchCounts=async()=>({[season]:30});
  client.urls.length=0;
  const second=client.loadAll();
  await settle();
  assert.deepEqual(livePageStarts(client.urls),[0,10]);
});

test('an older act never starts the current act early',async()=>{
  const client=analysisClient({count:30});
  client.context.currentActId=()=>'99999999-9999-4999-8999-999999999999';
  client.context.readSavedMatchCounts=async()=>({'99999999-9999-4999-8999-999999999999':5,[season]:30});
  const rank=holdRank(client);
  const pending=client.loadAll();
  await settle();
  assert.equal(client.urls.filter(url=>url.includes('/history')).length,0);
  rank.resolve();await pending;
  assert.ok(client.urls.every(url=>!url.includes('history-by-puuid')||!url.includes('99999999')));
});

test('verified repeat searches refresh only new pages and retain all matches',async()=>{
  const client=analysisClient();
  await client.loadAll();
  // A full scan: 20 pages, the empty end page and two look-ahead pages past it.
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,23);
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
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,6);
  client.state.storedFailure=false;
  await client.loadAll();
  client.state.region='na';
  client.urls.length=0;
  await client.loadAll();
  assert.equal(client.urls.filter(url=>(url.includes('/history/')||url.includes('/history-by-puuid/'))).length,6);
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
  assert.equal(next.urls.filter(url=>url.includes('/history-by-puuid/')).length,23);
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

// ── Older-act start search (findHistoryStartForAct), 24 Nov 2026 ──
const seekSource=extract('const MAX_HISTORY_OFFSET=',"// Henrik's stored-matches endpoint");
const ACT_BOUNDARY=Date.parse('2026-10-14T00:00:00Z'),HOUR=3600000;
// A live list, newest first: `newer` matches after the boundary, then `older`.
function liveList(newer,older){
  return Array.from({length:newer+older},(_,i)=>({metadata:{match_id:`m-${i}`,
    started_at:new Date(i<newer?ACT_BOUNDARY+(newer-i)*HOUR:ACT_BOUNDARY-(i-newer+1)*HOUR).toISOString()}}));
}
// Probes answer a tick later, so probes sent together overlap; `rounds`
// groups them by the requests in flight at once.
function seekClient(list){
  const probes=[],rounds=[];let inFlight=0;
  const context={API_BASE:'/api',REGION:'eu',PLATFORM:'pc',PLAYER:'Example',TAG:'123',_analysisGen:1,BATCH:10,setStatus(){},
    apiGet:async url=>{
      assert.match(url,/[?&]size=1&/);
      const offset=Number(new URL(url,'https://example.test').searchParams.get('start'));
      probes.push(offset);
      if(!inFlight)rounds.push([]);
      rounds.at(-1).push(offset);inFlight++;
      try{await tick();return{j:{data:list[offset]?[list[offset]]:[]}};}finally{inFlight--;}
    }};
  return{...runInNewContext(seekSource+'\n({findHistoryStartForAct,createStoredTimeline})',context),probes,rounds};
}
// A stored-matches timeline of the given rows, in 100-row pages.
function storedTimeline(client,list){
  const timeline=client.createStoredTimeline();
  const rows=list.map(m=>({meta:{started_at:m.metadata.started_at}}));
  for(let i=0;i<rows.length;i+=100)timeline.add(rows.slice(i,i+100),i+100>=rows.length);
  timeline.close();
  return timeline;
}
// The search this replaced: one-match probes in a row, bisecting 0..5000.
function binarySearchStart(list,boundary){
  let lo=0,hi=5000,probes=0;
  while(lo<hi){
    const mid=Math.floor((lo+hi)/2);probes++;
    const match=list[mid];
    if(match&&Date.parse(match.metadata.started_at)>=boundary)lo=mid+1;else hi=mid;
  }
  return{start:Math.max(0,lo-10),probes};
}

test('a right MMR guess finds an older act in one round of two probes (was 12 in a row)',async()=>{
  // The production case: 164 games in the act after the selected one.
  const list=liveList(164,300),client=seekClient(list);
  assert.equal(await client.findHistoryStartForAct(ACT_BOUNDARY,1,()=>{},{},{estimate:164}),154);
  assert.deepEqual(client.rounds,[[163,164]]);
  const before=binarySearchStart(list,ACT_BOUNDARY);
  assert.equal(before.start,154);
  assert.equal(before.probes,12);
});

test('a wrong or missing MMR guess is corrected from the stored index in one more round',async()=>{
  const list=liveList(164,300);
  // A region transfer can leave the MMR totals too high, zero or absent.
  for(const [estimate,rounds] of [[200,[[199,200],[163,164]]],[0,[[0],[163,164]]],[null,[[163,164]]]]){
    const client=seekClient(list);
    const start=await client.findHistoryStartForAct(ACT_BOUNDARY,1,()=>{},{},{estimate,storedTimeline:storedTimeline(client,list)});
    assert.equal(start,154);
    assert.deepEqual(client.rounds,rounds,`estimate ${estimate}`);
  }
});

test('the act search waits for the stored index only until it passes the boundary',async()=>{
  const list=liveList(164,300),client=seekClient(list);
  const timeline=client.createStoredTimeline();
  const rows=list.map(m=>({meta:{started_at:m.metadata.started_at}}));
  const pending=client.findHistoryStartForAct(ACT_BOUNDARY,1,()=>{},{},{storedTimeline:timeline});
  timeline.add(rows.slice(0,100));
  await tick();await tick();
  assert.equal(client.probes.length,0,'page 1 ends before the boundary');
  timeline.add(rows.slice(100,200)); // the index goes on loading for the act itself
  assert.equal(await pending,154);
  assert.deepEqual(client.rounds,[[163,164]]);
});

test('without a usable guess the act search still proves the offset',async()=>{
  const list=liveList(164,300);
  // The stored index failed before the boundary, and there is no MMR guess.
  const client=seekClient(list);
  const timeline=client.createStoredTimeline();
  timeline.close();
  assert.equal(await client.findHistoryStartForAct(ACT_BOUNDARY,1,()=>{},{},{storedTimeline:timeline}),154);
  assert.ok(client.rounds.every(round=>round.length===1));
  // Unreadable dates still mean a scan from the newest match.
  const bad=liveList(164,300);bad[163]={metadata:{started_at:'invalid'}};
  const badClient=seekClient(bad);
  assert.equal(await badClient.findHistoryStartForAct(ACT_BOUNDARY,1,()=>{},{},{estimate:164}),0);
});

test('the act search proves the same offset as the binary search for any guess',async t=>{
  // Deterministic pseudo-random cases: wrong guesses, stored rows missing
  // from or extra to the live list, short lists and empty acts.
  let seed=12345;
  const random=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  let probes=0,rounds=0,before=0,worst=0;
  for(let run=0;run<300;run++){
    const newer=random(4)===0?random(12):random(700),older=random(4)===0?0:random(400);
    const list=liveList(newer,older),client=seekClient(list);
    const stored=list.filter(()=>random(10)!==0);
    for(let k=random(20);k>0&&stored.length;k--){
      const at=random(stored.length);
      stored.splice(at,0,stored[at]); // a stored-only match at the same time
    }
    const kind=random(4);
    const hints={estimate:kind===0?null:newer+random(81)-40,storedTimeline:kind===3?undefined:storedTimeline(client,stored)};
    const expected=binarySearchStart(list,ACT_BOUNDARY);
    assert.equal(await client.findHistoryStartForAct(ACT_BOUNDARY,1,()=>{},{},hints),expected.start,`run ${run}`);
    probes+=client.probes.length;rounds+=client.rounds.length;before+=expected.probes;
    worst=Math.max(worst,client.rounds.length);
  }
  t.diagnostic(`${rounds} rounds, ${probes} probes, worst ${worst} rounds; binary search ${before} probes`);
  assert.ok(rounds<before/2,`${rounds} rounds (${probes} probes) against ${before} probes in a row`);
  assert.ok(worst<=13,`worst case ${worst} rounds`); // the binary search took 12-13
});

test('an older-act search seeds from MMR and starts its scan on a newer-act overlap page',async()=>{
  const NEWER='33333333-3333-4333-8333-333333333333',OLDER='44444444-4444-4444-8444-444444444444';
  const targetStart=ACT_BOUNDARY-60*24*HOUR;
  const client=analysisClient();
  const make=(n,act,from)=>Array.from({length:n},(_,i)=>({metadata:{match_id:`${act.slice(0,4)}-${i}`,season:{id:act},
    started_at:new Date(from-(i+1)*HOUR).toISOString()},players:[{puuid}]}));
  const rows=[...make(37,NEWER,ACT_BOUNDARY+40*HOUR),...make(25,season,ACT_BOUNDARY),...make(30,OLDER,targetStart)];
  const meta={[NEWER]:{start:ACT_BOUNDARY},[season]:{start:targetStart},[OLDER]:{start:targetStart-60*24*HOUR}};
  Object.assign(client.context,{_actMeta:meta,currentActId:()=>NEWER,getActInfoByUuid:id=>meta[id.toLowerCase()]||null});
  const original=client.context.apiGet;
  client.context.apiGet=async(url,...rest)=>{
    if(url.includes('/rank/')){client.urls.push(url);return{j:{data:{current:null,seasonal:[
      {season:{id:NEWER},games:37},{season:{id:season},games:25},{season:{id:OLDER},games:30}]}}};}
    const query=new URL(url,'https://example.test').searchParams,start=Number(query.get('start'));
    if(url.includes('/history/')&&query.get('size')==='1'){client.urls.push(url);return{j:{data:rows.slice(start,start+1)}};}
    if(url.includes('/history-by-puuid/')){client.urls.push(url);return{j:{data:rows.slice(start,start+10)}};}
    if(url.includes('/stored-matches/')){client.urls.push(url);return{j:{data:rows.map(row=>({meta:{id:row.metadata.match_id,
      season:row.metadata.season,started_at:row.metadata.started_at},stats:{puuid}})),results:{after:0}}};}
    return original(url,...rest);
  };
  await client.loadAll();
  const probeStarts=client.urls.filter(url=>url.includes('size=1&'))
    .map(url=>Number(new URL(url,'https://example.test').searchParams.get('start')));
  assert.deepEqual(probeStarts,[36,37]);
  assert.equal(livePageStarts(client.urls)[0],27,'one page of overlap before the act');
  assert.ok(rows.slice(27,37).every(row=>row.metadata.season.id===NEWER),'the first page is all newer act');
  assert.equal(client.context.allMatches.length,25);
});
