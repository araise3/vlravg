const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// All workers share this gate. Overlap network latency without multiplying the
// start rate. A proxy 429 pauses the whole queue, not just one player.
export function createRequestScheduler({fetchImpl=fetch,sleepImpl=sleep,now=Date.now,intervalMs=1000}={}) {
  let gate=Promise.resolve(),nextStart=0,blockedUntil=0;
  return async (url,options) => {
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
    const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(45000)});
    if(response.status===429){
      const body=await response.clone().json().catch(()=>null);
      const wait=Number.isFinite(body?.retryAfterMs)?Math.max(1000,Math.min(body.retryAfterMs,120000)):60000;
      blockedUntil=Math.max(blockedUntil,now()+wait);
    }
    return response;
  };
}
