# Reported competitive updates

The frontend reads the v4.10 competitive-update fields from the existing stable
`/api/mmr-history` routes. No beta host, new route, secret or schema migration is
required. Existing server-side quota handling stays in place.

Source: [Henrik release notes](https://docs.henrikdev.xyz/valorant/changes/v4.10.0).
Field names and nullable types were verified against the stable authenticated
OpenAPI schema and live stable history responses on 2026-10-10. Older records may
lack every new field. See [verification results](rr-update-verification.md).

Expanded match details show reported starting/ending rank and RR, performance
bonus, penalties, new-map forgiveness, placement status, shield replenishment,
queue and competitive movement. Match duration uses `match_length` (milliseconds)
only when the match response lacks its own duration. The RR page shows total
reported performance bonus and the number of eligible games with bonus data for
the selected range. A reported zero counts as coverage; null does not.

### RR penalties and Refunds tiles

Two RR summary tiles show RR moved outside the normal match payout, across
every match in the selected range (placements and 5-stacks included, like Net
RR):

- **RR penalties** sums dodge RR and reported AFK penalties. Its foot only
  counts them ("3 penalties"). The number is a tooltip trigger (hover, or tap
  on phones) with the breakdown: dodges, AFK penalties (each with RR and count)
  and the number of party-penalty games. The label's own tooltip explains what
  is counted.
- **Refunds** sums `refunded_rr`, with the number of refunded matches below.

The summary has seven tiles. Net RR spans two columns: two rows of four from
tablets up, three rows of two below it on phones. The card is capped near 860px
even on wide screens, so one row of seven would wrap every foot line. Each
amount's source:

- **Dodges.** MMR-history entries with `match_length` 0. A read-only D1 query
  (entries dated 8–22 Nov 2026) found 2,004 of them. None had a match in
  `match_archive` or `rr_match_features`, 86 sat in the feature-retry queue
  because their match could not be fetched, and every `last_change` was −6
  (1,907), −10 (78), −16 (18) or −20 (1), never with an AFK or party penalty.
  That fits Riot's escalating queue-dodge penalty. Their RR is exact
  `last_change`. Because no match exists, they never reach `processMatch` and
  Net RR omits them; the engine keeps them apart (`_rrDodges`, filtered to the
  selected act). "All" counts every act dodge; 50/30/20 count dodges on or after
  the oldest scoped match's start. Older records without `match_length` cannot
  be told apart and are not counted.
- **Refunds.** `refunded_rr`, which Riot applies on top of `last_change`, so Net
  RR omits it too.
- **AFK penalties.** The sum of reported `afk_penalty` magnitudes; only positive
  values (2, 4, 8, 16) have been observed and the schema gives no sign. In the
  same D1 sample, AFK-penalised players usually lost more than their non-AFK
  teammates in the same match, which suggests (inference, not verified) that the
  penalty is already inside `last_change` and therefore inside Net RR.
- **Party penalties.** `rr_penalty` (or the match's `party_rr_penaltys` entry)
  is a fraction of the payout, almost always 0.25, not RR, so those games are
  counted and never converted to RR or estimated.

**Remakes are not shown.** No short non-placement entry in the sample had a
0 RR change; every short game examined (down to 86 seconds) was an early
surrender with normal win/loss payouts, and AFK penalties sat on ordinary
losses. Neither the history nor the match payout gives a field that marks a
remake, so a remake cannot be told apart from a surrender or a normal loss.

`rr_before_update` and `tier_before_update` take priority over inferred starting
positions. Immortal and higher use cumulative RR, rooted at 2100 for charts.
Reported placement status takes priority over the old act-opening heuristic.

The payout remains `last_change`. Bonus, penalty and forgiveness fields are not
added to it again. The schema does not document penalty units or whether these
fields overlap, so penalties are displayed verbatim instead of inventing a
base-payout calculation. Refunds and shield protection retain their existing
behavior. Missing competitive-update fields cannot erase saved evidence, while
newly reported zero/false values can correct it.

## Possible next steps

- Bonus frequency by agent/map: calculate bonus games / covered games for each
  group, show coverage and require a useful sample before comparing groups.
- Bonus versus Performance Score: plot only matches with both reported values;
  describe association without treating the score as Riot's payout formula.
- Match-history filters for bonuses, AFK penalties, placements and protected
  losses: filter explicit evidence, keeping unknown records distinguishable.
- Promotion/derank timeline: use reported starting and ending tier rather than
  inferring an event from net payout or adjacent history entries.
- Rank-protection progress: use the new MMR v3 protection fields only after
  verifying their schema and reconciling them with match-level replenishment.
