import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequestGet } from '../functions/api/[[path]].js';

const puuid='11111111-1111-4111-8111-111111111111';

test('stored RR history route fixes the page size, validates the page and goes through the quota gate',async t=>{
  const urls=[];
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const APP_DB={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  const cache=new Map();
  globalThis.caches={default:{async match(key){return cache.get(key.url)?.clone();},
    async put(key,response){cache.set(key.url,response.clone());}}};
  globalThis.fetch=async url=>{urls.push(url);return Response.json({data:[{match_id:'m',tier:{id:24},ranking_in_tier:42,date:'2026-11-01T00:00:00Z'}]});};
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;});
  const request=async path=>{
    sql.prepare('UPDATE rate_quota SET next_start_at=0').run();
    const jobs=[];
    const response=await onRequestGet({request:new Request(`https://example.test/api/${path}`),
      env:{APP_DB,HENRIK_KEY:'test'},waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs);
    return response;
  };
  const r=await request(`stored-mmr-history/eu/${puuid}?page=3&size=999`);
  assert.equal(r.status,200);
  assert.equal((await r.json()).data[0].ranking_in_tier,42);
  assert.equal(urls[0],`https://api.henrikdev.xyz/valorant/v1/by-puuid/stored-mmr-history/eu/${puuid}?page=3&size=100`);
  for(const bad of ['0','101','x','1.5'])assert.equal((await request(`stored-mmr-history/eu/${puuid}?page=${bad}`)).status,400,bad);
  assert.equal((await request('stored-mmr-history/eu/not-a-puuid')).status,404);
  assert.equal(urls.length,1,'invalid requests never reach HenrikDev');
});
