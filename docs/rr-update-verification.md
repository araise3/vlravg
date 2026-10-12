# Stable competitive-update verification

Verified on October 10, 2026 using authenticated requests to
`https://api.henrikdev.xyz`. No beta host was used.

## Live evidence

- Stable `/openapi.json` returned HTTP 200 and documents all 11 supported new
  MMR-history fields with the expected nullable types. `match_length` is explicitly
  milliseconds and `rr_penalty` is a floating-point number.
- Three stable PUUID-history responses returned HTTP 200, with 20, 20 and 19
  entries. Every entry contained the 11 fields. One account had `rr_penalty=0.25`.
- All 59 entries passed the actual frontend history-ingestion code and raw
  collector in an isolated SQLite database: exact starting positions and tiers
  were retained and `last_change` was unchanged.
- 58 of 59 rank-coordinate equations agreed exactly. One promotion from
  Ascendant 1 at 88 RR to Ascendant 2 at 10 RR with a +17 payout had an additional
  five-point floor adjustment. The UI uses the reported start; the benchmark
  correctly excludes this coordinate discrepancy without inventing a payout.

## Saved corpus

Read-only D1 queries found 92,414 payouts, including 25,763 with the new fields.
Nonzero/true cases include 2,292 performance bonuses, 63 AFK penalties, 1,602 RR
penalties, 318 placements, 1,274 protected losses, 561 shield replenishments and
466 refunds. These counts are per-player payout records, not distinct matches.

A bounded, deliberately selected sample of 798 records with match features
covered the above cases plus older missing fields. The analysis retained 616
coordinate-checked non-placement wins/losses: 510 with reported starts and 106
with witnessed predecessor starts. It separately identified ordinary-reported,
unknown-adjustment, bonus, AFK penalty, RR penalty, party/five-stack, shield and
refund cohorts. Cohorts overlap; this sample is not a population estimate.

No nonzero new-map-forgiveness records were found. That branch is covered by
synthetic tests; its nonzero live behavior was not independently observed.
Penalty units and overlap remain unspecified, so no component is added to or
subtracted from `last_change`.

## Regression and browser checks

The relevant JavaScript and Python suites contain 91 passing tests. Coverage
includes reported starts over history gaps/act changes, promotions, cumulative
Immortal RR, zero/false/null values, placement eligibility, shields/refunds,
fractional penalties, preserved details after null responses, snapshot retention
and checksums, escaped text, cohort coverage and player-weighted comparisons.

Desktop and 320px browser checks passed for expanded match details, unavailable
fields, shielded losses, selected-range bonus totals, partial coverage and empty
states. There was no horizontal overflow or browser console error in these
fixture checks. Fixtures are development-only; they are not live player matches.

Two issues were fixed: stable returns `MOVEMENT_UNKNOWN`, which is now treated
as unavailable rather than displayed as a competitive movement event; and the
chart's fallback for a missing `elo` now includes the tier base instead of using
raw RR as the full rank position. The latter was found by a synthetic missing-field
regression test, not in the three live responses.
The shield fixture was also corrected to keep its displayed rank unchanged
while retaining the reported negative payout.

Raw live samples and account identities remain in ignored local verification
files; only this aggregate report and regression tests are versioned.
