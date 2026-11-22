# React + shadcn/ui frontend

Date: 2026-11-14. Replaces the single-file vanilla `index.html` frontend.

## What changed

The site is now a React 19 single-page app built with Vite 8, styled with
Tailwind CSS v4 and shadcn/ui (new-york style, zinc theme, JSX components).
The Cloudflare Pages Function, D1 schema, workflows and research scripts are
unchanged.

| Piece | Where |
| --- | --- |
| App shell | `index.html` (Vite entry, `#root`) |
| Engine: data loading, processing, statistics, UI state | `src/engine/core.mjs` |
| Rank badge data URIs | `src/engine/rank-icons.mjs` |
| Pages and charts | `src/app/` (`App.jsx`, `SearchHeader.jsx`, `MobileShell.jsx`, `pages/*.jsx`, `shared.jsx`) |
| shadcn components | `src/components/ui/` (`components.json`) |
| Theme | `src/index.css` |
| Dev fixtures | `src/dev/fixtures.mjs` (`?fixture=…`, dev builds only) |
| Backup of the old frontend | `legacy/index.html`, served at `/legacy/`; git tag `legacy-vanilla-frontend` |

## Architecture

The pre-React inline script was split in two.

1. **Engine (`src/engine/core.mjs`).** Everything that is not DOM code moved
   over largely verbatim: the HenrikDev client (`apiGet`, the request pool, 429
   handling), `loadAll`, `processMatch`, clutch detection with its empirical
   timing constants, KAST/ADR, RR history ingestion, act metadata, encounters,
   wintrade signals, the RR estimates, the replay upload pipeline and name
   history. The functions that wrote DOM (`render*`, `updateDetailPages`, the
   hidden `<select>`-backed act dropdown, the pro library list) now update
   module state and call `emit()`. `renderStats()`/`renderServers()`/
   `renderRankByRankCard()` keep their names but compute data only.
2. **React (`src/app`).** `useEngine()` subscribes with
   `useSyncExternalStore`. Each page derives its view from the snapshot and
   calls engine actions (`runAnalysis`, `selectSeasonOption`,
   `setServerPartySize`, …). All pages stay mounted and hidden when inactive,
   as before, so open match cards and table sorts survive navigation.

shadcn components used: Card, Table (with a sortable wrapper that keeps each
table's sort across reloads, as `initTableSorting` did), Tabs (page
navigation and the party size, RR range and duo stat side filters), Switch (count placements), Popover + Command
(pro library and act picker, both keyboard navigable), Collapsible (match
cards), Badge, Button, Input, Progress, Alert, Tooltip (explanations, via
`Hint`), ToggleGroup (RR zoom chips), NativeSelect (phone table sort), Empty,
Item + Avatar (phone lists, replay rows), ScrollArea (duo partners),
Separator and Skeleton. The 20 Nov 2026 pass that moved the remaining
hand-built controls onto these is in [shadcn-components.md](shadcn-components.md).

The EU ping map (`assets/ping-map/`) is still the standalone D3 script. The
Servers page renders its exact markup and loads the scripts on first visit.

## Behaviour kept on purpose

- Every number, label, tooltip text and empty-state message is computed by the
  same code as before or ported line for line (clutch outcome definitions,
  win rate = wins / (wins + losses), RR eligibility, Rank Shield shield, quiet
  MVP accolade, lobby rank needs `MIN_RATED`, Immortal+ continuous RR axis).
- URL routes, page titles, the `/lobby-rank` → `/lobbyrank` normalization,
  in-app navigation that keeps the player and act in the URL, Ctrl/⌘+K focus.
- Player links in tables and rosters are full page loads, as before.

## Old look restored (17 Nov 2026)

A side-by-side review of every page against `legacy/index.html` on the same
account found the zinc restyle read worse, almost entirely through styling.
These components now use the legacy values again, as unlayered rules at the
end of `src/index.css` (they outrank Tailwind's utility layer):

- Content column 912 px (`max-w-[960px]` with 24 px gutters), `#141416` cards
  with a solid `#2a2a2e` border and no shadow (`--card`, `--border`).
- Page navigation is the stock shadcn `Tabs` (`src/components/ui/tabs.jsx`),
  each trigger a real link; the list wraps onto more rows on phones so all 8
  pages stay visible at 375 px. One deviation from stock: the active
  background is a single `data-slot="tabs-indicator"` element in `TabsList`
  that measures the active trigger and slides to it (200 ms ease-out,
  off under `prefers-reduced-motion`; it also follows wrapped rows). Lists on
  hidden pages keep their last position and snap, without animating, on first
  show and when their page is shown again (`nextIndicatorBox`). The
  filters (party size, RR range, duo stat side) use the same Tabs.
- Tables (`SortableTable` and Name History get `.rank-table`): uppercase
  header strip, column lines, tinted best-value cell (`.table-best`), sticky
  first column. The sort arrow appears on hover and stays on the sorted
  column with the blue underline.
  Since 20 Nov 2026 `SortableTable` runs on TanStack Table v9
  (`src/app/data-table.jsx`, re-exported from `shared.jsx`; callers kept the
  same `columns`/`rows`/`values`/`maxima`/`pageSize` props). TanStack owns the
  state: one-column sorting (data columns high-to-low first, the row header
  A-to-Z; missing values last in both directions; ties keep the given order),
  paging (page reset only on a sort or search change) and a search over the
  row header for tables long enough to page. Sort is remembered per table for
  the session. On request the desktop table then took shadcn's default
  data-table look instead of `.rank-table`: a bordered rounded frame inside
  the card's content padding, ghost sort buttons with the arrow after the
  label, number columns right-aligned, shadcn `Input` search and outline
  Previous/Next with "Page N of M". The best value per column keeps only its
  tooltip. A "Columns" visibility menu was added and then removed on request.
  Refined the same day: a muted header row with small muted labels whose
  sort arrow appears on hover and stays on the sorted column (labels of
  right-aligned columns put the arrow first); 44px rows with 12px cell
  padding; the best value per column in semibold, but only where rows differ
  (an all-tie column has no best); a search with no match shows a row inside
  the frame; Previous/Next carry chevrons. A table that is a section's only
  content (party size, lobby rank, servers, RR by rank) uses `TableSection`:
  on desktop its frame is the card (12px radius, no card around it), on
  phones the row list sits in a card. Tables inside a titled card
  (Encounters, Wintrading) keep an inset 8px-radius frame.
  Name History's desktop table moved onto the same data table (standalone,
  newest first until a column is sorted, every column left-aligned since they
  are text and dates); phones keep the timeline list. With that, nothing used
  `.rank-table` and its CSS was removed.
  The Overview's recent matches (not sortable) takes the same look through
  the shared class constants in `data-table.jsx` (`TABLE_FRAME`,
  `TABLE_HEAD_ROW`, `TABLE_HEAD`, `TABLE_CELL`): an inset frame in its card on
  desktop; on phones it runs full-bleed with 8px inner cells and a 40px map
  thumbnail, since the inset version was 27px too wide at 375px.
  Phones keep the `MobileRowList` cards, full-bleed in the card.
  Opening that Columns menu first shifted the page 7.5px left: Radix's scroll
  lock puts `overflow: hidden` on body, which takes over the viewport and drops
  html's `scrollbar-gutter: stable`, then adds a scrollbar-width margin. Body
  now reserves the gutter too and the margin is removed (`src/index.css`), so
  no Radix menu, select or dialog moves the page.
  Database-style options (20 Nov 2026, first used on Duos): `pageSizes`
  adds a rows-per-page picker to the pager, `tools` puts controls beside the
  search, `searchable` forces the search on, `emptyText` fills the frame when
  an outside filter leaves no rows, and `detail(index)` makes rows expandable
  (a chevron in the row header opens a full-width detail row; on phones a
  toggle under the card).
- Overview: rebuilt as a shadcn dashboard (see "Overview dashboard" below).
- Match History: one summary strip, one-line day headers, and the old match
  card (210 px map-art panel, 25 px scoreline, uppercase result tag, bold
  stats, deaths in grey rather than red). On phones the stats use the old
  two-column layout, which also fixes the cut-off average lobby.
- Name History marks the current Riot ID in blue text.

Kept from the rewrite: the larger team and enemy rank chart, keyboard
pickers, and every toggle.

## Overview dashboard (17 Nov 2026)

`src/app/pages/Overview.jsx` follows shadcn's dashboard blocks, top to bottom:

- Lobby rank beside top teammates (`KpiCards`). Both cards share one header
  shape: an h2 title and an outline link to the full page (Lobby Rank,
  Duos). The lobby rank card (`LobbyRankCard`, the site's namesake,
  redesigned 20 Nov 2026) sets `--lobby-rank` to the average's rank colour
  (`rColor`), tints the card from the top-left with it and draws a hairline
  accent along its top edge. Its hero is the 64px rank badge over a soft
  blurred glow, the division in rank colour with the RR into it on the right,
  a shadcn `Progress` bar (0–100 RR) in the rank colour (both left out when
  the average is Immortal 1 or higher; see "Lobby RR at Immortal+"), and the rated-lobby
  count (a hint explains the 7-rated-player rule). A shadcn `Separator` then
  splits off two uppercase-labelled sections. "Lobby spread" (`lobbySpread`)
  appears when the lobbies cover more than one division: one slim rounded bar
  per division from the lowest to the highest, empty divisions as stubs, each
  in its own division's rank colour with only the average's division solid
  (one shared hue was tried and dropped on 20 Nov 2026: an Immortal average
  painted its Ascendant bars red); labels under
  every bar up to eight, else the ends and the average. "By party size" is a
  shadcn table in the shared data-table look (as Top teammates): one row per
  size played with party icon and label, lobby rank (icon and label) and
  lobby count; the row's title has the full summary. There is no RR column
  (removed on request): the RR into an averaged division is interpolated
  and added nothing per party size. A container query on the table frame
  (`@container`, 19rem) handles the narrow two-column card on tablets
  (640–~800px): the Lobbies column hides, the count goes under the party
  label, and the rank shows its short label. Phones fit all three columns. No badges. The `demo`
  fixture spreads lobbies from Platinum 2 to Ascendant 1 and mixes solo, duo
  and trio queues so the card has something to show. Top teammates took the slot of the former
  "Net RR (last 20)" card on request (17 Nov 2026): up to four party
  teammates as table rows (name, matches together, win rate, your net RR
  with them), with a link to Duos. A solo player gets a dashed empty note
  so the row keeps both cards. From 20 Nov 2026 the list fills the height
  the lobby rank card sets (from sm up): the table sits out of flow in a
  flex-1 box, and `useRowsThatFit` measures how many whole rows fit (at least
  `TEAMMATES_MIN_ROWS`, 4) whenever the box resizes. Phones stack the cards
  and keep four.
- Act stats: the eight act figures (K/D, ACS, PS, ADR, KAST, playtime,
  matches with W/L/D, win rate) as one 4×2 hairline grid, 2×4 on phones.
- Clutch stats: 1v1–1v5 win rate with a `Progress` bar and counts (five
  columns at every width), the attempted share as a badge, and the
  won/lost/saved split as one segmented bar. The tiles have the pre-React
  colours again (`CLUTCH_COLORS`: 1v1 green `#22c55e`, teal, blue, indigo,
  1v5 purple `#a855f7`, white text); a tile with no situations stays neutral.
- RR trend, last 20 matches (`RecentRRCard`), replacing the full trend chart
  on request (17 Nov 2026), in the style of compact tracker cards: net RR in
  the header, a cumulative RR line from 0 with one dot per match coloured by
  result (hover for the match), then avg gain, avg loss, RR gained and RR
  lost. Net and the gained/lost totals sum every recorded RR change in the
  window; the averages use RR-eligible matches only (no placements or
  5-stacks), as the footnote says. No range tabs; the RR page keeps the
  rank-axis chart and the longer ranges.
- Recent matches: full-width `Table` of the latest 8 with map art. Card
  actions link to the full pages.

`RankIcon` keeps each icon's aspect ratio (`object-contain`; the embedded
Immortal 3 icon is 40×37) and switches to the 256px PNG from 32px up.

Removed: the "Most-played lobbies" preview, the scrolling recent-match list,
the "Net RR (last 20)" KPI card and the full RR trend chart (both folded
into the last-20 RR card).

## Charts (17 Nov 2026)

All hand-built charts follow one system, checked against the dataviz method:

- **Colours** (`--series-1`, `--chart-win/loss/draw/save` in `src/index.css`):
  validated on the `#141416` card surface in dark mode. Win `#1baf7a`, loss
  `#e34948` and draw `#c98500` pass every gate; the win/loss deutan distance
  (6.9) sits in the floor band, so each chart also shows outcome by position
  or a label. Blue `#3987e5` carries single series and "your team" (blue/red
  passes outright). Text keeps the brighter `--win`/`--loss` tokens.
- **Marks**: 2px lines, a ~10% area wash, markers with a 2px surface ring,
  hairline solid grid, bars capped at 24px with a 4px rounded top and square
  baseline, direct labels only where they say something (curve ends, peaks,
  the latest RR), with a surface halo where they cross a line.
- **Frames and cards**: every plot sits in a `ChartFrame` (an inset `#0f0f11`
  panel with a hairline border) inside its card. Chart cards follow one order:
  header (title, one-line description, range control on the right) (20 Nov 2026: a `CardAction` link, badge or figure is centred on the title row; `CardAction` no longer spans the description row), key
  figures, the framed chart, then notes in small muted text. The RR page
  splits its key figures off (20 Nov 2026, on request): an "RR summary" card
  at the top holds five tiles in the Act stats grid look (`RRSummary`): Net RR (with the
  match count it sums), RR / Win and RR / Loss (with the eligible win and
  loss counts), W–L–D (draws always shown, in the draw yellow `text-draw`, even at zero; with a win/loss/draw split bar) and win rate (with a
  shadcn `Progress` bar), then the performance bonus note. Phones put Net RR
  across the full width above two rows of two. `StatStrip` and its
  `.stat-strip` CSS are gone. Since 21 Nov 2026 the summary, "RR trend" and
  "RR by session" cards each have their own match range: a small menu in the
  card header (`RRRangeSelect`: all time with the match count, Last 50 above
  50 matches, Last 30, Last 20). The ranges are kept per card in the engine
  (`rrRanges`, `setRRRange(card, value)`, `rrScopedMatches`), so changing one
  never rescopes another. Until then the summary's range tabs drove the trend
  and session charts too, which was not wanted.
- **Hover/focus**: one shared `ChartTooltip` (value first). RR trend uses a
  crosshair that snaps to the nearest match. The payout chart has no hover
  readout (removed on request); its curve points keep their aria-labels. The
  score-margin chart has no tooltip either (removed on request); lobby
  dot-plot rows show their own tooltip. All keep their aria-labels.
- **Per chart**: RR trend (reworked 17 Nov 2026) labels rank bands with icon
  and name on the left, washing every other band so each rank reads as a
  range. Since 21 Nov 2026 (on request, after MIBR zekken#1515's Immortal 1 to
  Radiant 948 RR climb looked lopsided), a chart that reaches Immortal+ drops
  that column. Its rank thresholds are unlabelled dashed lines. Threshold
  labels (icon and name) and ringed rank-up icons on the line were tried
  with it and removed on request on 22 Nov 2026. Charts below Immortal are
  unchanged. Immortal 2/3 and Radiant floors sit between the highest game recorded
  below that tier and the lowest recorded at or above it (no fixed Radiant
  line; tiers never recorded get no band). Immortal+ adds a dashed leaderboard
  RR scale on the right. Dates are evenly spaced, one per day at most; the end
  label takes the first spot (above, left, below) the line does not cross, and
  a "Peak" label marks a higher earlier point. Result dots show whenever
  matches are at least 8px apart, the hover point takes its result colour, and
  the area uses the gradient wash of the overview line. A range with no
  performance bonus says so instead of "+0 RR across 0 games". The dev
  fixture `?fixture=climb` reproduces a 106-game Immortal 1 to Radiant climb;
  since 20 Nov 2026 its payouts drift (gains about +26 to +16, losses about
  −12 to −20, oldest to newest, with jitter) so payout charts have a trend to
  show. "RR by session" (`RRSessionCard`, 21 Nov 2026) follows the RR trend
  card; it replaced "RR payout over time" (20 Nov 2026). See
  [rr-sessions.md](rr-sessions.md).
  The payout chart gets
  Win/Loss end labels, an "Even at N RR" label and a "RR per game" axis; the
  score-margin chart shows the count on top of every bar again (exact
  scorelines are in each bar's aria-label); "RR by result" is a diverging bar
  chart instead of a table (`RRResultChart`): one row per exact scoreline,
  closest margin first, average RR per loss growing left in red and per win
  right in green on one shared scale, value and game count at each bar end,
  "OT" on overtime scorelines and a dashed rule between margins; the overview
  clutch outcome split is a thin segmented bar with gaps. (The clutch tiles
  briefly went neutral; their old colours were restored on request.)

## Intentional differences

- shadcn components replace the hand-written widgets; the pieces listed above
  take the legacy look. The rank-coloured accent
  is still driven by the player's current rank (`--rank`). The search area
  (`SearchHeader.jsx`) is built from shadcn parts (17 Nov 2026): an
  `InputGroup` (search icon, input, Ctrl/⌘ K `Kbd` hint, submit
  `InputGroupButton`) beside a `ButtonGroup` with the pro library and act
  picker (outline `Button`s opening `Popover` + `Command`). The landing page
  keeps the centered intro above it; once a player loads it sits in a `Card`
  with a `Spinner` + `Progress` status line. The account's current rank,
  region and the Tracker.gg link slide into the right end of the input as
  three separate pills (`PILL`: bordered, `rounded-md` like the other
  controls), replacing the shortcut hint: 16px from the right with a fade,
  90ms apart, off under reduced motion. Phones replace this card with the app
  bar described in [mobile-layout.md](mobile-layout.md); the phone landing page
  keeps the full form, its "Pro players" button opening the search sheet.
- Pages have no visible title or description (17 Nov 2026, on request): the
  navigation names the page, so content starts right under it. Each page
  keeps its `<h1>` as `sr-only` (`PageHeading`), since it is the page's
  `aria-labelledby` name and the focus target after a page switch. The
  replay page's note about sandboxed parsing moved into its footnote.
  Cards whose title says it all have no description line either (Act stats,
  both RR trends, Recent matches, Top teammates, RR by result). Encounters
  and Wintrading signals keep theirs (who counts, and the "heuristic, not
  proof" caveat), and Clutch stats keeps its won-of-opportunities figure.
- No dot (`·`) separators anywhere in the UI (17 Nov 2026, on request; a
  test enforces it). Inline visual lists use `Sep`, a thin vertical rule
  (`shared.jsx`); text, tooltips and screen-reader labels use commas, colons
  or parentheses, and replay step details use semicolons because their
  upload times already contain a comma.
- Text boxes (inputs, the search bar, textareas) show a 1px focus ring
  around the 1px border, fading in with it. The payout chart's individual
  match dots are drawn at 28% opacity (were 55%) so the estimate curves lead.
- Server errors appear in one alert above the pages instead of only on the
  overview.
- The width measurement for match-card badge columns (canvas `measureText`) is
  gone; grid layout handles it.
- Paginated cards with dot navigation were already unused; their helpers were
  dropped.

## Deployment

The site now needs a build. In the Cloudflare Pages project settings, set
**Build command** to `npm run build` and **Build output directory** to `dist`.
The root directory stays the repository root, so `functions/` keeps working.
The build copies `_redirects`, `assets/`, `legacy/`, `pro-players.json`,
`favicon.svg`, `showcase.html` and `riot-probe.html` into `dist/`. Vite's own
files go to `dist/_app/` so `/assets/` URLs are unchanged.

Without those settings, a push would serve the unbuilt Vite shell, so set them
before deploying this change.

## Tests

`npm test` (the existing `node --test` command) passes: 381 tests.

- Logic tests that slice functions by text markers now read
  `src/engine/core.mjs`. Markers that pointed at removed DOM functions were
  moved to the next declaration.
- The overview stat maths moved into `overviewStatValues()` and the RR-by-rank
  rows into `rrRankRows()`, so tests call them directly.
- Rendering tests now render the real components to static HTML through Vite's
  SSR loader (`tests/helpers/react-render.mjs`): rank icons, the score-margin
  chart, RR payout chart ticks and zoom, the RR details panel, the duo table's
  teammate/you switch, the RR page with RR-less matches, and the name history
  table.
- The `loadAll` harness in `tests/fetch-efficiency.test.mjs` uses the new
  act-picker state instead of a stub `<select>`.

## Verification

- Browser, dev build with fixtures (`?fixture=demo` and `?fixture=worst`):
  every page at desktop width and at 375 px. There is no horizontal page
  overflow on any page (the ping map clips inside its panel), and there are no
  console errors. Match cards expand to the RR details and roster. The ping map
  draws 76 countries and fills its country picker.
- Browser, production build under `wrangler pages dev dist` with the Functions:
  pro-library pick → account lookup → route `/player/Absol/1321?act=…` →
  act picker → progressive match loading → 429 wait message. The local D1 had
  no schema applied, so the D1-only routes (archive, coverage, name history,
  mmr-history persistence) returned 503 and the UI fell back as the old page
  did. A full run against a migrated D1 was not done.

## Known gaps

- The JS bundle is about 600 kB (215 kB gzip), mostly the embedded rank badges
  that were already inline in the old page. They can be lazy-loaded later.
- `scripts/serve-ui-stress.py` now serves `legacy/index.html`. The React app
  uses `?fixture=` instead.
- The production deploy is unverified until the Pages build settings are
  changed.

## Lobby RR at Immortal+

Lobby averages are means of rated players' tier ids; match data carries no
player RR. Their "RR" (`tierRR`) is the average's decimal part read as RR
into a division, which is a fair shorthand only where divisions are 100 RR
wide (Iron through Ascendant). From Immortal 1 up, RR accumulates from the
Immortal 1 floor and Immortal 2, Immortal 3 and Radiant are regional
leaderboard cutoffs, so an "N RR into Immortal 3" figure describes nothing.
Since 20 Nov 2026 (user decision) every lobby-average display goes through
`lobbyRR`/`lobbyRankText` in `core.mjs`, which drop the RR once the average
rounds to tier 24+: the Overview lobby rank card (no RR figure or bar), table
lobby values (`LobbyValue`), the Duos matchup, match cards and their
tooltips, the match-history day headers, and the Lobby Rank team/enemy chart
rows and tooltips. The team gap there (`lobbyTeamsGapLabel`) stays in RR
below Immortal and becomes "Enemy higher"/"Team higher" once either side
averages Immortal+. The player's own rank (app bar, RR page, pre-match rank)
is untouched: that is real RR from the MMR history. Averaging tier ids still
treats Immortal 1 → 2 → 3 → Radiant as equal steps; that limit remains, as
the data has no per-player RR to do better.
