import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createD1Governor,d1Query,readByPuuidRange,D1_MS,D1_META,D1_SLOW_MS} from '../.github/scripts/d1-query.mjs';

const env={CF_API_TOKEN:'t',CF_ACCOUNT_ID:'a',CF_D1_DATABASE_ID:'d'};
const answer=(meta={},results=[{n:1}])=>Response.json({success:true,result:[{success:true,results,meta}]});
function fakeClock(){
  let t=0;const waits=[];
  return {now:()=>t,sleep:async ms=>{waits.push(ms);t+=ms;},advance:ms=>{t+=ms;},waits};
}

test('the governor sends one statement at a time, however many callers there are',async()=>{
  // 24 Nov 2026: four collector workers ran the player read at once.
  const clock=fakeClock(),governor=createD1Governor({now:clock.now,sleep:clock.sleep,log:()=>{}});
  let active=0,most=0;
  const fetchImpl=async()=>{active++;most=Math.max(most,active);await new Promise(r=>setTimeout(r,5));active--;return answer({duration:2});};
  const rows=await Promise.all(Array.from({length:6},(_,i)=>d1Query(env,`SELECT ${i}`,[],fetchImpl,{governor})));
  assert.equal(most,1);
  assert.equal(rows.length,6);
  assert.equal(governor.stats.statements,6);
});

test('after a statement D1 stays free for four times its D1 time, capped, and a failure counts its round trip',async()=>{
  const clock=fakeClock(),governor=createD1Governor({now:clock.now,sleep:clock.sleep,log:()=>{},maxPauseMs:20000});
  const send=(ms,fail=false)=>governor.run('q',async()=>{clock.advance(ms===null?700:50);if(fail)throw new Error('D1 query failed (500)');return {ms};});
  await send(250);
  await send(1);
  assert.deepEqual(clock.waits,[1000],'four times the 250 ms of D1 time, counted from the answer');
  await assert.rejects(send(null,true),/500/);
  await send(2);
  // The failed call reported no D1 time: its 700 ms round trip counts, 2800 ms pause.
  assert.equal(clock.waits.at(-1),2800);
  await send(10000);await send(1);
  assert.equal(clock.waits.at(-1),20000,'capped at maxPauseMs');
});

test('a slow statement is reported with its SQL, and the stats keep the slowest',async()=>{
  const clock=fakeClock(),warnings=[];
  const governor=createD1Governor({now:clock.now,sleep:clock.sleep,log:m=>warnings.push(m)});
  const fetchImpl=async(_url,{body})=>answer({duration:JSON.parse(body).sql.includes('slow')?D1_SLOW_MS+500:3,rows_read:9});
  await d1Query(env,'SELECT   fast',[],fetchImpl,{governor});
  const rows=await d1Query(env,'SELECT slow\n  FROM rr_history',[],fetchImpl,{governor});
  assert.equal(rows[D1_MS],D1_SLOW_MS+500);
  assert.equal(rows[D1_META].rows_read,9);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)),[{n:1}],'timing and meta are not part of the rows');
  assert.deepEqual(warnings,[`::warning::Slow D1 statement (${D1_SLOW_MS+500} ms): SELECT slow FROM rr_history`]);
  assert.deepEqual([governor.stats.statements,governor.stats.slow,governor.stats.slowest.sql],[2,1,'SELECT slow FROM rr_history']);
});

function puuidTable(t,puuids){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec('CREATE TABLE p(puuid TEXT PRIMARY KEY)');
  const insert=sql.prepare('INSERT INTO p VALUES(?)');
  for(const id of puuids)insert.run(id);
  return sql;
}
const random=n=>Array.from({length:n},(_,i)=>{const u=crypto.randomUUID();return i%7===0?u.toUpperCase():u;});

test('PUUID ranges read every row exactly once, whatever the case or the edge values',async t=>{
  const puuids=[...random(3000),'00000000-0000-4000-8000-000000000000','ffffffff-ffff-4fff-bfff-ffffffffffff',
    'FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF','0000000','not-a-uuid','zzz'];
  const sql=puuidTable(t,puuids);
  const range=sql.prepare('SELECT puuid FROM p WHERE puuid>=?1 AND puuid<?2');
  for(const parts of [1,3,16,257]){
    const rows=await readByPuuidRange(async(lo,hi)=>range.all(lo,hi),{parts});
    assert.equal(rows.length,puuids.length,`parts ${parts}`);
    assert.deepEqual(rows.map(r=>r.puuid).sort(),[...puuids].sort());
  }
  const plan=sql.prepare('EXPLAIN QUERY PLAN SELECT puuid FROM p WHERE puuid>=?1 AND puuid<?2').all().map(r=>r.detail).join('\n');
  assert.match(plan,/SEARCH p USING COVERING INDEX \S+ \(puuid>\? AND puuid<\?\)/,'a range on the key, not a scan');
});

test('PUUID ranges shrink when a range is slow and grow when it is fast',async t=>{
  const sql=puuidTable(t,random(2000));
  const range=sql.prepare('SELECT puuid FROM p WHERE puuid>=?1 AND puuid<?2');
  const timed=perRow=>async(lo,hi)=>{const rows=range.all(lo,hi);Object.defineProperty(rows,D1_MS,{value:rows.length*perRow});return rows;};
  // 2000 rows at 1 ms each: 16 parts of 125 ms grow towards the 250 ms target.
  const fast=await readByPuuidRange(timed(1),{parts:16});
  // At 20 ms a row the first range (125 rows, 2.5 s) is ten times the target.
  const slow=await readByPuuidRange(timed(20),{parts:16});
  assert.equal(fast.length,2000);assert.equal(slow.length,2000);
  assert.ok(fast.slices<16,`fast: ${fast.slices} slices`);
  assert.ok(slow.slices>64,`slow: ${slow.slices} slices`);
  // Without a reported time the ranges keep their size.
  assert.equal((await readByPuuidRange(async(lo,hi)=>range.all(lo,hi),{parts:16})).slices,16);
});

test('every script reaches D1 through d1Query, so the governor sees all of it',()=>{
  // A script with its own fetch to the D1 REST API would bypass the governor.
  const offenders=[];
  for(const dir of ['.github/scripts','scripts']){
    const base=new URL(`../${dir}/`,import.meta.url);
    for(const name of readdirSync(base,{recursive:true})){
      if(!/\.(m|c)?js$|\.py$/.test(name)||`${dir}/${name}`.replace(/\\/g,'/')==='.github/scripts/d1-query.mjs')continue;
      if(/\/d1\/database\//.test(readFileSync(new URL(String(name).replace(/\\/g,'/'),base),'utf8')))offenders.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(offenders,[]);
});
