// Quota values stay server-side. Persist only diagnostic counters per caller.
export const QUOTA_AUDIT_SCHEMA=`CREATE TABLE IF NOT EXISTS workflow_quota_audit (
  run_id TEXT PRIMARY KEY,upstream_calls INTEGER NOT NULL DEFAULT 0,
  comparable_samples INTEGER NOT NULL DEFAULT 0,skipped_samples INTEGER NOT NULL DEFAULT 0,
  external_usage_events INTEGER NOT NULL DEFAULT 0,unexplained_requests INTEGER NOT NULL DEFAULT 0,
  last_observed_at TEXT NOT NULL,last_detected_at TEXT
)`;

export function classifyQuotaObservation(parsed,{expectedRemaining,expectedResetAt,applied,current}){
  // Ignore missing headers, resets, boundary jitter and superseded responses.
  // Reservations already account for every call admitted by this proxy.
  const comparable=Boolean(applied)&&Number.isInteger(expectedRemaining)&&expectedRemaining>=0&&
    Number.isInteger(parsed.remaining)&&parsed.remaining>=0&&Number.isFinite(parsed.resetAt)&&
    Number.isFinite(expectedResetAt)&&expectedResetAt>current+3000&&parsed.resetAt>current+3000&&
    Math.abs(parsed.resetAt-expectedResetAt)<=3000;
  return {comparable,unexplained:comparable?Math.max(0,expectedRemaining-parsed.remaining):0};
}

export async function recordQuotaObservation(db,parsed,options){
  const {comparable,unexplained}=classifyQuotaObservation(parsed,options);
  const runId=/^[a-zA-Z0-9:_-]{1,128}$/.test(options.runId||'')?options.runId:'unattributed';
  const stamp=new Date(options.current).toISOString();
  await db.prepare(QUOTA_AUDIT_SCHEMA).run();
  await db.prepare(`INSERT INTO workflow_quota_audit(run_id,upstream_calls,comparable_samples,skipped_samples,
    external_usage_events,unexplained_requests,last_observed_at,last_detected_at)
    VALUES(?1,1,?2,?3,?4,?5,?6,?7) ON CONFLICT(run_id) DO UPDATE SET
    upstream_calls=upstream_calls+1,comparable_samples=comparable_samples+excluded.comparable_samples,
    skipped_samples=skipped_samples+excluded.skipped_samples,
    external_usage_events=external_usage_events+excluded.external_usage_events,
    unexplained_requests=unexplained_requests+excluded.unexplained_requests,
    last_observed_at=excluded.last_observed_at,
    last_detected_at=COALESCE(excluded.last_detected_at,last_detected_at)`)
    .bind(runId,comparable?1:0,comparable?0:1,unexplained>0?1:0,unexplained,stamp,unexplained>0?stamp:null).run();
}
