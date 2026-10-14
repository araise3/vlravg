import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise orchestration without real credentials, network calls or report files.
const source=readFileSync(new URL('../.github/scripts/collect-rr-corpus.mjs',import.meta.url),'utf8');
const mainSource=source.slice(source.indexOf('export async function main('),source.indexOf('\nif(process.argv'))
  .replace('export ','')+'\nmain';
const player={puuid:'11111111-1111-4111-8111-111111111111',region:'eu',platform:'pc'};
function fixture({capture,coverageFailure=false,detailQueryFailure=false}={}){
  const writes=[],events=[],process={exitCode:0};
  const context={process,Date,URL,JSON,Number,console:{log(){},error(){},warn(){}},randomUUID:()=> 'test-run',
    readQuotaAudit:async()=>({available:true,calls:0}),quotaCheckReport:()=>({status:'insufficient_evidence'}),
    listPlayers:async()=>[player],loadActivity:async(_env,players)=>players,
    selectPollingPlayers:players=>players,loadCandidates:async()=>[player],selectDiscoveryCandidates:players=>players,
    createRequestScheduler:()=>()=>{},pollingPolicy:()=>({cohort:'frequent'}),
    collectPlayers:async players=>{events.push('capture');return players.length&&capture?capture:{players:players.length,checked:players.length,failures:[],deferred:0};},
    d1Query:async()=>{events.push('detail-query');if(detailQueryFailure)throw new Error('Detail query unavailable');return [];},
    collectMatchFeatures:async()=>({saved:0,deferred:0,failed:0,budgetDeferred:0}),
    corpusReport:async()=>{events.push('coverage');if(coverageFailure)throw new Error('D1 unavailable');return {health:{stale:0,possible_gaps:0}};},
    mkdir:async()=>{},writeFile:async(_path,json)=>{events.push('write');writes.push(JSON.parse(json));},appendFile:async()=>{},
  };
  return {run:runInNewContext(mainSource,context),writes,events,process};
}
const env={HENRIK_WORKFLOW_KEY:'fixture',DETAIL_LIMIT:'0'};

test('zero detail limit avoids detail queries and coverage failure retains committed capture',async()=>{
  const f=fixture({coverageFailure:true});
  const report=await f.run(env);
  assert.ok(!f.events.includes('detail-query'));
  assert.ok(f.events.indexOf('write')<f.events.indexOf('coverage'));
  assert.equal(f.writes[0].refresh.checked,1);
  assert.equal(report.coverageError,'D1 unavailable');
  assert.equal(f.writes.at(-1).coverageError,'D1 unavailable');
  assert.equal(f.process.exitCode,1);
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
