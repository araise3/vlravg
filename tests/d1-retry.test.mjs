import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {withD1Retry,withD1RetryContext,isD1Overloaded,D1_RETRY_DELAYS_MS} from '../lib/d1-retry.mjs';
import {acquirePublicPermit} from '../lib/upstream-pacing.mjs';

const OVERLOAD='D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.';
// A D1-shaped binding over SQLite that fails the next `failures` calls.
function flakyDb(t,{failures=0,message=OVERLOAD}={}){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  const state={failures,calls:0,batches:0};
  const fail=()=>{state.calls++;if(state.failures>0){state.failures--;throw new Error(message);}};
  class Statement{
    constructor(query,values=[]){this.query=query;this.values=values;}
    bind(...values){return new Statement(this.query,values);}
    args(){return Object.fromEntries(this.values.map((v,i)=>['?'+(i+1),v]));}
    async first(){fail();const row=sql.prepare(this.query).all(this.args())[0];return row?{...row}:null;}
    async all(){fail();return {results:sql.prepare(this.query).all(this.args())};}
    async run(){fail();const r=sql.prepare(this.query).run(this.args());return {meta:{changes:r.changes}};}
    async raw(){fail();return sql.prepare(this.query).all(this.args()).map(Object.values);}
  }
  const db={prepare:query=>new Statement(query),
    async batch(statements){fail();state.batches++;
      if(!statements.every(s=>s instanceof Statement))throw new Error('batch needs the binding\'s own statements');
      return Promise.all(statements.map(s=>s.run()));},
    exec:async text=>{sql.exec(text);return {count:1};}};
  return {db,sql,state};
}
const noWait={sleep:async ms=>{waits.push(ms);},random:()=>0.5};
let waits=[];

test('an overloaded D1 is retried with growing waits, then answers',async t=>{
  waits=[];
  const {db,state}=flakyDb(t,{failures:3});
  const wrapped=withD1Retry(db,noWait);
  assert.deepEqual(await wrapped.prepare('SELECT ?1+1 AS n').bind(41).first(),{n:42});
  assert.equal(state.calls,4);
  assert.deepEqual(waits,D1_RETRY_DELAYS_MS.slice(0,3));
});

test('an overload that outlasts every wait, and any other error, is thrown unchanged',async t=>{
  waits=[];
  const lasting=flakyDb(t,{failures:99});
  await assert.rejects(withD1Retry(lasting.db,noWait).prepare('SELECT 1').all(),{message:OVERLOAD});
  assert.equal(lasting.state.calls,D1_RETRY_DELAYS_MS.length+1);
  const broken=flakyDb(t,{failures:1,message:'D1_ERROR: no such table: rate_quota'});
  await assert.rejects(withD1Retry(broken.db,noWait).prepare('SELECT 1').run(),/no such table/);
  assert.equal(broken.state.calls,1,'not retried');
  assert.ok(isD1Overloaded(new Error(OVERLOAD))&&isD1Overloaded('D1 DB is overloaded. Too many requests queued.'));
  assert.ok(!isD1Overloaded(new Error('D1 query failed (500)')));
});

test('a batch is retried whole and gets the binding\'s own statements',async t=>{
  waits=[];
  const {db,sql,state}=flakyDb(t,{failures:1});
  sql.exec('CREATE TABLE x(v INTEGER)');
  const wrapped=withD1Retry(db,noWait);
  await wrapped.batch([wrapped.prepare('INSERT INTO x VALUES(?1)').bind(1),wrapped.prepare('INSERT INTO x VALUES(?1)').bind(2)]);
  assert.equal(state.batches,1);
  assert.deepEqual(sql.prepare('SELECT v FROM x ORDER BY v').all().map(r=>r.v),[1,2]);
  assert.equal((await wrapped.exec('SELECT 1')).count,1,'other methods pass through');
});

test('the quota gate admits through a brief overload instead of failing',async t=>{
  // 24 Nov 2026: 98 gate admissions failed within 6 s and visitors got 503s.
  waits=[];
  const {db,state}=flakyDb(t);
  const wrapped=withD1Retry(db,noWait);
  assert.ok((await acquirePublicPermit(wrapped,{units:2})).startedAt,'a cold table is created through the wrapper');
  state.failures=2;
  const permit=await acquirePublicPermit(wrapped,{units:2,sleepImpl:async()=>{}});
  assert.ok(permit.startedAt||permit.retryAfterMs);
  assert.equal(state.failures,0);
  state.failures=99;
  await assert.rejects(acquirePublicPermit(wrapped,{units:2}),{message:OVERLOAD},'still fails closed when it lasts');
});

test('the request context keeps its methods and only swaps APP_DB',async t=>{
  const {db}=flakyDb(t,{failures:1});
  const context={request:{url:'https://x/api/a'},env:{APP_DB:db,OTHER:'kept'},waits:[],
    waitUntil(promise){this.waits.push(promise);}};
  const wrapped=withD1RetryContext(context,noWait);
  wrapped.waitUntil(Promise.resolve());
  assert.equal(context.waits.length,1);
  assert.equal(wrapped.env.OTHER,'kept');
  assert.deepEqual(await wrapped.env.APP_DB.prepare('SELECT 7 AS n').first(),{n:7});
  assert.equal(context.env.APP_DB,db,'the original env is untouched');
  assert.equal(withD1RetryContext({env:{}}).env.APP_DB,undefined);
});
