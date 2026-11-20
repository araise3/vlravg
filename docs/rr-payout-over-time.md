# RR payout over time

Added 20 Nov 2026 on request: a chart on the RR page that shows how your RR
payout per win and per loss moves across the act.

## What it shows

- **Data** (`rrPayoutTimeline` in `src/engine/core.mjs`): every RR-eligible
  match (`isRREligible`: RR recorded, rated rank, no placement, party below 5)
  in play order with its recorded payout (`myRR`, Riot's `last_change`). Each
  row also carries the trailing mean of the last `RR_PAYOUT_WINDOW` (5) win
  payouts and the last 5 loss payouts seen so far, each over its own results.
  An average is `null` until the first win or loss exists and is carried
  forward through matches of the other result.
- **Chart** (`RRPayoutChart` in `src/app/pages/RR.jsx`): one faint dot per
  match (green win, red loss, yellow draw) and the two trailing averages as
  solid green and red lines, on a signed RR axis with an emphasised zero line.
  The legend shows the latest win and loss averages. Hover or focus gives the
  payout, result, map and score, both averages at that point, and the match
  number and date.
- **Axis**: matches are spaced evenly in play order (match 1, 5, 10, …).
  A Date axis switch was tried and removed on request the same day; the
  tooltip still gives each match's date.
- **Range**: the chart uses the RR summary card's range tabs (all time, 50,
  30, 20), like the RR trend chart.

## Limits

- The averages are descriptive. A trailing mean of five is noisy; a drift in
  it is a pattern in your recorded payouts, not a measured change in hidden
  MMR.
- Excluded: placements, unrated ranks and full 5-stacks, matching the RR
  summary averages. The RR summary's Net RR still counts every recorded
  change.
- Fixtures: `demo` pays a flat +35/−30, so its lines are flat. `climb` has
  drifting payouts (gains about +26 to +16, losses about −12 to −20) to
  exercise the chart.

## Verification

- `tests/rr-payout-time.test.mjs`: eligibility and ordering, the trailing
  averages, x-axis ticks, dots/lines/legend/aria labels, the empty state, the
  card's place after RR trend and the absence of an axis switch.
- Checked in the browser with `?fixture=climb` and `?fixture=demo` at desktop
  width and 375px (no horizontal scroll), including hover.
