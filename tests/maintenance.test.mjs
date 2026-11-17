import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestGet} from '../functions/api/[[path]].js';
import {maintenance} from '../lib/site-flags.mjs';

const url='https://site.test/api/rank/eu/pc/Alpha/EU';
function fixture(t,flag){
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  if(flag!==undefined){sql.exec('CREATE TABLE site_flags (name TEXT PRIMARY KEY, value TEXT, until INTEGER)');
    if(flag)sql.prepare('INSERT INTO site_flags VALUES (?,?,?)').run('maintenance',flag.token,flag.until??null);}
  t.after(()=>sql.close());
  const APP_DB={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  const env={APP_DB,HENRIK_KEY:'HDEV-public-fixture',HENRIK_WORKFLOW_KEY:'HDEV-workflow-fixture'};
  const upstream=[],old=globalThis.caches;
  globalThis.caches={default:{async match(){return null;},async put(){}}};
  t.after(()=>{if(old===undefined)delete globalThis.caches;else globalThis.caches=old;});
  t.mock.method(globalThis,'fetch',async target=>{upstream.push(String(target));
    return Response.json({data:{}},{headers:{'x-ratelimit-remaining':'50','x-ratelimit-reset':'60'}});});
  const request=async headers=>{const jobs=[];const r=await onRequestGet({env,request:new Request(url,{headers}),waitUntil:p=>jobs.push(p)});await Promise.all(jobs);return r;};
  return{sql,env,upstream,request};
}

test('maintenance: visitors get a 503 that says so, without touching the upstream key',async t=>{
  const f=fixture(t,{token:'tok-1'});
  const r=await f.request({});
  assert.equal(r.status,503);
  const body=await r.json();
  assert.equal(body.maintenance,true);assert.match(body.error,/maintenance/);
  assert.equal(r.headers.get('Cache-Control'),'no-store');
  assert.equal(f.upstream.length,0);
  assert.equal((await f.request({'X-Sim-Pilot':'wrong'})).status,503,'a wrong token is a visitor');
});

test('maintenance: the pilot token reaches the upstream with the public key',async t=>{
  const f=fixture(t,{token:'tok-2'});
  const r=await f.request({'X-Sim-Pilot':'tok-2'});
  assert.equal(r.status,200);assert.equal(f.upstream.length,1);
});

test('maintenance: collectors keep their own pool but never borrow public slots',async t=>{
  const f=fixture(t,{token:'tok-3'});
  f.sql.prepare('INSERT OR REPLACE INTO workflow_rate_quota (id,remaining,reset_at,last_request_at,next_start_at) VALUES (1,0,?,0,0)').run(Date.now()+60000);
  const r=await f.request({'X-Workflow-Key':'HDEV-workflow-fixture'});
  assert.equal(r.status,429,'own pool exhausted: waits instead of borrowing');
  assert.equal(f.upstream.length,0);
});

test('maintenance is off without the table, without the row, or after until',async t=>{
  for(const flag of [undefined,null,{token:'tok-4',until:Date.now()-1000}]){
    const f=fixture(t,flag);
    assert.equal((await f.request({})).status,200);
  }
  assert.equal(await maintenance({prepare(){throw new Error('D1 down');}}),null,'storage errors count as off');
});
