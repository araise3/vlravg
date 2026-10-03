import {d1Query} from './d1-query.mjs';
// Limit games queries to the last week using date indexes. All-time latest
// timestamps seek each player's existing (puuid,date) index.
export async function loadActivity(env,players,query=d1Query){
  const rows=await query(env,`WITH recent AS (
    SELECT puuid,COUNT(*) AS games_7d FROM rr_history
    WHERE julianday(date)>=julianday('now','-7 days') GROUP BY puuid
  ), roster AS (
    SELECT puuid,platform,MAX(played_at) AS played_at,MAX(observed_at) AS observed_at
    FROM rr_candidate_games WHERE played_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days') GROUP BY puuid,platform
  ) SELECT p.puuid,p.platform,c.checked_at,COALESCE(r.games_7d,0) AS games_7d,
    (SELECT date FROM rr_history h WHERE h.puuid=p.puuid ORDER BY date DESC LIMIT 1) AS last_played_at,
    (SELECT json_extract(data,'$.tier.id') FROM rr_history h WHERE h.puuid=p.puuid ORDER BY date DESC LIMIT 1) AS tier,
    roster.played_at AS candidate_played_at,roster.observed_at AS candidate_observed_at
    FROM rr_players p LEFT JOIN recent r ON r.puuid=p.puuid
    LEFT JOIN rr_collection c ON c.puuid=p.puuid AND c.platform=p.platform
    LEFT JOIN roster ON roster.puuid=p.puuid AND roster.platform=p.platform`);
  const byId=new Map(rows.map(p=>[`${p.puuid}:${p.platform}`,p]));
  return players.map(p=>({...p,...byId.get(`${p.puuid}:${p.platform}`)}));
}

export async function loadCandidates(env,query=d1Query){
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
