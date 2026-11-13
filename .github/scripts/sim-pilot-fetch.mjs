// ML simulation pilot for ascend-companion-re (offline research, not part of the site): fetches
// each player listed in D1 `sim_pilot_players` their current-act competitive history through this
// site's own /api/stored-matches proxy, so it uses the public HenrikDev key behind the same atomic
// quota gate as live visitors. Paced well below the key's 60/min, waits out 429s, and stores a
// compact gzip+base64 history per player (no names or tags). Resumable: picks players without a
// status. Logs only counts (the repository and its Action logs are public). See docs/ml-sim-pilot.md.
import {gzipSync} from 'node:zlib';
import {d1Query,retryOnD1Overload} from './d1-query.mjs';

const env=process.env;
const ORIGIN=env.SITE_ORIGIN||'https://vlravg1.pages.dev';
const ACT=env.SIM_ACT||'e11a6';
const GAP_MS=Math.max(1000,Number(env.SIM_GAP_MS)||1500); // 40/min leaves the live site 20/min
const MAX_PAGES=4;
const deadline=Date.now()+Math.min(345,Math.max(5,Number(env.RUNTIME_MINUTES)||330))*60000;
const q=retryOnD1Overload((sql,params)=>d1Query(env,sql,params));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let last=0,requests=0,rateLimited=0,failed=0,players=0;

async function page(region,puuid,p){
  for(let attempt=0;attempt<6;attempt++){
    const wait=last+GAP_MS-Date.now();if(wait>0)await sleep(wait);
    if(Date.now()>=deadline)return{status:-1};
    last=Date.now();requests++;
    let res,body=null;
    try{res=await fetch(`${ORIGIN}/api/stored-matches/${region}/${puuid}?page=${p}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});body=await res.json().catch(()=>null);}
    catch{await sleep(10000);continue;}
    if(res.status===429){rateLimited++;await sleep(Math.max(2000,Math.min(Number(body?.retryAfterMs)||60000,120000)));continue;}
    if(res.status>=500){await sleep(10000*(attempt+1));continue;}
    return{status:res.status,body};
  }
  return{status:0};
}

function compact(m){
  const s=m.stats??{},me=String(s.team??'').toLowerCase(),ot=me==='red'?'blue':'red';
  return{m:m.meta?.id,t:m.meta?.started_at,ag:s.character?.id?.toLowerCase()??null,tm:me==='red'?1:0,k:s.kills,d:s.deaths,a:s.assists,sc:s.score,
    dm:s.damage?.made??null,dr:s.damage?.received??null,hs:s.shots?.head??0,bs:s.shots?.body??0,ls:s.shots?.leg??0,
    rw:m.teams?.[me]??null,rl:m.teams?.[ot]??null,tier:s.tier??null};
}

async function fetchPlayer({puuid,region}){
  const ms=[];let status=200;
  for(let p=1;p<=MAX_PAGES;p++){
    const r=await page(region,puuid,p);
    if(r.status===-1)return null; // run budget reached mid-player: leave it for the next run
    status=r.status;if(r.status!==200)break;
    const list=Array.isArray(r.body?.data)?r.body.data:[];
    let past=false;
    for(const m of list){
      const act=m.meta?.season?.short??null;
      if(act!==ACT){if(act)past=true;continue;}
      ms.push(compact(m));
    }
    if(past||list.length<100||!(r.body?.results?.after>0))break;
  }
  return{status,ms};
}

const t0=Date.now();
while(Date.now()<deadline){
  const batch=await q('SELECT puuid,region FROM sim_pilot_players WHERE status IS NULL LIMIT 40');
  if(!batch.length){console.log('All pilot players are fetched.');break;}
  for(const row of batch){
    if(Date.now()>=deadline)break;
    const h=await fetchPlayer(row);
    if(!h)break;
    if(h.status!==200&&h.status!==404)failed++;
    await q('UPDATE sim_pilot_players SET status=?1,n=?2,data=?3,fetched_at=?4 WHERE puuid=?5',
      [h.status,h.ms.length,gzipSync(JSON.stringify(h.ms)).toString('base64'),new Date().toISOString(),row.puuid]);
    if(++players%100===0){const min=(Date.now()-t0)/60000;console.log(`players ${players}, requests ${requests} (${(requests/min).toFixed(1)}/min), 429s ${rateLimited}, failed ${failed}`);}
  }
}
const [left]=await q('SELECT SUM(status IS NULL) AS left,COUNT(*) AS total FROM sim_pilot_players');
console.log(`Run done: players ${players}, requests ${requests}, 429s ${rateLimited}, failed ${failed}; remaining ${left?.left??'?'} of ${left?.total??'?'}.`);
