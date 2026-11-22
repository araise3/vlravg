# Your stats with each duo

Since 22 Nov 2026 the Duos page shows only each party teammate's own K/D, average ACS and Avg PS in the matches you shared, not the searched player's figures beside them (see "Current display"). The engine still collects your own figures per teammate, as described below; nothing on the page reads them now.

## What is counted

`buildTeammates()` already walks every stat match in which a teammate was in the searched player's party on the same team. For each such match it now also adds the searched player's own `myStats` to that teammate's row:

- `myKills` / `myDeaths`: summed kills and deaths. K/D is kills ÷ deaths, or kills when there are no deaths, which is the same rule the teammate K/D uses.
- `myAcsSum` / `myAcsCount`: average of per-match ACS, counting only matches where ACS could be computed (rounds played known).
- `myPerformanceSum` / `myPerformanceCount`: average Performance Score over matches where the API provided it. The PS cell's tooltip gives both coverage counts.

Matches without `myStats` are still skipped for the whole row, as before, so the teammate figures and yours share one match set.

## Current display: one teammates table (22 Nov 2026)

On request Teammates is one plain sortable table (`DuoRoster` in
`src/app/pages/Duos.jsx`), shown bare like the party-size table above it: no
card or card title around it (`TableSection` labelled "Teammates", standalone
table frame). This came after a same-day round of alternatives the user turned
down:

- **Columns**, in the site's table order (name, Matches, Avg Lobby, K/D, ACS,
  PS, Win rate, Total RR; set the same day on request): teammate, matches
  together, avg lobby, the teammate's own K/D, ACS and PS in your shared
  matches (coverage counts in the tooltips), win rate (W–L–D record in its
  tooltip) and your net RR together. The party-size table above uses the same
  order, and both pass `STAT_TABLE_WIDTHS` (shared.jsx, also used by Servers) to `SortableTable`'s `widths`
  (fixed table layout), so their columns line up. Elsewhere the RR-by-rank
  table now says Matches and Win rate (was Games and WR%), and Wintrading
  signals shows K/D, ACS, PS in that order. Default
  order is matches together; every column sorts; ten rows per page with the
  10/25/50 picker. Phones get the shared card list, as other tables do.
- **Not shown**: your own stats with each teammate. The highlight tiles, the
  expandable you-vs-them comparison rows (`DuoComparison`) and the act
  baseline (`duoBaseline`) were removed.
- **Colour**: only RR is green or red.

Tried and dropped on 22 Nov 2026, in order:

- A list + detail panel (the user's pick from teammate cards, list + detail
  panel and a flat table), restoring the 17 Nov duo chemistry layout below.
  The user then asked for "a normal list with only the duos stats".
- That table plus a separate "Your form by teammate" card: your K/D, ACS or PS
  with each teammate minus your act average, as diverging bars sorted best
  first, with small samples faded. The user asked to drop it and keep one
  teammates table.

## Earlier display: teammates table with highlights (20 Nov 2026, replaced 22 Nov 2026)

On request the Teammates card was redesigned from scratch (`DuoRoster` in
`src/app/pages/Duos.jsx`), replacing the pick-a-partner "duo chemistry"
layout described below:

- **Highlights** (`duoHighlights`, two or more teammates): three tiles for the
  teammate with the most matches together, the best total RR together (among
  teammates with recorded RR), and the best win rate over at least
  `DUO_HIGHLIGHT_MIN_DECIDED` (3) decided matches. A tile drops out when no
  teammate qualifies.
- **Table**: every party teammate as a row of the shared sortable data table:
  teammate, matches together, win rate (with a thin neutral bar; the W–L–D
  record is in its tooltip), your total RR together, avg lobby, your K/D and
  their K/D. Default order is matches together; every column sorts; ten rows
  per page with a 10/25/50 rows-per-page picker and a search once there are
  more than ten. A Record column was tried and dropped the same day: with it
  the table scrolled sideways at an 800 px window. Names truncate at 10 rem.
- **Compare stats**: a chevron in each row header opens a full-width row under
  it with the mirrored K/D, ACS and PS bars (`DuoComparison`): yours grow left
  from the stat label (a shadcn `Progress` turned around), theirs grow right,
  on one scale per stat across every teammate and both sides; the leader is
  solid and bold, and a small signed number under each of your figures
  compares it with your act average. Phones show the same rows as cards with a
  "Compare stats" toggle under each.
- **Colour**: only RR is green or red. Win rate, K/D and the act-average deltas
  are neutral, since green on nearly every row (a strong player wins most
  duos) read as noise.

## Encounters as a database-style table (20 Nov 2026)

`EncountersTable` keeps the engine's rows (players met in at least two counted
matches, never in your party) and adds: an always-on search, an All / Same
team / Opposing filter (a shadcn `ToggleGroup`; a filter with no rows says so
inside the frame), a "Same team %" column (share of encounters on your team,
with a thin bar), and the 10/25/50 rows-per-page picker. These come from new
`SortableTable` options (`searchable`, `tools`, `pageSizes`, `emptyText`,
`detail`), so other tables can use them too.

## Previous display: duo chemistry (17 Nov 2026, replaced 20 Nov 2026)

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
- **Long tables.** `SortableTable` takes `pageSize`; Encounters (since 20 Nov 2026 with a rows-per-page picker) and Wintrading signals show 10 rows per page with a "1–10 of 150 players" range and previous/next buttons. Sorting covers every row before the page is cut and returns to page 1. zekken's act had 150 encounters (15 pages).

## Verification

- `tests/stat-charts.test.mjs`: aggregation of own stats per teammate; the act baseline; the comparison's values, act-average deltas, shared bar scale (shadcn `Progress`) and leader emphasis; the highlight picks; the teammates table's columns, default order, closed comparison rows, paging with the rows-per-page picker and RR-only colour; the Encounters toolbar, filter, columns, team share and paging; an outside filter's empty text; `LobbyValue` as a flex row and the left-aligned Avg Lobby columns.
- Checked live on MIBR zekken#1515 (`npm run dev:live`) at desktop and 375 px.
