// Research evidence only. Raw payouts are never replaced by model estimates.
// Called only with server-fetched account responses (including our edge cache).
// Repeated profile opens do not rewrite identity or count as ranked activity.
export async function trackRRAccount(db,account) {
  const puuid=account?.puuid?.toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(puuid||'')||
    typeof account.name!=='string'||!account.name||typeof account.tag!=='string'||!account.tag)throw new Error('Invalid RR account');
  await db.prepare('INSERT OR IGNORE INTO rr_players(puuid,region,name,tag,updated_at) VALUES(?1,?2,?3,?4,?5)')
    .bind(puuid,account.region||null,account.name,account.tag,new Date().toISOString()).run();
}

export function matchFeatures(match, puuid) {
  const me=match?.players?.find(p=>p.puuid?.toLowerCase()===puuid);
  const meta=match?.metadata;
  const team=match?.teams?.find(t=>t.team_id===me?.team_id);
  const season=meta?.season?.id||meta?.season_id;
  if(!me||!season||!meta.match_id||!team?.rounds)throw new Error('Invalid research match');
  const rw=team.rounds.won,rl=team.rounds.lost,rounds=rw+rl;
  if(!Number.isFinite(rw)||!Number.isFinite(rl)||rounds<=0)throw new Error('Invalid round counts');
  const rated=match.players.filter(p=>Number.isFinite(p.tier?.id)&&p.tier.id>=3);
  const acs=match.players.map(p=>(p.stats?.score||0)/rounds);
  const mean=acs.reduce((a,b)=>a+b,0)/acs.length;
  const sd=Math.sqrt(acs.reduce((s,v)=>s+(v-mean)**2,0)/acs.length)||1;
  // Missing party evidence stays unknown; it must not become assumed solo play.
  const party=me.party_id?match.players.filter(p=>p.team_id===me.team_id&&p.party_id===me.party_id).length:null;
  return {
    version:1,mid:meta.match_id,season_id:season.toLowerCase(),season:meta.season?.short||null,
    date:meta.started_at||null,patch:meta.game_version||null,map:meta.map?.id||null,
    region:meta.region||null,platform:meta.platform||null,mode:meta.queue?.id||null,
    won:typeof team.won==='boolean'?team.won:rw>rl,draw:rw===rl,rw,rl,rd:rw-rl,
    party,pen:Array.isArray(meta.party_rr_penaltys)
      ?meta.party_rr_penaltys.find(p=>p.party_id===me.party_id)?.penalty??0:null,
    my_tier:me.tier?.id??null,kills:me.stats?.kills??null,deaths:me.stats?.deaths??null,
    assists:me.stats?.assists??null,score:me.stats?.score??null,
    acs_z:((me.stats?.score||0)/rounds-mean)/sd,
    lobby_tiers:match.players.map(p=>({tier:p.tier?.id??null,team:p.team_id})),
    lobby_mean_tier:rated.length?rated.reduce((s,p)=>s+p.tier.id,0)/rated.length:null,
  };
}

export async function saveFeatures(db,match,puuid) {
  const data=matchFeatures(match,puuid);
  await db.prepare('INSERT OR IGNORE INTO rr_match_features(puuid,match_id,season_id,started_at,data,collected_at) VALUES(?1,?2,?3,?4,?5,?6)')
    .bind(puuid,data.mid,data.season_id,data.date,JSON.stringify(data),new Date().toISOString()).run();
  return data;
}

// Older responses may omit these fields or return null. Retain already saved
// competitive-update evidence, while accepting reported zero/false corrections.
export function mergeRRUpdate(saved,fresh){
  const merged={...saved,...fresh};
  for(const key of ['afk_penalty','competitive_movement','is_placement_match','match_length',
    'new_map_incentive_rr_forgiven','queue_id','rr_before_update','rr_penalty',
    'rr_performance_bonus','tier_before_update','was_derank_protection_replenished']){
    if(fresh[key]==null&&saved?.[key]!=null)merged[key]=saved[key];
  }
  return merged;
}

// The live mmr-history window holds the ranked games among a player's last
// 20 matches of any mode (unrated or deathmatch games push ranked ones out).
export const RR_WINDOW_MAX=20;
const validEntry=h=>typeof h?.match_id==='string'&&h.match_id!==''&&Number.isFinite(h.last_change)&&Number.isFinite(Date.parse(h.date));

// Rank on one continuous axis: Iron 1 (tier 3) = 0, 100 RR per division, and
// Immortal 1 and up on one scale from 2100 (their rr is cumulative), so a
// Radiant label change with the same RR is not a discontinuity. Unrated (0-2)
// and missing values have no coordinate.
export function rankCoordinate(tier,rr){
  return Number.isInteger(tier)&&tier>=3&&Number.isFinite(rr)?(Math.min(tier,24)-3)*100+rr:null;
}
// Consecutive same-act payouts whose reported starting rank differs from the
// previous payout's ending rank: a game is missing between them, or the rank
// changed without a game (decay). Unknown values never count as a break.
export function rankBreaks(entries){
  const list=[...entries].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
  const breaks=[];
  for(let i=1;i<list.length;i++){
    const previous=list[i-1],current=list[i];
    const season=current.season?.id?.toLowerCase();
    if(!season||season!==previous.season?.id?.toLowerCase())continue;
    const end=rankCoordinate(previous.tier?.id,previous.rr);
    const start=rankCoordinate(current.tier_before_update?.id,current.rr_before_update);
    if(end!=null&&start!=null&&end!==start)breaks.push({after_match_id:previous.match_id,before_match_id:current.match_id});
  }
  return breaks;
}

export async function collectRR(db,payload,{puuid,region,platform},stamp=new Date().toISOString()) {
  if(payload?.data?.account?.puuid?.toLowerCase()!==puuid||!Array.isArray(payload.data.history))throw new Error('Invalid RR account');
  const history=payload.data.history;
  // The rolling upstream window is bounded; persist it in a fixed number of
  // statements rather than spending D1 queries on individual rows.
  if(history.length>RR_WINDOW_MAX||history.some(h=>!validEntry(h)))throw new Error('Invalid RR history');
  const ids=history.map(h=>h.match_id);
  const saved=ids.length?(await db.prepare(`SELECT match_id,data FROM rr_history WHERE puuid=?1 AND match_id IN (${ids.map((_,i)=>'?'+(i+2)).join(',')})`).bind(puuid,...ids).all()).results:[];
  const known=new Map((saved||[]).map(h=>[h.match_id,JSON.parse(h.data)]));
  // The newest payout saved before this window: one seek on (puuid,date).
  const head=await db.prepare('SELECT match_id,date FROM rr_history WHERE puuid=?1 AND date IS NOT NULL ORDER BY date DESC LIMIT 1').bind(puuid).first();
  const chronological=[...history].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
  const oldest=chronological[0];
  // The window is contiguous: it lists every ranked game since its oldest
  // entry. If it still holds the saved head, nothing between them is lost. If
  // it starts after the head, or is empty, games between the head and the
  // window may have dropped out of it: record a gap for stored-history healing.
  // A window older than the head (a stale upstream answer) proves nothing new.
  const gap=head&&!ids.includes(head.match_id)&&(!oldest||Date.parse(oldest.date)>Date.parse(head.date))
    ?{after_match_id:head.match_id,after_date:head.date,before_match_id:oldest?.match_id??null,before_date:oldest?.date??stamp}:null;
  const statements=[];
  if(history.length)statements.push(db.prepare(
    `INSERT INTO rr_history(puuid,match_id,data,date)
     SELECT ?1,json_extract(value,'$.match_id'),value,json_extract(value,'$.date') FROM json_each(?2) WHERE 1
     ON CONFLICT(puuid,match_id) DO UPDATE SET data=excluded.data,date=excluded.date
     WHERE rr_history.data<>excluded.data OR rr_history.date<>excluded.date`
  ).bind(puuid,JSON.stringify(history.map(h=>mergeRRUpdate(known.get(h.match_id),h)))));
  const predecessors=[];
  for(let i=1;i<chronological.length;i++){
    const current=chronological[i],previous=chronological[i-1];
    const season=current.season?.id?.toLowerCase();
    // An act reset cannot provide a starting RR coordinate for the next act.
    if(season&&season===previous.season?.id?.toLowerCase())predecessors.push({match_id:current.match_id,previous_match_id:previous.match_id});
  }
  if(predecessors.length)statements.push(db.prepare(
    `INSERT INTO rr_predecessors(puuid,match_id,previous_match_id)
     SELECT ?1,json_extract(value,'$.match_id'),json_extract(value,'$.previous_match_id') FROM json_each(?2) WHERE 1
     ON CONFLICT(puuid,match_id) DO UPDATE SET previous_match_id=excluded.previous_match_id
     WHERE rr_predecessors.previous_match_id<>excluded.previous_match_id`
  ).bind(puuid,JSON.stringify(predecessors)));
  // Remove previously recorded cross-act edges when upstream corrects a season.
  if(history.length)statements.push(db.prepare(
    `DELETE FROM rr_predecessors WHERE puuid=?1
     AND match_id IN (SELECT value FROM json_each(?2))
     AND NOT EXISTS (SELECT 1 FROM rr_history current JOIN rr_history previous
       ON previous.puuid=current.puuid AND previous.match_id=rr_predecessors.previous_match_id
       WHERE current.puuid=rr_predecessors.puuid AND current.match_id=rr_predecessors.match_id
       AND COALESCE(json_extract(current.data,'$.season.id'),'')<>''
       AND LOWER(json_extract(current.data,'$.season.id'))=LOWER(json_extract(previous.data,'$.season.id')))`
  ).bind(puuid,JSON.stringify(ids)));
  // The gap is queued in the same batch as the window, so it cannot be lost
  // between a committed poll and a crashed or cancelled collector run.
  if(gap)statements.push(db.prepare(
    `INSERT INTO rr_gaps(puuid,after_match_id,after_date,before_match_id,before_date,region,platform,source,detected_at,next_attempt_at)
     VALUES(?1,?2,?3,?4,?5,?6,?7,'window',?8,?8) ON CONFLICT(puuid,after_match_id) DO NOTHING`
  ).bind(puuid,gap.after_match_id,gap.after_date,gap.before_match_id,gap.before_date,region,platform,stamp));
  statements.push(db.prepare(`INSERT INTO rr_collection(puuid,platform,checked_at,head_match_id,window_ids,checks,possible_gaps,window_from)
    VALUES(?1,?2,?3,?4,?5,1,?6,?7) ON CONFLICT(puuid,platform) DO UPDATE SET checked_at=excluded.checked_at,head_match_id=excluded.head_match_id,
    window_ids=excluded.window_ids,checks=rr_collection.checks+1,possible_gaps=rr_collection.possible_gaps+excluded.possible_gaps,window_from=excluded.window_from`)
    .bind(puuid,platform,stamp,chronological.at(-1)?.match_id||null,JSON.stringify(ids),gap?1:0,oldest?.date??null));
  statements.push(db.prepare('INSERT INTO rr_players(puuid,region,platform,name,tag,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(puuid) DO UPDATE SET region=excluded.region,platform=excluded.platform')
    .bind(puuid,region,platform,payload.data.account.name||null,payload.data.account.tag||null,stamp));
  // A successful collector response means its evidence was committed atomically.
  await db.batch(statements);
  return {puuid,platform,checked_at:stamp,matches:ids.length,new_games:ids.filter(id=>!known.has(id)).length,
    newest_date:chronological.at(-1)?.date??null,window_from:oldest?.date??null,possible_gap:!!gap,gap};
}

// ── Stored-history healing (docs/rr-collector-gap-healing.md) ──
// HenrikDev's v2 stored-mmr-history returns the same entries as the live
// window, newest first, over the player's whole stored history. On 23 Nov 2026
// it held 99.87% of the 76,185 payouts this corpus had for 1,289 players, and
// it filled 20 of the 22 real gaps among them.
export const HEAL_PAGE_SIZE=100;
export const HEAL_MAX_PAGES=10;
export const HEAL_ATTEMPTS=3;
const HEAL_BACKOFF_DAYS=[1,3,7];
export const STORED_SOURCE='stored-mmr-history';

// Pure validation of one upstream page: the entries inside the gap, and
// whether the page reaches back past its start. Throws on a malformed page.
export function storedGapEntries(list,gap,size=HEAL_PAGE_SIZE){
  if(!Array.isArray(list)||list.some(h=>!validEntry(h)))throw new Error('Invalid stored RR history');
  const after=Date.parse(gap.after_date),before=Date.parse(gap.before_date);
  const entries=list.filter(h=>{const t=Date.parse(h.date);
    return t>after&&t<before&&h.match_id!==gap.after_match_id&&h.match_id!==gap.before_match_id;});
  // The list is newest first: once it shows a payout at or before the gap's
  // start, or ends, every stored payout inside the gap has been seen.
  const reached=list.length<size||list.some(h=>Date.parse(h.date)<=after);
  return {entries,reached};
}

export async function healRR(db,gap,list,{page=1,size=HEAL_PAGE_SIZE,stamp=new Date().toISOString()}={}){
  const {entries,reached}=storedGapEntries(list,gap,size);
  const puuid=gap.puuid;
  const ids=entries.map(h=>h.match_id);
  const present=ids.length?(await db.prepare(`SELECT j.value AS match_id FROM json_each(?2) j
    JOIN rr_history h ON h.puuid=?1 AND h.match_id=j.value`).bind(puuid,JSON.stringify(ids)).all()).results:[];
  const known=new Set((present||[]).map(row=>row.match_id));
  // Live data stays authoritative: stored entries only fill missing payouts.
  // They are marked so research can tell them apart, and adjacency between
  // them is never recorded as witnessed (rr_predecessors is live-only).
  const fresh=entries.filter(h=>!known.has(h.match_id)).map(h=>({...h,vlravg_source:STORED_SOURCE}));
  const statements=[];
  if(fresh.length)statements.push(db.prepare(
    `INSERT INTO rr_history(puuid,match_id,data,date)
     SELECT ?1,json_extract(value,'$.match_id'),value,json_extract(value,'$.date') FROM json_each(?2) WHERE 1
     ON CONFLICT(puuid,match_id) DO NOTHING`).bind(puuid,JSON.stringify(fresh)));
  const total=(Number(gap.recovered)||0)+fresh.length;
  if(!reached&&page<HEAL_MAX_PAGES){
    statements.push(db.prepare('UPDATE rr_gaps SET recovered=?3 WHERE puuid=?1 AND after_match_id=?2').bind(puuid,gap.after_match_id,total));
    await db.batch(statements);
    return {puuid,after_match_id:gap.after_match_id,done:false,next_page:page+1,recovered:fresh.length,total_recovered:total,status:gap.status};
  }
  // Verify the stretch from the payout before the gap through the first one
  // after it: every reported starting rank must equal the previous ending rank.
  const saved=(await db.prepare('SELECT data FROM rr_history WHERE puuid=?1 AND date>=?2 AND date<=?3 ORDER BY date LIMIT 2000')
    .bind(puuid,gap.after_date,gap.before_date).all()).results||[];
  const stretch=new Map(saved.map(row=>{const h=JSON.parse(row.data);return [h.match_id,h];}));
  for(const h of fresh)stretch.set(h.match_id,h);
  const breaks=rankBreaks([...stretch.values()]);
  const attempts=(Number(gap.attempts)||0)+1;
  const status=reached&&!breaks.length?(total>0?'healed':'connected'):attempts>=HEAL_ATTEMPTS?'unresolved':'incomplete';
  const next=status==='incomplete'?new Date(Date.parse(stamp)+HEAL_BACKOFF_DAYS[attempts-1]*86400000).toISOString():stamp;
  statements.push(db.prepare(`UPDATE rr_gaps SET status=?3,attempts=?4,recovered=?5,next_attempt_at=?6,resolved_at=?7
    WHERE puuid=?1 AND after_match_id=?2`).bind(puuid,gap.after_match_id,status,attempts,total,next,status==='incomplete'?null:stamp));
  await db.batch(statements);
  return {puuid,after_match_id:gap.after_match_id,done:true,status,recovered:fresh.length,total_recovered:total,
    breaks:breaks.length,reached,next_attempt_at:status==='incomplete'?next:null};
}
