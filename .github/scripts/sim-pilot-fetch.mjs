// ML simulation pilot for ascend-companion-re (offline research, not part of the site). Works
// through five D1 queues, in order, all via this site's own proxy (the public HenrikDev key behind
// the same atomic quota gate as live visitors):
//   live     sim_live_rr        recent archived matches' players' live RR window
//                                (/api/mmr-history-by-puuid), queued by enqueueLive at each run's start
//   livehist sim_live_players   collected matches' players' act history once all 10 ranks are in
//                                (enqueueLiveFollowups); saving one queues liveprev and fills KAST
//                                from /api/history-by-puuid (10 full matches a request), queueing
//                                only the games that list misses for the single-match kast queue
//   liveprev sim_live_prev      their last 20 games before the act, when a lobby had < 12 act games
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
import {gzipSync,gunzipSync} from 'node:zlib';
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {pathToFileURL} from 'node:url';
import {d1Query,retryOnD1Overload} from './d1-query.mjs';

export const MAX_PAGES=10;     // 1,000 matches: more than anyone plays in an act
export const MAX_ATTEMPTS=3;
export const MAX_FULL_OFFSET=990; // /api/history-by-puuid: 100 pages of 10 at most per player
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

export function liveEntry(h){
  return{m:h.match_id,t:h.date,s:h.season?.short??null,q:h.queue_id??null,tier:h.tier?.id??null,rr:h.rr??null,ch:h.last_change??null,
    tb:h.tier_before_update?.id??null,rb:h.rr_before_update??null};
}

// Live collector (docs/ml-sim-pilot.md): queues the players of every competitive PC match that
// reached match_archive and started within LIVE_WINDOW_H, one sim_live_rr row per (player, match).
// Walks match_archive by rowid from a stored cursor (visitors also archive old games, so rowid is
// not start order; old ones are skipped). Never throws: a failure only delays queueing to the next run.
export const LIVE_WINDOW_H=36;
export async function enqueueLive({d1,now=Date.now,log=console.log}={}){
  const st={scanned:0,matches:0,players:0};
  try{
    await d1(`CREATE TABLE IF NOT EXISTS sim_live_rr (id TEXT PRIMARY KEY, region TEXT NOT NULL, puuid TEXT NOT NULL, match_id TEXT NOT NULL, started_at TEXT, status INTEGER, n INTEGER, data TEXT, attempts INTEGER, fetched_at TEXT)`);
    // Queueing a match's players and a player's collected matches look rows up by match and by
    // player; without these each lookup scanned the whole table (~14M rows read for 1,045 matches
    // on 17 Nov 2026, which D1 refused as overloaded, code 7429).
    await d1(`CREATE INDEX IF NOT EXISTS sim_live_rr_match ON sim_live_rr(match_id)`);
    await d1(`CREATE INDEX IF NOT EXISTS sim_live_rr_puuid ON sim_live_rr(puuid)`);
    await d1(`CREATE TABLE IF NOT EXISTS sim_live_matches (match_id TEXT PRIMARY KEY, region TEXT, started_at TEXT, season TEXT, players INTEGER, queued_at TEXT, followed INTEGER)`);
    await d1(`CREATE TABLE IF NOT EXISTS sim_live_state (id INTEGER PRIMARY KEY CHECK (id=1), cursor INTEGER NOT NULL)`);
    const cutoff=new Date(now()-LIVE_WINDOW_H*3600000).toISOString();
    let cursor=(await d1(`SELECT cursor FROM sim_live_state WHERE id=1`))[0]?.cursor;
    cursor??=(await d1(`SELECT COALESCE((SELECT MIN(rowid) FROM match_archive WHERE started_at>=?1)-1,(SELECT MAX(rowid) FROM match_archive),0) AS c`,[cutoff]))[0]?.c??0;
    for(;;){
      const rows=await d1(`SELECT rowid AS r,match_id AS m,started_at AS t FROM match_archive WHERE rowid>?1 ORDER BY rowid LIMIT 500`,[cursor]);
      if(!rows.length)break;
      st.scanned+=rows.length;
      const fresh=[...new Set(rows.filter(x=>x.t&&x.t>=cutoff).map(x=>x.m))];
      const known=fresh.length?new Set((await d1(`SELECT match_id AS m FROM sim_live_matches WHERE match_id IN (${fresh.map((_,i)=>`?${i+1}`).join(',')})`,fresh)).map(x=>x.m)):new Set();
      for(const id of fresh.filter(m=>!known.has(m))){
        const h=(await d1(`SELECT hex(payload) AS h FROM match_archive WHERE match_id=?1 LIMIT 1`,[id]))[0]?.h;
        let m=null;try{m=JSON.parse(gunzipSync(Buffer.from(h,'hex')));}catch{}
        const md=m?.metadata,ok=md?.queue?.id==='competitive'&&md?.platform==='pc'&&md?.region&&m?.players?.length===10;
        await d1(`INSERT OR IGNORE INTO sim_live_matches (match_id,region,started_at,season,players,queued_at) VALUES (?1,?2,?3,?4,?5,?6)`,
          [id,ok?md.region:null,md?.started_at??null,md?.season?.short??null,ok?10:0,new Date(now()).toISOString()]);
        if(!ok)continue;
        const ps=m.players.map(p=>String(p.puuid).toLowerCase());
        await d1(`INSERT OR IGNORE INTO sim_live_rr (id,region,puuid,match_id,started_at) VALUES ${ps.map((_,i)=>`(?${i*5+1},?${i*5+2},?${i*5+3},?${i*5+4},?${i*5+5})`).join(',')}`,
          ps.flatMap(u=>[`${u}:${id}`,md.region,u,id,md.started_at]));
        st.matches++;st.players+=ps.length;
      }
      cursor=rows.at(-1).r;
      await d1(`INSERT INTO sim_live_state (id,cursor) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor`,[cursor]);
    }
  }catch(error){log(`Live queueing stopped early: ${String(error?.message??error).slice(0,200)}`);}
  log(`Live: scanned ${st.scanned} archive rows, queued ${st.matches} matches (${st.players} players).`);
  return st;
}

// Follow-ups for collected matches whose 10 RR windows are all saved (rank secured; a match with a
// window closed after 3 tries is dropped, followed=0): each player gets a fresh act history in
// sim_live_players (act = the match's season). A player already fetched before a newer collected
// match started is queued again, since games played in between count for that lobby. Saving a
// history then queues the pre-act tail and the KAST downloads (liveFollowups in run()), so full
// matches are only downloaded for matches that can pass the gate's rank condition.
export async function enqueueLiveFollowups({d1,log=console.log}={}){
  const st={matches:0,dropped:0,players:0};
  try{
    await d1(`CREATE TABLE IF NOT EXISTS sim_live_players (puuid TEXT PRIMARY KEY, region TEXT NOT NULL, act TEXT, need_after TEXT, status INTEGER, n INTEGER, data TEXT, attempts INTEGER, fetched_at TEXT)`);
    await d1(`CREATE TABLE IF NOT EXISTS sim_live_prev (id TEXT PRIMARY KEY, region TEXT NOT NULL, status INTEGER, n INTEGER, data TEXT, attempts INTEGER, fetched_at TEXT)`);
    // sim_live_matches predates the followed column (CREATE TABLE IF NOT EXISTS won't add it).
    if(!(await d1(`PRAGMA table_info(sim_live_matches)`)).some(c=>c?.name==='followed'))
      await d1(`ALTER TABLE sim_live_matches ADD COLUMN followed INTEGER`);
    const rows=await d1(`SELECT x.match_id AS m,x.season AS s,x.started_at AS t,SUM(r.status=200) AS ok,SUM(r.status IS NULL) AS open FROM sim_live_matches x JOIN sim_live_rr r ON r.match_id=x.match_id WHERE x.players=10 AND x.followed IS NULL GROUP BY x.match_id`);
    for(const x of rows){
      if(Number(x.ok)===10){
        await d1(`INSERT INTO sim_live_players (puuid,region,act,need_after) SELECT puuid,region,?2,?3 FROM sim_live_rr WHERE match_id=?1 ON CONFLICT(puuid) DO UPDATE SET act=excluded.act,need_after=MAX(COALESCE(sim_live_players.need_after,''),excluded.need_after),status=CASE WHEN sim_live_players.fetched_at<excluded.need_after THEN NULL ELSE sim_live_players.status END,attempts=CASE WHEN sim_live_players.fetched_at<excluded.need_after THEN NULL ELSE sim_live_players.attempts END`,[x.m,x.s,x.t]);
        await d1(`UPDATE sim_live_matches SET followed=1 WHERE match_id=?1`,[x.m]);st.matches++;st.players+=10;
      }else if(Number(x.open)===0){await d1(`UPDATE sim_live_matches SET followed=0 WHERE match_id=?1`,[x.m]);st.dropped++;}
    }
  }catch(error){log(`Live follow-ups stopped early: ${String(error?.message??error).slice(0,200)}`);}
  log(`Live follow-ups: ${st.matches} matches with all 10 ranks (${st.players} player histories queued), ${st.dropped} dropped.`);
  return st;
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
  const st={requests:0,rateLimited:0,saved:0,retryLater:0,closed:0,d1Retries:0,prevQueued:0,kastQueued:0,fullPages:0,kastFromPages:0,byQueue:{}};
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
  // After a collected match's player history is saved: the pre-act tail when any of their collected
  // matches has fewer than 12 earlier act games, and KAST for every earlier act game that neither
  // the archive (KAST computed locally) nor the KAST table already has. KAST comes from the
  // player's full-match list (pagesKast: 10 matches with rounds per request); only games that
  // list doesn't reach or doesn't hold (it misses some stored games) are queued for
  // /api/match-detail one by one. The stored list stays the source of the act history itself,
  // since that is the record the gate's parity check matched.
  async function liveFollowups(puuid,region,act,ms){
    const games=await q(`SELECT r.match_id AS m,r.started_at AS t FROM sim_live_rr r JOIN sim_live_matches x ON x.match_id=r.match_id WHERE r.puuid=?1 AND x.followed=1 AND x.season=?2`,[puuid,act]);
    const before=t=>ms.filter(e=>Date.parse(e.t)<Date.parse(t)-60000);
    if(games.some(g=>before(g.t).length<12)){await q(`INSERT OR IGNORE INTO sim_live_prev (id,region) VALUES (?1,?2)`,[`${puuid}:${act}`,region]);st.prevQueued++;}
    const need=[...new Set(games.flatMap(g=>before(g.t).map(e=>e.m)))],missing=[];
    for(let i=0;i<need.length;i+=45){
      const ids=need.slice(i,i+45),ph=ids.map((_,k)=>`?${k+1}`).join(',');
      const have=new Set([...await q(`SELECT DISTINCT match_id AS m FROM match_archive WHERE match_id IN (${ph})`,ids),
        ...await q(`SELECT match_id AS m FROM sim_pilot_kast WHERE match_id IN (${ph}) AND status IS NOT NULL`,ids)].map(x=>x.m));
      missing.push(...ids.filter(m=>!have.has(m)));
    }
    const got=kastOf&&missing.length?await pagesKast(region,puuid,missing,ms):{done:new Set()};
    if(got.budget)return{budget:true};
    const add=missing.filter(m=>!got.done.has(m));
    for(let i=0;i<add.length;i+=45){
      const ids=add.slice(i,i+45);
      await q(`INSERT OR IGNORE INTO sim_pilot_kast (match_id,region) VALUES ${ids.map((_,k)=>`(?${2*k+1},?${2*k+2})`).join(',')}`,ids.flatMap(m=>[m,region]));
    }
    st.kastQueued+=add.length;
    return{};
  }
  // Walks /api/history-by-puuid (competitive, 10 full matches per page, newest first) until every
  // wanted match is seen or the list is older than the oldest one; saves each wanted match's KAST
  // row straight into sim_pilot_kast (a row already queued is filled; a finished one is left).
  // A failed page only ends the walk: what it didn't cover falls back to the single-match queue.
  async function pagesKast(region,puuid,wanted,ms){
    const want=new Set(wanted),done=new Set(),time=new Map(ms.map(e=>[e.m,Date.parse(e.t)]));
    const oldest=Math.min(...wanted.map(m=>time.get(m)??Infinity));
    for(let start=0;start<=MAX_FULL_OFFSET&&done.size<want.size;start+=10){
      const r=await get(`history-by-puuid/${region}/pc/${puuid}?start=${start}`,listOk);
      if(r.status===-1)return{budget:true,done};
      if(r.status!==200)break;
      const list=r.body.data;st.fullPages++;
      for(const m of list){
        const id=m?.metadata?.match_id;
        if(!want.has(id)||done.has(id))continue;
        const k=kastOf(m);if(!k)continue; // incomplete payload: leave it to match-detail
        await q(`INSERT INTO sim_pilot_kast (match_id,region,status,n,data,fetched_at) VALUES (?1,?2,200,1,?3,?4) ON CONFLICT(match_id) DO UPDATE SET status=200,n=1,data=excluded.data,fetched_at=excluded.fetched_at WHERE sim_pilot_kast.status IS NULL`,
          [id,region,gzipSync(JSON.stringify(k)).toString('base64'),new Date(now()).toISOString()]);
        done.add(id);st.kastFromPages++;
      }
      const last=Date.parse(list.at(-1)?.metadata?.started_at);
      if(list.length<10||!(last>=oldest))break;
    }
    return{done};
  }
  const actHistory=async(region,puuid,act)=>{const ms=[];let past=false;
    const r=await pages(`stored-matches/${region}/${puuid}`,list=>{for(const m of list){const a=m.meta?.season?.short??null;if(a===act)ms.push(compact(m));else if(a)past=true;}},()=>past);
    return r.status?{...r,data:ms}:r;};
  const preAct=async(region,puuid,act)=>{const ms=[];
    const r=await pages(`stored-matches/${region}/${puuid}`,list=>{for(const m of list){const a=m.meta?.season?.short??null;if(a&&a!==act&&ms.length<PREV_GAMES)ms.push(compact(m));}},()=>ms.length>=PREV_GAMES);
    return r.status?{...r,data:ms}:r;};
  const queues=[
    // Live RR (time-critical, so first): a recent match's players' last ~20 ranked games while the
    // match is still in that window. The match's own entry carries the rank before it
    // (tier_before_update, rr_before_update): what Ascend's roster showed in that lobby. The
    // route also merges the window into rr_history, as for any visitor.
    {name:'live',table:'sim_live_rr',id:'id',async fetch(row){
      const [puuid,matchId]=row.id.split(':');
      const r=await get(`mmr-history-by-puuid/${row.region}/pc/${puuid}`,b=>Array.isArray(b?.data?.history));
      if(r.status===-1)return{budget:true};
      if(r.status===404)return{status:404,data:[]};
      if(r.status!==200)return{retry:true};
      const hist=r.body.data.history;
      if(!hist.some(h=>h?.match_id===matchId))return{retry:true}; // not listed yet; a later run tries again
      return{status:200,data:hist.filter(h=>Date.parse(h?.date)>=RR_SINCE).map(liveEntry)};
    }},
    // Collected matches' players (enqueueLiveFollowups): act history as of now, then follow-ups.
    {name:'livehist',table:'sim_live_players',id:'puuid',cols:'act',async fetch(row){
      const act=row.act||ACT,h=await actHistory(row.region,row.puuid,act);
      if(h.status===200&&(await liveFollowups(row.puuid,row.region,act,h.data)).budget)return{budget:true};
      return h;
    }},
    {name:'liveprev',table:'sim_live_prev',id:'id',async fetch(row){
      const [puuid,act]=row.id.split(':');return preAct(row.region,puuid,act);
    }},
    {name:'history',table:'sim_pilot_players',id:'puuid',fetch:row=>actHistory(row.region,row.puuid,ACT)},
    {name:'rr',table:'sim_pilot_rr',id:'puuid',async fetch(row){
      const es=[];let old=false;
      const r=await pages(`stored-mmr-history/${row.region}/${row.puuid}`,list=>{for(const e of list){const t=Date.parse(e.date);if(!Number.isFinite(t))continue;if(t<RR_SINCE){old=true;continue;}
        es.push({m:e.match_id,t:e.date,s:e.season?.short??null,tier:e.tier?.id??null,rr:e.ranking_in_tier??null,ch:e.last_mmr_change??null});}},()=>old);
      return r.status?{...r,data:es}:r;
    }},
    {name:'prev',table:'sim_pilot_prev',id:'puuid',fetch:row=>preAct(row.region,row.puuid,ACT)},
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
      loading??=q(`SELECT ${Q.id} AS id,region,COALESCE(attempts,0) AS attempts${Q.cols?`,${Q.cols}`:''} FROM ${Q.table} WHERE status IS NULL ORDER BY COALESCE(attempts,0),${Q.id} LIMIT 60`)
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
  log(`Run done: saved ${st.saved} (${Object.entries(st.byQueue).map(([k,v])=>`${k} ${v}`).join(', ')||'none'}), requests ${st.requests}, 429s ${st.rateLimited}, retry later ${st.retryLater}, closed after ${MAX_ATTEMPTS} tries ${st.closed}, D1 retries ${st.d1Retries}, follow-ups queued: prev ${st.prevQueued}, KAST ${st.kastQueued}; KAST from ${st.fullPages} full-match pages ${st.kastFromPages}; remaining ${remaining??'unknown'}.${fatal?' Stopped early: D1 unreachable.':''}${kastOf?'':' KAST rules not loaded.'}`);
  if(remaining===0)log('All pilot queues are done.');
  // Retries count as progress: each one raises a row's attempts, so chaining always ends.
  return{...st,remaining,progressed:st.saved+st.closed+st.retryLater,fatal:!!fatal};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const env=process.env;
  if(!env.SIM_QUEUES||env.SIM_QUEUES.split(',').includes('live')){
    // Every queueing statement can be repeated safely (CREATE IF NOT EXISTS, INSERT OR IGNORE, upserts,
    // UPDATE), so an overloaded D1 (7429) is waited out instead of ending the step.
    const d1=retryOnD1Overload((sql,params)=>d1Query(env,sql,params));
    await enqueueLive({d1});await enqueueLiveFollowups({d1});
  }
  const r=await run().catch(error=>{console.log(`Run failed: ${error?.message??error}`);return{remaining:null,progressed:0,fatal:true};});
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`remaining=${r.remaining??''}\nprogressed=${r.progressed}\n`);
}
