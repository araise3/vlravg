# Your stats with each duo

The Duos page teammate table can show either each teammate's K/D, average ACS and Avg PS, or the searched player's own figures in the matches they shared. Both come from the same set of shared matches.

## What is counted

`buildTeammates()` already walks every stat match in which a teammate was in the searched player's party on the same team. For each such match it now also adds the searched player's own `myStats` to that teammate's row:

- `myKills` / `myDeaths`: summed kills and deaths. K/D is kills ÷ deaths, or kills when there are no deaths, which is the same rule the teammate K/D uses.
- `myAcsSum` / `myAcsCount`: average of per-match ACS, counting only matches where ACS could be computed (rounds played known).
- `myPerformanceSum` / `myPerformanceCount`: average Performance Score over matches where the API provided it. The PS cell's tooltip gives both coverage counts.

Matches without `myStats` are still skipped for the whole row, as before, so the teammate figures and yours share one match set.

## Display

A Teammate / You switch at the top of the card (`setDuoStatsView`) chooses which side the K/D, ACS and PS columns show. Each cell holds one value; its tooltip gives both sides (and, for K/D, kills and deaths). K/D is coloured green above 1 and red below 1 for whichever side is shown. Sorting and the "Highest … in this table" highlights follow the shown figures, so the You view can be sorted by how well you play with each teammate. Matches, Avg Lobby, Win rate and Total RR are shared results and do not change. The chosen view persists across re-renders and searches in the same page session.

Earlier layouts:

- Separate "Your"/"Their" columns made the table 1,190 px wide, wider than the 910 px content column at a 1440 px viewport, so Total RR was scrolled out of view on desktop.
- A muted `You <value>` line under every teammate figure kept 8 columns but doubled row height and repeated "You" in every stat cell; it was replaced by the switch.

## Verification

- `tests/stat-charts.test.mjs`: aggregation of own stats per teammate, and the rendered cells in both views (single value, both sides in the tooltip, K/D tone, sort values following the view, Win rate and Total RR unchanged).
- Checked in the UI stress preview (`scripts/serve-ui-stress.py`, `/duos?data=demo`) at 1440 px and 375 px.
