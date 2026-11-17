# Phone layout (17 Nov 2026)

Below Tailwind's `sm` breakpoint (639px and narrower) the site switches to its
own phone layout instead of squeezing the desktop one. `useIsMobile()`
(`src/app/hooks.js`, `MOBILE_QUERY = '(max-width: 639px)'`) picks the layout;
the phone CSS at the end of `src/index.css` uses the same breakpoint. Server
renders (the component tests) always produce the desktop layout, because
`useMediaQuery`'s server snapshot is `false`.

The engine is unchanged. Pages stay mounted in `App.jsx` in both layouts;
only the chrome around them and the way some data is drawn differ.

## Shell (`src/app/MobileShell.jsx`)

- **App bar** (`MobileTopBar`, sticky, blurred): the loaded account's rank
  icon, Riot ID, rank, RR and region. Tapping it, or the search button, opens
  the search sheet. A second row holds the act picker and the Tracker.gg link
  (shown once a search has started). Loading shows a 2px progress line along
  the bar's bottom edge; the status text sits under the bar without a second
  progress bar.
- **Search sheet** (`MobileSearchSheet`, full screen from the top so the
  keyboard does not cover it): one field for Riot ID, PUUID or pro name, a
  clear button, the act picker and a Search button. Pro players matching the
  field are listed live underneath (first 50, with a "keep typing" note), so
  the separate pro search box from desktop is gone. The sheet closes only once
  a submitted search actually starts loading; an invalid entry shakes the
  field and keeps it open. The phone landing page keeps the full search form;
  its "Pro players" button opens this sheet instead of a popover.
- **Bottom tab bar** (`MobileTabBar`, fixed, safe-area padded): Overview,
  Matches, RR and Duos as real links, plus **More**, a bottom sheet with Lobby
  Rank, Servers, Name History and Replays. While one of those is open, the More
  tab takes that page's icon and name. The bar appears as soon as a search
  starts. `MOBILE_TABS` + `MOBILE_MORE` cover every page in `App.jsx`'s `NAV`
  exactly once (tested).
- **Per-page scroll**: each page keeps its own scroll position; a page opened
  for the first time starts at the top. Positions reset on a new search.
- `index.html` sets `viewport-fit=cover` so the bars can pad for notches and
  the home indicator.
- `src/components/ui/sheet.jsx` is shadcn's Sheet (Radix Dialog sliding from
  an edge); the bottom side has a grab handle and safe-area padding.

## Pages

- **Tables become card lists.** `SortableTable` renders `MobileRowList` on
  phones: the row header is the card title, the first data column its
  headline figure, the rest a three-column label/value grid. Columns flagged
  `wide` (average lobby with rank icon and RR) span two cells. Sorting uses a
  native `<select>` (the OS picker) plus a direction button and shares the
  desktop table's remembered sort. The highest-value tint appears only when
  there is more than one row, and the sort row is hidden below three rows.
  This covers Duos (party size, teammates, encounters, wintrading), Lobby
  Rank, Servers and both RR tables.
- **Match History**: `MobileMatchCard` is a compact row: 72px map thumbnail
  with the result stripe and your starting rank, then result, score, MVP
  trophy and RR change on one line, map/time/length/server on the next, and
  K/D/A, ACS, PS and lobby rank under that. Tapping opens the same RR details
  and roster; the roster uses narrower columns and short rank labels.
- **Overview**: the lobby rank and top teammates cards stack; the lobby rows
  use the short rank label ("Immo 3") and put the lobby count under the row
  label. The last-20 RR card's four figures wrap to a 2×2 grid.
  (A combined hero card was tried first and replaced when the cards were
  reworked around the per-party-size lobby ranks.) A skeleton fills the page
  while matches load. Act stats use tighter cells.
- **RR Breakdown**: the payout and score-margin charts draw a narrow viewBox
  (360 wide) with larger type instead of a sideways-scrolling 900-wide one.
  Axis ticks thin out to at least 44px apart, and the score-margin chart
  labels every 1st, 2nd or 4th margin so labels stay about 30px apart. The payout chart gets rank
  chips ("All ranks", "Dia 1", …) for zooming, since double-click is not a
  phone gesture. The RR trend crosshair follows horizontal drags
  (`touch-action: pan-y`) and taps.
- **Name History**: a timeline of cards (name, current marker, date range,
  act) instead of the four-column table.
- **Servers**: the four summary figures share one hairline grid.
- Cards use 16px side padding instead of 24px (unlayered rule; explicit
  `px-0` full-bleed content is left alone).

## Desktop

Unchanged. Checked at 990px after the change: the search card, tab strip and
tables render as before (`data-layout="desktop"`, no tab bar, 8 tables on the
overview fixture).

## Verification

- `tests/mobile-layout.test.mjs`: breakpoint and CSS agree, server renders
  stay desktop, tab bar + More cover every page once, the app bar wiring
  (search focus opens the sheet, closes only on a started search, no
  `rounded-full` controls), card-list order/sort options/wide cells/best tint,
  the one-row case, the compact match card text and label, and the overview
  KPI rows' phone labels.
- In the browser (Vite dev, `?fixture=demo` and `?fixture=worst`) at 375×812
  and 320×700: every page had `scrollWidth` equal to the viewport width (no
  sideways scroll) and no element past the right edge outside intentional
  scrollers. Checked the More sheet, the search sheet (pro filtering, an
  invalid entry staying open with a shake, a valid Riot ID closing it and
  showing the loading state), an expanded match card, and the landing page's
  Pro players button.
- Not checked: a real iOS/Android device (safe-area insets and the on-screen
  keyboard were only emulated), and live API data on phones.
