# Your stats with each duo

The Duos page teammate table shows the searched player's own K/D, average ACS and Avg PS under each teammate's figure. Both lines come from the same set of shared matches.

## What is counted

`buildTeammates()` already walks every stat match in which a teammate was in the searched player's party on the same team. For each such match it now also adds the searched player's own `myStats` to that teammate's row:

- `myKills` / `myDeaths`: summed kills and deaths. K/D is kills ÷ deaths, or kills when there are no deaths, which is the same rule the teammate K/D uses.
- `myAcsSum` / `myAcsCount`: average of per-match ACS, counting only matches where ACS could be computed (rounds played known).
- `myPerformanceSum` / `myPerformanceCount`: average Performance Score over matches where the API provided it. The PS cell's tooltip gives both coverage counts.

Matches without `myStats` are still skipped for the whole row, as before, so the teammate figures and yours share one match set.

## Display

Each stat cell shows the teammate's value first, with a muted `You <value>` line beneath it. Your K/D is coloured green above 1 and red below 1, matching the teammate K/D. Sorting and the "Highest … in this table" highlights still use the teammate's figures.

An earlier draft used separate "Your"/"Their" columns. That made the table 1,190 px wide, wider than the 910 px content column at a 1440 px viewport, so Total RR was scrolled out of view on desktop. The stacked layout keeps the original 8 columns and 800 px minimum width.

## Verification

- `tests/stat-charts.test.mjs`: aggregation of own stats per teammate, and the rendered cells (teammate value, `You` line, K/D tone, sort values unchanged).
- Checked in the UI stress preview (`scripts/serve-ui-stress.py`, `/duos?data=demo`). At 1440 px the table fits its container with no horizontal scroll. At 375 px the table scrolls inside its card as before, and the page itself does not overflow.
