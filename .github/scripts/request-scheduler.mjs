// Cloudflare schedules actual upstream calls atomically. This wrapper only
// authenticates proxy requests and sets their timeout: D1-only reads have no
// client delay. requestJSON retries individual 429s using the proxy wait time.
export function createRequestScheduler({fetchImpl=fetch,workflowKey,origin}={}) {
  if(workflowKey&&!origin)throw new Error('Workflow requests require SITE_ORIGIN');
  const workflowOrigin=workflowKey?new URL(origin).origin:null;
  let readiness;
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
    return fetchImpl(url,{...requestOptions,signal:AbortSignal.timeout(45000)});
  };
}
