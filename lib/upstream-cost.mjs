// HenrikDev units per upstream call (lib/upstream-pacing.mjs).
//
// HenrikDev charges "1 request to the API = +1" and "1 background request to
// Riot = +1" (docs.henrikdev.xyz general/rate-limiting) and reports no cost
// per call. Two uses here:
//
// - maxUnits: the most a call can cost under that rule, from what it asks
//   for. A call held in flight counts as this much until its response gives
//   HenrikDev's real count. Answers from HenrikDev's store make no Riot
//   request (1); one object makes at most one (2); a match list at most one
//   per match (1 + its size, pages capped at MATCH_LIST_MAX_SIZE).
// - quota_cost_samples: the measured cost of calls that had the key to
//   themselves (`clean` in upstream-pacing), the drop in HenrikDev's count
//   between two headers of one window, by route key and cache status. It is
//   evidence for checking maxUnits; admission does not use it.
export const MATCH_LIST_MAX_SIZE=10;
export const QUOTA_COST_KEEP_DAYS=14;

export const QUOTA_COST_SCHEMA=`CREATE TABLE IF NOT EXISTS quota_cost_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,observed_at TEXT NOT NULL,pool TEXT NOT NULL,
  route TEXT NOT NULL,cache_status TEXT,status INTEGER,cost INTEGER NOT NULL
)`;

// The route key samples are kept by: the /api path's first segment, plus the
// page size for match lists and the phase for name backfill, since those
// decide how much HenrikDev fetches.
export function costKey(route,match,url,requestPath){
  const segment=String(requestPath||'').split('/')[1]||'other';
  if(route?.nameBackfill)return `${segment}:${match?.state?.phase||'live'}`;
  if(route?.historyByPuuid||segment==='history'){
    const size=Number(url?.searchParams?.get('size'));
    return `${segment}:${Number.isInteger(size)&&size>0?size:'default'}`;
  }
  return segment;
}

// route: a proxy ROUTES entry; match: its RegExp match (name-backfill adds
// `state`); url: the upstream query as sent; requestPath: the /api-relative path.
export function maxUnits(route,match,url,requestPath){
  const list=size=>1+Math.min(MATCH_LIST_MAX_SIZE,Number.isInteger(size)&&size>0?size:MATCH_LIST_MAX_SIZE);
  if(route?.storedMatches||route?.storedMmr||route?.rrHeal)return 1;
  if(route?.nameBackfill){
    const phase=match?.state?.phase;
    return phase==='stored'?1:phase==='stored-detail'?2:list(10);
  }
  const segment=String(requestPath||'').split('/')[1];
  if(route?.historyByPuuid||segment==='history')return list(Number(url?.searchParams?.get('size')));
  return 2;
}

export async function recordCostSample(db,{pool,route,cacheStatus=null,status=null,cost,now=Date.now()}){
  if(!Number.isInteger(cost)||cost<0)return;
  const key=/^[a-z0-9:-]{1,48}$/.test(route||'')?route:'other';
  const cache=/^[A-Z_]{1,16}$/.test(cacheStatus||'')?cacheStatus:null;
  await db.prepare(QUOTA_COST_SCHEMA).run();
  await db.prepare(`INSERT INTO quota_cost_samples(observed_at,pool,route,cache_status,status,cost)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(new Date(now).toISOString(),pool==='workflow'?'workflow':'public',key,cache,
    Number.isInteger(status)?status:null,cost).run();
  await db.prepare('DELETE FROM quota_cost_samples WHERE observed_at<?1')
    .bind(new Date(now-QUOTA_COST_KEEP_DAYS*86400000).toISOString()).run();
}
