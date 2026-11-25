import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {acquireWorkflowPermit,observeWorkflowQuota,WORKFLOW_SPACING_MS,
  acquirePublicPermit,observePublicQuota,PUBLIC_UNKNOWN_SPACING_MS,
  acquireProfilePermit,PUBLIC_PROFILE_RESERVE,
  PRIORITY_CLAIM_MARGIN_MS,QUOTA_MARGIN,PUBLIC_IN_FLIGHT,PUBLIC_IN_FLIGHT_KNOWN,LEASE_MS,NO_HEADER_429_WAIT_MS,
  RESET_GUARD_MS,QUOTA_WINDOW_MS,BOUNDARY_429_WAIT_MS,
  releasePublicLease} from '../lib/upstream-pacing.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function database(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const s={bind(...v){values=v;return s;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async run(){return sql.prepare(query).run(...values);}};return s;}};
  return {db,sql};
}
const leases=(sql,table='rate_quota')=>JSON.parse(sql.prepare(`SELECT leases FROM ${table}`).get().leases);
const nextStart=(sql,table='rate_quota')=>sql.prepare(`SELECT next_start_at FROM ${table}`).get().next_start_at;
// Run `count` callers through a fake clock; each permit is answered at once.
async function crowd(acquire,answer,count){
  let clock=100000;const waiting=[],permits=[];
  const jobs=Array.from({length:count},()=>acquire({now:()=>clock,maxWaitMs:600000,
    sleepImpl:ms=>new Promise(resolve=>waiting.push({at:clock+ms,resolve}))})
    .then(async permit=>{permits.push(permit);await answer(permit,permits.length,()=>clock);}));
  for(let iteration=0;permits.length<count&&iteration<2000;iteration++){
    await tick();if(!waiting.length)continue;
    clock=Math.min(...waiting.map(w=>w.at));
    const ready=waiting.filter(w=>w.at<=clock),later=waiting.filter(w=>w.at>clock);
    waiting.splice(0,waiting.length,...later);ready.forEach(w=>w.resolve());
  }
  await Promise.all(jobs);
  return {permits,clock};
}

test('serial collector calls keep their spacing and stay below 30 starts a minute',async t=>{
  const {db}=database(t);
  const {permits}=await crowd(o=>acquireWorkflowPermit(db,o),
    (permit,n,now)=>observeWorkflowQuota(db,{remaining:null,resetAt:null},{startedAt:permit.startedAt,now,status:200}),40);
  const starts=permits.map(p=>p.startedAt);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=WORKFLOW_SPACING_MS);
  for(const start of starts)assert.ok(starts.filter(time=>time>=start&&time<start+60000).length<=29);
});

test('the public pool admits more than 30 a minute on a 60-unit key, each answered call setting the count',async t=>{
  const {db,sql}=database(t);
  sql.prepare('UPDATE rate_quota SET remaining=89,reset_at=160000').run();
  const {permits,clock}=await crowd(o=>acquirePublicPermit(db,o),
    (permit,n,now)=>observePublicQuota(db,{remaining:89-n,resetAt:160000},{startedAt:permit.startedAt,now,status:200}),40);
  const starts=permits.map(p=>p.startedAt);
  assert.equal(new Set(starts).size,40);
  // A known count is not spread over the window: only the 150 ms floor.
  for(let i=1;i<starts.length;i++)assert.equal(starts[i]-starts[i-1],150);
  assert.equal(sql.prepare('SELECT remaining FROM rate_quota').get().remaining,49,'HenrikDev\'s count, never a guess');
  assert.deepEqual(leases(sql),[],'every answered call released its lease');
  assert.ok((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).quota,'the collector pool is separate');
});

test('free units are spread over the window and an empty window waits for its reset',async t=>{
  const {db,sql}=database(t);let clock=100000;const T='workflow_rate_quota';
  sql.prepare(`INSERT INTO ${T} (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,4,110000,0,0)`).run();
  const answer=async(permit,remaining)=>observeWorkflowQuota(db,{remaining,resetAt:110000},{startedAt:permit.startedAt,now:()=>clock,status:200});
  const first=await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0});
  assert.equal(first.quota.remaining,3,'4 known, 1 held');
  assert.equal(nextStart(sql,T),102500,'10 s over 4 free units');
  await answer(first,3);
  clock=102500;const second=await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0});
  assert.equal(nextStart(sql,T),105000);
  await answer(second,2);
  clock=105000;
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs,5000,`${QUOTA_MARGIN} units are kept for outside use`);
  clock=110000;
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).quota.remaining,null,'a new window is learned from its first call');
});

test('a known count lets a search\'s opening burst start together instead of queueing',async t=>{
  // Rank, RR history and name history, then three live pages, asked at once
  // with a full window: each starts one 150 ms floor after the last.
  const {db,sql}=database(t);const clock=100000;
  sql.prepare('UPDATE rate_quota SET remaining=58,reset_at=157500').run();
  const starts=[];
  for(const units of [2,2,3,11,11,11]){
    const permit=await acquirePublicPermit(db,{now:()=>clock+150*starts.length,units,maxWaitMs:0});
    assert.ok(permit.quota,`call ${starts.length+1} admitted at once`);
    starts.push(permit.startedAt);
  }
  assert.equal(starts.at(-1)-starts[0],750);
  assert.equal(leases(sql).length,PUBLIC_IN_FLIGHT_KNOWN);
  assert.equal(nextStart(sql),clock+900,'no spread spacing after the burst');
  const seventh=await acquirePublicPermit(db,{now:()=>clock+900,units:2,maxWaitMs:0});
  assert.ok(seventh.retryAfterMs>0&&seventh.retryAfterMs<=250,'the cap still holds');
});

test('a window whose count is unknown keeps the 3-call cap and the unknown spacing',async t=>{
  const {db,sql}=database(t);let clock=100000;
  for(let i=0;i<PUBLIC_IN_FLIGHT;i++){
    assert.ok((await acquirePublicPermit(db,{now:()=>clock,units:11,maxWaitMs:0})).quota);
    assert.equal(nextStart(sql),clock+PUBLIC_UNKNOWN_SPACING_MS);
    clock=nextStart(sql);
  }
  const refused=await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:0});
  assert.ok(refused.retryAfterMs>0&&refused.retryAfterMs<=250,'full at PUBLIC_IN_FLIGHT, not PUBLIC_IN_FLIGHT_KNOWN');
});

test('at most PUBLIC_IN_FLIGHT_KNOWN calls run at once; an answer or an expired lease frees a place',async t=>{
  const {db,sql}=database(t);let clock=100000;
  sql.prepare('UPDATE rate_quota SET remaining=50,reset_at=160000').run();
  const held=[];
  for(let i=0;i<PUBLIC_IN_FLIGHT_KNOWN;i++){held.push(await acquirePublicPermit(db,{now:()=>clock}));clock=nextStart(sql);}
  assert.equal(leases(sql).length,PUBLIC_IN_FLIGHT_KNOWN);
  const refused=await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:0});
  assert.ok(refused.retryAfterMs>0&&refused.retryAfterMs<=250,'busy, not empty: a short wait');
  await observePublicQuota(db,{remaining:47,resetAt:160000},{startedAt:held[0].startedAt,now:()=>clock,status:200});
  assert.ok((await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:0})).quota,'an answer frees its place');
  clock=nextStart(sql);
  assert.ok((await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs>0);
  clock=held[1].startedAt+LEASE_MS+1;
  assert.ok((await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:0})).quota,'a call that never answered gives its place back');
  await releasePublicLease(db,clock,{now:()=>clock});
  assert.ok(!leases(sql).some(lease=>lease.s===clock),'a failed fetch releases its lease at once');
});

test('calls in flight hold their maximum cost until HenrikDev\'s count arrives',async t=>{
  const {db,sql}=database(t);let clock=100000;
  sql.prepare('UPDATE rate_quota SET remaining=30,reset_at=160000').run();
  const page=await acquirePublicPermit(db,{now:()=>clock,units:11});
  assert.equal(page.quota.remaining,19,'30 known, 11 held');
  clock=nextStart(sql);
  const busy=await acquirePublicPermit(db,{now:()=>clock,units:11,maxWaitMs:0});
  assert.ok(busy.retryAfterMs<=250,'30 - 11 held - 11 would leave less than the reserve and margin: wait for the answer');
  const lookup=await acquireProfilePermit(db,{now:()=>clock,units:2});
  assert.equal(lookup.quota.remaining,17);
  // HenrikDev had the page cached: it cost 1.
  await observePublicQuota(db,{remaining:29,resetAt:160000},{startedAt:page.startedAt,now:()=>clock,status:200});
  assert.equal(sql.prepare('SELECT remaining FROM rate_quota').get().remaining,30,'an older call\'s header never sets the count');
  await observePublicQuota(db,{remaining:27,resetAt:160000},{startedAt:lookup.startedAt,now:()=>clock,status:200});
  assert.equal(sql.prepare('SELECT remaining FROM rate_quota').get().remaining,27);
  assert.deepEqual(leases(sql),[]);
  clock=nextStart(sql);
  assert.equal((await acquirePublicPermit(db,{now:()=>clock,units:11})).quota.remaining,16);
});

test('account lookups keep a reserve that other public calls cannot spend, down to the margin',async t=>{
  const {db,sql}=database(t);let clock=100000;const resetAt=clock+60000;
  const floor=QUOTA_MARGIN+PUBLIC_PROFILE_RESERVE;
  sql.prepare('UPDATE rate_quota SET remaining=?,reset_at=?').run(floor+2,resetAt);
  assert.equal((await acquirePublicPermit(db,{now:()=>clock,units:2,maxWaitMs:0})).quota.remaining,floor);
  clock=nextStart(sql);
  sql.prepare('UPDATE rate_quota SET remaining=?,leases=\'[]\'').run(floor+1);
  assert.equal((await acquirePublicPermit(db,{now:()=>clock,units:2,maxWaitMs:60000})).retryAfterMs,resetAt-clock,'into the reserve: back at the reset, at once');
  assert.equal((await acquireProfilePermit(db,{now:()=>clock,units:2})).quota.remaining,floor-1);
  sql.prepare('UPDATE rate_quota SET remaining=?,leases=\'[]\'').run(QUOTA_MARGIN+1);
  clock=nextStart(sql);
  assert.ok((await acquireProfilePermit(db,{now:()=>clock,units:2,maxWaitMs:0})).retryAfterMs>=resetAt-clock,'even account lookups keep the margin');
  clock=Math.max(resetAt,nextStart(sql));
  assert.ok((await acquirePublicPermit(db,{now:()=>clock,maxWaitMs:0})).quota,'a new window opens to every caller');
});

test('a 429 pauses every caller until HenrikDev\'s reset or Retry-After, and briefly without either',async t=>{
  const {db}=database(t);let clock=100000;
  const call=async()=>{const permit=await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:600000,sleepImpl:async ms=>{clock+=ms;}});return permit;};
  let permit=await call();
  assert.equal(await observeWorkflowQuota(db,{remaining:0,resetAt:clock+40000},{startedAt:permit.startedAt,now:()=>clock,status:429,retryAfterMs:9000}),40000,'the later of the two');
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs,40000);
  clock+=40000;permit=await call();
  assert.equal(await observeWorkflowQuota(db,{remaining:null,resetAt:null},{startedAt:permit.startedAt,now:()=>clock,status:429,retryAfterMs:9000}),9000);
  clock+=9000;permit=await call();
  assert.equal(await observeWorkflowQuota(db,{remaining:null,resetAt:null},{startedAt:permit.startedAt,now:()=>clock,status:429}),NO_HEADER_429_WAIT_MS,'no 60 s guess');
  // At the boundary HenrikDev answers 429 with a full window's reset (parsed with the guard).
  clock+=NO_HEADER_429_WAIT_MS;permit=await call();
  assert.equal(await observeWorkflowQuota(db,{remaining:0,resetAt:clock+QUOTA_WINDOW_MS+RESET_GUARD_MS},{startedAt:permit.startedAt,now:()=>clock,status:429}),BOUNDARY_429_WAIT_MS,'the window opens a second later, not in 60 s');
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).retryAfterMs,Math.max(BOUNDARY_429_WAIT_MS,WORKFLOW_SPACING_MS),'only the boundary wait, or the collector spacing');
  clock+=Math.max(BOUNDARY_429_WAIT_MS,WORKFLOW_SPACING_MS);
  assert.equal((await acquireWorkflowPermit(db,{now:()=>clock,maxWaitMs:0})).quota.remaining,null,'reopened, learned from the next answer');
  // A mid-window 429 still waits for the reset it states.
  permit=await call();
  assert.equal(await observeWorkflowQuota(db,{remaining:0,resetAt:clock+30000+RESET_GUARD_MS},{startedAt:permit.startedAt,now:()=>clock,status:429}),30000+RESET_GUARD_MS);
});

test('busy gates return a bounded retry and missing or failed storage never grants admission',async t=>{
  const {db}=database(t);
  const permit=await acquireWorkflowPermit(db,{now:()=>100000});
  await observeWorkflowQuota(db,{remaining:null,resetAt:null},{startedAt:permit.startedAt,now:()=>100000,status:200});
  assert.equal((await acquireWorkflowPermit(db,{now:()=>100000,maxWaitMs:0})).retryAfterMs,2100);
  await assert.rejects(acquireWorkflowPermit(null),/requires APP_DB/);
  await assert.rejects(acquireWorkflowPermit({prepare(){throw new Error('D1 unavailable');}}),/D1 unavailable/);
  await assert.rejects(acquirePublicPermit({prepare(){throw new Error('D1 unavailable');}}),/D1 unavailable/);
});

test('older quota tables are upgraded without losing exhaustion state; only the public one gets claims',async t=>{
  const {db,sql}=database(t);
  sql.exec('DROP TABLE workflow_rate_quota; CREATE TABLE workflow_rate_quota(id INTEGER PRIMARY KEY,remaining INTEGER,reset_at INTEGER,last_request_at INTEGER); INSERT INTO workflow_rate_quota VALUES(1,0,110000,100000)');
  assert.equal((await acquireWorkflowPermit(db,{now:()=>100000,maxWaitMs:0})).retryAfterMs,10000);
  sql.exec('DROP TABLE rate_quota; CREATE TABLE rate_quota(id INTEGER PRIMARY KEY,remaining INTEGER,reset_at INTEGER,last_request_at INTEGER,next_start_at INTEGER NOT NULL DEFAULT 0); INSERT INTO rate_quota VALUES(1,0,110000,100000,0)');
  assert.equal((await acquirePublicPermit(db,{now:()=>100000,maxWaitMs:0})).retryAfterMs,10000);
  const columns=table=>sql.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  for(const name of ['next_start_at','leases'])assert.ok(columns('rate_quota').includes(name)&&columns('workflow_rate_quota').includes(name),name);
  assert.ok(columns('rate_quota').includes('priority_until'));
  assert.ok(!columns('workflow_rate_quota').includes('priority_until'));
});

test('an unknown window checks no units, so the first call can learn the quota',async t=>{
  const {db}=database(t);
  assert.equal((await acquirePublicPermit(db,{now:()=>100000,units:11})).quota.remaining,null);
});

test('a waiting account lookup takes the next public slot ahead of other waiting calls',async t=>{
  const {db,sql}=database(t);let clock=100000;
  sql.prepare('UPDATE rate_quota SET remaining=40,reset_at=160000').run();
  await acquirePublicPermit(db,{now:()=>clock});
  const slot=nextStart(sql);
  assert.ok(slot>clock);
  clock=100100;
  let wake;const profile=acquireProfilePermit(db,{now:()=>clock,sleepImpl:ms=>new Promise(resolve=>{wake=resolve;clock+=ms;})});
  await tick();await tick();await tick();
  assert.equal(sql.prepare('SELECT priority_until FROM rate_quota').get().priority_until,slot+PRIORITY_CLAIM_MARGIN_MS,'claims the slot it waits for');
  const now=()=>slot;
  assert.equal((await acquirePublicPermit(db,{now,maxWaitMs:0})).retryAfterMs,PRIORITY_CLAIM_MARGIN_MS);
  wake();
  const permit=await profile;
  assert.equal(permit.startedAt,slot);
  assert.equal(sql.prepare('SELECT priority_until FROM rate_quota').get().priority_until,0,'admission clears the claim');
  assert.ok((await acquirePublicPermit(db,{now:()=>nextStart(sql),maxWaitMs:0})).quota,'the following slot is open to everyone');
});

test('a claim left by a lookup that gave up holds other calls back only until it lapses',async t=>{
  const {db,sql}=database(t);
  sql.prepare('UPDATE rate_quota SET remaining=40,reset_at=160000,next_start_at=0,priority_until=100300').run();
  assert.equal((await acquirePublicPermit(db,{now:()=>100000,maxWaitMs:0})).retryAfterMs,300);
  assert.ok((await acquireProfilePermit(db,{now:()=>100000,maxWaitMs:0})).quota,'another account lookup is not held back');
  sql.prepare('UPDATE rate_quota SET next_start_at=0,priority_until=100300').run();
  assert.ok((await acquirePublicPermit(db,{now:()=>100300,maxWaitMs:0})).quota);
});

test('an account lookup that will not wait for its slot leaves no claim',async t=>{
  const {db,sql}=database(t);
  sql.prepare('UPDATE rate_quota SET remaining=40,reset_at=160000,next_start_at=109000').run();
  assert.equal((await acquireProfilePermit(db,{now:()=>100000})).retryAfterMs,9000,'beyond the 8 s wait');
  assert.equal(sql.prepare('SELECT priority_until FROM rate_quota').get().priority_until,0);
  sql.prepare('UPDATE rate_quota SET remaining=0').run();
  assert.equal((await acquireProfilePermit(db,{now:()=>100000})).retryAfterMs,60000,'nor does one refused by an empty window');
  assert.equal(sql.prepare('SELECT priority_until FROM rate_quota').get().priority_until,0);
});
