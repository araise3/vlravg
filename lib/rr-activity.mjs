const HOUR=3600000,DAY=24*HOUR;
export function pollingPolicy(player,now=Date.now()){
  const played=Date.parse(player.last_played_at);
  const checked=Date.parse(player.checked_at);
  const observed=Date.parse(player.candidate_observed_at);
  const rosterGame=Date.parse(player.candidate_played_at);
  // Fresh, previously unseen roster evidence wakes up a paused account once.
  const wake=Number.isFinite(observed)&&Number.isFinite(rosterGame)&&now-rosterGame<=2*DAY&&
    (!Number.isFinite(checked)||observed>checked);
  if(!Number.isFinite(played)||now-played>7*DAY){
    const initial=!Number.isFinite(checked)&&!Number.isFinite(played);
    return {cohort:wake?'reactivated':initial?'unassessed':'inactive',due:wake||initial,intervalHours:null};
  }
  const games=Number(player.games_7d)||0;
  const intervalHours=now-played<=2*DAY&&games>=10?4:now-played<=3*DAY&&games>=3?12:24;
  return {cohort:intervalHours===4?'frequent':intervalHours===12?'regular':'occasional',intervalHours,
    due:!Number.isFinite(checked)||now-checked>=intervalHours*HOUR};
}

export function selectPollingPlayers(players,now=Date.now()){
  return players.map(p=>({...p,policy:pollingPolicy(p,now)})).filter(p=>p.policy.due)
    .sort((a,b)=>(a.policy.intervalHours||4)-(b.policy.intervalHours||4)||
      (Number(b.games_7d)||0)-(Number(a.games_7d)||0)||
      (a.checked_at||'').localeCompare(b.checked_at||'')||a.puuid.localeCompare(b.puuid));
}

// Give thin rank bands a turn, then prioritize observed activity within a band.
export function selectDiscoveryCandidates(candidates,players,limit=25,now=Date.now()){
  const tracked=new Set(players.map(p=>p.puuid));
  const bands=new Map(),coverage=new Map();
  for(const p of players)if(pollingPolicy(p,now).cohort!=='inactive'){
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
  const selected=[];
  while(selected.length<limit&&bands.size){
    const [band,list]=[...bands.entries()].sort(([a],[b])=>(coverage.get(a)||0)-(coverage.get(b)||0)||a-b)[0];
    selected.push(list.shift());coverage.set(band,(coverage.get(band)||0)+1);
    if(!list.length)bands.delete(band);
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
  const statements=(match.players||[]).filter(p=>uuid.test(p.puuid||'')&&p.puuid.toLowerCase()!==puuid&&p.tier?.id>=3)
    .map(p=>db.prepare('INSERT OR IGNORE INTO rr_candidate_games(puuid,platform,match_id,region,tier,played_at,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(p.puuid.toLowerCase(),platform,match.metadata.match_id,region,p.tier.id,new Date(time).toISOString(),stamp));
  if(statements.length)await db.batch(statements);
  return statements.length;
}
