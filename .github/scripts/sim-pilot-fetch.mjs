// ML simulation pilot for ascend-companion-re (offline research, not part of the site): fetches
// each player listed in D1 `sim_pilot_players` their current-act competitive history through this
// site's own /api/stored-matches proxy, so it uses the public HenrikDev key behind the same atomic
// quota gate as live visitors. Paced well below the key's 60/min, waits out 429s, and stores a
// compact gzip+base64 history per player (no names or tags). Logs only counts (the repository and
// its Action logs are public). See docs/ml-sim-pilot.md.
//
// Runs unattended overnight, so nothing transient may stop it:
// - every D1 call and every page request retries network errors, 5xx and 429 with backoff;
// - a player is saved only when all their pages came back (200) or the account is unknown (404);
//   any other outcome leaves the row unfetched and counts an attempt, and after MAX_ATTEMPTS the
//   row is closed with status 0 so one broken account can't block the pilot;
// - the script never throws: it reports `remaining` and `progressed` to $GITHUB_OUTPUT so the
//   workflow can start the next run itself (GitHub drops many scheduled triggers).
import {gzipSync} from 'node:zlib';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {d1Query} from './d1-query.mjs';

export const MAX_PAGES=10;     // 1,000 matches: more than anyone plays in an act
export const MAX_ATTEMPTS=3;
export const WORKERS=2;        // a page takes 1-2 s, so one worker alone can't keep the pace

const realSleep=ms=>new Promise(r=>setTimeout(r,ms));

export function compact(m){
  const s=m.stats??{},me=String(s.team??'').toLowerCase(),ot=me==='red'?'blue':'red';
  return{m:m.meta?.id,t:m.meta?.started_at,ag:s.character?.id?.toLowerCase()??null,tm:me==='red'?1:0,k:s.kills,d:s.deaths,a:s.assists,sc:s.score,
    dm:s.damage?.made??null,dr:s.damage?.received??null,hs:s.shots?.head??0,bs:s.shots?.body??0,ls:s.shots?.leg??0,
    rw:m.teams?.[me]??null,rl:m.teams?.[ot]??null,tier:s.tier??null};
}

export async function run({env=process.env,fetchImpl=fetch,d1=(sql,params)=>d1Query(env,sql,params,fetchImpl),
  sleep=realSleep,now=Date.now,log=console.log}={}){
  const ORIGIN=env.SITE_ORIGIN||'https://vlravg1.pages.dev';
  const ACT=env.SIM_ACT||'e11a6';
  const GAP_MS=Math.max(1000,Number(env.SIM_GAP_MS)||1500); // 40/min leaves the live site 20/min
  const deadline=now()+Math.min(345,Math.max(1,Number(env.RUNTIME_MINUTES)||330))*60000;
  const st={requests:0,rateLimited:0,saved:0,retryLater:0,closed:0,d1Retries:0};
  const left=()=>deadline-now();
  const pause=ms=>sleep(Math.max(0,Math.min(ms,left())));

  // D1: retry anything (network resets, 5xx, overload) for up to ~10 minutes, then give up quietly.
  async function q(sql,params){
    let delay=5000;
    for(let attempt=0;;attempt++){
      try{return await d1(sql,params);}
      catch(error){
        if(attempt>=8||left()<=0)throw error;
        st.d1Retries++;await pause(delay);delay=Math.min(delay*2,120000);
      }
    }
  }

  // One shared pacer for all workers: each request reserves the next slot; a 429 pushes it back.
  let nextSlot=0;
  async function slot(){const at=Math.max(now(),nextSlot);nextSlot=at+GAP_MS;await pause(at-now());}

  async function page(region,puuid,p){
    for(let attempt=0;attempt<8;attempt++){
      await slot();
      if(left()<=0)return{status:-1};
      st.requests++;
      let res,body=null;
      try{
        res=await fetchImpl(`${ORIGIN}/api/stored-matches/${region}/${puuid}?page=${p}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});
        body=await res.json().catch(()=>null);
      }catch{await pause(10000*(attempt+1));continue;}
      if(res.status===429){st.rateLimited++;const wait=Math.max(2000,Math.min(Number(body?.retryAfterMs)||60000,120000));nextSlot=Math.max(nextSlot,now()+wait);continue;}
      if(res.status>=500||(res.status===200&&!Array.isArray(body?.data))){await pause(10000*(attempt+1));continue;}
      return{status:res.status,body};
    }
    return{status:0};
  }

  // Returns {status:200|404, ms} when complete, {retry:true} when it should be tried again.
  async function fetchPlayer({puuid,region}){
    const ms=[];
    for(let p=1;p<=MAX_PAGES;p++){
      const r=await page(region,puuid,p);
      if(r.status===-1)return{retry:true,budget:true};
      if(r.status===404&&p===1)return{status:404,ms};
      if(r.status!==200)return{retry:true};
      const list=r.body.data;
      let past=false;
      for(const m of list){
        const act=m.meta?.season?.short??null;
        if(act!==ACT){if(act)past=true;continue;}
        ms.push(compact(m));
      }
      if(past||list.length<100||!(r.body?.results?.after>0))return{status:200,ms};
    }
    return{status:200,ms,capped:true};
  }

  let queue=[],loading=null,exhausted=false,fatal=null,consecutiveFails=0;
  const claimed=new Set();
  async function nextPlayer(){
    for(;;){
      if(queue.length)return queue.shift();
      if(exhausted||left()<=0||fatal)return null;
      loading??=q('SELECT puuid,region,COALESCE(attempts,0) AS attempts FROM sim_pilot_players WHERE status IS NULL ORDER BY COALESCE(attempts,0),puuid LIMIT 60')
        .then(rows=>{rows=rows.filter(r=>!claimed.has(r.puuid));rows.forEach(r=>claimed.add(r.puuid));queue.push(...rows);if(!rows.length)exhausted=true;})
        .catch(error=>{fatal=error;})
        .finally(()=>{loading=null;});
      await loading;
    }
  }

  async function worker(){
    for(;;){
      const row=await nextPlayer();
      if(!row)return;
      try{
        const h=await fetchPlayer(row);
        if(h.budget)return;
        if(h.retry){
          const attempts=row.attempts+1,close=attempts>=MAX_ATTEMPTS;
          await q(close?'UPDATE sim_pilot_players SET attempts=?1,status=0,fetched_at=?2 WHERE puuid=?3':'UPDATE sim_pilot_players SET attempts=?1 WHERE puuid=?3',
            [attempts,new Date(now()).toISOString(),row.puuid]);
          close?st.closed++:st.retryLater++;
          if(++consecutiveFails>=20){log('20 players in a row failed; pausing 5 minutes.');await pause(300000);consecutiveFails=0;}
          continue;
        }
        await q('UPDATE sim_pilot_players SET status=?1,n=?2,data=?3,fetched_at=?4 WHERE puuid=?5',
          [h.status,h.ms.length,gzipSync(JSON.stringify(h.ms)).toString('base64'),new Date(now()).toISOString(),row.puuid]);
        consecutiveFails=0;
        if(++st.saved%100===0)log(`saved ${st.saved}, requests ${st.requests}, 429s ${st.rateLimited}, retry later ${st.retryLater}, closed ${st.closed}, D1 retries ${st.d1Retries}`);
      }catch(error){
        // Only D1 giving up for ~10 minutes lands here; stop this worker, leave the row for later.
        fatal??=error;return;
      }
    }
  }

  await Promise.all(Array.from({length:WORKERS},worker));
  let remaining=null;
  try{remaining=(await q('SELECT SUM(status IS NULL) AS left FROM sim_pilot_players'))[0]?.left??0;}catch{}
  log(`Run done: saved ${st.saved}, requests ${st.requests}, 429s ${st.rateLimited}, retry later ${st.retryLater}, closed after ${MAX_ATTEMPTS} tries ${st.closed}, D1 retries ${st.d1Retries}; remaining ${remaining??'unknown'}.${fatal?' Stopped early: D1 unreachable.':''}`);
  if(remaining===0)log('All pilot players are fetched.');
  // Retries count as progress: each one raises a row's attempts, so chaining always ends.
  return{...st,remaining,progressed:st.saved+st.closed+st.retryLater,fatal:!!fatal};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await run().catch(error=>{console.log(`Run failed: ${error?.message??error}`);return{remaining:null,progressed:0,fatal:true};});
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`remaining=${r.remaining??''}\nprogressed=${r.progressed}\n`);
}
