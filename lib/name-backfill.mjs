export const BACKFILL_LIMIT = 10000;
export const STORED_BACKFILL_LIMIT = 10000;
const RAPID_NAME_BOUNCE_MS = 48 * 60 * 60 * 1000;

const sameRiotId = (a, b) => a.name === b.name && a.tag === b.tag;

function parseStoredPending(value){
  let rows;
  try{rows=JSON.parse(value||'[]');}catch{throw new Error('Invalid pending stored matches');}
  if(!Array.isArray(rows)||rows.length>100||rows.some(row=>typeof row?.match_id!=='string'||!row.match_id||
      typeof row?.played_at!=='string'||!Number.isFinite(Date.parse(row.played_at))))
    throw new Error('Invalid pending stored matches');
  return rows;
}

export async function backfillState(db, puuid, internal = false) {
  const player = await db.prepare('SELECT region,platform FROM rr_players WHERE puuid=?1').bind(puuid).first();
  if (!player?.region || !player?.platform) return { available: false, complete: false, next_start: 0 };
  const row = await db.prepare(`SELECT next_start,complete,stored_page,stored_scanned,stored_complete,stored_pending
    FROM player_name_backfill WHERE puuid=?1 AND region=?2 AND platform=?3`)
    .bind(puuid, player.region, player.platform).first();
  const next_start = row?.next_start || 0;
  const matchlist_complete=!!row?.complete;
  const stored_page=row?.stored_page || 1;
  const stored_scanned=row?.stored_scanned || 0;
  const stored_complete=!!row?.stored_complete;
  const pending=parseStoredPending(row?.stored_pending);
  const phase=!matchlist_complete?'matches':pending.length?'stored-detail':'stored';
  const complete=matchlist_complete&&stored_complete&&!pending.length;
  const state={ ...player, available: true, next_start, matchlist_complete, stored_page, stored_scanned,
    stored_complete, stored_pending_count:pending.length, phase, complete,
    limited:(!matchlist_complete&&next_start>=BACKFILL_LIMIT)||
      (matchlist_complete&&!stored_complete&&!pending.length&&stored_scanned>=STORED_BACKFILL_LIMIT) };
  if(internal&&pending.length)state.stored_match=pending[0];
  return state;
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

function storedMatchRows(matches,puuid,now){
  if (!Array.isArray(matches) || matches.length > 100) throw new Error('Invalid stored match page');
  const valid=[];
  for(const match of matches){
    if(!match?.meta?.id||!match?.stats||match.stats.puuid?.toLowerCase()!==puuid)
      throw new Error('Invalid stored match record');
    const stamp=Date.parse(match.meta.started_at);
    if(!Number.isFinite(stamp)||stamp>now||stamp<Date.UTC(2020,0,1))throw new Error('Invalid stored match date');
    const hasName=[match.stats.name,match.stats.tag].every(v=>typeof v==='string'&&v.trim());
    valid.push({match_id:match.meta.id,name:hasName?match.stats.name:null,tag:hasName?match.stats.tag:null,
      played_at:new Date(stamp).toISOString()});
  }
  return valid;
}

export function storedNameEvidence(matches, puuid, now = Date.now()) {
  return compactMatchEvidence(storedMatchRows(matches,puuid,now).filter(row=>row.name));
}

export function compactMatchEvidence(rows) {
  const sorted=[...rows].map(({name,tag,played_at})=>({name,tag,played_at}))
    .sort((a,b)=>a.played_at.localeCompare(b.played_at)||a.name.localeCompare(b.name)||a.tag.localeCompare(b.tag));
  const periods=[];
  for(const row of sorted){
    const last=periods.at(-1);
    if(last&&sameRiotId(last,row))last.last_seen=row.played_at;
    else periods.push({name:row.name,tag:row.tag,first_seen:row.played_at,last_seen:row.played_at});
  }
  // Full-match rosters occasionally contain one stale identity. If it creates
  // A -> B -> A between observations less than 48 hours apart, treating B as
  // two real Riot ID changes would be impossible under Riot's rename cadence.
  // Remove only a single-observation sandwich; longer or slower A -> B -> A
  // sequences remain separate periods so genuine name reuse is preserved.
  for(let i=1;i<periods.length-1;){
    const before=periods[i-1],blip=periods[i],after=periods[i+1];
    const bounceMs=Date.parse(after.first_seen)-Date.parse(before.last_seen);
    if(sameRiotId(before,after)&&blip.first_seen===blip.last_seen&&
        Number.isFinite(bounceMs)&&bounceMs>=0&&bounceMs<RAPID_NAME_BOUNCE_MS){
      before.last_seen=after.last_seen;
      periods.splice(i,2);
      if(i>1)i--;
    }else i++;
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

export async function saveStoredBackfillPage(db,puuid,state,payload,now=Date.now()){
  const matches=payload?.data;
  const rows=storedMatchRows(matches,puuid,now);
  const pageEvidence=compactMatchEvidence(rows.filter(row=>row.name));
  const saved=await db.prepare(`SELECT complete,stored_page,stored_complete,stored_pending,evidence FROM player_name_backfill
    WHERE puuid=?1 AND region=?2 AND platform=?3`).bind(puuid,state.region,state.platform).first();
  if(!saved||!saved.complete||saved.stored_complete||parseStoredPending(saved.stored_pending).length||saved.stored_page!==state.stored_page)
    return backfillState(db,puuid);
  const evidence=compactMatchEvidence([
    ...parseCompactMatchEvidence(saved.evidence),
    ...pageEvidence,
  ]);
  const earliest=evidence[0]?.played_at||'9999';
  const pending=rows.filter(row=>!row.name&&row.played_at<earliest)
    .map(({match_id,played_at})=>({match_id,played_at}));
  const after=Number(payload?.results?.after);
  const pageComplete=matches.length===0||(Number.isFinite(after)&&after===0);
  await db.prepare(`UPDATE player_name_backfill SET stored_page=?4,stored_scanned=stored_scanned+?5,
    stored_complete=?6,stored_pending=?7,updated_at=?8,evidence=?9 WHERE puuid=?1 AND region=?2 AND platform=?3
    AND complete=1 AND stored_complete=0 AND stored_page=?10`)
    .bind(puuid,state.region,state.platform,state.stored_page+1,matches.length,pageComplete?1:0,JSON.stringify(pending),
      new Date(now).toISOString(),JSON.stringify(evidence),state.stored_page).run();
  return backfillState(db,puuid);
}

export async function saveStoredMatchDetail(db,puuid,state,match,now=Date.now()){
  if(match?.metadata?.match_id!==state.stored_match?.match_id)throw new Error('Wrong stored match detail');
  const pageEvidence=matchNameEvidence([match],puuid,now);
  const saved=await db.prepare(`SELECT stored_pending,evidence FROM player_name_backfill
    WHERE puuid=?1 AND region=?2 AND platform=?3`).bind(puuid,state.region,state.platform).first();
  const pending=parseStoredPending(saved?.stored_pending);
  if(!pending.length||pending[0].match_id!==state.stored_match.match_id)return backfillState(db,puuid);
  const evidence=compactMatchEvidence([...parseCompactMatchEvidence(saved.evidence),...pageEvidence]);
  await db.prepare(`UPDATE player_name_backfill SET stored_pending=?4,updated_at=?5,evidence=?6
    WHERE puuid=?1 AND region=?2 AND platform=?3 AND stored_pending=?7`)
    .bind(puuid,state.region,state.platform,JSON.stringify(pending.slice(1)),new Date(now).toISOString(),
      JSON.stringify(evidence),saved.stored_pending).run();
  return backfillState(db,puuid);
}

export async function skipStoredMatchDetail(db,puuid,state,now=Date.now()){
  const saved=await db.prepare(`SELECT stored_pending FROM player_name_backfill
    WHERE puuid=?1 AND region=?2 AND platform=?3`).bind(puuid,state.region,state.platform).first();
  const pending=parseStoredPending(saved?.stored_pending);
  if(!pending.length||pending[0].match_id!==state.stored_match?.match_id)return backfillState(db,puuid);
  await db.prepare(`UPDATE player_name_backfill SET stored_pending=?4,updated_at=?5
    WHERE puuid=?1 AND region=?2 AND platform=?3 AND stored_pending=?6`)
    .bind(puuid,state.region,state.platform,JSON.stringify(pending.slice(1)),new Date(now).toISOString(),saved.stored_pending).run();
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
