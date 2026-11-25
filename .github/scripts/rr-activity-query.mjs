import {d1Query,retryOnD1Overload,recentDateBound,readByPuuidRange} from './d1-query.mjs';
// Startup reads are read-only, so a D1 overload waits out the window instead
// of failing the run before any RR is captured.
const readQuery=retryOnD1Overload(d1Query);
// All-time latest timestamps and last-week counts seek each player's
// (puuid,date) index, which holds both columns, so no table row is read.
// latest_season and season_start rely on rr_history_date and
// rr_history_season_date (schema.sql); keep their season expression identical
// to the index or SQLite rescans JSON.
//
// On 23 Nov 2026 D1's analytics showed this query reading 2.24 million rows
// (5.6 s) per run: a whole-table GROUP BY for the last-week counts, and a
// MIN(date) that read every row of the current act. The counts now read only
// each player's last week, and the act's first game is a single index seek.
export async function loadActivity(env,players,query=readQuery){
  const rows=await loadTracked(env,query);
  const byId=new Map(rows.map(p=>[`${p.puuid}:${p.platform}`,p]));
  return players.map(p=>({...p,...byId.get(`${p.puuid}:${p.platform}`)}));
}

// Every tracked account with its region, platform and activity. Read in
// PUUID ranges (readByPuuidRange): as one statement it took 2.2 s of D1 time
// and 568,153 rows for 23,476 accounts on 24 Nov 2026, and it grows with
// every account. Each range repeats the two act lookups, which are single
// index seeks. `scope(column)` limits both the roster and the players to a
// PUUID range (?1, ?2) or to a list (?1, a JSON array).
const trackedSQL=scope=>`WITH latest_season AS (
    SELECT LOWER(json_extract(data,'$.season.id')) AS id FROM rr_history
    WHERE COALESCE(json_extract(data,'$.season.id'),'')<>'' ORDER BY date DESC LIMIT 1
  ), season_start AS (
    SELECT (SELECT h.date FROM rr_history h
      WHERE LOWER(json_extract(h.data,'$.season.id'))=(SELECT id FROM latest_season) AND h.date IS NOT NULL
      ORDER BY h.date LIMIT 1) AS started_at
  ), roster AS (
    SELECT puuid,platform,MAX(played_at) AS played_at,MAX(observed_at) AS observed_at
    FROM rr_candidate_games WHERE played_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')
      AND ${scope('puuid')} GROUP BY puuid,platform
  ) SELECT p.puuid,p.region,p.platform,c.checked_at,c.window_from,failed.checked_at AS failed_probe_at,
    (SELECT COUNT(*) FROM rr_history h WHERE h.puuid=p.puuid AND h.date>=${recentDateBound(7)}
      AND julianday(h.date)>=julianday('now','-7 days')) AS games_7d,
    (SELECT date FROM rr_history h WHERE h.puuid=p.puuid ORDER BY date DESC LIMIT 1) AS last_played_at,
    (SELECT json_extract(data,'$.tier.id') FROM rr_history h WHERE h.puuid=p.puuid ORDER BY date DESC LIMIT 1) AS tier,
    roster.played_at AS candidate_played_at,roster.observed_at AS candidate_observed_at,
    season_start.started_at AS season_started_at
    FROM rr_players p
    LEFT JOIN rr_collection c ON c.puuid=p.puuid AND c.platform=p.platform
    LEFT JOIN rr_candidate_checks failed ON failed.puuid=p.puuid AND failed.platform=p.platform
    LEFT JOIN roster ON roster.puuid=p.puuid AND roster.platform=p.platform
    CROSS JOIN season_start
    WHERE ${scope('p.puuid')}`;
const inRange=column=>`${column}>=?1 AND ${column}<?2`;
const inList=column=>`${column} IN (SELECT value FROM json_each(?1))`;
export async function loadTracked(env,query=readQuery,options){
  return readByPuuidRange((lo,hi)=>query(env,trackedSQL(inRange),[lo,hi]),options);
}
// The same rows for a list of PUUIDs, in chunks; each is a key lookup.
export async function loadTrackedPuuids(env,puuids,query=readQuery,{chunk=500}={}){
  const rows=[];
  for(let i=0;i<puuids.length;i+=chunk)
    rows.push(...await query(env,trackedSQL(inList),[JSON.stringify(puuids.slice(i,i+chunk))]));
  return rows;
}

// The 30-minute player reload, incremental (docs/rr-collector-d1-load.md).
// A full read (loadTracked) cost about 570k rows each time, although only a
// few hundred accounts change in half an hour. After a full read, each reload
// asks D1 which accounts may have changed since the last one and re-reads
// only those (loadTrackedPuuids). An account's row changes when:
//   - a save touched it: rr_collection.checked_at (every collectRR, visitors'
//     included; it also covers in-place rr_history updates and region changes
//     made by collectRR), rr_candidate_checks.checked_at (failed probes);
//   - rows were added: rr_history, rr_players and rr_candidate_games rowids
//     above the last read's maximum (heals and late saves carry old dates, so
//     dates cannot tell new rows apart; rowids grow with every insert while
//     the row with the highest rowid is never deleted, and nothing deletes
//     from these tables);
//   - rr_players.updated_at moved (account lookups update region and names);
//   - time passed: a game left the 7-day count (rr_history.date) or the 2-day
//     roster (rr_candidate_games.played_at) since the last read. Nothing is
//     written when that happens, so the date ranges are read on their
//     indexes.
// Times come from D1's own clock, with a minute of margin on every bound;
// reading an account that did not change costs only a lookup. A full read
// runs first, every fullEveryMs, when the change list exceeds maxChanged, and
// when the act's start (shared by every row) moved.
export const FULL_RELOAD_MS=3*3600000;
export const RELOAD_MARGIN_MS=60000;
const DAY=86400000;
const shift=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();
const MARKS_SQL=`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at,
  (SELECT MAX(rowid) FROM rr_history) AS history,(SELECT MAX(rowid) FROM rr_players) AS players,
  (SELECT MAX(rowid) FROM rr_candidate_games) AS candidates`;
// UNION ALL, de-duplicated here: with UNION, SQLite merges sorted streams and
// walks rr_history's PUUID index (every row) instead of seeking the rowid.
// Two statements, because D1 refuses a compound SELECT of more than five
// terms ("too many terms in compound SELECT"; seven failed the first
// change-only reload on 25 Nov 2026, local SQLite allows 500).
export const D1_MAX_COMPOUND_TERMS=5;
const SAVED_SQL=`SELECT puuid FROM rr_collection WHERE checked_at>=?1
  UNION ALL SELECT puuid FROM rr_candidate_checks WHERE checked_at>=?1
  UNION ALL SELECT puuid FROM rr_players WHERE rowid>?2 OR updated_at>=?1`;
const ADDED_SQL=`SELECT puuid FROM rr_history WHERE rowid>?1
  UNION ALL SELECT puuid FROM rr_history WHERE date>=?2 AND date<?3
  UNION ALL SELECT puuid FROM rr_candidate_games WHERE rowid>?4
  UNION ALL SELECT puuid FROM rr_candidate_games WHERE played_at>=?5 AND played_at<?6`;
export async function changedPuuids(env,since,{at,history,players,candidates},query=readQuery,margin=RELOAD_MARGIN_MS){
  const saved=await query(env,SAVED_SQL,[shift(since,-margin),Number(players)||0]);
  const added=await query(env,ADDED_SQL,[Number(history)||0,shift(since,-7*DAY-margin),shift(at,-7*DAY+margin),
    Number(candidates)||0,shift(since,-2*DAY-margin),shift(at,-2*DAY+margin)]);
  return [...new Set([...saved,...added].map(row=>row.puuid))];
}
export function createTrackedLoader(env,{query=readQuery,fullEveryMs=FULL_RELOAD_MS,maxChanged=5000,
  now=Date.now,options}={}){
  let last=null;// {at,history,players,candidates,fullAt,season}
  const stats={full:0,changed:0,accounts:0};
  const mark=rows=>{Object.defineProperty(rows,'reload',{value:rows.reload||'full'});return rows;};
  async function full(marks){
    const rows=await loadTracked(env,query,options);
    last={...marks,fullAt:now(),season:rows[0]?.season_started_at??null};
    stats.full++;
    return mark(rows);
  }
  async function load(){
    const [marks]=await query(env,MARKS_SQL);
    if(!last||now()-last.fullAt>=fullEveryMs)return full(marks);
    const ids=await changedPuuids(env,last.at,{...last,at:marks.at},query);
    if(ids.length>maxChanged)return full(marks);
    const rows=await loadTrackedPuuids(env,ids,query);
    // A new act, or an earlier game of the current one, moves every row's
    // season start: read everything.
    if(rows.some(row=>(row.season_started_at??null)!==last.season))return full(marks);
    last={...last,...marks};
    stats.changed++;stats.accounts+=rows.length;
    Object.defineProperty(rows,'reload',{value:'changed'});
    return rows;
  }
  return {load,stats,get last(){return last;},set last(value){last=value;}};
}

export async function loadCandidates(env,query=readQuery){
  return query(env,`WITH games AS (
    SELECT puuid,platform,COUNT(*) AS games_7d,MAX(played_at) AS last_played_at
    FROM rr_candidate_games WHERE played_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') GROUP BY puuid,platform
  ) SELECT g.puuid,g.platform,g.games_7d,g.last_played_at,r.region,r.tier
    FROM games g JOIN rr_candidate_games r ON r.puuid=g.puuid AND r.platform=g.platform AND r.played_at=g.last_played_at
    LEFT JOIN rr_candidate_checks c ON c.puuid=g.puuid AND c.platform=g.platform
    WHERE g.last_played_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')
    AND (c.checked_at IS NULL OR c.checked_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))
    GROUP BY g.puuid,g.platform`);
}
