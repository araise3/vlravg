// ─────────────────────────────────────────────────────────────────────────
//  vlravg engine — account lookup, match loading, match processing and the
//  statistics behind every page. The React layer (src/app) renders from this
//  module's state and calls its actions; nothing here touches the DOM except
//  the replay Turnstile widget, the document title and browser history.
//
//  The domain logic is the pre-React index.html script moved here verbatim
//  (see legacy/index.html). Tests slice functions out of this file by their
//  literal headers and comments, so keep declarations un-exported (the single
//  export list is at the end) and grep tests/ before renaming anything.
// ─────────────────────────────────────────────────────────────────────────

/* ── UI STATE ────────────────────────────────────────────── */
// Every state change calls emit(). Notifications are coalesced into one
// microtask so a burst of updates renders once.
const _listeners=new Set();
let _version=0,_emitPending=false;
function emit(){
  if(_emitPending)return;
  _emitPending=true;
  queueMicrotask(()=>{_emitPending=false;_version++;_listeners.forEach(fn=>fn());});
}
function subscribe(fn){_listeners.add(fn);return()=>{_listeners.delete(fn);};}
function getVersion(){return _version;}

let searchText='';
let statusText='',statusSpin=false;
// null = indeterminate; 0 hides the bar.
let progressValue=0;
let errorMessage=null;
let accentColor='#3b82f6',rankColored=false;
let headerInfo=null,trackerHref='';
let hasAnalysis=false;
// Played acts for the act picker, newest first: {value,label,games,countKind}.
let seasonOptions=[];
let seasonValue='';
let seasonUi={mode:'idle',label:'Most recent act'};
// Signals are counters the React layer watches for one-off effects.
let seasonOpenSignal=0,searchShakeSignal=0,searchFocusSignal=0,pageFocusSignal=0,scrollResultsSignal=0;

const PARTY_LABELS={1:'Solo',2:'Duo',3:'Trio',5:'5-Stack'};

// ─────────────────────────────────────────────────────────────────────────
//  HenrikDev API client  (grounded in docs.henrikdev.xyz, v4.x)
// ─────────────────────────────────────────────────────────────────────────
// All calls go through a same-origin Cloudflare Worker proxy that injects the
// API key server-side, so no key is ever shipped to the browser.
//
// WHY THIS IS BUILT THE WAY IT IS — three facts from the official docs drive
// the whole design:
//
//  1. The rate limit is a QUOTA over a fixed 1-minute window, and a "unit" is
//     NOT one request. Per the v4.0.0 rate-limit spec:
//         1 API call            = +1
//         + 1 per Riot fetch it triggers behind the scenes
//     A cached matchlist page costs 1; an uncached size-10 page can cost up to
//     ~11 (1 history + up to 10 individual matches). So you cannot pace by
//     "requests per minute" — the *cost* of each request is variable and only
//     known after the fact. This is exactly why fresh data 429'd while old,
//     already-cached pages sailed through.
//
//  2. Since v4.5 the API returns IETF RateLimit headers that tell us the truth
//     directly, no guessing:
//         ratelimit: "per1min";r=<remaining quota>;t=<seconds until reset>
//     We read r and t on EVERY response and pace off them proactively, waiting
//     out the window when quota runs low — instead of reacting after a 429.
//     (Falls back to the legacy x-ratelimit-remaining / retry-after if absent.)
//
//  3. Every response carries X-Cache-Status: HIT|MISS (+ X-Cache-TTL on HIT).
//     HITs are cheap, so we don't need to slow down for them.
//
// Docs: https://docs.henrikdev.xyz/valorant/changes/v4.0.0  (cost model)
//       https://docs.henrikdev.xyz/valorant/changes/v4.5.0  (ratelimit headers)
//       https://docs.henrikdev.xyz/valorant/error-codes     (429 = code 0)
const API_BASE  = '/api';
// Matchlist page size. Fixed at 10: HAR testing showed HenrikDev's v4 matches
// endpoint caps the response at 10 regardless of a larger `size` param (with
// mode=competitive), so requesting more is a silent no-op. (We previously tried
// dynamic sizing up to 50 — the server returned 10 every time, confirming the
// cap — so it was removed as dead complexity.)
const BATCH     = 10;
const PER_PAGE  = 15;

// ── Pacing philosophy ──────────────────────────────────────────────────────
// Request pacing (spacing calls out, gliding as quota runs low) now lives
// entirely in the worker — see functions/api/[[path]].js — coordinated
// across every concurrent user of the app hitting the same HenrikDev key,
// not just this one browser tab. The client no longer sees real quota
// numbers at all; it just fires requests and, on a 429, reads how long to
// wait from the response body instead of headers. Per HenrikDev's docs a 429
// is a fast rejection and may not even count against the budget, so this
// stays simple: fire, and if the worker says wait, wait the real time it
// gives us and continue.
//
// Absolute ceiling on any single wait, so a bad reset value or a stuck
// window can never hang the UI indefinitely.
const MAX_WAIT_MS = 65000;
// Minimum wait after a 429, so we can never retry into the same
// just-exhausted window microseconds later.
const RL_WAIT_FLOOR_MS = 2500;

// Parses an API short code like "e11a4" into {ep:11, act:4}. Returns null if
// it doesn't match the expected pattern.
function parseShort(short){
  const m=(short||'').match(/^e(\d+)a(\d+)$/i);
  return m?{ep:parseInt(m[1],10),act:parseInt(m[2],10)}:null;
}

// Friendly label for a season UUID, built from the API's own "short" code.
// HenrikDev's short code never actually switched to "v25"/"v26" — it just
// kept incrementing the episode number past 9 (e10, e11, ...) to represent
// what Riot brands to players as "Season 2025", "Season 2026", etc. Episode
// 10 = Season 2025, so we translate episode 10+ into that "V" year label;
// episodes 1–9 keep their original E#A# form.
function getActLabel(uuid,shortCode){
  const p=parseShort(shortCode);
  if(!p)return shortCode?shortCode.toUpperCase():(uuid?uuid.slice(0,8)+'…':'Unknown');
  if(p.ep<=9)return `E${p.ep}A${p.act}`;
  const year=2025+(p.ep-10);
  return `V${String(year).slice(-2)}A${p.act}`;
}

// Chronological (oldest→newest) ordering of the season UUIDs present in a
// player's `seasonal` MMR data. Sorts by the parsed episode/act numbers
// rather than the short code's raw text, since e.g. "e10a1" < "e9a1" as a
// string even though Episode 10 came after Episode 9.
function getSeasonOrder(seasonal){
  return (seasonal||[])
    .map(s=>({id:s.season?.id,p:parseShort(s.season?.short)}))
    .filter(s=>s.id)
    .sort((a,b)=>{
      if(a.p&&b.p)return (a.p.ep-b.p.ep)||(a.p.act-b.p.act);
      if(!a.p&&!b.p)return 0;
      return a.p?-1:1; // unparseable codes (unknown future format) sort as "newest"
    })
    .map(s=>s.id);
}

// Reveal the resolved account badges with the selected act after rank lookup.
function finalizeHeader(current,showTracker=false){
  rankColored=!!(current?.tier?.name||Number.isInteger(current?.tier?.id));
  headerInfo={current,region:REGION,showTracker,trackerHref,riotId:PLAYER&&TAG?`${PLAYER}#${TAG}`:''};
  // Current rank is shown once, in the badge above. These values also drive
  // the rank-coloured accent and RR displays elsewhere.
  CURRENT_TIER_ID=current?.tier?.id??null;
  CURRENT_RR=current?.rr??null;
  emit();
}

function hexToRgb(hex){
  const n=parseInt(hex.replace('#',''),16);
  return`${(n>>16)&255},${(n>>8)&255},${n&255}`;
}
function setAccent(color){accentColor=color;emit();}

/* ── RANK MAP ────────────────────────────────────────────── */
const RANK_MAP={
  0:'Unranked',1:'Unranked',2:'Unranked',
  3:'Iron 1',4:'Iron 2',5:'Iron 3',
  6:'Bronze 1',7:'Bronze 2',8:'Bronze 3',
  9:'Silver 1',10:'Silver 2',11:'Silver 3',
  12:'Gold 1',13:'Gold 2',14:'Gold 3',
  15:'Platinum 1',16:'Platinum 2',17:'Platinum 3',
  18:'Diamond 1',19:'Diamond 2',20:'Diamond 3',
  21:'Ascendant 1',22:'Ascendant 2',23:'Ascendant 3',
  24:'Immortal 1',25:'Immortal 2',26:'Immortal 3',
  27:'Radiant'
};
const RANK_MAP_SHORT={
  0:'Unr',1:'Unr',2:'Unr',
  3:'Iron 1',4:'Iron 2',5:'Iron 3',
  6:'Brnz 1',7:'Brnz 2',8:'Brnz 3',
  9:'Silv 1',10:'Silv 2',11:'Silv 3',
  12:'Gold 1',13:'Gold 2',14:'Gold 3',
  15:'Plat 1',16:'Plat 2',17:'Plat 3',
  18:'Dia 1',19:'Dia 2',20:'Dia 3',
  21:'Asc 1',22:'Asc 2',23:'Asc 3',
  24:'Immo 1',25:'Immo 2',26:'Immo 3',
  27:'Rad'
};
function rName(n){return RANK_MAP[n]||'Unranked';}

const RANK_COLORS={
  0:'#6b7280',1:'#6b7280',2:'#6b7280',
  3:'#7a7a7e',4:'#7a7a7e',5:'#7a7a7e',
  6:'#b07428',7:'#b07428',8:'#b07428',
  9:'#c2c8cf',10:'#c2c8cf',11:'#c2c8cf',
  12:'#e8a820',13:'#e8a820',14:'#e8a820',
  15:'#36b5c0',16:'#36b5c0',17:'#36b5c0',
  18:'#c07de0',19:'#c07de0',20:'#c07de0',
  21:'#2db87a',22:'#2db87a',23:'#2db87a',
  24:'#d03248',25:'#d03248',26:'#d03248',
  27:'#f0e0b0',
};
function rColor(n){return RANK_COLORS[n]||'#6b7280';}
function avgLabel(a){return RANK_MAP[Math.round(a)]||'—';}
function avgLabelShort(a){return RANK_MAP_SHORT[Math.round(a)]||'—';}
// Split an avg tier value into a rank division + RR. Whole numbers center each
// division (it spans value±0.5), so round() picks the division and the distance
// from its lower edge (tier-0.5) gives 0-99 RR — i.e. 0.01 of the value = 1 RR.
function tierRR(v){
  let tier=Math.round(v);
  let rr=Math.round((v-tier+0.5)*100);
  if(rr>=100){rr-=100;tier+=1;}
  if(rr<0){rr+=100;tier-=1;}
  return{tier,rr};
}
// Lobby averages come from tier ids alone (match data has no player RR), so
// their "RR" is the average's decimal part read as RR into a division. That
// only holds where divisions are 100 RR wide (Iron through Ascendant). From
// Immortal 1 up RR accumulates from the Immortal 1 floor and Immortal 2/3 and
// Radiant are regional leaderboard cutoffs, so an average there shows its
// rank without RR (decision 20 Nov 2026). Returns null when hidden.
function lobbyRR(r){return r&&r.tier<24?r.rr:null;}
function lobbyRankText(v,short=false){
  const r=tierRR(v),label=short?avgLabelShort(r.tier):avgLabel(r.tier);
  return lobbyRR(r)==null?label:`${label} (${r.rr} RR)`;
}
function rClass(n){
  if(n<=2)return 'r-unr';if(n<=5)return 'r-iron';if(n<=8)return 'r-bronze';
  if(n<=11)return 'r-silver';if(n<=14)return 'r-gold';if(n<=17)return 'r-plat';
  if(n<=20)return 'r-diamond';if(n<=23)return 'r-asc';if(n<=26)return 'r-imm';
  return 'r-rad';
}

/* ── STATE ──────────────────────────────────────────────── */
let PLAYER='',TAG='',REGION='eu',PLATFORM='pc',TARGET_SEASON='',PUUID='';
let allMatches=[],statMatches=[],mhIncludeReset=false,mhVisible=PER_PAGE,mhData=[],mhLastDayKey=null,mhDayStats={};
// The player's actual current-rank tier, set by finalizeHeader once the MMR
// fetch resolves. Drives the site accent color (see renderStats) — falls
// back to the avg lobby rank tier when unknown (e.g. MMR fetch failed).
let CURRENT_TIER_ID=null;
// The player's raw current.rr alongside CURRENT_TIER_ID — the visible-rank
// anchor used by the next-division progress bar and rank cards.
let CURRENT_RR=null;
// match_id -> RR gained/lost that match, from /api/mmr-history. The server
// persists every match it's ever seen for this player (see mergeRRHistory in
// functions/api/[[path]].js), so this grows past the live upstream's ~20-game
// window across repeated searches — but a given match still isn't guaranteed
// to be covered (never fetched before, or persisted after this ran). Read via
// _rrChangeByMatchId[matchId] ?? null, never assume it's present.
let _rrChangeByMatchId={};
// Nullable competitive-update fields from Henrik v4.10. Absence is not zero.
let _rrDetailsByMatchId={};
function parseRRDetails(h){
  const number=v=>Number.isFinite(v)?v:null;
  const bool=v=>typeof v==='boolean'?v:null;
  return {
    bonus:number(h.rr_performance_bonus),afkPenalty:number(h.afk_penalty),
    penalty:number(h.rr_penalty),mapForgiveness:number(h.new_map_incentive_rr_forgiven),
    placement:bool(h.is_placement_match),shieldReplenished:bool(h.was_derank_protection_replenished),
    beforeTier:number(h.tier_before_update?.id),beforeRR:number(h.rr_before_update),
    afterTier:number(h.tier?.id),afterRR:number(h.rr),
    queue:typeof h.queue_id==='string'?h.queue_id:null,
    duration:Number.isFinite(h.match_length)&&h.match_length>=0?h.match_length:null,
    movement:typeof h.competitive_movement==='string'&&h.competitive_movement!=='MOVEMENT_UNKNOWN'?h.competitive_movement:null,
  };
}
function reportedRRStart(d){
  if(d.beforeTier==null||d.beforeTier<3||d.beforeRR==null)return null;
  return (d.beforeTier>=24?2100:(d.beforeTier-3)*100)+d.beforeRR;
}
// match_id -> continuous RR position BEFORE that match — previous history
// position within a season, else the post-match position minus the movement
// that actually applied. Immortal+ is normalized to 2100 + cumulative RR.
let _preRRByMatchId={};
// Exact displayed RR position and tier after each match for the RR trend.
let _postRRByMatchId={};
let _postTierByMatchId={};
// Exact tier at that pre-match position when a preceding MMR-history entry is
// available. Immortal+ tier thresholds vary by region rather than every 100 RR.
let _preTierByMatchId={};
// match_id -> refunded_rr from MMR history. Riot applies this on top of the
// match payout, so it is rendered as a separate segment instead of being
// silently folded into last_change.
let _refundedRRByMatchId={};
// Queue dodges from the same MMR history: entries with match_length 0. In D1
// (Nov 2026), none of 2,004 such entries had a fetchable match and every
// last_change was −6, −10, −16 or −20 RR. With no match they never reach
// processMatch, so they are kept here for the RR summary. Older records
// without match_length cannot be told apart and are not counted.
let _rrDodges=[];
function rrDodgeEntry(h){
  if(h?.match_length!==0||!Number.isFinite(h.last_change))return null;
  const atMs=Date.parse(h.date);
  return {matchId:h.match_id,atMs:Number.isFinite(atMs)?atMs:null,change:h.last_change,
    seasonId:typeof h.season?.id==='string'?h.season.id:null};
}
// The selected act's dodges (all of them before an act is known).
function rrActDodges(){
  const act=TARGET_SEASON.toLowerCase();
  return _rrDodges.filter(d=>!act||d.seasonId?.toLowerCase()===act);
}
// match_id -> was_derank_protected from the same /api/mmr-history entries.
// Riot's Rank Shield: last_change still applies its normal negative payout
// on a protected loss, but the displayed tier/RR doesn't drop — so a player
// reading only their badge can be sitting on more losses than it shows.
// Surfaced on each match as myDerankProtected.
let _derankProtectedByMatchId={};
let allTeammates=[],allEncounters=[],serverData=[],serverPartySize=0,serverFilteredMatchCount=0,lobbyRankPartySize=0,lobbyRankFilteredMatchCount=0,rrMovementZoomTier=null;

// ── SHARED MATCH ARCHIVE ──────────────────────────────────────────────────
// Trusted full matches are kept in APP_DB by the proxy. Browser tabs and
// devices read the same archive; failures fall back to live history.
// Pages are fetched a few at a time: each one waits ~0.4 s on the proxy (D1
// lookup plus R2 reads), so one-by-one paging made a 500-match archive take
// several seconds. The archive is split into 50-row chunks; a chunk the
// proxy cut short (its JSON budget) is finished from the returned cursor
// before the chunk counts as done. Pages still publish strictly in order.
async function readServerMatchArchive(puuid,seasonId,generation,isRelevant=()=>true,opts={}){
  const CHUNK=50,PARALLEL=3,MAX_START=5000;
  const stale=()=>generation!==_analysisGen||!isRelevant();
  const chunks=[],published=[];
  let head=0,nextChunk=0,endFound=false,failed=null,fatal=null,cursorless=false;
  const flush=()=>{
    while(chunks[head]){
      const chunk=chunks[head];
      if(chunk.rows.length>chunk.sent){
        const page=chunk.rows.slice(chunk.sent);chunk.sent=chunk.rows.length;
        published.push(...page);
        if(page.length)opts.onPage?.(page);
      }
      if(!chunk.done)break;
      head++;
    }
  };
  const fetchPage=async(start,size)=>{
    const {r:response,j}=await fetchApiJson(`${API_BASE}/match-archive/${encodeURIComponent(puuid)}/${encodeURIComponent(seasonId)}?start=${start}&size=${size}`,{cache:'no-store',signal:opts.signal});
    if(!response.ok)throw new Error('Match archive unavailable');
    const page=Array.isArray(j?.data)?j.data:[];
    if(j&&Object.prototype.hasOwnProperty.call(j,'nextStart')){
      if(j.nextStart!==null&&(!Number.isSafeInteger(j.nextStart)||j.nextStart<=start))
        throw Object.assign(new Error('Invalid archive cursor'),{fatal:true});
      return{page,next:j.nextStart};
    }
    // A previously deployed proxy serves ten rows and no cursor.
    cursorless=true;
    return{page,next:page.length<10?null:start+page.length};
  };
  // Returns false once the read must stop (superseded or failed).
  const runChunk=async index=>{
    const chunk=chunks[index]={rows:[],sent:0,done:false};
    const end=(index+1)*CHUNK;
    let start=index*CHUNK;
    while(true){
      if(stale()||failed||fatal)return false;
      let result;
      try{result=await fetchPage(start,Math.min(CHUNK,end-start));}
      catch(e){if(e?.fatal)fatal=fatal||e;else failed=failed||e;return false;}
      if(stale())return false;
      chunk.rows.push(...result.page);
      if(result.next===null)endFound=true;
      if(result.next===null||result.next>=end){chunk.done=true;flush();return true;}
      flush();
      start=result.next;
    }
  };
  const worker=async()=>{
    while(!endFound&&!failed&&!fatal&&!stale()&&nextChunk*CHUNK<=MAX_START){
      if(!await runChunk(nextChunk++))return;
    }
  };
  // The first chunk runs alone: most archives fit in it, and its answer
  // shows whether the proxy speaks cursors at all.
  await runChunk(nextChunk++);
  if(!endFound&&!failed&&!fatal&&!stale())
    await Promise.all(Array.from({length:cursorless?1:PARALLEL},worker));
  if(stale())return [];
  if(fatal)throw fatal;
  if(opts.signal?.aborted&&failed)throw failed;
  if(failed&&!published.length)throw failed;
  if(!failed&&endFound&&chunks.every(c=>c.done))opts.onComplete?.();
  return published;
}
async function readSavedMatchCounts(puuid,opts={}){
  if(!puuid)return{};
  try{
    const {r:response,j}=await fetchApiJson(`${API_BASE}/match-archive-counts/${encodeURIComponent(puuid)}`,{cache:'no-store',signal:opts.signal});
    if(!response.ok)return{};
    const {data}=j;
    return data&&typeof data==='object'&&!Array.isArray(data)?data:{};
  }catch(_){return{};}
}
// The live season feed contains all acts, including future ones. The newest
// start date that is not in the future is the one cacheable act. If both live
// metadata and the hardcoded fallback are unavailable, archive reads fail open and
// the normal history pagination remains unchanged.
function currentActId(){
  const source=_actMeta&&Object.keys(_actMeta).length?_actMeta:HARDCODED_ACT_META;
  const now=Date.now();
  let bestId=null,bestStart=-Infinity;
  Object.entries(source||{}).forEach(([id,info])=>{
    if(Number.isFinite(info?.start)&&info.start<=now&&info.start>bestStart){bestId=id.toLowerCase();bestStart=info.start;}
  });
  return bestId;
}

// Pages share one search/data flow and one placement filter. Their result
// sections stay mounted so navigation preserves loaded data and open matches.
let activePage='overview',analysisState='idle';
let headerRevealPending=false;
let nameHistoryRows=[],nameHistoryState='idle';
let nameHistoryBackfill=null,nameBackfillBusy=false,nameBackfillError=false;
let nameBackfillStopRequested=false,nameBackfillStopped=false,nameBackfillPages=0;
async function loadNameHistory(puuid,generation=_analysisGen,opts={signal:_analysisController?.signal}){
  nameHistoryState='loading';emit();
  try{
    const {j}=await apiGet(`${API_BASE}/name-history/${encodeURIComponent(puuid)}?platform=${encodeURIComponent(PLATFORM)}`,{...opts,quiet:true,cache:'no-store'});
    if(generation!==_analysisGen||puuid!==PUUID)return;
    if(!Array.isArray(j.data?.history))throw new Error('Invalid name history');
    nameHistoryRows=j.data.history;nameHistoryBackfill=j.data.backfill;nameHistoryState='ready';
  }catch{
    if(generation!==_analysisGen||puuid!==PUUID)return;
    nameHistoryState='error';
  }
  emit();
}
async function loadOlderNames(){
  if(nameBackfillBusy){nameBackfillStopRequested=true;emit();return;}
  if(!PUUID||nameHistoryBackfill?.complete||nameHistoryBackfill?.limited||!nameHistoryBackfill?.available)return;
  const puuid=PUUID,generation=_analysisGen;
  const signal=_analysisController?.signal;
  nameBackfillBusy=true;nameBackfillStopRequested=false;nameBackfillStopped=false;nameBackfillError=false;emit();
  try{
    // Each request saves one page and its cursor to D1. The browser drives the
    // full scan while this tab remains open; stopping never discards progress.
    while(!nameBackfillStopRequested&&generation===_analysisGen&&puuid===PUUID){
      const previous=nameHistoryBackfill;
      const {j}=await apiGet(`${API_BASE}/name-backfill/${encodeURIComponent(puuid)}`,{quiet:true,cache:'no-store',signal});
      if(generation!==_analysisGen||puuid!==PUUID)return;
      if(!j.data?.backfill||!Array.isArray(j.data.history))throw new Error('Invalid backfill response');
      nameBackfillPages++;
      nameHistoryRows=j.data.history;nameHistoryBackfill=j.data.backfill;emit();
      if(!nameHistoryBackfill.available||nameHistoryBackfill.complete||nameHistoryBackfill.limited||nameBackfillStopRequested)break;
      const cursor=b=>[b.next_start,b.matchlist_complete,b.stored_page,b.stored_scanned,b.stored_complete,b.stored_pending_count].join(':');
      if(previous&&cursor(previous)===cursor(nameHistoryBackfill))throw new Error('Name history scan made no progress');
      await sleep(2500,signal);
    }
  }catch{
    if(generation===_analysisGen&&puuid===PUUID)nameBackfillError=true;
  }finally{
    if(generation===_analysisGen&&puuid===PUUID){
      nameBackfillStopped=nameBackfillStopRequested&&!nameHistoryBackfill?.complete;
      nameBackfillBusy=false;nameBackfillStopRequested=false;emit();
    }
  }
}
// Name history has dates rather than a season UUID. Map each observation onto
// the act timeline so a rename spanning several acts still reads naturally.
// This uses the immutable act-start snapshot (rather than a player’s selected
// act) because name history deliberately covers the entire account lifetime.
function nameHistoryActAt(stamp){
  const time=Date.parse(stamp);
  if(!Number.isFinite(time))return null;
  const starts=Object.values(HARDCODED_ACT_META).map(info=>info?.start)
    .filter(Number.isFinite).sort((a,b)=>a-b);
  let ordinal=-1;
  for(let i=0;i<starts.length;i++){
    if(starts[i]>time)break;
    ordinal=i;
  }
  if(ordinal<0)return null;
  // Episodes 1–9 had three acts. Riot's later yearly format has six acts;
  // retain the same V25/V26 shorthand used elsewhere in this interface.
  if(ordinal<27){
    const episode=Math.floor(ordinal/3)+1,act=ordinal%3+1;
    return {ordinal,series:`E${episode}`,act,label:`E${episode}A${act}`,
      description:`Episode ${episode}, Act ${act}`};
  }
  const offset=ordinal-27,year=25+Math.floor(offset/6),act=offset%6+1;
  return {ordinal,series:`V${year}`,act,label:`V${year}A${act}`,
    description:`V${year}, Act ${act}`};
}
function nameHistoryActRange(first,last){
  const start=nameHistoryActAt(first),end=nameHistoryActAt(last);
  if(!start||!end)return {label:'—',start:'—',end:null,sort:null,title:'Episode and act unavailable'};
  if(start.ordinal===end.ordinal)return {label:start.label,start:start.label,end:null,sort:start.ordinal,title:start.description};
  if(start.series===end.series)return {
    label:`${start.series}A${start.act} — A${end.act}`,
    start:start.label,end:`A${end.act}`,
    sort:start.ordinal,title:`${start.description} through ${end.description}`,
  };
  return {label:`${start.label} — ${end.label}`,start:start.label,end:end.label,sort:start.ordinal,
    title:`${start.description} through ${end.description}`};
}

/* ── REPLAY IMPORT ──────────────────────────────────────── */
// Uploads go to /api/replays (functions/api/replays, docs/replay-import.md).
// The row list is keyed by match ID and updated in place so a running upload
// keeps its progress while matches keep loading. Every progress figure shown
// is one the browser measured or the pipeline reported; nothing is estimated.
const REPLAY_MAGIC=0x43f4efdd;
const REPLAY_STATUS_BATCH=60;
const REPLAY_POLL_MS=5000;
const REPLAY_POLL_LIMIT=720;
const REPLAY_UPLOAD_CONCURRENCY=3;
const REPLAY_ERRORS={
  players_mismatch:'The replay’s players do not match the players HenrikDev lists for this match.',
  rounds_mismatch:'The replay’s round count does not match HenrikDev’s score for this match.',
  map_mismatch:'The replay’s map does not match the map HenrikDev lists for this match.',
  kills_mismatch:'The replay’s kills per player do not match HenrikDev’s for this match.',
  size_mismatch:'The stored file size did not match the upload.',
  decoder_validate_failed:'The parser does not support this game version yet.',
  decoder_export_failed:'The parser read the replay but could not export it.',
  compact_failed:'The replay could not be reduced to the compact timeline.',
  compact_invalid:'The parser produced invalid output.',
  timeout:'The sandbox ran out of time (15 minutes).',
  oversize:'The parsed result was larger than allowed.',
  download_failed:'The parser could not download the stored file.',
  output_rejected:'The sandbox output contained files that are not allowed.',
  export_missing:'The full parser export was missing.',
  parser_attempts_exhausted:'Three parser runs did not finish this replay.',
  upload_aborted:'The upload was cancelled.',
  upload_abandoned:'The upload did not finish within 2 hours.',
};
// The pipeline step each failure code belongs to.
const REPLAY_FAILED_STEP={upload_aborted:'upload',upload_abandoned:'upload',download_failed:'download',decoder_validate_failed:'decode',decoder_export_failed:'decode',
  compact_failed:'decode',timeout:'decode',oversize:'decode',output_rejected:'decode',parser_failed:'decode',compact_invalid:'store',
  export_missing:'store',players_mismatch:'store',rounds_mismatch:'store',map_mismatch:'store',kills_mismatch:'store',size_mismatch:'store',parser_attempts_exhausted:'run'};
// notes: a file rejected in the browser before upload, shown until the row next changes.
const replayImport={config:null,configLoad:null,status:new Map(),busy:new Set(),live:new Map(),uploadFailed:new Set(),expanded:new Set(),notes:new Map(),pollTimer:null,polls:0,turnstileLoad:null};

// One row per loaded match with a valid ID, newest first.
function replayMatchRows(matches){
  const seen=new Set();
  return matches.filter(m=>{
    const id=String(m.matchId||'').toLowerCase();
    if(!PUUID_RE.test(id)||seen.has(id))return false;
    seen.add(id);return true;
  }).sort((a,b)=>(b.startedAtMs??0)-(a.startedAtMs??0)).map(m=>({
    matchId:m.matchId.toLowerCase(),map:m.mapName||'Unknown',date:m.startedAt||'',
    score:m.myR!=null&&m.opR!=null?`${m.myR}–${m.opR}`:'—',
    result:m.won===true?'win':m.won===false?'loss':'draw',
  }));
}

// The replay header carries the match UUID (UTF-16 FString at offset 44).
function replayFileMatchId(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<48)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(0,true)!==REPLAY_MAGIC||view.getInt32(32,true)<=0)return null;
  const units=view.getInt32(44,true);
  if(units>=0||units<-1024||48-units*2>bytes.byteLength)return null;
  try{
    const name=new TextDecoder('utf-16le',{fatal:true}).decode(bytes.subarray(48,48-units*2)).replace(/\0+$/,'').trim().toLowerCase();
    return PUUID_RE.test(name)?name:null;
  }catch{return null;}
}

// ...and names the game build ("++Ares-Core+release-13.09", an FString near byte 708).
function replayFileBuild(bytes){
  if(!(bytes instanceof Uint8Array))return null;
  const text=String.fromCharCode(...bytes.subarray(0,Math.min(bytes.byteLength,4096)));
  const m=/\+\+Ares-Core\+release-(\d{1,2}\.\d{1,2})\0/.exec(text);
  return m?m[1]:null;
}

function replayClock(iso){
  const date=new Date(iso);
  if(Number.isNaN(date.getTime()))return '';
  const time=date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  return date.toDateString()===new Date().toDateString()?time:`${date.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}, ${time}`;
}
function replayDuration(ms){
  if(!(ms>=0))return '';
  const s=Math.round(ms/1000);
  return s<60?`${s} s`:s<3600?`${Math.floor(s/60)} min ${s%60} s`:`${Math.floor(s/3600)} h ${Math.floor(s%3600/60)} min`;
}
const replayMB=bytes=>(bytes/1048576).toFixed(1);
function replayBuildRange(builds){
  if(!Array.isArray(builds)||!builds.length)return '';
  const key=b=>b.split('.').map(Number);
  const sorted=[...builds].sort((a,b)=>{const[x,y]=key(a),[u,v]=key(b);return x-u||y-v;});
  return sorted.length>1?`${sorted[0]}–${sorted.at(-1)}`:sorted[0];
}

// The short headline next to the upload button.
function replayStatusView(status){
  const s=status?.status||'none';
  if(s==='parsed')return{text:'Parsed',tone:'parsed'};
  if(s==='pending')return{text:'Queued',tone:'busy'};
  if(s==='parsing')return{text:'Parsing',tone:'busy'};
  if(s==='uploading')return{text:'Upload in progress',tone:'busy'};
  if(s==='failed'||s==='rejected')return{text:s==='failed'?'Parse failed':'Rejected',tone:'bad'};
  if(status&&!status.eligible)return{text:'Not in the verified archive',tone:''};
  return{text:'No replay',tone:''};
}

function replayFailureText(status){
  const p=status.progress||{};
  // Decoder failures keep their file for a retry, within limits (raw_kept).
  const retry=status.raw_kept===false?' The file was not kept, so upload it again once support is added.':' It is retried automatically once support is added.';
  if(status.error==='decoder_validate_failed'&&p.header_build){
    const range=replayBuildRange(p.supported_builds);
    return `Game version ${p.header_build} is not supported by this parser build${range?` (it reads ${range})`:''}.${retry}`;
  }
  const text=REPLAY_ERRORS[status.error]||'The replay could not be processed.';
  return ['decoder_validate_failed','decoder_export_failed'].includes(status.error)?text+retry:text;
}

// The pipeline's own record as steps: {key,label,state,detail,since?,link?}.
// state is done | active | failed | skipped | pending.
function replayProgressSteps(status){
  const s=status?.status;
  if(!s||s==='none')return [];
  const p=status.progress||{};
  const steps=[];
  const uploadedDetail=[p.header_build&&`build ${p.header_build} per the replay header`,status.uploaded_at&&replayClock(status.uploaded_at)].filter(Boolean).join('; ');
  steps.push(s==='uploading'?{key:'upload',label:'Upload in progress',state:'active',detail:'Another upload of this match has not finished.'}
    :{key:'upload',label:'Uploaded',state:'done',detail:uploadedDetail});
  if(s==='uploading')return steps;
  const claimed=Boolean(p.claimed_at);
  const dispatch=!p.dispatch?'':!p.dispatch.requested?'waiting for the daily parser run at 04:23 UTC'
    :p.dispatch.ok?`parser run requested ${replayClock(p.dispatch.at)}`:'the parser run request failed; the daily run at 04:23 UTC picks it up';
  steps.push(s==='pending'
    ?{key:'queue',label:'Queued',state:'active',since:status.uploaded_at,detail:[p.queue_position&&`position ${p.queue_position}`,dispatch].filter(Boolean).join('; ')}
    :{key:'queue',label:'Queued',state:claimed?'done':'pending',detail:claimed&&status.uploaded_at?`waited ${replayDuration(Date.parse(p.claimed_at)-Date.parse(status.uploaded_at))}`:''});
  if(claimed){
    const runLink=p.run_url?{href:p.run_url,text:'View parser run'}:null;
    const jobs=new Map((p.jobs||[]).map(job=>[job.name,job]));
    // The job snapshot is only refreshed while parsing, so once the row is
    // finished an unfinished job there is stale: the pipeline got past it.
    const finished=s!=='parsing';
    const jobStep=(key,name,labels)=>{
      const job=jobs.get(name);
      if(finished&&job?.status!=='completed')return{key,label:labels.done,state:'done',detail:''};
      if(!job)return{key,label:labels.pending,state:'pending',detail:''};
      const took=job.started_at&&job.completed_at?replayDuration(Date.parse(job.completed_at)-Date.parse(job.started_at)):'';
      if(job.status==='completed'){
        if(job.conclusion==='success')return{key,label:labels.done,state:'done',detail:took};
        if(job.conclusion==='skipped')return{key,label:labels.done,state:'skipped',detail:'skipped'};
        return{key,label:labels.done,state:'failed',detail:`job ${job.conclusion||'failed'}`};
      }
      if(job.status==='in_progress')return{key,label:labels.active,state:'active',since:job.started_at,detail:''};
      return{key,label:labels.pending,state:'pending',detail:''};
    };
    if(jobs.size){
      const download=jobStep('download','fetch',{done:'Downloaded by the parser',active:'Downloading',pending:'Download'});
      download.link=runLink;
      steps.push(download);
      const decoder=jobStep('decoder','toolchain',{done:'Decoder ready',active:'Preparing the decoder',pending:'Decoder'});
      if(jobs.get('toolchain')?.cached&&decoder.state==='done')decoder.detail='from cache';
      else if(decoder.state==='done'&&decoder.detail)decoder.detail=`built in ${decoder.detail}`;
      steps.push(decoder);
      steps.push(jobStep('decode','parse',{done:'Decoded in the sandbox',active:'Decoding in the sandbox',pending:'Decode in the sandbox'}));
      steps.push(jobStep('store','submit',{done:'Checked and stored',active:'Checking and storing',pending:'Check and store'}));
    }else{
      steps.push({key:'run',label:s==='parsing'?'Parser run in progress':'Parser run',state:s==='parsing'?'active':'done',since:p.claimed_at,
        detail:[`started ${replayClock(p.claimed_at)}`,p.attempt>1&&`attempt ${p.attempt}`].filter(Boolean).join('; '),link:runLink});
    }
    const store=steps.find(step=>step.key==='store')||steps.at(-1);
    const extra=[p.decoded_at&&`result validated ${replayClock(p.decoded_at)}`,
      p.export&&`${p.export.files_done} of ${p.export.files} export files, ${replayMB(p.export.bytes_done)} of ${replayMB(p.export.bytes)} MB`].filter(Boolean);
    if(extra.length&&s==='parsing')store.detail=[store.detail,...extra].filter(Boolean).join('; ');
  }
  if(s==='parsed'){
    const c=status.counts||{};
    steps.push({key:'stored',label:'Stored',state:'done',detail:[status.parsed_at&&replayClock(status.parsed_at),c.rounds!=null&&`${c.rounds} rounds`,c.kills!=null&&`${c.kills} kills`,
      status.duration_ms&&`${Math.round(status.duration_ms/60000)} min`,status.build&&status.build.replace(/^\+\+Ares-Core\+release-/,'build '),
      status.export_bytes&&`full export ${replayMB(status.export_bytes)} MB`].filter(Boolean).join('; ')});
  }
  if(s==='failed'||s==='rejected'){
    const key=REPLAY_FAILED_STEP[status.error]||'decode';
    let at=steps.findIndex(step=>step.key===key||(key!=='upload'&&step.key==='run'));
    if(at<0){steps.push({key,label:'Parser run',state:'failed'});at=steps.length-1;}
    steps[at]={...steps[at],state:'failed',since:undefined,detail:replayFailureText(status)};
    steps.splice(at+1);
  }
  return steps;
}

// Upload speed over the last three seconds of measured progress; null until
// at least half a second has been measured.
function replaySpeed(samples,now,sent){
  samples.push([now,sent]);
  while(samples.length>2&&now-samples[0][0]>3000)samples.shift();
  const [t0,b0]=samples[0];
  return now-t0>=500?(sent-b0)/((now-t0)/1000):null;
}

async function loadReplayConfig(){
  replayImport.configLoad??=fetch('/api/replays/config').then(r=>r.ok?r.json():null).then(body=>{
    replayImport.config=body?.data||{enabled:false};
  }).catch(()=>{replayImport.config={enabled:false};replayImport.configLoad=null;});
  return replayImport.configLoad;
}

async function refreshReplayStatuses(ids){
  for(let i=0;i<ids.length;i+=REPLAY_STATUS_BATCH){
    const batch=ids.slice(i,i+REPLAY_STATUS_BATCH);
    try{
      const res=await fetch('/api/replays/status?ids='+batch.join(','));
      if(!res.ok)continue;
      const body=await res.json();
      for(const id of batch)if(body.data?.[id])replayImport.status.set(id,body.data[id]);
    }catch{}
  }
}

// What one replay row shows: the status headline, any rejection note, its
// steps, and whether the upload control is available.
function replayRowView(id){
  const status=replayImport.status.get(id);
  const canUpload=!!(replayImport.config?.enabled&&status?.can_upload);
  if(replayImport.busy.has(id)){
    return{label:'Uploading',tone:'busy',detail:'',steps:replayImport.live.get(id)||[],foldable:false,folded:false,canUpload:false,busy:true};
  }
  // A failed upload keeps its own steps until the server has something newer.
  if(replayImport.uploadFailed.has(id)&&!['uploading','pending','parsing','parsed'].includes(status?.status)){
    return{label:'Not uploaded',tone:'bad',detail:'',steps:replayImport.live.get(id)||[],foldable:false,folded:false,canUpload,busy:false};
  }
  const note=replayImport.notes.get(id);
  const view=replayStatusView(status);
  // A parsed replay folds its steps away; failures stay open to show why.
  const steps=replayProgressSteps(status);
  const foldable=status?.status==='parsed'&&steps.length>0;
  return{
    label:note?'Not uploaded':status?view.text:'Checking…',
    tone:note?'bad':view.tone,
    detail:note||'',
    steps,foldable,folded:foldable&&!replayImport.expanded.has(id),
    canUpload,busy:false,
  };
}
function toggleReplaySteps(id){
  if(!replayImport.expanded.delete(id))replayImport.expanded.add(id);
  emit();
}
// Loads the upload config and any missing statuses for the loaded matches.
async function syncReplayImport(){
  const ids=replayMatchRows(allMatches).map(r=>r.matchId);
  emit();
  await loadReplayConfig();
  const missing=ids.filter(id=>!replayImport.status.has(id));
  if(missing.length)await refreshReplayStatuses(missing);
  emit();
  scheduleReplayPoll();
}

function scheduleReplayPoll(){
  clearTimeout(replayImport.pollTimer);
  const waiting=[...replayImport.status].filter(([,s])=>['pending','parsing'].includes(s.status)).map(([id])=>id);
  if(!waiting.length||replayImport.polls>=REPLAY_POLL_LIMIT){replayImport.polls=0;return;}
  replayImport.pollTimer=setTimeout(async()=>{
    if(activePage!=='replays')return;
    if(document.hidden){scheduleReplayPoll();return;}
    replayImport.polls++;
    await refreshReplayStatuses(waiting);
    replayImport.notes.clear();
    emit();
    scheduleReplayPoll();
  },REPLAY_POLL_MS);
}

function loadTurnstile(){
  replayImport.turnstileLoad??=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async=true;script.onload=resolve;
    script.onerror=()=>{script.remove();replayImport.turnstileLoad=null;reject(new Error('Verification could not load.'));};
    document.head.appendChild(script);
  });
  return replayImport.turnstileLoad;
}

async function replayTurnstileToken(host){
  await loadTurnstile();
  return new Promise((resolve,reject)=>{
    const box=document.createElement('div');
    host.appendChild(box);
    const done=()=>setTimeout(()=>{try{turnstile.remove(widget);}catch{}box.remove();},0);
    const widget=turnstile.render(box,{sitekey:replayImport.config.turnstileSiteKey,action:'replay-upload',appearance:'interaction-only',
      callback:token=>{done();resolve(token);},
      'error-callback':()=>{done();reject(new Error('Verification failed. Try again.'));return true;},
      'expired-callback':()=>{done();reject(new Error('Verification expired. Try again.'));}});
  });
}

async function replayRequest(url,init,attempts=3){
  for(let attempt=1;;attempt++){
    try{
      const res=await fetch(url,init);
      if(res.status<500||attempt>=attempts)return res;
    }catch(e){if(attempt>=attempts)throw e;}
    await new Promise(r=>setTimeout(r,1500*attempt));
  }
}

// One part over XHR, which reports bytes sent; fetch cannot.
function replayPutPart(url,token,blob,onSent){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('PUT',url);
    xhr.setRequestHeader('X-Upload-Token',token);
    xhr.upload.onprogress=event=>onSent(event.loaded);
    xhr.onload=()=>{let body={};try{body=JSON.parse(xhr.responseText);}catch{}resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,body});};
    xhr.onerror=()=>reject(new Error('Network error'));
    xhr.send(blob);
  });
}

// `host` is the row's Turnstile container element; the widget needs a node.
async function uploadReplay(matchId,file,host){
  const config=replayImport.config;
  const reject=text=>{replayImport.notes.set(matchId,text);emit();};
  if(!config?.enabled)return;
  replayImport.notes.delete(matchId);
  if(file.size<config.minBytes||file.size>config.maxBytes){
    reject(`Replays must be between ${config.minBytes/1048576} and ${config.maxBytes/1048576} MB.`);return;
  }
  const head=new Uint8Array(await file.slice(0,4096).arrayBuffer());
  const embedded=replayFileMatchId(head);
  if(!embedded){reject('This is not a VALORANT replay file.');return;}
  if(embedded!==matchId){reject(`This replay is from match ${embedded}.`);return;}
  const build=replayFileBuild(head);
  const steps=[
    {key:'check',label:'File checked',state:'done',detail:[`replay of this match`,build&&`build ${build}`,`${replayMB(file.size)} MB`].filter(Boolean).join('; ')},
    {key:'verify',label:'Verifying you are human',state:'active',detail:''},
    {key:'send',label:'Upload',state:'pending',detail:''},
    {key:'finish',label:'Finish upload',state:'pending',detail:''},
  ];
  const update=(key,patch)=>{Object.assign(steps.find(step=>step.key===key),patch);replayImport.live.set(matchId,[...steps]);emit();};
  replayImport.uploadFailed.delete(matchId);
  replayImport.busy.add(matchId);
  update('verify',{});
  try{
    const turnstileToken=await replayTurnstileToken(host);
    update('verify',{state:'done',label:'Verified'});
    update('send',{state:'active',label:'Uploading',detail:`0.0 of ${replayMB(file.size)} MB, 0%`});
    const start=await replayRequest(`/api/replays/upload/${matchId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({size:file.size,turnstileToken})},1);
    const started=await start.json().catch(()=>({}));
    if(!start.ok)throw Object.assign(new Error(started.error||'Upload could not start.'),{step:'send'});
    const {uploadToken,partBytes,parts}=started.data;
    const began=Date.now(),samples=[],loaded=new Array(parts).fill(0);
    let lastPaint=0,finished=0,failure=null;
    const paint=(force=false)=>{
      const now=Date.now(),sent=loaded.reduce((sum,b)=>sum+b,0),speed=replaySpeed(samples,now,sent);
      if(!force&&now-lastPaint<200)return;
      lastPaint=now;
      update('send',{detail:[`${replayMB(sent)} of ${replayMB(file.size)} MB`,`${Math.floor(sent/file.size*100)}%`,speed!=null&&`${replayMB(speed)} MB/s`,`${finished} of ${parts} parts done`].filter(Boolean).join('; ')});
    };
    const sendPart=async n=>{
      if(failure)return;
      const blob=file.slice((n-1)*partBytes,n*partBytes);
      let res;
      for(let attempt=1;;attempt++){
        loaded[n-1]=0;
        try{res=await replayPutPart(`/api/replays/upload/${matchId}/part/${n}`,uploadToken,blob,bytes=>{loaded[n-1]=bytes;paint();});if(res.status<500||attempt>=3)break;}
        catch(e){if(attempt>=3){failure??=e;return;}}
        await new Promise(r=>setTimeout(r,1500*attempt));
      }
      if(!res.ok){failure??=new Error(res.body.error||'Upload failed.');return;}
      loaded[n-1]=blob.size;finished++;paint(true);
    };
    // Part 1 goes first: the server checks the replay header in it. The rest
    // go REPLAY_UPLOAD_CONCURRENCY at a time.
    await sendPart(1);
    let next=2;
    await Promise.all(Array.from({length:Math.min(REPLAY_UPLOAD_CONCURRENCY,parts-1)},async()=>{while(next<=parts&&!failure)await sendPart(next++);}));
    if(failure){
      fetch(`/api/replays/upload/${matchId}/abort`,{method:'POST',headers:{'X-Upload-Token':uploadToken}}).catch(()=>{});
      throw Object.assign(failure,{step:'send'});
    }
    const took=Date.now()-began;
    update('send',{state:'done',label:'Uploaded',detail:`${replayMB(file.size)} MB in ${replayDuration(took)}, ${replayMB(file.size/Math.max(took/1000,0.001))} MB/s average`});
    update('finish',{state:'active',label:'Finishing upload'});
    const done=await replayRequest(`/api/replays/upload/${matchId}/complete`,{method:'POST',headers:{'X-Upload-Token':uploadToken}});
    if(!done.ok)throw Object.assign(new Error((await done.json().catch(()=>({}))).error||'Upload could not be finished.'),{step:'finish'});
  }catch(e){
    const failed=steps.find(step=>step.key===(e.step||'verify'));
    Object.assign(failed,{state:'failed',detail:e.message||'Upload failed.'});
    steps.splice(steps.indexOf(failed)+1);
    replayImport.live.set(matchId,[...steps]);
    replayImport.uploadFailed.add(matchId);
    replayImport.busy.delete(matchId);
    await refreshReplayStatuses([matchId]);
    emit();
    return;
  }
  replayImport.busy.delete(matchId);
  replayImport.live.delete(matchId);
  await refreshReplayStatuses([matchId]);
  emit();
  scheduleReplayPoll();
}

const PAGE_SLUGS={overview:'',duos:'duos',matches:'matches','lobby-rank':'lobbyrank',servers:'servers',rr:'rr',clutches:'clutches',names:'names',replays:'replays'};
function playerRouteUrl(name,tag,page='overview',act=''){
  const base=`/player/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  const suffix=PAGE_SLUGS[page];
  const query=act&&PUUID_RE.test(act)?`?act=${encodeURIComponent(act.toLowerCase())}`:'';
  return base+(suffix?`/${suffix}`:'')+query;
}
function parsePlayerRoute(){
  const segments=location.pathname.replace(/\/+$/,'').split('/');
  if(segments.length<4||segments.length>5||segments[1]!=='player')return null;
  const page=segments[4]||'overview';
  if(!Object.prototype.hasOwnProperty.call(PAGE_SLUGS,page)&&page!=='lobbyrank')return null;
  try{
    const name=decodeURIComponent(segments[2]);
    const tag=decodeURIComponent(segments[3]);
    if(!name||!tag)return null;
    const requestedAct=new URLSearchParams(location.search).get('act')||'';
    return{name,tag,page:page==='lobbyrank'?'lobby-rank':page,act:PUUID_RE.test(requestedAct)?requestedAct.toLowerCase():''};
  }catch(_){return null;}
}
function writePlayerRoute(name,tag,act,mode='push'){
  if(!name||!tag)return;
  const url=playerRouteUrl(name,tag,activePage,act);
  if(url===location.pathname+location.search)return;
  history[mode==='replace'?'replaceState':'pushState'](null,'',url);
  applyPage();
}
function loadPlayerFromRoute(){
  const route=parsePlayerRoute();
  if(!route){
    // Returning to a generic route should return to its empty landing state.
    if(PLAYER||TAG)location.reload();
    return;
  }
  if(PLAYER.toLowerCase()===route.name.toLowerCase()&&TAG.toLowerCase()===route.tag.toLowerCase()&&
     TARGET_SEASON.toLowerCase()===route.act)return;
  searchText=`${route.name}#${route.tag}`;
  onManualInput();
  seasonValue='';
  emit();
  runAnalysis(undefined,{fromUrl:true,initialAct:route.act});
}

const PAGE_TITLES={overview:'vlravg — Average Lobby Rank & Valorant Stats',duos:'Duos — vlravg',matches:'Match History — vlravg','lobby-rank':'Lobby Rank — vlravg',servers:'Servers — vlravg',rr:'RR Breakdown — vlravg',clutches:'Clutches — vlravg',names:'Name History — vlravg',replays:'Replay Import — vlravg'};
const PROFILE_TITLES={overview:'Overview',duos:'Duos',matches:'Match History','lobby-rank':'Lobby Rank',servers:'Servers',rr:'RR Breakdown',clutches:'Clutches',names:'Name History',replays:'Replay Import'};
let playerRoute=null;
function applyPage(focus=false){
  playerRoute=parsePlayerRoute();
  let path=location.pathname.replace(/\/+$/,'');
  // Also normalize old links when a cached app shell or local SPA fallback
  // serves HTML before Cloudflare's redirect rules are applied.
  if(path==='/lobby-rank'){
    path='/lobbyrank';
    history.replaceState(history.state,'',path+location.search+location.hash);
  }
  activePage=playerRoute?.page||(path==='/duos'?'duos':path==='/matches'?'matches':path==='/lobbyrank'?'lobby-rank':path==='/servers'?'servers':path==='/rr'?'rr':path==='/clutches'?'clutches':path==='/names'?'names':path==='/replays'?'replays':'overview');
  document.title=playerRoute?`${playerRoute.name}#${playerRoute.tag} — ${PROFILE_TITLES[activePage]} — vlravg`:PAGE_TITLES[activePage];
  if(focus)pageFocusSignal++;
  emit();
}
// The in-app href for a page, keeping the loaded player and act in the URL.
function pageHref(page){
  return playerRoute
    ?playerRouteUrl(playerRoute.name,playerRoute.tag,page,playerRoute.act)
    :page==='overview'?'/':`/${PAGE_SLUGS[page]}`;
}
function navigateToPage(page){
  if(page===activePage)return;
  history.pushState(null,'',pageHref(page));
  applyPage(true);
}

/* ── ACT PICKER ──────────────────────────────────────────── */
function actOptionLabel(uuid,stats){
  return getActLabel(uuid,stats?.short);
}
function updateSeasonDropdown(seasonStats,seasonOrder,savedCounts={}){
  const current=seasonValue;
  // Include acts saved under this PUUID even when the current region's MMR
  // response has no games for them (for example after a region transfer).
  const order=[...new Set([...(seasonOrder||[]),...Object.keys(savedCounts)].map(id=>id.toLowerCase()))]
    .sort((a,b)=>{
      const aStart=getActInfoByUuid(a)?.start,bStart=getActInfoByUuid(b)?.start;
      if(aStart!=null&&bStart!=null)return bStart-aStart;
      return (seasonOrder||[]).indexOf(b)-(seasonOrder||[]).indexOf(a);
    });
  const options=[];
  order.forEach(uuid=>{
    const stats=seasonStats[uuid.toLowerCase()]||seasonStats[uuid];
    const regionalGames=Number(stats?.games)||0;
    const savedGames=Number(savedCounts[uuid.toLowerCase()]??savedCounts[uuid])||0;
    if(regionalGames<=0&&savedGames<=0)return;
    options.push({value:uuid,label:actOptionLabel(uuid,stats),games:savedGames||regionalGames,countKind:savedGames?'saved':'regional'});
  });
  seasonOptions=options;
  // Restore previous selection if it's still in the list
  seasonValue=current&&options.some(o=>o.value===current)?current:'';
  emit();
}

function setSeasonMatchCount(actId,count,kind){
  if(!actId)return;
  let option=seasonOptions.find(o=>o.value.toLowerCase()===actId.toLowerCase());
  if(!option){
    option={value:actId,label:actOptionLabel(actId),games:0,countKind:null};
    seasonOptions=[...seasonOptions,option];
  }
  seasonOptions=seasonOptions.map(o=>o===option?{...o,games:count,countKind:kind}:o);
  seasonValue=option.value;
  emit();
}

// The count shown beside an act in the picker.
function seasonOptionCountText(option){
  if(!option?.value||!option.countKind)return '';
  const games=Number(option.games)||0,amount=games.toLocaleString();
  return option.countKind==='loading'
    ?(games?`${amount}+ matches found, still checking`:'Checking matches…')
    :option.countKind==='partial'?`${amount}+ matches found, scan paused`
    :option.countKind==='found'?`${amount} ${games===1?'match':'matches'} found`
    :option.countKind==='saved'?`${amount} saved ${games===1?'match':'matches'}`
    :`${amount} in current region`;
}
function seasonTriggerLabel(){
  if(seasonUi.mode!=='select')return seasonUi.label;
  return seasonValue?(seasonOptions.find(o=>o.value===seasonValue)?.label||'Most recent act'):'Most recent act';
}

function selectSeasonOption(value){
  const changed=seasonValue!==value;
  if(changed)seasonValue=value;
  emit();
  // If a profile is already loaded (PLAYER gets set once runAnalysis has run),
  // picking a different act should actually reload the stats for it.
  if(changed&&PLAYER)runAnalysis();
}
function openSeasonDropdown(){seasonOpenSignal++;emit();}

let _prefetchId=0;
// Bumped each time a new analysis starts; a run whose id no longer matches has
// been superseded (e.g. the user picked a different act) and must stop writing.
let _analysisGen=0;
let _analysisController=null,_prefetchController=null;
let _lastPrefetchKey='';
let _prefetchCache=null; // {key, acctJ, mmrJ} — set once prefetchPlayerActs succeeds
let _seasonOptionsKey='';
let _pendingPrefetchKey='';

function showSeasonLoading(){seasonUi={mode:'loading',label:'Loading acts…'};emit();}
function showSeasonIdle(label='Most recent act'){seasonUi={mode:'idle',label};emit();}
function showSeasonSelect(){seasonUi={mode:'select',label:''};emit();}
// The act picker was opened: show the loaded acts, or load them first.
async function requestSeasonDropdown(){
  let parsed=parseSearchInput(searchText.trim());
  if(!parsed){
    await proLibraryReady;
    const exactPro=findExactProAccount(searchText);
    if(exactPro){searchText=exactPro.puuid;onManualInput();parsed=parseSearchInput(searchText.trim());emit();}
  }
  if(!parsed){
    shakeSearchBar();
    focusSearch();
    return;
  }
  if(seasonOptions.length){openSeasonDropdown();return;}
  prefetchPlayerActs(true);
}

// The search box takes "name#tag", and also accepts a raw PUUID pasted in
// its place — same box, no separate mode. Returns null when the input is
// neither. `key` is the identity used for prefetch caching.
const PUUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseSearchInput(raw){
  const s=(raw||'').trim();
  if(PUUID_RE.test(s)){
    const id=s.toLowerCase();
    return{puuid:id,name:'',tag:'',key:id};
  }
  const hi=s.lastIndexOf('#');
  if(hi<1||hi===s.length-1)return null;
  const name=s.slice(0,hi),tag=s.slice(hi+1);
  return{puuid:'',name,tag,key:`${name}#${tag}`};
}
// Account lookup for either input form.
function accountUrlFor(p){
  return p.puuid
    ? `${API_BASE}/account-by-puuid/${encodeURIComponent(p.puuid)}`
    : `${API_BASE}/account/${encodeURIComponent(p.name)}/${p.tag}`;
}

/* ── PRO PLAYER LIBRARY ──────────────────────────────────── */
// Static pro-account library generated from the vct-2026-data-analysis
// project's curated Tracker mapping. Search stays entirely client-side; the
// PUUID is used for analysis so Riot ID changes do not break a saved entry.
let proLibraryRows=[];
let proLibraryState='loading';
let proLibraryReady=Promise.resolve();
function foldProSearch(value){
  return (value||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLocaleLowerCase('en');
}
async function loadProPlayerLibrary(){
  try{
    const response=await fetch('/pro-players.json');
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const data=await response.json();
    proLibraryRows=(data.players||[]).flatMap(player=>(player.accounts||[]).filter(account=>PUUID_RE.test(account.puuid||'')).map((account,index)=>({
      handle:player.handle,
      accountIndex:index,
      accountCount:player.accounts.length,
      puuid:account.puuid.toLowerCase(),
      // Team and team code only for pros on a partnered roster (rostermania).
      team:player.team||null,
      teamCode:/^[a-z0-9]{1,6}$/i.test(player.teamCode||'')?player.teamCode:null,
      region:player.region||null,
      countryCode:/^[a-z]{2}$/i.test(player.countryCode||'')?player.countryCode.toUpperCase():null,
      searchText:foldProSearch([player.handle,account.puuid,player.team,player.teamCode].filter(Boolean).join(' ')),
    })));
    proLibraryState='ready';
  }catch(error){
    console.warn('Pro player library unavailable:',error);
    proLibraryState='error';
  }
  emit();
}
function proMatchScore(row,query){
  const handle=foldProSearch(row.handle),puuid=foldProSearch(row.puuid);
  if(handle===query)return 0;
  if(handle.startsWith(query))return 1;
  if(puuid.startsWith(query))return 2;
  if(handle.includes(query))return 3;
  if(puuid.includes(query))return 4;
  return 5;
}
function proSearchResults(rawQuery){
  const query=foldProSearch(String(rawQuery||'').trim());
  const terms=query.split(/\s+/).filter(Boolean);
  return proLibraryRows
    .filter(row=>terms.every(term=>row.searchText.includes(term)))
    .sort((a,b)=>proMatchScore(a,query)-proMatchScore(b,query)||a.handle.localeCompare(b.handle,'en',{sensitivity:'base'}));
}
function analyzeProAccount(row){
  searchText=row.puuid;
  onManualInput();
  emit();
  runAnalysis(row.puuid);
}
function findExactProAccount(value){
  const query=foldProSearch(value.trim());
  if(!query)return null;
  return proLibraryRows.find(row=>row.accountIndex===0&&foldProSearch(row.handle)===query)
    ||proLibraryRows.find(row=>foldProSearch(row.handle)===query)
    ||null;
}
async function submitSearch(){
  if(parseSearchInput(searchText.trim())){
    runAnalysis();
    return;
  }
  await proLibraryReady;
  const exactPro=findExactProAccount(searchText);
  if(exactPro){
    searchText=exactPro.puuid;
    onManualInput();
    emit();
    runAnalysis(exactPro.puuid);
    return;
  }
  runAnalysis();
}

function setSearchText(value){
  searchText=value;
  onManualInput();
  emit();
}
function onManualInput(){
  if(headerInfo)headerInfo={...headerInfo,showTracker:false};
  const raw=searchText.trim();
  const parsed=parseSearchInput(raw);
  const valid=parsed!=null;
  const key=parsed?parsed.key:null;
  // Return to the compact act picker if the name is invalid, or if it's changed
  // from the acts we already loaded — so the user can load acts for the new name.
  if(!valid || (_seasonOptionsKey && key!==_seasonOptionsKey) || (_pendingPrefetchKey && key!==_pendingPrefetchKey)){
    showSeasonIdle();
    seasonOptions=[];seasonValue='';
    _prefetchId++;
    _prefetchController?.abort();
    _lastPrefetchKey='';
    _seasonOptionsKey='';
    _pendingPrefetchKey='';
    _prefetchCache=null;
  }
}

async function prefetchPlayerActs(openAfter=false){
  const raw=searchText.trim();
  const parsed=parseSearchInput(raw);
  if(!parsed){
    shakeSearchBar();
    return;
  }
  const key=parsed.key;
  if(_lastPrefetchKey===key)return;
  const myId=++_prefetchId;
  _prefetchController?.abort();
  _prefetchController=new AbortController();
  const opts={quiet:true,signal:_prefetchController.signal};
  _pendingPrefetchKey=key;
  showSeasonLoading();
  try{
    const{j:acctJ}=await apiGet(accountUrlFor(parsed),opts);
    if(myId!==_prefetchId)return;
    const acctData=acctJ.data||acctJ;
    const region=acctData.region||'eu';
    // A PUUID search only knows the name/tag after this lookup resolves.
    const name=parsed.name||acctData.name||'';
    const tag=parsed.tag||acctData.tag||'';
    if(!name||!tag){_pendingPrefetchKey='';showSeasonIdle();return;}

    const savedCountsPromise=readSavedMatchCounts(acctData.puuid,opts);
    const mmrUrl=`${API_BASE}/rank/${region}/pc/${encodeURIComponent(name)}/${tag}`;
    const mmrPromise=apiGet(mmrUrl,opts).then(result=>({result}),error=>({error}));
    const savedCounts=await savedCountsPromise;
    if(myId!==_prefetchId)return;
    if(Object.keys(savedCounts).length){
      updateSeasonDropdown({},[],savedCounts);
      showSeasonSelect();
      if(openAfter){openSeasonDropdown();openAfter=false;}
    }

    const mmrOutcome=await mmrPromise;
    if(mmrOutcome.error)throw mmrOutcome.error;
    const{j:mmrJ}=mmrOutcome.result;
    if(myId!==_prefetchId)return;

    const seasonal=(mmrJ.data||mmrJ).seasonal||[];
    const seasonStats={};
    seasonal.forEach(s=>{
      const id=(s.season?.id||'').toLowerCase();
      if(!id)return;
      seasonStats[id]={games:s.games||0,short:s.season?.short||null};
    });

    if(!Object.values(seasonStats).some(s=>s.games>0)&&!Object.keys(savedCounts).length){_pendingPrefetchKey='';showSeasonIdle('No played acts');return;}
    const seasonOrder=getSeasonOrder(seasonal);
    updateSeasonDropdown(seasonStats,seasonOrder,savedCounts);

    if(!seasonValue){
      seasonValue=seasonOptions[0]?.value||'';
      emit();
    }

    _lastPrefetchKey=key;
    _seasonOptionsKey=key;
    _pendingPrefetchKey='';
    _prefetchCache={key,acctJ,mmrJ,savedCounts};
    showSeasonSelect();
    if(openAfter)openSeasonDropdown();
  }catch(_){
    if(myId!==_prefetchId)return;
    _pendingPrefetchKey='';
    if(seasonOptions.length){
      _lastPrefetchKey=key;_seasonOptionsKey=key;showSeasonSelect();
    }else showSeasonIdle('Retry loading acts');
  }
}

function shakeSearchBar(){searchShakeSignal++;emit();}
function focusSearch(){searchFocusSignal++;emit();}

function runAnalysis(searchOverride,{fromUrl=false,initialAct=null}={}){
  let playerName,playerTag,playerRegion,playerPlatform,playerSeason;
  const rawNT=typeof searchOverride==='string'?searchOverride.trim():searchText.trim();
  const parsed=parseSearchInput(rawNT);
  if(!parsed){
    shakeSearchBar();
    focusSearch();
    return;
  }
  if(seasonUi.mode==='loading'){
    _prefetchId++;
    _prefetchController?.abort();
    _pendingPrefetchKey='';
    showSeasonIdle();
  }
  playerName=parsed.name;
  playerTag=parsed.tag;
  playerRegion='eu'; // overridden by account lookup
  playerPlatform='pc';
  playerSeason=initialAct!==null?initialAct:seasonValue;
  // A PUUID search starts with the id already known and the name/tag blank;
  // loadAll's account step fills those in from the by-puuid lookup.
  PLAYER=playerName;TAG=playerTag;REGION=playerRegion;PLATFORM=playerPlatform;TARGET_SEASON=playerSeason;PUUID=parsed.puuid;
  hasAnalysis=true;
  analysisState='loading';
  headerRevealPending=true;
  showSeasonLoading();
  setStatus('');
  const inputIdentity=parsed.name?parsed:parseSearchInput(searchText.trim());
  const pendingRoutePush=!fromUrl&&!inputIdentity?.name;
  if(!fromUrl&&inputIdentity?.name)writePlayerRoute(inputIdentity.name,inputIdentity.tag,playerSeason);
  nameHistoryRows=[];nameHistoryState='idle';nameHistoryBackfill=null;nameBackfillBusy=false;nameBackfillError=false;
  nameBackfillStopRequested=false;nameBackfillStopped=false;nameBackfillPages=0;
  accentColor='#3b82f6';
  rankColored=false;
  errorMessage=null;
  headerInfo=null;trackerHref='';
  CURRENT_TIER_ID=null;
  CURRENT_RR=null;
  allMatches=[];statMatches=[];mhVisible=PER_PAGE;mhData=[];mhDayStats={};replayImport.status.clear();replayImport.notes.clear();
  _rrChangeByMatchId={};_rrDetailsByMatchId={};_preRRByMatchId={};_preTierByMatchId={};_postRRByMatchId={};_postTierByMatchId={};_refundedRRByMatchId={};_derankProtectedByMatchId={};_rrDodges=[];
  allTeammates=[];allEncounters=[];serverData=[];serverPartySize=0;serverFilteredMatchCount=0;lobbyRankPartySize=0;lobbyRankFilteredMatchCount=0;rrMovementZoomTier=null;
  lobbyRankData=[];partySizeData=[];overviewStats=null;
  rrRanges=rrDefaultRanges();
  // If the season dropdown's prefetch already fetched this exact player (the
  // common case — it runs while the player is still typing), reuse those
  // responses instead of re-fetching account+mmr from scratch.
  const submittedKey=parsed.key;
  const prefetchSnapshot=(_lastPrefetchKey===submittedKey&&_prefetchCache?.key===submittedKey)?_prefetchCache:null;
  _lastPrefetchKey='';
  _prefetchCache=null;
  if(activePage==='overview')scrollResultsSignal++;
  emit();
  loadAll(prefetchSnapshot,pendingRoutePush);
}

// ─────────────────────────────────────────────────────────────────────────
//  Rate-limit ledger — a tiny model of the server's per-1-min quota window,
//  kept in sync from response headers so callers can look BEFORE they leap.
// ─────────────────────────────────────────────────────────────────────────
// Rate limiting (pacing, quota tracking, gliding) now lives entirely in the
// worker — see functions/api/[[path]].js. The client has no quota state of
// its own anymore; apiGet() below just fires requests and reacts to a 429 by
// reading retryAfterMs out of the response body.

const MIN_RATED=7; // strict: a match needs at least this many rated players (of 10) for its lobby rank to count

function sleep(ms,signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>signal?.removeEventListener('abort',onAbort);
    const onAbort=()=>{clearTimeout(timer);cleanup();reject(signal.reason);};
    const timer=setTimeout(()=>{cleanup();resolve();},ms);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

// Bound Henrik concurrency per search; waiting for a retry never holds a slot.
function createRequestPool(limit=2){
  let active=0;
  const queue=[];
  const acquire=signal=>new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const entry={start(){
      signal?.removeEventListener('abort',onAbort);
      active++;
      let released=false;
      resolve(()=>{
        if(released)return;
        released=true;active--;
        queue.shift()?.start();
      });
    }};
    const onAbort=()=>{const i=queue.indexOf(entry);if(i>=0)queue.splice(i,1);reject(signal.reason);};
    if(active<limit)entry.start();
    else{queue.push(entry);signal?.addEventListener('abort',onAbort,{once:true});}
  });
  return{acquire};
}

// Keep the timeout active through JSON body consumption, not just headers.
async function fetchApiJson(url,opts={}){
  opts.signal?.throwIfAborted();
  const controller=new AbortController();
  const onAbort=()=>controller.abort(opts.signal.reason);
  opts.signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(new DOMException('Request timed out','TimeoutError')),opts.timeoutMs??30000);
  try{
    const r=await fetch(url,{cache:opts.cache||'default',signal:controller.signal,
      method:opts.method||'GET',headers:opts.headers,body:opts.body});
    let j;
    try{j=await r.json();}catch(e){if(r.ok||controller.signal.aborted)throw e;j=null;}
    controller.signal.throwIfAborted();
    return{r,j};
  }finally{
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort',onAbort);
  }
}


async function waitForRateLimit(ms,onUpdate,signal){
  const deadline=performance.now()+ms;
  let lastMessage='';
  let ownsStatus=true;
  const update=()=>{
    if(lastMessage&&statusText!==lastMessage)ownsStatus=false;
    if(!ownsStatus||signal?.aborted)return;
    const seconds=Math.max(0,Math.ceil((deadline-performance.now())/1000));
    const message=onUpdate?.(seconds)||`Rate limit reached — waiting ${seconds}s for reset…`;
    if(message!==lastMessage){
      setStatus(message,true);
      lastMessage=message;
    }
  };
  update();
  const timer=setInterval(update,200);
  try{await sleep(ms,signal);}finally{clearInterval(timer);}
}

// Pull a machine-readable error code out of HenrikDev's {status,errors:[{code,…}]}
// body when available, so messages are specific (see docs → Error Codes).
function parseApiError(r,b){
  const e=b?.errors?.[0];
  if(e)return `API ${r.status} (code ${e.code}): ${e.message||'error'}`;
  return `API ${r.status}`;
}

// ─────────────────────────────────────────────────────────────────────────
//  apiGet — the single entry point for every HenrikDev call.
//
//  Pacing (spacing requests, gliding as quota runs low) now lives entirely in
//  the worker, coordinated across every concurrent user of the app — see
//  functions/api/[[path]].js. This function just fires requests and, on a
//  429, waits however long the worker's response body says to.
//
//  Returns { j } — `rem` was dropped from the return shape since the client
//  no longer has quota numbers to report; no call site was reading it.
// ─────────────────────────────────────────────────────────────────────────
async function apiGet(url,opts={},_attempt=0,_rl=0){
  const MAX_RETRIES=5;   // hard failures (network / 5xx)
  const MAX_RL_WAITS=40; // 429 waits within one call (each waits the real reset)

  opts.signal?.throwIfAborted();
  let r,j;
  try{
    const release=opts.pool?await opts.pool.acquire(opts.signal):()=>{};
    try{({r,j}=await fetchApiJson(url,opts));}finally{release();}
  }catch(e){
    if(opts.signal?.aborted)throw opts.signal.reason;
    // fetch() itself threw → network/CORS failure (e.g. proxy 5xx with no CORS).
    if(_attempt>=MAX_RETRIES)throw new Error('Network error — check your connection');
    const wait=Math.min(1500*Math.pow(2,_attempt),20000);
    if(!opts.quiet)setStatus(`Network error — retrying in ${Math.ceil(wait/1000)}s… (${_attempt+1}/${MAX_RETRIES})`,true);
    await sleep(wait,opts.signal);
    return apiGet(url,opts,_attempt+1,_rl);
  }
  opts.signal?.throwIfAborted();

  // 1) 429 — the worker either declined before calling upstream (shared quota
  //    already exhausted this window) or relayed a real 429 from HenrikDev.
  //    Either way, the body tells us exactly how long to wait — no headers
  //    involved anymore. Floor the wait so we can never retry into the same
  //    just-exhausted window microseconds later.
  if(r.status===429){
    if(_rl>=MAX_RL_WAITS)throw new Error('Rate limited — please try again in a minute');
    let retryMs=RL_WAIT_FLOOR_MS;
    if(Number.isFinite(j?.retryAfterMs))retryMs=Math.max(j.retryAfterMs,RL_WAIT_FLOOR_MS);
    const wait=Math.min(retryMs,MAX_WAIT_MS);
    if(opts.quiet)await sleep(wait,opts.signal);
    else await waitForRateLimit(wait,opts.onRateLimit,opts.signal);
    return apiGet(url,opts,_attempt,_rl+1);
  }

  // 2) Maintenance (the proxy's switch, lib/site-flags.mjs): not transient, say so once.
  if(r.status===503&&j?.maintenance)throw new Error(j.error||'vlravg is offline for maintenance. Please try again later.');
  // The proxy already spent an upstream call and then could not save it.
  // Retrying would spend another call for the same failed write.
  if(r.status===503&&j?.storage==='unavailable')throw new Error(parseApiError(r,j));

  // 3) Transient server errors — exponential backoff.
  if([500,502,503,504].includes(r.status)){
    if(_attempt>=MAX_RETRIES)throw new Error(parseApiError(r,j));
    const wait=Math.min(1000*Math.pow(2,_attempt),16000); // 1,2,4,8,16s
    if(!opts.quiet)setStatus(`Server error (${r.status}) — retrying in ${Math.ceil(wait/1000)}s… (${_attempt+1}/${MAX_RETRIES})`,true);
    await sleep(wait,opts.signal);
    return apiGet(url,opts,_attempt+1,_rl);
  }

  // 4) Other non-OK (400/401/403/404…) — not retryable, surface the real reason.
  if(!r.ok)throw new Error(parseApiError(r,j));

  return{j};
}

// Back-compat alias — older call sites referenced fetchWithRetry by name.
const fetchWithRetry=apiGet;


function isSeason(m){
  if(!TARGET_SEASON)return true;
  const sid=m.metadata?.season?.id||m.metadata?.season_id||'';
  return sid===TARGET_SEASON||sid.includes(TARGET_SEASON.slice(0,8));
}
// ── CLUTCH DETECTION — reusable, module-level functions ────────────────────
// Extracted so both processMatch (the real app) and the full-round review
// debug panel can call the EXACT same logic — guarantees the review tool
// never drifts out of sync with what the app actually computes.

/* ═══════════════════════════════════════════════════════════════════════
   CLUTCH DETECTION

   Definition used here: a clutch is any moment where every teammate who
   was actually playing the round is dead, you are still alive, and at
   least one enemy remains. The 1vX number is however many enemies were
   alive at that instant.

   Riot's API exposes no pre-computed clutch flag, so this is
   reconstructed from the raw kills array (each kill carries a round
   index, a killer/victim with team, a timestamp, and the weapon used).
   Three things make that reconstruction harder than it sounds. Each one
   caused a real, confirmed bug before it was handled:

     1. REVIVES — a death in the kill feed isn't always permanent. Sage
        resurrection and Clove's self-revive put a player back in the
        round, so counting every death entry over-counts how many
        teammates are actually down.
     2. ABSENT PLAYERS — a disconnected teammate never dies. Waiting for
        a death that will never come means the "last one alive" trigger
        never fires, hiding real clutches entirely.
     3. POSTHUMOUS KILLS — lingering utility (a Tejo missile in flight, a
        Killjoy turret, a trap, a molly still ticking) scores kills after
        its owner is already dead for good. That looks identical to a
        revive if you only check "did they get a kill after dying."

   Validated against two ground truths that don't depend on this code
   being right: Riot's own CeremonyClutch round tag, and an
   Elimination-round cross-check (the losing side must have exactly as
   many real deaths as it had players on the field). Across two
   independent datasets — 140 and 123 matches, different players and
   ranks — CeremonyClutch matched 144/144 and 108/108 with zero misses,
   and Elimination mismatches were 0 on both.

   Note on ceremony: CeremonyClutch is reliable when present but far too
   sparse to detect with. Riot shows only one badge per round with
   Ace/TeamAce/Thrifty/Closer taking priority over Clutch, never badges
   losses at all, and skips most genuine 1v1s (measured: ~2% of true 1v1
   wins get the tag, vs ~63% of 1v2s). Confirmed cases exist of an
   unambiguous 15-second solo 1v1 win still tagged CeremonyDefault. It's
   used as a verification signal in the debug panel, never as the source.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Tunables ─────────────────────────────────────────────────────── */

// A weapon kill credited to a player this soon after their own death is
// read as timestamp jitter on a near-simultaneous trade, not proof they
// were revived and playing on. Calibrated against confirmed examples on
// both sides: a genuine Sage revive showed an 8.7s gap between the
// "death" and the player's next rifle kill, while a real trade (verified
// independently by that round's CeremonyClutch tag) showed 1.3s.
const REVIVE_MIN_GAP_MS=3000;

// Round Phase durations plus the confirmed Post-Round Phase, used by the
// Clove revive-window check below. Riot's data doesn't expose "time
// remaining," only round-relative event timestamps and the plant time, so
// these are needed to derive how much clock was left at any moment.
//
// Nominal Round Phase durations are 100s (unplanted) / 45s (post-plant).
// Buy Phase is separate and NOT included in time_in_round_in_ms —
// confirmed empirically: if it were, unplanted-round kills would top out
// near 130s (100+30s Buy Phase), but the observed max across 113 matches
// was 106.7s, matching nominal Round Phase, not Round+Buy. That leftover
// ~6-7s overshoot (106.7s unplanted, 51.1s post-plant) is the confirmed
// 7s Post-Round Phase — a real, separate phase where "any surviving agents
// will still be able to do anything... but will no longer be able to
// affect the outcome of the round," so actions taken there can still land
// in the kill feed with real timestamps past the nominal mark.
//
// Not Dead Yet's own safety net ("survives if the round ends while the
// timer is still ongoing") is NOT the same boundary as the round's outcome
// being decided — her timer keeps running through Post-Round Phase and can
// still expire and kill her during it; she's only safe once the NEXT Buy
// Phase actually begins. So the correct boundary for this check is nominal
// Round Phase PLUS the confirmed 7s Post-Round Phase — not nominal alone
// (an earlier version of this comment argued the opposite and was wrong).
const POST_ROUND_PHASE_MS=7000;
const CLOVE_REVIVE_SPIKE_BOUNDARY_MS=45000+POST_ROUND_PHASE_MS;
const CLOVE_REVIVE_ROUND_BOUNDARY_MS=100000+POST_ROUND_PHASE_MS;

// Absolute ceiling on how long a Clove's own self-revive attempt
// (Not Dead Yet) can take from her original death to needing a kill or
// damaging assist locked in. Built from confirmed values — 1.5s revive
// windup + up to 2s intangibility + 0.8s deactivation + 10s resurrection
// timer = 14.3s — plus Riot's own description of "a couple of seconds"
// to decide and activate in the first place, generously rounded up to
// 3s (14.3s + 3s = 17.3s). Cross-checked against 38 confirmed real Not
// Dead Yet timeouts in this exact dataset: the largest observed gap
// between an original death and the timeout kill was 16.86s, comfortably
// under this ceiling — so it's a validated bound, not just a paper one.
// See computeRealDeaths case 2b for how this gets used.
const MAX_CLOVE_SELF_REVIVE_WINDOW_MS=17300;

/* ── Step 1 · Who was actually in this round? ─────────────────────── */

// Primary method: DIRECT OBSERVATION via the positional snapshot Riot
// attaches to the plant and defuse events (rounds[r].plant.player_locations).
// That snapshot lists every player alive at that instant with their map
// coordinates — it's literally the data tracker.gg renders as the round
// minimap. A player who never spawned simply isn't in it.
//
// So: a player is ABSENT from the round if they're missing from the
// snapshot AND have no death event before it. Missing-but-died is just
// someone who was already killed; missing-and-never-died never spawned.
//
// Use RAW death events here, not the revive-adjusted ones from
// computeRealDeaths. A revived player was genuinely dead at the snapshot
// moment, so their absence IS explained — but the revive logic erases
// that death, which would make them look like they never spawned.
// (Confirmed: four separate players flagged this way before the fix, all
// of them ordinary revives, all four false positives.)
//
// Fallback: received_penalty, for the ~40% of rounds with no plant or
// defuse (eliminations before the plant, or time expiry) and therefore no
// snapshot to read.
//
// Validated against each other across 3,205 rounds that DO have a
// snapshot, over two independent datasets: the two methods agree on
// every single player-round, zero disagreements in either direction.
// The snapshot is preferred anyway because it's direct observation
// rather than a flag, so it can't be defeated by a short AFK stint that
// never trips Riot's penalty threshold.
//
// Two earlier approaches were tried and both proved wrong:
//   · Inferring from the kill feed ("last round they appear in") — a
//     present, live player can go several rounds with no kills and no
//     deaths, and that heuristic read those quiet rounds as disconnects,
//     inventing clutch situations that never happened.
//   · was_afk — turned out to mean "took zero actions this round," which
//     fires for a present-but-idle player just as often as for someone
//     truly gone (confirmed: a round with was_afk=true, a real weapon in
//     the loadout, and no penalty — that player was still on the field
//     and still killable). It also failed the other way, with a
//     confirmed-gone player showing was_afk=false.
//
// Deliberately NOT used: stayed_in_spawn. A player who hides in spawn
// all round is still alive and still killable, so they legitimately
// count toward the roster — excluding them would fire the last-alive
// trigger early and invent clutches. It's a signal for judging effort,
// not presence.
function presentCount(teamPlayers,roundData,roundKills){
  // Gather every positional snapshot available this round, then use the
  // EARLIEST one — the fewer players who've died by that point, the fewer
  // absences need explaining away via the kill feed.
  //
  // Sources, best coverage first:
  //   1. Kill events (player_locations / player_locations_on_kill). Every
  //      round with at least one kill gets a snapshot, so this covers
  //      essentially all rounds — including the ~40% with no plant or
  //      defuse. Field naming differs between API versions, so both are
  //      accepted. Absent from the v4 matchlist payload as currently
  //      fetched; present in v2's match endpoint. Handled defensively so
  //      it starts working automatically the moment richer data is fed in.
  //   2. Plant / defuse events (player_locations). Always present in v4,
  //      but only exist on rounds that actually had a plant or defuse.
  const snaps=[];
  (roundKills||[]).forEach(k=>{
    const locs=k.player_locations||k.player_locations_on_kill;
    if(locs?.length)snaps.push({ms:k.time_in_round_in_ms??0,locs});
  });
  if(roundData.plant?.player_locations?.length)
    snaps.push({ms:roundData.plant.round_time_in_ms,locs:roundData.plant.player_locations});
  if(roundData.defuse?.player_locations?.length)
    snaps.push({ms:roundData.defuse.round_time_in_ms,locs:roundData.defuse.player_locations});

  if(snaps.length&&roundKills){
    const snap=snaps.reduce((a,b)=>b.ms<a.ms?b:a);
    // Snapshot entries are {player:{puuid}} in v4, {player_puuid} in v2.
    const seenAlive=new Set(snap.locs.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean));
    const diedBySnapshot=new Set();
    roundKills.forEach(k=>{
      if(k.victim?.puuid&&(k.time_in_round_in_ms??0)<=snap.ms)diedBySnapshot.add(k.victim.puuid);
    });
    return teamPlayers.filter(p=>seenAlive.has(p.puuid)||diedBySnapshot.has(p.puuid)).length;
  }

  // No positional data at all this round — fall back to Riot's penalty flag.
  const active={};
  (roundData.stats||[]).forEach(s=>{active[s.player.puuid]=!s.received_penalty;});
  return teamPlayers.filter(p=>active[p.puuid]===true).length;
}

/* ── Step 2 · When did each player REALLY die? ────────────────────── */

// Resolves each player's permanent death for the round, filtering out
// deaths undone by a revive (Sage resurrection, Clove self-revive).
//
// Returns { realDeath: {puuid: deathMs}, unresolved: Set<puuid> }.
// A player absent from realDeath never permanently died that round.
// A player in `unresolved` has a death we could not verify either way —
// it is provisionally recorded as real, but flagged so callers can
// exclude the round rather than trust a guess.
//
// PRIMARY GATE, checked once per player before anything else: was a
// revive even mechanically possible for them this round? The only two
// revive mechanics in the game are Clove's self-revive and Sage's
// resurrection. If the player isn't Clove and no Sage exists anywhere on
// their team, no revive could have happened — their first death is the
// real one, full stop, with no snapshot walk, no elimination-result
// gate, and no risk of landing in `unresolved`. Measured: this closes
// the gate immediately for 79% of all death events (players who aren't
// Clove and have no Sage teammate) — the detailed walk below only ever
// runs for the remaining 21%.
//
// For the gate-open cases, primary signal is positional. Every kill
// event carries player_locations, a snapshot of everyone alive at that
// instant (~99.8% round coverage). A revived player is absent from
// snapshots taken while dead, then reappears in a later one — direct
// observation of aliveness over time, not inference from kill timing.
//
// This replaced an earlier kill-timing heuristic ("got a weapon kill
// >3s after dying, so they must have been revived"). Measured against
// positional data across 537 matches, that heuristic found 257 revives
// — of which positional confirmed 256 and refuted 1 — while missing
// 1,212 real revives it had no way to see. It also can't be repaired by
// tightening the weapon check: a confirmed case has a player dead for
// good, never reappearing in any snapshot, credited a normal Vandal
// kill 5.3s later. Riot's own client shows that kill at 0m distance, the
// same degenerate signature seen on environmental kills — the engine
// retroactively credits a death to whoever last damaged the victim,
// carrying their weapon and a meaningless position. No field on the
// kill record separates that from a genuine post-revive kill; only the
// positional snapshot does.
//
// Resolution order per death event (gate-open players only), earliest
// death first:
//
//   1. A snapshot exists after this death:
//        · player reappears in one  → this death was undone; keep
//          walking to their next death event
//        · player never reappears   → this death is real
//
//   2. No snapshot exists after this death (almost always the round's
//      final kill — 99.3% of such cases). Try to settle it anyway:
//        · Round ended by Elimination and this player's team lost → the
//          whole losing side must be dead, so no revive succeeded →
//          death is real. (Resolves the large majority of such cases.)
//        · Otherwise → UNRESOLVED. ~0.24% of all deaths, all in
//          Detonate/Defuse rounds where a revived player could
//          genuinely still be alive at round end.
//
// An earlier version treated an Ability-tagged death (weapon.type !==
// 'Weapon', e.g. "Not Dead Yet" — Clove's ultimate expiring) as always
// final, on the reasoning that it's an unambiguous marker of Clove's own
// revive attempt failing. That's true as far as it goes, but it doesn't
// mean the player is done — a Sage can resurrect a body regardless of
// what killed it, including a body that arrived at "Not Dead Yet" via a
// failed self-revive. Confirmed real case: a Clove's ult expires, and
// she reappears in a later positional snapshot — her Sage teammate
// revived her after her own attempt failed. So every death, ability-
// tagged or not, gets the same positional check; nothing is trusted as
// final just because of how it's labeled.
//
// Killer identity is deliberately unused. Gating on "a different killer
// than the previous death entry" was tried and failed on a real case:
// two normal-weapon deaths credited to two different enemies turned out
// to be one ordinary death, not a revive.
function computeRealDeaths(roundKills,roundData,players){
  const agentOf={},teamOf={};
  (players||[]).forEach(p=>{agentOf[p.puuid]=p.agent?.name;teamOf[p.puuid]=p.team_id?.toLowerCase();});

  const sageOnTeam={};
  (players||[]).forEach(p=>{if(p.agent?.name==='Sage')sageOnTeam[teamOf[p.puuid]]=true;});

  const deathsByVictim={};
  for(const k of roundKills){
    const victim=k.victim?.puuid;
    if(!victim)continue;
    (deathsByVictim[victim]??=[]).push(k.time_in_round_in_ms??0);
  }

  const realDeath={},unresolved=new Set();

  for(const puuid in deathsByVictim){
    const deaths=deathsByVictim[puuid].sort((a,b)=>a-b);

    // Primary gate — skip the entire walk when a revive was never on
    // the table for this player.
    const reviveEverPossible=agentOf[puuid]==='Clove'||sageOnTeam[teamOf[puuid]];
    if(!reviveEverPossible){
      realDeath[puuid]=deaths[0];
      continue;
    }

    // Gate open — build snapshots (only needed here, so built lazily)
    // and walk each death event in order. Kill events aren't the only
    // source: the plant and defuse events also carry a player_locations
    // snapshot (same data presentCount already uses in Step 1), and
    // those often land AFTER a round's last kill — exactly the case
    // that otherwise falls through to unresolved for lack of any later
    // snapshot to check.
    const snaps=[];
    for(const k of roundKills){
      const locs=k.player_locations||k.player_locations_on_kill;
      if(!locs?.length)continue;
      snaps.push({ms:k.time_in_round_in_ms??0,alive:new Set(locs.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean))});
    }
    if(roundData?.plant?.player_locations?.length)
      snaps.push({ms:roundData.plant.round_time_in_ms,alive:new Set(roundData.plant.player_locations.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean))});
    if(roundData?.defuse?.player_locations?.length)
      snaps.push({ms:roundData.defuse.round_time_in_ms,alive:new Set(roundData.defuse.player_locations.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean))});
    snaps.sort((a,b)=>a.ms-b.ms);

    const firstDeathOf={};
    for(const pu in deathsByVictim)firstDeathOf[pu]=Math.min(...deathsByVictim[pu]);

    for(const t of deaths){
      // 1 · Positional evidence available? Checked first for EVERY
      // death, including an Ability-tagged one ("Not Dead Yet" — Clove's
      // own revive failing). That death is not automatically final: a
      // Sage can resurrect a body regardless of what killed it, so a
      // Clove who fails her own revive attempt can still be brought back
      // by a teammate afterward. Confirmed real case: a Clove's ult
      // expires (Not Dead Yet), and she reappears in a later snapshot —
      // her Sage teammate revived her after her own revive attempt
      // failed. An earlier version trusted the ability tag as always
      // final and got this wrong.
      const later=snaps.filter(s=>s.ms>t);
      if(later.length){
        if(later.some(s=>s.alive.has(puuid)))continue;  // came back — death undone
        realDeath[puuid]=t;break;                        // stayed dead — real
      }

      // 2 · No positional evidence after this death — does the round
      // result settle it? (The Clove/Sage possibility check already
      // happened at the gate above, so only the elimination gate
      // remains here.)
      const sageAliveNow=(players||[]).some(p=>
        p.puuid!==puuid&&teamOf[p.puuid]===teamOf[puuid]&&agentOf[p.puuid]==='Sage'&&
        (firstDeathOf[p.puuid]===undefined||firstDeathOf[p.puuid]>t));
      const couldSelfRevive=agentOf[puuid]==='Clove';
      const teamWipedOut=roundData?.result==='Elimination'&&
        roundData.winning_team?.toLowerCase()!==teamOf[puuid];

      if((!couldSelfRevive&&!sageAliveNow)||teamWipedOut){
        realDeath[puuid]=t;break;                        // settled — real
      }

      // 2b · Clove-specific timing bound. Not Dead Yet requires a kill
      // or damaging assist within its resurrection timer — which would
      // itself be a kill event in roundKills — or the round ending
      // while that timer is still running, which lets her survive with
      // no kill needed at all. If NEITHER happened (no kill anywhere
      // later in the round, AND the round ran on long enough afterward
      // that the timer would have expired regardless of when she
      // activated), a successful revive isn't just unproven, it's ruled
      // out mechanically. Only applies when Clove's own ult is the sole
      // possible revive route — a live Sage teammate can revive at any
      // point up to round end with no timer of their own, so this bound
      // doesn't constrain that case.
      if(couldSelfRevive&&!sageAliveNow){
        const noMoreKillsThisRound=!roundKills.some(k=>(k.time_in_round_in_ms??0)>t);
        const roundEndEstimate=roundData?.plant?.round_time_in_ms!=null
          ?roundData.plant.round_time_in_ms+CLOVE_REVIVE_SPIKE_BOUNDARY_MS
          :CLOVE_REVIVE_ROUND_BOUNDARY_MS;
        if(noMoreKillsThisRound&&(roundEndEstimate-t)>MAX_CLOVE_SELF_REVIVE_WINDOW_MS){
          realDeath[puuid]=t;break;                        // timing rules out a revive — real
        }
      }

      unresolved.add(puuid);
      realDeath[puuid]=t;                                // provisional
      break;
    }
  }

  return{realDeath,unresolved};
}

/* ── Step 3 · Was there a clutch, and what kind? ──────────────────── */

// Walks the round's kills in order, tracking how many players are left
// standing on each side, and fires the moment the tracked player becomes
// their team's sole survivor with enemies still up.
//
// startMyAlive / startEnemyAlive must come from presentCount (Step 1),
// NOT hardcoded to 5. With a disconnected teammate the trigger condition
// (myAlive===1) needs one more death than will ever occur, so the whole
// situation stays invisible. Cross-checking Elimination rounds found 83
// clutch situations in a single dataset hidden by exactly this.
//
// Only real deaths (Step 2) decrement the counters, so a teammate who
// dies and gets revived still counts as standing — you were never truly
// the last one alive if someone came back up.
//
// Returns null when no clutch occurred, otherwise:
//   clutchType              how many enemies were alive at the trigger (1-5)
//   clutchStartMs           when the last teammate permanently died
//   killsAfterClutch        kills the player got from that point on
//   killTimes               timestamps of those kills
//   enemyAliveAfterLastKill enemies left standing after the final kill
//   deathMs                 when the player died, or null if they survived
function detectClutch(roundKills,realDeath,pTeam,puuid,startMyAlive=5,startEnemyAlive=5){
  let myAlive=startMyAlive,enemyAlive=startEnemyAlive,meAlive=true;
  let clutchType=null,clutchStartMs=null,deathMs=null;
  let killsAfterClutch=0,killTimes=[],enemyAliveAfterLastKill=null;

  for(const k of roundKills){
    const victim=k.victim?.puuid;
    const killMs=k.time_in_round_in_ms??0;

    if(victim&&realDeath[victim]===killMs){
      const victimTeam=k.victim?.team?.toLowerCase();
      if(victimTeam===pTeam)myAlive--;else if(victimTeam)enemyAlive--;

      // The tracked player's own death ends their round — stop here so
      // nothing after it counts toward them.
      if(victim===puuid){meAlive=false;deathMs=killMs;break;}

      // Last teammate down, player still up → clutch begins. Latched on
      // first trigger only; myAlive only ever counts down, so it can
      // pass through 1 exactly once per round.
      if(meAlive&&myAlive===1&&clutchType==null){
        clutchType=enemyAlive;
        clutchStartMs=killMs;
      }
    }

    // Kills the player lands once the clutch is underway. Self-kills
    // (walking into your own utility) don't count as progress.
    const isSelfKill=k.killer?.puuid===victim;
    if(clutchType!=null&&k.killer?.puuid===puuid&&!isSelfKill){
      killsAfterClutch++;
      enemyAliveAfterLastKill=enemyAlive;
      killTimes.push(killMs);
    }
  }

  // clutchType is the enemy count at trigger time. 0 means the enemy team
  // was already wiped, which isn't a clutch — the round was already won.
  if(clutchType==null||clutchType<1||clutchType>5)return null;
  return{clutchType,clutchStartMs,killsAfterClutch,killTimes,enemyAliveAfterLastKill,deathMs};
}

/* ── Step 4 · How did it end? ─────────────────────────────────────── */

// Turns the raw facts from Step 3 into Win / Loss / Save, following the
// game's own definitions of those terms rather than an inferred-intent
// model. Separate from detection.
//
//   WIN  — Riot: "a type of round outcome where the round was won by the
//          last player alive on the team."
//   SAVE — Riot: "when the opponent team's victory is guaranteed for a
//          round, and remaining teammates choose to run and hide in order
//          to avoid losing their weapons by dying to opponents." The
//          defining fact is surviving with the gun, NOT going killless:
//          an exit frag is by definition a kill taken while saving, so
//          picking one up on the way out is still a save.
//   LOSS — the round was lost and the weapon went with it, i.e. they died.
//
// So once the round is lost, the ONLY question is whether the player walked
// away with their gun. Nothing else is consulted:
//   - Kill count doesn't matter. An exit frag is by definition a kill taken
//     while saving, so picking one up on the way out is still a save.
//   - Wiping the remaining enemies and still losing (killed everyone, but
//     couldn't reach a planted spike in time) is still a save — they kept
//     the gun. Dying to that spike mid-defuse is what makes it a loss, and
//     that's already covered by the death check.
//   - Side and plant status are deliberately not consulted: weapon carryover
//     depends only on whether you personally survived, not the team-level
//     credit tier. An attacker who survives after a teammate's plant gets
//     defused actually nets more credits than the no-plant case while
//     keeping their gun just the same, so gating on plant status would call
//     the worse outcome a save and the better one not.
//
// There used to be a fourth outcome, EXIT ("got a kill but never really
// played for the round"), split out by an idle-ratio test over the
// player's available window. It's gone: it inferred intent from kill
// timing and never validated — the attack side was already being coerced
// back to loss because real-data checks across 277 attack-side situations
// fired exit on just 7, and tracing every one showed genuine continuous
// engagement rather than a deliberate "didn't try" pattern. Carving it
// out had also forced SAVE into an artificial "zero kills" shape, which
// is what's corrected here.
function classifyClutchOutcome({won,deathMs}){
  if(won)return 'win';
  return deathMs==null?'save':'loss';
}

// Which team attacked each round ('red'/'blue'), for the Clutches page.
// Only planting rounds say so directly (the planter's team). The other rounds
// follow the regular-time side pattern: one team attacks rounds 1–12, the
// other 13–24, then sides swap every overtime round. Which team starts on
// attack is not assumed: both orientations are tried against the plants, and
// the pattern is used only when at least one plant exists and every plant
// agrees with it. Otherwise only planting rounds get a side; the rest stay
// null (unknown) rather than guessed.
function roundAttackers(rounds){
  if(!Array.isArray(rounds))return[];
  const planted=rounds.map(r=>r?.plant?.player?.team?.toLowerCase()||null);
  const other=team=>team==='red'?'blue':'red';
  const pattern=first=>rounds.map((_,i)=>i<12?first:i<24?other(first):i%2===0?first:other(first));
  const fits=first=>{const sides=pattern(first);return planted.every((team,i)=>!team||team===sides[i]);};
  const anyPlant=planted.some(Boolean);
  const first=anyPlant?(fits('red')?'red':fits('blue')?'blue':null):null;
  const sides=first?pattern(first):[];
  return rounds.map((_,i)=>planted[i]||sides[i]||null);
}

/* ── PROCESS MATCH ──────────────────────────────────────── */
function ratedTeamRank(players,myTeamId,ownTeam){
  if(!myTeamId)return null;
  const ranks=players.filter(p=>p.team_id&&
    (ownTeam?p.team_id===myTeamId:p.team_id!==myTeamId)&&p._tier>=3).map(p=>p._tier);
  return ranks.length?ranks.reduce((sum,tier)=>sum+tier,0)/ranks.length:null;
}

function processMatch(m){
  const meta=m.metadata||{};
  const players=m.players||[];

  // Prefer PUUID lookup (works across name changes); fall back to name+tag
  const me=players.find(p=>PUUID?p.puuid===PUUID:
    p.name?.toLowerCase().trim()===PLAYER.toLowerCase().trim()&&p.tag?.toLowerCase().trim()===TAG.toLowerCase().trim()
  );
  const myTeamId=me?.team_id?.toLowerCase();

  // 1vX clutch detection — reconstructed from the raw kills array (each kill
  // event carries an explicit round index + killer/victim team), since the
  // API doesn't expose a pre-computed clutch flag anywhere (checked: neither
  // the round object nor its per-player round-stats entries have one).
  // Since myAlive only ever counts down through a round, it becomes 1 at most
  // once — whatever enemyAlive happens to be at that exact moment is the
  // clutch type (1v1 through 1v5).
  //
  // Every clutch situation resolves into exactly ONE of three outcomes:
  //   WIN  — team won the round (killed everyone / defused / both — the API
  //          doesn't let us cheaply distinguish which, so this stays one
  //          bucket for now).
  //   LOSS — the round was lost and the weapon went with it: they died.
  //   SAVE — the round was lost but they survived, keeping their gun for the
  //          next one. Kills taken on the way out are exit frags and don't
  //          stop it being a save.
  //
  // So once the round is lost the dividing line is simply "did you survive
  // with the gun" (SAVE) or not (LOSS). See classifyClutchOutcome for the
  // sourced game definitions, and for why the old fourth outcome, EXIT,
  // was dropped.
  const clutchAllByPuuid=new Map();
  // The searched player's counted clutches one by one, for the Clutches
  // page: null when the match has no round data, [] when it has no clutch.
  let myClutches=null;
  if(Array.isArray(m.kills)&&Array.isArray(m.rounds)){
    const attackers=roundAttackers(m.rounds);
    if(me)myClutches=[];
    const killsByRound=[];
    m.kills.forEach(k=>{(killsByRound[k.round]??=[]).push(k);});
    killsByRound.forEach(arr=>arr.sort((a,b)=>(a.time_in_round_in_ms??0)-(b.time_in_round_in_ms??0)));
    const realDeathByRound=killsByRound.map((rk,ri)=>computeRealDeaths(rk||[],m.rounds[ri],m.players));
    const redRoster=players.filter(p=>p.team_id?.toLowerCase()==='red');
    const blueRoster=players.filter(p=>p.team_id?.toLowerCase()==='blue');
    for(const p of players){
      const pTeam=p.team_id?.toLowerCase();
      const myRoster=pTeam==='red'?redRoster:blueRoster;
      const enemyRoster=pTeam==='red'?blueRoster:redRoster;
      const byType={1:{win:0,loss:0,save:0},2:{win:0,loss:0,save:0},3:{win:0,loss:0,save:0},4:{win:0,loss:0,save:0},5:{win:0,loss:0,save:0}};
      for(let r=0;r<m.rounds.length;r++){
        const roundData=m.rounds[r];
        const roundKills=killsByRound[r]||[];
        const{realDeath,unresolved}=realDeathByRound[r]||{realDeath:{},unresolved:new Set()};
        // Corrected starting alive-counts — NOT always 5/5. A teammate who
        // was AFK/disconnected this round doesn't count toward "how many
        // people have to die before you're the last one alive." See
        // presentCount's comment for why this has to use Riot's was_afk
        // flag rather than being inferred from the kill feed.
        const startMyAlive=presentCount(myRoster,roundData,roundKills);
        const startEnemyAlive=presentCount(enemyRoster,roundData,roundKills);
        const detected=detectClutch(roundKills,realDeath,pTeam,p.puuid,startMyAlive,startEnemyAlive);
        if(!detected)continue;
        const{clutchType,deathMs}=detected;
        const won=roundData.winning_team?.toLowerCase()===pTeam;
        const outcome=classifyClutchOutcome({won,deathMs});
        // A round carrying an unverifiable death is excluded from the
        // aggregate rather than guessed at — but only when the ambiguity
        // actually reaches this player's computed outcome. "Unresolved"
        // means we don't know whether a specific death stuck; it doesn't
        // mean every clutch situation in that round is untrustworthy.
        //
        // The test: re-run detection + classification a second time,
        // assuming every unresolved death in this round was actually a
        // successful revive (removed from realDeath entirely — the same
        // "what if they came back" the ambiguity is actually about), and
        // compare. If the type and outcome come out identical either way,
        // the ambiguous fact never touched this computation and it's safe
        // to count regardless of which way it really went. This subsumes
        // the simpler "win is always safe" case (a team-level win never
        // depends on kill timing) and catches more: e.g. a kill on the
        // ambiguous player landing after the round was already decided
        // falls outside the idle-ratio window either way, so it's inert
        // even for a loss outcome. It only stays sensitive — and
        // correctly excluded — when the ambiguous death is what triggered
        // the clutch itself (a teammate's death dropping the team to
        // last-alive): if they didn't really die, there was no clutch at
        // all, which is a different answer than any outcome computed
        // assuming there was. ~1.9% of rounds carry an unresolved death;
        // of the clutch situations that touch one, this test found about
        // three-quarters were unaffected by it. See computeRealDeaths
        // case 3 for how a death lands in unresolved in the first place.
        const isUnresolved=unresolved&&unresolved.size>0;
        let countThis=true;
        if(isUnresolved){
          const altRealDeath={...realDeath};
          for(const u of unresolved)delete altRealDeath[u];
          const detectedAlt=detectClutch(roundKills,altRealDeath,pTeam,p.puuid,startMyAlive,startEnemyAlive);
          const outcomeAlt=detectedAlt?classifyClutchOutcome({won,deathMs:detectedAlt.deathMs}):null;
          countThis=detectedAlt!=null&&detectedAlt.clutchType===clutchType&&outcomeAlt===outcome;
        }
        if(countThis)byType[clutchType][outcome]++;
        if(countThis&&me&&p.puuid===me.puuid){
          const attacker=attackers[r];
          const plantMs=roundData.plant?.round_time_in_ms;
          myClutches.push({
            round:r+1,type:clutchType,outcome,kills:detected.killsAfterClutch,
            side:attacker?(attacker===pTeam?'attack':'defense'):null,
            // Spike already down when the last teammate died.
            spikeDown:Number.isFinite(plantMs)&&Number.isFinite(detected.clutchStartMs)?plantMs<=detected.clutchStartMs:Number.isFinite(plantMs)?null:false,
          });
        }
      }
      if(Object.values(byType).some(t=>t.win||t.loss||t.save))clutchAllByPuuid.set(p.puuid,byType);
    }
  }

  let won=undefined, myR=undefined, opR=undefined;

  const teamsRaw=m.teams;
  if(Array.isArray(teamsRaw)){
    const myT=teamsRaw.find(t=>t.team_id?.toLowerCase()===myTeamId);
    const opT=teamsRaw.find(t=>t.team_id?.toLowerCase()!==myTeamId);
    myR=myT?.rounds?.won??myT?.rounds_won;
    opR=opT?.rounds?.won??opT?.rounds_won;
  } else if(teamsRaw&&typeof teamsRaw==='object'){
    const myT=myTeamId?teamsRaw[myTeamId]:null;
    const opTeamId=myTeamId==='red'?'blue':'red';
    const opT=teamsRaw[opTeamId]||null;
    if(typeof myT==='number'){
      myR=myT;
      opR=typeof opT==='number'?opT:null;
    } else if(myT&&typeof myT==='object'){
      myR=myT.rounds_won??myT.rounds?.won;
      opR=opT?.rounds_won??opT?.rounds?.won;
    }
  }

  // Always derive won from round counts — API's won field is unreliable for draws
  if(myR!=null&&opR!=null){
    if(myR>opR) won=true;
    else if(myR<opR) won=false;
    else won=undefined; // genuine draw (14-14, 15-15 overtime tie)
  }
  const mapName=meta.map?.name||meta.map||'Unknown';
  const serverName=[meta.cluster,meta.server].find(value=>typeof value==='string'&&value.trim())?.trim()||null;
  const durationMs=meta.game_length_in_ms??(meta.game_length!=null?meta.game_length*1000:null);
  const startedAtDate=meta.started_at
    ?new Date(meta.started_at)
    :meta.game_start
      ?new Date(meta.game_start*1000)
      :null;
  const startedAtMs=startedAtDate?startedAtDate.getTime():null;
  const startedAt=startedAtDate
    ?startedAtDate.toLocaleDateString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})
    :'';

  // Avg lobby rank — averaged over rated players only (Iron 1 = tier 3+).
  // Strict quality gate: if fewer than MIN_RATED of the lobby are rated, too much
  // of the lobby is unranked to trust the average, so drop it.
  const rankNums=players.map(p=>p.tier?.id??p.currenttier??0).filter(n=>n>=3);
  const ratedCount=rankNums.length;
  const rawAvg=ratedCount?rankNums.reduce((a,b)=>a+b,0)/ratedCount:null;
  const avgRank=ratedCount>=MIN_RATED?rawAvg:null;
  // A lobby with ZERO rated players (everyone Unranked — common right after a
  // reset) has rawAvg===null, which previously made this whole condition
  // false via the `rawAvg!=null&&` guard — incorrectly treating a fully
  // unranked lobby as if it wasn't low-rated at all, instead of flagging it
  // as unrated like every other under-MIN_RATED lobby.
  const lowRated=ratedCount<MIN_RATED;

  // Total rounds in the match — same for all players, use as fallback for rounds_played
  const totalRounds=(myR!=null&&opR!=null)?myR+opR:null;

  // My stats — v4 player object fields
  const myStats=me?extractStats(me,totalRounds,computeRoundStats(m,me.puuid)):null;

  // All players with tier + ACS
  const playersOut=players.map(p=>{
    const s=p.stats||p;
    const score=s.score??s.combat_score??0;
    const rp=s.rounds_played??s.roundsPlayed??totalRounds;
    const _acs=rp&&rp>0?score/rp:null;
    const _kills=s.kills??0;
    const _deaths=s.deaths??0;
    // KD: null means unknown (no data), not 0
    const _kd=_deaths>0?Math.round((_kills/_deaths)*100)/100:_kills>0?_kills:null;
    return{
      name:p.name,tag:p.tag,puuid:p.puuid,
      team_id:p.team_id?.toLowerCase(),
      party_id:p.party_id??null,
      agent:p.agent?.name??null,agentId:p.agent?.id??null,
      _tier:p.tier?.id??p.currenttier??0,
      _label:p.tier?.patched??p.currenttier_patched??rName(p.tier?.id??p.currenttier??0),
      _kills,
      _deaths,
      _kd,
      _acs,
      _performanceScore:Number.isFinite(p.performance?.score)?p.performance.score:null,
      _clutchAll:clutchAllByPuuid.get(p.puuid)||null,
    };
  });
  const avgTeamRank=ratedTeamRank(playersOut,myTeamId,true);
  const avgEnemyRank=ratedTeamRank(playersOut,myTeamId,false);

  const {mvpBasis,matchMvpPuuid,teamMvpPuuids,scorePlaces}=pickMvps(playersOut);
  const acsPlayers=playersOut.filter(p=>p._acs!=null);

  // ACS placement within the match (1 = highest ACS), assigned once here so
  // render-time code (the teammates list) can read it directly instead of
  // re-sorting every match's players on every re-render. acsPlayers holds
  // references into playersOut, so this mutates those objects.
  [...acsPlayers].sort((a,b)=>b._acs-a._acs).forEach((p,i)=>{p._acsPlace=i+1;});
  const mePlayerOut=playersOut.find(p=>PUUID?p.puuid===PUUID:
    `${p.name}#${p.tag}`.toLowerCase()===`${PLAYER}#${TAG}`.toLowerCase());
  const myClutchAll=mePlayerOut?._clutchAll??null; // {1:{win,loss,save},...,5:{...}} or null
  const matchId=meta.match_id??m.match_id??null;

  // Party size — count teammates sharing the same party_id as me
  const myPartyId=me?.party_id??null;
  const myTeamPlayers=players.filter(p=>p.team_id?.toLowerCase()===myTeamId);
  const partySize=myPartyId
    ? myTeamPlayers.filter(p=>p.party_id===myPartyId).length
    : 1;

  // Party RR penalty for THIS match, from metadata.party_rr_penaltys — a list
  // of {party_id, penalty} where penalty is the fraction (0.25 = 25% cut).
  // 0 when solo or unpenalized. Feeds the payout model's (1 − pen) term.
  const myPartyPenalty=(meta.party_rr_penaltys||[]).find(p=>p.party_id===myPartyId)?.penalty??0;

  // My tier and RR for this match — used to derive peak rank
  const myTierId=me?.tier?.id??me?.currenttier??0;
  const myRankKnown=Number.isInteger(me?.tier?.id??me?.currenttier);
  const myTierName=me?.tier?.patched??me?.currenttier_patched??rName(myTierId);
  // RR gained/lost this match, from /api/mmr-history (see loadAll's Step
  // 1.5) — the v4 match endpoint itself doesn't include per-match RR at
  // all. Only populated for whichever recent matches that fetch covered;
  // null for everything else, not just genuinely unrated games.
  const myRR=_rrChangeByMatchId[matchId]??null;
  const myRRDetails=_rrDetailsByMatchId[matchId]??null;
  // RR total going into this match — the x-axis position in RR movement.
  const myPreRR=_preRRByMatchId[matchId]??null;
  const myPreTierId=_preTierByMatchId[matchId]??null;
  const myPostRR=_postRRByMatchId[matchId]??null;
  const myPostTierId=_postTierByMatchId[matchId]??null;
  // RR restored alongside this result (for example after a cheater ban).
  const myRefundedRR=_refundedRRByMatchId[matchId]??0;
  // Whether Rank Shield absorbed this match's loss (badge didn't drop even
  // though myRR above still carries the normal negative payout).
  const myDerankProtected=_derankProtectedByMatchId[matchId]??false;
  return{mvpBasis,scorePlaces,mapName,serverName,startedAt,startedAtMs,durationMs:durationMs||myRRDetails?.duration||durationMs,won,myR,opR,avgRank,avgRankRaw:rawAvg,avgTeamRank,avgEnemyRank,lowRated,ratedCount,myStats,players:playersOut,myTierId,myRankKnown,myTierName,myRR,myRRDetails,myPreRR,myPreTierId,myPostRR,myPostTierId,myRefundedRR,myDerankProtected,myPartyPenalty,partySize,myPartyId,matchMvpPuuid,teamMvpPuuids,myClutchAll,myClutches,myAgent:me?.agent?.name??null,myAgentId:me?.agent?.id??null,matchId,seasonShort:meta.season?.short??null,seasonId:meta.season?.id??null};
}

// Per-round stats for one player, from the v4 rounds[] and kills[] arrays.
// Started from the ascend-companion scoreboard, then fitted to tracker.gg's
// scoreboards (docs/adr-kast.md). Every rule below was needed to reproduce
// tracker on all 330 player rows of 33 Nov 2026 matches, 23 of them scored
// blind first:
// - damage: only hits on enemies. Henrik's stats.damage.dealt is Riot's raw
//   total, which also counts friendly fire and self-damage, so ADR from it
//   came out higher than tracker.gg. Enemy-only ADR, with trackerFixed1's
//   rounding, matched every row checked (360, incl. 30 from Oct 2026).
// - KAST: rounds with a kill, an assist, survived, or traded.
//   · kill/assist: no assist credit on a self-kill (an enemy's own spike
//     death lists assisters).
//   · survived: present in the round and alive at its end. A death undone
//     by a revive (Sage, Clove; computeRealDeaths) or caused by the spike
//     explosion (weapon type Bomb) doesn't count; a fall or a failed Clove
//     revive does. Presence comes from presentCount's position snapshots,
//     not Riot's was_afk, which lags a round.
//   · traded: their killer died to one of their teammates after them, at
//     most 3 s later, and they were that killer's last victim before the
//     trade kill (a trade credits only the last teammate the killer took;
//     same-millisecond kills keep the kill list's order). A kill in the
//     same millisecond as the death doesn't count.
//   Tracker computed trades differently for matches up to 27 Oct 2026
//   (killer died within 5 s, any victim, any cause) and kept those stored
//   values. We use the current rule everywhere, so act totals spanning that
//   date run below tracker's (docs/adr-kast.md).
// Returns null when the payload has no round data (older/compact shapes),
// so callers fall back to the summary totals.
const KAST_TRADE_WINDOW_MS=3000;
function computeRoundStats(m,puuid){
  if(!puuid||!Array.isArray(m?.rounds)||!m.rounds.length)return null;
  const team={};
  for(const p of m.players||[])if(p?.puuid)team[p.puuid]=String(p.team_id??'').toLowerCase();
  const myTeam=team[puuid];
  if(!myTeam)return null;
  // Damage dealt to enemies, and (22 Nov 2026, for the damage delta) damage
  // taken from enemies: enemy players' damage events whose receiver is you.
  // A live payload's taken total matched stats.damage.received exactly.
  let enemyDamage=0,hasDamage=false,enemyDamageTaken=0,hasTaken=false;
  for(const r of m.rounds){
    for(const s of r?.stats||[]){
      if(!Array.isArray(s?.damage_events))continue;
      const from=s?.player?.puuid;
      if(from===puuid){
        hasDamage=true;
        for(const d of s.damage_events){
          const to=d?.player?.puuid??d?.receiver?.puuid??d?.receiver;
          if(!to||team[to]===myTeam)continue;
          enemyDamage+=d.damage??0;
        }
      }else if(from&&team[from]&&team[from]!==myTeam){
        hasTaken=true;
        for(const d of s.damage_events){
          const to=d?.player?.puuid??d?.receiver?.puuid??d?.receiver;
          if(to===puuid)enemyDamageTaken+=d.damage??0;
        }
      }
    }
  }
  let kastRounds=null;
  if(Array.isArray(m.kills)){
    const byRound=new Map();
    for(const k of m.kills){
      if(!Number.isInteger(k?.round))continue;
      if(!byRound.has(k.round))byRound.set(k.round,[]);
      byRound.get(k.round).push(k);
    }
    kastRounds=0;
    for(let n=0;n<m.rounds.length;n++){
      const ks=(byRound.get(n)||[]).slice().sort((a,b)=>(a.time_in_round_in_ms??0)-(b.time_in_round_in_ms??0));
      let died=false,credited=false;
      // ks keeps the kill list's order for kills in the same millisecond
      // (Array.prototype.sort is stable); tracker's trade rule depends on it.
      for(let i=0;i<ks.length;i++){
        const k=ks[i];
        const killer=k.killer?.puuid,victim=k.victim?.puuid,t0=k.time_in_round_in_ms??0;
        if(killer===puuid&&victim!==puuid)credited=true;
        // No assist credit on a self-kill (an enemy's own spike death).
        if(killer!==victim&&(k.assistants||[]).some(a=>a?.puuid===puuid))credited=true;
        // A spike explosion (weapon type Bomb) isn't a death for KAST; a
        // fall or a failed Clove revive ("Not Dead Yet") is.
        if(victim===puuid&&k.weapon?.type!=='Bomb')died=true;
        if(victim===puuid&&killer&&killer!==puuid){
          const trade=ks.find(x=>x.victim?.puuid===killer&&(x.time_in_round_in_ms??0)>t0&&(x.time_in_round_in_ms??0)-t0<=KAST_TRADE_WINDOW_MS&&team[x.killer?.puuid]===myTeam);
          const tTrade=trade?.time_in_round_in_ms??0;
          // The trade goes to the killer's last victim strictly before the
          // trade kill: a teammate the killer took later in the list (same
          // millisecond included) takes it, one killed in the trade's own
          // millisecond doesn't.
          const killedAgain=trade&&ks.some((y,j)=>j>i&&y.killer?.puuid===killer&&team[y.victim?.puuid]===myTeam&&(y.time_in_round_in_ms??0)<tTrade);
          if(trade&&!killedAgain)credited=true;
        }
      }
      // Revived and alive at round end counts as survived.
      if(died&&!credited&&computeRealDeaths(ks,m.rounds[n],m.players).realDeath[puuid]===undefined)died=false;
      // A player absent from the round (disconnected or left) didn't
      // survive it. Presence comes from the position snapshots, as for
      // clutches: Riot's was_afk lags a round (set while the player is
      // still on the field, missing once they're gone) and doesn't match.
      const absent=presentCount([{puuid}],m.rounds[n]||{},ks)===0;
      if(credited||(!died&&!absent))kastRounds++;
    }
  }
  return{enemyDamage:hasDamage?enemyDamage:null,enemyDamageTaken:hasTaken?enemyDamageTaken:null,kastRounds,rounds:m.rounds.length};
}

// Display rounding that reproduces tracker.gg's numbers (360 ADR and 330
// KAST rows, see docs/adr-kast.md):
// - ADR goes to 2 decimals first, then 1: 135.952 → 135.95 → "135.9"
//   (the double 135.95 sits just below the half).
// - A KAST percentage exactly on .5 rounds to even: 15/24 = 62.5% → 62.
function trackerFixed1(v){return(Math.round(v*100)/100).toFixed(1);}
function roundHalfEven(v){
  const f=Math.floor(v);
  return Math.abs(v-f-0.5)<1e-9?(f%2===0?f:f+1):Math.round(v);
}

function extractStats(p,fallbackRounds=null,roundStats=null){
  // v4 stats nested under p.stats, v3 flat
  const s=p.stats||p;
  // Use null as sentinel so we can detect missing data vs a genuine 0
  const kills=s.kills??null;
  const deaths=s.deaths??null;
  // If both kills and deaths are absent, we have no real stats — signal the caller
  if(kills===null&&deaths===null)return null;
  const k=kills??0;
  const d=deaths??0;
  const assists=s.assists??0;
  const score=s.score??s.combat_score??0;
  const rounds_played=s.rounds_played??s.roundsPlayed??fallbackRounds;
  // Current v4 responses nest this as stats.damage.dealt (confirmed via a
  // live match payload — .made/.damage_made don't exist in that shape and
  // silently left dmg/adr null). Kept as fallbacks in case older cached
  // responses or a future API version use one of those instead.
  // Enemy-only damage from the round data wins when present (see
  // computeRoundStats); the summary total includes friendly fire.
  const dmg=roundStats?.enemyDamage??s.damage?.dealt??p.damage_made??s.damage?.made??s.damage_made??null;
  const hs=p.headshots??s.headshots??s.shots?.head??null;
  const bs=p.bodyshots??s.bodyshots??s.shots?.body??null;
  const ls=p.legshots??s.legshots??s.shots?.leg??null;
  const totalShots=(hs??0)+(bs??0)+(ls??0);
  const hsPct=totalShots>0?Math.round((hs??0)/totalShots*100):null;

  // ACS = combat score / rounds; if no rounds_played we can't compute it
  const acs=rounds_played&&rounds_played>0?score/rounds_played:null;
  // KD: null means unknown (no data), not 0
  const kd=d>0?Math.round((k/d)*100)/100:k>0?k:null;
  const adr=rounds_played&&rounds_played>0&&dmg!==null?Math.round(dmg/rounds_played):null;
  // Damage delta per round: damage dealt minus damage taken, both from the
  // round data when present, else the summary totals (damage.received).
  const dmgTaken=roundStats?.enemyDamageTaken??s.damage?.received??null;
  const ddDelta=rounds_played&&rounds_played>0&&dmg!==null&&dmgTaken!==null?Math.round((dmg-dmgTaken)/rounds_played):null;

  const kastRounds=roundStats?.kastRounds??null;
  const kastTotalRounds=kastRounds!=null&&roundStats.rounds>0?roundStats.rounds:null;
  const kast=kastTotalRounds?roundHalfEven(kastRounds/kastTotalRounds*100):null;

  const performanceScore=Number.isFinite(p.performance?.score)?p.performance.score:null;
  return{kills:k,deaths:d,assists,score,rounds_played:rounds_played??null,kd,acs,performanceScore,adr,hsPct,dmg,dmgTaken,ddDelta,kast,kastRounds:kastTotalRounds?kastRounds:null,kastTotalRounds};
}

// ─────────────────────────────────────────────────────────────────────────
// Hardcoded fallback act metadata — a static snapshot of the exact same shape
// loadSeasonDates() builds live from valorant-api.com/v1/seasons (uuid →
// {start, resetAct}), generated directly from a real pull of that endpoint.
// Past acts never change their start date, so this stays accurate
// indefinitely; it just won't know about an act added after this snapshot —
// that's fine, since live data is always tried first and takes over again
// the instant valorant-api.com is reachable.
const HARDCODED_ACT_META={
  '3f61c772-4560-cd3f-5d3f-a7ab5abda6b3':{start:1590994800000,resetAct:true}, // Episode 1 Act I
  '0530b9c4-4980-f2ee-df5d-09864cd00542':{start:1596499200000,resetAct:false}, // Episode 1 Act II
  '46ea6166-4573-1128-9cea-60a15640059b':{start:1602547200000,resetAct:false}, // Episode 1 Act III
  '97b6e739-44cc-ffa7-49ad-398ba502ceb0':{start:1610409600000,resetAct:true}, // Episode 2 Act I
  'ab57ef51-4e59-da91-cc8d-51a5a2b9b8ff':{start:1614643200000,resetAct:false}, // Episode 2 Act II
  '52e9749a-429b-7060-99fe-4595426a0cf7':{start:1619481600000,resetAct:false}, // Episode 2 Act III
  '2a27e5d2-4d30-c9e2-b15a-93b8909a442c':{start:1624320000000,resetAct:true}, // Episode 3 Act I
  '4cb622e1-4244-6da3-7276-8daaf1c01be2':{start:1631059200000,resetAct:false}, // Episode 3 Act II
  'a16955a5-4ad0-f761-5e9e-389df1c892fb':{start:1635811200000,resetAct:false}, // Episode 3 Act III
  '573f53ac-41a5-3a7d-d9ce-d6a6298e5704':{start:1641859200000,resetAct:true}, // Episode 4 Act I
  'd929bc38-4ab6-7da4-94f0-ee84f8ac141e':{start:1646092800000,resetAct:false}, // Episode 4 Act II
  '3e47230a-463c-a301-eb7d-67bb60357d4f':{start:1650931200000,resetAct:false}, // Episode 4 Act III
  '67e373c7-48f7-b422-641b-079ace30b427':{start:1655769600000,resetAct:true}, // Episode 5 Act I
  '7a85de9a-4032-61a9-61d8-f4aa2b4a84b6':{start:1661212800000,resetAct:false}, // Episode 5 Act II
  'aca29595-40e4-01f5-3f35-b1b3d304c96e':{start:1666051200000,resetAct:false}, // Episode 5 Act III
  '9c91a445-4f78-1baa-a3ea-8f8aadf4914d':{start:1673308800000,resetAct:true}, // Episode 6 Act I
  '34093c29-4306-43de-452f-3f944bde22be':{start:1678147200000,resetAct:false}, // Episode 6 Act II
  '2de5423b-4aad-02ad-8d9b-c0a931958861':{start:1682380800000,resetAct:false}, // Episode 6 Act III
  '0981a882-4e7d-371a-70c4-c3b4f46c504a':{start:1687824000000,resetAct:true}, // Episode 7 Act I
  '03dfd004-45d4-ebfd-ab0a-948ce780dac4':{start:1693267200000,resetAct:false}, // Episode 7 Act II
  '4401f9fd-4170-2e4c-4bc3-f3b4d7d150d1':{start:1698710400000,resetAct:false}, // Episode 7 Act III
  'ec876e6c-43e8-fa63-ffc1-2e8d4db25525':{start:1704758400000,resetAct:true}, // Episode 8 Act I
  '22d10d66-4d2a-a340-6c54-408c7bd53807':{start:1709596800000,resetAct:false}, // Episode 8 Act II
  '4539cac3-47ae-90e5-3d01-b3812ca3274e':{start:1714435200000,resetAct:false}, // Episode 8 Act III
  '52ca6698-41c1-e7de-4008-8994d2221209':{start:1719360000000,resetAct:true}, // Episode 9 Act I
  '292f58db-4c17-89a7-b1c0-ba988f0e9d98':{start:1724803200000,resetAct:false}, // Episode 9 Act II
  'dcde7346-4085-de4f-c463-2489ed47983b':{start:1729641600000,resetAct:false}, // Episode 9 Act III
  '476b0893-4c2e-abd6-c5fe-708facff0772':{start:1736294400000,resetAct:true}, // V25 Act I
  '16118998-4705-5813-86dd-0292a2439d90':{start:1741132800000,resetAct:false}, // V25 Act II
  'aef237a0-494d-3a14-a1c8-ec8de84e309c':{start:1745971200000,resetAct:false}, // V25 Act III
  'ac12e9b3-47e6-9599-8fa1-0bb473e5efc7':{start:1750809600000,resetAct:true}, // V25 Act IV
  '5adc33fa-4f30-2899-f131-6fba64c5dd3a':{start:1755648000000,resetAct:false}, // V25 Act V
  '4c4b8cff-43eb-13d3-8f14-96b783c90cd2':{start:1760486400000,resetAct:false}, // V25 Act VI
  '3ea2b318-423b-cf86-25da-7cbb0eefbe2d':{start:1767744000000,resetAct:true}, // V26 Act I
  '9d85c932-4820-c060-09c3-668636d4df1b':{start:1773792000000,resetAct:false}, // V26 Act II
  'ce2783e8-44fc-dd48-3da3-33b5ba6c4a22':{start:1777420800000,resetAct:false}, // V26 Act III
  '4f0864e2-40af-28a4-de2c-0e9e64e75f23':{start:1782259200000,resetAct:true}, // V26 Act IV
  '8102cd81-43a0-d0d7-bd59-47b8fe9bed1b':{start:1787097600000,resetAct:false}, // V26 Act V
  'd816f426-48ea-f052-117f-9697a155b319':{start:1791936000000,resetAct:false}, // V26 Act VI
};

// Act metadata from valorant-api.com (keyless, CORS-open, so the browser can call
// it directly regardless of our own API proxy). Maps act UUID → {start, resetAct}
// where resetAct means it's the first act of its episode/season container — i.e.
// the full placement reset (which happens twice a year). Best-effort: stays null
// on failure, and getActInfo() then falls back to HARDCODED_ACT_META.
let _actMeta=null,_seasonDatesPromise=null;
function loadSeasonDates(){
  if(_seasonDatesPromise)return _seasonDatesPromise;
  _seasonDatesPromise=fetch('https://valorant-api.com/v1/seasons',{signal:AbortSignal.timeout(10000)})
    .then(r=>r.ok?r.json():Promise.reject(r.status))
    .then(j=>{
      // Acts carry a parentUuid (their episode/season); episodes/seasons don't.
      const acts=(j.data||[]).filter(s=>s.uuid&&s.startTime&&s.parentUuid)
        .map(s=>({uuid:s.uuid.toLowerCase(),parent:s.parentUuid,t:Date.parse(s.startTime)}))
        .filter(s=>!isNaN(s.t));
      // The earliest-starting act under each parent is that season's reset act.
      const firstByParent={};
      acts.forEach(s=>{
        const f=firstByParent[s.parent];
        if(!f||s.t<f.t)firstByParent[s.parent]=s;
      });
      const resetUuids=new Set(Object.values(firstByParent).map(s=>s.uuid));
      const meta={};
      acts.forEach(s=>{meta[s.uuid]={start:s.t,resetAct:resetUuids.has(s.uuid)};});
      _actMeta=meta;
      return meta;
    })
    .catch(()=>{_actMeta=null;return null;});
  return _seasonDatesPromise;
}

// Looks up a match's act start info by whichever source is available, in
// order of trust: live valorant-api data (by UUID) → hardcoded snapshot (also
// by UUID) → null (caller falls back further to the history heuristic).
function getActInfo(m){
  if(!m.seasonId)return null;
  const id=m.seasonId.toLowerCase();
  return (_actMeta&&_actMeta[id])||HARDCODED_ACT_META[id]||null;
}

// Same lookup, but by season UUID directly (used where we have TARGET_SEASON
// rather than a match object on hand).
function getActInfoByUuid(uuid){
  if(!uuid)return null;
  const id=uuid.toLowerCase();
  return (_actMeta&&_actMeta[id])||HARDCODED_ACT_META[id]||null;
}

// Twice a year Valorant does a "total" rank reset — everyone recalibrates through
// five placement games, so ranks (and the avg-lobby-rank figure) run low for about
// a week. That reset lands on the first act of each episode/season container (e.g.
// Episode 9 Act I, or V26 Act IV, which opens the year's second half). We flag
// matches in the first RESET_GRACE_DAYS of such an act (m.postReset=true) so they
// can be greyed out in the history and left out of stats by default (a toggle can
// re-include them). Act start dates + reset status come from getActInfo(), which
// tries live valorant-api data first, then the hardcoded snapshot. A match whose
// act isn't in either source (e.g. a brand-new act launched after this snapshot,
// while valorant-api is also unreachable) simply isn't tagged as post-reset.
const RESET_GRACE_DAYS=7;
function tagPostResetPlacements(matches,days=RESET_GRACE_DAYS){
  const WINDOW=days*86400000;
  matches.forEach(m=>{
    const info=getActInfo(m);
    m.postReset=!!(info&&info.resetAct&&m.startedAtMs!=null&&m.startedAtMs<info.start+WINDOW);
  });
  return matches;
}

// The OTHER placement matches. Acts 1 and 4 open an episode with five
// placement games (tagPostResetPlacements, above), but Riot also requires a
// single placement match to open Acts 2/3/5/6: "For Acts 2 and 3 within an
// Episode, if you already completed your initial 5 placements, you only need
// to play 1 placement match to update your rank" — and for Immortal+ that
// match runs on RR that was just cut by 90%. Its RR swing is set by
// placement rules, not by the ordinary RR model, so the RR-stats card
// has to drop it (m.actPlacement) the same way it drops the five.
//
// A match only qualifies if we can PROVE it's that act's first: we must also
// hold a match from before the act started, which means pagination actually
// spans the boundary. Without that guard the oldest match on a truncated
// page would be mislabelled a placement in every act we happen to cut off in
// the middle of.
function tagActPlacements(matches){
  const byAct=new Map();
  let oldestMs=Infinity;
  matches.forEach(m=>{
    if(m.startedAtMs==null)return;
    if(m.startedAtMs<oldestMs)oldestMs=m.startedAtMs;
    const info=getActInfo(m);
    if(!info||info.resetAct)return;   // episode openers are the 5-game reset
    const cur=byAct.get(info.start);
    if(!cur||m.startedAtMs<cur.startedAtMs)byAct.set(info.start,m);
  });
  matches.forEach(m=>{m.actPlacement=false;});
  byAct.forEach((m,actStart)=>{
    if(oldestMs<actStart)m.actPlacement=true;
  });
  return matches;
}

/* ── LOAD ─────────────────────────────────────────────────── */
// Coverage and page evidence live in D1; there is no browser cache or expiry.
async function beginServerActScan(puuid,season,opts={}){
  if(!puuid||!season)return null;
  const url=`${API_BASE}/match-coverage/${REGION}/${PLATFORM}/${encodeURIComponent(puuid)}/${encodeURIComponent(season)}`;
  try{
    const {r,j}=await fetchApiJson(url,{...opts,cache:'no-store'});
    if(!r.ok||!PUUID_RE.test(j?.data?.scanId||''))return null;
    const coverage=j.data.coverage;
    return{url,scanId:j.data.scanId,coverage:coverage&&Array.isArray(coverage.matchIds)&&Array.isArray(coverage.liveIds)
      ?{matchIds:coverage.matchIds,liveIds:new Set(coverage.liveIds)}:null};
  }catch{return null;} // A missing migration must never prevent normal fetching.
}
async function finishServerActScan(scan,opts={}){
  if(!scan)return;
  try{
    await fetchApiJson(scan.url,{...opts,cache:'no-store',method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({scanId:scan.scanId})});
  }catch{/* Keep matches available even if coverage could not be certified. */}
}
function isKnownHistoryPage(rows,coverage){
  return !!(coverage&&rows.length&&rows.every(m=>coverage.liveIds.has(m.metadata?.match_id||m.match_id)));
}
const MAX_HISTORY_OFFSET=5000;
// MMR season totals belong to the account's current region and can reset on a
// transfer. The match list is keyed to the player across regions, so seek to
// the selected act by its calendar boundary instead of using those totals as
// either a skip offset or a stopping condition.
async function findHistoryStartForAct(nextActStart,generation,onRateLimit,opts={}){
  if(!Number.isFinite(nextActStart)||nextActStart>Date.now())return 0;
  let lo=0,hi=MAX_HISTORY_OFFSET;
  while(lo<hi){
    if(generation!==_analysisGen)return 0;
    const mid=Math.floor((lo+hi)/2);
    setStatus('Finding this act’s matches…',true);
    const url=`${API_BASE}/history/${REGION}/${PLATFORM}/${encodeURIComponent(PLAYER)}/${TAG}?mode=competitive&size=1&start=${mid}`;
    const {j}=await apiGet(url,{...opts,onRateLimit});
    if(generation!==_analysisGen)return 0;
    const match=j.data?.[0];
    const started=match?Date.parse(match.metadata?.started_at):null;
    if(match&&!Number.isFinite(started))return 0; // scan from newest if dates cannot be trusted
    if(match&&started>=nextActStart)lo=mid+1;
    else hi=mid;
  }
  return Math.max(0,lo-BATCH); // overlap one page at the act boundary
}

// Henrik's stored-matches endpoint is a compact archive, not a v4 match
// payload. Use its 100-record pages to locate missing IDs for an older act,
// then fetch full details only for those IDs so every existing stat keeps its
// normal full-match meaning. This is best-effort: an incomplete archive must
// never discard the live matches already found.
async function recoverStoredSeasonMatches(collected,alreadySaved,myGen,onRateLimit,opts={}){
  if(!PUUID||!TARGET_SEASON)return false;
  const known=new Set([...alreadySaved,...collected.map(m=>m.metadata?.match_id||m.match_id).filter(Boolean)]);
  const missing=[];
  const wanted=TARGET_SEASON.toLowerCase();
  const region=encodeURIComponent(REGION);
  const puuid=encodeURIComponent(PUUID);
  let complete=false;
  let storedSawTarget=false;
  const scanQuery=opts.scanId?`&scan=${encodeURIComponent(opts.scanId)}`:'';
  for(let page=1;page<=100;page++){
    if(myGen!==_analysisGen)return false;
    setStatus('Checking older games…',true);
    let payload;
    try{
      ({j:payload}=await apiGet(`${API_BASE}/stored-matches/${region}/${puuid}?page=${page}${scanQuery}`,{...opts,onRateLimit}));
    }catch(_){break;} // no stored archive, or temporarily unavailable
    if(myGen!==_analysisGen)return false;
    if(!Array.isArray(payload?.data))break;
    const rows=Array.isArray(payload?.data)?payload.data:[];
    if(!rows.length){complete=true;break;}
    if(rows.some(row=>row?.meta?.season?.id?.toLowerCase()===wanted))storedSawTarget=true;
    rows.forEach(row=>{
      const id=row?.meta?.id;
      if(!id||row?.meta?.season?.id?.toLowerCase()!==wanted||
         row?.stats?.puuid?.toLowerCase()!==PUUID.toLowerCase()||known.has(id))return;
      known.add(id);
      missing.push({id,region:row.meta.region||REGION});
    });
    const actStart=getActInfoByUuid(TARGET_SEASON)?.start;
    if((!opts.scanId||storedSawTarget)&&Number.isFinite(actStart)&&rows.every(row=>{
      const started=Date.parse(row?.meta?.started_at);
      return Number.isFinite(started)&&started<actStart;
    })){complete=true;break;}
    if(payload?.results?.after===0){complete=true;break;}
  }
  let failures=0;
  for(let i=0;i<missing.length;i++){
    if(myGen!==_analysisGen)return false;
    setStatus(`Adding older games (${i+1} of ${missing.length})…`,true);
    try{
      const {id,region:matchRegion}=missing[i];
      const {j}=await apiGet(`${API_BASE}/match-detail/${encodeURIComponent(matchRegion)}/${encodeURIComponent(id)}${scanQuery?`?${scanQuery.slice(1)}`:''}`,{...opts,onRateLimit});
      if(myGen!==_analysisGen)return false;
      const match=j?.data||j;
      if(match?.metadata?.match_id!==id||!isSeason(match)||
         !match?.players?.some(p=>p.puuid?.toLowerCase()===PUUID.toLowerCase())){complete=false;continue;}
      collected.push(match);
      failures=0;
    }catch(e){
      complete=false;
      // A missing old detail is specific to that ID. Other repeated failures
      // suggest the endpoint is unavailable, so stop instead of issuing
      // hundreds of requests that cannot succeed.
      if(/^API 404\b/.test(e?.message||''))continue;
      if(++failures>=3)break;
    }
  }
  return complete;
}


async function loadAll(prefetchSnapshot=null,pendingRoutePush=false){
  const myGen=++_analysisGen; // supersede any in-flight analysis
  _analysisController?.abort();
  _analysisController=new AbortController();
  const requestOpts={signal:_analysisController.signal,pool:createRequestPool(2)};
  loadSeasonDates(); // fire off act-start dates now; awaited before we filter matches
  setProgress(null); // the match API supplies no reliable total
  const rawMatches=new Map(),processedMatches=new Map();
  const performanceRefreshNeeded=new Set();
  const publishMatches=(rows,reprocess=false)=>{
    let added=false;
    rows.forEach(raw=>{
      const id=raw?.metadata?.match_id||raw?.match_id;
      if(!id)return;
      const saved=rawMatches.get(id);
      if(saved){
        // Archived matches can predate Performance Score. Enrich them from
        // fresh v4 rows without replacing already reported scores or stats.
        const reported=new Map((raw.players||[]).filter(p=>p.puuid&&Object.hasOwn(p,'performance'))
          .map(p=>[p.puuid,p.performance]));
        let enriched=false;
        const players=(saved.players||[]).map(p=>{
          if(Number.isFinite(p.performance?.score)||!reported.has(p.puuid))return p;
          if(Object.hasOwn(p,'performance')&&!Number.isFinite(reported.get(p.puuid)?.score))return p;
          enriched=true;
          return{...p,performance:reported.get(p.puuid)};
        });
        if(!enriched)return;
        raw={...saved,players,_performanceRefreshNeeded:players.some(p=>!Object.hasOwn(p,'performance'))};
        processedMatches.delete(id);
      }
      rawMatches.set(id,raw);
      if(raw._performanceRefreshNeeded===true)performanceRefreshNeeded.add(id);
      else if(raw.players?.length&&raw.players.every(p=>Object.hasOwn(p,'performance')))performanceRefreshNeeded.delete(id);
      added=true;
    });
    if(!added&&!reprocess)return;
    if(reprocess)processedMatches.clear();
    rawMatches.forEach((raw,id)=>{
      if(!processedMatches.has(id))processedMatches.set(id,processMatch(raw));
    });
    allMatches=tagActPlacements(tagPostResetPlacements([...processedMatches.values()]
      .sort((a,b)=>(b.startedAtMs||0)-(a.startedAtMs||0))));
    setSeasonMatchCount(TARGET_SEASON,allMatches.length,'loading');
    renderAll(true);
    void refreshTeammateNames(lookupTeammateRows(allMatches));
    setStatus(`Showing ${allMatches.length} games. Checking for more matches…`,true);
  };
  const onRateLimit=seconds=>{
    if(myGen===_analysisGen&&allMatches.length)
      return `Showing ${allMatches.length} games. API rate limit reached; loading resumes automatically in about ${Math.ceil(seconds/5)*5}s.`;
  };
  try{
    // Step 0: resolve PUUID so we can find the player in historical matches
    // regardless of name changes over time
    setStatus('Resolving player…',true);
    // A PUUID search has no name/tag yet, so this lookup is the only way to
    // get them — unlike a name#tag search, it can't be skipped past on error.
    const byPuuid=!PLAYER&&!!PUUID;
    let resolvedAccount=false;
    try{
      let acctJ;
      if(prefetchSnapshot?.acctJ){
        acctJ=prefetchSnapshot.acctJ;
      }else{
        const acctUrl=accountUrlFor({puuid:byPuuid?PUUID:'',name:PLAYER,tag:TAG});
        ({j:acctJ}=await apiGet(acctUrl,requestOpts));
      }
      if(myGen!==_analysisGen)return;
      const acctData=acctJ.data||acctJ;
      PUUID=acctData.puuid||PUUID;
      resolvedAccount=!!(acctData.name&&acctData.tag);
      // Use API-returned name/tag for correct capitalisation
      if(acctData.name) PLAYER=acctData.name;
      if(acctData.tag)  TAG=acctData.tag;
      if(acctData.region){
        REGION=acctData.region.toLowerCase();
      }
    }catch(e){
      if(myGen!==_analysisGen)return;
      // If account lookup fails, fall back to name+tag matching — except for
      // a PUUID search, which has nothing to fall back to.
      if(byPuuid)throw e;
    }
    if(byPuuid&&(!PLAYER||!TAG))throw new Error('No account found for that PUUID');
    if(myGen!==_analysisGen)return;
    // Account-level history loads independently of match/act availability.
    if(PUUID)void loadNameHistory(PUUID,myGen,requestOpts);
    // Autocorrect the input's casing now that it's resolved (corrected casing
    // on success, the originally-typed value stays as a fallback on failure).
    searchText=`${PLAYER}#${TAG}`;
    if(resolvedAccount)trackerHref=`https://tracker.gg/valorant/profile/riot/${encodeURIComponent(`${PLAYER}#${TAG}`)}/overview`;
    emit();
    writePlayerRoute(PLAYER,TAG,TARGET_SEASON,pendingRoutePush?'push':'replace');
    const savedCountsPromise=prefetchSnapshot?.savedCounts
      ?Promise.resolve(prefetchSnapshot.savedCounts)
      :readSavedMatchCounts(PUUID,requestOpts);

    // Saved pages publish immediately while independent Henrik requests load.
    let archivedMatches=[],archiveActId='',archivePromise=null;
    let serverScan=null,verifiedScan=null,archiveComplete=false;
    const previewActId=TARGET_SEASON||currentActId();
    const startArchive=actId=>{
      archiveActId=actId.toLowerCase();
      archiveComplete=false;
      return readServerMatchArchive(PUUID,actId,myGen,
        ()=>!TARGET_SEASON||TARGET_SEASON.toLowerCase()===actId.toLowerCase(),
        {...requestOpts,onComplete:()=>{if(myGen===_analysisGen&&archiveActId===actId.toLowerCase())archiveComplete=true;},onPage:page=>{
          if(myGen!==_analysisGen)return;
          if(!TARGET_SEASON)TARGET_SEASON=actId;
          publishMatches(page);
        }}).catch(()=>[]);
    };
    if(PUUID&&previewActId){
      archivePromise=startArchive(previewActId);
    }

    // Per-match RR gained/lost, keyed by match_id so processMatch
    // can attach it below. The proxy persists this server-side (see
    // mergeRRHistory), so it can cover more than upstream's live ~20-game
    // window — but still isn't guaranteed to cover every match. Best-effort
    // and runs alongside rank, archive and match fetching.
    const rrPromise=(async()=>{
      try{
        const rrUrl=`${API_BASE}/mmr-history/${REGION}/${PLATFORM}/${encodeURIComponent(PLAYER)}/${TAG}`;
        const{j:rrJ}=await apiGet(rrUrl,{...requestOpts,quiet:true});
        if(myGen!==_analysisGen)return;
        const history=(rrJ.data||rrJ).history||[];
        // Entries arrive oldest→newest per the API, but sort defensively so the
        // previous-entry carry-forward below always walks forward in time.
        const sorted=[...history].filter(h=>h.match_id).sort((a,b)=>new Date(a.date)-new Date(b.date));
        let prev=null;
        sorted.forEach(h=>{
          const lastChange=Number.isFinite(h.last_change)?h.last_change:null;
          const refundedRR=Number.isFinite(h.refunded_rr)?h.refunded_rr:0;
          const derankProtected=!!h.was_derank_protected;
          _rrChangeByMatchId[h.match_id]=lastChange;
          const details=parseRRDetails(h);
          _rrDetailsByMatchId[h.match_id]=details;
          _refundedRRByMatchId[h.match_id]=refundedRR;
          const dodge=rrDodgeEntry(h);
          if(dodge)_rrDodges.push(dodge);
          _derankProtectedByMatchId[h.match_id]=derankProtected;
          // Pre-match RR: the previous entry's elo is the exact value when the
          // season hasn't changed. Across a season boundary (or for the first
          // persisted entry) derive it from the ending total. Refunds apply on
          // top of the match payout, while a protected loss reports its normal
          // negative last_change but does not reduce the displayed RR.
          const sameSeason=prev&&prev.season?.short===h.season?.short;
          // Henrik's `elo` is tier-base + RR. At Immortal+, Riot's `rr` is
          // cumulative while the tier changes at a regional threshold, so use a
          // continuous coordinate rooted at the Immortal 1 floor. Otherwise a
          // promotion would introduce a fake 100-point jump into this chart.
          const historyTotal=entry=>{
            const tier=entry?.tier?.id??0;
            if(tier>=24&&Number.isFinite(entry?.rr))return 2100+entry.rr;
            return Number.isFinite(entry?.elo)?entry.elo:
              tier>=3&&Number.isFinite(entry?.rr)?(tier-3)*100+entry.rr:null;
          };
          const previousTotal=historyTotal(prev);
          const endingTotal=historyTotal(h);
          if(endingTotal!=null)_postRRByMatchId[h.match_id]=endingTotal;
          if((h?.tier?.id??0)>=3)_postTierByMatchId[h.match_id]=h.tier.id;
          const reportedStart=reportedRRStart(details);
          if(reportedStart!=null){
            _preRRByMatchId[h.match_id]=reportedStart;
            _preTierByMatchId[h.match_id]=details.beforeTier;
          }else if(sameSeason&&previousTotal!=null){
            _preRRByMatchId[h.match_id]=previousTotal;
            if((prev?.tier?.id??0)>=3)_preTierByMatchId[h.match_id]=prev.tier.id;
          }else if(endingTotal!=null&&lastChange!=null){
            const appliedMatchChange=derankProtected&&lastChange<0?0:lastChange;
            _preRRByMatchId[h.match_id]=endingTotal-appliedMatchChange-refundedRR;
            if((h?.tier?.id??0)>=3)_preTierByMatchId[h.match_id]=h.tier.id;
          }
          prev=h;
        });
      }catch(_){
        // No RR-change data this run — matches just fall back to myRR===null.
      }
      if(myGen===_analysisGen&&rawMatches.size)publishMatches([],true); // attach RR to saved matches
      if(myGen===_analysisGen)emit(); // dodges have no match to publish
    })();

    // Step 1: fetch v3/mmr (or reuse the prefetch) for rank and act selection.
    // Its per-act game counts are regional, not a reliable match-list total.
    let start=0;
    let finalCurrent=null;
    let useServerArchive=false;
    const revealHeader=()=>{
      if(myGen!==_analysisGen||!headerRevealPending)return;
      headerRevealPending=false;
      if(TARGET_SEASON)showSeasonSelect();
      else showSeasonIdle('No played acts');
      writePlayerRoute(PLAYER,TAG,TARGET_SEASON,'replace');
      finalizeHeader(finalCurrent,resolvedAccount);
    };
    setStatus('Loading rank and acts…',true);
    try{
      let mmrJ;
      if(prefetchSnapshot?.mmrJ){
        mmrJ=prefetchSnapshot.mmrJ;
      }else{
        const mmrUrl=`${API_BASE}/rank/${REGION}/${PLATFORM}/${encodeURIComponent(PLAYER)}/${TAG}`;
        ({j:mmrJ}=await apiGet(mmrUrl,{...requestOpts,onRateLimit}));
      }
      const seasonal=(mmrJ.data||mmrJ).seasonal||[];
      const seasonOrder=getSeasonOrder(seasonal);
      finalCurrent=(mmrJ.data||mmrJ).current||null;
      const savedCounts=await savedCountsPromise;
      if(myGen!==_analysisGen)return;

      // Build UUID-keyed stats map for dropdown
      const seasonStats={};
      seasonal.forEach(s=>{
        const id=(s.season?.id||'').toLowerCase();
        if(!id)return;
        seasonStats[id]={games:s.games||0,short:s.season?.short||null};
      });

      // Repopulate dropdown: only acts the player has played
      if(Object.keys(seasonStats).length||Object.keys(savedCounts).length){
        updateSeasonDropdown(seasonStats,seasonOrder,savedCounts);
        _seasonOptionsKey=parseSearchInput(searchText.trim())?.key||'';
        if(allMatches.length)setSeasonMatchCount(TARGET_SEASON,allMatches.length,'loading');
      }
      if(TARGET_SEASON){
        let selected=seasonOptions.find(option=>option.value.toLowerCase()===TARGET_SEASON.toLowerCase());
        if(!selected){
          selected={value:TARGET_SEASON,label:actOptionLabel(TARGET_SEASON,seasonStats[TARGET_SEASON.toLowerCase()]),games:0,countKind:null};
          seasonOptions=[...seasonOptions,selected];
        }
        TARGET_SEASON=selected.value;
        seasonValue=selected.value;
        emit();
      }

      // Saved acts can be newer than the current region's MMR act list.
      if(!TARGET_SEASON){
        TARGET_SEASON=seasonOptions[0]?.value||'';
        seasonValue=TARGET_SEASON;
        emit();
      }

    }catch(_){
      // MMR fetch failed — match history still loads from its own timeline.
      const savedCounts=await savedCountsPromise;
      if(myGen!==_analysisGen)return;
      if(Object.keys(savedCounts).length){
        updateSeasonDropdown({},[],savedCounts);
        if(!TARGET_SEASON){
          TARGET_SEASON=seasonOptions[0]?.value||'';
          seasonValue=TARGET_SEASON;
          emit();
        }
        if(allMatches.length)setSeasonMatchCount(TARGET_SEASON,allMatches.length,'loading');
      }
    }
    // Archived matches may already be on screen, but keep the header together
    // until the selected act is known. If MMR has no act, history can supply it.
    if(myGen!==_analysisGen)return;
    if(TARGET_SEASON)revealHeader();
    // Resolve the real calendar-current act before consulting shared history.
    // Archive failures never affect the normal API path.
    await loadSeasonDates();
    if(myGen!==_analysisGen)return;
    const liveCurrentActId=currentActId();
    if(PUUID&&TARGET_SEASON&&archiveActId!==TARGET_SEASON.toLowerCase()){
      archivePromise=startArchive(TARGET_SEASON);
    }
    if(PUUID&&TARGET_SEASON){
      serverScan=await beginServerActScan(PUUID,TARGET_SEASON,requestOpts);
      if(myGen!==_analysisGen)return;
      verifiedScan=serverScan?.coverage||null;
    }
    const targetActStart=getActInfoByUuid(TARGET_SEASON)?.start??null;
    if(TARGET_SEASON&&TARGET_SEASON.toLowerCase()!==liveCurrentActId&&targetActStart!=null){
      const actMeta=_actMeta&&Object.keys(_actMeta).length?_actMeta:HARDCODED_ACT_META;
      const nextActStart=Math.min(...Object.values(actMeta).map(info=>info?.start)
        .filter(value=>Number.isFinite(value)&&value>targetActStart));
      try{start=await findHistoryStartForAct(nextActStart,myGen,onRateLimit,requestOpts);}catch(_){start=0;}
      if(myGen!==_analysisGen)return;
    }
    if(liveCurrentActId){
      useServerArchive=!!(PUUID&&TARGET_SEASON&&TARGET_SEASON.toLowerCase()===liveCurrentActId);
      if(useServerArchive)start=0; // current-act scans always begin at the newest match
    }
    // Step 2: paginate match history. D1 rows are shared across every browser.
    // A first/partial search checks the whole act. Regional MMR totals never
    // prove completeness; only coverage verified by the proxy enables early stopping.
    let collected=[];
    // Safety bound: the v4 matchlist response has no total/pagination metadata
    // (only status+data), so an empty page is the sole reliable end signal. Since
    // we no longer treat a short page as the end, guard against a pathological
    // never-empty response with a hard offset ceiling. Competitive history is
    // finite and this is far beyond any real account's game count.
    let guardPages=0, MAX_PAGES=600; // ~ MAX_HISTORY_OFFSET/min-page-size, belt-and-braces
    let liveHistoryError=null;
    let scanStoppedEarly=false;
    let knownPageStreak=0;
    while(true){
      if(start>=MAX_HISTORY_OFFSET||++guardPages>MAX_PAGES){scanStoppedEarly=true;break;}
      setStatus(allMatches.length
        ?`Showing ${allMatches.length} matches, checking the rest of this act…`
        :'Checking competitive match history…',true);

      const url=serverScan
        ?`${API_BASE}/history-by-puuid/${REGION}/${PLATFORM}/${encodeURIComponent(PUUID)}?start=${start}&scan=${encodeURIComponent(serverScan.scanId)}`
        :`${API_BASE}/history/${REGION}/${PLATFORM}/${encodeURIComponent(PLAYER)}/${TAG}?mode=competitive&size=${BATCH}&start=${start}${useServerArchive?`&puuid=${encodeURIComponent(PUUID)}`:''}`;
      let j;
      try{
        ({j}=await fetchWithRetry(url,{...requestOpts,onRateLimit}));
      }catch(e){
        // Let the PUUID-keyed stored archive recover this act if live history
        // becomes unavailable, regardless of the account's current region.
        liveHistoryError=e;scanStoppedEarly=true;break;
      }
      if(myGen!==_analysisGen)return; // superseded by a newer act selection
      if(!Array.isArray(j.data)){liveHistoryError=new Error('Invalid match history');scanStoppedEarly=true;break;}
      const data=j.data||[];
      // TRUE end of history: the API returned nothing at this offset.
      if(!data.length)break;

      // When rank metadata is unavailable, use the newest actual match to
      // choose an act instead of silently mixing several acts together.
      if(!TARGET_SEASON){
        const firstAct=data[0]?.metadata?.season?.id||data[0]?.metadata?.season_id;
        if(firstAct){TARGET_SEASON=firstAct;setSeasonMatchCount(firstAct,0,'loading');revealHeader();}
      }

      const onPage=TARGET_SEASON?data.filter(m=>isSeason(m)):data;
      // If the skip offset landed beyond an act that v4 no longer lists,
      // stop spending live-list requests once the page is entirely older.
      // The stored index below can still recover that act by season ID.
      if(TARGET_SEASON&&!onPage.length&&targetActStart!=null&&
         data.every(m=>{
           const date=Date.parse(m.metadata?.started_at);
           return Number.isFinite(date)&&date<targetActStart;
         }))break;
      onPage.forEach(m=>{
        collected.push(m);
      });
      if(onPage.length)publishMatches(onPage);

      // The server proved prior coverage, but the browser must also have read
      // every covered match before it can stop downloading the live timeline.
      knownPageStreak=isKnownHistoryPage(data,verifiedScan)?knownPageStreak+1:0;
      if(knownPageStreak>=2){
        if(archivePromise){archivedMatches=await archivePromise;archivePromise=null;}
        if(myGen!==_analysisGen)return;
        if(archiveComplete&&!performanceRefreshNeeded.size&&verifiedScan.matchIds.every(id=>rawMatches.has(id)))break;
        verifiedScan=null;knownPageStreak=0; // A failed/partial archive needs the full live scan.
      }

      // Scrolled past the season — a full-ish page with zero matching games
      // means we've paged beyond the target act.
      if(TARGET_SEASON&&collected.length>0&&onPage.length===0)break;

      // Advance by the number of matches the API ACTUALLY returned (not the
      // requested size) — robust even if the API returns fewer than asked.
      start+=data.length;
      // Quota pacing stays in the proxy; the browser never sees quota headers.
      if(myGen!==_analysisGen)return;
    }

    // Both streams have published progressively; join before recovery so it
    // requests full details only for IDs neither stream already supplied.
    if(archivePromise)archivedMatches=await archivePromise;
    if(myGen!==_analysisGen)return;
    let recoveryComplete=false;

    // Check the PUUID-keyed stored index for matches absent from the live
    // list. Its compact records carry each match's original region.
    if(TARGET_SEASON){
      // Old-format archived IDs still need a one-time detail lookup if the
      // paginated live list no longer contains them. Fresh nulls are complete.
      const completeIds=new Set([...rawMatches.keys()].filter(id=>!performanceRefreshNeeded.has(id)));
      try{recoveryComplete=await recoverStoredSeasonMatches(collected,completeIds,myGen,onRateLimit,
        {...requestOpts,scanId:serverScan?.scanId});}catch(_){/* Keep live rows. */}
      if(myGen!==_analysisGen)return;
    }
    await rrPromise;
    if(myGen!==_analysisGen)return;
    if(!collected.length&&!archivedMatches.length&&!rawMatches.size&&liveHistoryError)throw liveHistoryError;
    publishMatches([...collected,...archivedMatches]);
    // Provisional archive rows may have rendered before live act metadata.
    // Refresh placement flags even when the last pages added no new IDs.
    allMatches=tagActPlacements(tagPostResetPlacements(allMatches));
    if(recoveryComplete&&!scanStoppedEarly&&!liveHistoryError){
      await finishServerActScan(serverScan,requestOpts);
      if(myGen!==_analysisGen)return;
    }
    revealHeader();
    setSeasonMatchCount(TARGET_SEASON,allMatches.length,scanStoppedEarly?'partial':'found');
    if(myGen!==_analysisGen)return; // a newer analysis took over
    setProgress(100);
    setTimeout(()=>{if(myGen===_analysisGen)setProgress(0);},600);
    renderAll();
    void refreshTeammateNames(lookupTeammateRows(allMatches));
    if(scanStoppedEarly&&allMatches.length)
      setStatus(`Showing ${allMatches.length} games. The live match scan stopped early; search again later to load more.`);
  }catch(e){
    if(myGen!==_analysisGen)return; // superseded run — swallow its error
    if(headerRevealPending){
      headerRevealPending=false;
      if(seasonOptions.length)showSeasonSelect();
      else showSeasonIdle('Retry loading acts');
    }
    if(allMatches.length){
      setSeasonMatchCount(TARGET_SEASON,allMatches.length,'partial');
      setStatus(`Showing ${allMatches.length} games. More games could not be loaded right now; search again later.`);
      return;
    }
    analysisState='error';
    setStatus('');
    errorMessage=e.message;
    emit();
  }
}

/* ── RENDER ALL ──────────────────────────────────────────── */
// Recomputes every stat panel's data. Avg Lobby Rank, Duos, and the K/D-by-rank
// card use statMatches, which excludes post-reset placement games unless the
// person toggles them in (mhIncludeReset) — since rank genuinely resets/
// recalibrates during placements. The Stats panel (K/D, ACS, Games, Win Rate)
// always counts placement games regardless, since those raw results are real.
let overviewStats=null;
function renderStats(skipPlaytime){
  statMatches=mhIncludeReset?allMatches:allMatches.filter(m=>!m.postReset);
  const statsPanelMatches=allMatches;
  const resetCount=allMatches.filter(m=>m.postReset).length;

  // Average rated lobbies across every queue size, including full 5-stacks.
  const avgs=statMatches.map(m=>m.avgRank).filter(v=>v!=null);
  const overall=avgs.length?avgs.reduce((a,b)=>a+b,0)/avgs.length:null;

  // Theme the whole UI from the player's own current rank — falls back to the
  // avg lobby rank (then all matches) if current rank never resolved, e.g.
  // the MMR fetch failed.
  const accentAvg=overall!=null?overall:(()=>{
    const a=statMatches.map(m=>m.avgRank).filter(Boolean);
    return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  })();
  const accentTier=CURRENT_TIER_ID!=null?CURRENT_TIER_ID:(accentAvg!=null?Math.round(accentAvg):null);
  if(accentTier!=null)accentColor=rColor(accentTier);

  overviewStats={
    resetCount,overall,overallRR:overall!=null?tierRR(overall):null,
    ...overviewStatValues(statsPanelMatches),
    playtime:skipPlaytime&&overviewStats?overviewStats.playtime:computePlaytime(),
  };

  renderRankByRankCard();
  renderServers(statMatches);
  buildTeammates();
  emit();
}

// The Stats panel figures: K/D, ACS, PS, ADR and KAST over every match.
function overviewStatValues(statsPanelMatches){
  // Sum raw kills and deaths across all games for an accurate overall K/D
  const statGames=statsPanelMatches.filter(m=>m.myStats&&m.myStats.kills!=null&&m.myStats.deaths!=null);
  const totalKills=statGames.reduce((a,m)=>a+m.myStats.kills,0);
  const totalDeaths=statGames.reduce((a,m)=>a+m.myStats.deaths,0);
  const avgKD=statGames.length?(totalDeaths>0?+(totalKills/totalDeaths).toFixed(2):totalKills):null;

  // Avg ACS — total combat score ÷ total rounds (weighted, matches tracker.gg)
  const acsGames=statsPanelMatches.filter(m=>m.myStats?.acs!=null&&m.myStats?.rounds_played>0);
  const totalAcsScore=acsGames.reduce((a,m)=>a+m.myStats.score,0);
  const totalAcsRounds=acsGames.reduce((a,m)=>a+m.myStats.rounds_played,0);
  const avgAcs=totalAcsRounds>0?(totalAcsScore/totalAcsRounds).toFixed(1):null;

  // Performance Score is already a per-match score; average only reported values.
  const performanceGames=statsPanelMatches.filter(m=>Number.isFinite(m.myStats?.performanceScore));
  const avgPerformance=performanceGames.length?performanceGames.reduce((sum,m)=>sum+m.myStats.performanceScore,0)/performanceGames.length:null;

  // Avg ADR — total damage ÷ total rounds, same weighted approach as ACS
  // (per-match average of averages would over-weight short matches).
  const adrGames=statsPanelMatches.filter(m=>m.myStats?.adr!=null&&m.myStats?.rounds_played>0);
  const totalDmg=adrGames.reduce((a,m)=>a+m.myStats.dmg,0);
  const totalAdrRounds=adrGames.reduce((a,m)=>a+m.myStats.rounds_played,0);
  const avgAdr=totalAdrRounds>0?trackerFixed1(totalDmg/totalAdrRounds):null;

  // KAST — KAST rounds ÷ rounds over matches that carry round data, to one
  // decimal like tracker's profile overview (per-match KAST stays whole).
  const kastGames=statsPanelMatches.filter(m=>m.myStats?.kastRounds!=null&&m.myStats?.kastTotalRounds>0);
  const totalKastRounds=kastGames.reduce((a,m)=>a+m.myStats.kastRounds,0);
  const totalKastDenom=kastGames.reduce((a,m)=>a+m.myStats.kastTotalRounds,0);

  return{
    kd:avgKD!=null?avgKD.toFixed(2):'—',
    acs:avgAcs!=null?avgAcs:'—',
    performance:avgPerformance==null?'—':avgPerformance.toFixed(1),
    performanceTitle:`Avg PS; ${performanceGames.length} of ${statsPanelMatches.length} matches have data`,
    adr:avgAdr!=null?avgAdr:'—',
    kast:totalKastDenom>0?`${(totalKastRounds/totalKastDenom*100).toFixed(1)}%`:'—',
    kastTitle:`Share of rounds with a kill, an assist, survived, or traded (killer died to a teammate within 3 s); ${kastGames.length} of ${statsPanelMatches.length} matches have round data`,
  };
}

function renderAll(partial=false){
  analysisState='ready';
  if(allMatches.length<=50&&Object.values(rrRanges).includes('50'))
    rrRanges=Object.fromEntries(Object.entries(rrRanges).map(([card,range])=>[card,range==='50'?'all':range]));
  if(!allMatches.length){
    if(!partial)setStatus('No matches found for this season.');
    emit();
    return;
  }
  renderStats();
  if(!partial)setStatus('',false);
  renderMatches();
}

/* ── SERVERS ────────────────────────────────────────────── */
// Party sizes present in the current matches, per filter, for the toggles.
const partySizeAvailability={};
function syncPartySizeOptions(name,available,selected){
  partySizeAvailability[name]=available;
  return selected&&available.has(selected)?selected:0;
}

let serverSummary=null;
function renderServers(matches){
  const available=new Set(matches.filter(m=>m.serverName).map(m=>m.partySize||1));
  serverPartySize=syncPartySizeOptions('servers-party-size',available,serverPartySize);
  const selectedMatches=serverPartySize
    ?matches.filter(m=>(m.partySize||1)===serverPartySize)
    :matches;
  serverFilteredMatchCount=selectedMatches.length;
  const groups=new Map();
  selectedMatches.forEach(m=>{
    if(!m.serverName)return;
    const key=m.serverName.toLocaleLowerCase();
    if(!groups.has(key))groups.set(key,{name:m.serverName,games:0,wins:0,losses:0,draws:0,kills:0,deaths:0,combatGames:0,score:0,rounds:0,performanceSum:0,performanceCount:0,lobbySum:0,lobbyCount:0,rrTotal:0,rrCount:0});
    const row=groups.get(key);
    row.games++;
    if(m.won===true)row.wins++;
    else if(m.won===false)row.losses++;
    else row.draws++;
    const stats=m.myStats;
    if(stats?.kills!=null&&stats?.deaths!=null){
      row.kills+=stats.kills;
      row.deaths+=stats.deaths;
      row.combatGames++;
    }
    if(stats?.score!=null&&stats?.rounds_played>0){
      row.score+=stats.score;
      row.rounds+=stats.rounds_played;
    }
    if(Number.isFinite(stats?.performanceScore)){row.performanceSum+=stats.performanceScore;row.performanceCount++;}
    // Net recorded RR on this server, every match counted (like the party-size table).
    if(Number.isFinite(m.myRR)){row.rrTotal+=m.myRR;row.rrCount++;}
    if(m.avgRank!=null){
      row.lobbySum+=m.avgRank;
      row.lobbyCount++;
    }
  });
  const knownMatches=[...groups.values()].reduce((sum,row)=>sum+row.games,0);
  serverData=[...groups.values()].map(row=>{
    const decided=row.wins+row.losses;
    return{...row,
      share:knownMatches?row.games/knownMatches*100:null,
      winRate:decided?row.wins/decided*100:null,
      kd:row.combatGames?(row.deaths>0?row.kills/row.deaths:row.kills):null,
      acs:row.rounds?row.score/row.rounds:null,
      performanceScore:row.performanceCount?row.performanceSum/row.performanceCount:null,
      avgLobby:row.lobbyCount?row.lobbySum/row.lobbyCount:null,
    };
  }).sort((a,b)=>b.games-a.games||a.name.localeCompare(b.name));
  const mostPlayed=serverData[0]||null;
  const best=[...serverData].filter(row=>row.games>=3&&row.winRate!=null).sort((a,b)=>b.winRate-a.winRate||b.games-a.games)[0]||null;
  serverSummary=[
    {label:'Most played',value:mostPlayed?.name||'—',note:mostPlayed?`${mostPlayed.games} matches, ${Math.round(mostPlayed.share)}% share`:''},
    {label:'Best win rate',value:best?.name||'—',note:best?`${winRateLabel(best.winRate)} across ${best.games} matches`:'Requires 3 matches on a server'},
    {label:'Servers played',value:serverData.length?String(serverData.length):'—',note:'Distinct servers this selection'},
    {label:'Server coverage',value:selectedMatches.length?`${knownMatches}/${selectedMatches.length}`:'—',note:selectedMatches.length?`${Math.round(knownMatches/selectedMatches.length*100)}% of matches identified`:''},
  ];
}

function setServerPartySize(value){
  const size=Number(value);
  serverPartySize=[1,2,3,5].includes(size)?size:0;
  renderServers(statMatches);
  emit();
}

/* ── TEAMMATES ───────────────────────────────────────────── */
function computeEncounters(matches,partyScope,playerPuuid,playerName,playerTag){
  const myId=playerPuuid?.toLowerCase()||'';
  const myRiotId=`${playerName}#${playerTag}`.toLowerCase();
  const findMe=m=>m.players?.find(p=>myId?p.puuid?.toLowerCase()===myId:
    `${p.name}#${p.tag}`.toLowerCase()===myRiotId);
  const riotKey=p=>p.name&&p.tag?`${p.name}#${p.tag}`.toLowerCase():'';
  const playerKey=p=>p.puuid?`id:${p.puuid.toLowerCase()}`:riotKey(p)?`riot:${riotKey(p)}`:'';
  const partyIds=new Set(),partyNames=new Set();
  // Exclude someone from Encounters altogether if they queued with the player
  // at any point in this act, even if another meeting was outside the party.
  partyScope.forEach(m=>{
    const me=findMe(m);
    if(!me||!m.myPartyId)return;
    m.players.forEach(p=>{
      if(p===me||p.party_id!==m.myPartyId)return;
      if(p.puuid)partyIds.add(p.puuid.toLowerCase());
      if(riotKey(p))partyNames.add(riotKey(p));
    });
  });
  const byPlayer=new Map();
  matches.forEach(m=>{
    const me=findMe(m);
    if(!me?.team_id)return;
    const seen=new Set();
    m.players.forEach(p=>{
      if(p===me||!p.team_id||!p.name||!p.tag)return;
      const key=playerKey(p);
      if(!key||seen.has(key))return;
      seen.add(key);
      if(p.puuid&&partyIds.has(p.puuid.toLowerCase())||partyNames.has(riotKey(p)))return;
      if(m.myPartyId&&p.party_id===m.myPartyId)return;
      const sameTeam=p.team_id===me.team_id;
      // A same-team player with missing party data cannot be verified as an
      // encounter. Opponents are necessarily outside the player's party.
      if(sameTeam&&(!m.myPartyId||!p.party_id))return;
      let row=byPlayer.get(key);
      if(!row){
        row={key,name:p.name,tag:p.tag,games:0,sameTeam:0,opponents:0,lastSeen:0};
        byPlayer.set(key,row);
      }
      row.games++;
      if(sameTeam)row.sameTeam++;else row.opponents++;
      if((m.startedAtMs||0)>row.lastSeen){
        row.lastSeen=m.startedAtMs;
        row.name=p.name;
        row.tag=p.tag;
      }
    });
  });
  return [...byPlayer.values()].filter(row=>row.games>=2)
    .sort((a,b)=>b.games-a.games||b.lastSeen-a.lastSeen||a.name.localeCompare(b.name));
}

// Match archives preserve Riot IDs at match time. Resolve current duo names
// separately during a player lookup, once per analysis. Rendering, navigation,
// and filters only reuse these names; they never initiate account requests.
let teammateNameState=null;
function lookupTeammateRows(matches){
  const rows=new Map();
  for(const m of matches){
    if(!m.myPartyId)continue;
    const me=m.players.find(p=>p.puuid===PUUID);
    if(!me)continue;
    for(const p of m.players){
      if(p===me||p.team_id!==me.team_id||p.party_id!==m.myPartyId||!p.puuid)continue;
      rows.set(p.puuid.toLowerCase(),{key:p.puuid});
    }
  }
  return [...rows.values()];
}
function currentTeammateIdentity(p){
  if(teammateNameState?.generation!==_analysisGen)return p;
  return teammateNameState.accounts.get(p.puuid?.toLowerCase())||p;
}
async function refreshTeammateNames(rows){
  if(teammateNameState?.generation!==_analysisGen){
    teammateNameState={generation:_analysisGen,accounts:new Map(),queue:[],running:false};
  }
  const state=teammateNameState,signal=_analysisController?.signal;
  for(const row of rows){
    if(!PUUID_RE.test(row.key))continue;
    const id=row.key.toLowerCase();
    if(state.accounts.has(id))continue;
    state.accounts.set(id,null); // Also deduplicates failed and pending lookups.
    state.queue.push(id);
  }
  if(state.running)return;
  state.running=true;
  try{
    while(state.queue.length&&state.generation===_analysisGen&&!signal?.aborted){
      const id=state.queue.shift();
      try{
        // The proxy spends the collector's key on these, not visitors' quota.
        const result=await apiGet(`${API_BASE}/account-by-puuid/${encodeURIComponent(id)}`,
          {signal,quiet:true,cache:'no-store',headers:{'X-Name-Lookup':'teammate'}});
        if(state.generation!==_analysisGen||signal?.aborted)return;
        const account=result?.j?.data;
        if(account?.puuid?.toLowerCase()!==id||!account.name||!account.tag)continue;
        state.accounts.set(id,{name:account.name,tag:account.tag});
        buildTeammates(); // Updates the duo table, overview, and profile links.
      }catch{
        // Keep the last observed name when a lookup is unavailable.
      }
    }
  }finally{state.running=false;}
}

function buildTeammates(){
  const tmap={};
  statMatches.forEach(m=>{
    if(!m.myStats)return;
    // Resolve "me" and my team once per match rather than once per teammate.
    const mePlayer=m.players.find(q=>PUUID?q.puuid===PUUID:q.name?.toLowerCase()===PLAYER.toLowerCase());
    const myTeamId=mePlayer?.team_id;
    const myTeam=m.players.filter(p=>p.team_id===myTeamId);
    myTeam.forEach(p=>{
      if(p===mePlayer)return;
      // Only count players who were in the same party (duo/trio/5-stack)
      if(!m.myPartyId||p.party_id!==m.myPartyId)return;
      const key=p.puuid||`${p.name}#${p.tag}`;
      if(!tmap[key])tmap[key]={name:p.name,tag:p.tag,key,lastSeen:-1,games:0,wins:0,decided:0,kills:0,deaths:0,rankSum:0,rankCount:0,acsSum:0,acsCount:0,performanceSum:0,performanceCount:0,placeSum:0,placeCount:0,rrTotal:0,rrCount:0,
        myKills:0,myDeaths:0,myAcsSum:0,myAcsCount:0,myPerformanceSum:0,myPerformanceCount:0};
      if((m.startedAtMs||0)>tmap[key].lastSeen){
        const identity=currentTeammateIdentity(p);
        tmap[key].name=identity.name;tmap[key].tag=identity.tag;
        tmap[key].lastSeen=m.startedAtMs||0;
      }
      tmap[key].games++;
      if(m.won===true||m.won===false)tmap[key].decided++;
      if(m.won===true)tmap[key].wins++;
      if(Number.isFinite(m.myRR)){tmap[key].rrTotal+=m.myRR;tmap[key].rrCount++;}
      tmap[key].kills+=p._kills||0;
      tmap[key].deaths+=p._deaths||0;
      if(m.avgRank!=null){tmap[key].rankSum+=m.avgRank;tmap[key].rankCount++;}
      if(Number.isFinite(p._performanceScore)){tmap[key].performanceSum+=p._performanceScore;tmap[key].performanceCount++;}
      if(p._acs!=null){
        tmap[key].acsSum+=p._acs;tmap[key].acsCount++;
        // ACS placement (1 = highest) is precomputed per player at load.
        if(p._acsPlace!=null){tmap[key].placeSum+=p._acsPlace;tmap[key].placeCount++;}
      }
      // The searched player's own line in the same shared matches.
      tmap[key].myKills+=m.myStats.kills||0;
      tmap[key].myDeaths+=m.myStats.deaths||0;
      if(Number.isFinite(m.myStats.acs)){tmap[key].myAcsSum+=m.myStats.acs;tmap[key].myAcsCount++;}
      if(Number.isFinite(m.myStats.performanceScore)){tmap[key].myPerformanceSum+=m.myStats.performanceScore;tmap[key].myPerformanceCount++;}
    });
  });

  allTeammates=Object.values(tmap).sort((a,b)=>b.games-a.games);
  allEncounters=computeEncounters(statMatches,allMatches,PUUID,PLAYER,TAG);

  emit();
}

// This is a transparent screening heuristic, not a calibrated probability of
// cheating. Repeated low performances against the searched player are evidence
// worth reviewing, but match data cannot establish collusion or intent.
function computeWintradeSignals(matches,partyScope,playerPuuid,playerName,playerTag){
  const myId=playerPuuid?.toLowerCase()||'';
  const myRiotId=`${playerName}#${playerTag}`.toLowerCase();
  const findMe=m=>m.players?.find(p=>myId?p.puuid?.toLowerCase()===myId:
    `${p.name}#${p.tag}`.toLowerCase()===myRiotId);
  const keyFor=p=>p.puuid?`id:${p.puuid.toLowerCase()}`:
    p.name&&p.tag?`riot:${p.name}#${p.tag}`.toLowerCase():'';
  const partyGames=new Map();
  partyScope.forEach(m=>{
    const me=findMe(m);
    if(!me||!m.myPartyId)return;
    m.players.forEach(p=>{
      const key=keyFor(p);
      if(p===me||!key||p.team_id!==me.team_id||p.party_id!==m.myPartyId)return;
      partyGames.set(key,(partyGames.get(key)||0)+1);
    });
  });
  const byPlayer=new Map();
  matches.forEach(m=>{
    const me=findMe(m);
    if(!me?.team_id)return;
    const enemy=m.players.filter(p=>p.team_id&&p.team_id!==me.team_id);
    const seen=new Set();
    enemy.forEach(p=>{
      const key=keyFor(p);
      if(!key||seen.has(key)||!p.name||!p.tag)return;
      seen.add(key);
      let row=byPlayer.get(key);
      if(!row){
        row={key,name:p.name,tag:p.tag,encounters:0,lowGames:0,measuredGames:0,
          acsSum:0,acsCount:0,performanceSum:0,performanceCount:0,killsSum:0,deathsSum:0,wins:0,decided:0,
          lowSeverity:0,partyGames:partyGames.get(key)||0,lastSeen:0};
        byPlayer.set(key,row);
      }
      row.encounters++;
      if(m.won!=null){row.decided++;if(m.won)row.wins++;}
      if(Number.isFinite(p._performanceScore)){row.performanceSum+=p._performanceScore;row.performanceCount++;}
      if(Number.isFinite(p._acs)){
        row.acsSum+=p._acs;row.acsCount++;
      }
      if(Number.isFinite(p._kills)&&Number.isFinite(p._deaths)){
        row.killsSum+=p._kills;row.deathsSum+=p._deaths;
      }
      const peerAcs=enemy.filter(q=>q!==p&&Number.isFinite(q._acs))
        .map(q=>q._acs).sort((a,b)=>a-b);
      if(Number.isFinite(p._acs)&&Number.isFinite(p._kills)&&
         Number.isFinite(p._deaths)&&p._deaths>0&&peerAcs.length>=3){
        const mid=Math.floor(peerAcs.length/2);
        const median=peerAcs.length%2?peerAcs[mid]:(peerAcs[mid-1]+peerAcs[mid])/2;
        if(median>0){
          row.measuredGames++;
          const acsRatio=p._acs/median;
          const kd=p._kills/p._deaths;
          if(acsRatio<0.65&&kd<0.65){
            row.lowGames++;
            row.lowSeverity+=Math.min(1,(0.65-acsRatio)/0.65);
          }
        }
      }
      if((m.startedAtMs||0)>row.lastSeen){row.lastSeen=m.startedAtMs;row.name=p.name;row.tag=p.tag;}
    });
  });
  return [...byPlayer.values()].filter(row=>row.encounters>=2&&row.lowGames>0).map(row=>{
    const repeat=20*Math.min(1,(row.encounters-1)/4);
    const low=35*row.lowGames/row.measuredGames;
    const severity=10*row.lowSeverity/row.lowGames;
    const wins=20*Math.max(0,(row.decided?row.wins/row.decided:0)-0.5)*2;
    const party=row.partyGames?Math.min(15,7+4*(row.partyGames-1)):0;
    // Keep sparse records out of the highest bands regardless of a lucky streak.
    const sampleCap=row.encounters===2?45:row.encounters===3?65:95;
    return{...row,score:Math.round(Math.min(95,Math.min(sampleCap,repeat+low+severity+wins)+party)),
      avgAcs:row.acsCount?row.acsSum/row.acsCount:null,
      performanceScore:row.performanceCount?row.performanceSum/row.performanceCount:null,
      kd:row.deathsSum?row.killsSum/row.deathsSum:null};
  }).sort((a,b)=>b.score-a.score||b.encounters-a.encounters||b.lastSeen-a.lastSeen);
}

const OVERVIEW_RECENT_MATCH_LIMIT=20;
function overviewRecentMatches(matches){
  return [...matches].sort((a,b)=>(b.startedAtMs||0)-(a.startedAtMs||0)).slice(0,OVERVIEW_RECENT_MATCH_LIMIT);
}

function decidedWinRate(wins,decided){return decided>0?wins/decided*100:null;}
// Win rates show one decimal; the colour follows the shown value, so 50.0% stays neutral.
function winRateLabel(rate){return rate==null?'—':rate.toFixed(1)+'%';}
function winRateTone(rate){const shown=rate==null?null:Math.round(rate*10)/10;return shown==null||shown===50?'':shown>50?'rank-positive':'rank-negative';}

/* ── PLAYTIME ────────────────────────────────────────────── */
// Total playtime. Always counts every match, including post-reset placement
// games — time spent playing placements is real playtime either way.
function computePlaytime(){
  const withDur=allMatches.filter(m=>m.startedAtMs!=null&&m.durationMs!=null&&m.durationMs>0);
  if(!withDur.length)return{value:'—',title:''};
  const totalMs=withDur.reduce((s,m)=>s+m.durationMs,0);
  const totalH=Math.floor(totalMs/3600000);
  const totalM=Math.round((totalMs%3600000)/60000);
  // Average hours per day since the targeted act started, only when that
  // start date is known (live data or the hardcoded snapshot).
  const seasonStartMs=getActInfoByUuid(TARGET_SEASON)?.start??null;
  const avgHoursPerDay=seasonStartMs!=null
    ?(totalMs/3600000/Math.max(1,Math.ceil((Date.now()-seasonStartMs)/86400000))).toFixed(1)
    :null;
  // Hours only past a day's worth, otherwise Xh Ym.
  return{
    value:totalH>=24?`${totalH}h`:`${totalH}h ${totalM}m`,
    title:avgHoursPerDay!=null
      ?`${totalH}h ${totalM}m across ${withDur.length} match${withDur.length===1?'':'es'} — ${avgHoursPerDay}h per day since season start`
      :`${totalH}h ${totalM}m across ${withDur.length} match${withDur.length===1?'':'es'}`,
  };
}

/* ── K/D BY RANK (Player / Lobby toggle) ────────────────── */
let lobbyRankData=[],partySizeData=[];

// Aggregate the same match statistics by lobby rank or party size.
function buildKdRankBuckets(bucketFn,{includeLobby,matches=statMatches}={}){
  const rb={};
  matches.filter(m=>m.myStats).forEach(m=>{
    const info=bucketFn(m);
    if(!info)return;
    const t=info.tier;
    if(!rb[t])rb[t]={totalKills:0,totalDeaths:0,wins:0,decided:0,total:0,label:info.label,icon:info.icon,acsSum:0,acsCount:0,performanceSum:0,performanceCount:0,lobbySum:0,lobbyCount:0,teamRankSum:0,teamRankCount:0,enemyRankSum:0,enemyRankCount:0,rrTotal:0,rrCount:0,dmgSum:0,adrRounds:0,adrCount:0};
    rb[t].total++;
    if(m.won===true||m.won===false)rb[t].decided++;
    if(Number.isFinite(m.myRR)){rb[t].rrTotal+=m.myRR;rb[t].rrCount++;}
    if(includeLobby&&m.avgRank!=null){rb[t].lobbySum+=m.avgRank;rb[t].lobbyCount++;}
    if(m.avgTeamRank!=null){rb[t].teamRankSum+=m.avgTeamRank;rb[t].teamRankCount++;}
    if(m.avgEnemyRank!=null){rb[t].enemyRankSum+=m.avgEnemyRank;rb[t].enemyRankCount++;}
    if(m.won===true)rb[t].wins++;
    if(m.myStats.kills!=null)rb[t].totalKills+=m.myStats.kills;
    if(m.myStats.deaths!=null)rb[t].totalDeaths+=m.myStats.deaths;
    if(Number.isFinite(m.myStats.performanceScore)){rb[t].performanceSum+=m.myStats.performanceScore;rb[t].performanceCount++;}
    if(m.myStats.acs!=null){rb[t].acsSum+=m.myStats.acs;rb[t].acsCount++;}
    // ADR is total damage over total rounds, weighted like the Stats panel's.
    if(m.myStats.adr!=null&&m.myStats.rounds_played>0){rb[t].dmgSum+=m.myStats.dmg;rb[t].adrRounds+=m.myStats.rounds_played;rb[t].adrCount++;}
  });
  return Object.keys(rb).map(Number).sort((a,b)=>a-b).map(tier=>({tier,...rb[tier]}));
}

/* ── RR GAINS ────────────────────────────────────────────── */
// Plain, observed RR statistics: RR/Win, RR/Loss, Games, and Win Rate, four
// pills living among the Stats card's other four (Avg K/D/ACS/ADR/Playtime).
// Nothing here is inferred or fitted: every figure is an average of Riot's
// own last_change values for the matches in scope.
//
// (This replaced a hidden-MMR estimate card, which inverted Riot's documented
// payout formula to back out where hidden MMR sat relative to displayed rank.
// It worked, but everything it printed was a fitted estimate carrying a
// confidence range. This reports measured values only — which is why the
// calibrated band constants, the c→elo level conversion, the double-promotion
// evidence block and the live /api/calib-model fetch are all gone from the
// client. The server still folds calibration on /history; nothing reads it.)
//
// Match eligibility — the matches Riot pays by the ordinary RR rules:
//   - myRR (last_change) present; an uncovered match carries no RR data at all
//   - tier 3+; Unranked/placement games pay by placement rules instead
//   - not the single act-opening placement match (see tagActPlacements)
//   - not a full 5-stack — a premade 5 isn't normal solo/duo queue RR
// Draws are KEPT: they're real matches that move RR (by roughly nothing), so
// dropping them would bias the per-match net upward for anyone who draws.
// They're excluded from the win and loss averages, which are per-outcome by
// definition.
//
// Every eligible match saved for the current act, uncapped — not just recent
// form. That's possible because allMatches already holds far more than the
// live upstream mmr-history endpoint's own ~20-game window: the server
// persists every match it's ever seen for this player (see mergeRRHistory in
// functions/api/[[path]].js), so repeated searches accumulate a real
// act-long history beyond what any single fetch returns.
// Rank Shields need no special handling — a shielded loss freezes DISPLAYED
// RR but last_change still reports the full payout, so these averages stay
// honest. (Measured across the research corpus: 223 was_derank_protected
// entries all carry a normal −14..−26 last_change against an elo delta of 0.)

// Win/loss/net summary for one set of rows.
function rrBucketStats(rows){
  const wins=rows.filter(r=>r.won===true),losses=rows.filter(r=>r.won===false),draws=rows.filter(r=>r.won===null);
  const sum=a=>a.reduce((s,r)=>s+r.rr,0);
  const total=sum(rows);
  return{
    count:rows.length,
    wins:wins.length,losses:losses.length,draws:draws.length,
    avgGain:wins.length?sum(wins)/wins.length:null,
    avgLoss:losses.length?-sum(losses)/losses.length:null, // positive magnitude
    total,
    net:rows.length?total/rows.length:null,
    winRate:(wins.length+losses.length)?wins.length/(wins.length+losses.length)*100:null,
  };
}

// The full stat set the card renders. No minimum-matches gate — with too few
// matches the averages just show as "—" (rrBucketStats returns null on an
// empty bucket), rather than hiding the card outright.
function isRREligible(m){
  const placement=m.myRRDetails?.placement??!!m.actPlacement;
  return m.myRR!=null&&m.myTierId>=3&&!placement&&(m.partySize||1)<5;
}
function computeRRStats(matches){
  const eligible=[];
  matches.forEach(m=>{
    if(!isRREligible(m))return;
    eligible.push({
      rr:m.myRR,
      won:m.won===true?true:(m.won===false?false:null),
      penalty:m.myPartyPenalty||0,
    });
  });
  const rows=eligible;
  const n=rows.length;
  return{
    ...rrBucketStats(rows),
    n,
    partyMatches:rows.filter(r=>r.penalty>0).length,
  };
}

// ── Column renderer ──────────────────────────────────────────────────────
// Signs use U+2212 so figures line up under font-variant-numeric:tabular-nums.
const rrSigned=(x,d)=>`${x<0?'−':'+'}${Math.abs(x).toFixed(d)}`;

function rrPositionFromElo(elo,tierHint=null){
  let tier=tierHint>=3?tierHint:Math.floor(elo/100)+3;
  tier=Math.max(3,Math.min(27,tier));
  // Iron through Ascendant use a 0–99 progress bar per division. Immortal+
  // instead displays leaderboard RR accumulated from the Immortal 1 floor;
  // it must not reset when the API's tier changes to Immortal 2/3/Radiant.
  let rr=Math.round(elo-(tier>=24?2100:(tier-3)*100));
  if(tier<24){
    while(rr<0&&tier>3){tier--;rr+=100;}
    while(rr>=100&&tier<24){tier++;rr-=100;}
  }
  return{tier,rr,label:`${avgLabelShort(tier)}, ${rr} RR`};
}

function rrMovementXAxis(rows,zoomTier){
  const positions=rows.map(row=>zoomTier==null?row.m.myPreRR:
    rrPositionFromElo(row.m.myPreRR,row.m.myPreTierId??row.m.myTierId).rr);
  const observedMin=Math.min(...positions),observedMax=Math.max(...positions);
  if(zoomTier!=null){
    // Keep ordinary ranks on 0–100 RR. At Immortal+, RR is cumulative;
    // show only the hundred-RR intervals containing this tier's matches.
    // This centers 150 in a 100–200 view instead of leaving an empty 0–100.
    const min=zoomTier<24?0:Math.floor(observedMin/100)*100;
    const max=zoomTier<24?100:Math.max(min+100,Math.ceil(observedMax/100)*100);
    return{positions,observedMin,observedMax,min,max};
  }
  const span=Math.max(1,observedMax-observedMin);
  const pad=Math.max(25,span*.06);
  return{positions,observedMin,observedMax,min:Math.max(0,observedMin-pad),max:observedMax+pad};
}

function rrMovementRows(matches){
  // Use the same five-stack eligibility rule as the RR summary. Draws do not
  // contribute to win/loss payout comparison. Rank Shield losses still carry
  // their normal last_change, so keep them as evidence for this estimate.
  return matches.filter(m=>
    isRREligible(m)&&m.myPreRR!=null&&
    (m.won===true||m.won===false)
  ).map(m=>{
    return{m,net:m.myRR,penalty:m.myPartyPenalty||0};
  });
}

const RR_ESTIMATE_NEIGHBORS=5;
const RR_ESTIMATE_MAX_SPAN=30;
// Where 30 RR holds fewer than 3 games, the estimate retries over 60 RR. A
// fast climber gains 20–30 RR a game, so their games start 20–30 RR apart and
// a 30 RR window left most of the curve as gaps (2026-11-21, on request).
// Points the 30 RR window draws are unchanged; points drawn rose from 81% to
// 94%, and the added points were 2.62 RR from the held-out payout vs 3.27 for
// the act mean alone (553 holdout corpus players; docs/rr-payout-model-2026-11-20.md).
const RR_ESTIMATE_WIDE_SPAN=60;
const RR_ESTIMATE_MIN_SAMPLES=3;
const RR_ESTIMATE_PRIOR_WEIGHT=2;

// Round margin moves payouts: each extra round of margin adds about a third
// of an RR to a win and to a loss's cost. Measured 2026-11-21 within each
// player/act on the RR corpus, controlling for starting rank, by rank group
// of the starting tier (tuning players; holdout players agreed within 0.02;
// docs/rr-payout-model-2026-11-20.md). The estimate moves every payout to a
// typical RR_MARGIN_REFERENCE-round margin before averaging, so a few
// blowouts or close games among the nearby ones do not skew the line:
// 0.22 RR closer on 553 holdout players, better in every rank group.
// Games without a known score keep their raw payout.
const RR_MARGIN_REFERENCE=4;
const RR_MARGIN_SLOPES={
  win:{ironGold:.35,platDiamond:.38,ascendant:.32,immortal:.36,radiant:.35},
  loss:{ironGold:.45,platDiamond:.42,ascendant:.36,immortal:.31,radiant:.33},
};
function rrMarginGroup(tier){
  return tier<=14?'ironGold':tier<=20?'platDiamond':tier<=23?'ascendant':tier<=26?'immortal':'radiant';
}
// A row's payout magnitude at the reference margin.
function rrMarginAdjusted(row){
  const payout=Math.abs(row.net),m=row.m;
  if(!Number.isInteger(m.myR)||!Number.isInteger(m.opR))return payout;
  const tier=m.myPreTierId??m.myTierId;
  const slope=RR_MARGIN_SLOPES[m.won?'win':'loss'][rrMarginGroup(tier)];
  return payout-slope*(Math.abs(m.myR-m.opR)-RR_MARGIN_REFERENCE);
}

function rrPayoutEstimates(visibleRows,allRows,won){
  const pool=allRows.filter(row=>row.m.won===won).sort((a,b)=>a.m.myPreRR-b.m.myPreRR);
  if(!pool.length)return[];
  const actMean=pool.reduce((sum,row)=>sum+rrMarginAdjusted(row),0)/pool.length;
  const centers=new Map(visibleRows.filter(row=>row.m.won===won).map(row=>[row.m.myPreRR,row.axisRR]));
  return [...centers.keys()].sort((a,b)=>a-b).map(position=>{
    const axisPosition=centers.get(position);
    let low=0,high=pool.length;
    while(low<high){
      const mid=(low+high)>>1;
      if(pool[mid].m.myPreRR<position)low=mid+1;
      else high=mid;
    }
    // The nearest games of this outcome, at most `span` RR away and spanning
    // at most `span` RR together.
    const nearby=span=>{
      let before=low-1,after=low,min=Infinity,max=-Infinity;
      const sample=[];
      while(sample.length<RR_ESTIMATE_NEIGHBORS&&(before>=0||after<pool.length)){
        const takeBefore=before>=0&&(after===pool.length||
          position-pool[before].m.myPreRR<=pool[after].m.myPreRR-position);
        const row=pool[takeBefore?before--:after++];
        if(Math.abs(row.m.myPreRR-position)>span)break;
        const candidateMin=Math.min(min,row.m.myPreRR),candidateMax=Math.max(max,row.m.myPreRR);
        if(candidateMax-candidateMin>span)continue;
        sample.push(row);
        min=candidateMin;max=candidateMax;
      }
      return{sample,min,max,span};
    };
    let local=nearby(RR_ESTIMATE_MAX_SPAN);
    if(local.sample.length<RR_ESTIMATE_MIN_SAMPLES)local=nearby(RR_ESTIMATE_WIDE_SPAN);
    const {sample,min,max,span}=local;
    if(sample.length<RR_ESTIMATE_MIN_SAMPLES)return{position,axisPosition,payout:null};
    const localTotal=sample.reduce((sum,row)=>sum+rrMarginAdjusted(row),0);
    // The act mean steadies a small local sample. Its weight was 8 until
    // 2026-11-21; 2 draws the same points and gaps but keeps the curve's ends
    // on the dots, 0.08 RR closer for 553 holdout corpus players (better at
    // Immortal+, slightly worse below; docs/rr-payout-model-2026-11-20.md).
    const payout=(localTotal+RR_ESTIMATE_PRIOR_WEIGHT*actMean)/(sample.length+RR_ESTIMATE_PRIOR_WEIGHT);
    const minRow=sample.find(row=>row.m.myPreRR===min),maxRow=sample.find(row=>row.m.myPreRR===max);
    return{position,axisPosition,payout,n:sample.length,min,max,span,
      minTier:minRow.m.myPreTierId??minRow.m.myTierId,
      maxTier:maxRow.m.myPreTierId??maxRow.m.myTierId,actMean};
  });
}

// Lines join neighbouring estimates unless they sit further apart than the
// wider of the two windows used (30 RR, or 60 RR where games are sparse).
function rrPayoutSegments(estimates){
  const segments=[];
  let current=[],previous=null;
  const flush=()=>{if(current.length)segments.push(current);current=[];};
  estimates.forEach(estimate=>{
    if(estimate.payout==null){flush();previous=null;return;}
    const reach=Math.max(estimate.span??RR_ESTIMATE_MAX_SPAN,previous?.span??RR_ESTIMATE_MAX_SPAN);
    if(previous!=null&&estimate.position-previous.position>reach)flush();
    current.push(estimate);
    previous=estimate;
  });
  flush();
  return segments;
}

// Even point (redefined 22 Nov 2026, on request): a sustained stretch of play
// where RR per win and RR per loss are equal. Riot pays more for wins than it
// takes for losses while hidden MMR sits above the displayed rank and the
// reverse above it, so wins and losses paying the same game after game
// usually means the rank has met hidden MMR. Until 22 Nov this was the
// crossing of two straight lines fitted against starting rank over the whole
// act; that drew "Even" where the lines met by extrapolation while the games
// there were still apart (Ethan#FARM: 2.2–2.9 RR apart at the top of the act,
// marked "Even at 380 RR").
// Games in play order, party-penalized ones left out (their payout is scaled
// down), each payout evened out to the reference margin like the curves.
// A window of RR_EVEN_WINDOW consecutive games with at least
// RR_EVEN_MIN_SIDE wins and losses is even when its average win and average
// loss are within RR_EVEN_MAX_GAP RR. Consecutive even windows form a stretch,
// trimmed until each half of it is even too; the longest stretch of at least
// RR_EVEN_MIN_GAMES games is the even point,
// placed at its games' median starting RR. Thresholds were set on two
// players (docs/rr-even-point.md), not validated on the corpus.
const RR_EVEN_WINDOW=16;
const RR_EVEN_MIN_SIDE=4;
const RR_EVEN_MAX_GAP=1.5;
const RR_EVEN_MIN_GAMES=20;
function rrPayoutEvenPoint(rows){
  const games=rows
    .filter(row=>!(row.penalty>0)&&Number.isFinite(row.net)&&row.net!==0&&Number.isFinite(row.m.myPreRR)&&(row.m.won===true||row.m.won===false))
    .map((row,index)=>({row,index,won:row.net>0,payout:rrMarginAdjusted(row)}))
    .sort((a,b)=>(a.row.m.startedAtMs||0)-(b.row.m.startedAtMs||0)||a.index-b.index);
  if(games.length<Math.max(RR_EVEN_WINDOW,RR_EVEN_MIN_GAMES))return null;
  const mean=list=>list.reduce((sum,game)=>sum+game.payout,0)/list.length;
  const even=[];
  for(let i=0;i+RR_EVEN_WINDOW<=games.length;i++){
    const window=games.slice(i,i+RR_EVEN_WINDOW),wins=window.filter(game=>game.won),losses=window.filter(game=>!game.won);
    even.push(wins.length>=RR_EVEN_MIN_SIDE&&losses.length>=RR_EVEN_MIN_SIDE&&Math.abs(mean(wins)-mean(losses))<=RR_EVEN_MAX_GAP);
  }
  // Windows that overlap a stretch's edges can pull in a few games just
  // outside it, so each half of a stretch must also be even on its own; the
  // edge whose half is further apart loses a game until both halves are.
  const gapOf=list=>{
    const wins=list.filter(game=>game.won),losses=list.filter(game=>!game.won);
    return wins.length&&losses.length?mean(wins)-mean(losses):Infinity;
  };
  const trim=(first,last)=>{
    while(last-first+1>=RR_EVEN_MIN_GAMES){
      const mid=first+((last-first+1)>>1);
      const head=Math.abs(gapOf(games.slice(first,mid))),tail=Math.abs(gapOf(games.slice(mid,last+1)));
      if(head<=RR_EVEN_MAX_GAP&&tail<=RR_EVEN_MAX_GAP)return{first,last};
      if(head>=tail)first++;else last--;
    }
    return null;
  };
  let best=null;
  for(let i=0;i<even.length;){
    if(!even[i]){i++;continue;}
    let j=i;
    while(j+1<even.length&&even[j+1])j++;
    const found=trim(i,j+RR_EVEN_WINDOW-1);
    if(found&&(!best||found.last-found.first>=best.last-best.first))best=found;
    i=j+1;
  }
  if(!best)return null;
  const stretch=games.slice(best.first,best.last+1),wins=stretch.filter(game=>game.won),losses=stretch.filter(game=>!game.won);
  const byStart=stretch.map(game=>game.row.m).sort((a,b)=>a.myPreRR-b.myPreRR),starts=byStart.map(m=>m.myPreRR);
  const mid=starts.length>>1,position=starts.length%2?starts[mid]:(starts[mid-1]+starts[mid])/2;
  const nearest=stretch.reduce((a,b)=>Math.abs(b.row.m.myPreRR-position)<Math.abs(a.row.m.myPreRR-position)?b:a).row.m;
  return{position,games:stretch.length,wins:wins.length,losses:losses.length,winPayout:mean(wins),lossPayout:mean(losses),
    minRR:starts[0],maxRR:starts.at(-1),minTier:byStart[0].myPreTierId??byStart[0].myTierId,maxTier:byStart.at(-1).myPreTierId??byStart.at(-1).myTierId,startMs:stretch[0].row.m.startedAtMs??null,endMs:stretch.at(-1).row.m.startedAtMs??null,
    tier:nearest.myPreTierId??nearest.myTierId};
}

function setRRMovementZoomTier(tier){
  rrMovementZoomTier=tier;
  emit();
}

// Match range per RR page card (all time or the 50/30/20 most recent): each
// card picks its own, so changing one never rescopes another (21 Nov 2026;
// until then the summary's tabs drove the trend and session charts too).
const RR_RANGE_CARDS=['summary','trend','sessions'];
const RR_RANGES=['all','50','30','20'];
const rrDefaultRanges=()=>Object.fromEntries(RR_RANGE_CARDS.map(card=>[card,'all']));
let rrRanges=rrDefaultRanges();
function setRRRange(card,value){
  if(!RR_RANGE_CARDS.includes(card)||!RR_RANGES.includes(value)||(value==='50'&&allMatches.length<=50))return;
  if(rrRanges[card]===value)return;
  rrRanges={...rrRanges,[card]:value};
  emit();
}
function rrScopedMatches(matches,range){
  return range==='all'||!RR_RANGES.includes(range)?matches:[...matches]
    .sort((a,b)=>(b.startedAtMs||0)-(a.startedAtMs||0))
    .slice(0,Number(range));
}
// RR by session: matches with a recorded RR change and a start time, in play
// order, split into play sessions wherever more than RR_SESSION_BREAK_MS passes
// between one match's end (start + duration, or RR_SESSION_MATCH_MS when the
// duration is unknown) and the next match's start. Net RR counts every
// recorded change, placements and 5-stacks included, like the summary's Net RR.
// Replaced "RR payout over time" on 21 Nov 2026: payout size barely moves
// within an act (docs/rr-and-hidden-mmr.md), the number of wins does.
const RR_SESSION_BREAK_MS=3*3600000;
const RR_SESSION_MATCH_MS=40*60000;
function rrSessionRows(matches,breakMs=RR_SESSION_BREAK_MS){
  const ordered=matches.filter(m=>Number.isFinite(m.myRR)&&Number.isFinite(m.startedAtMs))
    .sort((a,b)=>a.startedAtMs-b.startedAtMs);
  const sessions=[];
  let current=null;
  ordered.forEach(m=>{
    const end=m.startedAtMs+(Number.isFinite(m.durationMs)&&m.durationMs>0?m.durationMs:RR_SESSION_MATCH_MS);
    if(!current||m.startedAtMs-current.endMs>breakMs){
      current={startMs:m.startedAtMs,endMs:end,matches:[],wins:0,losses:0,draws:0,net:0};
      sessions.push(current);
    }
    current.matches.push(m);
    current.endMs=Math.max(current.endMs,end);
    current.net+=m.myRR;
    if(m.won===true)current.wins++;else if(m.won===false)current.losses++;else current.draws++;
  });
  return sessions.map((s,i)=>{
    const last=s.matches.at(-1);
    return{...s,i,games:s.matches.length,
      postRR:Number.isFinite(last.myPostRR)?last.myPostRR:null,postTierId:last.myPostTierId??null};
  });
}
function rrDuoInfo(match){
  if(match.partySize!==2||!match.myPartyId)return null;
  const me=match.players?.find(p=>PUUID?p.puuid===PUUID:
    `${p.name}#${p.tag}`.toLowerCase()===`${PLAYER}#${TAG}`.toLowerCase());
  const partner=me&&match.players.find(p=>p!==me&&p.party_id===match.myPartyId&&p.team_id===me.team_id);
  return{
    key:partner?.puuid||`${partner?.name||'unknown'}#${partner?.tag||match.myPartyId}`,
    name:partner?.name||'Duo',
    label:partner?.name?`Duo with ${partner.name}${partner.tag?'#'+partner.tag:''}`:'Duo match',
  };
}

function rrReportedStats(matches){
  const eligible=matches.filter(isRREligible);
  const covered=eligible.filter(m=>m.myRRDetails?.bonus!=null);
  return {total:eligible.length,covered:covered.length,
    bonusMatches:covered.filter(m=>m.myRRDetails.bonus>0).length,
    bonusTotal:covered.reduce((sum,m)=>sum+m.myRRDetails.bonus,0)};
}

// Act dodges inside an RR range: every one for "all", otherwise those on or
// after the oldest scoped match's start (dodges have no match to count).
function rrDodgesInRange(dodges,scoped,range){
  if(range==='all'||!RR_RANGES.includes(range))return dodges;
  const starts=scoped.map(m=>m.startedAtMs).filter(Number.isFinite);
  if(!starts.length)return [];
  const from=Math.min(...starts);
  return dodges.filter(d=>d.atMs!=null&&d.atMs>=from);
}

// RR moved outside the normal match payout, for the RR summary's
// "RR penalties" (dodges + AFK) and "Refunds" tiles, over every match in the
// range (like Net RR):
// - dodges: their exact last_change; no match exists, so Net RR lacks them.
// - refunds: refunded_rr, applied on top of last_change, so Net RR lacks them.
// - AFK penalties: afk_penalty summed as reported; its magnitude is used
//   because only positive values have been observed and the schema documents
//   no sign. It may already be inside last_change (undocumented).
// rr_penalty (and the match's party penalty) is a fraction of the payout, not
// RR, so those games are counted, never converted. Remakes leave no separate
// record in either API response and are not detected.
function rrAdjustmentStats(matches,dodges=[]){
  const covered=matches.filter(m=>Number.isFinite(m.myRRDetails?.afkPenalty));
  const afk=covered.filter(m=>m.myRRDetails.afkPenalty!==0);
  const refunds=matches.filter(m=>Number.isFinite(m.myRefundedRR)&&m.myRefundedRR!==0);
  const party=matches.filter(m=>m.myRRDetails?.penalty>0||m.myPartyPenalty>0);
  const dodgeRR=dodges.reduce((sum,d)=>sum+d.change,0);
  const refundRR=refunds.reduce((sum,m)=>sum+m.myRefundedRR,0);
  const afkRR=afk.reduce((sum,m)=>sum+Math.abs(m.myRRDetails.afkPenalty),0);
  return {total:matches.length,dodges:dodges.length,dodgeRR,
    refunds:refunds.length,refundRR,
    afkCovered:covered.length,afkMatches:afk.length,afkRR,
    partyMatches:party.length,penaltyRR:dodgeRR-afkRR};
}

function buildRRScoreRows(matches){
  const groups=new Map();
  matches.filter(m=>isRREligible(m)&&Number.isFinite(m.myRR)).forEach(m=>{
    if(!Number.isInteger(m.myR)||!Number.isInteger(m.opR)||m.myR<0||m.opR<0||m.myR===m.opR)return;
    if(m.won!==true&&m.won!==false)return;
    if(m.won!==(m.myR>m.opR))return;
    const high=Math.max(m.myR,m.opR),low=Math.min(m.myR,m.opR),key=high+'-'+low;
    if(!groups.has(key))groups.set(key,{high,low,margin:high-low,matches:[]});
    groups.get(key).matches.push(m);
  });
  return [...groups.values()].sort((a,b)=>a.margin-b.margin||a.high-b.high).map(g=>({
    high:g.high,low:g.low,margin:g.margin,stats:computeRRStats(g.matches),
  }));
}

// Matches grouped by your rank in each match. Games, K/D, ACS and win rate
// include every match; Performance Score averages only reported scores; RR
// averages use eligible recorded payouts only.
function rrRankRows(matches){
  const groups=new Map();
  matches.forEach(m=>{
    if(!groups.has(m.myTierId))groups.set(m.myTierId,[]);
    groups.get(m.myTierId).push(m);
  });
  return [...groups].sort((a,b)=>a[0]-b[0]).map(([tier,group])=>{
    const performance=group.map(m=>m.myStats).filter(Boolean);
    const kdMatches=performance.filter(s=>s.kills!=null&&s.deaths!=null);
    const kills=kdMatches.reduce((sum,s)=>sum+s.kills,0);
    const deaths=kdMatches.reduce((sum,s)=>sum+s.deaths,0);
    const acsMatches=performance.filter(s=>s.acs!=null);
    const performanceMatches=performance.filter(s=>Number.isFinite(s.performanceScore));
    const wins=group.filter(m=>m.won===true).length,losses=group.filter(m=>m.won===false).length;
    return{tier,stats:{...computeRRStats(group.filter(m=>Number.isFinite(m.myRR))),
      n:group.length,
      winRate:wins+losses?wins/(wins+losses)*100:null,
      kd:deaths>0?kills/deaths:kills>0?kills:null,
      acs:acsMatches.length?acsMatches.reduce((sum,s)=>sum+s.acs,0)/acsMatches.length:null,
      performanceScore:performanceMatches.length?performanceMatches.reduce((sum,s)=>sum+s.performanceScore,0)/performanceMatches.length:null,
    }};
  });
}

/* ── CLUTCHES (1v1–1v5) ─────────────────────────────────── */
// Aggregates myClutchAll (computed per match in processMatch — see the 1vX
// detection block there) across every match in scope. Uses the same match
// scope as the rest of the Stats panel (always counts placement games, all
// party sizes).
function clutchTotals(matches){
  const totals={1:{win:0,loss:0,save:0},2:{win:0,loss:0,save:0},3:{win:0,loss:0,save:0},4:{win:0,loss:0,save:0},5:{win:0,loss:0,save:0}};
  matches.forEach(m=>{
    if(!m.myClutchAll)return;
    for(let t=1;t<=5;t++){
      const s=m.myClutchAll[t];
      if(!s)continue;
      totals[t].win+=s.win||0;totals[t].loss+=s.loss||0;
      totals[t].save+=s.save||0;
    }
  });
  return totals;
}

// Everything the Clutches page shows, from each match's myClutches. Win rate
// here is won ÷ situations, as on the Overview's clutch card (a save is a
// situation that was not won). Matches without round data are counted
// separately so the page can say how much it covers.
const CLUTCH_SPIKE_STATES=[
  ['attack',true,'Attack, spike down','Your team planted before you were left alone: hold the spike'],
  ['attack',false,'Attack, before the plant','No spike down yet: plant or clear the site'],
  ['defense',true,'Defense, spike down','The spike was down: retake and defuse'],
  ['defense',false,'Defense, before the plant','No spike down yet: stop the plant'],
];
function clutchBreakdown(matches){
  const tally=()=>({total:0,win:0,loss:0,save:0,kills:0});
  const add=(t,c)=>{t.total++;t[c.outcome]++;t.kills+=c.kills;};
  const all=tally(),byType={1:tally(),2:tally(),3:tally(),4:tally(),5:tally()};
  const spike=new Map(CLUTCH_SPIKE_STATES.map(([side,down])=>[`${side}:${down}`,tally()]));
  const unknownSpike=tally();
  const byMap=new Map(),byAgent=new Map(),highlights=[];
  let covered=0;
  const group=(map,key,c)=>{if(!key)return;if(!map.has(key))map.set(key,tally());add(map.get(key),c);};
  matches.forEach(m=>{
    if(!Array.isArray(m.myClutches))return;
    covered++;
    m.myClutches.forEach(c=>{
      add(all,c);add(byType[c.type],c);
      const state=c.side&&c.spikeDown!=null?spike.get(`${c.side}:${c.spikeDown}`):null;
      add(state||unknownSpike,c);
      group(byMap,m.mapName??m.map,c);group(byAgent,m.myAgent,c);
      if(c.outcome==='win'&&c.type>=2)highlights.push({...c,matchId:m.matchId,mapName:m.mapName??m.map??null,agent:m.myAgent??null,agentId:m.myAgentId??null,
        startedAtMs:m.startedAtMs??null,myR:m.myR??null,opR:m.opR??null,matchWon:m.won});
    });
  });
  const rate=t=>t.total?t.win/t.total*100:null;
  const rows=map=>[...map].map(([name,t])=>({name,...t,winRate:rate(t)})).sort((a,b)=>b.total-a.total||collatorCompare(a.name,b.name));
  highlights.sort((a,b)=>b.type-a.type||b.kills-a.kills||(b.startedAtMs??0)-(a.startedAtMs??0));
  return{
    matches:matches.length,covered,...all,winRate:rate(all),
    byType:[1,2,3,4,5].map(type=>({type,...byType[type],winRate:rate(byType[type])})),
    bySpike:CLUTCH_SPIKE_STATES.map(([side,down,label,note])=>{const t=spike.get(`${side}:${down}`);return{side,spikeDown:down,label,note,...t,winRate:rate(t)};}),
    unknownSpike:unknownSpike.total,
    byMap:rows(byMap),byAgent:rows(byAgent),highlights,
  };
}
function collatorCompare(a,b){return String(a).localeCompare(String(b));}

/* ── LOBBY RANK ──────────────────────────────────────────── */
function renderRankByRankCard(){
  const available=new Set(statMatches.filter(m=>m.myStats&&m.avgRank!=null&&Math.round(m.avgRank)>=3)
    .map(m=>m.partySize||1));
  lobbyRankPartySize=syncPartySizeOptions('lobby-rank-party-size',available,lobbyRankPartySize);
  const lobbyMatches=lobbyRankPartySize
    ?statMatches.filter(m=>(m.partySize||1)===lobbyRankPartySize)
    :statMatches;
  lobbyRankFilteredMatchCount=lobbyMatches.length;
  lobbyRankData=buildKdRankBuckets(m=>{
    if(m.avgRank==null)return null;
    const tier=Math.round(m.avgRank);
    if(tier<3)return null;
    return{tier,label:avgLabel(tier)};
  },{matches:lobbyMatches});
  partySizeData=buildKdRankBuckets(m=>{
    const size=m.partySize||1;
    return{tier:size,label:PARTY_LABELS[size]||size+'-Stack'};
  },{includeLobby:true});
}

function setLobbyRankPartySize(value){
  const size=Number(value);
  lobbyRankPartySize=[1,2,3,5].includes(size)?size:0;
  renderRankByRankCard();
  emit();
}

// Dot plot: one row per lobby-rank group on a shared rank axis, your team's and
// the enemy team's average rated rank joined by a line, gap labelled in RR.
function lobbyTeamsChartRows(rows){
  return rows.map(b=>{
    const team=b.teamRankCount?b.teamRankSum/b.teamRankCount:null;
    const enemy=b.enemyRankCount?b.enemyRankSum/b.enemyRankCount:null;
    // Rank values move 0.01 per RR (see tierRR), so the gap converts directly,
    // but only below Immortal: once either side averages Immortal 1 or higher
    // (rounds to tier 24+) there are no 100-RR divisions, so the gap keeps its
    // direction and drops the RR figure (see lobbyRR).
    const gap=team!=null&&enemy!=null?Math.round((enemy-team)*100):null;
    const gapInRR=gap!=null&&Math.max(team,enemy)<23.5;
    return{tier:b.tier,total:b.total,team,enemy,gap,gapInRR};
  });
}
function lobbyTeamsGapLabel(gap,inRR=true){
  if(gap==null)return '—';
  if(gap===0)return 'Even';
  return inRR?(gap>0?`Enemy +${gap} RR`:`Team +${-gap} RR`):(gap>0?'Enemy higher':'Team higher');
}

/* ── STATUS ──────────────────────────────────────────────── */
function setStatus(msg,spin=false){
  statusText=msg;
  statusSpin=!!spin;
  emit();
}
function setProgress(pct){
  progressValue=pct;
  emit();
}

// Count the greyed-out placement-week games in the stats (or not). Only the stat
// panels change — the match history and its greying stay exactly as they are.
function toggleIncludeReset(checked){
  mhIncludeReset=!!checked;
  renderStats(true);
}

/* ── MATCH LIST ──────────────────────────────────────────── */
// Public map metadata is optional: match data renders immediately, even offline.
// One request per page, shared by the initial list and subsequent pagination.
let matchMapMetadataPromise=null,matchDetailsId=0;
function loadMatchMapMetadata(){
  if(!matchMapMetadataPromise){
    matchMapMetadataPromise=fetch('https://valorant-api.com/v1/maps',{signal:AbortSignal.timeout(10000)})
      .then(r=>{if(!r.ok)throw new Error('Map metadata unavailable');return r.json();})
      .then(j=>{
        const maps=new Map();
        for(const map of Array.isArray(j.data)?j.data:[]){
          // The full splash stays crisp when the card is scaled on high-DPI
          // displays; listViewIcon is a smaller thumbnail and looked soft.
          const artwork=map.splash||map.stylizedBackgroundImage||map.listViewIcon;
          if(typeof artwork!=='string')continue;
          const url=new URL(artwork);
          if(url.protocol!=='https:'||url.hostname!=='media.valorant-api.com')continue;
          for(const key of [map.displayName,map.uuid,map.mapUrl]){
            if(typeof key==='string')maps.set(key.toLowerCase(),url.href);
          }
        }
        return maps;
      }).catch(()=>new Map());
  }
  return matchMapMetadataPromise;
}
// Agent icons and colours, optional like the map art (22 Nov 2026, for the
// Clutches page). Keyed by lower-case name and UUID. The colour is the first
// of valorant-api's backgroundGradientColors (RRGGBBAA): the dark tint the
// game puts behind the agent, used here as the icon tile's background. Only
// https media.valorant-api.com icons and plain hex colours are kept.
function parseAgentMetadata(j){
  const agents=new Map();
  for(const agent of Array.isArray(j?.data)?j.data:[]){
    if(agent?.isPlayableCharacter===false)continue;
    let icon=null;
    try{
      const url=new URL(agent.displayIconSmall||agent.displayIcon);
      if(url.protocol==='https:'&&url.hostname==='media.valorant-api.com')icon=url.href;
    }catch(_){}
    const hex=agent.backgroundGradientColors?.[0];
    const color=typeof hex==='string'&&/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)?`#${hex.slice(0,6).toLowerCase()}`:null;
    if(!icon&&!color)continue;
    const art={name:agent.displayName,icon,color};
    for(const key of [agent.displayName,agent.uuid])if(typeof key==='string')agents.set(key.toLowerCase(),art);
  }
  return agents;
}
let agentMetadataPromise=null;
function loadAgentMetadata(){
  agentMetadataPromise??=fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true',{signal:AbortSignal.timeout(10000)})
    .then(r=>{if(!r.ok)throw new Error('Agent metadata unavailable');return r.json();})
    .then(parseAgentMetadata).catch(()=>new Map());
  return agentMetadataPromise;
}
// Match MVP is the highest score in the match, Team MVP the highest on each
// team. Since Patch 13.06 (22 Sep 2026) Riot picks the MVP by Performance
// Score, which replaced ACS (support.riotgames.com/valorant/gameplay/
// performance-score). So the score is Performance Score when every player
// has one, and ACS for older matches without it; a partly reported match
// also falls back to ACS rather than mix the two. Riot does not publish its
// tie-break or Team MVP rules: ties keep the first player listed, and each
// team's top player is that team's MVP (an inference from the old ACS rule).
// scorePlaces ranks every scored player by the same score (1 = MVP), ties in
// list order, matching the MVP pick.
function pickMvps(players){
  const withPs=players.filter(p=>Number.isFinite(p._performanceScore));
  const mvpBasis=withPs.length&&withPs.length===players.length?'ps':'acs';
  const score=mvpBasis==='ps'?p=>p._performanceScore:p=>p._acs;
  const scored=mvpBasis==='ps'?withPs:players.filter(p=>p._acs!=null);
  const top=list=>list.length?list.reduce((a,b)=>score(b)>score(a)?b:a).puuid:null;
  const teams=[...new Set(players.map(p=>p.team_id))];
  return{
    mvpBasis:scored.length?mvpBasis:null,
    matchMvpPuuid:top(scored),
    teamMvpPuuids:new Set(teams.map(tid=>top(scored.filter(p=>p.team_id===tid))).filter(Boolean)),
    scorePlaces:new Map([...scored].sort((a,b)=>score(b)-score(a)).map((p,i)=>[p.puuid,i+1])),
  };
}
// A match place as the card writes it: "MVP" for first, otherwise "2nd" …
// "10th".
function placeText(place){
  if(place===1)return 'MVP';
  const tens=place%100,suffix=tens>=11&&tens<=13?'th':({1:'st',2:'nd',3:'rd'})[place%10]||'th';
  return place+suffix;
}
function matchAward(m,puuid){
  const myPuuid=puuid||PUUID||m.players?.find(p=>p.name?.toLowerCase()===PLAYER.toLowerCase()&&p.tag?.toLowerCase()===TAG.toLowerCase())?.puuid;
  if(!myPuuid)return null;
  if(m.matchMvpPuuid===myPuuid)return 'match';
  if(m.teamMvpPuuids?.has(myPuuid))return 'team';
  return null;
}
function matchCardPlayerRank(m){
  const beforeTier=m.myPreTierId??m.myRRDetails?.beforeTier;
  const tier=beforeTier??m.myTierId;
  if(Number.isInteger(tier)&&tier>=0&&tier<=2&&(beforeTier!=null||m.myRankKnown!==false))return{tier:0,rr:null};
  return m.myPreRR!=null?rrPositionFromElo(m.myPreRR,tier):null;
}
function dayHeaderLabel(ms){
  if(ms==null)return 'Unknown date';
  return new Date(ms).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
}

function scoreMarginDistribution(matches){
  // Regulation: 13–0 through 13–11. Overtime wins are always by two;
  // overtime draws have margin zero. There are no normal ±1 finishes.
  // https://playvalorant.com/en-gb/news/game-updates/valorant-patch-notes-1-03/
  // Keep unusual API scores (e.g. early endings) exact rather than clamping
  // them into a valid margin or silently dropping recorded matches.
  const emptyBin=margin=>({margin,count:0,scorelines:new Map()});
  const counts=new Map(Array.from({length:27},(_,i)=>i-13)
    .filter(margin=>Math.abs(margin)!==1).map(margin=>[margin,emptyBin(margin)]));
  let total=0;
  for(const m of matches){
    if(!Number.isInteger(m.myR)||!Number.isInteger(m.opR)||m.myR<0||m.opR<0||m.myR+m.opR===0)continue;
    const margin=m.myR-m.opR;
    if(!counts.has(margin))counts.set(margin,emptyBin(margin));
    const bin=counts.get(margin),scoreline=`${m.myR}–${m.opR}`;
    if(!bin.scorelines.has(scoreline))bin.scorelines.set(scoreline,{scoreline,myR:m.myR,opR:m.opR,count:0});
    const score=bin.scorelines.get(scoreline);
    bin.count++;score.count++;total++;
  }
  const bins=[...counts.values()].sort((a,b)=>a.margin-b.margin).map(bin=>({
    ...bin,
    scorelines:[...bin.scorelines.values()].sort((a,b)=>a.myR-b.myR||a.opR-b.opR),
  }));
  return {bins,total};
}

// Per-day avg lobby rank + total RR change, aggregated across the FULL set
// (mhData) — not just whatever page is currently visible — so a day's figures
// stay correct and stable regardless of Load More.
function renderMatches(){
  mhData=allMatches.slice().sort((a,b)=>(b.startedAtMs??0)-(a.startedAtMs??0));
  mhDayStats={};
  mhData.forEach(m=>{
    const k=m.startedAtMs!=null?new Date(m.startedAtMs).toDateString():'unknown';
    if(!mhDayStats[k])mhDayStats[k]={sum:0,count:0,rrTotal:0,rrCount:0,matches:0,wins:0,losses:0,draws:0};
    mhDayStats[k].matches++;
    if(m.won===true)mhDayStats[k].wins++;
    else if(m.won===false)mhDayStats[k].losses++;
    else mhDayStats[k].draws++;
    if(m.avgRank!=null){
      mhDayStats[k].sum+=m.avgRank;
      mhDayStats[k].count++;
    }
    // myRR is Riot's last_change — the real payout for that match. On a
    // Rank Shield loss this still carries its normal negative value even
    // though the badge didn't drop, so summing it already accounts for
    // shielded losses correctly without any special-casing here.
    if(m.myRR!=null){
      mhDayStats[k].rrTotal+=m.myRR;
      mhDayStats[k].rrCount++;
    }
  });
  emit();
}
function loadMoreMatches(){
  if(mhVisible>=mhData.length)return;
  mhVisible+=PER_PAGE;
  emit();
}

/* ── STARTUP ─────────────────────────────────────────────── */
let _engineStarted=false;
function initEngine({fixture=null}={}){
  if(_engineStarted)return;
  _engineStarted=true;
  window.addEventListener('popstate',()=>{applyPage();loadPlayerFromRoute();});
  proLibraryReady=loadProPlayerLibrary();
  applyPage();
  if(fixture)fixture();
  else loadPlayerFromRoute();
}

// Local UI fixtures (scripts/ui-stress-fixtures.js, ported): loads synthetic
// v4-shaped matches through processMatch with no API calls. Dev builds only.
function loadFixtureAnalysis({player,tag,puuid,season,current,rr,raw,names,mode}){
  PLAYER=player;TAG=tag;PUUID=puuid;TARGET_SEASON=season;REGION='eu';
  searchText=`${player}#${tag}`;
  hasAnalysis=true;
  Object.assign(_rrChangeByMatchId,rr.change);Object.assign(_preRRByMatchId,rr.pre);
  Object.assign(_postRRByMatchId,rr.post);Object.assign(_preTierByMatchId,rr.preTier);
  Object.assign(_postTierByMatchId,rr.postTier);Object.assign(_derankProtectedByMatchId,rr.protected);
  Object.assign(_refundedRRByMatchId,rr.refunded||{});_rrDodges.push(...(rr.dodges||[]).map(rrDodgeEntry).filter(Boolean));
  for(const [id,details] of Object.entries(rr.details))_rrDetailsByMatchId[id]=parseRRDetails(details);
  finalizeHeader(current);
  allMatches=raw.map(processMatch);
  setSeasonMatchCount(TARGET_SEASON,allMatches.length,'found');showSeasonSelect();
  nameHistoryState='ready';nameHistoryRows=names;
  renderAll();
  if(mode==='loading'){allMatches=[];analysisState='loading';setStatus('Loading rank and acts…',true);}
  if(mode==='error'){allMatches=[];analysisState='error';setStatus('');errorMessage='Fixture API unavailable';}
  emit();
}

// One immutable view of the state the React layer reads, rebuilt per version.
let _snapshot=null,_snapshotVersion=-1;
function getSnapshot(){
  if(_snapshotVersion===_version&&_snapshot)return _snapshot;
  _snapshotVersion=_version;
  _snapshot={
    version:_version,
    PLAYER,TAG,REGION,PLATFORM,TARGET_SEASON,PUUID,
    activePage,analysisState,playerRoute,hasAnalysis,
    searchText,statusText,statusSpin,progressValue,errorMessage,
    accentColor,rankColored,headerInfo,headerRevealPending,
    seasonOptions,seasonValue,seasonUi,seasonTriggerLabel:seasonTriggerLabel(),
    seasonOpenSignal,searchShakeSignal,searchFocusSignal,pageFocusSignal,scrollResultsSignal,
    allMatches,statMatches,mhIncludeReset,mhData,mhDayStats,mhVisible,
    overviewStats,serverData,serverSummary,serverPartySize,serverFilteredMatchCount,
    lobbyRankData,partySizeData,lobbyRankPartySize,lobbyRankFilteredMatchCount,
    partySizeAvailability:{...partySizeAvailability},
    allTeammates,allEncounters,
    rrRanges,rrMovementZoomTier,rrDodges:rrActDodges(),
    nameHistoryRows,nameHistoryState,nameHistoryBackfill,nameBackfillBusy,nameBackfillError,
    nameBackfillStopRequested,nameBackfillStopped,nameBackfillPages,
    proLibraryState,proLibraryCount:proLibraryRows.length,
    replayConfig:replayImport.config,
  };
  return _snapshot;
}

export {
  subscribe,getSnapshot,initEngine,loadFixtureAnalysis,
  // actions
  setSearchText,submitSearch,runAnalysis,requestSeasonDropdown,selectSeasonOption,
  analyzeProAccount,proSearchResults,navigateToPage,pageHref,
  toggleIncludeReset,setServerPartySize,setLobbyRankPartySize,
  setRRRange,setRRMovementZoomTier,loadMoreMatches,loadOlderNames,loadNameHistory,
  syncReplayImport,uploadReplay,toggleReplaySteps,replayRowView,replayMatchRows,
  // presentation helpers
  overviewStatValues,PARTY_LABELS,PER_PAGE,MIN_RATED,RANK_MAP,rName,rColor,rClass,avgLabel,avgLabelShort,tierRR,lobbyRR,lobbyRankText,hexToRgb,
  seasonOptionCountText,playerRouteUrl,PUUID_RE,
  nameHistoryActRange,computeWintradeSignals,overviewRecentMatches,decidedWinRate,
  winRateLabel,winRateTone,rrSigned,computeRRStats,isRREligible,rrPositionFromElo,
  rrMovementRows,rrMovementXAxis,rrPayoutEstimates,rrMarginAdjusted,RR_MARGIN_REFERENCE,rrPayoutEvenPoint,rrPayoutSegments,rrScopedMatches,RR_RANGES,
  rrDuoInfo,rrSessionRows,RR_SESSION_BREAK_MS,rrReportedStats,rrAdjustmentStats,rrDodgesInRange,rrDodgeEntry,buildRRScoreRows,rrRankRows,clutchTotals,clutchBreakdown,roundAttackers,lobbyTeamsChartRows,
  lobbyTeamsGapLabel,loadMatchMapMetadata,loadAgentMetadata,parseAgentMetadata,matchAward,pickMvps,placeText,matchCardPlayerRank,dayHeaderLabel,
  scoreMarginDistribution,
};
