import {d1Query,retryOnD1Overload,pacedQuery,PACE_FACTOR,forEachPuuidRange,SLICE_TARGET_MS} from './d1-query.mjs';
// Gap bookkeeping for the RR collector (docs/rr-collector-gap-healing.md).
// Every statement here is idempotent, so a D1 overload is waited out.
const query=retryOnD1Overload(d1Query);

// Gaps whose next attempt is due, oldest first. Polls record them (collectRR)
// and the daily scan below adds rank discontinuities in saved history.
export async function loadOpenGaps(env,limit=5000,run=query){
  return run(env,`SELECT puuid,after_match_id,after_date,before_match_id,before_date,region,platform,source,status,attempts,recovered
    FROM rr_gaps WHERE status IN ('open','incomplete') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ORDER BY next_attempt_at,puuid,after_match_id LIMIT ?1`,[limit]);
}

export async function gapSummary(env,run=query){
  const rows=await run(env,`SELECT status,source,COUNT(*) AS gaps,COALESCE(SUM(recovered),0) AS recovered
    FROM rr_gaps GROUP BY status,source ORDER BY status,source`);
  const summary={total:0,recovered:0,byStatus:{},bySource:{}};
  for(const row of rows){
    const n=Number(row.gaps)||0;
    summary.total+=n;summary.recovered+=Number(row.recovered)||0;
    summary.byStatus[row.status]=(summary.byStatus[row.status]||0)+n;
    summary.bySource[row.source]=(summary.bySource[row.source]||0)+n;
  }
  return summary;
}

export async function readState(env,name,run=query){
  return (await run(env,'SELECT value,updated_at FROM rr_collector_state WHERE name=?1',[name]))[0]||null;
}
export async function writeState(env,name,value,run=query){
  await run(env,`INSERT INTO rr_collector_state(name,value,updated_at) VALUES(?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,[name,value]);
}

// A saved payout whose reported starting rank differs from the previous saved
// payout's ending rank (same act, both known, Immortal+ on one RR axis) where
// upstream never listed the two together. Either games are missing between
// them or the rank changed without a game (decay); healing tells them apart.
// Pairs witnessed adjacent in one live window (rr_predecessors) cannot hide a
// game. Each statement holds all of its players' rows: a PUUID range (?1, ?2)
// for the weekly full scan, or a list (?1, a JSON array) for the daily scan of
// changed players.
const scanSQL=scope=>`WITH s AS (
    SELECT h.puuid,h.match_id,h.date,
      LOWER(json_extract(h.data,'$.season.id')) AS season,
      json_extract(h.data,'$.tier_before_update.id') AS tb,json_extract(h.data,'$.rr_before_update') AS rb,
      LAG(h.match_id) OVER w AS prev_id,LAG(h.date) OVER w AS prev_date,
      LAG(LOWER(json_extract(h.data,'$.season.id'))) OVER w AS prev_season,
      LAG(json_extract(h.data,'$.tier.id')) OVER w AS prev_tier,LAG(json_extract(h.data,'$.rr')) OVER w AS prev_rr
    FROM rr_history h WHERE h.date IS NOT NULL AND ${scope}
    WINDOW w AS (PARTITION BY h.puuid ORDER BY h.date,h.match_id)
  ) SELECT s.puuid,s.prev_id AS after_match_id,s.prev_date AS after_date,s.match_id AS before_match_id,s.date AS before_date,
    p.region,p.platform
  FROM s JOIN rr_players p ON p.puuid=s.puuid
  WHERE s.prev_id IS NOT NULL AND COALESCE(s.season,'')<>'' AND s.season=s.prev_season
    AND typeof(s.tb)='integer' AND s.tb>=3 AND typeof(s.prev_tier)='integer' AND s.prev_tier>=3
    AND typeof(s.rb) IN ('integer','real') AND typeof(s.prev_rr) IN ('integer','real')
    AND (MIN(s.tb,24)-3)*100+s.rb<>(MIN(s.prev_tier,24)-3)*100+s.prev_rr
    AND p.region IN ('eu','na','ap','kr','latam','br') AND p.platform IN ('pc','console')
    AND NOT EXISTS (SELECT 1 FROM rr_predecessors r WHERE r.puuid=s.puuid AND r.match_id=s.match_id AND r.previous_match_id=s.prev_id)
    AND NOT EXISTS (SELECT 1 FROM rr_gaps g WHERE g.puuid=s.puuid AND g.after_match_id=s.prev_id)`;
// The first guess; the ranges then resize to about SLICE_TARGET_MS of D1
// time each (forEachPuuidRange).
export const SCAN_SLICES=64;
export const SCAN_PLAYERS_PER_STATEMENT=200;
const INSERT_CHUNK=200;

// `puuids`: scan only these players (the daily scan of changed players);
// without it, every player in self-sizing PUUID ranges (the weekly full scan).
export async function scanGaps(env,run=query,{puuids=null,chunk=SCAN_PLAYERS_PER_STATEMENT,slices=SCAN_SLICES,
  targetMs=SLICE_TARGET_MS,pauseMs=500,factor=PACE_FACTOR,sleep}={}){
  const paced=pacedQuery(run,{factor,minPauseMs:pauseMs,sleep});
  let found=0;
  async function part(sql,params){
    const rows=await paced(env,sql,params);
    for(let i=0;i<rows.length;i+=INSERT_CHUNK){
      await paced(env,`INSERT INTO rr_gaps(puuid,after_match_id,after_date,before_match_id,before_date,region,platform,source,detected_at,next_attempt_at)
        SELECT json_extract(value,'$.puuid'),json_extract(value,'$.after_match_id'),json_extract(value,'$.after_date'),
          json_extract(value,'$.before_match_id'),json_extract(value,'$.before_date'),json_extract(value,'$.region'),
          json_extract(value,'$.platform'),'scan',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM json_each(?1) WHERE 1 ON CONFLICT(puuid,after_match_id) DO NOTHING`,[JSON.stringify(rows.slice(i,i+INSERT_CHUNK))]);
    }
    found+=rows.length;
    return rows;
  }
  if(puuids){
    let statements=0;
    for(let i=0;i<puuids.length;i+=chunk,statements++)
      await part(scanSQL('h.puuid IN (SELECT value FROM json_each(?1))'),[JSON.stringify(puuids.slice(i,i+chunk))]);
    return {found,players:puuids.length,statements};
  }
  // Each range is sized by the scan's D1 time; the inserts that follow it are
  // paced but do not resize the next range.
  const ranges=await forEachPuuidRange((lo,hi)=>part(scanSQL('h.puuid>=?1 AND h.puuid<?2'),[lo,hi]),{parts:slices,targetMs});
  return {found,ranges};
}

// Where the daily scan of changed players starts: D1's clock and the highest
// rr_history rowid, read before a scan so that rows saved during it are
// scanned the next time.
export async function historyMarks(env,run=query){
  const [row]=await run(env,`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at,(SELECT MAX(rowid) FROM rr_history) AS history`);
  return {at:row.at,history:Number(row.history)||0};
}
// Players whose saved history may have changed since `marks`: rows added
// (rowid; heals and late saves carry old dates) or a save that may have
// updated rows in place (collectRR always moves rr_collection.checked_at).
// A minute of margin on the time; UNION ALL keeps the rowid condition a seek.
export async function changedHistoryPlayers(env,{at,history},run=query,margin=60000){
  const rows=await run(env,`SELECT puuid FROM rr_history WHERE rowid>?1
    UNION ALL SELECT puuid FROM rr_collection WHERE checked_at>=?2`,
  [Number(history)||0,new Date(Date.parse(at)-margin).toISOString()]);
  return [...new Set(rows.map(row=>row.puuid))];
}
