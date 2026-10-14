// Cloudflare schedules actual upstream calls atomically. This wrapper
// authenticates requests and sets their timeout. The collector opts into FIFO
// admission and shared cooldowns; other callers retain immediate saved-data reads.
export function createRequestScheduler({fetchImpl=fetch,workflowKey,origin,runId,serialize=false,
  deadline=Infinity,now=Date.now,sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(workflowKey&&!origin)throw new Error('Workflow requests require SITE_ORIGIN');
  const workflowOrigin=workflowKey?new URL(origin).origin:null;
  let readiness;
  let queue=Promise.resolve(),cooldownUntil=0;
  const request=async (url,options) => {
    if(now()<cooldownUntil)await sleepImpl(Math.min(cooldownUntil,deadline)-now());
    if(now()>=deadline){
      const error=new Error('Collection run budget exhausted');error.code='WORKFLOW_BUDGET';throw error;
    }
    let requestOptions=options;
    if(workflowKey){
      const target=new URL(url);
      if(target.protocol!=='https:'||target.origin!==workflowOrigin||!target.pathname.startsWith('/api/')){
        throw new Error('Workflow key may only be sent to SITE_ORIGIN /api/ over HTTPS');
      }
      const headers=new Headers(options?.headers);
      headers.set('X-Workflow-Key',workflowKey);
      if(runId)headers.set('X-Workflow-Run',runId);
      // Refuse redirects so a changed origin can never receive this secret.
      requestOptions={...options,headers,redirect:'error'};
      // One shared, D1-only probe prevents a new client from sending unpaced
      // traffic to an older proxy while a Pages deployment is still building.
      readiness??=(async()=>{
        const response=await fetchImpl(`${workflowOrigin}/api/calib-model`,{
          headers:new Headers({'X-Workflow-Key':workflowKey,Accept:'application/json'}),
          redirect:'error',signal:AbortSignal.timeout(45000),
        });
        const ready=response.ok&&response.headers.get('X-Workflow-Pacing')==='upstream-v1';
        await response.body?.cancel();
        if(!ready){
          const hint=response.status===401?'HENRIK_WORKFLOW_KEY must match in GitHub Actions and Cloudflare Pages production'
            :response.status===503?'Check the Pages production HENRIK_WORKFLOW_KEY and proxy availability'
            :'Deploy the updated Pages Function first';
          const error=new Error(`Central workflow pacing is not ready (HTTP ${response.status}); ${hint}`);
          error.code='WORKFLOW_CONFIGURATION';
          throw error;
        }
      })().catch(error=>{readiness=undefined;throw error;});
      await readiness;
    }
    const response=await fetchImpl(url,{...requestOptions,signal:AbortSignal.timeout(45000)});
    if(serialize&&response.status===429){
      const body=await response.clone().json().catch(()=>null);
      const wait=Number.isFinite(body?.retryAfterMs)?Math.max(1000,body.retryAfterMs):60000;
      cooldownUntil=Math.max(cooldownUntil,now()+wait);
    }
    return response;
  };
  // FIFO admission avoids workers repeatedly racing for one server-side slot.
  // A 429 pauses queued requests too; the proxy remains the quota authority.
  return serialize?(url,options)=>{
    const pending=queue.then(()=>request(url,options));
    queue=pending.catch(()=>{});return pending;
  }:request;
}
