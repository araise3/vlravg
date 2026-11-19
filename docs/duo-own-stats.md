# Your stats with each duo

The Duos page shows each party teammate's K/D, average ACS and Avg PS beside the searched player's own figures in the matches they shared. Both come from the same set of shared matches.

## What is counted

`buildTeammates()` already walks every stat match in which a teammate was in the searched player's party on the same team. For each such match it now also adds the searched player's own `myStats` to that teammate's row:

- `myKills` / `myDeaths`: summed kills and deaths. K/D is kills ÷ deaths, or kills when there are no deaths, which is the same rule the teammate K/D uses.
- `myAcsSum` / `myAcsCount`: average of per-match ACS, counting only matches where ACS could be computed (rounds played known).
- `myPerformanceSum` / `myPerformanceCount`: average Performance Score over matches where the API provided it. The PS cell's tooltip gives both coverage counts.

Matches without `myStats` are still skipped for the whole row, as before, so the teammate figures and yours share one match set.

## Display: duo chemistry (17 Nov 2026)

`DuoChemistry` in `src/app/pages/Duos.jsx` is a pick-a-partner layout:

- **Partner list** (left on desktop): name and tag, matches together, win rate, your total RR together, and your K/D in the matches you shared. A "form" column (your ACS with them minus your act average) was tried first and replaced by K/D on request. Partners are listed by matches together (no sort control, removed on request). On desktop every partner is in the list, which scrolls inside the matchup's height (`contain: size` keeps the list from setting the row height). The column labels sit above the scroll area, so the scrollbar starts under them rather than beside the K/D label (20 Nov 2026); the labels and the scroll area reserve the same scrollbar gutter, so the columns line up whether or not the list overflows. Phones show eight, then "Show all N teammates".
- **Matchup** (right on desktop, for the selected partner, the first by default): name and matches together; avg lobby, win rate with the W–L(–D) record, and total RR; then mirrored bars for K/D, ACS and PS, yours growing left from the stat label and theirs growing right. Bars share one scale per stat across every partner and both sides, so lengths compare between partners. The leading side is solid and bold; the trailing side is faded. Under each of your figures, a small signed number compares it with your act average (desktop adds "vs avg").
- **Colour**: only RR is green or red. Win rate, K/D and the act-average deltas are neutral, since green on nearly every row (a strong player wins most duos) read as noise.
- **Phones**: the list fills the card; tapping a partner opens the matchup under them (tap again to close).

The act average (`duoBaseline`) is computed exactly like the per-teammate figures, over the same stat matches: K/D from summed kills and deaths, ACS and PS as means of per-match values. It is not the round-weighted act ACS on the Overview, so the comparison is like for like.

Earlier layouts, all rejected:

- Separate "Your"/"Their" columns made the table 1,190 px wide, wider than the 910 px content column at a 1440 px viewport, so Total RR was scrolled out of view on desktop.
- A muted `You <value>` line under every teammate figure kept 8 columns but doubled row height and repeated "You" in every stat cell.
- A Teammate / You switch (`setDuoStatsView`) showed one side at a time; the user found the toggle ugly. The engine state and setter were removed.
- Head-to-head duo cards (two per row, a two-row Them/You mini table each) showed everything at once but read as a wall of near-identical boxes; replaced the same day by the chemistry layout.

## Other Duos page fixes (17 Nov 2026)

- **Avg Lobby alignment.** `LobbyValue` was an `inline-flex` box with a 22px icon sitting on the text baseline, which lifted the rank label 2.6px above the other cells' text (measured on zekken's party-size table). It is now a block `flex` row centred like every other cell (difference 0.2px), and Avg Lobby columns (party size table, Servers) use `align: 'left'` so icons line up between rows.
- **Long tables.** `SortableTable` takes `pageSize`; Encounters and Wintrading signals show 10 rows per page with a "1–10 of 150 players" range and previous/next buttons. Sorting covers every row before the page is cut and returns to page 1. zekken's act had 150 encounters (15 pages).

## Verification

- `tests/stat-charts.test.mjs`: aggregation of own stats per teammate; the act baseline; the matchup's values, act-average deltas, shared bar scale and leader emphasis, and the absence of a view switch; the partner list's order, default selection, absence of a sort control, K/D column and the desktop scroll box; `LobbyValue` as a flex row and the left-aligned Avg Lobby columns; ten-row paging.
- Checked live on MIBR zekken#1515 (`npm run dev:live`) at desktop and 375 px.
