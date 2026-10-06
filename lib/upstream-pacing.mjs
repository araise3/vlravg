export const WORKFLOW_SPACING_MS=2100;
export const PUBLIC_UNKNOWN_SPACING_MS=2100;
const workflowPool={table:'workflow_rate_quota',floorMs:WORKFLOW_SPACING_MS,unknownMs:WORKFLOW_SPACING_MS,percent:100};
// Learn the public key's own budget from headers, rather than assuming its tier.
// Known quota is spread over the remaining window with 5% timing headroom.
const publicPool={table:'rate_quota',floorMs:150,unknownMs:PUBLIC_UNKNOWN_SPACING_MS,percent:105};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function initialize(db,{table}){
  // Table names come exclusively from the two private pool definitions above.
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY CHECK(id=1),remaining INTEGER,reset_at INTEGER,
    last_request_at INTEGER,next_start_at INTEGER NOT NULL DEFAULT 0)`).run();
  try{await db.prepare(`SELECT next_start_at FROM ${table} WHERE id=1`).first();}
  catch{
    // Additive upgrade from the original four-column quota tables.
    // Another request may win this ALTER; check the resulting schema either way.
    try{await db.prepare(`ALTER TABLE ${table} ADD COLUMN next_start_at INTEGER NOT NULL DEFAULT 0`).run();}
    catch{await db.prepare(`SELECT next_start_at FROM ${table} WHERE id=1`).first();}
  }
  await db.prepare(`INSERT OR IGNORE INTO ${table} (id,remaining,reset_at,last_request_at,next_start_at) VALUES(1,NULL,0,0,0)`).run();
}

// The conditional write is the authority, not a preceding read. Two requests
// cannot claim the same slot, including across isolates or stale D1 read replicas.
// A bounded server wait covers four concurrent backfill workers; larger queues
// receive the existing retryAfterMs signal rather than holding requests forever.
async function acquirePermit(db,pool,{now=Date.now,sleepImpl=sleep,maxWaitMs=8000}={}){
  if(!db)throw new Error('Upstream pacing requires APP_DB');
  const {table,floorMs,unknownMs,percent}=pool;
  const deadline=now()+maxWaitMs;
  let initialized=false;
  for(;;){
    const startedAt=now();
    let row;
    try{
      row=await db.prepare(`UPDATE ${table} SET
        remaining=CASE WHEN reset_at<=?1 THEN NULL WHEN remaining IS NULL THEN NULL ELSE remaining-1 END,
        reset_at=CASE WHEN reset_at<=?1 THEN 0 ELSE reset_at END,
        last_request_at=?1,next_start_at=?1+MAX(?2,
          CASE WHEN remaining>0 AND reset_at>?1
            THEN CAST(((reset_at-?1)*?4+remaining*100-1)/(remaining*100) AS INTEGER) ELSE ?3 END)
        WHERE id=1 AND next_start_at<=?1
          AND (remaining IS NULL OR remaining>0 OR reset_at<=?1)
        RETURNING remaining,reset_at,last_request_at,next_start_at`)
        .bind(startedAt,floorMs,unknownMs,percent).first();
    }catch(error){
      if(initialized)throw error;
      await initialize(db,pool);initialized=true;continue;
    }
    if(row)return {startedAt,quota:{remaining:row.remaining,resetAt:row.reset_at,lastRequestAt:row.last_request_at}};
    row=await db.prepare(`SELECT remaining,reset_at,next_start_at FROM ${table} WHERE id=1`).first();
    if(!row){
      if(initialized)throw new Error('Upstream quota row unavailable');
      await initialize(db,pool);initialized=true;continue;
    }
    const current=now();
    const quotaWait=row.remaining!=null&&row.remaining<=0?Math.max(0,row.reset_at-current):0;
    const wait=Math.max(50,row.next_start_at-current,quotaWait);
    if(quotaWait||current+wait>deadline)return {retryAfterMs:wait};
    await sleepImpl(wait);
  }
}

export const acquireWorkflowPermit=(db,options)=>acquirePermit(db,workflowPool,options);
export const acquirePublicPermit=(db,options)=>acquirePermit(db,publicPool,options);

// Reservations subtract in-flight calls before headers arrive. An older response
// must not replenish capacity already reserved by newer requests. Do not update
// next_start_at here: a slow response must never reset the admission schedule.
async function observeQuota(db,{table},parsed,{startedAt,now=Date.now,status,retryAfterMs=0}={}){
  const current=now();
  await db.prepare(`UPDATE ${table} SET
    remaining=CASE WHEN ?1 IS NULL THEN remaining
      WHEN reset_at>?3 AND remaining IS NOT NULL THEN MIN(remaining,?1) ELSE ?1 END,
    reset_at=COALESCE(?2,reset_at)
    WHERE id=1 AND last_request_at=?4`)
    .bind(parsed.remaining,parsed.resetAt,current,startedAt).run();
  if(status!==429)return 0;
  // A real 429 stops every upstream caller even if this response arrived late.
  const resetAt=Math.max(parsed.resetAt||0,current+(retryAfterMs||60000));
  const row=await db.prepare(`UPDATE ${table} SET remaining=0,
    reset_at=MAX(COALESCE(reset_at,0),?1) WHERE id=1 RETURNING reset_at`)
    .bind(resetAt).first();
  if(!row)throw new Error('Upstream quota row unavailable');
  return Math.max(1000,row.reset_at-current);
}

export const observeWorkflowQuota=(db,parsed,options)=>observeQuota(db,workflowPool,parsed,options);
export const observePublicQuota=(db,parsed,options)=>observeQuota(db,publicPool,parsed,options);
