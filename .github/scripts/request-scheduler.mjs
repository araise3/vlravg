const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// All workers share this gate. Overlap network latency without multiplying the
// start rate. A proxy 429 pauses the whole queue, not just one player.
// The workflow key allows 30 requests/minute. 2.1s spacing leaves headroom
// (at most 29 starts in a rolling minute), including concurrent backfill workers.
export function createRequestScheduler({fetchImpl=fetch,sleepImpl=sleep,now=Date.now,intervalMs=2100,workflowKey,origin}={}) {
  if(workflowKey&&!origin)throw new Error('Workflow requests require SITE_ORIGIN');
  const workflowOrigin=workflowKey?new URL(origin).origin:null;
  let gate=Promise.resolve(),nextStart=0,blockedUntil=0;
  return async (url,options) => {
    let requestOptions=options;
    if(workflowKey){
      const target=new URL(url);
      if(target.protocol!=='https:'||target.origin!==workflowOrigin||!target.pathname.startsWith('/api/')){
        throw new Error('Workflow key may only be sent to SITE_ORIGIN /api/ over HTTPS');
      }
      const headers=new Headers(options?.headers);
      headers.set('X-Workflow-Key',workflowKey);
      // Refuse redirects so a changed origin can never receive this secret.
      requestOptions={...options,headers,redirect:'error'};
    }
    const turn=gate.then(async()=>{
      for(;;){
        const wait=Math.max(nextStart,blockedUntil)-now();
        if(wait<=0)break;
        await sleepImpl(wait);
      }
      nextStart=now()+intervalMs;
    });
    gate=turn.catch(()=>{});
    await turn;
    // Start the network timeout after acquiring the rate-limit gate.
    const response=await fetchImpl(url,{...requestOptions,signal:AbortSignal.timeout(45000)});
    if(response.status===429){
      const body=await response.clone().json().catch(()=>null);
      const wait=Number.isFinite(body?.retryAfterMs)?Math.max(1000,Math.min(body.retryAfterMs,120000)):60000;
      blockedUntil=Math.max(blockedUntil,now()+wait);
    }
    return response;
  };
}
