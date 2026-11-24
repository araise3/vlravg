// The most one upstream call can cost in HenrikDev units (lib/upstream-pacing.mjs
// holds it while the call is in flight).
//
// HenrikDev charges "1 request to the API = +1" and "1 background request to
// Riot = +1" (docs.henrikdev.xyz general/rate-limiting) and reports no cost
// per call. Answers from HenrikDev's store make no Riot request (1); one
// object makes at most one (2); a match list at most one per match (1 + its
// size, pages capped at MATCH_LIST_MAX_SIZE).
//
// Except where measured higher: account lookups by PUUID with force=true
// (account-by-puuid, name-history) cost 3 in most of 26 clean samples on
// 24 Nov 2026 (cache status HIT: 23 samples, average 2.83, highest 3; why is
// not known). Those samples were taken by a measurement since removed: 429s
// turned out to cost nothing (docs/henrikdev-429-behaviour.md), so these
// bounds only protect the account-lookup reserve and need not be exact.
export const MATCH_LIST_MAX_SIZE=10;
export const FORCED_ACCOUNT_UNITS=3;

// route: a proxy ROUTES entry; match: its RegExp match (name-backfill adds
// `state`); url: the upstream query as sent; requestPath: the /api-relative path.
export function maxUnits(route,match,url,requestPath){
  const list=size=>1+Math.min(MATCH_LIST_MAX_SIZE,Number.isInteger(size)&&size>0?size:MATCH_LIST_MAX_SIZE);
  if(route?.storedMatches||route?.storedMmr||route?.rrHeal)return 1;
  if(route?.accountByPuuid||route?.nameHistory)return FORCED_ACCOUNT_UNITS;
  if(route?.nameBackfill){
    const phase=match?.state?.phase;
    return phase==='stored'?1:phase==='stored-detail'?2:list(10);
  }
  const segment=String(requestPath||'').split('/')[1];
  if(route?.historyByPuuid||segment==='history')return list(Number(url?.searchParams?.get('size')));
  return 2;
}
