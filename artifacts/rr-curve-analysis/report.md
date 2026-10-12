# RR payout curves: corpus analysis and proposed methodology

Analysis date: 1 October 2026. Recommendation is for a retrospective chart of this player's recorded act, rather than a hidden-MMR model or a next-match payout predictor.

## Recommendation

Replace the hard five-neighbour / 30-RR rule with a **Gaussian distance-weighted mean, using an 80-RR bandwidth as the default**, fitted separately to wins and losses within one player and act. Evaluate it on a fixed 5-RR grid. Preserve the actual match dots. Use evidence strength to change line treatment, and stop local estimates across genuinely unsupported regions.

This is a practical choice among near-tied estimators. The corpus does **not** establish a uniquely optimal algorithm or a significant prediction-accuracy advantage. It does establish that the current narrow rule discards much of the available support and introduces unnecessary small bends and breaks. A broad weighted mean is simpler and visually more stable than a local polynomial while achieving essentially the same held-out accuracy.

The earlier suggestion to change 30 RR to 40 RR would repair sxllow's particular gap. After this broader analysis, I would not adopt it as the general methodology: it retains the abrupt neighbour changes, and its overall held-out error is slightly worse.

## Corpus and eligibility

The analysis combines the original research files, collection waves 2–6, current sxllow data, and a read-only export of the production D1 store. No application code or deployed model was modified. The export made 36 SELECT queries, reported zero rows written, and reported no database changes.

Production contains 66,094 RR rows from 902 players. Only 2,033 production rows from 67 players join to saved full match details. The combined sources contain 68,493 unique player-match history entries and 13,025 joins to match evidence. The remaining 55,468 history entries are useful for reconstructing rank chronology, but were not used as payout training rows because outcome and party eligibility cannot be fully verified.

After excluding unranked/placement entries, witnessed act openers, draws, known five-stacks, positive party penalties, and an outcome/sign inconsistency, the usable corpus has **11,564 matches, 624 players, and 824 player-acts**.

| Starting-rank family | Eligible matches | Players represented |
|---|---:|---:|
| Iron | 807 | 61 |
| Bronze | 942 | 73 |
| Silver | 641 | 53 |
| Gold | 455 | 41 |
| Platinum | 487 | 43 |
| Diamond | 1,058 | 71 |
| Ascendant | 1,343 | 102 |
| Immortal+ | 5,831 | 306 |

Counts of players by rank overlap when a player crossed a rank family.

There are 4,083 eligible rows whose old slim match records do not contain party size. Known positive penalties are excluded, but an unpenalized five-stack cannot be proved absent for those rows. A separate known-party-size analysis gives the same broad conclusion; the fully verified production cohort also favours broader weighting.

Raw RR remains Riot's `last_change`; refunds are not added to the payout. Rank Shield losses keep their actual negative payout. Immortal+ starting positions use the continuous coordinate `2100 + leaderboard RR`; there is no extra 100-RR jump on an Immortal tier change. Starting tier follows the previous same-season history entry when available.

The chronology is observational. In 828 usable entries, ending displayed rank did not exactly equal starting rank plus applied payout/refund. Promotions, demotions and protection can explain such discrepancies; it is not evidence that all these rows are wrong. Only 7 discrepancies exceeded 30 RR. The coordinate-consistency and alternative-coordinate checks below assess sensitivity without rewriting these rows as presumed errors.

Legacy player identity is a case-folded Riot ID, while production detail joins use PUUID. Old renamed identities cannot all be reconciled retrospectively. This and shared matches between sampled opponents limit the interpretation of player-level bootstrap intervals.

## What the corpus can resolve

The median evaluated player-act-outcome group has **9 matches**. Its median observed rank span is **80 RR**. The 90th percentile group has 13 matches; the longest group has 90. These snapshots support broad means much more reliably than a detailed payout function with many local turns.

The evaluation includes groups with at least six matches of the same outcome: 977 groups and 9,738 rows. Groups below six are retained in the audit but excluded from model comparison because a three-block holdout would leave too little data. They are addressed explicitly in the proposed low-data display policy.

Of the evaluated groups with at least ten matches, the median absolute correlation between rank and chronological match index is **0.785**. A player climbing through ranks is also moving through time. Changes in hidden MMR, recent form, performance, opponents and round margins may accompany the rank change. A curve here describes the saved matches at each starting rank; it cannot identify the causal effect of rank itself.

## Benchmark design

I tested **92 configurations**:

- The player's act average and a regularized straight-line baseline.
- The current hard-neighbour estimator and variants with spans of 30/40/60/100 RR, 5/10/20 neighbours, and prior weights of 0/8/20.
- Gaussian weighted means with bandwidths of 20/30/40/60/80/100/150/200 RR and the same prior choices.
- Tricube weighted means and regularized local linear fits at 40/60/80/100/150/200 RR.
- Adaptive nearest-neighbour local linear fits with 10/20/30 neighbours and 100/200-RR bandwidth caps.

The local linear implementations have a ridge on slope to avoid unstable edge estimates; these are local-regression variants, not a claim that the default statsmodels LOWESS implementation was run. LOWESS itself uses nearby observations and weighted local linear regression. [Method reference](https://www.statsmodels.org/stable/generated/statsmodels.nonparametric.smoothers_lowess.lowess.html).

Players were assigned deterministically to separate tuning and holdout sets. All acts and outcomes from one named player stay on the same side. Hyperparameters were ranked by tuning-set player-balanced RMSE, then scored on held-out players. The tuning winner was Gaussian 80 RR without the fixed act-mean prior. The final holdout contains **4,516 matches from 271 players**. Each estimator is still trained on the eligible matches of the individual player-act it is describing; there is no pooled cross-player payout curve.

Within each group I measured:

1. Leave-one-match-out error, recomputing all terms and the prior without that match.
2. Three contiguous chronological holdout blocks of same-outcome matches. This is the primary comparison because nearby matches can be dependent.
3. A forward check: train on the first 70% of same-outcome matches, score the remaining 30%.

Separation of correlated groups and time-aware validation follows the reasoning in the [scikit-learn cross-validation guide](https://scikit-learn.org/stable/modules/cross_validation.html). Blocking reduces dependence leakage but does not prove complete session independence. The forward check is a robustness check, not a validation of a next-match prediction product.

Predictions without sufficient local support fall back to that player's training act average **for scoring only**. Every method is scored on the same held-out rows. Otherwise a method could appear more accurate merely by refusing difficult matches. Local coverage is reported separately. The fallback is not presented as a supported local curve in the chart analysis.

The primary RMSE first averages squared errors within player, then averages across players and takes a square root. This prevents sxllow and other longer histories from dominating parameter selection. Match-weighted RMSE and MAE are included for transparency.

I also matched the Python implementation of the current estimator against the actual JavaScript function on 76 corpus groups, including equal-RR ties and sparse samples. Every compared estimate agreed to numerical precision.

## Held-out results

| Method | Player-balanced RMSE (RR) | Match-weighted RMSE (RR) | MAE (RR) | Local estimate coverage |
|---|---:|---:|---:|---:|
| Flat act average | 3.903 | 3.581 | 2.229 | Act average everywhere |
| Regularized straight line | 3.895 | 3.566 | 2.205 | 100.0% |
| Current: 30 RR / five neighbours / prior 8 | 3.905 | 3.581 | 2.223 | 48.7% |
| 40 RR / five neighbours / prior 8 | 3.913 | 3.591 | 2.226 | 64.0% |
| Gaussian weighted mean, 60 RR | 3.893 | 3.566 | 2.197 | 98.2% |
| Gaussian weighted mean, 80 RR | 3.894 | 3.565 | 2.203 | 99.4% |
| Gaussian weighted mean, 100 RR | 3.896 | 3.567 | 2.210 | 99.7% |
| Tricube local linear, 150 RR | 3.891 | 3.563 | 2.194 | 97.7% |
| Tricube local linear, 200 RR | 3.896 | 3.566 | 2.201 | 99.3% |

The Gaussian 80 method improves player-balanced RMSE by only **0.011 RR** relative to the current method. A 3,000-resample paired player bootstrap gives a difference interval of **[-0.036, 0.012] RR**; negative favours Gaussian. Since that interval includes zero, the predictive improvement is not established. The bootstrap is an approximate uncertainty measure, not proof of a global optimum.

Gaussian 60 and regularized tricube local linear fits are close alternatives. A slightly better number for an alternative on the holdout does not justify choosing it after looking at that same holdout. The simpler Gaussian 80 rule remains the choice selected before holdout inspection.

The current model's 8-match prior gives the act average 8/(3+8) to 8/(5+8), or **62–73% of each local estimate**. That explains why its curves often look nearly flat even while tiny local neighbour changes generate jagged wiggles. Broad weighting pools the evidence continuously rather than applying a fixed eight-match pseudo-sample at each point.

### Forward check

| Method | Player-balanced RMSE (RR) | Match-weighted RMSE (RR) | MAE (RR) | Local estimate coverage |
|---|---:|---:|---:|---:|
| Flat act average | 3.917 | 3.630 | 2.285 | Act average everywhere |
| Regularized straight line | 3.910 | 3.609 | 2.259 | 100.0% |
| Current: 30 RR / five neighbours / prior 8 | 3.918 | 3.630 | 2.276 | 45.5% |
| 40 RR / five neighbours / prior 8 | 3.930 | 3.643 | 2.280 | 60.8% |
| Gaussian weighted mean, 60 RR | 3.925 | 3.614 | 2.248 | 97.6% |
| Gaussian weighted mean, 80 RR | 3.916 | 3.610 | 2.257 | 98.8% |
| Gaussian weighted mean, 100 RR | 3.912 | 3.612 | 2.265 | 99.7% |
| Tricube local linear, 150 RR | 3.919 | 3.610 | 2.244 | 96.8% |
| Tricube local linear, 200 RR | 3.919 | 3.613 | 2.256 | 98.8% |

The forward results do not show a clear advantage in player-balanced error over the act mean. This reinforces using the curves as retrospective descriptive averages, not payout forecasts.

## Display stability and interruptions

Display measurements use the **210 held-out outcome groups with at least ten matches**, evaluated across their observed rank range on a 5-RR grid. All methods see the same data. The current rule uses its real segmentation: no connection across a missing estimate or more than 30 RR between valid centres.

- Current mean supported rank-range coverage: **77.2%**; Gaussian 80 before the extra locality guard: **100.0%**.
- Current fraction with multiple curve segments: **11.0%**; Gaussian 80: **0.0%** in this cohort.
- Mean absolute second difference on supported triples: **0.05534 RR** for the current curve, **0.00043 RR** for Gaussian 80. This measures small-scale bending on a 5-RR grid, not accuracy.
- Mean change after removing one observation, measured on commonly supported positions: **0.180 RR** versus **0.172 RR**.

The large improvement is in continuity and small-scale roughness. The improvement in sensitivity to a single match is much smaller. A smooth line can be stable-looking without being more accurate, so the recommendation does not treat roughness alone as success.

Widening the current hard rule to 40 RR raises supported range coverage to **92.7%**, but retains abrupt membership changes and has slightly worse overall held-out error.

## Data-quality and denser-history sensitivity

All values below are player-balanced blocked RMSE in RR, with the existing player split retained. They are sensitivity checks, not separate retuning opportunities.

| Restricted cohort | Held-out rows / players | Current RMSE | 40 RR RMSE | Gaussian 80 RMSE |
|---|---:|---:|---:|---:|
| Verified production match details | 597 / 24 | 2.258 | 2.246 | 2.199 |
| Known party size | 2778 / 171 | 4.684 | 4.694 | 4.668 |
| Consistent pre/post coordinates | 3997 / 258 | 3.647 | 3.652 | 3.648 |
| At least 100 RR observed span | 1582 / 92 | 4.022 | 4.035 | 4.009 |
| At least 15 same-outcome matches | 427 / 14 | 2.222 | 2.206 | 2.188 |
| Ending RR minus actual payout | 4516 / 271 | 3.901 | 3.911 | 3.889 |

The broader methodology survives known-party-size filtering and is supported by the verified production-detail cohort. The coordinate-consistent subset slightly favours 60 RR over 80 RR, while the production-detail subset favours 80. This supports treating **60–100 RR as a reasonable resolution range**, with 80 a conservative default; it does not support tuning the chart to one conspicuous gap.

## Concrete display specification

For one player, act and outcome, let x_i be continuous pre-match rank RR and y_i the positive magnitude of the actual payout. At each 5-RR grid point x:

```
w_i(x) = exp(-0.5 * ((x_i - x) / 80)^2)
estimated payout = sum(w_i * y_i) / sum(w_i)
effective sample size = sum(w_i)^2 / sum(w_i^2)
```

The benchmark truncates weights beyond 240 RR (three bandwidths). This is a bandwidth in standard-deviation units: a point 80 RR away retains about 61% weight; it is not a new hard 80-RR sample span. All positive-weight matches can contribute; there is no five-neighbour cap. No fixed act-average prior is added by default. Positive weights keep the estimate inside the contributing payouts' observed range.

Display rules:

1. Keep separate win and loss magnitudes, using the current green/red colours and actual match dots.
2. Show each outcome only over its own observed starting-rank range. Axis padding is visual space, not an invitation to extrapolate.
3. Require at least three same-outcome observations within 80 RR and effective sample size at least five for a local curve. Use a solid line at effective n ≥ 8, and a dashed line at effective n between 5 and 8. Below that, retain the dots and stop the local estimate.
4. If an entire outcome has fewer than six observations, avoid fitting local shape. With three to five, a clearly identified dashed act average over the observed range is reasonable; with zero to two, show the individual dots without a curve.
5. Sample on a fixed grid and connect with straight SVG path segments. The statistical estimator supplies the smoothness. Do not use an interpolating cubic spline to manufacture bends or overshoot between estimates.
6. Recompute support and segmentation independently of decorative rank bands. Zoom filters the visible domain but uses the same full-act outcome pool and the same 80-RR weighting, so zooming does not change the estimate at a given RR.
7. Keep rank/RR labels across the entire chart. Immortal+ RR stays continuous even when a shaded band or recorded tier changes.
8. On hover, show the estimated mean to one decimal, contributing match count, nearby rank range, and relevant dates. Use a short visible note such as “Smoothed from recorded payouts this act; dashed where data is limited.” The technical effective-n formula belongs in the implementation documentation.

The proposed locality/effective-n policy retained **99.97%** of observed range in the 210-group display cohort. Requiring effective n ≥ 8 for solid treatment retained **98.89%**. The treatment thresholds are conservative UI choices tested for coverage; the corpus does not calibrate them to a particular statistical confidence probability.

Do not enforce a monotonic direction, fit a high-order polynomial, or drop large real payouts solely to make the line attractive. RR payout differences can accompany changing performance and match margins; the chart should summarize actual evidence.

## Sxllow#vapo

The current joined e11a5 corpus contains **82 eligible wins and 77 eligible losses**. That is 159 W/L matches; two draw records explain why a naive reconstruction that treated `teams.won=false` as a loss counted 161 earlier in the investigation. The live UI's draw handling already maps draws outside W/L curve eligibility.

- Win act average: **18.80 RR**; Gaussian 80 curve range: **18.37–19.15 RR**.
- Loss act-average magnitude: **18.58 RR**; Gaussian 80 curve range: **18.19–19.55 RR**.
- Minimum effective sample size along the evaluated grids: about **24 wins** and **22 losses**.

The 389/407/425 RR wins no longer trigger an artificial break because their contributions change continuously. The remaining higher-RR points support a modest rise in loss magnitude and a relatively flat win payout. Any stronger detailed shape would overstate what these observed payouts establish.

For illustration, I generated 500 outcome-specific moving-block resamples with block length four. The average half-width of the pointwise 95% bootstrap stability envelope is **0.43 RR** for wins and **0.46 RR** for losses. These envelopes measure resampling sensitivity of this collected history; they are **not** calibrated confidence intervals for Riot's future payouts or for a causal rank effect. I would keep them in the analysis view until an uncertainty display is separately validated.

## Limits and release decision

The data is an opportunistic corpus, with a large Immortal+ collection wave and mostly short same-outcome snapshots. It is not a representative random sample of all Valorant players. Broad coverage is measured within observed ranges and should not be generalized to empty regions or unseen ranks.

Kernel smoothing has boundary bias and can flatten real trends at the endpoints. A regularized local linear estimator is worth reconsidering if substantially denser, wider histories show a reproducible accuracy or shape-recovery benefit. Today its extra complexity is not justified by the small, uncertain predictive differences.

Before shipping, add meaningful checks for no overshoot, duplicate starting RR, single-outcome histories, sparse large rank gaps, drawn matches, continuous Immortal coordinates, zoom consistency and grid support. Then render a fixed set of dense and sparse examples and verify that a “limited data” treatment is visible without making the chart noisy.

The recommendation is **Gaussian weighted descriptive curves at 80 RR, evidence-based line treatment, fixed-grid rendering and no extrapolation**. The measured reason to change is clearer use of the available evidence and fewer sampling artifacts, not an established improvement in prediction.

## Reproducibility

- `scripts/export-rr-curve-corpus.mjs`: read-only production export; token remains in the existing environment, raw rows remain under ignored `.local/rr-curve-prod/`.
- `scripts/analyze-rr-curves.py`: corpus assembly, 92-model tuning/holdout benchmark and display metrics.
- `scripts/analyze-rr-curve-sensitivity.py`: eligibility/coordinate/dense-cohort checks, production-estimator parity cases, locality policies and sxllow resampling.
- `scripts/render-rr-curve-analysis.py`: this report and the portable comparison charts.
- `results.json`, `sensitivity.json`, `corpus.json`, `examples.json`, `model-definitions.json`: machine-readable analysis outputs in this directory.

Python requires numpy. All randomization uses fixed seeds. The HTML comparison embeds its dataset and uses version-pinned Chart.js from a CDN; it can be opened locally with internet access for that chart library.
