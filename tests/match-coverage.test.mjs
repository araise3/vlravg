import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequestGet,onRequestPost } from '../functions/api/[[path]].js';

const puuid='11111111-1111-4111-8111-111111111111';
const season='22222222-2222-4222-8222-222222222222';
const newer='33333333-3333-4333-8333-333333333333';
const older='44444444-4444-4444-8444-444444444444';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row=(n,s=season)=>({metadata:{match_id:id(n),season:{id:s},started_at:new Date(2000000000000-n*1000).toISOString()},players:[{puuid}]});
const compact=m=>({meta:{id:m.metadata.match_id,season:m.metadata.season,started_at:m.metadata.started_at,region:'eu'},stats:{puuid}});

function fixture(t,{live=Array.from({length:23},(_,n)=>row(n)),stored=live}={}){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const statement=(sql,args=[])=>({
    bind(...values){return statement(sql,values);},
    async first(){return db.prepare(sql).get(...args)||null;},
    async all(){return{results:db.prepare(sql).all(...args)};},
    async run(){return{meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
    execute(){return /^\s*(SELECT|WITH)/i.test(sql)?{results:db.prepare(sql).all(...args)}:
      {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
  });
  const binding={prepare:sql=>statement(sql),async batch(statements){
    db.exec('BEGIN');
    try{const result=statements.map(stmt=>stmt.execute());db.exec('COMMIT');return result;}
    catch(e){db.exec('ROLLBACK');throw e;}
  }};
  const cache=new Map(),upstreamCalls=[];
  const savedFetch=globalThis.fetch,savedCaches=globalThis.caches;
  const state={live,stored,failWrites:false};
  globalThis.caches={default:{async match(key){return cache.get(key.url)?.clone();},async put(key,response){cache.set(key.url,response.clone());}}};
  globalThis.fetch=async address=>{
    upstreamCalls.push(address);
    const url=new URL(address);
    let data;
    if(url.pathname.includes('/by-puuid/matches/')){
      const start=Number(url.searchParams.get('start'));
      data=state.live.slice(start,start+10);
    }else if(url.pathname.includes('/stored-matches/')){
      const page=Number(url.searchParams.get('page'));
      return Response.json({data:state.stored.slice((page-1)*100,page*100).map(compact),results:{after:page*100>=state.stored.length?0:100}});
    }else if(url.pathname.includes('/v4/match/')){
      data=state.stored.find(match=>match.metadata.match_id===url.pathname.split('/').at(-1));
      if(!data)return Response.json({error:'Missing'},{status:404});
    }else throw new Error('Unexpected upstream '+address);
    return Response.json({data});
  };
  t.after(()=>{globalThis.fetch=savedFetch;globalThis.caches=savedCaches;db.close();});
  const path=(region='eu',platform='pc',act=season)=>`match-coverage/${region}/${platform}/${puuid}/${act}`;
  const request=async(route,{body,failWrites=false}={})=>{
    // This fixture tests archive coverage; admission timing has its own tests.
    db.prepare('UPDATE rate_quota SET last_request_at=0,next_start_at=0 WHERE id=1').run();
    const env={APP_DB:failWrites?{...binding,batch:async()=>{throw new Error('Write failed');}}:binding,HENRIK_KEY:'test'};
    const jobs=[];
    const request=new Request('https://example.test/api/'+route,body===undefined?{}:
      {method:'POST',headers:{'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
    const response=body===undefined?await onRequestGet({request,env,waitUntil:p=>jobs.push(p)}):await onRequestPost({request,env});
    await Promise.allSettled(jobs);
    // Real quota state is never exposed, on cache hits or misses.
    assert.equal(response.headers.get('ratelimit'),null);
    assert.equal(response.headers.get('x-ratelimit-remaining'),null);
    return response;
  };
  const begin=async(region='eu',platform='pc',act=season)=>(await (await request(path(region,platform,act))).json()).data;
  const livePage=(scan,start,opts)=>request(`history-by-puuid/eu/pc/${puuid}?start=${start}&scan=${scan.scanId}`,opts);
  const storedPage=(scan,page=1)=>request(`stored-matches/eu/${puuid}?page=${page}&scan=${scan.scanId}`);
  const finish=async(scan,act=season)=>(await (await request(path('eu','pc',act),{body:{scanId:scan.scanId}})).json()).data;
  const full=async(scan)=>{
    for(let start=0;;){
      const data=(await (await livePage(scan,start)).json()).data;
      if(!data.length)break;
      start+=data.length;
    }
    for(let page=1;;page++){
      const payload=await (await storedPage(scan,page)).json();
      if(!payload.data.length||payload.results.after===0)break;
    }
  };
  return{db,binding,state,path,request,begin,livePage,storedPage,finish,full,upstreamCalls,cache};
}

test('coverage survives fresh visitors and arbitrary elapsed time',async t=>{
  const f=fixture(t),first=await f.begin();
  assert.equal(first.coverage,null);
  await f.full(first);
  assert.deepEqual(await f.finish(first),{verified:true});
  f.db.prepare("UPDATE match_archive_coverage SET verified_at='2020-01-01T00:00:00Z'").run();
  const visitor=await f.begin();
  assert.notEqual(visitor.scanId,first.scanId);
  assert.equal(visitor.coverage.matchIds.length,23);
  assert.equal(visitor.coverage.liveIds.length,23);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive_scan_pages').get().n,0);
  assert.ok(f.upstreamCalls.every(url=>!url.includes('scan=')));
});

test('incremental verification uses trusted cached pages and keeps all older IDs',async t=>{
  const f=fixture(t),first=await f.begin();
  await f.full(first);await f.finish(first);
  const before=f.upstreamCalls.length,second=await f.begin();
  assert.equal((await f.livePage(second,0)).headers.get('X-Proxy-Cache'),'HIT');
  await f.livePage(second,10);await f.storedPage(second);
  assert.deepEqual(await f.finish(second),{verified:true});
  assert.equal(f.upstreamCalls.length,before);
  assert.equal((await f.begin()).coverage.matchIds.length,23);
});

test('a browser cannot assert completeness without observed page evidence',async t=>{
  const f=fixture(t),scan=await f.begin();
  assert.equal((await f.request(f.path(),{body:{scanId:scan.scanId,complete:true,matchCount:23}})).status,400);
  assert.deepEqual(await f.finish(scan),{verified:false});
  assert.equal((await f.begin()).coverage,null);
  assert.equal((await f.request(f.path(),{body:'x'.repeat(257)})).status,400);
});

test('missing pages and a short last page do not establish coverage',async t=>{
  const f=fixture(t),scan=await f.begin();
  await f.livePage(scan,0);await f.livePage(scan,20);await f.livePage(scan,23);await f.storedPage(scan);
  assert.deepEqual(await f.finish(scan),{verified:false});
  const second=await f.begin();
  await f.livePage(second,0);await f.livePage(second,10);await f.livePage(second,20);await f.storedPage(second);
  assert.deepEqual(await f.finish(second),{verified:false});
});

test('failed archive writes cannot certify coverage even when match responses succeed',async t=>{
  const f=fixture(t),scan=await f.begin();
  assert.equal((await f.livePage(scan,0,{failWrites:true})).status,200);
  await f.livePage(scan,10);await f.livePage(scan,20);await f.livePage(scan,23);await f.storedPage(scan);
  assert.deepEqual(await f.finish(scan),{verified:false});
  assert.equal((await f.begin()).coverage,null);
});

test('deleting a covered match invalidates durable coverage even if counts match',async t=>{
  const f=fixture(t),scan=await f.begin();
  await f.full(scan);await f.finish(scan);
  const payload=f.db.prepare('SELECT payload FROM match_archive LIMIT 1').get().payload;
  f.db.prepare('DELETE FROM match_archive WHERE match_id=?').run(id(22));
  f.db.prepare('INSERT INTO match_archive (puuid,season_id,match_id,payload) VALUES (?,?,?,?)').run(puuid,season,id(999),payload);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive').get().n,23);
  assert.equal((await f.begin()).coverage,null);
});

test('coverage is scoped by region, platform and act',async t=>{
  const f=fixture(t),scan=await f.begin();
  await f.full(scan);await f.finish(scan);
  assert.equal((await f.begin('na')).coverage,null);
  assert.equal((await f.begin('eu','console')).coverage,null);
  assert.equal((await f.begin('eu','pc',older)).coverage,null);
});

test('older-act coverage requires a newer-act overlap, not an arbitrary mid-act offset',async t=>{
  const live=[...Array.from({length:12},(_,n)=>row(n,newer)),...Array.from({length:13},(_,n)=>row(n+12)),row(25,older)];
  const f=fixture(t,{live}),scan=await f.begin();
  await f.livePage(scan,2);await f.livePage(scan,12);await f.livePage(scan,22);await f.livePage(scan,26);
  await f.storedPage(scan);
  assert.deepEqual(await f.finish(scan),{verified:true});
  const mid=await f.begin('eu','pc',newer);
  await f.livePage(mid,10);await f.livePage(mid,20);await f.livePage(mid,26);await f.storedPage(mid);
  assert.deepEqual(await f.finish(mid,newer),{verified:false});
});

test('stored-index matches need full payloads saved before coverage can be certified',async t=>{
  const live=Array.from({length:20},(_,n)=>row(n)),extra=row(20);
  const f=fixture(t,{live,stored:[...live,extra]}),scan=await f.begin();
  await f.full(scan);
  assert.deepEqual(await f.finish(scan),{verified:false});
  assert.equal((await f.request(`match-detail/eu/${extra.metadata.match_id}?scan=${scan.scanId}`)).status,200);
  assert.deepEqual(await f.finish(scan),{verified:true});
  assert.equal((await f.begin()).coverage.matchIds.length,21);
});

test('unavailable coverage storage fails open for normal match fetching',async()=>{
  const route=`https://example.test/api/match-coverage/eu/pc/${puuid}/${season}`;
  assert.equal((await onRequestGet({request:new Request(route),env:{}})).status,503);
  assert.equal((await onRequestPost({request:new Request(route,{method:'POST',body:'{}'}),env:{}})).status,503);
});

test('a slower concurrent scan cannot erase matches another visitor verified',async t=>{
  const f=fixture(t,{live:Array.from({length:20},(_,n)=>row(n))});
  const slow=await f.begin(),fast=await f.begin();
  await f.full(slow);
  f.state.live.push(row(20));f.state.stored=f.state.live;
  f.cache.clear();
  await f.full(fast);
  assert.deepEqual(await f.finish(fast),{verified:true});
  assert.deepEqual(await f.finish(slow),{verified:true});
  assert.equal((await f.begin()).coverage.matchIds.length,21);
});
