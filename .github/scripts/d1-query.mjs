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
