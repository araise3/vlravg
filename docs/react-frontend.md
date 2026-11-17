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
cards), Badge, Button, Input, Progress, Alert, Tooltip provider.

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

- Two KPI cards, reworked on request (17 Nov 2026): a headline value, then a
  hairline-divided list of rows; no corner badges. Average lobby rank (with
  its RR beside it) lists one row per party size played: party icon and
  label, that size's average lobby rank with icon and RR, and its lobby
  count. Net RR over the last 20 matches lists RR per win, RR per loss and
  the W–L(–D) record with win rate, then "N of M eligible". Net sums every
  recorded RR change; the per-win and per-loss averages use RR-eligible
  matches only. An all-draw window says there are no wins or losses to
  average. Phones show the short rank label and put each row's note under
  its label.
- Act stats: the eight act figures (K/D, ACS, PS, ADR, KAST, playtime,
  matches with W/L/D, win rate) as one 4×2 hairline grid, 2×4 on phones.
- Clutch stats: 1v1–1v5 win rate with a `Progress` bar and counts (five
  columns at every width), the attempted share as a badge, and the
  won/lost/saved split as one segmented bar. The tiles have the pre-React
  colours again (`CLUTCH_COLORS`: 1v1 green `#22c55e`, teal, blue, indigo,
  1v5 purple `#a855f7`, white text); a tile with no situations stays neutral.
- Top teammates: up to three side by side in the same hairline grid (name,
  K/D, matches together), stacked on phones. No avatars.
- RR trend: the RR page's `RRTrendChart` in a card, with All/30/20 tabs that
  share the RR page's range.
- Recent matches: full-width `Table` of the latest 8 with map art. Card
  actions link to the full pages.

`RankIcon` keeps each icon's aspect ratio (`object-contain`; the embedded
Immortal 3 icon is 40×37) and switches to the 256px PNG from 32px up.

Removed: the "Most-played lobbies" preview, the scrolling recent-match list
and the small RR sparkline.

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
  header (title, one-line description, range control on the right), key
  figures as a hairline-divided `StatStrip` (no boxed tiles), the framed
  chart, then notes in small muted text.
- **Hover/focus**: one shared `ChartTooltip` (value first). RR trend uses a
  crosshair that snaps to the nearest match. The payout chart has no hover
  readout (removed on request); its curve points keep their aria-labels. Bars
  and dot-plot rows show their own tooltip and keep their aria-labels.
- **Per chart**: RR trend drops the rank-colour bands and icon-only axis for
  labelled rank boundaries, date ticks and an end label; the payout chart gets
  Win/Loss end labels, an "Even · N RR" label and a "RR per game" axis; the
  score-margin chart labels only its tallest win and loss bars; the overview
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
