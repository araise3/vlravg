import {d1Query,retryOnD1Overload,pacedQuery,PACE_FACTOR} from './d1-query.mjs';
import {puuidSliceBounds,puuidSliceWhere} from './puuid-slices.mjs';

// D1 is the inventory: completed evidence is never queued again. Archived
// matches can be processed by the proxy without spending Henrik quota, even
// when an earlier upstream lookup left a retry delay behind.
const inventorySQL=where=>`SELECT h.puuid,h.match_id,h.date,p.region,
  f.match_id AS saved_id,a.match_id AS archive_id,r.next_attempt_at
  FROM rr_history h LEFT JOIN rr_players p ON p.puuid=h.puuid
  LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
  LEFT JOIN match_archive a ON a.puuid=h.puuid AND a.match_id=h.match_id
  LEFT JOIN rr_feature_retry r ON r.puuid=h.puuid AND r.match_id=h.match_id
  ${where?`WHERE ${where}`:''}`;

const COUNTS=['total','saved','missing','missingRegion','archived','waitingRetry'];
// The queue order: archived matches first (no upstream call), then newest.
const queueOrder=(a,b)=>(Number(b.archived)-Number(a.archived))||(a.date===b.date?0:a.date==null?1:b.date==null?-1:a.date<b.date?1:-1)
  ||(a.puuid<b.puuid?-1:a.puuid>b.puuid?1:0)||(a.match_id<b.match_id?-1:a.match_id>b.match_id?1:0);

// The inventory joins every rr_history row (about a million on 23 Nov 2026)
// to four tables, twice per run. As single statements this ran right before
// the end-of-run census and, without any overload retry, left D1 rejecting
// the site's queries. It now runs in PUUID slices on the primary key, paced
// like the census: counts add up per slice, and each slice's first `limit`
// queued rows merge into the same global order (archived first, newest
// first, then PUUID and match ID), so the result is unchanged.
export const INVENTORY_SLICES=64;
export async function loadFeaturePlan(env,limit,query=retryOnD1Overload(d1Query),
  {slices=INVENTORY_SLICES,pauseMs=500,factor=PACE_FACTOR,sleep}={}){
  if(!Number.isSafeInteger(limit)||limit<0||limit>5000)throw new Error('Invalid feature limit');
  const paced=pacedQuery(query,{factor,minPauseMs:pauseMs,sleep});
  const inventory=Object.fromEntries(COUNTS.map(key=>[key,0]));
  const queued=[];
  for(const slice of puuidSliceBounds(slices)){
    const {where,params}=puuidSliceWhere(slice);
    const [counts]=await paced(env,`WITH inventory AS (${inventorySQL(where)})
      SELECT COUNT(*) AS total,
        COALESCE(SUM(saved_id IS NOT NULL),0) AS saved,
        COALESCE(SUM(saved_id IS NULL),0) AS missing,
        COALESCE(SUM(saved_id IS NULL AND region IS NULL),0) AS missingRegion,
        COALESCE(SUM(saved_id IS NULL AND region IS NOT NULL AND archive_id IS NOT NULL),0) AS archived,
        COALESCE(SUM(saved_id IS NULL AND region IS NOT NULL AND archive_id IS NULL
          AND julianday(next_attempt_at)>julianday('now')),0) AS waitingRetry
      FROM inventory`,params);
    for(const key of COUNTS)inventory[key]+=Number(counts?.[key])||0;
    if(!limit||!(Number(counts?.missing)>0))continue;
    const limitParam=`?${params.length+1}`;
    queued.push(...await paced(env,`WITH inventory AS (${inventorySQL(where)})
      SELECT puuid,match_id,date,region,archive_id IS NOT NULL AS archived FROM inventory
      WHERE saved_id IS NULL AND region IS NOT NULL
        AND (archive_id IS NOT NULL OR next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday('now'))
      ORDER BY archive_id IS NOT NULL DESC,date DESC,puuid,match_id LIMIT ${limitParam}`,[...params,limit]));
  }
  const rows=queued.sort(queueOrder).slice(0,limit).map(({date,...row})=>row);
  return {inventory,rows};
}
