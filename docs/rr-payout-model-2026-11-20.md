# RR payout by starting rank: full-corpus model check (2026-11-20)

Question: which model should draw "Estimated RR payout by starting rank" on
the RR page? The chart currently uses `near30_k5_prior8` (`rrPayoutEstimates`:
up to 5 of the player's own games within a 30 RR span, shrunk toward their
act mean with weight 8).

Outcome: on request, the RR page switched to `gauss60_prior0` the same day,
and on 2026-11-21, also on request, went back to the nearby-games curve (see
"Reverted" below), then lowered its act-mean pull from 8 to 2 (see the last
section).

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

## Reverted (2026-11-21, on request)

The user did not like how smooth the 60 RR curve looked and asked for the
previous display back. `rrPayoutEstimates` again draws `near30_k5_prior8`:
up to 5 of the player's own wins (or losses) within a 30 RR span, blended with
their act mean at a prior weight of 8, with gaps where fewer than 3 games are
that close; `rrPayoutSegments` breaks the line across gaps over 30 RR again,
and the tooltip and footnote describe it as before. The benchmark results
above stand as measured; the display is a choice of look over the measured
error difference.

## Data-shaped variants of the current curve (2026-11-21, exploratory)

After the revert, the user named what they like about the current curve: it
looks like data, not a model (local, jagged, with gaps where games are
sparse). Variants that keep that rule were benchmarked
(`.local/rr-corpus/benchmark/full-2026-11-20/scripts/local_grid.py`, results
`local-grid.json` and `local-k5-prior2.json`): at most `k` nearest games
(3/5/8) within a `span` (30/45/60 RR), a gap with fewer than 3, act-mean pull
0/2/4/8, mean or median. Same clean rows, groups, player split and within-act
5-fold as the grid search above; errors on the points each variant draws,
paired comparisons on the points both draw; a variant qualified only if it
did not draw fewer points than the current curve (81% of holdout points).

- Best on tuning players: `k8_span60_prior2_mean`, holdout −0.12 RR vs the
  current curve [−0.15, −0.09]. It draws 94% of points and averages up to 8
  games over 60 RR, so it is visibly smoother with far fewer gaps, which is
  against the stated preference.
- Same look, lighter pull: `k5_span30_prior2_mean` (the current curve with the
  act-mean weight cut from 8 to 2) draws exactly the same points and gaps.
  Holdout vs current: −0.08 RR [−0.11, −0.05] overall; Immortal+ −0.28
  [−0.33, −0.23]; below Immortal +0.04 [+0.01, +0.06] (slightly worse).
  Removing the pull entirely (`prior0`) is not measurably better than now
  (−0.02 [−0.07, +0.02]).
- On sample player A the lighter pull moves the curve's ends onto the dots
  (early losses about 10 instead of 13 RR); on player B the two are nearly
  identical.

Shipped on request on 2026-11-21: `RR_ESTIMATE_PRIOR_WEIGHT` is now 2, so the
frontend draws `k5_span30_prior2_mean` (same window, games and gaps as before).

## Games × window grid at prior 2 (2026-11-21, exploratory)

On request, every combination of up to 3, 4, 5, 6, 7, 8, 10, 12 or 15
nearby games and a 10, 15, 20, 25, 30, 40, 50, 60, 80 or 100 RR window was
run on the same local archive (the 2026-11-20 snapshot's clean rows; no new
D1 export), all at the shipped act-mean prior of 2
(`scripts/games_window_grid.py`, `games-window-grid.json`). Each is compared
with the shipped 5 games / 30 RR on the holdout points both draw (RR, 95%
player bootstrap; negative is better):

| Games \ window | 10 | 15 | 20 | 25 | 30 | 40 | 50 | 60 | 80 | 100 |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | +0.05 | +0.06 | +0.04 | +0.04 | +0.03 | +0.03 | +0.03 | +0.03 | +0.03 | +0.03 |
| 4 | +0.04 | +0.03 | +0.02 | +0.02 | +0.01 | +0.01 | +0.01 | 0.00 | 0.00 | 0.00 |
| 5 | +0.04 | +0.03 | +0.01 | +0.01 | 0 (shipped) | −0.01 | −0.01 | −0.02 | −0.01 | −0.01 |
| 8 | +0.04 | +0.02 | +0.01 | −0.01 | −0.02 | −0.03 | −0.04 | −0.04 | −0.04 | −0.04 |
| 10 | +0.04 | +0.02 | 0.00 | −0.01 | −0.02 | −0.04 | −0.05 | −0.05 | −0.06 | −0.06 |
| 15 | +0.04 | +0.02 | 0.00 | −0.01 | −0.02 | −0.04 | −0.05 | −0.06 | −0.06 | −0.06 |
| Points drawn | 43% | 56% | 70% | 77% | 81% | 88% | 91% | 94% | 97% | 98% |

(6, 7 and 12 games sit between their neighbours.) The share of points drawn
depends only on the window, since a point needs 3 games inside it.

- Every difference is small next to the typical error of about 2.5 RR: the
  best (10–15 games over 80–100 RR, −0.06) draws 97–98% of points and is the
  smoothest, against the stated preference.
- With the shipped gaps (30 RR), up to 8 games is −0.02 RR [−0.02, −0.01],
  better in both rank bands; 10, 12 and 15 games add almost nothing more.
- Windows under 25 RR and fewer than 5 games are worse, and narrow windows
  leave many more gaps.

## Detailed accuracy (2026-11-21)

`scripts/accuracy_detail.py` scored all 90 combinations above on 44,443
holdout points (prior 2), each on the points it and the shipped 5 games /
30 RR both draw; full results in `accuracy-detail.json` and
`accuracy-detail.csv`. Errors are estimate minus actual payout, in RR.

| Games / window | Drawn | RMSE | Mean abs. | Median abs. | Bias | Within 1 | Within 2 | Within 3 |
|---|---|---|---|---|---|---|---|---|
| 3 / 30 | 81% | 2.58 | 1.65 | 1.20 | +0.05 | 43.3% | 71.0% | 85.3% |
| **5 / 30 (shipped)** | 81% | 2.55 | 1.61 | 1.16 | +0.04 | 44.1% | 72.1% | 85.8% |
| 8 / 30 | 81% | 2.53 | 1.60 | 1.15 | +0.03 | 44.9% | 72.6% | 86.1% |
| 15 / 30 | 81% | 2.53 | 1.59 | 1.14 | +0.03 | 44.9% | 72.8% | 86.2% |
| 5 / 60 | 94% | 2.53 | 1.60 | 1.14 | +0.04 | 44.5% | 72.4% | 86.0% |
| 8 / 60 | 94% | 2.51 | 1.57 | 1.11 | +0.03 | 45.9% | 73.2% | 86.4% |
| 15 / 100 | 98% | 2.49 | 1.56 | 1.12 | +0.03 | 45.7% | 73.6% | 86.5% |

Shipped curve by group (points, RMSE, mean abs., within 2 RR): wins 18,826,
2.15, 1.49, 74.2%; losses 17,369, 2.71, 1.75, 69.8%; Iron–Gold 4,177, 4.20,
3.32, 37.3%; Platinum–Diamond 4,556, 2.33, 1.88, 61.0%; Ascendant 4,469,
1.51, 1.10, 84.4%; Immortal 12,551, 1.97, 1.28, 80.5%; Radiant 10,442, 1.93,
1.43, 75.5%. Bias stays within ±0.1 RR in every group. 8 / 30 improves every
group by 0.01–0.02 RMSE and 0.4–1.1 points within 2 RR.

Windows under 30 RR are scored only on the denser points they draw, so their
hit rates look better than they are; their RMSE on comparable points is in
the grid above.

## Round margin (2026-11-21, exploratory)

Riot names round margin as a payout factor. `scripts/margin_effect.py`
(`margin-effect.json`) joined each clean payout to its match's rounds won and
lost (151,481 rows with both; margins 2–13) and measured, within each
player/act/outcome group (20+ games) and rank group, the slope of payout
magnitude on absolute round margin, controlling for starting position.
Player-bootstrap 95% intervals; tuning and holdout players separately.

| RR per extra round of margin | Wins (tuning / holdout) | Losses (tuning / holdout) |
|---|---|---|
| Iron–Gold | +0.35 / +0.35 | +0.45 / +0.45 |
| Platinum–Diamond | +0.38 / +0.38 | +0.42 / +0.44 |
| Ascendant | +0.32 / +0.33 | +0.36 / +0.37 |
| Immortal | +0.36 / +0.37 | +0.31 / +0.31 |
| Radiant | +0.35 / +0.33 | +0.33 / +0.33 |

Every interval is about ±0.02–0.05 and excludes zero; tuning and holdout
agree. A 13–3 win (margin 10) pays about 2.5–3 RR more than a 13–11 win, and
a 3–13 loss costs about 2.5–3.5 RR more than an 11–13 loss.

Display test: the shipped curve (5 games within 30 RR, prior 2) computed on
payouts moved to a 4-round margin with the tuning slopes, then the held-out
game's own margin added back, against the shipped curve on the same holdout
points: RMSE 2.32 vs 2.55, −0.22 RR [−0.25, −0.20]; better in every rank
group (Iron–Gold −0.18, Platinum–Diamond −0.32, Ascendant −0.34, Immortal
−0.18, Radiant −0.25) and for wins (−0.24) and losses (−0.23). That is about
ten times the gain of any games/window setting above.

Shipped on request on 2026-11-21: `rrMarginAdjusted` in `src/engine/core.mjs`
moves each chart payout to a 4-round margin with the tuning slopes rounded to
two decimals (`RR_MARGIN_SLOPES`, by outcome and the starting tier's rank
group) before the 5-games / 30 RR average and its act mean; games without a
known score keep their raw payout. The dots stay actual payouts; tooltips and
the footnote say the line is at a typical 4-round margin. The even point
still uses raw payouts. Asked whether margins "balance out" with enough games:
over a whole act they largely do (the act mean barely moves), but each point
averages at most 5 nearby games, where one blowout shifts it by about 0.5 RR;
the holdout gain above is measured at that scale.

On araïse#5055 (e11a6, 170 games) part of the 3–4 RR
win/loss gap near 90–120 RR into Immortal came from margins: the large losses
there were 9–11-round blowouts and the wins mostly 2-round games; at a
4-round margin the gap is about 3 RR instead of about 3.8.
