# RR payout benchmark: e11a5 and e11a6 (2026-10-28)

First runs of `scripts/benchmark-rr-corpus.py`. Goal: find out whether any
starting-rank curve predicts a player's RR gain/loss better than their own act
average. e11a5 is complete. e11a6 was about two weeks old and still running,
and it was added afterwards to enlarge the sample (see "Adding e11a6").

## Input

- Snapshot `.local/rr-corpus/snapshots/2026-10-28T20-24-45Z` (local only):
  212,044 rows, sha256 `dfc402440b3b2d7d40403c930c3f42ac89fa2bf5e1edea39a1e97632f3d6154b`.
  It was exported with `scripts/export-rr-corpus.mjs` unchanged; its D1 query
  function went through `wrangler d1 execute` (read-only) because no
  `CF_API_TOKEN` was set locally.
- Command: `python scripts/benchmark-rr-corpus.py <snapshot>/corpus.ndjson.gz --act e11a5`.
- Report: `.local/rr-corpus/benchmark/e11a5-2026-10-28/benchmark.json`.

## Eligible data

Of 115,964 e11a5 payouts, 29,055 were clean (25%). The largest exclusion was
missing match features: 73,855 rows (64%). Detail enrichment had covered only
36% of this act when the snapshot was taken. Other exclusions: 3,923
party-penalty/five-stack, 3,280 with no starting rank, 2,775 rank-coordinate
discrepancies, 2,334 reported bonus/penalty/forgiveness, 510 draws or missing
outcomes, 195 placements, and a few others.

Starting rank was reported for 25,297 clean rows and taken from a witnessed
predecessor for 3,758. 425 player/outcome groups had 20+ clean games: 126
tuning players and 133 holdout players, with 3,955 temporal test rows.

## Result

Player-weighted RMSE of RR payout on later games (earliest 70% trains, last
30% tests):

| Model | Tuning | Holdout |
|---|---|---|
| act_mean (player's own average) | 2.44 | 2.37 |
| linear (selected on tuning) | 2.37 | 2.34 |
| near30_k5_prior8 (current frontend curve) | 2.43 | 2.33 |
| gaussian40_prior8 | 2.40 | 2.33 |
| gaussian80_prior8 | 2.39 | 2.33 |

Paired holdout comparison of the selected `linear` model, resampled by player
(95% bootstrap):

- vs `act_mean`: −0.03 RR, interval [−0.22, +0.15]
- vs `near30_k5_prior8`: +0.01 RR, interval [−0.17, +0.18]

Both intervals include zero. No model measurably beats the player's own act
average. `ready_to_review: true` only means at least 30 holdout players; it
does not indicate a better model.

## Coverage by rank (holdout)

Bands below are an aggregation made for this note: row-weighted RMSE combined
from the report's per-tier entries. They are approximate.

| Band | Test rows | Most players in one tier/outcome | RMSE act_mean / linear / near30 / gauss80 |
|---|---|---|---|
| Iron–Bronze (3–8) | 49 | 3 | 5.47 / 4.85 / 5.29 / 5.41 |
| Silver (9–11) | 55 | 3 | 4.96 / 5.27 / 4.98 / 4.98 |
| Gold (12–14) | 83 | 4 | 3.03 / 2.70 / 2.97 / 3.00 |
| Platinum (15–17) | 118 | 5 | 2.79 / 2.93 / 2.82 / 2.78 |
| Diamond (18–20) | 144 | 7 | 2.04 / 2.87 / 2.04 / 2.03 |
| Ascendant (21–23) | 263 | 14 | 1.65 / 1.52 / 1.62 / 1.61 |
| Immortal (24–26) | 798 | 30 | 1.66 / 1.63 / 1.62 / 1.60 |
| Radiant (27) | 632 | 39 | 1.89 / 1.62 / 1.86 / 1.80 |

Two thirds of the holdout rows are Immortal or Radiant. Below Platinum, no
single tier/outcome has more than 4 holdout players. Errors there are larger
(about 3–5 RR), but the sample is too small to compare models.

## e11a5 conclusion

- Within e11a5, a player's payouts are predicted to about 2.3 RR by their own
  average. No starting-rank curve tested adds measurable accuracy.
- Backfilling e11a5's missing details would roughly triple its eligible rows.

## Adding e11a6

These runs use the same snapshot. e11a6 alone was run with `--act e11a6`. The
pooled run feeds the clean rows of both acts to the script's own
`eligible_rows`/`evaluate`; the wrapper lived in the session scratchpad.
Groups stay per player, act and outcome, and each player keeps one
tuning/holdout assignment across acts.

| Run | Eligible rows | Groups | Holdout players | Test rows |
|---|---|---|---|---|
| e11a5 | 29,055 / 115,964 | 425 | 133 | 3,955 |
| e11a6 (in progress) | 57,824 / 89,213 | 992 | 310 | 10,627 |
| Pooled | 86,879 / 205,177 | 1,417 | 353 | 14,582 |

Holdout player RMSE (RR):

| Model | e11a5 | e11a6 | Pooled |
|---|---|---|---|
| act_mean | 2.37 | 3.61 | 3.30 |
| linear (selected on tuning in all three) | 2.34 | 2.68 | 2.58 |
| near30_k5_prior8 (current frontend) | 2.33 | 3.46 | 3.17 |
| gaussian40_prior8 | 2.33 | 3.34 | 3.08 |
| gaussian80_prior8 | 2.33 | 3.23 | 2.99 |

Paired holdout differences for `linear` (95% player bootstrap):

- e11a6: −0.93 [−1.11, −0.73] vs act_mean; −0.78 [−0.94, −0.59] vs near30.
- Pooled: −0.71 [−0.87, −0.56] vs act_mean; −0.59 [−0.74, −0.44] vs near30.

Pooled holdout RMSE by band (approximate aggregation, as above):

| Band | Test rows | Most players in one tier/outcome | act_mean / linear / near30 / gauss80 |
|---|---|---|---|
| Iron–Bronze (3–8) | 172 | 5 | 4.69 / 4.69 / 4.66 / 4.64 |
| Silver (9–11) | 215 | 10 | 4.13 / 4.42 / 4.13 / 4.18 |
| Gold (12–14) | 215 | 12 | 3.69 / 3.54 / 3.69 / 3.65 |
| Platinum (15–17) | 437 | 17 | 2.94 / 3.04 / 2.96 / 2.93 |
| Diamond (18–20) | 556 | 22 | 2.25 / 2.38 / 2.24 / 2.18 |
| Ascendant (21–23) | 851 | 28 | 1.72 / 1.57 / 1.69 / 1.67 |
| Immortal (24–26) | 2,682 | 79 | 2.61 / 2.08 / 2.46 / 2.36 |
| Radiant (27) | 2,591 | 114 | 4.39 / 2.44 / 4.15 / 3.69 |

## Overall conclusion

- With e11a6 included, `linear` beats both the player's act average and the
  current curve, and the intervals exclude zero.
- The gain comes from Immortal and Radiant: 4.39 → 2.44 RR at Radiant and
  2.61 → 2.08 at Immortal. Payouts there change with the starting RR position
  within an act. From Iron to Diamond, no model measurably beats the player's
  own average; `linear` is slightly worse in Silver and Platinum.
- e11a5 showed no such gain. A plausible but unverified explanation is
  early-act climbing: in e11a6's first two weeks, Immortal+ players moved far
  along the RR axis, so their later games started from very different
  positions than their earlier ones.
- A rank-dependent curve for Immortal+ and the player's own average below is
  suggested by these results. That split was chosen after seeing the holdout,
  so it must be confirmed on data not used here before any frontend change.
  The natural check is the completed e11a6 plus the next act.
- Unknown: whether the Immortal+ gain holds for a full act, and anything
  reliable below Gold (at most 5–12 holdout players per tier/outcome).

## Pre-registration (recorded 2026-10-28, before any later data was seen)

The hypothesis below came from the exploratory results above. It is fixed in
code by the commit that adds this section, so the confirming test cannot be
adjusted after its data is seen. Changing any of it requires a new,
separately dated pre-registration.

**Hypothesis.** The model `hybrid_linear_immortal` beats the current frontend
curve. It predicts a payout with `linear` when the game's starting position
is Immortal 1 or higher (`x >= 2100`), and with the player's act mean
(`act_mean`) below that.

**Fixed analysis.** This is `scripts/benchmark-rr-corpus.py` as of that commit,
unchanged:

- clean-row filter;
- per player/act/outcome groups of 20+ games, with the earliest 70% training
  and the latest 30% testing;
- tuning/holdout split by SHA-256 of the player key;
- player-weighted RMSE;
- 1,000 player bootstrap draws with seed 17431.

The hybrid is scored separately and is never part of tuning selection. The
report's `evaluation.preregistered` block computes:

| Test | Role |
|---|---|
| `primary_hybrid_vs_current_curve`: hybrid vs `near30_k5_prior8` | Decides |
| `immortal_plus_linear_vs_act_mean`: Immortal+ test rows only | Must also pass |
| `hybrid_vs_act_mean` | Reported |
| `below_immortal_linear_vs_act_mean` | Reported; expected not to pass |

A test passes when the upper bound of its 95% interval is below zero.

**Data.**

- *Confirmatory*: the first act none of whose games were in the 2026-10-28
  snapshot, i.e. the act after e11a6, benchmarked with `--act` once it is
  superseded. At least 30 holdout players in the Immortal+ subset are
  required; with fewer, the result is inconclusive, not a failure.
- *Consistency only*: the completed e11a6. Its first two weeks were used to
  form the hypothesis, so it cannot confirm it.

**Decision.** Ship the hybrid to the frontend only if both deciding tests pass
on the confirmatory act. Otherwise keep the current curve, and record the
outcome here either way.

**Exploratory values on the 2026-10-28 snapshot** (not evidence for the
hypothesis, since they formed it):

| Test | e11a5 | e11a6 | Pooled |
|---|---|---|---|
| Hybrid vs current curve | −0.00 [−0.11, +0.10] | −0.79 [−0.95, −0.62] | −0.60 [−0.74, −0.46] |
| Immortal+ linear vs act mean | −0.10 [−0.33, +0.15] | −1.48 [−1.72, −1.21] | −1.20 [−1.43, −0.96] |
| Below Immortal linear vs act mean | +0.02 [−0.27, +0.30] | +0.04 [−0.08, +0.16] | −0.00 [−0.09, +0.08] |

Adding the hybrid changed none of the existing outputs. Model tables, the
tuning selection and paired comparisons are identical to the runs above.
`tests/rr_benchmark_preregistered_test.py` checks that the hybrid switches
exactly at Immortal 1, is never selected, and that pass flags follow the
interval rule.
