import {d1Query} from './d1-query.mjs';

export async function readQuotaAudit(env,runId,query=d1Query){
  try{
    const tables=await query(env,"SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_quota_audit'");
    if(!tables.length)return {available:true,calls:0,own_calls:0,samples:0,skipped:0,events:0,unexplained:0};
    const [row]=await query(env,`SELECT COALESCE(SUM(upstream_calls),0) AS calls,
      COALESCE(SUM(CASE WHEN run_id=?1 THEN upstream_calls ELSE 0 END),0) AS own_calls,
      COALESCE(SUM(comparable_samples),0) AS samples,COALESCE(SUM(skipped_samples),0) AS skipped,
      COALESCE(SUM(external_usage_events),0) AS events,COALESCE(SUM(unexplained_requests),0) AS unexplained,
      MAX(last_detected_at) AS last_detected_at FROM workflow_quota_audit`,[runId]);
    return {available:true,...row};
  }catch(error){return {available:false,error:error.message};}
}

export function quotaCheckReport(before,after){
  if(!before.available||!after.available)return {status:'unavailable',error:after.error||before.error};
  const delta=key=>Math.max(0,(after[key]||0)-(before[key]||0));
  const otherProxyCalls=Math.max(0,delta('calls')-delta('own_calls'));
  const unexplained=delta('unexplained'),samples=delta('samples');
  return {status:otherProxyCalls?'other_proxy_activity':unexplained?'possible_external_usage':samples?'no_evidence':'insufficient_evidence',
    upstreamCalls:delta('calls'),otherProxyCalls,comparableSamples:samples,skippedSamples:delta('skipped'),
    externalUsageEvents:delta('events'),unexplainedRequests:unexplained,
    lastDetectedAt:unexplained?after.last_detected_at:null,
    note:'Unexplained quota drops suggest use outside this proxy; headers cannot identify the other instance. No evidence does not prove exclusive use.'};
}
