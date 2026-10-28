const HOUR=3600000,DAY=24*HOUR;
export function pollingPolicy(player,now=Date.now()){
  const played=Date.parse(player.last_played_at);
  const checked=Date.parse(player.checked_at);
  const observed=Date.parse(player.candidate_observed_at);
  const rosterGame=Date.parse(player.candidate_played_at);
  const failed=Date.parse(player.failed_probe_at);
  if(Number.isFinite(failed)&&(!Number.isFinite(checked)||failed>checked)){
    const newRoster=Number.isFinite(observed)&&observed>failed&&Number.isFinite(rosterGame)&&now-rosterGame<=2*DAY;
    return {cohort:'region-recheck',due:now-failed>=DAY||newRoster,intervalHours:24};
  }
  // Fresh, previously unseen roster evidence wakes up a paused account once.
  const wake=Number.isFinite(observed)&&Number.isFinite(rosterGame)&&now-rosterGame<=2*DAY&&
    (!Number.isFinite(checked)||observed>checked);
  // Henrik keeps ~20 payouts, so a poll must come before 20 more games. In
  // production RR (Oct 6-28, 3,206 players) nobody reached 20 games within
  // 8 hours (max 15; 13 within 6 hours), while 28 did within 12 hours and 151
  // within 24. Recently active players therefore get 6 or 8 hours. Quiet
  // accounts are still checked, because players returning from a break lost
  // whole windows when only roster evidence could wake them.
  if(!Number.isFinite(played)||now-played>7*DAY){
    const initial=!Number.isFinite(checked)&&!Number.isFinite(played);
    const seasonStart=Date.parse(player.season_started_at);
    const seasonAssessment=Number.isFinite(seasonStart)&&seasonStart<=now&&(!Number.isFinite(checked)||checked<seasonStart);
    const intervalHours=Number.isFinite(played)&&now-played<=30*DAY?24:72;
    const routine=!Number.isFinite(checked)||now-checked>=intervalHours*HOUR;
    return {cohort:wake?'reactivated':initial?'unassessed':seasonAssessment?'season-assessment':intervalHours===24?'dormant':'inactive',
      due:wake||initial||seasonAssessment||routine,intervalHours};
  }
  const games=Number(player.games_7d)||0;
  const intervalHours=now-played<=2*DAY&&games>=10?6:8;
  return {cohort:intervalHours===6?'frequent':'active',intervalHours,
    due:!Number.isFinite(checked)||now-checked>=intervalHours*HOUR};
}

// No count cap: capture is irreplaceable, so the run deadline bounds it and
// match details only use time left after every due account is polled.
export function selectPollingPlayers(players,now=Date.now(),limit=Infinity){
  const overdue=p=>{
    const checked=Date.parse(p.checked_at);
    return Number.isFinite(checked)?(now-checked)/((p.policy.intervalHours||4)*HOUR):1000;
  };
  return players.map(p=>({...p,policy:pollingPolicy(p,now)})).filter(p=>p.policy.due)
    .sort((a,b)=>overdue(b)-overdue(a)||(a.policy.intervalHours||4)-(b.policy.intervalHours||4)||
      (Number(b.games_7d)||0)-(Number(a.games_7d)||0)||
      (a.checked_at||'').localeCompare(b.checked_at||'')||a.puuid.localeCompare(b.puuid)).slice(0,limit);
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
  for(const p of players)if(pollingPolicy(p,now).cohort==='frequent'){
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
