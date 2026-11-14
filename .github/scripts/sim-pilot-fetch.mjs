// ML simulation pilot for ascend-companion-re (offline research, not part of the site). Works
// through four D1 queues, in order, all via this site's own proxy (the public HenrikDev key behind
// the same atomic quota gate as live visitors):
//   history  sim_pilot_players  each player's current-act competitive games (/api/stored-matches)
//   rr       sim_pilot_rr       each player's RR history: tier and RR after every game since August
//                                (/api/stored-mmr-history), for their rank as it stood before a match
//   prev     sim_pilot_prev     each player's last 20 games before the act (/api/stored-matches),
//                                for results and the Riot fallback when the act has few games
//   kast     sim_pilot_kast     each earlier game's full match (/api/match-detail), reduced here to
//                                every player's tracker-rule KAST rounds and enemy damage
// Rows store gzip+base64 JSON without names or tags. Logs only counts (the repository and its
// Action logs are public). See docs/ml-sim-pilot.md.
//
// Runs unattended overnight, so nothing transient may stop it:
// - every D1 call and every request retries network errors, 5xx and 429 with backoff;
// - an item is saved only when it came back complete (or the account/match is unknown: 404); any
//   other outcome leaves the row open and counts an attempt, closed with status 0 after
//   MAX_ATTEMPTS so one broken item can't block the pilot;
// - the script never throws: it reports `remaining` and `progressed` to $GITHUB_OUTPUT so the
//   workflow can start the next run itself (GitHub drops many scheduled triggers).
import {gzipSync} from 'node:zlib';
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {pathToFileURL} from 'node:url';
import {d1Query} from './d1-query.mjs';

export const MAX_PAGES=10;     // 1,000 matches: more than anyone plays in an act
export const MAX_ATTEMPTS=3;
export const NOT_FOUND_CONFIRM=2; // a 404 counts only when a later run gets it again
export const WORKERS=2;        // a request takes 1-2 s, so one worker alone can't keep the pace
const RR_SINCE=Date.parse('2026-08-01T00:00:00Z'); // the pilot's matches start 13 Oct 2026
const PREV_GAMES=20;           // Ascend's Riot fallback looks at the last 20 games
const KAST_CUT=Date.parse('2026-10-27T17:00:00Z'); // tracker kept its older trade rule before this

const realSleep=ms=>new Promise(r=>setTimeout(r,ms));

export function compact(m){
  const s=m.stats??{},me=String(s.team??'').toLowerCase(),ot=me==='red'?'blue':'red';
  return{m:m.meta?.id,t:m.meta?.started_at,s:m.meta?.season?.short??null,ag:s.character?.id?.toLowerCase()??null,tm:me==='red'?1:0,k:s.kills,d:s.deaths,a:s.assists,sc:s.score,
    dm:s.damage?.made??null,dr:s.damage?.received??null,hs:s.shots?.head??0,bs:s.shots?.body??0,ls:s.shots?.leg??0,
    rw:m.teams?.[me]??null,rl:m.teams?.[ot]??null,tier:s.tier??null};
}

// Tracker-exact KAST (docs/adr-kast.md): computeRoundStats from index.html as pinned by the
// workflow (SIM_KAST_HTML, commit f2dd31f), plus the older trade rule for earlier matches.
export function loadKast(html){
  const section=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));
  const realDeaths=html.slice(html.indexOf('const POST_ROUND_PHASE_MS'),html.indexOf('\n}\n',html.indexOf('function computeRealDeaths('))+3);
  const cur=section('// Per-round stats for one player','// ─────────────────');
  const s=cur.indexOf('function computeRoundStats('),e=cur.indexOf('\n}\n',s)+3;
  const trade='x.victim?.puuid===killer&&(x.time_in_round_in_ms??0)>t0&&(x.time_in_round_in_ms??0)-t0<=KAST_TRADE_WINDOW_MS&&team[x.killer?.puuid]===myTeam';
  if(s<0||!cur.slice(s,e).includes(trade)||!cur.slice(s,e).includes('const killedAgain=trade&&'))throw new Error('KAST rules not found in the pinned index.html');
  const old=cur.slice(s,e).replace('function computeRoundStats(','function computeRoundStatsOld(')
    .replace(trade,'x.victim?.puuid===killer&&(x.time_in_round_in_ms??0)>t0&&(x.time_in_round_in_ms??0)-t0<=5000').replace('const killedAgain=trade&&','const killedAgain=false&&');
  const ctx={};runInNewContext(realDeaths+cur+'\n'+old+'\nObject.assign(this,{computeRoundStats,computeRoundStatsOld});',ctx);
  return m=>{
    const started=Date.parse(m?.metadata?.started_at);
    if(!Array.isArray(m?.players)||m.players.length!==10||!Array.isArray(m.rounds)||!m.rounds.length||!Array.isArray(m.kills)||!Number.isFinite(started))return null;
    const crs=started<KAST_CUT?ctx.computeRoundStatsOld:ctx.computeRoundStats;
    const p=m.players.map(pl=>{const rs=crs(m,pl.puuid);return[pl.puuid,rs?.kastRounds??null,rs?.enemyDamage??null];});
    return p.some(x=>x[1]==null)?null:{t:m.metadata.started_at,R:m.rounds.length,old:started<KAST_CUT?1:0,p};
  };
}

export async function run({env=process.env,fetchImpl=fetch,d1=(sql,params)=>d1Query(env,sql,params,fetchImpl),
  sleep=realSleep,now=Date.now,log=console.log,kastOf=null}={}){
  const ORIGIN=env.SITE_ORIGIN||'https://vlravg1.pages.dev';
  const ACT=env.SIM_ACT||'e11a6';
  const GAP_MS=Math.max(1000,Number(env.SIM_GAP_MS)||1500); // 40/min leaves the live site 20/min
  const deadline=now()+Math.min(345,Math.max(1,Number(env.RUNTIME_MINUTES)||330))*60000;
  const st={requests:0,rateLimited:0,saved:0,retryLater:0,closed:0,d1Retries:0,byQueue:{}};
  const left=()=>deadline-now();
  const pause=ms=>sleep(Math.max(0,Math.min(ms,left())));
  if(!kastOf){const f=env.SIM_KAST_HTML;kastOf=f&&existsSync(f)?loadKast(readFileSync(f,'utf8')):null;}

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

  // {status, body} | {status:-1} (run budget) | {status:0} (gave up)
  async function get(path,valid){
    for(let attempt=0;attempt<8;attempt++){
      await slot();
      if(left()<=0)return{status:-1};
      st.requests++;
      let res,body=null;
      try{
        res=await fetchImpl(`${ORIGIN}/api/${path}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(45000)});
        body=await res.json().catch(()=>null);
      }catch{await pause(10000*(attempt+1));continue;}
      if(res.status===429){st.rateLimited++;const wait=Math.max(2000,Math.min(Number(body?.retryAfterMs)||60000,120000));nextSlot=Math.max(nextSlot,now()+wait);continue;}
      if(res.status>=500||(res.status===200&&!valid(body))){await pause(10000*(attempt+1));continue;}
      return{status:res.status,body};
    }
    return{status:0};
  }
  const listOk=b=>Array.isArray(b?.data);

  // Each returns {status:200|404, data, n} when complete, {retry:true} to try again, {budget:true}.
  async function pages(path,take,done){
    for(let p=1;p<=MAX_PAGES;p++){
      const r=await get(`${path}?page=${p}`,listOk);
      if(r.status===-1)return{budget:true};
      if(r.status===404&&p===1)return{status:404,data:[]};
      if(r.status!==200)return{retry:true};
      const list=r.body.data;take(list);
      if(done(list)||list.length<100||(r.body?.results&&!(r.body.results.after>0)))return{status:200};
    }
    return{status:200};
  }
  const queues=[
    {name:'history',table:'sim_pilot_players',id:'puuid',async fetch(row){
      const ms=[];let past=false;
      const r=await pages(`stored-matches/${row.region}/${row.puuid}`,list=>{for(const m of list){const a=m.meta?.season?.short??null;if(a===ACT)ms.push(compact(m));else if(a)past=true;}},()=>past);
      return r.status?{...r,data:ms}:r;
    }},
    {name:'rr',table:'sim_pilot_rr',id:'puuid',async fetch(row){
      const es=[];let old=false;
      const r=await pages(`stored-mmr-history/${row.region}/${row.puuid}`,list=>{for(const e of list){const t=Date.parse(e.date);if(!Number.isFinite(t))continue;if(t<RR_SINCE){old=true;continue;}
        es.push({m:e.match_id,t:e.date,s:e.season?.short??null,tier:e.tier?.id??null,rr:e.ranking_in_tier??null,ch:e.last_mmr_change??null});}},()=>old);
      return r.status?{...r,data:es}:r;
    }},
    {name:'prev',table:'sim_pilot_prev',id:'puuid',async fetch(row){
      const ms=[];
      const r=await pages(`stored-matches/${row.region}/${row.puuid}`,list=>{for(const m of list){const a=m.meta?.season?.short??null;if(a&&a!==ACT&&ms.length<PREV_GAMES)ms.push(compact(m));}},()=>ms.length>=PREV_GAMES);
      return r.status?{...r,data:ms}:r;
    }},
    {name:'kast',table:'sim_pilot_kast',id:'match_id',async fetch(row){
      const r=await get(`match-detail/${row.region}/${row.match_id}`,b=>b?.data&&typeof b.data==='object');
      if(r.status===-1)return{budget:true};
      if(r.status===404)return{status:404,data:null};
      if(r.status!==200)return{retry:true};
      const k=kastOf(r.body.data);
      return k?{status:200,data:k}:{retry:true};
    }},
  ].filter(x=>(!env.SIM_QUEUES||env.SIM_QUEUES.split(',').includes(x.name))&&(x.name!=='kast'||kastOf)); // no KAST rules: leave KAST rows untouched

  let qi=0,queue=[],loading=null,fatal=null,consecutiveFails=0;
  const claimed=new Set();
  async function nextItem(){
    for(;;){
      if(queue.length)return queue.shift();
      if(qi>=queues.length||left()<=0||fatal)return null;
      const Q=queues[qi];
      loading??=q(`SELECT ${Q.id} AS id,region,COALESCE(attempts,0) AS attempts FROM ${Q.table} WHERE status IS NULL ORDER BY COALESCE(attempts,0),${Q.id} LIMIT 60`)
        .then(rows=>{rows=rows.filter(r=>!claimed.has(`${Q.name}:${r.id}`));rows.forEach(r=>claimed.add(`${Q.name}:${r.id}`));
          if(rows.length)queue.push(...rows.map(r=>({Q,row:{...r,[Q.id]:r.id}})));else qi++;})
        .catch(error=>{fatal=error;})
        .finally(()=>{loading=null;});
      await loading;
    }
  }

  async function worker(){
    for(;;){
      const item=await nextItem();
      if(!item)return;
      const {Q,row}=item;
      try{
        let h=await Q.fetch(row);
        if(h.budget)return;
        // HenrikDev sometimes answers 404 for an account it has data for (one pilot player got 404
        // at night and 41 stored matches the next afternoon), so a 404 only closes an item when a
        // later run gets it again; the first one is a retry.
        if(h.status===404&&row.attempts+1<NOT_FOUND_CONFIRM)h={retry:true};
        if(h.retry){
          const attempts=row.attempts+1,close=attempts>=MAX_ATTEMPTS;
          await q(close?`UPDATE ${Q.table} SET attempts=?1,status=0,fetched_at=?2 WHERE ${Q.id}=?3`:`UPDATE ${Q.table} SET attempts=?1 WHERE ${Q.id}=?3`,
            [attempts,new Date(now()).toISOString(),row.id]);
          close?st.closed++:st.retryLater++;
          if(++consecutiveFails>=20){log('20 items in a row failed; pausing 5 minutes.');await pause(300000);consecutiveFails=0;}
          continue;
        }
        const n=Array.isArray(h.data)?h.data.length:h.data?1:0;
        await q(`UPDATE ${Q.table} SET status=?1,n=?2,data=?3,fetched_at=?4 WHERE ${Q.id}=?5`,
          [h.status,n,gzipSync(JSON.stringify(h.data)).toString('base64'),new Date(now()).toISOString(),row.id]);
        consecutiveFails=0;st.byQueue[Q.name]=(st.byQueue[Q.name]??0)+1;
        if(++st.saved%100===0)log(`saved ${st.saved} (${Object.entries(st.byQueue).map(([k,v])=>`${k} ${v}`).join(', ')}), requests ${st.requests}, 429s ${st.rateLimited}, retry later ${st.retryLater}, closed ${st.closed}, D1 retries ${st.d1Retries}`);
      }catch(error){
        // Only D1 giving up for ~10 minutes lands here; stop this worker, leave the row for later.
        fatal??=error;return;
      }
    }
  }

  await Promise.all(Array.from({length:WORKERS},worker));
  let remaining=null;
  try{remaining=0;for(const Q of queues)remaining+=(await q(`SELECT SUM(status IS NULL) AS left FROM ${Q.table}`))[0]?.left??0;}catch{remaining=null;}
  log(`Run done: saved ${st.saved} (${Object.entries(st.byQueue).map(([k,v])=>`${k} ${v}`).join(', ')||'none'}), requests ${st.requests}, 429s ${st.rateLimited}, retry later ${st.retryLater}, closed after ${MAX_ATTEMPTS} tries ${st.closed}, D1 retries ${st.d1Retries}; remaining ${remaining??'unknown'}.${fatal?' Stopped early: D1 unreachable.':''}${kastOf?'':' KAST rules not loaded.'}`);
  if(remaining===0)log('All pilot queues are done.');
  // Retries count as progress: each one raises a row's attempts, so chaining always ends.
  return{...st,remaining,progressed:st.saved+st.closed+st.retryLater,fatal:!!fatal};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await run().catch(error=>{console.log(`Run failed: ${error?.message??error}`);return{remaining:null,progressed:0,fatal:true};});
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`remaining=${r.remaining??''}\nprogressed=${r.progressed}\n`);
}
