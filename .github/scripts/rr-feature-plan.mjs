import {d1Query,retryOnD1Overload,recentDateBound} from './d1-query.mjs';

// Match features use the calls left after every due poll and gap heal. The
// queue is the newest payouts without features, newest first (archived
// matches cost no upstream call; the proxy reads them from R2). An older
// version counted the whole inventory (about a million rows joined to four
// tables) twice per run in 64 slices; the backlog of older rows cannot be
// fetched at the spare call rate anyway, and the daily census reports feature
// coverage. Ordering by date alone lets SQLite walk the rr_history(date) index
// backwards and stop at the limit: sorting archived rows first read every
// recent row and took 7.4 s of D1 time on 23 Nov 2026.
export const FEATURE_DAYS=3;
export async function loadFeatureQueue(env,limit,query=retryOnD1Overload(d1Query),{days=FEATURE_DAYS}={}){
  if(!Number.isSafeInteger(limit)||limit<0||limit>5000)throw new Error('Invalid feature limit');
  if(!limit)return [];
  return query(env,`SELECT h.puuid,h.match_id,p.region,a.match_id IS NOT NULL AS archived
    FROM rr_history h JOIN rr_players p ON p.puuid=h.puuid
    LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
    LEFT JOIN match_archive a ON a.puuid=h.puuid AND a.match_id=h.match_id
    LEFT JOIN rr_feature_retry r ON r.puuid=h.puuid AND r.match_id=h.match_id
    WHERE h.date>=${recentDateBound(days)} AND f.match_id IS NULL AND p.region IS NOT NULL
      AND (a.match_id IS NOT NULL OR r.next_attempt_at IS NULL OR julianday(r.next_attempt_at)<=julianday('now'))
    ORDER BY h.date DESC LIMIT ?1`,[limit]);
}
