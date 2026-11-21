# How RR and hidden MMR work (research notes, 2026-11-21)

Background for RR page design: what Riot has said about Rank Rating (RR) and
hidden MMR, what is only community lore, and what the repo's own RR corpus
shows. The sections below keep three labels apart: Riot statement, unconfirmed
claim, and corpus observation.

## 1. What Riot states

Sources: Riot support pages [How RR is calculated](https://support.riotgames.com/en-us/valorant/gameplay/how-rank-rating-rr-is-calculated),
[RR for Iron–Ascendant](https://support.riotgames.com/en-us/valorant/gameplay/rank-rating-rr-for-iron-through-ascendant-ranks),
[RR for Immortal/Radiant](https://support.riotgames.com/en-us/valorant/gameplay/rank-rating-rr-for-immortal-and-radiant-ranks),
[Competitive FAQ](https://support.riotgames.com/en-us/valorant/gameplay/valorant-competitive-mode-faq);
dev posts [Ask VALORANT: Rank Rating](https://playvalorant.com/en-us/news/dev/ask-valorant-rank-rating-edition/),
[Competitive changes 2.02](https://playvalorant.com/en-gb/news/game-updates/competitive-changes-2-02-and-what-s-next/);
patch notes [6.0](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-6-0/),
[10.01](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-10-01),
[13.00](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-13-00/),
[13.06](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-13-06/).

**Two numbers.** MMR is a hidden rating of skill, used for matchmaking. Riot
calls it "fairly fluid": it can move a lot from one game to the next. Rank
plus RR is what you see, and Riot keeps it "slightly decoupled" from MMR, so
your rank does not swing with every MMR change. Riot has never published an
MMR value, scale or formula.

**Payout factors, in Riot's order of weight:**

1. Win or loss: the base amount. A loss never gains RR.
2. Round margin: a 13–2 win pays more than a 13–9 win, and a 3–13 loss costs more than an 11–13 loss.
3. Individual performance: a small bonus on wins or cushion on losses. It
   counts damage and assists, not just kills. Below Immortal it is reported
   separately; 2.02 described it as performing above the matchmaker's
   expectation *and* your own average. At Immortal and Radiant, RR is
   "completely reliant on the outcome of the match."
4. Convergence: a multiplier from the gap between MMR and rank. With MMR
   above your rank, wins pay more than losses cost. With the two equal, wins
   and losses are about even. With MMR below your rank (a "negative convergence
   factor"), wins pay less and losses cost more. Patch 6.0 made convergence
   lean more on performance and less on round margin when rank and MMR are
   far apart.

**Equilibrium.** At your MMR you are expected to win about 50% of games.
Streaks or demotion protection can leave you above your MMR. From there you
have to win more than the players already at that MMR to climb further.

**Mechanics with numbers:**

- 100 RR per division up to Ascendant 3. A promotion starts you at a 10 RR
  minimum. A demotion starts you at no less than 70 RR. A double promotion can
  happen when MMR is far above rank (Riot's example: Gold 1 to Gold 3).
- Rank Shields (since 10.01): reaching tier 1 of any rank except Radiant
  grants 2 shields. Each blocks one rank drop from a loss at 0 RR, but not a
  drop between tiers within a rank.
- Immortal+: one continuous RR number, starting at 10 RR on reaching Immortal 1. Regional
  thresholds (12.05 made them consistent across regions; EU is Immortal 2 at
  100, Immortal 3 at 200, Radiant at 500). Radiant also needs a top-500 spot.
  A new act's placement cuts leaderboard RR by 90%.
- Placements: 5 games at a season start (highest placement Ascendant 3).
  Later acts need 1 game. Placements come out low on purpose, so convergence
  pushes you up. The reset includes a small MMR adjustment.
- Party penalty: a 5-stack with rank gaps loses 0–90% of its RR. The FAQ
  gives 25% when every member is Ascendant 3 or below, or when one is Immortal 1–3.
- New-map forgiveness: losses on a new map cost 50% less for two weeks
  (Corrode in 11.00, Summit in 13.00).
- RR refunds for games against a cheater, capped. They halve twice if your
  rank has risen since the match.
- 13.00 (June 2026) changed the RR formula "so consistent winners feel less
  stuck", especially at Immortal+. No numbers were published.
- 13.06's Performance Score (0–500) replaced ACS for MVP and scoreboard
  order. The patch notes do not say it feeds RR.

## 2. Unconfirmed claims (secondary sources only)

- "Encounter MMR": a dev quoted on Reddit (via
  [Dot Esports](https://dotesports.com/valorant/news/no-stars-again-heres-why-valorant-is-denying-you-your-performance-bonus))
  said the performance bonus comes only from the encounter-MMR update. That is
  your duel results against opponents, weighted by their MMR. Riot's own pages
  never use the term. It does fit "outperform the matchmaker's expectation".
- Whether MMR is Elo- or Glicko-like (with an uncertainty term): no Riot
  source found. Placements coming out low and then converging quickly fits a rating with an uncertainty
  term, but that is inference.
- Guide sites disagree on where the bonus stops (Diamond or Ascendant) and how
  big it is (2–10 RR). The corpus below settles both.
- Any site that shows an "MMR number" is showing its own estimate.

## 3. What the repo's RR corpus shows

Snapshot `.local/rr-corpus/snapshots/2026-11-20T01-38-41-146Z` (local only),
875,157 HenrikDev `mmr-history` entries from 23,165 accounts: 85% e11a6 and 14%
e11a5; EU 77%, NA 21%. The cohort is selected by activity and is not
representative. The script lives in the session scratchpad and was not committed.
Win/loss comes from the sign of `last_change`; placements are counted apart.

**Payout size by starting rank (non-placement games):**

| Rank | Win median (p5–p95) | Loss median (p5–p95) | Games with a performance bonus | Median bonus |
|---|---|---|---|---|
| Iron | +21 (10–36) | −18 (−30 to −6) | 33% | 6 |
| Bronze | +20 (10–34) | −19 (−30 to −8) | 27% | 5 |
| Silver | +19 (10–31) | −19 (−30 to −10) | 21% | 4 |
| Gold | +19 (11–28) | −18 (−27 to −11) | 12.5% | 4 |
| Platinum | +18 (12–25) | −18 (−25 to −12) | 4.1% | 3 |
| Diamond | +18 (13–23) | −18 (−23 to −13) | 0.4% | 3 |
| Ascendant | +17 (14–21) | −19 (−23 to −15) | 0% | — |
| Immortal | +18 (14–25) | −19 (−23 to −12) | 0% | — |
| Radiant | +18 (15–24) | −19 (−23 to −13) | 0% | — |

- **The performance bonus is a low-rank mechanic.** It fades from a third
  of Iron games to almost none in Diamond, and never appears from Ascendant up (0 games with
  bonus data, of about 560k wins and losses). 8,884 bonuses came on losses, where they cushion the loss. This
  matches Riot's "boost gains or cushion losses".
- **Payouts narrow as rank rises.** In Iron, 90% of wins pay +10 to +36; in
  Ascendant, +14 to +21. Above Gold a typical player's win and loss each sit
  within about ±4 RR of 18. That is why a chart of payout over time looks flat:
  most of the ±4 is round-margin noise (about 0.33–0.45 RR per round, see
  [rr-payout-model-2026-11-20.md](rr-payout-model-2026-11-20.md)), not
  MMR moving.
- **The MMR gap is small for most players.** Across 14,329 player-acts with
  10+ wins and 10+ losses, mean win minus mean loss has a median of −1.2 RR
  (p10 −5.0, p90 +4.0). 43% are within ±2 RR, i.e. sitting at their MMR. Only
  8% show a clearly positive gap (more than +5) and 10% a clearly negative one
  (less than −5). That losses slightly outweigh wins for the typical active
  player fits Riot's description of players held a little above their MMR by
  streaks and protection. This is an inference.
- **Promotion and demotion rules confirmed.** After a promotion, RR is
  at least 10 (median 10); after a demotion, at least 70 (median 81). 431 games
  promoted by two divisions or more.
- **Penalties as reported.** `rr_penalty` is a fraction, almost always 0.25
  (51,532 games, all ranks), so the 25% party penalty. 0.75 appears 12
  times. `afk_penalty` takes values 2, 4, 8 and 16, which looks like
  doubling per offence (inference). Rank Shield protected 14,280 games; refunds
  3,717; new-map forgiveness 23.
- **Placements differ.** Placement `last_change` can be strongly negative in
  Iron–Silver (down to −50) and is mostly positive from Platinum up, so
  placements are excluded from payout averages, as the site already does.

The data cannot tell whether `last_change` already includes the performance
bonus (see [rr-update-details.md](rr-update-details.md)); the site keeps
showing both verbatim.

## 4. What this means for the RR page

- The only hidden-MMR signal in RR data is the **win/loss asymmetry**, and it
  is small (a few RR) next to per-game noise of ±3–4 RR. Any chart that tries
  to show MMR has to average over many games, remove the round margin first,
  and say it is an estimate.
- Charts by starting rank (the existing estimate chart and its even point)
  work because rank moves with MMR during a climb. A chart by time adds little
  for a player who is not climbing.
- Below Diamond, the performance bonus is a real and visible part of the
  payout. Bonus rate and size are worth showing there; from Ascendant up there is nothing to show.
- Most of the RR you gain or lose comes from how many games you win, not the
  size of each payout. Breakdowns that show where wins and losses happen
  (session, map, party size) explain more of a player's RR than payout-size
  charts.
