import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { onRequestGet } from '../functions/api/[[path]].js';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
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

async function archiveDb(matches){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE match_archive (puuid TEXT,season_id TEXT,match_id TEXT,started_at TEXT,payload BLOB)');
  db.exec('CREATE INDEX archive_order ON match_archive(puuid,season_id,started_at DESC,match_id DESC)');
  const insert=db.prepare('INSERT INTO match_archive VALUES (?,?,?,?,?)');
  for(const [i,match] of matches.entries()){
    const stream=new Blob([JSON.stringify(match)]).stream().pipeThrough(new CompressionStream('gzip'));
    const payload=new Uint8Array(await new Response(stream).arrayBuffer());
    insert.run(puuid,season,String(i).padStart(4,'0'),new Date(2000000000000-i*1000).toISOString(),payload);
  }
  return{db,binding:{prepare(sql){return{bind(...args){return{async all(){return{results:db.prepare(sql).all(...args)};}};}};}}};
}

async function archiveRequest(binding,query){
  return onRequestGet({request:new Request(`https://example.test/api/match-archive/${puuid}/${season}${query}`),
    env:{APP_DB:binding},waitUntil(){}});
}

test('a 200-match archive loads in four requests and publishes each page immediately',async t=>{
  const {db,binding}=await archiveDb(Array.from({length:200},(_,id)=>({id})));
  t.after(()=>db.close());
  let requests=0;
  const pages=[];
  const context={_analysisGen:1,API_BASE:'/api',...transport(async()=>Response.json({}))};
  context.fetchApiJson=async url=>{
    requests++;
    const r=await archiveRequest(binding,new URL(url,'https://example.test').search);
    return{r,j:await r.json()};
  };
  const read=runInNewContext(archiveSource+'\nreadServerMatchArchive',context);
  const rows=await read(puuid,season,1,()=>true,{onPage:page=>pages.push(page.length)});
  assert.equal(rows.length,200);
  assert.equal(new Set(rows.map(row=>row.id)).size,200);
  assert.equal(requests,4);
  assert.deepEqual(pages,[50,50,50,50]);
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
  assert.equal(calls,2);
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
  const seasonSelect={options:[{value:''},{value:season}],value:season};
  const context={
    console,AbortController,Date,Set,Map,Promise,API_BASE:'/api',BATCH:10,PLAYER:'Example',TAG:'123',REGION:'eu',PLATFORM:'pc',
    TARGET_SEASON:season,PUUID:puuid,_analysisGen:0,_analysisController:null,PUUID_RE:/^[0-9a-f-]{36}$/,
    allMatches:[],headerRevealPending:true,_rrChangeByMatchId:{},_refundedRRByMatchId:{},_derankProtectedByMatchId:{},
    _preRRByMatchId:{},_postRRByMatchId:{},_postTierByMatchId:{},_preTierByMatchId:{},
    setTimeout:()=>0,setProgress(){},setStatus(){},setSeasonMatchCount(){},showSeasonSelect(){},showSeasonIdle(){},
    writePlayerRoute(){},finalizeHeader(){},updateSeasonDropdown(){},updateSeasonTriggerLabel(){},updateDetailPages(){},
    accountUrlFor:()=>'/api/account/Example/123',loadNameHistory:async()=>{},readSavedMatchCounts:async()=>({}),
    currentActId:()=>season,loadSeasonDates:async()=>{},getActInfoByUuid:()=>({start:1000}),getSeasonOrder:()=>[],
    parseSearchInput:()=>({key:'Example#123'}),isSeason:row=>row.metadata?.season?.id===season,
    actOptionLabel:()=>'',renderSeasonOptions(){},
    tagActPlacements:rows=>rows,tagPostResetPlacements:rows=>rows,
    createRequestPool:()=>({}),
    processMatch:row=>({id:row.metadata.match_id,startedAtMs:Date.parse(row.metadata.started_at),myRR:context._rrChangeByMatchId[row.metadata.match_id]??null}),
    renderAll:()=>renders.push(context.allMatches.map(row=>({...row}))),
    document:{getElementById:id=>id==='m-season'?seasonSelect:id==='m-nametag'?{value:'Example#123'}:{setAttribute(){}}},
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
