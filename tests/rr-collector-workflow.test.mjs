import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {shouldChainRun,CHAIN_MIN_ELAPSED_MS} from '../.github/scripts/collect-rr-corpus.mjs';

// Exercise orchestration without real credentials, network calls or report files.
const source=readFileSync(new URL('../.github/scripts/collect-rr-corpus.mjs',import.meta.url),'utf8');
const mainSource=source.slice(source.indexOf('export async function main('),source.indexOf('\nif(process.argv'))
  .replace('export ','')+'\nmain';
const player={puuid:'11111111-1111-4111-8111-111111111111',region:'eu',platform:'pc'};
function fixture({capture,coverageFailure=false,detailQueryFailure=false,databaseFull=false}={}){
  const writes=[],events=[],outputs=[],process={exitCode:0};
  const context={process,Date,URL,JSON,Number,console:{log(){},error(){},warn(){}},randomUUID:()=> 'test-run',
    readQuotaAudit:async()=>({available:true,calls:0}),quotaCheckReport:()=>({status:'insufficient_evidence'}),
    assertD1Headroom:async()=>{events.push('headroom');if(databaseFull){const e=new Error('D1 database is full');e.code='WORKFLOW_STORAGE';throw e;}},
    listPlayers:async()=>{events.push('list');return [player];},loadActivity:async(_env,players)=>players,
    selectPollingPlayers:players=>players,loadCandidates:async()=>[player],selectDiscoveryCandidates:players=>players,
    createRequestScheduler:()=>()=>{},pollingPolicy:()=>({cohort:'frequent'}),
    collectPlayers:async players=>{events.push('capture');return players.length&&capture?capture:{players:players.length,checked:players.length,failures:[],deferred:0};},
    loadFeaturePlan:async(_env,limit)=>{
      events.push('inventory');
      if(limit){events.push('detail-query');if(detailQueryFailure)throw new Error('Detail query unavailable');}
      return {inventory:{total:10,saved:8,missing:2,archived:1,waitingRetry:1,missingRegion:0},rows:[]};
    },
    collectMatchFeatures:async()=>({saved:0,deferred:0,failed:0,budgetDeferred:0}),
    corpusReport:async()=>{events.push('coverage');if(coverageFailure)throw new Error('D1 unavailable');return {health:{stale:0,possible_gaps:0}};},
    mkdir:async()=>{},writeFile:async(_path,json)=>{events.push('write');writes.push(JSON.parse(json));},
    appendFile:async(path,text)=>{if(path==='github-output')outputs.push(text);},shouldChainRun,
  };
  return {run:runInNewContext(mainSource,context),writes,events,outputs,process};
}
const env={HENRIK_WORKFLOW_KEY:'fixture',DETAIL_LIMIT:'0'};

test('zero detail limit avoids detail queries and a coverage failure only warns after committed capture',async()=>{
  const f=fixture({coverageFailure:true});
  const report=await f.run(env);
  assert.ok(!f.events.includes('detail-query'));
  assert.ok(f.events.indexOf('write')<f.events.indexOf('coverage'));
  assert.equal(f.writes[0].refresh.checked,1);
  assert.equal(report.coverageError,'D1 unavailable');
  assert.equal(f.writes.at(-1).coverageError,'D1 unavailable');
  assert.equal(f.process.exitCode,0);
  assert.equal(report.detailInventory.saved,8);
});

test('incomplete transient capture skips optional scouting and detail queries',async()=>{
  const f=fixture({capture:{players:1,checked:0,failures:[{puuid:player.puuid,retryable:true}],deferred:0}});
  const report=await f.run({...env,DETAIL_LIMIT:'1500'});
  assert.equal(report.enrichmentSkipped,'tracked_capture_incomplete');
  assert.equal(report.candidatesScouted,0);
  assert.ok(!f.events.includes('detail-query'));
  assert.equal(f.process.exitCode,1);
});

test('an optional detail query failure cannot erase captured RR or appear successful',async()=>{
  const f=fixture({detailQueryFailure:true});
  const report=await f.run({...env,DETAIL_LIMIT:'1500'});
  assert.ok(f.events.indexOf('write')<f.events.indexOf('detail-query'));
  assert.equal(report.refresh.checked,1);
  assert.equal(report.enrichmentError,'Detail query unavailable');
  assert.equal(f.writes.at(-1).refresh.checked,1);
  assert.equal(f.process.exitCode,1);
});

test('invalid budgets fail before credentials can be used for network access',async()=>{
  const f=fixture();
  await assert.rejects(f.run({...env,RUNTIME_MINUTES:'240'}),/RUNTIME_MINUTES/);
  assert.equal(f.events.length,0);
});

test('a run chains the next one only after progress with work left or a long run',()=>{
  const done={refresh:{checked:3,deferred:0},scouting:{checked:0},details:0,detailBudgetDeferred:0};
  assert.equal(shouldChainRun(done,{elapsedMs:60000}),false,'a short run that finished leaves the next start to the schedule');
  assert.equal(shouldChainRun(done,{elapsedMs:CHAIN_MIN_ELAPSED_MS}),true);
  assert.equal(shouldChainRun({...done,refresh:{checked:3,deferred:40}},{elapsedMs:60000}),true,'budget-deferred capture continues');
  assert.equal(shouldChainRun({...done,detailBudgetDeferred:5},{elapsedMs:60000}),true,'budget-deferred details continue');
  assert.equal(shouldChainRun({refresh:{checked:0,deferred:3000},details:0},{elapsedMs:3*3600000}),false,
    'a run without progress (all 429s) never loops; the hourly trigger retries');
  assert.equal(shouldChainRun({refresh:{checked:0,deferred:0},scouting:{checked:0},details:7,detailBudgetDeferred:0},{elapsedMs:CHAIN_MIN_ELAPSED_MS}),true);
});

test('collection failures still report the chain decision to the workflow',async()=>{
  const f=fixture({capture:{players:2,checked:1,failures:[{puuid:player.puuid,retryable:true}],deferred:1}});
  const report=await f.run({...env,GITHUB_OUTPUT:'github-output'});
  assert.equal(f.process.exitCode,1);
  assert.equal(report.chainNext,true);
  assert.deepEqual(f.outputs,['chain=true\n']);
  assert.equal(f.writes.at(-1).chainNext,true);
  const idle=fixture();
  await idle.run({...env,GITHUB_OUTPUT:'github-output'});
  assert.deepEqual(idle.outputs,['chain=false\n']);
});

test('a full database stops the run before any player is listed or any upstream call is made',async()=>{
  const f=fixture({databaseFull:true});
  await assert.rejects(f.run(env),{code:'WORKFLOW_STORAGE'});
  assert.deepEqual(f.events,['headroom']);
  assert.equal(f.outputs.length,0); // no chain to a next run
});
