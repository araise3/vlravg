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

export async function collectRR(db,payload,{puuid,region,platform},stamp=new Date().toISOString()) {
  if(payload?.data?.account?.puuid?.toLowerCase()!==puuid||!Array.isArray(payload.data.history))throw new Error('Invalid RR account');
  const history=payload.data.history;
  // Two statements per entry plus two metadata writes fit D1's Free-plan
  // 50-query invocation limit; the upstream normally returns at most 20.
  if(history.length>20||history.some(h=>!h?.match_id||!Number.isFinite(h.last_change)||!Number.isFinite(Date.parse(h.date))))throw new Error('Invalid RR history');
  const ids=history.map(h=>h.match_id);
  const previous=await db.prepare('SELECT window_ids FROM rr_collection WHERE puuid=?1 AND platform=?2').bind(puuid,platform).first();
  const oldIds=previous?JSON.parse(previous.window_ids):[];
  // Absence of overlap in a full rolling window is a warning, not proof of
  // how many games were lost. Act resets can also replace the whole window.
  const possibleGap=oldIds.length>0&&ids.length>=20&&!ids.some(id=>oldIds.includes(id));
  const statements=history.map(h=>db.prepare(
    'INSERT INTO rr_history(puuid,match_id,data,date) VALUES(?1,?2,?3,?4) ON CONFLICT(puuid,match_id) DO UPDATE SET data=excluded.data,date=excluded.date WHERE rr_history.data<>excluded.data OR rr_history.date<>excluded.date'
  ).bind(puuid,h.match_id,JSON.stringify(h),h.date));
  const chronological=[...history].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
  for(let i=1;i<chronological.length;i++)statements.push(db.prepare(
    'INSERT INTO rr_predecessors(puuid,match_id,previous_match_id) VALUES(?1,?2,?3) ON CONFLICT(puuid,match_id) DO UPDATE SET previous_match_id=excluded.previous_match_id WHERE rr_predecessors.previous_match_id<>excluded.previous_match_id'
  ).bind(puuid,chronological[i].match_id,chronological[i-1].match_id));
  statements.push(db.prepare('INSERT INTO rr_collection(puuid,platform,checked_at,head_match_id,window_ids,checks,possible_gaps) VALUES(?1,?2,?3,?4,?5,1,?6) ON CONFLICT(puuid,platform) DO UPDATE SET checked_at=excluded.checked_at,head_match_id=excluded.head_match_id,window_ids=excluded.window_ids,checks=rr_collection.checks+1,possible_gaps=rr_collection.possible_gaps+excluded.possible_gaps')
    .bind(puuid,platform,stamp,chronological.at(-1)?.match_id||null,JSON.stringify(ids),possibleGap?1:0));
  statements.push(db.prepare('INSERT INTO rr_players(puuid,region,platform,name,tag,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(puuid) DO UPDATE SET region=excluded.region,platform=excluded.platform')
    .bind(puuid,region,platform,payload.data.account.name||null,payload.data.account.tag||null,stamp));
  // A successful collector response means its evidence was committed atomically.
  await db.batch(statements);
  return {puuid,platform,checked_at:stamp,matches:ids.length,possible_gap:possibleGap};
}
