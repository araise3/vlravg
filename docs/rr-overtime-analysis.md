# Regulation vs overtime at a two-round margin

Analysis date: 7 October 2026 (Europe/Berlin). The fresh read-only D1 snapshot
finished at 00:41 CEST. No Henrik requests were made for this investigation.

**There is no evidence of a large overall payout difference in this cohort.**
After comparing games within the same player/act and adjusting for observed
rank and performance, the overtime difference is +0.12 RR on wins and 0.03 RR
more lost on losses. Both approximate 95% intervals include zero. Keeping
regulation and overtime together at ±2 in the chart is reasonable; the exact
scoreline breakdown remains available on hover/focus.

This is an observational result for the collected cohort, not proof that Riot
uses identical payout rules for every player, rank or overtime length.

## Evidence and raw averages

The snapshot contains **80,632 player/match payout records**, of which 16,592
have trusted match features. The existing corpus benchmark's strict eligibility
rules retain 12,731 records. Restricting those to completed two-round-margin
competitive games leaves **2,872 player/match records from 726 accounts and
2,419 distinct matches**. These are all PC games in act `e11a5`, played from
28 September through 6 October 2026. Multiple tracked accounts may share a
match, so these are not 2,872 independent games.

Regulation means exactly 13–11 or 11–13. Overtime means a winner with at least
14 rounds and a loser with at least 12, separated by exactly two rounds.
Draws, other margins, and eight abnormal/inconsistent two-round finishes are
excluded. The actual `last_change` payout is used, including Rank Shield
losses; refunds are not added to that payout.

| Outcome | Regulation average RR | Regulation records | Overtime average RR | Overtime records |
|---|---:|---:|---:|---:|
| Win | +17.78 | 789 | +17.69 | 686 |
| Loss | −17.64 | 722 | −18.17 | 675 |

Raw OT wins differ by −0.09 RR. Raw OT losses cost 0.52 RR more. Pooling
different accounts mixes different MMR/rank relationships, so the raw loss
difference should not be treated as an overtime penalty.

## Comparisons within accounts

All differences below mean **overtime minus regulation in payout magnitude**:
positive wins mean more RR gained; positive losses mean more RR lost.

| Method | Win difference (RR) | Loss cost difference (RR) |
|---|---:|---:|
| Equal-weight same-player/act means | +0.10 | +0.17 |
| Player/act fixed effects + witnessed starting rank/RR | +0.19 | +0.13 |
| Above + performance, lobby rank gap, party size and linear date | +0.12 | +0.03 |
| Fully adjusted approximate 95% interval | −0.24 to +0.48 | −0.32 to +0.38 |

The adjusted win comparison uses 979 records from 256 accounts that have both
finish types; losses use 924 records from 255 such accounts. Starting rank is
the preceding game's ending rank, with adjacency witnessed in a real upstream
RR window. Performance is standardized ACS within the match, an imperfect
proxy for the performance Riot evaluates. The lobby gap uses public tiers;
hidden MMR is unavailable. Dates are included as a linear within-act trend.

The equal-weight comparison averages each account's within-act difference,
then weights accounts equally. Its 5,000-draw player bootstrap intervals are
−0.33 to +0.54 RR for wins and −0.22 to +0.57 RR for losses. The regression
weights observations and uses player/act fixed effects. Its covariance is
clustered in two dimensions—permanent account and match ID—to account for
repeated games and multiple accounts from the same match. Regression intervals
use a normal approximation with finite-cluster/parameter corrections.

## Sensitivity checks

| Restricted cohort | Adjusted win difference, 95% interval | Adjusted loss cost difference, 95% interval |
|---|---:|---:|
| Solo only | +0.65 [−0.05, +1.35] | +0.44 [−0.26, +1.15] |
| Starting rank below Immortal | +0.21 [−0.53, +0.96] | −0.13 [−0.93, +0.67] |
| Starting rank Immortal+ | +0.08 [−0.05, +0.20] | +0.11 [−0.02, +0.24] |

All primary records are PC, so the PC-only check reproduces the primary result.
The solo and lower-rank checks are less precise than the overall comparison.

| OT winning score (reverse for losses) | Win records | Average win RR | Loss records | Average loss RR |
|---|---:|---:|---:|---:|
| 14–12 | 409 | +17.75 | 382 | −17.90 |
| 15–13 | 170 | +17.30 | 195 | −18.44 |
| 16–14 | 81 | +18.22 | 72 | −18.68 |
| 17–15 or longer | 26 | +17.73 | 26 | −18.69 |

The 15–13 loss subgroup has a small adjusted increase of +0.44 RR
[+0.05, +0.83]. This is an exploratory subgroup comparison without multiple-
comparison correction, not strong evidence of a separate mechanic. Very long
OT games have only 26 win and 26 loss records, so their results cannot establish
equivalence. Subgroup models compare each OT length against regulation games
within accounts with both types; full counts and intervals are in the results.

## Limits and reproduction

About 79% of payout records lack trusted match features, and primary exclusions
also remove unwitnessed starting ranks, act transitions, coordinate discrepancies,
unknown/nonstandard parties, five-stacks/party penalties, draws and nonstandard
payout signs. The strict coordinate check excludes promotion floors and other
adjustments rather than inventing a starting position. Detail availability and
collection policy may select the cohort. Player fixed effects cannot remove
time-varying hidden MMR, and observed ACS/lobby tiers do not recover Riot's model.

Riot identifies match outcome, margin, individual performance and rank relative
to MMR as payout factors. Its [RR explanation](https://support.riotgames.com/en-us/valorant/gameplay/rank-rating-rr-for-iron-through-ascendant-ranks)
and [patch 6.0 notes](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-6-0/)
provide context; neither establishes an overtime-specific formula.

The frontend's new margin trend is a descriptive smoother for the searched
player's current act. It uses all eligible payouts within two rounds, weighted
by proximity, and an eight-match prior at that outcome's act average. At least
three nearby records are required. It does not extrapolate beyond observed
margins or join wins and losses. This display heuristic is not a trained corpus
model or a causal estimate. Faint dots retain individual recorded payouts;
bar tooltips retain raw averages and exact regulation/OT scorelines.

```powershell
python scripts/analyze-rr-overtime.py .local/rr-corpus/snapshots/2026-10-07-overtime/corpus.ndjson.gz --out artifacts/rr-overtime-analysis
python tests/rr_overtime_test.py
node --test tests/stat-charts.test.mjs tests/rr-movement.test.mjs
```

The raw snapshot remains local and ignored. Its SHA-256 is
`3b3949d9d8321d7a7e990b5a7fb93c8be91d54c2db6fb93e33d202498dbc0bf3`.
Aggregate outputs are in [results.json](../artifacts/rr-overtime-analysis/results.json).
