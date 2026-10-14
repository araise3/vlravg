import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {classifyQuotaObservation,recordQuotaObservation} from '../lib/workflow-quota-audit.mjs';
import {readQuotaAudit,quotaCheckReport} from '../.github/scripts/workflow-quota-check.mjs';
import {acquireWorkflowPermit,observeWorkflowQuota} from '../lib/upstream-pacing.mjs';

function database(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const statement={bind(...params){values=params;return statement;},
    async first(){return sql.prepare(query).get(...values)||null;},
    async all(){return {results:sql.prepare(query).all(...values)};},
    async run(){return sql.prepare(query).run(...values);}};return statement;}};
  const query=async(_env,text,params=[]) => (await db.prepare(text).bind(...params).all()).results;
  return {db,sql,query};
}
const options={expectedRemaining:8,expectedResetAt:160000,applied:true,current:110000,runId:'run-1'};

test('quota drops exclude own reservations and detect unexplained same-window usage',()=>{
  assert.deepEqual(classifyQuotaObservation({remaining:8,resetAt:160000},options),{comparable:true,unexplained:0});
  assert.deepEqual(classifyQuotaObservation({remaining:5,resetAt:161000},options),{comparable:true,unexplained:3});
  for(const overrides of [{applied:false},{expectedRemaining:null},{expectedResetAt:110500}])
    assert.equal(classifyQuotaObservation({remaining:5,resetAt:160000},{...options,...overrides}).comparable,false);
  for(const headers of [{remaining:null,resetAt:160000},{remaining:5,resetAt:180000}])
    assert.equal(classifyQuotaObservation(headers,options).comparable,false);
});

test('server diagnostics distinguish other proxy processes and external quota drops',async t=>{
  const {db,query}=database(t),before=await readQuotaAudit({},'run-1',query);
  await recordQuotaObservation(db,{remaining:8,resetAt:160000},options);
  assert.equal(quotaCheckReport(before,await readQuotaAudit({},'run-1',query)).status,'no_evidence');
  await recordQuotaObservation(db,{remaining:5,resetAt:160000},{...options,runId:'other-process'});
  const after=await readQuotaAudit({},'run-1',query),report=quotaCheckReport(before,after);
  assert.equal(report.status,'other_proxy_activity');assert.equal(report.otherProxyCalls,1);
  assert.equal(report.unexplainedRequests,3);assert.equal(report.comparableSamples,2);
  assert.ok(!JSON.stringify(after).includes('remaining'));
});

test('unknown headers never report exclusive key use and audit initializes existing databases',async t=>{
  const {db,sql,query}=database(t);sql.exec('DROP TABLE workflow_quota_audit');
  const before=await readQuotaAudit({},'run-1',query);
  await recordQuotaObservation(db,{remaining:null,resetAt:null},options);
  assert.equal(quotaCheckReport(before,await readQuotaAudit({},'run-1',query)).status,'insufficient_evidence');
  assert.equal(quotaCheckReport({available:false,error:'D1 unavailable'},before).status,'unavailable');
});

test('real admissions carry expected quota and late responses cannot become external-usage evidence',async t=>{
  const {db,sql,query}=database(t);let clock=100000;
  sql.prepare('INSERT INTO workflow_rate_quota VALUES(1,10,160000,0,0)').run();
  const before=await readQuotaAudit({},'run-1',query);
  const permit=await acquireWorkflowPermit(db,{now:()=>clock});
  await observeWorkflowQuota(db,{remaining:7,resetAt:160000},{startedAt:permit.startedAt,now:()=>clock,status:200,
    expectedRemaining:permit.quota.remaining,expectedResetAt:permit.quota.resetAt,runId:'run-1'});
  let report=quotaCheckReport(before,await readQuotaAudit({},'run-1',query));
  assert.equal(report.status,'possible_external_usage');assert.equal(report.unexplainedRequests,2);
  clock=120000;const newer=await acquireWorkflowPermit(db,{now:()=>clock});
  await observeWorkflowQuota(db,{remaining:0,resetAt:160000},{startedAt:permit.startedAt,now:()=>clock,status:200,
    expectedRemaining:permit.quota.remaining,expectedResetAt:permit.quota.resetAt,runId:'run-1'});
  report=quotaCheckReport(before,await readQuotaAudit({},'run-1',query));
  assert.equal(report.unexplainedRequests,2);assert.equal(report.skippedSamples,1);
  assert.ok(newer.quota);
});
