# Match card expand speed

24 Nov 2026. Opening a match card on Match History took 20–80 ms of main-thread
work in a production build. It now takes about 10 ms, whatever the number of cards shown.

## Where the time went

Measured on the dev fixtures (`?fixture=120`, with Load More pressed until 15, 60 or
120 cards were shown). The measurement started at a click on the card's trigger, ran through
React's sync flush and ended with a forced layout (`document.body.offsetHeight`).
Opening and closing cost almost the same, and both grew with the number of cards shown:

| Cards shown | Open (median) | Close (median) |
| --- | --- | --- |
| 15 | 20–23 ms | 16–18 ms |
| 60 | 46–48 ms | 46–47 ms |
| 120 | 69–79 ms | 70–80 ms |

The expanded body was not the main cost. `MatchesPage` kept the opened ids in
state and gave every card a new `onOpenChange` closure on each render, so a toggle
re-rendered every card (with its `matchView`, about eight Radix tooltips and the
map backdrop), every day recap and the RR by session chart. Nothing computes per round or per player on
open beyond sorting the ten players. There are no charts in the opened card,
and the collapsible has no animation.

The opened body itself cost about 8–9 ms with 15 cards shown, of which about 4 ms
was style and layout (forced inside Radix Collapsible's height measurement)
and about 4.5 ms was React. About half of that React time was the roughly 17 Radix tooltips in the
stat tiles and roster.

## Change

- `MatchLogCard` (memoized) wraps `MatchCard` in the log and gets one stable
  `onToggle(matchId,open)` from the page (`useCallback`, no dependencies). A toggle
  re-renders only the card whose `open` changed. All cards still re-render on
  engine changes, because `s` is the engine snapshot.
- `DayHeader` and `RRSessionCard` are memoized. Their props do not change on a toggle.
- `toggleExpanded` returns the same set when nothing changes, so a no-op toggle does
  not re-render the page.

The card's content and look are unchanged. `MatchCard` keeps its props, and
`MatchLogCard` renders exactly the same HTML (tested).

## After

Same build setup and method:

| Cards shown | Open, desktop (1024 px) | Close | Open, phone (375 px) | Close |
| --- | --- | --- | --- | --- |
| 15 | 9.3–10.5 ms | 5–7 ms | 8.6 ms | 5.0 ms |
| 60 | 9.3–10.2 ms | 7–8 ms | 8.1 ms | 5.6 ms |
| 120 | 10.5–11.4 ms | 10–11 ms | 9.6 ms | 7.5 ms |

Before at 375 px: 20.6, 42.0 and 68.3 ms to open with 15, 60 and 120 cards.

In the Vite dev server (development React under StrictMode), the open went from
about 60–170 ms (15 cards) and 150–260 ms (60 cards) to about 38–46 ms.

## Tried and not kept

- **Deferring the opened card's tooltips** to a render just after the first paint
  (`useDeferredValue`): the first frame got about 2 ms cheaper. But attaching the tooltips
  remounts their triggers, and that re-inserted the roster's agent `<img>`s a frame
  after the card opened. With `loading="lazy"`, they were not complete at insertion, so the icons
  could blank for a moment. Not kept.
- **One shared `TooltipProvider`** instead of one per `Hint`: about 0.3 ms. It would also
  have changed the tooltips' skip-delay behaviour across hints. Not kept.

## Method and limits

- Timings come from a production build of this branch with the dev fixtures kept
  (a scratch Vite config that defines `import.meta.env.DEV` and builds to a scratch folder). It was
  served by `vite preview` in the in-app browser. They are one desktop machine's numbers. A phone's
  CPU is slower, so its absolute times are higher, but the proportions should hold.
- The browser pane was hidden, so frames were throttled. That is why the timings stop at the forced
  layout rather than the next paint. Paint and compositing are not included.
- Medians of 16–24 open/close pairs per row. Runs varied by a few ms with machine load. Where the
  ranges come from repeated runs, both are given.

## Tests

`tests/match-card-expand.test.mjs`:
- `MatchLogCard` renders the same HTML as `MatchCard`, closed and opened.
- `MatchLogCard`, `RRSessionCard` and `DayHeader` are memoized.
- The page passes the stable `toggle`.
- `toggleExpanded` adds and removes ids and keeps the set when nothing changes.

The check in the browser at 375 px and desktop widths: two opened cards stayed open after
switching to RR Breakdown and Duos (desktop) or RR (phone tab bar) and back, and still toggled afterwards.
