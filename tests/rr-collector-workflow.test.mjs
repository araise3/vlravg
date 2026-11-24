import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {runCollector,healGap,dailyAudit,stepSummary,HEAL_EVERY,RETRY_MS,FEATURE_BATCH} from '../.github/scripts/collect-rr-corpus.mjs';

const T0=Date.parse('2026-11-24T12:00:00Z'),HOUR=3600000;
const ago=h=>new Date(T0-h*HOUR).toISOString();
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const origin='https://test';
// A heavy player polls every 12 hours: checked 36 hours ago is three intervals overdue.
const heavy=(n,hoursAgo)=>({puuid:uuid(n),region:'eu',platform:'pc',games_7d:40,last_played_at:ago(1),checked_at:ago(hoursAgo)});

// The site's proxy, simulated: every call takes two seconds of the fake clock.
function harness({players,gaps=[],features=[],respond={}}={}){
  let t=T0;
  const calls=[];
  const clock={now:()=>t,sleep:async ms=>{t+=Math.max(1,ms);}};
  const fetchImpl=async url=>{
    t+=2000;
    const path=new URL(url).pathname.split('/').slice(2);
    calls.push(path.slice(0,1).concat(path.at(-1)).join(':'));
    const custom=respond[path[0]]?.(path,calls);
    if(custom)return custom;
    if(path[0]==='rr-collect')return Response.json({data:{puuid:path[3],checked_at:new Date(t).toISOString(),new_games:2,
      newest_date:new Date(t-HOUR).toISOString(),window_from:new Date(t-48*HOUR).toISOString(),possible_gap:false,gap:null}});
    if(path[0]==='rr-heal')return Response.json({data:{puuid:path[1],after_match_id:path[2],done:true,status:'healed',recovered:3,breaks:0}});
    if(path[0]==='rr-feature')return Response.json({data:{puuid:path[2],match_id:path[3],saved:true}});
    return Response.json({},{status:404});
  };
  let featureLoads=0;
  const run=options=>runCollector({origin,fetchImpl,deadline:T0+HOUR,now:clock.now,sleep:clock.sleep,sleepImpl:clock.sleep,
    log:()=>{},concurrency:1,discoveryLimit:0,
    loadPlayers:async()=>players.map(p=>({...p})),loadGaps:async()=>gaps.splice(0),
    loadFeatures:async()=>featureLoads++?[]:features,...options});
  return {run,calls,clock};
}

test('due polls go most overdue first, heals interleave, spare calls fill features, nothing else is polled',async()=>{
  const players=[heavy(1,13),heavy(2,36),heavy(3,24),...Array.from({length:8},(_,i)=>heavy(10+i,14)),heavy(9,1)];
  const gap={puuid:uuid(1),after_match_id:'gap-1',after_date:ago(30),before_date:ago(13),region:'eu',platform:'pc',status:'open',attempts:0,recovered:0};
  const h=harness({players,gaps:[gap],features:[{puuid:uuid(1),match_id:'m1',region:'eu'},{puuid:uuid(2),match_id:'m2',region:'eu'}]});
  const report=await h.run();
  assert.deepEqual(h.calls.slice(0,2),[`rr-collect:${uuid(2)}`,`rr-collect:${uuid(3)}`],'three, then two intervals overdue');
  const healAt=h.calls.indexOf('rr-heal:gap-1');
  assert.equal(healAt,HEAL_EVERY-1,'one task in five heals while polls are due');
  const polls=h.calls.filter(c=>c.startsWith('rr-collect'));
  assert.equal(polls.length,11);
  assert.ok(!polls.includes(`rr-collect:${uuid(9)}`),'checked an hour ago: not due');
  assert.ok(h.calls.indexOf('rr-feature:m1')>h.calls.lastIndexOf(polls.at(-1)),'features only after every due poll');
  assert.deepEqual([report.polls.done,report.polls.newGames,report.heals.healed,report.heals.recovered,report.features.saved],[11,22,1,3,2]);
  assert.equal(report.backlog.due,0);assert.equal(report.tracked,12);
  assert.equal(report.cohorts.heavy,12);
});

test('a window that misses the saved head is healed in the same run',async()=>{
  const players=[heavy(1,13),heavy(2,13)];
  const h=harness({players,respond:{'rr-collect':path=>path[3]===uuid(1)?Response.json({data:{puuid:uuid(1),checked_at:ago(0),new_games:20,
    newest_date:ago(0.5),window_from:ago(10),possible_gap:true,gap:{after_match_id:'head',after_date:ago(20),before_match_id:'w0',before_date:ago(10)}}}):null}});
  const report=await h.run();
  assert.ok(h.calls.includes('rr-heal:head'));
  assert.equal(report.polls.gapsFound,1);assert.equal(report.heals.healed,1);
});

test('failed polls and heals are retried later in the same run and never fail it',async()=>{
  let pollFailures=0,healFailures=0;
  const gap={puuid:uuid(2),after_match_id:'g',after_date:ago(30),before_date:ago(13),region:'eu',platform:'pc',status:'open',attempts:0,recovered:0};
  const h=harness({players:[heavy(1,13)],gaps:[gap],respond:{
    'rr-collect':()=>pollFailures++<3?Response.json({},{status:503}):null,
    'rr-heal':()=>healFailures++<3?Response.json({},{status:502}):null,
  }});
  const report=await h.run();
  assert.deepEqual([report.polls.failed,report.polls.done],[1,1]);
  assert.deepEqual([report.heals.failed,report.heals.healed],[1,1]);
  assert.equal(h.calls.filter(c=>c===`rr-collect:${uuid(1)}`).length,4,'three transient attempts, then one after the cooldown');
  assert.equal(report.failures.length,2);
  assert.ok(RETRY_MS<HOUR);
});

test('a resolved gap is dropped; a paged heal follows next_page',async()=>{
  let page=0;
  const fetchImpl=async url=>{
    const p=Number(new URL(url).searchParams.get('page'));page=p;
    return p===1?Response.json({data:{puuid:uuid(1),after_match_id:'a',done:false,next_page:2,recovered:100}})
      :Response.json({data:{puuid:uuid(1),after_match_id:'a',done:true,status:'healed',recovered:7,breaks:0}});
  };
  assert.deepEqual(await healGap({puuid:uuid(1),after_match_id:'a'},{origin,fetchImpl}),{status:'healed',recovered:107,breaks:0});
  assert.equal(page,2);
  const gone=await healGap({puuid:uuid(1),after_match_id:'a'},{origin,fetchImpl:async()=>Response.json({},{status:404})});
  assert.equal(gone.status,'gone');
});

test('a configuration error stops every worker and is rethrown',async()=>{
  const h=harness({players:[heavy(1,13),heavy(2,13)],respond:{'rr-collect':()=>{const e=new Error('Central workflow pacing is not ready');e.code='WORKFLOW_CONFIGURATION';throw e;}}});
  await assert.rejects(h.run({concurrency:2}),{code:'WORKFLOW_CONFIGURATION'});
});

test('reloads keep this run\'s newer checks over a lagging D1 read and pick up new accounts',async()=>{
  const rows=[heavy(1,13)];
  let loads=0;
  const h=harness({players:[]});
  const report=await h.run({reloadMs:10*60000,loadPlayers:async()=>{loads++;if(loads===2)rows.push(heavy(2,13));return rows.map(p=>({...p}));}});
  assert.ok(loads>=3);
  assert.equal(h.calls.filter(c=>c===`rr-collect:${uuid(1)}`).length,1,'the stale replica row does not make it due again');
  assert.ok(h.calls.includes(`rr-collect:${uuid(2)}`));
  assert.equal(report.polls.done,2);
});

// 24 Nov 2026: four workers each started the 30-minute reload while the first
// was still reading, so three copies of the 568k-row player read ran at once
// and D1 rejected the site's quota gate (docs/rr-collector-d1-load.md).
test('a reload runs once at a time however many workers find it due',async()=>{
  let loads=0,active=0,most=0;
  const h=harness({players:[]});
  const players=Array.from({length:40},(_,i)=>heavy(1+i,13));
  const report=await h.run({concurrency:4,reloadMs:10*60000,loadPlayers:async()=>{
    loads++;active++;most=Math.max(most,active);
    try{await h.clock.sleep(2200);return players.map(p=>({...p}));}finally{active--;}
  }});
  assert.equal(most,1,'no reload overlaps another');
  assert.ok(loads>=2&&loads<=7,`one load per ten-minute period in an hour, got ${loads}`);
  assert.equal(report.reloads,loads);
  assert.equal(report.polls.done,40);
});

test('the initial load is retried before the run gives up',async()=>{
  let loads=0;
  const h=harness({players:[]});
  const report=await h.run({loadPlayers:async()=>{if(++loads<3)throw new Error('fetch failed');return [heavy(1,13)];}});
  assert.equal(report.polls.done,1);
  await assert.rejects(harness({players:[]}).run({loadPlayers:async()=>{throw new Error('fetch failed');}}),/fetch failed/);
});

test('the daily audit runs once a day',async()=>{
  const events=[];
  const fake={log:()=>{},scan:async()=>{events.push('scan');return {found:2};},census:async()=>{events.push('census');return {currentAct:null,ranks:[]};},
    write:async(_env,name,value)=>events.push(`write:${name}`)};
  assert.equal((await dailyAudit({},{...fake,read:async()=>({value:new Date(Date.now()-HOUR).toISOString()})})).skipped,true);
  assert.deepEqual(events,[]);
  const done=await dailyAudit({},{...fake,read:async()=>({value:new Date(Date.now()-25*HOUR).toISOString()})});
  assert.deepEqual([done.skipped,done.gapScan.found],[false,2]);
  assert.deepEqual(events,['scan','census','write:audit_at']);
  await dailyAudit({},{...fake,read:async()=>null});
  assert.equal(events.filter(e=>e==='scan').length,2);
});

// main() with every network and file dependency stubbed.
const source=readFileSync(new URL('../.github/scripts/collect-rr-corpus.mjs',import.meta.url),'utf8');
const mainSource=source.slice(source.indexOf('export async function main('),source.indexOf('export function stepSummary('))
  .replace('export ','')+'\nmain';
function fixture({collector,databaseFull=false}={}){
  const events=[],outputs=[],writes=[],process={exitCode:0};
  const context={process,Date,URL,JSON,Number,Math,console:{log(){},error(){},warn(){}},randomUUID:()=>'test-run',
    MINUTE:60000,FEATURE_BATCH,stepSummary,fatal:e=>['WORKFLOW_CONFIGURATION','WORKFLOW_STORAGE'].includes(e?.code),
    readQuotaAudit:async()=>({available:true,calls:0}),quotaCheckReport:()=>({status:'insufficient_evidence'}),
    assertD1Headroom:async()=>{events.push('headroom');if(databaseFull){const e=new Error('D1 database is full');e.code='WORKFLOW_STORAGE';throw e;}},
    createRequestScheduler:()=>Object.assign(()=>{},{pools:{workflow:3,public:0}}),
    loadTracked:async()=>[],loadOpenGaps:async()=>[],loadFeatureQueue:async()=>[],loadCandidates:async()=>[],
    d1Governor:()=>({stats:{statements:12,busyMs:340.6,slow:0,slowest:{ms:90,sql:'SELECT 1'}}}),
    runCollector:async options=>{events.push('collect');assert.ok(options.deadline>Date.now());return collector?collector():{polls:{done:3},heals:{},backlog:{due:0,overdue2x:0}};},
    dailyAudit:async()=>{events.push('audit');return {skipped:true};},gapSummary:async()=>({total:0,byStatus:{}}),
    mkdir:async()=>{},writeFile:async(_path,json)=>writes.push(JSON.parse(json)),
    appendFile:async(path,text)=>{if(path==='github-output')outputs.push(text);},
  };
  return {run:runInNewContext(mainSource,context),events,outputs,writes,process};
}
const env={HENRIK_WORKFLOW_KEY:'fixture',GITHUB_OUTPUT:'github-output'};

test('a normal run writes its report, chains the next run and exits cleanly',async()=>{
  const f=fixture();
  const report=await f.run(env);
  assert.deepEqual(f.events,['headroom','audit','collect']);
  assert.equal(report.chainNext,true);assert.deepEqual(f.outputs,['chain=true\n']);
  assert.equal(f.process.exitCode,0);
  assert.equal(f.writes.at(-1).polls.done,3);
  assert.deepEqual(JSON.parse(JSON.stringify(report.d1)),{statements:12,busyMs:341,slow:0,slowest:{ms:90,sql:'SELECT 1'}},'the D1 governor count is reported');
});

test('failed polls never fail the workflow; a configuration stop does, without chaining',async()=>{
  const busy=fixture({collector:()=>({polls:{done:1,failed:40},heals:{failed:3},backlog:{due:900,overdue2x:12}})});
  await busy.run(env);
  assert.equal(busy.process.exitCode,0);assert.deepEqual(busy.outputs,['chain=true\n']);
  const broken=fixture({collector:()=>{const e=new Error('HENRIK_WORKFLOW_KEY must match');e.code='WORKFLOW_CONFIGURATION';throw e;}});
  const report=await broken.run(env);
  assert.equal(broken.process.exitCode,1);assert.deepEqual(broken.outputs,['chain=false\n']);
  assert.equal(report.fatal.code,'WORKFLOW_CONFIGURATION');
  const crash=fixture({collector:()=>{throw new Error('bug');}});
  await assert.rejects(crash.run(env),/bug/);
});

test('invalid budgets and a full database stop before any upstream call',async()=>{
  const f=fixture();
  await assert.rejects(f.run({...env,RUNTIME_MINUTES:'360'}),/RUNTIME_MINUTES/);
  await assert.rejects(f.run({...env,DETAIL_LIMIT:'9000'}),/DETAIL_LIMIT/);
  assert.equal(f.events.length,0);
  const full=fixture({databaseFull:true});
  await assert.rejects(full.run(env),{code:'WORKFLOW_STORAGE'});
  assert.deepEqual(full.events,['headroom']);assert.equal(full.outputs.length,0);
});

test('the step summary renders partial reports',()=>{
  assert.match(stepSummary({}),/0 polls committed/);
  assert.match(stepSummary({fatal:{message:'D1 full'},polls:{done:2}}),/Stopped:\*\* D1 full/);
});
