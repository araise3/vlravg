const HOUR=3600000,DAY=24*HOUR;

// Polling intervals (docs/rr-collector-gap-healing.md). The live window lists
// the ranked games among a player's last 20 matches, so a poll should come
// before 20 more. Measured on the 3,531 players tracked continuously since
// October (saved games 25 Oct-19 Nov 2026), the share of moments after which
// a player played 21+ ranked games within the interval, per 10,000:
//   7-day games  35+: 12h 0-1.3   16h 15-38
//                15-34: 12h 0-0.3  16h 0-1.5   24h 3-10
//                 5-14: 16h 0-0.9  24h 0-5.6
//                  1-4: 24h 0-3.4  36h 0.5-30
//   none in 7 days, played in 30: 48h 7.5 | none in 30: 72h 46
// A missed poll is no longer a lost game: the window that fails to reach the
// saved history records a gap, healed from HenrikDev's stored RR history. The
// intervals keep those heals rare and fit the workflow key (~40k calls/day;
// these need ~29k for the 23,392 players tracked on 23 Nov 2026).
export const POLL_HOURS={heavy:12,regular:16,casual:24,light:24,quiet:48,inactive:72};
// Unrated, swiftplay or deathmatch games push ranked ones out of the window
// too. Its oldest ranked game bounds how long the last 20 matches took, so a
// window that turned over within S hours is polled again within S hours.
export const TURNOVER_MIN_HOURS=4;

export function activityCohort(player,now=Date.now()){
  const games=Number(player.games_7d)||0;
  if(games>=35)return 'heavy';
  if(games>=15)return 'regular';
  if(games>=5)return 'casual';
  if(games>=1)return 'light';
  const played=Date.parse(player.last_played_at);
  return Number.isFinite(played)&&now-played<=30*DAY?'quiet':'inactive';
}
// The discovery target counts frequent players: 10+ games in a week and one
// in the last two days.
export const isFrequent=(player,now=Date.now())=>(Number(player.games_7d)||0)>=10&&
  now-Date.parse(player.last_played_at)<=2*DAY;

export function pollingPolicy(player,now=Date.now()){
  const checked=Date.parse(player.checked_at);
  const observed=Date.parse(player.candidate_observed_at);
  const rosterGame=Date.parse(player.candidate_played_at);
  const failed=Date.parse(player.failed_probe_at);
  const cohort=activityCohort(player,now);
  let intervalHours=POLL_HOURS[cohort];
  const from=Date.parse(player.window_from);
  if(Number.isFinite(checked)&&Number.isFinite(from)&&checked>from)
    intervalHours=Math.min(intervalHours,Math.max(TURNOVER_MIN_HOURS,(checked-from)/HOUR));
  // Upstream could not find the account (404) even after a region check: the
  // proxy recorded the failed probe. Retry after the interval, at most a day.
  if(Number.isFinite(failed)&&(!Number.isFinite(checked)||failed>checked)){
    const hours=Math.min(24,intervalHours);
    const newRoster=Number.isFinite(observed)&&observed>failed&&Number.isFinite(rosterGame)&&now-rosterGame<=2*DAY;
    const urgency=(now-failed)/(hours*HOUR);
    return {cohort:'region-recheck',intervalHours:hours,due:urgency>=1||newRoster,urgency:newRoster?Math.max(urgency,1):urgency};
  }
  if(!Number.isFinite(checked))return {cohort:'unassessed',intervalHours,due:true,urgency:2};
  const urgency=(now-checked)/(intervalHours*HOUR);
  // Fresh, previously unseen roster evidence or a newly observed act wakes an
  // account before its interval ends, once.
  const wake=Number.isFinite(observed)&&observed>checked&&Number.isFinite(rosterGame)&&now-rosterGame<=2*DAY;
  const seasonStart=Date.parse(player.season_started_at);
  const season=Number.isFinite(seasonStart)&&seasonStart<=now&&checked<seasonStart;
  if(wake||season)return {cohort:wake?'reactivated':'season-assessment',intervalHours,due:true,urgency:Math.max(urgency,1)};
  return {cohort,intervalHours,due:urgency>=1,urgency};
}

// Most overdue first, relative to each player's own interval, so a short
// interval cannot starve a long one when calls run short. No count cap.
export function comparePolling(a,b){
  return b.policy.urgency-a.policy.urgency||a.policy.intervalHours-b.policy.intervalHours||
    (Number(b.games_7d)||0)-(Number(a.games_7d)||0)||
    (a.checked_at||'').localeCompare(b.checked_at||'')||a.puuid.localeCompare(b.puuid);
}
export function selectPollingPlayers(players,now=Date.now(),limit=Infinity){
  return players.map(p=>({...p,policy:pollingPolicy(p,now)})).filter(p=>p.policy.due).sort(comparePolling).slice(0,limit);
}

// Benchmark samples need 20+ clean games per player, act and outcome, which
// mostly come from frequent players. On 2026-10-28 the tracked pool was already
// balanced (276 Iron .. 666 Immortal), but frequent players were not (59 Iron,
// 115 Bronze vs 259 Immortal). Low-rank players also average fewer games per act,
// so bands are balanced by frequent players and stop drawing probes at a target.
export const DISCOVERY_BAND_TARGET=250;

// Give thin rank bands a turn, then prioritize observed activity within a band.
export function selectDiscoveryCandidates(candidates,players,limit=40,now=Date.now()){
  const tracked=new Set(players.map(p=>p.puuid));
  const bands=new Map(),coverage=new Map();
  for(const p of players)if(isFrequent(p,now)){
    const band=Math.floor(((Number(p.tier)||3)-3)/3);
    coverage.set(band,(coverage.get(band)||0)+1);
  }
  for(const p of candidates){
    if(tracked.has(p.puuid)||!Number.isFinite(Date.parse(p.last_played_at))||now-Date.parse(p.last_played_at)>2*DAY)continue;
    const band=Math.floor((p.tier-3)/3);
    if(!bands.has(band))bands.set(band,[]);
    bands.get(band).push(p);
  }
  for(const list of bands.values())list.sort((a,b)=>b.games_7d-a.games_7d||b.last_played_at.localeCompare(a.last_played_at)||a.puuid.localeCompare(b.puuid));
  for(const band of [...bands.keys()])if((coverage.get(band)||0)>=DISCOVERY_BAND_TARGET)bands.delete(band);
  const selected=[];
  while(selected.length<limit&&bands.size){
    const [band,list]=[...bands.entries()].sort(([a],[b])=>(coverage.get(a)||0)-(coverage.get(b)||0)||a-b)[0];
    selected.push(list.shift());coverage.set(band,(coverage.get(band)||0)+1);
    if(!list.length||coverage.get(band)>=DISCOVERY_BAND_TARGET)bands.delete(band);
  }
  return selected;
}

// Server-only input: never take roster contents from the browser.
export async function discoverMatchPlayers(db,match,{puuid,region,platform},stamp=new Date().toISOString()){
  const date=match?.metadata?.started_at;
  const time=Date.parse(date),now=Date.parse(stamp);
  if(!['pc','console'].includes(platform)||!['eu','na','ap','kr','latam','br'].includes(region)||
    !Number.isFinite(time)||time>now+300000||now-time>2*DAY)return 0;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // New-act placement rosters can report Unrated (0). A trusted competitive
  // match still proves activity; do not lose these players during the reset.
  const competitive=match.metadata.queue?.id==='competitive';
  const statements=(match.players||[]).filter(p=>uuid.test(p.puuid||'')&&p.puuid.toLowerCase()!==puuid&&
      (p.tier?.id>=3||(competitive&&p.tier?.id===0)))
    .map(p=>db.prepare('INSERT OR IGNORE INTO rr_candidate_games(puuid,platform,match_id,region,tier,played_at,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(p.puuid.toLowerCase(),platform,match.metadata.match_id,region,p.tier.id,new Date(time).toISOString(),stamp));
  if(statements.length)await db.batch(statements);
  return statements.length;
}
