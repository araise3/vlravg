export async function d1Query(env,sql,params=[],fetchImpl=fetch) {
  for(const key of ['CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])if(!env[key])throw new Error(`Missing ${key}`);
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
  const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  if(!response.ok||!body.success||!body.result?.[0]?.success)throw new Error(`D1 query failed (${response.status}): ${JSON.stringify(body.errors||[])}`);
  const results=body.result[0].results||[];
  // D1's own time for the statement, for pacedQuery (not enumerable, so the
  // rows read the same everywhere else).
  const ms=body.result[0].meta?.duration;
  if(Number.isFinite(ms))Object.defineProperty(results,D1_MS,{value:ms});
  return results;
}
export const D1_MS=Symbol('d1Ms');

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
export async function d1DatabaseSize(env,fetchImpl=fetch){
  for(const key of ['CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])if(!env[key])throw new Error(`Missing ${key}`);
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
  const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({sql:'SELECT 1',params:[]}),signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  if(!response.ok||!body.success||!body.result?.[0]?.success)throw new Error(`D1 query failed (${response.status}): ${JSON.stringify(body.errors||[])}`);
  const size=body.result[0].meta?.size_after;
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
