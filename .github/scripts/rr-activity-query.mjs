import {d1Query,retryOnD1Overload,recentDateBound} from './d1-query.mjs';
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
  const rows=await query(env,`WITH latest_season AS (
    SELECT LOWER(json_extract(data,'$.season.id')) AS id FROM rr_history
    WHERE COALESCE(json_extract(data,'$.season.id'),'')<>'' ORDER BY date DESC LIMIT 1
  ), season_start AS (
    SELECT (SELECT h.date FROM rr_history h
      WHERE LOWER(json_extract(h.data,'$.season.id'))=(SELECT id FROM latest_season) AND h.date IS NOT NULL
      ORDER BY h.date LIMIT 1) AS started_at
  ), roster AS (
    SELECT puuid,platform,MAX(played_at) AS played_at,MAX(observed_at) AS observed_at
    FROM rr_candidate_games WHERE played_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days') GROUP BY puuid,platform
  ) SELECT p.puuid,p.platform,c.checked_at,failed.checked_at AS failed_probe_at,
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
    CROSS JOIN season_start`);
  const byId=new Map(rows.map(p=>[`${p.puuid}:${p.platform}`,p]));
  return players.map(p=>({...p,...byId.get(`${p.puuid}:${p.platform}`)}));
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
