export async function d1Query(env,sql,params=[],fetchImpl=fetch) {
  for(const key of ['CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])if(!env[key])throw new Error(`Missing ${key}`);
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
  const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  if(!response.ok||!body.success||!body.result?.[0]?.success)throw new Error(`D1 query failed (${response.status}): ${JSON.stringify(body.errors||[])}`);
  return body.result[0].results||[];
}
