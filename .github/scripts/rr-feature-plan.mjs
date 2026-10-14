import {d1Query} from './d1-query.mjs';

// D1 is the inventory: completed evidence is never queued again. Archived
// matches can be processed by the proxy without spending Henrik quota, even
// when an earlier upstream lookup left a retry delay behind.
const inventorySQL=`SELECT h.puuid,h.match_id,h.date,p.region,
  f.match_id AS saved_id,a.match_id AS archive_id,r.next_attempt_at
  FROM rr_history h LEFT JOIN rr_players p ON p.puuid=h.puuid
  LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
  LEFT JOIN match_archive a ON a.puuid=h.puuid AND a.match_id=h.match_id
  LEFT JOIN rr_feature_retry r ON r.puuid=h.puuid AND r.match_id=h.match_id`;

export async function loadFeaturePlan(env,limit,query=d1Query){
  if(!Number.isSafeInteger(limit)||limit<0||limit>5000)throw new Error('Invalid feature limit');
  const [inventory]=await query(env,`WITH inventory AS (${inventorySQL})
    SELECT COUNT(*) AS total,
      COALESCE(SUM(saved_id IS NOT NULL),0) AS saved,
      COALESCE(SUM(saved_id IS NULL),0) AS missing,
      COALESCE(SUM(saved_id IS NULL AND region IS NULL),0) AS missingRegion,
      COALESCE(SUM(saved_id IS NULL AND region IS NOT NULL AND archive_id IS NOT NULL),0) AS archived,
      COALESCE(SUM(saved_id IS NULL AND region IS NOT NULL AND archive_id IS NULL
        AND julianday(next_attempt_at)>julianday('now')),0) AS waitingRetry
    FROM inventory`);
  const rows=limit?await query(env,`WITH inventory AS (${inventorySQL})
    SELECT puuid,match_id,region,archive_id IS NOT NULL AS archived FROM inventory
    WHERE saved_id IS NULL AND region IS NOT NULL
      AND (archive_id IS NOT NULL OR next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday('now'))
    ORDER BY archive_id IS NOT NULL DESC,date DESC,puuid,match_id LIMIT ?1`,[limit]):[];
  return {inventory,rows};
}
