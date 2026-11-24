// RR corpus collector (docs/rr-corpus.md, docs/rr-collector-gap-healing.md).
//
// One run is a continuous scheduler for up to ~5.5 hours. Four workers share
// the site's paced proxy and always take the most important task:
//   1. polls that are due, most overdue first relative to each player's own
//      interval (lib/rr-activity.mjs pollingPolicy);
//   2. gap heals: a poll whose live window did not reach the saved history
//      queued an rr_gaps row; /api/rr-heal fills it from HenrikDev's stored
//      RR history. While polls are due, every HEAL_EVERY-th task is a heal;
//   3. with calls to spare: match features for recent payouts and discovery
//      probes of recent opponents.
// Players are re-read from D1 every RELOAD_MS (new enrolments and visitors'
// own fetches count as polls). Once a day the run also scans saved history for
// rank discontinuities and writes the act/tier census (D1 only, paced).
//
// Failures never end the run: a failed poll or heal is retried later in the
// same run, and anything unfinished stays in D1 for the next one. Only a
// configuration error (pacing not deployed, key mismatch) or D1 refusing
// writes stops it, and only those fail the workflow.
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {refreshPlayer,requestJSON} from './refresh-rr-history.mjs';
import {createRequestScheduler} from './request-scheduler.mjs';
import {d1Query,retryOnD1Overload,assertD1Headroom,pacedQuery,PACE_FACTOR,d1Governor,forEachPuuidRange,SLICE_TARGET_MS} from './d1-query.mjs';
import {readQuotaAudit,quotaCheckReport} from './workflow-quota-check.mjs';
import {loadTracked,loadCandidates} from './rr-activity-query.mjs';
import {loadFeatureQueue} from './rr-feature-plan.mjs';
import {loadOpenGaps,gapSummary,readState,writeState,scanGaps} from './rr-gap-queries.mjs';
import {pollingPolicy,comparePolling,selectDiscoveryCandidates} from '../../lib/rr-activity.mjs';

const MINUTE=60000,HOUR=60*MINUTE;
export const RELOAD_MS=30*MINUTE;
export const PLAN_MS=MINUTE;          // due list recomputed at most this often
export const HEAL_EVERY=5;            // while polls are due, one task in five heals
export const RETRY_MS=10*MINUTE;      // a failed poll or heal waits this long in the same run
export const FEATURE_BATCH=500;
export const FEATURE_RELOAD_MS=15*MINUTE;
export const DISCOVERY_LIMIT=40;
export const AUDIT_EVERY_MS=24*HOUR;
const REGIONS=['eu','na','ap','kr','latam','br'];
const fatal=error=>['WORKFLOW_CONFIGURATION','WORKFLOW_STORAGE'].includes(error?.code);
const budget=error=>error?.code==='WORKFLOW_BUDGET';

// One poll through /api/rr-collect. Returns {status:'ok',receipt} |
// {status:'unavailable'} | {status:'failed',reason,retryable}; throws only
// fatal and budget errors.
export async function capturePlayer(player,{origin,fetchImpl,log=console.log,deadline=Infinity,now=Date.now,sleepImpl}){
  try{
    let region=player.region,platform=player.platform;
    if(!region||!platform){
      const discovered=await refreshPlayer(player,{origin,fetchImpl});
      region=discovered.name.data?.region||region;
      platform=discovered.rr.platform||platform;
    }
    if(!region||!platform)return {status:'failed',reason:'region/platform unavailable',retryable:false};
    const collect=()=>requestJSON(`${origin}/api/rr-collect/${region}/${platform}/${player.puuid}`,fetchImpl,sleepImpl,{deadline,now});
    let result=await collect();
    if(result.status===404){
      // The PUUID survives a region transfer; the stored shard may not. This
      // route forces an upstream account refresh. Retry only the reported shard.
      const account=await requestJSON(`${origin}/api/account-by-puuid/${player.puuid}`,fetchImpl,sleepImpl,{deadline,now});
      if(account.ok){
        const fresh=account.data?.region?.toLowerCase();
        if(account.data?.puuid?.toLowerCase()!==player.puuid||!REGIONS.includes(fresh))
          return {status:'failed',reason:'invalid account region response',retryable:false};
        if(fresh!==region){
          log(`RR region changed ${player.puuid}: ${region} -> ${fresh}`);
          region=fresh;player.region=fresh;
          result=await collect();
        }
      }else if(account.status!==404)return {status:'failed',reason:`Region lookup: ${account.reason}`,retryable:Boolean(account.retryable)};
      // The proxy durably recorded the failed probe; polling retries after it.
      if(result.status===404)return {status:'unavailable',region,platform};
    }
    if(!result.ok||result.data?.puuid!==player.puuid||!result.data.checked_at)
      return {status:'failed',reason:result.reason||'invalid collection receipt',retryable:Boolean(result.retryable)};
    player.platform=platform;
    return {status:'ok',receipt:result.data};
  }catch(error){
    if(fatal(error)||budget(error))throw error;
    return {status:'failed',reason:error.message,retryable:true};
  }
}

// A list sweep (discovery probes, tests): every player once, workers in
// parallel, one retry pass for transient failures.
export async function collectPlayers(players,{origin,fetchImpl,log=console.log,concurrency=4,
  deadline=Infinity,now=Date.now,retryPass=true,sleepImpl}){
  let index=0,checked=0,gaps=0;
  const failures=[],unavailable=[];
  async function worker(){
    while(index<players.length&&now()<deadline){
      const player=players[index++];
      let result;
      try{result=await capturePlayer(player,{origin,fetchImpl,log,deadline,now,sleepImpl});}
      catch(error){if(budget(error))break;throw error;}
      if(result.status==='ok'){checked++;gaps+=result.receipt.possible_gap?1:0;}
      else if(result.status==='unavailable'){
        unavailable.push({puuid:player.puuid,region:result.region,platform:result.platform,reason:'upstream_account_unavailable'});
        log(`RR unavailable ${player.puuid}: ${result.region}/${result.platform}; retry after cooldown`);
      }else{failures.push({puuid:player.puuid,reason:result.reason,retryable:result.retryable});log(`RR FAILED ${player.puuid}: ${result.reason}`);}
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,players.length)},worker));
  const retryIds=new Set(failures.filter(f=>f.retryable).map(f=>f.puuid));
  if(retryPass&&retryIds.size&&now()<deadline){
    const retried=await collectPlayers(players.filter(p=>retryIds.has(p.puuid)),{
      origin,fetchImpl,log,concurrency,deadline,now,retryPass:false,sleepImpl});
    for(let i=failures.length-1;i>=0;i--)if(retryIds.has(failures[i].puuid))failures.splice(i,1);
    failures.push(...retried.failures);unavailable.push(...retried.unavailable);checked+=retried.checked;gaps+=retried.gaps;
  }
  return {players:players.length,checked,gaps,failures,unavailable,deferred:players.length-checked-failures.length-unavailable.length};
}

// Fills one gap, page by page. {status} is the gap's new state, 'gone' when
// it was resolved elsewhere, or 'failed' (retried later).
export async function healGap(gap,{origin,fetchImpl,deadline=Infinity,now=Date.now,sleepImpl}){
  let recovered=0;
  for(let page=1;;){
    const result=await requestJSON(`${origin}/api/rr-heal/${gap.puuid}/${gap.after_match_id}?page=${page}`,fetchImpl,sleepImpl,{deadline,now});
    if(result.status===404)return {status:'gone',recovered};
    const data=result.data;
    if(!result.ok||data?.puuid!==gap.puuid||data.after_match_id!==gap.after_match_id)
      return {status:'failed',reason:result.reason||'invalid heal receipt',retryable:result.retryable!==false,recovered};
    recovered+=Number(data.recovered)||0;
    if(data.done)return {status:data.status,recovered,breaks:data.breaks};
    if(!(data.next_page>page))return {status:'failed',reason:'invalid heal page',retryable:true,recovered};
    page=data.next_page;
  }
}

async function collectFeature(row,{origin,fetchImpl,deadline,now,discover}){
  const result=await requestJSON(`${origin}/api/rr-feature/${row.region}/${row.puuid}/${row.match_id}${discover?'?discover=1':''}`,fetchImpl,undefined,{deadline,now});
  const valid=result.ok&&result.data?.match_id===row.match_id&&result.data?.puuid===row.puuid;
  if(valid&&result.data.saved===true)return 'saved';
  if(valid&&result.data.deferred===true&&result.data.reason==='upstream_match_not_found'&&result.data.retry_at)return 'deferred';
  return 'failed';
}

// The scheduler. All D1 reads are injected so tests can run it offline.
export async function runCollector({origin,fetchImpl,deadline,now=Date.now,log=console.log,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),concurrency=4,
  loadPlayers,loadGaps,loadFeatures=async()=>[],loadCandidates:loadProbes=async()=>[],
  featureLimit=FEATURE_BATCH,discoveryLimit=DISCOVERY_LIMIT,reloadMs=RELOAD_MS,sleepImpl}){
  const stats={
    polls:{done:0,failed:0,unavailable:0,newGames:0,gapsFound:0},
    heals:{done:0,failed:0,recovered:0,healed:0,connected:0,incomplete:0,unresolved:0,gone:0},
    features:{saved:0,deferred:0,failed:0},
    discovery:{probed:0,enrolled:0,failed:0},
    reloads:0,failures:[],
  };
  const players=new Map();
  let gaps=[],features=[],probes=null,due=[],planned=0,loaded=0,reloading=false,featuresLoadedAt=-Infinity;
  const busy=new Set(),healing=new Set(),cooling=new Map();
  let sinceHeal=0;
  const keep=list=>stats.failures.length<200&&stats.failures.push(list);

  async function reload(){
    const rows=await loadPlayers();
    for(const row of rows){
      if(!row?.puuid)continue;
      const mine=players.get(row.puuid);
      // A poll this run made may be newer than the D1 read replica.
      if(mine&&Date.parse(mine.checked_at)>(Date.parse(row.checked_at)||0))
        players.set(row.puuid,{...row,checked_at:mine.checked_at,window_from:mine.window_from,
          last_played_at:mine.last_played_at>(row.last_played_at||'')?mine.last_played_at:row.last_played_at});
      else players.set(row.puuid,{...row});
    }
    const open=await loadGaps();
    const key=g=>`${g.puuid}:${g.after_match_id}`;
    const pending=new Set(gaps.map(key));
    for(const gap of open)if(!pending.has(key(gap))&&!healing.has(key(gap)))gaps.push(gap);
    if(probes==null&&discoveryLimit>0){
      try{probes=selectDiscoveryCandidates(await loadProbes(),[...players.values()],discoveryLimit,now());}
      catch(error){probes=[];log(`::warning::Discovery candidates unavailable: ${error.message}`);}
    }
    loaded=now();stats.reloads++;planned=0;
  }
  function plan(){
    const t=now();
    due=[];
    for(const player of players.values()){
      if(busy.has(player.puuid)||(cooling.get(player.puuid)||0)>t)continue;
      const policy=pollingPolicy(player,t);
      if(policy.due)due.push({...player,policy});
    }
    due.sort(comparePolling);
    planned=t;
  }
  async function next(){
    const t=now();
    // One reload at a time: `loaded` moves only when it finishes, so without
    // this every worker that asked meanwhile started its own copy of the
    // player read, and three at once overloaded D1 (24 Nov 2026,
    // docs/rr-collector-d1-load.md). Other workers carry on with the last plan.
    if(!reloading&&t-loaded>=reloadMs){
      reloading=true;
      try{await reload();}catch(error){if(fatal(error))throw error;log(`::warning::Player reload failed: ${error.message}`);loaded=t;}
      finally{reloading=false;}
    }
    if(t-planned>=PLAN_MS)plan();
    const healDue=()=>{const i=gaps.findIndex(g=>(cooling.get(`gap:${g.puuid}:${g.after_match_id}`)||0)<=t&&!busy.has(g.puuid));
      return i<0?null:gaps.splice(i,1)[0];};
    if(due.length&&sinceHeal<HEAL_EVERY-1){
      while(due.length){const p=due.shift();if(!busy.has(p.puuid)){sinceHeal++;return {type:'poll',player:players.get(p.puuid)||p};}}
    }
    const gap=healDue();
    if(gap){sinceHeal=0;return {type:'heal',gap};}
    while(due.length){const p=due.shift();if(!busy.has(p.puuid)){sinceHeal++;return {type:'poll',player:players.get(p.puuid)||p};}}
    if(!features.length&&featureLimit>0&&t-featuresLoadedAt>=FEATURE_RELOAD_MS){
      featuresLoadedAt=t;
      try{features=await loadFeatures(featureLimit);}catch(error){features=[];log(`::warning::Feature queue unavailable: ${error.message}`);}
    }
    if(features.length)return {type:'feature',row:features.shift()};
    if(probes?.length)return {type:'probe',player:probes.shift()};
    return null;
  }

  async function poll(player){
    const result=await capturePlayer(player,{origin,fetchImpl,log,deadline,now,sleepImpl});
    const t=now();
    if(result.status==='ok'){
      const r=result.receipt;
      stats.polls.done++;stats.polls.newGames+=Number(r.new_games)||0;
      const p=players.get(player.puuid)||player;
      p.checked_at=r.checked_at;p.window_from=r.window_from??null;p.failed_probe_at=null;
      if(r.newest_date&&(!p.last_played_at||r.newest_date>p.last_played_at))p.last_played_at=r.newest_date;
      // Until the next reload counts them from D1, new games raise the
      // weekly count so a binge shortens the next interval right away.
      p.games_7d=(Number(p.games_7d)||0)+(Number(r.new_games)||0);
      players.set(p.puuid,p);
      if(r.gap){
        stats.polls.gapsFound++;
        gaps.unshift({puuid:p.puuid,...r.gap,region:p.region,platform:p.platform,source:'window',status:'open',attempts:0,recovered:0});
      }
      if(stats.polls.done%250===0)log(`Polled ${stats.polls.done}; ${due.length} still due; ${gaps.length} gaps queued.`);
    }else if(result.status==='unavailable'){
      stats.polls.unavailable++;
      const p=players.get(player.puuid);if(p)p.failed_probe_at=new Date(t).toISOString();
    }else{
      stats.polls.failed++;keep({type:'poll',puuid:player.puuid,reason:result.reason});
      cooling.set(player.puuid,t+(result.retryable?RETRY_MS:6*HOUR));
      log(`Poll failed ${player.puuid}: ${result.reason}${result.retryable?'; retrying later':''}`);
    }
  }
  async function heal(gap){
    const key=`${gap.puuid}:${gap.after_match_id}`;
    healing.add(key);
    try{
      const result=await healGap(gap,{origin,fetchImpl,deadline,now,sleepImpl});
      stats.heals.recovered+=result.recovered||0;
      if(result.status==='failed'){
        stats.heals.failed++;keep({type:'heal',puuid:gap.puuid,after:gap.after_match_id,reason:result.reason});
        cooling.set(`gap:${key}`,now()+RETRY_MS);gaps.push(gap);
        log(`Heal failed ${key}: ${result.reason}; retrying later`);
      }else{
        stats.heals.done++;
        if(result.status in stats.heals)stats.heals[result.status]++;
        if(result.recovered)log(`Healed ${key}: ${result.recovered} payouts recovered from stored history (${result.status}).`);
      }
    }finally{healing.delete(key);}
  }
  async function feature(row){
    const outcome=await collectFeature(row,{origin,fetchImpl,deadline,now,discover:stats.features.saved+stats.features.deferred<50});
    stats.features[outcome]++;
    if(outcome==='failed')keep({type:'feature',puuid:row.puuid,match:row.match_id});
  }
  async function probe(player){
    const result=await capturePlayer(player,{origin,fetchImpl,log,deadline,now,sleepImpl});
    stats.discovery.probed++;
    if(result.status==='ok')stats.discovery.enrolled++;else if(result.status==='failed')stats.discovery.failed++;
  }

  let stop=null;
  async function worker(){
    while(!stop&&now()<deadline){
      let task;
      try{task=await next();}catch(error){stop=error;break;}
      if(!task){await sleep(Math.min(30000,Math.max(0,deadline-now())));continue;}
      const owner=task.player?.puuid||task.gap?.puuid||task.row?.puuid;
      busy.add(owner);
      try{
        if(task.type==='poll')await poll(task.player);
        else if(task.type==='heal')await heal(task.gap);
        else if(task.type==='feature')await feature(task.row);
        else await probe(task.player);
      }catch(error){
        if(budget(error)){if(task.type==='heal')gaps.push(task.gap);break;}
        if(fatal(error)){stop=error;break;}
        // Anything unexpected stays visible and is retried, never fatal.
        log(`::warning::${task.type} task failed: ${error.message}`);keep({type:task.type,owner,reason:error.message});
        if(task.type==='poll')cooling.set(owner,now()+RETRY_MS);
        if(task.type==='heal'){cooling.set(`gap:${task.gap.puuid}:${task.gap.after_match_id}`,now()+RETRY_MS);gaps.push(task.gap);}
      }finally{busy.delete(owner);}
    }
  }
  // D1 overloads are already retried inside the reads; a network failure at
  // startup gets three more chances before the run gives up.
  for(let attempt=1;;attempt++){
    try{await reload();break;}
    catch(error){
      if(fatal(error)||attempt>=4||now()+30000>=deadline)throw error;
      log(`::warning::Initial player load failed (${error.message}); retrying in 30 s.`);await sleep(30000);
    }
  }
  plan();
  log(`Tracking ${players.size} accounts; ${due.length} due now; ${gaps.length} gaps to heal; ${probes?.length||0} discovery probes.`);
  await Promise.all(Array.from({length:concurrency},worker));
  if(stop)throw stop;
  // What the next run starts with.
  plan();
  const t=now(),cohorts={},overdue={};let late=0;
  for(const player of players.values()){
    const policy=pollingPolicy(player,t);
    cohorts[policy.cohort]=(cohorts[policy.cohort]||0)+1;
    if(policy.urgency>=2){late++;overdue[policy.cohort]=(overdue[policy.cohort]||0)+1;}
  }
  return {...stats,tracked:players.size,cohorts,
    backlog:{due:due.length,overdue2x:late,overdueByCohort:overdue,gapsQueued:gaps.length,
      featuresQueued:features.length,probesLeft:probes?.length||0}};
}

// ── Daily audit: act/tier census and gap scan (D1 only) ──
// The census parses every rr_history row. As one statement it overloaded D1
// (7429) and blocked the site's queries; it runs in PUUID slices, paced by
// the D1 time each slice reported (docs/rr-collector-d1-load.md). A PUUID
// falls in exactly one slice, so per-slice distinct players add up.
const RANK_SUMS=['payouts','players','placements','with_features','gains','losses','reported_start','bonus_known',
  'bonus_nonzero','afk_penalty_known','rr_penalty_known','map_forgiveness_known','placement_known','stored'];
export function mergeRankSlices(slices){
  const groups=new Map();
  for(const rows of slices)for(const row of rows){
    const key=JSON.stringify([row.season_id,row.act,row.ending_tier]);
    const group=groups.get(key);
    if(!group){groups.set(key,{...row});continue;}
    for(const field of RANK_SUMS)group[field]=(Number(group[field])||0)+(Number(row[field])||0);
    if(row.first_game!=null&&(group.first_game==null||row.first_game<group.first_game))group.first_game=row.first_game;
    if(row.latest_game!=null&&(group.latest_game==null||row.latest_game>group.latest_game))group.latest_game=row.latest_game;
  }
  // Match SQLite's ORDER BY act,ending_tier: NULLs first, then ascending.
  const order=(a,b)=>a===b?0:a==null?-1:b==null?1:a<b?-1:1;
  return [...groups.values()].sort((a,b)=>order(a.act,b.act)||order(a.ending_tier,b.ending_tier));
}
// The first guess at the number of PUUID ranges; they then resize to about
// SLICE_TARGET_MS of D1 time each (forEachPuuidRange). One 1/64 range
// measured 248 ms on 23 Nov 2026.
export const CENSUS_SLICES=64;
const rankSliceSql=where=>`SELECT json_extract(h.data,'$.season.id') AS season_id,
    json_extract(h.data,'$.season.short') AS act,json_extract(h.data,'$.tier.id') AS ending_tier,
    COUNT(*) AS payouts,COUNT(DISTINCT h.puuid) AS players,
    MIN(h.date) AS first_game,MAX(h.date) AS latest_game,
    SUM(CASE WHEN json_extract(h.data,'$.is_placement_match')=1 THEN 1 ELSE 0 END) AS placements,
    SUM(CASE WHEN f.match_id IS NOT NULL THEN 1 ELSE 0 END) AS with_features,
    SUM(CASE WHEN json_extract(h.data,'$.last_change')>0 THEN 1 ELSE 0 END) AS gains,
    SUM(CASE WHEN json_extract(h.data,'$.last_change')<0 THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN json_type(h.data,'$.tier_before_update.id')='integer' AND json_type(h.data,'$.rr_before_update') IN ('integer','real') THEN 1 ELSE 0 END) AS reported_start,
    SUM(CASE WHEN json_type(h.data,'$.rr_performance_bonus') IN ('integer','real') THEN 1 ELSE 0 END) AS bonus_known,
    SUM(CASE WHEN json_extract(h.data,'$.rr_performance_bonus')<>0 THEN 1 ELSE 0 END) AS bonus_nonzero,
    SUM(CASE WHEN json_type(h.data,'$.afk_penalty') IN ('integer','real') THEN 1 ELSE 0 END) AS afk_penalty_known,
    SUM(CASE WHEN json_type(h.data,'$.rr_penalty') IN ('integer','real') THEN 1 ELSE 0 END) AS rr_penalty_known,
    SUM(CASE WHEN json_type(h.data,'$.new_map_incentive_rr_forgiven') IN ('integer','real') THEN 1 ELSE 0 END) AS map_forgiveness_known,
    SUM(CASE WHEN json_type(h.data,'$.is_placement_match') IN ('true','false') THEN 1 ELSE 0 END) AS placement_known,
    SUM(CASE WHEN json_extract(h.data,'$.vlravg_source')='stored-mmr-history' THEN 1 ELSE 0 END) AS stored
    FROM rr_history h LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
    ${where}
    GROUP BY season_id,act,ending_tier`;

export async function corpusReport(env,query=retryOnD1Overload(d1Query),
  {slices=CENSUS_SLICES,targetMs=SLICE_TARGET_MS,pauseMs=500,factor=PACE_FACTOR,sleep}={}){
  const paced=pacedQuery(query,{factor,minPauseMs:pauseMs,sleep});
  const results=[];
  const ranges=await forEachPuuidRange(async(lo,hi)=>{
    const rows=await paced(env,rankSliceSql('WHERE h.puuid>=?1 AND h.puuid<?2'),[lo,hi]);
    results.push(rows);
    return rows;
  },{parts:slices,targetMs});
  const ranks=mergeRankSlices(results);
  const latest=ranks.filter(row=>row.season_id&&row.latest_game).sort((a,b)=>Date.parse(b.latest_game)-Date.parse(a.latest_game))[0];
  const currentRows=latest?ranks.filter(row=>row.season_id===latest.season_id):[];
  const currentAct=latest?{id:latest.season_id,act:latest.act,
    first_game:currentRows.map(row=>row.first_game).sort()[0],latest_game:latest.latest_game,
    payouts:currentRows.reduce((n,row)=>n+row.payouts,0),placements:currentRows.reduce((n,row)=>n+row.placements,0)}:null;
  const competitiveUpdates={};
  for(const field of ['payouts','reported_start','bonus_known','bonus_nonzero','afk_penalty_known','rr_penalty_known','map_forgiveness_known','placement_known','stored']){
    competitiveUpdates[field]=ranks.reduce((sum,row)=>sum+(Number(row[field])||0),0);
  }
  return {at:new Date().toISOString(),currentAct,ranks,competitiveUpdates,ranges,
    note:'Rank buckets use ending tier for collection monitoring. Model evaluation reconstructs starting rank and excludes ambiguous rows. "stored" counts payouts filled from stored RR history.'};
}

// Runs at most once a day, recorded in rr_collector_state, beside the polling.
export async function dailyAudit(env,{log=console.log,read=readState,write=writeState,scan=scanGaps,census=corpusReport}={}){
  const last=await read(env,'audit_at');
  if(last&&Date.now()-Date.parse(last.value)<AUDIT_EVERY_MS)return {skipped:true,last:last.value};
  const scanned=await scan(env);
  log(`Gap scan: ${scanned.found} rank discontinuities queued for healing.`);
  const report=await census(env);
  await write(env,'audit_at',new Date().toISOString());
  return {skipped:false,gapScan:scanned,...report};
}

export async function main(env=process.env){
  if(!env.HENRIK_WORKFLOW_KEY)throw new Error('Missing required secret: HENRIK_WORKFLOW_KEY');
  const origin=new URL(env.SITE_ORIGIN||'https://vlravg1.pages.dev').origin;
  const runtime=Number(env.RUNTIME_MINUTES||330);
  if(!Number.isSafeInteger(runtime)||runtime<10||runtime>345)throw new Error('RUNTIME_MINUTES must be between 10 and 345');
  const featureLimit=Number(env.DETAIL_LIMIT??FEATURE_BATCH);
  if(!Number.isSafeInteger(featureLimit)||featureLimit<0||featureLimit>5000)throw new Error('Invalid DETAIL_LIMIT');
  // A full database rejects every save after the upstream call has spent
  // quota, so do not start.
  await assertD1Headroom(env);
  const started=Date.now();
  const deadline=started+(runtime-5)*MINUTE; // five minutes for the audit tail and report
  const runId=env.GITHUB_RUN_ID?`${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT||1}:${randomUUID()}`:randomUUID();
  const quotaBefore=await readQuotaAudit(env,runId);
  const fetchImpl=createRequestScheduler({workflowKey:env.HENRIK_WORKFLOW_KEY,origin,runId,serialize:true,inFlight:3,deadline});
  const report={startedAt:new Date(started).toISOString(),runtimeMinutes:runtime};
  await mkdir('.local/rr-corpus',{recursive:true});
  // The daily audit only reads and writes D1 (paced); it runs beside polling.
  const audit=dailyAudit(env).catch(error=>({error:error.message}));
  let fatalError=null;
  try{
    Object.assign(report,await runCollector({origin,fetchImpl,deadline,
      loadPlayers:()=>loadTracked(env),loadGaps:()=>loadOpenGaps(env),
      loadFeatures:limit=>loadFeatureQueue(env,limit),loadCandidates:()=>loadCandidates(env),featureLimit}));
  }catch(error){
    if(!fatal(error))throw error;
    fatalError=error;report.fatal={code:error.code,message:error.message};
    console.error(`::error::${error.message}`);
  }
  report.audit=await audit;
  if(report.audit?.error)console.warn(`::warning::Daily audit failed: ${report.audit.error}`);
  try{report.gaps=await gapSummary(env);}catch(error){report.gaps={error:error.message};}
  report.upstreamPools={...fetchImpl.pools};
  report.quotaCheck=quotaCheckReport(quotaBefore,await readQuotaAudit(env,runId));
  if(['other_proxy_activity','possible_external_usage'].includes(report.quotaCheck.status))
    console.warn(`::warning::Workflow key may be shared: ${report.quotaCheck.otherProxyCalls} other proxy calls; ${report.quotaCheck.unexplainedRequests} unexplained quota units.`);
  if(report.backlog?.overdue2x)console.warn(`::warning::${report.backlog.overdue2x} accounts are more than twice their polling interval overdue; their gaps are healed from stored history.`);
  // Collection is continuous: the next run waits in the concurrency group.
  // A configuration or storage stop does not chain into a loop of failures.
  report.chainNext=!fatalError;
  // This run's D1 statements through the governor: count, D1 time, the slowest.
  report.d1={...d1Governor().stats,busyMs:Math.round(d1Governor().stats.busyMs)};
  report.elapsedMinutes=Math.round((Date.now()-started)/MINUTE);
  report.at=new Date().toISOString();
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,`chain=${report.chainNext}\n`);
  await writeFile('.local/rr-corpus/collection-report.json',JSON.stringify(report,null,2));
  const {ranks,...summary}=report.audit||{};
  console.log(JSON.stringify({...report,audit:{...summary,ranks:ranks?.length}}));
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,stepSummary(report));
  if(fatalError)process.exitCode=1;
  return report;
}

export function stepSummary(r){
  const p=r.polls||{},h=r.heals||{},f=r.features||{},b=r.backlog||{},g=r.gaps||{};
  return `## RR corpus\n\n`+
    (r.fatal?`**Stopped:** ${r.fatal.message}\n\n`:'')+
    `${p.done??0} polls committed (${p.newGames??0} new payouts), ${p.failed??0} failed and retried, ${p.unavailable??0} accounts unavailable. `+
    `${p.gapsFound??0} windows did not reach the saved history.\n\n`+
    `Gap heals: ${h.done??0} finished (${h.healed??0} healed, ${h.connected??0} had no missing games, ${h.incomplete??0} retry later, ${h.unresolved??0} unresolved), `+
    `${h.recovered??0} payouts recovered from stored history, ${h.failed??0} failed and retried.\n\n`+
    `Match features: ${f.saved??0} saved, ${f.deferred??0} deferred by upstream, ${f.failed??0} errors. Discovery: ${r.discovery?.enrolled??0} of ${r.discovery?.probed??0} probes enrolled.\n\n`+
    `Next run starts with ${b.due??'?'} polls due (${b.overdue2x??'?'} over twice their interval) and ${b.gapsQueued??'?'} gaps queued, of ${r.tracked??'?'} tracked accounts.\n\n`+
    `All gaps: ${g.total??'?'} (${JSON.stringify(g.byStatus||{})}); ${g.recovered??'?'} payouts recovered in total.\n\n`+
    `Upstream calls: ${r.upstreamPools?.workflow??0} on the workflow key, ${r.upstreamPools?.public??0} on borrowed idle site-key slots. Quota check: ${r.quotaCheck?.status}.\n`+
    (r.audit&&!r.audit.skipped&&!r.audit.error?`\nDaily audit: ${r.audit.gapScan?.found??0} discontinuities queued; observed act ${r.audit.currentAct?.act||r.audit.currentAct?.id||'unknown'} with ${r.audit.currentAct?.payouts??0} payouts.\n`:'');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
