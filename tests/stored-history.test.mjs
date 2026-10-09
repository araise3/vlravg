import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { onRequestGet } from '../functions/api/[[path]].js';

const puuid='11111111-1111-4111-8111-111111111111';
const season='22222222-2222-4222-8222-222222222222';

test('stored routes fix archive page size and fetch full detail by match ID',async t=>{
  const urls=[];
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const APP_DB={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  const cache=new Map([[`https://example.test/api/match-detail/eu/${puuid}`,Response.json({data:{legacy:true}})]]);
  globalThis.caches={default:{async match(key){return cache.get(key.url)?.clone();},
    async put(key,response){cache.set(key.url,response.clone());}}};
  globalThis.fetch=async url=>{
    urls.push(url);
    return Response.json({data:[]});
  };
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const request=async path=>{
    // Routing assertions are independent of admission timing, tested separately.
    sql.prepare('UPDATE rate_quota SET next_start_at=0').run();
    const jobs=[];
    const response=await onRequestGet({request:new Request(`https://example.test/api/${path}`),
      env:{APP_DB,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs);
    return response;
  };
  assert.equal((await request(`stored-matches/eu/${puuid}?page=2&size=999&mode=custom`)).status,200);
  assert.equal(urls[0],`https://api.henrikdev.xyz/valorant/v1/by-puuid/stored-matches/eu/${puuid}?mode=competitive&size=100&page=2`);
  assert.equal((await request(`stored-matches/eu/${puuid}?page=0`)).status,400);
  assert.equal(urls.length,1);
  assert.equal((await request(`match-detail/eu/${puuid}?page=999`)).status,200);
  assert.equal(urls[1],`https://api.henrikdev.xyz/valorant/v4/match/eu/${puuid}`);
  assert.ok(cache.has(`https://example.test/api/match-detail/eu/${puuid}?_payload=performance-v1`),
    'new schema bypasses the old day-long detail cache once');
  assert.equal((await request(`match-detail/eu/${puuid}?_payload=anything&force=1`)).headers.get('X-Proxy-Cache'),'HIT');
  assert.equal(urls.length,2,'caller query strings must not force repeated upstream refreshes');
});

test('archive recovery fetches full details only for missing matches in the selected season',async()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const start=html.indexOf('async function recoverStoredSeasonMatches(');
  const end=html.indexOf('\nasync function loadAll(',start);
  assert.ok(start>0&&end>start);
  const urls=[];
  const context={
    PUUID:puuid,TARGET_SEASON:season,REGION:'eu',API_BASE:'/api',_analysisGen:1,
    getActInfoByUuid:()=>({start:Date.parse('2026-01-01T00:00:00Z')}),
    isSeason:m=>m.metadata?.season?.id===season,
    setStatus(){},setProgress(){},
    apiGet:async url=>{
      urls.push(url);
      if(url.includes('/stored-matches/'))return{j:{data:[
        {meta:{id:'live',season:{id:season},started_at:'2026-02-03T00:00:00Z'},stats:{puuid}},
        {meta:{id:'archive',season:{id:season},started_at:'2026-02-02T00:00:00Z'},stats:{puuid}},
        {meta:{id:'other',season:{id:'another'},started_at:'2026-02-01T00:00:00Z'},stats:{puuid}},
      ],results:{after:0}}};
      return{j:{data:{metadata:{match_id:'archive',season:{id:season}},players:[{puuid}]}}};
    },
  };
  const recover=runInNewContext(html.slice(start,end)+'\nrecoverStoredSeasonMatches',context);
  const matches=[{metadata:{match_id:'live'}}];
  await recover(matches,new Set(),1);
  assert.equal(matches.length,2);
  assert.equal(matches[1].metadata.match_id,'archive');
  assert.deepEqual(urls,[`/api/stored-matches/eu/${puuid}?page=1`, '/api/match-detail/eu/archive']);
});

test('unavailable old match details do not prevent later archived games from loading',async()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const start=html.indexOf('async function recoverStoredSeasonMatches(');
  const end=html.indexOf('\nasync function loadAll(',start);
  const ids=['missing-1','missing-2','missing-3','available'];
  const context={
    PUUID:puuid,TARGET_SEASON:season,REGION:'eu',API_BASE:'/api',_analysisGen:1,
    setStatus(){},setProgress(){},isSeason:()=>true,getActInfoByUuid:()=>null,
    apiGet:async url=>{
      if(url.includes('/stored-matches/'))return{j:{data:ids.map(id=>({meta:{id,season:{id:season}},stats:{puuid}})),results:{after:0}}};
      const id=url.split('/').at(-1);
      if(id!=='available')throw new Error('API 404 (code 0): Match not found');
      return{j:{data:{metadata:{match_id:id},players:[{puuid}]}}};
    },
  };
  const recover=runInNewContext(html.slice(start,end)+'\nrecoverStoredSeasonMatches',context);
  const matches=[];
  await recover(matches,new Set(),1);
  assert.equal(matches.length,1);
  assert.equal(matches[0].metadata.match_id,'available');
});

test('archive recovery fetches transferred matches from their recorded region',async()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const start=html.indexOf('async function recoverStoredSeasonMatches(');
  const end=html.indexOf('\nasync function loadAll(',start);
  const urls=[];
  const context={
    PUUID:puuid,TARGET_SEASON:season,REGION:'eu',API_BASE:'/api',_analysisGen:1,
    setStatus(){},setProgress(){},isSeason:()=>true,getActInfoByUuid:()=>null,
    apiGet:async url=>{
      urls.push(url);
      if(url.includes('/stored-matches/'))return{j:{data:[
        {meta:{id:'old-na-match',region:'na',season:{id:season}},stats:{puuid}},
      ],results:{after:0}}};
      return{j:{data:{metadata:{match_id:'old-na-match'},players:[{puuid}]}}};
    },
  };
  const recover=runInNewContext(html.slice(start,end)+'\nrecoverStoredSeasonMatches',context);
  const matches=[];
  await recover(matches,new Set(),1);
  assert.equal(matches.length,1);
  assert.deepEqual(urls,[`/api/stored-matches/eu/${puuid}?page=1`,'/api/match-detail/na/old-na-match']);
});
