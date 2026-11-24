// Why does the public window reach zero? (docs/profile-quota-reserve.md)
// One row per notable public-pool event, no player identity: the route's
// first path segment, the call's estimated cost in HenrikDev units, our
// gate's count and what HenrikDev's headers said.
//
// - upstream-429:    HenrikDev refused a call our gate had admitted.
// - low-window:      a public response whose header shows the reserve or less
//                    left; gate_remaining is our count after admitting it.
// - profile-refused: a search's account lookup could not reach upstream.
//                    served_saved is only set on rows from 24 Nov 2026, when
//                    a saved identity could answer it (since removed).
import {PUBLIC_PROFILE_RESERVE} from './upstream-pacing.mjs';

export const PUBLIC_QUOTA_AUDIT_DAYS=14;
export const PUBLIC_QUOTA_AUDIT_SCHEMA=`CREATE TABLE IF NOT EXISTS public_quota_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,observed_at TEXT NOT NULL,event TEXT NOT NULL,
  route TEXT NOT NULL,profile INTEGER NOT NULL DEFAULT 0,gate_remaining INTEGER,
  header_remaining INTEGER,reset_in_ms INTEGER,retry_after_ms INTEGER,served_saved INTEGER,cost INTEGER
)`;
const EVENTS=new Set(['upstream-429','low-window','profile-refused']);
const int=v=>Number.isFinite(v)?Math.round(v):null;

// Which upstream observations are worth a row.
export function publicQuotaEvent(parsed,status){
  if(status===429)return 'upstream-429';
  return Number.isInteger(parsed?.remaining)&&parsed.remaining<=PUBLIC_PROFILE_RESERVE?'low-window':null;
}

export async function recordPublicQuotaEvent(db,{event,route,profile=false,gateRemaining=null,
  headerRemaining=null,resetAt=null,retryAfterMs=null,servedSaved=null,cost=null,now=Date.now()}){
  if(!db||!EVENTS.has(event))return;
  const label=/^[a-z0-9:-]{1,48}$/.test(route||'')?route:'other';
  const stamp=new Date(now).toISOString();
  await db.prepare(PUBLIC_QUOTA_AUDIT_SCHEMA).run();
  const insert=()=>db.prepare(`INSERT INTO public_quota_audit(observed_at,event,route,profile,gate_remaining,
    header_remaining,reset_in_ms,retry_after_ms,served_saved,cost) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
    .bind(stamp,event,label,profile?1:0,int(gateRemaining),int(headerRemaining),
      Number.isFinite(resetAt)?Math.max(0,Math.round(resetAt-now)):null,int(retryAfterMs),
      servedSaved==null?null:servedSaved?1:0,int(cost)).run();
  // Tables created before the cost column (migration 0015) gain it here.
  try{await insert();}
  catch(error){
    if(!/cost/i.test(String(error?.message)))throw error;
    try{await db.prepare('ALTER TABLE public_quota_audit ADD COLUMN cost INTEGER').run();}catch{}
    await insert();
  }
  await db.prepare('DELETE FROM public_quota_audit WHERE observed_at<?1')
    .bind(new Date(now-PUBLIC_QUOTA_AUDIT_DAYS*86400000).toISOString()).run();
}
