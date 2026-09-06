export const BACKFILL_LIMIT = 10000;

export async function backfillState(db, puuid) {
  const player = await db.prepare('SELECT region,platform FROM rr_players WHERE puuid=?1').bind(puuid).first();
  if (!player?.region || !player?.platform) return { available: false, complete: false, next_start: 0 };
  const row = await db.prepare('SELECT next_start,complete FROM player_name_backfill WHERE puuid=?1 AND region=?2 AND platform=?3')
    .bind(puuid, player.region, player.platform).first();
  const next_start = row?.next_start || 0;
  return { ...player, available: true, next_start, complete: !!row?.complete, limited: next_start >= BACKFILL_LIMIT && !row?.complete };
}

export function matchNameEvidence(matches, puuid, now = Date.now()) {
  if (!Array.isArray(matches) || matches.length > 10) throw new Error('Invalid match page');
  const valid = [];
  for (const match of matches) {
    if (!match?.metadata?.match_id || !Array.isArray(match.players)) throw new Error('Invalid match record');
    const player = match.players.find(p => p.puuid?.toLowerCase() === puuid);
    // Never attribute a roster mate's name, account lookup, or input name to a match.
    if (!player) throw new Error('Player missing from match');
    const stamp = Date.parse(match.metadata.started_at);
    if (!Number.isFinite(stamp) || stamp > now || stamp < Date.UTC(2020,0,1)) throw new Error('Invalid match date');
    if (![player.name,player.tag].every(v => typeof v === 'string' && v.trim())) continue;
    valid.push({match_id:match.metadata.match_id,name:player.name,tag:player.tag,played_at:new Date(stamp).toISOString()});
  }
  // Ten unchanged match rows carry only two useful facts for a date range: the
  // earliest and latest dates. Keep both endpoints of each consecutive ID run.
  // Sorting makes this independent of the upstream page's ordering. A one-match
  // run remains one row, so brief or reused names are still preserved.
  valid.sort((a,b)=>a.played_at.localeCompare(b.played_at)||a.match_id.localeCompare(b.match_id));
  const evidence=[];
  for(let start=0;start<valid.length;){
    let end=start;
    while(end+1<valid.length&&valid[end+1].name===valid[start].name&&valid[end+1].tag===valid[start].tag)end++;
    evidence.push(valid[start]);
    if(end!==start)evidence.push(valid[end]);
    start=end+1;
  }
  return evidence;
}

export function compactMatchEvidence(rows) {
  const sorted=[...rows].map(({name,tag,played_at})=>({name,tag,played_at}))
    .sort((a,b)=>a.played_at.localeCompare(b.played_at)||a.name.localeCompare(b.name)||a.tag.localeCompare(b.tag));
  const periods=[];
  for(const row of sorted){
    const last=periods.at(-1);
    if(last&&last.name===row.name&&last.tag===row.tag)last.last_seen=row.played_at;
    else periods.push({name:row.name,tag:row.tag,first_seen:row.played_at,last_seen:row.played_at});
  }
  return periods.flatMap(period=>period.first_seen===period.last_seen
    ?[{name:period.name,tag:period.tag,played_at:period.first_seen}]
    :[{name:period.name,tag:period.tag,played_at:period.first_seen},{name:period.name,tag:period.tag,played_at:period.last_seen}]);
}

export function parseCompactMatchEvidence(value) {
  let rows;
  try{rows=JSON.parse(value||'[]');}catch{throw new Error('Invalid compact name evidence');}
  if(!Array.isArray(rows)||rows.some(row=>![row?.name,row?.tag,row?.played_at].every(v=>typeof v==='string'&&v)))
    throw new Error('Invalid compact name evidence');
  return compactMatchEvidence(rows);
}

export async function saveBackfillPage(db, puuid, state, matches, now = Date.now()) {
  const pageEvidence=matchNameEvidence(matches,puuid,now);
  const saved=await db.prepare(`SELECT next_start,evidence FROM player_name_backfill
    WHERE puuid=?1 AND region=?2 AND platform=?3`).bind(puuid,state.region,state.platform).first();
  // A concurrent request already advanced this player. Return its state without
  // spending another write or mixing evidence from a stale cursor into the scan.
  if(saved&&saved.next_start!==state.next_start)return backfillState(db,puuid);
  const evidence=compactMatchEvidence([
    ...(saved?parseCompactMatchEvidence(saved.evidence):[]),
    ...pageEvidence,
  ]);
  // Evidence now lives in the cursor row as compact period endpoints. One atomic
  // write replaces the old evidence-row inserts plus their two index updates,
  // while keeping exact first/last observations and A -> B -> A name reuse.
  await db.prepare(`INSERT INTO player_name_backfill(puuid,region,platform,next_start,complete,updated_at,evidence)
    VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(puuid,region,platform) DO UPDATE SET
    next_start=excluded.next_start,complete=excluded.complete,updated_at=excluded.updated_at,evidence=excluded.evidence
    WHERE player_name_backfill.next_start=?8 AND player_name_backfill.complete=0`)
    .bind(puuid,state.region,state.platform,state.next_start+matches.length,matches.length===0?1:0,
      new Date(now).toISOString(),JSON.stringify(evidence),state.next_start).run();
  return backfillState(db,puuid);
}

// Match evidence only fills the time BEFORE the first live observation. Later
// matches cannot split a verified period or mark an old name as current.
export function mergeNameTimeline(live, matches) {
  const checks = [...live].sort((a,b)=>a.first_seen.localeCompare(b.first_seen));
  const cutoff = checks[0]?.first_seen || '';
  const older = matches.filter(m=>m.played_at<cutoff).sort((a,b)=>a.played_at.localeCompare(b.played_at));
  const periods=[];
  for (const m of older) {
    const last=periods.at(-1);
    if(last && last.name===m.name && last.tag===m.tag) last.last_seen=m.played_at;
    else periods.push({name:m.name,tag:m.tag,first_seen:m.played_at,last_seen:m.played_at,ended_at:m.played_at,source:'Matches'});
  }
  for (const check of checks) {
    const last=periods.at(-1);
    if(last?.source==='Matches' && last.name===check.name && last.tag===check.tag) {
      Object.assign(last,{last_seen:check.last_seen,ended_at:check.ended_at,source:'Matches + checks'});
    } else periods.push({...check,source:'Checks'});
  }
  for(let i=0;i<periods.length-1;i++) if(periods[i].source==='Matches') periods[i].ended_at=periods[i+1].first_seen;
  return periods.reverse();
}
