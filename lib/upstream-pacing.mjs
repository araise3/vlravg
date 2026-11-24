import {recordQuotaObservation} from './workflow-quota-audit.mjs';
import {recordCostSample} from './upstream-cost.mjs';
export const WORKFLOW_SPACING_MS=2100;
export const PUBLIC_UNKNOWN_SPACING_MS=2100;
// HenrikDev states its window reset in whole seconds. On 24 Nov 2026 a call
// sent 0.16 s after the stated reset got a real 429 with Retry-After 60,
// which stops every caller for a minute. Parsed reset times therefore add
// this guard (functions/api/[[path]].js parseUpstreamQuota).
export const RESET_GUARD_MS=1000;
// When a 429 carries neither Retry-After nor a reset, wait this long instead of
// guessing a full minute. HenrikDev documents only that those headers say how
// long to wait; the 60 s blocks seen on 24 Nov 2026 came once from its own
// reset header and once from Retry-After or this gate's former 60 s default.
export const NO_HEADER_429_WAIT_MS=5000;
// Calls in flight at once per key, and how long an unanswered call holds its
// place (a Worker that dies mid-call never releases it).
export const PUBLIC_IN_FLIGHT=3;
export const WORKFLOW_IN_FLIGHT=1;
export const LEASE_MS=30000;
// Units kept back from HenrikDev's count for use of the key outside the gate.
export const QUOTA_MARGIN=2;
const workflowPool={table:'workflow_rate_quota',floorMs:WORKFLOW_SPACING_MS,unknownMs:WORKFLOW_SPACING_MS,percent:100,inFlight:WORKFLOW_IN_FLIGHT};
// Learn the public key's own budget from headers, rather than assuming its tier.
// Known quota is spread over the remaining window with 5% timing headroom.
//
// Quota is counted in HenrikDev's units, not calls: "1 request to the API =
// +1" and "1 background request to Riot = +1" (docs.henrikdev.xyz
// general/rate-limiting). The site key has 60 units a minute and the workflow
// key 30. `remaining` is HenrikDev's own count from the newest response; the
// gate never guesses it. Only calls in flight are unknown, so:
// - at most `inFlight` calls run at once per key, each holding a lease;
// - a lease holds the call's documented maximum (`units`,
//   lib/upstream-cost.mjs maxUnits), released when its response arrives;
// - a call is admitted only while HenrikDev's count minus every held maximum
//   minus its own still leaves QUOTA_MARGIN, plus the pool's reserve.
// So no admitted call can find the key empty unless something outside the
// gate used it. Counting every call as one let the gate admit calls HenrikDev
// had no units for; its 429 then stopped every caller (24 Nov 2026).
//
// Cost evidence: every admission records the previous admission
// (prev_request_at) and every response the newest call seen answered
// (observed_request_at) and, for the newest call, HenrikDev's count
// (header_remaining, header_reset_at). A call admitted after the previous
// call's response arrived, whose own response is the newest, had the key to
// itself between two headers of one window: the drop is its cost, kept in
// quota_cost_samples for analysis. Admission does not use it.
//
// A search needs one upstream call, the account lookup, to reach the
// player's saved matches (D1/R2, no upstream). Other public calls leave this
// many units of every known window to account lookups, so a saved profile
// still opens when a busy minute has spent the rest of the quota (24 Nov
// 2026): six lookups at two units each.
export const PUBLIC_PROFILE_RESERVE=12;
// Account lookups also go first. Under load every waiting request polls for
// the next slot, and a live drain (24 Nov 2026) saw account lookups lose that
// race for the gate's whole 8 s wait with 13-41 calls left. A waiting account
// lookup now claims the next slot (`priority_until`); other public calls,
// collector loans included, do not take a slot while a claim is live. A claim
// lasts until the slot it waits for plus this margin, so one left behind by a
// lookup that gave up holds the others back at most that long.
export const PRIORITY_CLAIM_MARGIN_MS=500;
const profilePool={table:'rate_quota',floorMs:150,unknownMs:PUBLIC_UNKNOWN_SPACING_MS,percent:105,priority:'claim',inFlight:PUBLIC_IN_FLIGHT};
// `reserve`: units that must still be left after the call.
const publicPool={...profilePool,reserve:PUBLIC_PROFILE_RESERVE,priority:'yield'};
// Collector calls may borrow a public slot only while the site's key keeps at
// least this many units after the call, or the window is fresh. With a 60/min
// key, visitors keep half of every window, and borrowed calls share the
// public schedule, so the key's pacing never changes.
export const PUBLIC_BORROW_RESERVE=30;
const borrowPool={...profilePool,reserve:PUBLIC_BORROW_RESERVE,priority:'yield'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const QUOTA_COLUMNS=[['next_start_at','INTEGER NOT NULL DEFAULT 0'],['prev_request_at','INTEGER NOT NULL DEFAULT 0'],
  ['observed_request_at','INTEGER NOT NULL DEFAULT 0'],['header_remaining','INTEGER'],['header_reset_at','INTEGER'],
  ['leases',"TEXT NOT NULL DEFAULT '[]'"]];
async function initialize(db,{table,priority}){
  // Only the public table, whose pools use priority claims, gets priority_until.
  const columns=priority?[...QUOTA_COLUMNS,['priority_until','INTEGER NOT NULL DEFAULT 0']]:QUOTA_COLUMNS;
  // Table names come exclusively from the two private pool definitions above.
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY CHECK(id=1),remaining INTEGER,reset_at INTEGER,
    last_request_at INTEGER,${columns.map(([name,type])=>`${name} ${type}`).join(',')})`).run();
  // Additive upgrades from older quota tables.
  // Another request may win an ALTER; check the resulting schema either way.
  for(const [column,type] of columns){
    try{await db.prepare(`SELECT ${column} FROM ${table} WHERE id=1`).first();}
    catch{
      try{await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();}
      catch{await db.prepare(`SELECT ${column} FROM ${table} WHERE id=1`).first();}
    }
  }
  await db.prepare(`INSERT OR IGNORE INTO ${table} (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,NULL,0,0,0)`).run();
}

// Leases live in the quota row as a JSON array of {s: startedAt, u: units,
// e: expiry}, so one conditional UPDATE both checks and takes them.
const LIVE=`json_each(leases) WHERE json_extract(value,'$.e')>?1`;
const HELD=`COALESCE((SELECT SUM(json_extract(value,'$.u')) FROM ${LIVE}),0)`;
const LIVE_COUNT=`(SELECT COUNT(*) FROM ${LIVE})`;
const LIVE_ARRAY=`COALESCE((SELECT json_group_array(json(value)) FROM ${LIVE}),'[]')`;
const liveLeases=(text,current)=>{
  let list=[];try{list=JSON.parse(text||'[]');}catch{}
  return Array.isArray(list)?list.filter(lease=>lease?.e>current):[];
};

// The conditional write is the authority, not a preceding read. Two requests
// cannot claim the same slot, including across isolates or stale D1 read replicas.
// A bounded server wait covers four concurrent backfill workers; larger queues
// receive the existing retryAfterMs signal rather than holding requests forever.
// `units`: the call's documented maximum HenrikDev cost. Spacing stays per
// call: the units still free are spread over the window.
async function acquirePermit(db,pool,{now=Date.now,sleepImpl=sleep,maxWaitMs=8000,units:requested=1}={}){
  if(!db)throw new Error('Upstream pacing requires APP_DB');
  const {table,floorMs,unknownMs,percent,reserve=null,priority=null,inFlight}=pool;
  const units=Number.isInteger(requested)&&requested>0?requested:1;
  const floor=QUOTA_MARGIN+(reserve||0);
  // ?9: 1 = yield to a live claim, 0 = a claimant, which clears it on admission.
  const priorityFlag=priority==='yield'?1:priority==='claim'?0:null;
  const claimSet=priority?'priority_until=CASE WHEN ?9=0 THEN 0 ELSE priority_until END,':'';
  const claimWhere=priority?'AND (?9 IS NOT 1 OR priority_until<=?1)':'';
  const claimColumn=priority?',priority_until':'';
  const deadline=now()+maxWaitMs;
  let initialized=false;
  for(;;){
    const startedAt=now();
    let row;
    try{
      row=await db.prepare(`UPDATE ${table} SET
        remaining=CASE WHEN reset_at<=?1 THEN NULL ELSE remaining END,
        reset_at=CASE WHEN reset_at<=?1 THEN 0 ELSE reset_at END,
        prev_request_at=last_request_at,last_request_at=?1,${claimSet}
        next_start_at=?1+MAX(?2,
          CASE WHEN remaining IS NOT NULL AND reset_at>?1 AND remaining-${HELD}>0
            THEN CAST(((reset_at-?1)*?4+(remaining-${HELD})*100-1)/((remaining-${HELD})*100) AS INTEGER) ELSE ?3 END),
        leases=json_insert(${LIVE_ARRAY},'$[#]',json_object('s',?1,'u',?6,'e',?1+?8))
        WHERE id=1 AND next_start_at<=?1
          AND ${LIVE_COUNT}<?7
          AND (remaining IS NULL OR reset_at<=?1 OR remaining-${HELD}-?6>=?5)
          ${claimWhere}
        RETURNING remaining,reset_at,last_request_at,next_start_at,prev_request_at,observed_request_at,
          header_remaining,header_reset_at,leases`)
        .bind(startedAt,floorMs,unknownMs,percent,floor,units,inFlight,LEASE_MS,...(priority?[priorityFlag]:[])).first();
    }catch(error){
      if(initialized)throw error;
      await initialize(db,pool);initialized=true;continue;
    }
    if(row){
      const held=liveLeases(row.leases,startedAt).reduce((sum,lease)=>sum+(lease.u||0),0);
      return {startedAt,units,
        // Units still free after every held maximum, this call's included.
        quota:{remaining:row.remaining==null?null:row.remaining-held,resetAt:row.reset_at,lastRequestAt:row.last_request_at},
        // HenrikDev's count before this call, and whether nothing else ran since.
        baseline:{clean:row.prev_request_at>0&&row.observed_request_at>=row.prev_request_at,
          remaining:row.header_remaining,resetAt:row.header_reset_at}};
    }
    row=await db.prepare(`SELECT remaining,reset_at,next_start_at,leases${claimColumn} FROM ${table} WHERE id=1`).first();
    if(!row){
      if(initialized)throw new Error('Upstream quota row unavailable');
      await initialize(db,pool);initialized=true;continue;
    }
    const current=now();
    const live=liveLeases(row.leases,current);
    const held=live.reduce((sum,lease)=>sum+(lease.u||0),0);
    const known=row.remaining!=null&&row.reset_at>current;
    // Not enough units even with nothing in flight: open again at the reset,
    // answered at once instead of retrying every 50 ms.
    const quotaWait=known&&row.remaining-units<floor?row.reset_at-current:0;
    // Units or places held by calls in flight: they free up as responses
    // arrive, or at the latest when their leases expire.
    const busy=live.length>=inFlight||known&&row.remaining-held-units<floor;
    const leaseWait=busy?Math.min(250,Math.max(50,Math.min(...live.map(lease=>lease.e))-current)):0;
    const claimWait=priority==='yield'?(row.priority_until||0)-current:0;
    const wait=Math.max(50,row.next_start_at-current,claimWait,quotaWait,leaseWait);
    if(quotaWait||current+wait>deadline)return {retryAfterMs:wait};
    // Claim the slot this lookup is about to wait for. MAX keeps a longer
    // claim made by another waiting lookup.
    if(priority==='claim')await db.prepare(`UPDATE ${table} SET priority_until=MAX(priority_until,?1) WHERE id=1`)
      .bind(current+wait+PRIORITY_CLAIM_MARGIN_MS).run();
    await sleepImpl(wait);
  }
}

export const acquireWorkflowPermit=(db,options)=>acquirePermit(db,workflowPool,options);
export const acquirePublicPermit=(db,options)=>acquirePermit(db,publicPool,options);
// Account lookups for a search: the whole public window, reserve included.
export const acquireProfilePermit=(db,options)=>acquirePermit(db,profilePool,options);
// Never waits: a collector call that cannot borrow now falls back to its own pool.
export const acquireBorrowedPublicPermit=(db,options)=>acquirePermit(db,borrowPool,{...options,maxWaitMs:0});

// Two headers of one window differ by at most the whole-second rounding of
// their reset plus response timing; a new window is about 60 s later.
export const SAME_WINDOW_MS=1500;

// Every response releases its call's lease. Only the newest admitted call's
// header sets the count (last_request_at): it counts every call HenrikDev had
// received by then, and calls still in flight keep holding their maxima until
// their own responses arrive. Do not update next_start_at here: a slow
// response must never reset the admission schedule.
async function observeQuota(db,{table},parsed,{startedAt,now=Date.now,status,retryAfterMs=0,
  expectedRemaining,expectedResetAt,runId,baseline=null,costKey=null,cacheStatus=null}={}){
  const current=now();
  const observed=await db.prepare(`UPDATE ${table} SET
    remaining=CASE WHEN last_request_at=?3 AND ?1 IS NOT NULL THEN ?1 ELSE remaining END,
    reset_at=CASE WHEN last_request_at=?3 THEN COALESCE(?2,reset_at) ELSE reset_at END,
    header_remaining=CASE WHEN last_request_at=?3 AND ?1 IS NOT NULL THEN ?1 ELSE header_remaining END,
    header_reset_at=CASE WHEN last_request_at=?3 AND ?2 IS NOT NULL THEN ?2 ELSE header_reset_at END,
    observed_request_at=MAX(observed_request_at,?3),
    leases=COALESCE((SELECT json_group_array(json(value)) FROM json_each(leases)
      WHERE json_extract(value,'$.s')<>?3 AND json_extract(value,'$.e')>?4),'[]')
    WHERE id=1 RETURNING last_request_at=?3 AS applied`)
    .bind(parsed.remaining,parsed.resetAt,startedAt,current).first();
  const applied=!!observed?.applied;
  if(table==='workflow_rate_quota')await recordQuotaObservation(db,parsed,
    {expectedRemaining,expectedResetAt,applied,current,runId});
  const cost=applied&&status!==429?measuredSample(baseline,parsed):null;
  if(cost!=null&&costKey){
    // A lost sample only delays measurement; it never fails the request.
    try{await recordCostSample(db,{pool:table==='workflow_rate_quota'?'workflow':'public',route:costKey,
      cacheStatus,status,cost,now:current});}catch{}
  }
  if(status!==429)return 0;
  // A real 429 stops every upstream caller even if this response arrived late,
  // until HenrikDev's reset or Retry-After, whichever is later.
  const until=Math.max(parsed.resetAt||0,retryAfterMs>0?current+retryAfterMs:0);
  const resetAt=until>current?until:current+NO_HEADER_429_WAIT_MS;
  const row=await db.prepare(`UPDATE ${table} SET remaining=0,
    reset_at=MAX(COALESCE(reset_at,0),?1) WHERE id=1 RETURNING reset_at`)
    .bind(resetAt).first();
  if(!row)throw new Error('Upstream quota row unavailable');
  return Math.max(1000,row.reset_at-current);
}

// The cost of a call that had the key to itself, or null.
export function measuredSample(baseline,parsed){
  if(!baseline?.clean||!Number.isInteger(baseline.remaining)||!Number.isInteger(parsed?.remaining))return null;
  if(!Number.isFinite(baseline.resetAt)||!Number.isFinite(parsed.resetAt))return null;
  if(Math.abs(parsed.resetAt-baseline.resetAt)>SAME_WINDOW_MS)return null;
  const cost=baseline.remaining-parsed.remaining;
  return cost>=0?cost:null;
}

// A call that never got a response (the fetch failed) gives its place back.
async function releaseLease(db,{table},startedAt,{now=Date.now}={}){
  await db.prepare(`UPDATE ${table} SET leases=COALESCE((SELECT json_group_array(json(value)) FROM json_each(leases)
    WHERE json_extract(value,'$.s')<>?1 AND json_extract(value,'$.e')>?2),'[]') WHERE id=1`).bind(startedAt,now()).run();
}
export const releaseWorkflowLease=(db,startedAt,options)=>releaseLease(db,workflowPool,startedAt,options);
export const releasePublicLease=(db,startedAt,options)=>releaseLease(db,publicPool,startedAt,options);

export const observeWorkflowQuota=(db,parsed,options)=>observeQuota(db,workflowPool,parsed,options);
export const observePublicQuota=(db,parsed,options)=>observeQuota(db,publicPool,parsed,options);
