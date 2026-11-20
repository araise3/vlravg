# RR payout even point

The RR page's "Estimated RR payout by starting rank" chart can draw a dashed vertical line,
labelled **Even**, at the starting rank where RR per win and RR per loss are about equal. The
line's accessible label describes the pattern around it: wins pay more than losses cost below
the line, and losses cost more above it, with the change per 100 RR for each. (Until 20 Nov 2026
the same sentence also sat above the chart; it was removed on request.)

## Why a crossing exists

Riot pays more for a win than it takes for a loss while a player's hidden MMR sits above their
displayed rank, and the reverse once the rank is above it. A player whose rank moves through that
point within an act therefore shows a falling win payout and a rising loss payout against starting
rank, and the two cross. That the crossing marks where rank met MMR is an inference from this
behaviour; the chart says so and does not report an MMR value.

One anonymous EU player in act e11a6 is the reference case (`tests/fixtures/rr-even-point-player.json`):
starting at 111 RR (cumulative Immortal-axis RR), wins paid about +30 and losses −7; from about 676 RR
both were about 18; above about 780 RR wins paid +14 and losses −22.

## Method (`rrPayoutEvenPoint` in `src/engine/core.mjs`)

- Rows: the chart's own eligible matches (`rrMovementRows`: RR present, tier 3+, not a placement,
  not a five-stack, win or loss), in the selected act and RR range. Party-penalized games are
  left out because their payout is scaled down. Rank Shield losses stay in: their `last_change` is
  the normal payout.
- Two ordinary least-squares lines: win payout against starting RR, and loss magnitude against
  starting RR.
- Shown only when each side has at least 8 games, the gap's slope (win slope − loss slope) has
  t ≤ −3 using the two slopes' standard errors, and the crossing lies within the observed starting
  ranks. Otherwise nothing is drawn.
- The label's rank comes from the nearest match's starting tier, as the chart's rank bands do.
  Zoomed into one rank, the line appears only if the point falls inside that rank.

## Validation

`scripts/rr-even-point-holdout.mjs` on 400 players from `rr_history` with 50+ entries since
15 Oct 2026 (the first 400 by account ID, at least 30 eligible e11a6 games each), on 17 Nov 2026.
For each player the point was fitted on every other game and tested on the rest:

| Gate | Players with a point | Held-out games within ±40 RR: median win−loss gap | Mean abs. gap | Below by >80 RR: median gap | Above by >80 RR: median gap |
|---|---|---|---|---|---|
| t ≤ −2 | 148 (37%) | −0.2 RR (107 players) | 1.6 | +8.1 (80) | −3.7 (53) |
| **t ≤ −3 (shipped)** | **105 (26%)** | **−0.4 RR (73)** | **1.3** | **+8.5 (66)** | **−3.7 (40)** |
| t ≤ −4 | 80 (20%) | −0.4 RR (60) | 1.1 | +8.8 (61) | −3.6 (30) |

Near the line, wins and losses paid within about 1.3 RR of each other on games the fit never saw,
while well below and above it the gap had the expected sign. On the reference player, all 163
eligible games fitted together give 675 RR on the live site.

## Limits

- A straight line is an approximation: payouts flatten at their caps, and a very long climb may
  bend.
- The fit uses starting rank only. When hidden MMR moves during the act, the pattern follows time
  rather than rank, and the gate usually hides the line. One player checked on 17 Nov had wins
  and losses about 3 RR apart during two climbs and equal in between, but no rank trend
  (gap-slope t = −0.8), so no line is drawn for them.
- The corpus sample is act e11a6 only, selected for activity, and not checked for region balance.
