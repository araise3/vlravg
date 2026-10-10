# Reported competitive updates

The frontend reads the v4.10 competitive-update fields from the existing stable
`/api/mmr-history` routes. No beta host, new route, secret or schema migration is
required. Existing server-side quota handling stays in place.

Source: [Henrik release notes](https://docs.henrikdev.xyz/valorant/changes/v4.10.0).
Field names and nullable types were verified against the vendor's OpenAPI schema
on 2026-10-10. Older records may lack every new field.

Expanded match details show reported starting/ending rank and RR, performance
bonus, penalties, new-map forgiveness, placement status, shield replenishment,
queue and competitive movement. Match duration uses `match_length` (milliseconds)
only when the match response lacks its own duration. The RR page shows total
reported performance bonus and the number of eligible games with bonus data for
the selected range. A reported zero counts as coverage; null does not.

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
