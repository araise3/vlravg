import {readFile,writeFile} from 'node:fs/promises';
const run=JSON.parse(await readFile('.local/riot-capacity-results.json','utf8'));
const all=run.frames.flatMap(f=>f.result.metrics || []);
const setups=run.setup?.setupMetrics || [];
const phases=['burst1','burst2','steady'].filter(p=>run.frames.some(f=>f.phase===p));
function maxWindow(metrics,windowMs){
  const sorted=[...metrics].sort((a,b)=>a.at-b.at);let left=0,max=0;
  for(let right=0;right<sorted.length;right++){
    while(sorted[right].at-sorted[left].at>=windowMs)left++;
    max=Math.max(max,right-left+1);
  }
  return max;
}
const pct=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;};
let doc='# Controlled EU Riot match-detail rate measurement\n\n';
doc+=`Started ${new Date(run.startedAt).toLocaleString('en-GB',{timeZone:'Europe/Berlin',hour12:false})} Europe/Berlin. Total elapsed ${(run.elapsedMs/1000).toFixed(1)} seconds.\n\n`;
doc+='The test used one dedicated account, one authenticated session, one EU host and one endpoint: `GET https://pd.eu.a.pvp.net/match-details/v1/matches/{id}`. Authentication, entitlement and content ran once; history IDs were discovered once. Detail calls rotated over a fixed list of accessible matches, without a local detail cache. These are repeated detail reads, not discovery of unique uncached matches. Each run was capped at 200 sequential requests, split into frames of at most 40 calls to stay below Worker subrequest limits.\n\n';
doc+=`The preview datacenter was ${run.setup?.colo??'unknown'}, and ${new Set(run.frames.map(f=>f.result.colo)).size} datacenter value(s) were recorded during detail frames. The same opaque session identifier was used across all frames: ${run.frames.every(f=>f.result.session===run.setup?.session)}. Encrypted temporary session state was kept server-side in the Cache API; no database schema or production provider was changed.\n\n`;
doc+='| Run | Requested pacing | Successful details | Rejected details | Detail interval, s | Max successful dispatches / 1s | / 10s | / 60s | Median / p95 transfer, ms |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n';
for(const phase of phases){
  const metrics=run.frames.filter(f=>f.phase===phase).flatMap(f=>f.result.metrics||[]);
  const successes=metrics.filter(m=>m.status===200), sorted=[...metrics].sort((a,b)=>a.at-b.at);
  const span=sorted.length?sorted.at(-1).at+sorted.at(-1).elapsedMs-sorted[0].at:0;
  doc+=`| ${phase} | ${phase==='steady'?'1 request/s':'none'} | ${successes.length} | ${metrics.length-successes.length} | ${(span/1000).toFixed(3)} | ${maxWindow(successes,1000)} | ${maxWindow(successes,10000)} | ${maxWindow(successes,60000)} | ${pct(successes.map(m=>m.elapsedMs),.5)} / ${pct(successes.map(m=>m.elapsedMs),.95)} |\n`;
}
doc+='\nIntervals run from first dispatch to final response completion. Whole-run time includes client/preview round trips and cooldowns. Rolling windows count dispatch timestamps and use half-open windows; they are client-side observations, not server quota counters.\n\n';
const headers=[...new Set([...setups,...all].flatMap(m=>m.rate?.present||[]))].sort();
doc+=`## Headers\n\nRate-control headers observed: ${headers.length?headers.map(h=>'`'+h+'`').join(', '):'none'}.\n\n`;
doc+='The allowlist checks application and method limit/count pairs, limit type, legacy limit/remaining/reset, RateLimit, RateLimit-Policy, and Retry-After. Structured RateLimit fields retain numeric quota/window values only, excluding opaque partition identifiers. No cookies, tokens, redirect URLs, raw player records or raw errors are returned.\n\n';
for(const frame of run.frames)for(const m of frame.result.metrics||[])if(m.status===429)
  doc+=`- ${frame.phase}: rejection at detail request ${m.phaseSequence}; Retry-After ${m.rate?.retryAfterMs==null?'absent':m.rate.retryAfterMs/1000+' seconds'}; server classification ${m.rate?.serverClass}; body type ${m.rate?.contentType}; Cloudflare Ray header present ${m.rate?.cloudflareRayPresent}; challenge marker ${m.rate?.challenge}; ${m.bytes} bytes; ${m.elapsedMs} ms.\n`;
doc+='\nA Cloudflare server header and plain 429 identify an upstream response served through Cloudflare. They do not alone distinguish a Cloudflare rate-limiting rule from a Riot service behind that edge, or reveal whether the quota is keyed by account, IP, route or another attribute.\n\n';
doc+='## Cooldown and accounting\n\n';
for(const c of run.cooldowns)doc+=`- Before ${c.before}: ${(c.waitedMs/1000).toFixed(1)} seconds idle.\n`;
doc+=`\n${setups.length} setup requests and ${all.length} detail attempts were recorded. Each phase stopped on its first rejection. A 429 enforces at least 120 seconds idle, or the supplied Retry-After if longer; the client adds five seconds. Missing/changed cache or non-rate failure stops the experiment.\n\n`;
if(run.error)doc+=`Experiment limitation: ${run.error}.\n\n`;
doc+=`Temporary session cleanup confirmed: ${run.cleanup?.ok===true}.\n\n`;
const bursts=['burst1','burst2'].map(p=>run.frames.filter(f=>f.phase===p).flatMap(f=>f.result.metrics||[]));
const rejected=bursts.map(a=>a.find(m=>m.status===429));
const steady=run.frames.filter(f=>f.phase==='steady').flatMap(f=>f.result.metrics||[]);
doc+='## Interpretation\n\n';
if(rejected.every(Boolean)&&rejected[0].phaseSequence===rejected[1].phaseSequence)
  doc+=`Both unpaced runs accepted ${rejected[0].phaseSequence-1} details and rejected request ${rejected[0].phaseSequence} after cooldown. That is a reproducible burst boundary for this session, endpoint and deployment. `;
if(steady.length)doc+=`The one-request-per-second run produced ${steady.filter(m=>m.status===200).length} successes and ${steady.filter(m=>m.status!==200).length} rejections. `;
if(steady.some(m=>m.status===429))
  doc+='\n\nThe sustained run also hit a limit despite client dispatch spacing of one second. The repeated burst result and Retry-After establish neither a reliably sustainable 60/minute budget nor a single fixed-window rule. Server arrival-time variation, longer windows, shared counters or another quota scope could affect this; the retained metadata cannot distinguish them. No lower sustained rate was validated in this experiment.\n';
else
  doc+='\n\nA 60-request burst boundary with Retry-After 60 seconds and successful sustained traffic would be consistent with a minute-scale limiter, but would still not constitute an explicitly published quota.\n';
doc+='\nThis is not proof of Riot-wide capacity. More general conclusions require endpoint/region/scope measurements or provider confirmation. A production scheduler should leave headroom and honor Retry-After, including on an already paced workload.\n';
await writeFile('docs/riot-capacity-measurement.md',doc);
await writeFile('docs/riot-capacity-results.json',JSON.stringify(run,null,2));
console.log(JSON.stringify({setupRequests:setups.length,detailRequests:all.length,headers,phases:phases.map(p=>{
  const a=run.frames.filter(f=>f.phase===p).flatMap(f=>f.result.metrics||[]);
  return {phase:p,successes:a.filter(m=>m.status===200).length,rejections:a.filter(m=>m.status!==200).length};
})}));
