# Riot direct API versus the existing HenrikDev proxy

Measured on 29 September 2026 from a Cloudflare Pages Function.

Tested 24 cached-player samples (ap: 8, eu: 8, kr: 1, na: 7), plus four regional full-page checks. The sample was frozen before the main run; 24 distinct player hashes were observed. Players were sampled from rr_players, restricted to PC. No fixed RIOT_TARGET_PUUID was required.

## Speed

These are completed response-body transfer times, excluding the intentional 500 ms pause before each request. Henrik measurements include the production proxy, its server-side pacing and persistence. HIT and MISS refer to our proxy cache, not HenrikDev's internal caching. This is not a raw API-to-API comparison.

| Provider | Endpoint | Successful samples | Median ms | p95 ms | Proxy HIT / MISS |
| --- | --- | ---: | ---: | ---: | --- |
| riot | content | 24 | 672 | 837 | 0 / 0 |
| riot | rank | 24 | 892 | 1047 | 0 / 0 |
| riot | history | 24 | 175 | 767 | 0 / 0 |
| riot | rr | 24 | 178 | 763 | 0 / 0 |
| riot | detail | 24 | 1016 | 1617 | 0 / 0 |
| henrik-proxy | account | 24 | 182 | 1272 | 10 / 14 |
| henrik-proxy | rank | 24 | 444 | 907 | 1 / 23 |
| henrik-proxy | history | 24 | 671 | 2789 | 4 / 20 |
| henrik-proxy | rr | 24 | 129 | 1915 | 4 / 20 |

Riot cookie renewal + identity + entitlement requests had a median summed transfer time of 192 ms per player test.

Riot history returns IDs; Henrik history returns full match records. The two history latency rows therefore represent different amounts of useful data.

| Region | Shared full matches fetched from Riot | Sum of Riot detail transfer times, ms | Henrik ten-match history response, ms | Henrik cache |
| --- | ---: | ---: | ---: | --- |
| ap | 10 | 8530 | 572 | MISS |
| eu | 8 | 682 | 338 | MISS |
| kr | 10 | 15355 | 601 | MISS |
| na | 10 | 9497 | 571 | MISS |

Riot details were fetched sequentially. The detail sums exclude authentication, history lookup and pacing; they are lower bounds on a sequential full-page workflow. Bounded parallel fetching could improve this, but was not measured. EU only had eight shared history matches, so that row is not a ten-versus-ten comparison. Authentication was deliberately renewed for each player test; an application would reuse valid tokens.

## Data parity

- 429 paired RR payouts: 0 mismatches.
- 429 paired Rank Shield flags: 0 mismatches.
- 429 paired refund values: 0 mismatches.
- 38 full matches / 380 paired player records in the regional deep checks. Kills, deaths, assists and score mismatches: {"kills":0,"deaths":0,"assists":0,"score":0}.
- Match-player tier mismatches: 0 / 380.
- Naive sum of Riot roundDamage differed from Henrik dealt damage for 14 / 380 paired player records. ADR requires an explicit damage mapping, not blind summation.

Current-rank season tier differed for 2 player(s), while RR matched. For the inspected Immortal player, the seasonal CompetitiveTier was 24 (Immortal 1), while LatestCompetitiveUpdate.TierAfterUpdate and the newest RR update were 26 (Immortal 3), matching Henrik. This is an adapter field-selection issue; do not treat the raw seasonal tier as universally equivalent to the displayed tier.

Self-damage is one source of damage discrepancies: the diagnostic showed 999-point events. Excluding all self-damage is also incorrect in the sampled data: it produced 42 mismatches over the regional deep checks. Keep ADR parity unresolved until the event/stat semantics are mapped explicitly.

Current rank mapping diagnostic:

```json
{
  "comparable": true,
  "riotTier": 24,
  "henrikTier": 26,
  "riotRR": 426,
  "henrikRR": 426,
  "latestUpdateTier": 26,
  "latestHistoryTier": 26,
  "seasonalFields": [
    "SeasonID",
    "NumberOfWins",
    "NumberOfWinsWithPlacements",
    "NumberOfGames",
    "Rank",
    "CapstoneWins",
    "LeaderboardRank",
    "CompetitiveTier",
    "RankedRating",
    "WinsByTier",
    "GamesNeededForRating",
    "TotalWinsNeededForRank"
  ],
  "mmrFields": [
    "Version",
    "Subject",
    "LatestCompetitiveUpdate",
    "NewPlayerExperienceFinished",
    "IsActRankBadgeHidden",
    "IsLeaderboardAnonymized",
    "OnboardingFlowV2Enabled",
    "OnboardingStatus",
    "IsAtDerankProtectedTier",
    "DerankProtectedGamesRemaining",
    "DerankProtectedStatus",
    "QueueSkills"
  ],
  "tierMatches": false,
  "rrMatches": true
}
```

RR field mappings verified from live schemas: RankedRatingEarned → last_change; WasDerankProtected → was_derank_protected; RankedRatingRefundApplied → refunded_rr. Riot also provides before/after RR and tiers, performance bonus, AFK/party penalties, IsPlacementMatch, and shield replenishment. The earlier draft's guessed RankedRatingWasDerankProtected/RankedRatingRefunded names were incorrect; they are not missing features.

Both APIs expose party IDs, season IDs, kill events, plant/defuse data, round statistics and hit-location data. Henrik round statistics are rounds[].stats, while Riot uses roundResults[].playerStats; differing keys do not mean absent data. Riot includes explicit observer flags. Henrik uses transformed metadata/agent/map/weapon names; direct Riot data needs a schema adapter and content-ID lookups before it can feed processMatch(). The clutch algorithm was not run against translated raw data, so clutch parity remains unverified.

## History depth

| Region | Riot history page 20–39 | Riot RR page 20–39 |
| --- | --- | --- |
| ap | HTTP 200: 1 entries | HTTP 400: 0 entries |
| eu | HTTP 400: 0 entries | HTTP 400: 0 entries |
| kr | HTTP 200: 20 entries | HTTP 200: 20 entries |
| na | HTTP 200: 19 entries | HTTP 400: 0 entries |

The Korean sample successfully returned a second page of 20 RR updates. Do not assume a hard 20-game cap on Riot's direct endpoint. Some out-of-range page probes returned 400; that does not prove the endpoint is broken or establish a global retention limit. Requests at indices 100–119 were exploratory and must not be included as ordinary request failures or timing comparisons. The existing proxy's RR history contains accumulated stored entries, so its entry count is not comparable to a single live Riot page. The EU deep sample had only eight accessible Riot history entries while Henrik returned ten; this is an observed coverage difference, not proof of a universal retention period.

## Rate limits and reliability

Across the saved phases, 489 Riot requests produced 0 rate-limit responses. The Henrik-backed proxy produced 2 saved rate-limit responses. A further HTTP 429 was observed at sample 11 of the first main attempt before resuming; its partial player record was replaced during resume and is not included in the saved metric totals. Each phase stopped at a 429; the continuation honored a cooldown. Henrik's quota is shared with live visitors, and the proxy may issue its own preflight 429, so this does not establish Henrik's raw per-key ceiling or attribute every rejection to upstream. No quota numbers or partition keys were exposed.

Riot's missing rate headers are not evidence of unlimited requests. Traffic was paced, sequential, through one dedicated account and one Cloudflare deployment. No concurrency ramp, sustained capacity ceiling, token-expiry endurance test, console test or custom-game comparison was performed.

## Recommendation

Use direct Riot as a candidate supplemental backend, not a proven universal replacement. It supplies the required stat/RR primitives and additional raw fields, and bypassed the Henrik proxy's quota bottleneck in this run. It did not consistently beat the existing proxy for full match pages, and needs rank/damage/schema mapping, name#tag resolution, caching, persistent history and session-refresh recovery. Keep the existing provider until these mappings and coverage differences are resolved.
