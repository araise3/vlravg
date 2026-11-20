# RR payout by starting rank: full-corpus model check (2026-11-20)

Question: which model should draw "Estimated RR payout by starting rank" on
the RR page? The chart currently uses `near30_k5_prior8` (`rrPayoutEstimates`:
up to 5 of the player's own games within a 30 RR span, shrunk toward their
act mean with weight 8).

Outcome: on request, the RR page switched to `gauss60_prior0` the same day
(see "Shipped" below).

## Input

- Snapshot `.local/rr-corpus/snapshots/2026-11-20T01-38-41-146Z` (local only):
  875,157 rows, sha256
  `ab9f58213ee67802aed3ae408402ddf9d9ecce91a31f4cc7d7dd2b907486f31c`.
- Same query and record format as `scripts/export-rr-corpus.mjs`, but
  streamed to gzip (the corpus no longer fits in one in-memory string) and read
  through `wrangler d1 execute --remote` (read-only SELECTs, 1,000 rows per page,
  0.5 s between pages, 29 minutes, no retries). The wrapper and analysis
  scripts are kept beside the results in
  `.local/rr-corpus/benchmark/full-2026-11-20/scripts/`.
- The analysis imports `scripts/benchmark-rr-corpus.py` unchanged and streams
  records into its `eligible_rows`, `evaluate` and `predict`. Run on the
  2026-10-28 snapshot it reproduces the numbers in
  [rr-benchmark-e11.md](rr-benchmark-e11.md) exactly (e11a5 holdout 2.37 /
  2.34 / 2.33; e11a6 3.61 / 2.68 / 3.46, same group and player counts).
- Results: `.local/rr-corpus/benchmark/full-2026-11-20/analysis.json`.

## Eligible data

151,519 clean rows of 875,157 (17%). The main exclusion is missing match
features: 667,622 rows (76%); detail enrichment still covers a minority of
saved payouts. Others: 19,166 party penalty/five-stack, 14,172 coordinate
discrepancies, 12,166 reported bonus/penalty/forgiveness, 4,479 placements,
3,340 without a starting rank, 2,612 draws or missing outcomes.

Clean rows by act: e11a5 29,197 and e11a6 122,284; earlier acts have at most
14 each. **e11a6 is still the latest observed act** (last game
2026-11-20 01:19 UTC), so no act after e11a6 exists in the data.

## 1. Pre-registered temporal benchmark (unchanged method)

Earliest 70% of each player/act/outcome group trains, the latest 30% tests;
player-weighted RMSE on holdout players.

| Act | Holdout players | act_mean | linear | near30 (current) | gauss40 | gauss80 | hybrid |
|---|---|---|---|---|---|---|---|
| e11a5 (complete) | 133 | 2.37 | 2.34 | 2.33 | 2.33 | 2.33 | 2.33 |
| e11a6 (in progress) | 531 | 3.82 | 3.02 | 3.69 | 3.57 | 3.47 | 2.96 |

Pre-registered tests (95% player bootstrap; pass = upper bound below zero):

| Test | e11a5 | e11a6 |
|---|---|---|
| Hybrid vs current curve (decides) | −0.00 [−0.11, +0.10] | −0.73 [−0.88, −0.59] pass |
| Immortal+ linear vs act mean (must pass) | −0.10 [−0.33, +0.15] | −1.49 [−1.76, −1.19] pass |
| Hybrid vs act mean | −0.05 [−0.16, +0.07] | −0.87 [−1.03, −0.71] pass |
| Below Immortal linear vs act mean | +0.02 [−0.27, +0.30] | +0.10 [−0.01, +0.21] |

e11a6 is **consistency only** under the pre-registration (its first two
weeks formed the hypothesis). It is consistent: both deciding tests pass on
the now 4× larger e11a6. The decision itself still needs the act after e11a6,
which has not started in the data.

## 2. Exploratory: fit within the act (labelled exploratory)

The chart describes a player's whole act at each starting rank; it does not
forecast later games. So models were also scored on games held out at random
from inside the act: 5 folds per player/act/outcome group (same 20-game
minimum, tuning/holdout player split and player-weighted RMSE). Three extra
smoothers were tried only here: local-linear kernels (bandwidth 80 and 140 RR)
and a 120 RR Gaussian, each with the same prior weight of 8.

Holdout player RMSE (RR):

| Model | e11a5 (133 players) | e11a6 (531) |
|---|---|---|
| act_mean | 2.144 | 3.134 |
| **linear** | **2.065** | **2.567** |
| near30_k5_prior8 (current) | 2.097 | 2.927 |
| gaussian40_prior8 | 2.083 | 2.813 |
| gaussian80_prior8 | 2.093 | 2.765 |
| hybrid_linear_immortal | 2.089 | 2.586 |
| local_linear80_prior8 | 2.068 | 2.736 |
| local_linear140_prior8 | 2.062 | 2.679 |
| gaussian120_prior8 | 2.105 | 2.781 |

- Tuning players selected `linear` in e11a6 and `local_linear140` in e11a5;
  in e11a5 the two are tied on holdout (−0.002 [−0.023, +0.021]).
- `linear` vs current curve on holdout: e11a6 −0.36 [−0.42, −0.30].
- By band (holdout): below Immortal, `linear` 3.005 vs current 3.063 vs
  act mean 3.104 in e11a6 (best there, `local_linear140`, is 3.004);
  Immortal+, `linear` 2.015 vs current 2.724 vs act mean 3.094.
- Unlike the temporal test, the straight line also helps below Immortal when
  describing the act (about −0.06 RR vs the current curve), though by far less
  than at Immortal+ (about −0.7 RR).

`linear` here is the benchmark's ridge line: per player, act and outcome,
the payout's mean plus a slope of Sxy / (Sxx + 8000) around the mean starting
position, clamped to 0–200.

## 3. Exploratory: a better curve of the current kind

The straight line was rejected on sight: it cannot bend, so a climb whose loss
payout sits flat and then rises (an S-shape) is wrong at both ends. A grid
search then looked for a local curve like the current one. Script and output:
`.local/rr-corpus/benchmark/full-2026-11-20/scripts/grid_search.py` (kept beside the
results) and `grid-search.json`.

- Families: Gaussian-weighted average of the player's games around each
  starting rank, and Gaussian local-linear fits (slope ridge 0, 2,000 or
  8,000). Widths 15–200 RR; pull toward the act mean of 0, 1, 2, 4 or 8
  pseudo-games. 141 variants including the current curve.
- Selection: tuning players only, pooled e11a5+e11a6, within-act 5-fold
  (same rows, groups, player split and fold assignment as above).
- Tuning RMSE: best `loclin80_prior0_ridge8000` 2.443, best Gaussian
  `gauss60_prior0` 2.451, current curve 2.774. Every top-10 variant has no or
  minimal act-mean pull (prior 0–1): the current prior of 8 is what flattens
  the ends.

Holdout players (never used in selection), RMSE vs current curve with 95%
player bootstrap of the difference:

| Slice | gauss60_prior0 | loclin80 | Current |
|---|---|---|---|
| Within act, all | 2.485 (−0.34 [−0.40, −0.29]) | 2.474 (−0.36 [−0.42, −0.30]) | 2.828 |
| Within act, e11a5 | 2.060 (−0.04 [−0.08, −0.01]) | 2.053 (−0.05 [−0.09, −0.01]) | 2.101 |
| Within act, e11a6 | 2.515 (−0.41 [−0.47, −0.34]) | 2.501 (−0.42 [−0.49, −0.35]) | 2.920 |
| Within act, below Immortal | 2.956 (−0.06 [−0.10, −0.03]) | 2.953 (−0.07 [−0.12, −0.02]) | 3.020 |
| Within act, Immortal+ | 1.857 (−0.74 [−0.84, −0.63]) | 1.822 (−0.77 [−0.89, −0.65]) | 2.592 |
| Later games (70/30), all | 2.843 (−0.67 [−0.79, −0.55]) | 2.841 (−0.67 [−0.80, −0.55]) | 3.515 |
| Later games, e11a5 | 2.276 (−0.06 [−0.14, +0.02]) | 2.254 (−0.08 [−0.23, +0.08]) | 2.332 |
| Later games, below Immortal | 3.032 (−0.07 [−0.12, −0.02]) | 3.057 (−0.04 [−0.12, +0.02]) | 3.101 |

Both beat the current curve in every within-act slice, and both also beat the
straight line (e11a6 within-act 2.52/2.50 vs 2.57). `gauss60_prior0` is the
closest to the current method (a local weighted average) and the only one
whose forecasting test below Immortal also excludes zero; it is the
recommended candidate. This search is exploratory: selected on tuning
players and checked on holdout players of the same two acts, not on a later
act.

## Conclusion

- Of the five benchmark models plus the hybrid, the regularized straight line
  (`linear`) had the lowest error, but it cannot follow bends and was
  rejected on review of sample players. The grid search (section 3) found a
  local curve of the current kind that beats both: `gauss60_prior0`, a
  Gaussian-weighted average 60 RR wide with no pull toward the act mean.
- The decision rule recorded on 2026-10-28 has not been met yet: it requires
  the act after e11a6, which does not exist in the data. e11a6 is consistent
  with the hypothesis but cannot confirm it.
- Caveats: three quarters of saved payouts have no match features yet, so
  the clean sample is the enriched subset; the cohort is activity-selected and
  not region-balanced; only two acts have meaningful data.

## Shipped (2026-11-20, on request)

`rrPayoutEstimates` in `src/engine/core.mjs` now draws `gauss60_prior0`: at
each of the player's starting positions, a Gaussian-weighted average of that
outcome's payouts (σ = 60 RR), with no act-mean pull. An estimate is shown
only when at least 3 games of that outcome start within 120 RR (2σ), and
`rrPayoutSegments` breaks the line only across gaps wider than 120 RR. The
chart rows are unchanged (`rrMovementRows`: eligible wins and losses, party
penalties included), as is the even point. Tooltips name the games within
120 RR and keep the act average for reference.

This is a display choice made on exploratory evidence. The pre-registered
hybrid test in [rr-benchmark-e11.md](rr-benchmark-e11.md) still compares
against the fixed `near30_k5_prior8` baseline and is unaffected.
