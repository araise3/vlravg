// Every statement a script sends to D1 goes through d1Query, and so through
// one governor per process (createD1Governor). The site and every script
// share one database, and D1 rejects all of its queries for a few seconds
// once it has used too much CPU and memory within ten seconds (error 7429).
// The site's queries are single-row and well under a millisecond; the
// overloads of 23 and 24 Nov 2026 were script reads, the second one up to
// four copies of the collector's player read at once
// (docs/rr-collector-d1-load.md). So the governor holds that budget on the
// scripts' side, whatever the caller does:
// - one statement at a time per process, so no caller can stack heavy reads;
// - after each statement D1 stays free for PACE_FACTOR times as long as the
//   statement kept it busy (at most maxPauseMs), so scripts use at most about
//   a fifth of D1's time;
// - a statement that kept D1 busy longer than D1_SLOW_MS is logged as a
//   GitHub warning, so a read that grows with its tables shows up long
//   before it can overload D1.
// It does not see `wrangler d1 execute` or other processes: each process has
// its own governor.
export const D1_SLOW_MS=1000;
export function createD1Governor({factor=PACE_FACTOR,maxPauseMs=20000,slowMs=D1_SLOW_MS,now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=console.warn}={}){
  let tail=Promise.resolve(),openAt=-Infinity;
  const stats={statements:0,busyMs:0,slow:0,slowest:null};
  function run(label,send){
    const turn=tail.then(async()=>{
      const wait=openAt-now();
      if(wait>0)await sleep(wait);
      const started=now();
      let busy=null;
      try{const out=await send();busy=out?.ms??null;return out;}
      finally{
        // Without D1's own time (a failed statement) the round trip counts.
        const ms=Number.isFinite(busy)?busy:now()-started;
        stats.statements++;stats.busyMs+=ms;
        if(!stats.slowest||ms>stats.slowest.ms)stats.slowest={ms:Math.round(ms),sql:label};
        if(ms>slowMs){stats.slow++;log(`::warning::Slow D1 statement (${Math.round(ms)} ms): ${label}`);}
        openAt=now()+Math.min(maxPauseMs,factor*ms);
      }
    });
    tail=turn.catch(()=>{});
    return turn;
  }
  return {run,stats};
}
let sharedGovernor=null;
export const d1Governor=()=>sharedGovernor??=createD1Governor();

export async function d1Query(env,sql,params=[],fetchImpl=fetch,{governor=d1Governor()}={}) {
  for(const key of ['CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])if(!env[key])throw new Error(`Missing ${key}`);
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
  const label=String(sql).replace(/\s+/g,' ').trim().slice(0,160);
  const {results,meta}=await governor.run(label,async()=>{
    const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(60000)});
    const body=await response.json();
    if(!response.ok||!body.success||!body.result?.[0]?.success)throw new Error(`D1 query failed (${response.status}): ${JSON.stringify(body.errors||[])}`);
    const meta=body.result[0].meta||{};
    return {results:body.result[0].results||[],meta,ms:meta.duration};
  });
  // D1's own time for the statement, and its whole meta (rows read, size),
  // not enumerable, so the rows read the same everywhere else.
  if(Number.isFinite(meta.duration))Object.defineProperty(results,D1_MS,{value:meta.duration});
  Object.defineProperty(results,D1_META,{value:meta});
  return results;
}
export const D1_MS=Symbol('d1Ms');
export const D1_META=Symbol('d1Meta');

// Reads keyed by PUUID, cut into ranges small enough that no statement holds
// D1 for long however large the tables grow. `run(lo,hi)` reads the rows
// with lo <= puuid < hi. The ranges cover every string: the first starts at
// '' and the last ends at '~', above every hex digit and letter, so a PUUID
// lands in exactly one range whatever its case; inner bounds are 8-digit
// lowercase hex prefixes. After each range the next one is resized so that it
// should take about targetMs of D1 time (at most doubled or quartered per
// step); without a reported time the size stays. `parts` is only the first
// guess. The 24 Nov 2026 player read was 2.2 s in one statement and grows
// with every tracked account; the census and gap scan grow with rr_history.
// forEachPuuidRange hands each range's result to the caller (the census
// merges per-range groups, the gap scan inserts per range) and resizes by the
// D1 time attached to what `run` returns; it returns the number of ranges.
export const SLICE_TARGET_MS=250;
const PUUID_SPACE=2**32;
const puuidBound=n=>Math.floor(n).toString(16).padStart(8,'0');
export async function forEachPuuidRange(run,{parts=16,targetMs=SLICE_TARGET_MS,maxParts=65536}={}){
  let position=0,width=PUUID_SPACE/parts,slices=0;
  while(position<PUUID_SPACE){
    const end=Math.min(PUUID_SPACE,position+Math.max(PUUID_SPACE/maxParts,Math.floor(width)));
    const part=await run(position?puuidBound(position):'',end>=PUUID_SPACE?'~':puuidBound(end));
    slices++;
    const ms=part?.[D1_MS];
    if(Number.isFinite(ms))width*=Math.min(2,Math.max(0.25,targetMs/Math.max(ms,1)));
    position=end;
  }
  return slices;
}
export async function readByPuuidRange(run,options){
  const rows=[];
  const slices=await forEachPuuidRange(async(lo,hi)=>{
    const part=await run(lo,hi);
    for(const row of part)rows.push(row);
    return part;
  },options);
  Object.defineProperty(rows,'slices',{value:slices});
  return rows;
}

// D1 rejects work when a database consumes too much in a 10-second window
// (HTTP 429, code 7429). Read-only callers can wait out the window and retry.
export function isD1Overload(error){
  return /D1 query failed \(429\)|"code":7429/.test(String(error?.message||''));
}
export function retryOnD1Overload(query,{delays=[15000,30000,60000],
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=console.warn}={}){
  return async(...args)=>{
    for(let attempt=0;;attempt++){
      try{return await query(...args);}
      catch(error){
        if(!isD1Overload(error)||attempt>=delays.length)throw error;
        log(`D1 overloaded; retrying read in ${delays[attempt]/1000}s (${attempt+1}/${delays.length}).`);
        await sleep(delays[attempt]);
      }
    }
  };
}

// Pace a series of heavy reads (sliced whole-table passes). Before each read
// it waits `factor` times as long as the previous read kept D1 busy, at least
// `minPauseMs`, so the collector holds D1 for at most about 1/(1+factor) of
// the time and the site's own queries keep fitting in D1's 10-second window.
// D1 reports its own time per statement (d1Query attaches it); without that
// report (a failed read) the whole round trip is used, which errs on the slow
// side. 16 census slices of about 4.4 s each with a fixed 1 s pause kept D1
// about 80% busy and overloaded it at the end of every run (23 Nov 2026,
// docs/rr-collector-d1-load.md).
export const PACE_FACTOR=4;
export function pacedQuery(query,{factor=PACE_FACTOR,minPauseMs=500,maxPauseMs=20000,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}){
  let wait=0;
  const paced=async(...args)=>{
    if(wait)await sleep(wait);
    const started=now();
    let busy=null;
    try{const rows=await query(...args);busy=rows?.[D1_MS]??null;return rows;}
    finally{wait=Math.min(maxPauseMs,Math.max(minPauseMs,factor*(busy??now()-started)));}
  };
  return paced;
}

// A lower bound for "date is within the last `days` days" that SQLite can
// answer from a date index. rr_history dates are ISO UTC strings
// (YYYY-MM-DDTHH:MM:SS[.fff]Z); a bound one second early, cut to whole
// seconds, sorts at or below every such string in the window, so pairing it
// with the exact julianday() test keeps the same rows while reading only the
// window instead of every row.
export const recentDateBound=days=>`strftime('%Y-%m-%dT%H:%M:%SZ','now','-${Number(days)} days','-1 second')`;

// D1's per-database size limit (10 GB on Workers Paid). Every query result
// reports the database size, so a trivial read is enough to check it.
export const D1_SIZE_LIMIT_BYTES=10e9;
export const D1_HEADROOM_BYTES=200e6;
export async function d1DatabaseSize(env,fetchImpl=fetch,options){
  const size=(await d1Query(env,'SELECT 1',[],fetchImpl,options))[D1_META]?.size_after;
  return Number.isFinite(size)?size:null;
}
export async function assertD1Headroom(env,{fetchImpl=fetch,limit=D1_SIZE_LIMIT_BYTES,headroom=D1_HEADROOM_BYTES}={}){
  const size=await d1DatabaseSize(env,fetchImpl);
  if(size!=null&&size>=limit-headroom){
    const error=new Error(`D1 database is ${(size/1e9).toFixed(2)} GB of its ${(limit/1e9).toFixed(0)} GB limit; free space before collecting`);
    error.code='WORKFLOW_STORAGE';throw error;
  }
  return size;
}
