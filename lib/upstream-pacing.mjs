import {recordQuotaObservation} from './workflow-quota-audit.mjs';
export const WORKFLOW_SPACING_MS=2100;
export const PUBLIC_UNKNOWN_SPACING_MS=2100;
// HenrikDev states its window reset in whole seconds. On 24 Nov 2026 a call
// sent 0.16 s after the stated reset got a real 429 with Retry-After 60,
// which stops every caller for a minute. Parsed reset times therefore add
// this guard (functions/api/[[path]].js parseUpstreamQuota).
export const RESET_GUARD_MS=1000;
// When a 429 carries no reset, wait this long instead of guessing a full
// minute. HenrikDev never sends Retry-After (docs/henrikdev-429-behaviour.md);
// the 60 s block at 21:47 on 24 Nov 2026 was this gate's former 60 s default.
export const NO_HEADER_429_WAIT_MS=5000;
// HenrikDev's window is one minute (`ratelimit-policy: q=60;w=60`). A call
// that lands right at the reset gets a 429 claiming a full new window (reset
// 60) although the window opens about a second later: seen at all three
// boundaries of the 429 test, and the cause of the 60 s block at 21:04 on
// 24 Nov 2026. A 429 whose reset is within BOUNDARY_429_MS of a whole window
// is treated as that and waits BOUNDARY_429_WAIT_MS. A window genuinely spent
// in its first seconds then costs one more 429, which HenrikDev neither
// counts nor punishes (same doc).
export const QUOTA_WINDOW_MS=60000;
export const BOUNDARY_429_MS=2000;
export const BOUNDARY_429_WAIT_MS=2000;
// Calls in flight at once per key, and how long an unanswered call holds its
// place (a Worker that dies mid-call never releases it).
// PUBLIC_IN_FLIGHT bounds a site window whose count is unknown (no header
// yet), where admission checks no units. Once HenrikDev's count is known,
// every call holds its maximum cost, so units bound the key and the cap only
// limits how many calls one window runs at once: PUBLIC_IN_FLIGHT_KNOWN fits
// a search's opening burst (rank, RR history, name history, three live
// pages). With 3, that burst queued behind slow calls (25 Nov 2026,
// docs/profile-quota-reserve.md).
export const PUBLIC_IN_FLIGHT=3;
export const PUBLIC_IN_FLIGHT_KNOWN=6;
export const WORKFLOW_IN_FLIGHT=1;
export const LEASE_MS=30000;
// Units kept back from HenrikDev's count for use of the key outside the gate.
export const QUOTA_MARGIN=2;
// `percent`: with a known count, space calls so the free units last the rest
// of the window, plus this much timing headroom (100 = none). The collector
// keeps it. The site pools use 0, which turns it off (the spacing formula
// then gives 0, leaving `floorMs`): their units are already bound by the held
// maxima below, and spreading them only delayed a search's own calls (about
// 1 s apart with a full window; 25 Nov 2026). An unknown window keeps
// `unknownMs` in every pool.
const workflowPool={table:'workflow_rate_quota',floorMs:WORKFLOW_SPACING_MS,unknownMs:WORKFLOW_SPACING_MS,percent:100,
  inFlight:WORKFLOW_IN_FLIGHT,inFlightKnown:WORKFLOW_IN_FLIGHT};
// Learn the public key's own budget from headers, rather than assuming its tier.
//
// Quota is counted in HenrikDev's units, not calls: "1 request to the API =
// +1" and "1 background request to Riot = +1" (docs.henrikdev.xyz
// general/rate-limiting). The site key has 60 units a minute and the workflow
// key 30. `remaining` is HenrikDev's own count from the newest response; the
// gate never guesses it. Only calls in flight are unknown, so:
// - at most `inFlight` calls run at once per key (`inFlightKnown` once the
//   count is known), each holding a lease;
// - a lease holds the call's maximum cost (`units`, lib/upstream-cost.mjs
//   maxUnits), released when its response arrives;
// - a call is admitted only while HenrikDev's count minus every held maximum
//   minus its own still leaves QUOTA_MARGIN, plus the pool's reserve.
// So no admitted call can find the key empty unless something outside the
// gate used it. Counting every call as one let the gate admit calls HenrikDev
// had no units for; its 429 then stopped every caller (24 Nov 2026).
// A 429 itself costs nothing (docs/henrikdev-429-behaviour.md); this keeps
// the account-lookup reserve, which HenrikDev knows nothing about.
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
// lookup now claims the next slot (`priority_until`); other public calls do
// not take a slot while a claim is live. A claim
// lasts until the slot it waits for plus this margin, so one left behind by a
// lookup that gave up holds the others back at most that long.
export const PRIORITY_CLAIM_MARGIN_MS=500;
const profilePool={table:'rate_quota',floorMs:150,unknownMs:PUBLIC_UNKNOWN_SPACING_MS,percent:0,priority:'claim',
  inFlight:PUBLIC_IN_FLIGHT,inFlightKnown:PUBLIC_IN_FLIGHT_KNOWN};
// `reserve`: units that must still be left after the call.
const publicPool={...profilePool,reserve:PUBLIC_PROFILE_RESERVE,priority:'yield'};
// Collector calls never use the site key. They used to borrow it while 30
// units stayed free, which left every quiet window at about 32 and a search
// unable to reach its first history page (live test, 25 Nov 2026).
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const QUOTA_COLUMNS=[['next_start_at','INTEGER NOT NULL DEFAULT 0'],['leases',"TEXT NOT NULL DEFAULT '[]'"]];
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
// call: in the collector pool the units still free are spread over the window.
async function acquirePermit(db,pool,{now=Date.now,sleepImpl=sleep,maxWaitMs=8000,units:requested=1}={}){
  if(!db)throw new Error('Upstream pacing requires APP_DB');
  const {table,floorMs,unknownMs,percent,reserve=null,priority=null,inFlight,inFlightKnown}=pool;
  const units=Number.isInteger(requested)&&requested>0?requested:1;
  const floor=QUOTA_MARGIN+(reserve||0);
  // ?9: 1 = yield to a live claim, 0 = a claimant, which clears it on admission.
  const priorityFlag=priority==='yield'?1:priority==='claim'?0:null;
  const claimSet=priority?'priority_until=CASE WHEN ?9=0 THEN 0 ELSE priority_until END,':'';
  const claimWhere=priority?'AND (?9 IS NOT 1 OR priority_until<=?1)':'';
  const claimColumn=priority?',priority_until':'';
  // From the private pool definitions above, never from a request.
  const knownCap=Number(inFlightKnown);
  const deadline=now()+maxWaitMs;
  let initialized=false;
  for(;;){
    const startedAt=now();
    let row;
    try{
      row=await db.prepare(`UPDATE ${table} SET
        remaining=CASE WHEN reset_at<=?1 THEN NULL ELSE remaining END,
        reset_at=CASE WHEN reset_at<=?1 THEN 0 ELSE reset_at END,
        last_request_at=?1,${claimSet}
        next_start_at=?1+MAX(?2,
          CASE WHEN remaining IS NOT NULL AND reset_at>?1 AND remaining-${HELD}>0
            THEN CAST(((reset_at-?1)*?4+(remaining-${HELD})*100-1)/((remaining-${HELD})*100) AS INTEGER) ELSE ?3 END),
        leases=json_insert(${LIVE_ARRAY},'$[#]',json_object('s',?1,'u',?6,'e',?1+?8))
        WHERE id=1 AND next_start_at<=?1
          AND ${LIVE_COUNT}<CASE WHEN remaining IS NOT NULL AND reset_at>?1 THEN ${knownCap} ELSE ?7 END
          AND (remaining IS NULL OR reset_at<=?1 OR remaining-${HELD}-?6>=?5)
          ${claimWhere}
        RETURNING remaining,reset_at,last_request_at,next_start_at,leases`)
        .bind(startedAt,floorMs,unknownMs,percent,floor,units,inFlight,LEASE_MS,...(priority?[priorityFlag]:[])).first();
    }catch(error){
      if(initialized)throw error;
      await initialize(db,pool);initialized=true;continue;
    }
    if(row){
      const held=liveLeases(row.leases,startedAt).reduce((sum,lease)=>sum+(lease.u||0),0);
      return {startedAt,units,
        // Units still free after every held maximum, this call's included.
        quota:{remaining:row.remaining==null?null:row.remaining-held,resetAt:row.reset_at,lastRequestAt:row.last_request_at}};
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
    const busy=live.length>=(known?knownCap:inFlight)||known&&row.remaining-held-units<floor;
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

// Every response releases its call's lease. Only the newest admitted call's
// header sets the count (last_request_at): it counts every call HenrikDev had
// received by then, and calls still in flight keep holding their maxima until
// their own responses arrive. Do not update next_start_at here: a slow
// response must never reset the admission schedule.
async function observeQuota(db,{table},parsed,{startedAt,now=Date.now,status,retryAfterMs=0,
  expectedRemaining,expectedResetAt,runId}={}){
  const current=now();
  const observed=await db.prepare(`UPDATE ${table} SET
    remaining=CASE WHEN last_request_at=?3 AND ?1 IS NOT NULL THEN ?1 ELSE remaining END,
    reset_at=CASE WHEN last_request_at=?3 THEN COALESCE(?2,reset_at) ELSE reset_at END,
    leases=COALESCE((SELECT json_group_array(json(value)) FROM json_each(leases)
      WHERE json_extract(value,'$.s')<>?3 AND json_extract(value,'$.e')>?4),'[]')
    WHERE id=1 RETURNING last_request_at=?3 AS applied`)
    .bind(parsed.remaining,parsed.resetAt,startedAt,current).first();
  const applied=!!observed?.applied;
  if(table==='workflow_rate_quota')await recordQuotaObservation(db,parsed,
    {expectedRemaining,expectedResetAt,applied,current,runId});
  if(status!==429)return 0;
  // A real 429 stops every upstream caller even if this response arrived late,
  // until HenrikDev's reset or Retry-After, whichever is later; a boundary
  // 429 only for BOUNDARY_429_WAIT_MS, replacing the reset it claimed.
  const resetIn=Number.isFinite(parsed.resetAt)?parsed.resetAt-RESET_GUARD_MS-current:null;
  const boundary=!(retryAfterMs>0)&&resetIn!=null&&resetIn>=QUOTA_WINDOW_MS-BOUNDARY_429_MS;
  const until=Math.max(parsed.resetAt||0,retryAfterMs>0?current+retryAfterMs:0);
  const resetAt=boundary?current+BOUNDARY_429_WAIT_MS:until>current?until:current+NO_HEADER_429_WAIT_MS;
  const row=await db.prepare(`UPDATE ${table} SET remaining=0,
    reset_at=CASE WHEN ?2 THEN ?1 ELSE MAX(COALESCE(reset_at,0),?1) END WHERE id=1 RETURNING reset_at`)
    .bind(resetAt,boundary?1:0).first();
  if(!row)throw new Error('Upstream quota row unavailable');
  return Math.max(1000,row.reset_at-current);
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
