export async function d1Query(env,sql,params=[],fetchImpl=fetch) {
  for(const key of ['CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])if(!env[key])throw new Error(`Missing ${key}`);
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
  const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  if(!response.ok||!body.success||!body.result?.[0]?.success)throw new Error(`D1 query failed (${response.status}): ${JSON.stringify(body.errors||[])}`);
  return body.result[0].results||[];
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
