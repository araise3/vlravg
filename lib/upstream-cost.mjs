// Estimated HenrikDev units for one upstream call (lib/upstream-pacing.mjs).
// HenrikDev counts "1 request to the API = +1" and "1 background request to
// Riot = +1" (docs.henrikdev.xyz general/rate-limiting). Answers from its own
// store cost 1; single objects it may fetch from Riot cost 2; a live match
// list costs at most 1 + its size (pages are capped at 10). These are upper
// estimates: the response header then sets the real count.
export const MATCH_LIST_MAX_SIZE=10;

const list=size=>1+Math.min(MATCH_LIST_MAX_SIZE,Math.max(1,Number.isInteger(size)?size:MATCH_LIST_MAX_SIZE));

// route: a proxy ROUTES entry; match: its RegExp match (name-backfill adds
// `state`); url: the upstream query as sent; requestPath: the /api-relative path.
export function upstreamCost(route,match,url,requestPath){
  if(route.storedMatches||route.storedMmr||route.rrHeal)return 1;
  if(route.nameBackfill)return match?.state?.phase==='stored'?1:match?.state?.phase==='stored-detail'?2:list(10);
  if(route.historyByPuuid||/^\/history\//.test(requestPath||'')){
    const size=url?.searchParams?.has('size')?Number(url.searchParams.get('size')):NaN;
    return list(size);
  }
  return 2;
}
