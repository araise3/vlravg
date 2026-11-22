# RR payout even point

The RR page's "Estimated RR payout by starting rank" chart can draw a dashed vertical line,
labelled **Even at N RR**, where a player's wins and losses paid the same RR for a sustained
stretch of games. The line's accessible label gives the stretch: how many games in a row, the
average win and loss, the dates and the starting ranks it covered.

Definition (user decision, 22 Nov 2026): the even point is when a player's RR gained and RR lost
are equal for a sustained period of time.

## Why it matters

Riot pays more for a win than it takes for a loss while a player's hidden MMR sits above their
displayed rank, and the reverse once the rank is above it. Wins and losses paying the same game
after game therefore usually means the rank has met hidden MMR. That is an inference from this
behaviour; the chart says "usually" and reports no MMR value.

## Method (`rrPayoutEvenPoint` in `src/engine/core.mjs`)

- Rows: the chart's own eligible matches (`rrMovementRows`: RR present, tier 3+, not a placement,
  not a five-stack, win or loss), in the selected act and RR range, in play order.
  Party-penalized games are left out because their payout is scaled down. Rank Shield losses stay
  in: their `last_change` is the normal payout.
- Each payout is evened out to a 4-round margin (`rrMarginAdjusted`), as the chart's curves are.
- A window of 16 consecutive games with at least 4 wins and 4 losses is **even** when its average
  win and average loss are within 1.5 RR.
- Consecutive even windows form a stretch. Windows overlapping a stretch's edges can pull in games
  just outside it, so the stretch is trimmed, one game at a time from the side that is further
  apart, until each half of it is also within 1.5 RR.
- The longest stretch of at least 20 games is the even point. The line sits at the median starting
  RR of its games; the rank label comes from the game nearest that RR.
- Zoomed into one rank, the line appears only if the point falls inside that rank.

## Cases

- **Reference player** (`tests/fixtures/rr-even-point-player.json`, one anonymous EU player, act
  e11a6): a 34-game stretch from 588 to 774 RR, wins +18.9 and losses −18.7 on average, line at
  670 RR. The old line fit put it at 676 RR.
- **Apart player** (`tests/fixtures/rr-even-point-apart.json`, one anonymous Radiant player, Nov
  2026): wins fell from about +32 to +21 and losses rose from −8 to about −18 over the act, but in
  play order the 16-game gap never got under 2.2 RR. No line. The old fit drew "Even at 380 RR",
  where the curves were visibly apart.
- Synthetic play (`tests/rr-movement.test.mjs`): 24 even games in a row give a point; 19 do not;
  games 3 RR apart throughout do not; a 10-game even patch between games 6 RR apart does not.

## Previous method (17–22 Nov 2026)

Two straight lines (win payout and loss cost against starting RR over the whole act) and their
crossing, shown when the gap's slope had t ≤ −3 and the crossing lay inside the observed ranks.
`scripts/rr-even-point-holdout.mjs` validated that fit on 400 corpus players (held-out games
within ±40 RR of the crossing: median win−loss gap −0.4 RR). It was replaced because the lines
extrapolate: a player whose payouts converge quickly and then flatten still got a crossing where
their games stayed a few RR apart. Those holdout figures do not apply to the current rule.

## Limits

- The thresholds (16-game window, 4 per side, 1.5 RR, 20 games) were set on the two players
  above and synthetic play, not validated on the corpus.
- Stretch edges are only as sharp as payout noise allows: next to games about 3 RR apart, a
  14-game even patch can read as about 27 games. Games 6 RR apart blur it by only a few games.
- A player who is even from the first game to the last gets a line in the middle of everything
  they played; that is the definition, not a fault.
- Fewer than 20 eligible games in range never give a point.
