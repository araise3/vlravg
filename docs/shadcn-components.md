# shadcn component pass (20 Nov 2026)

A review of the whole React site for hand-built UI that a shadcn component
already covers. Everything below was asked for; tier 1 items were confirmed
one by one. Tests: `tests/shadcn-parts.test.mjs` plus updates to the
overview, Duos and mobile-layout tests.

## Added components

`native-select`, `empty`, `item`, `avatar`, `scroll-area`, added with
`npx shadcn@latest add`. Two local adjustments:

- The CLI wrote `import { cn } from "cn"`; fixed to `@/lib/utils`.
- `native-select.jsx` uses the repo's input focus style (1px ring, border
  colour transitioned with it; see `tests/search-header.test.mjs`) and takes a
  `wrapperClassName` so the select can stretch (`w-fit` by default).

`progress.jsx` gained three repo additions: `value` is forwarded to Radix (so
`aria-valuenow` is set; upstream drops it), a `null` value is indeterminate (a
35% segment sliding across, keyframe `progress-indeterminate` in
`src/index.css`), and `indicatorClassName`.

## Tier 1: direct swaps

| Where | Before | Now |
|---|---|---|
| RR payout chart, phones | `aria-pressed` chip buttons | `ToggleGroup type="single"` (radio group, arrow keys). Tapping the chosen rank again returns to all ranks. |
| Phone table card lists | `<select>` with copied input classes | `NativeSelect size="sm"` (still the OS picker) |
| Sort direction button | hand-styled button | `Button variant="outline" size="icon-sm"` |
| `ShowAllButton` | ghost-button classes copied | `Button variant="ghost" size="sm"` |
| Overview Top teammates | raw `<table>` | shadcn `Table` with the shared `TABLE_*` classes (tinted header row, like Recent matches) |
| `EmptyState` and the dashed one-liners in Overview | dashed divs | `Empty` (`EmptyState`, `InlineEmpty`), text only |
| Tracker.gg link (search card, phone app bar) | hand-styled link | `Button variant="outline" size="sm" asChild`; on desktop it keeps the shared `PILL` look of the rank and region pills |
| `Sep` | span rule | `Separator orientation="vertical"` rendered as a span (`asChild`), since it sits inside text and the match card's button; still decorative |

## Tier 2

### Hints instead of native titles

`TooltipProvider` was mounted but `Tooltip` was never used; explanations lived
in native `title` attributes, which never show on touch screens.
`src/app/hint.jsx` exports `Hint`, a shadcn Tooltip that:

- opens on hover and keyboard focus (the text gets `tabindex="0"` and a faint
  dotted underline), and toggles on a tap (a click whose `pointerType` is not
  `mouse`); an outside tap closes it;
- with `asChild` puts the trigger on an existing element instead (the table
  sort buttons; spans inside a match card's toggle button, where a focus stop
  would be invalid, so those open on hover only);
- wraps its own `TooltipProvider` (delay 200 ms) so components render outside
  `App` in tests.

Converted: table column definitions (sort buttons), Act stats labels, the RR
trend net figure, Top teammates Win rate/RR, the clutch "attempted" badge and
outcome legend, Duo matchup Win rate/Total RR and the partner K/D header,
`StatStrip` labels, Count placements, the roster PS header and the day
header's Net RR, and on match cards the RR change (Rank Shield), MVP,
Placements badge, PS, Avg lobby and starting rank.

Left as native `title`: truncation titles that repeat the visible text, and
per-cell data titles (best value in a column, Performance Score coverage,
the wintrade "heuristic" note per cell). Tooltips inside a match card's
button are hover-only, so phones still don't see those; the card's
`aria-label` carries the figures and the opened card's RR notes repeat Rank Shield.

### One progress bar

The search card's indeterminate bar, the phone app bar's line and the Name
History scan bar were three hand-built bars with two keyframes
(`search-progress`, `indeterminate`). All three are now `Progress`; the Name
History bar is now a labelled `progressbar` rather than a span.

### Item and Avatar

The phone pro-player list (initial in an `Avatar`), the More sheet links and
the replay rows are `Item`s. Replay rows are an outline `Item` with the card's
radius and shadow; the error, steps and Turnstile take full-width rows
(`basis-full`).

### ScrollArea

The Duos partner list scrolls in a `ScrollArea` on desktop. Its overlay
scrollbar sits over the rows' right padding, so the header no longer needs the
matching `scrollbar-gutter` trick. Radix wraps the content in a
`display:table` div, which stops names truncating; `SCROLL_BLOCK` forces it to
`block`. The cmdk lists (pro library popover, act picker) keep their own
scrolling: cmdk scrolls the active item itself and the popover's height rules
are tested.

### Loading skeletons

`EmptyState loading` renders `PageSkeleton` (filter row, summary card, table
shaped blocks, with the loading line kept for screen readers) on the detail
pages. The overview skeleton, phones-only before, now has a desktop shape too.

## Verified

`npm run build` and `npm test` (470 pass). In the browser (Vite fixtures) at
desktop width and 375 px:

- the loading skeletons, the Act stats hint on hover, and a simulated touch tap
  opening it, then an outside tap closing it;
- Duos partner columns staying aligned; scrolling and the hover scrollbar,
  checked with the list forced short, since no fixture has enough partners;
- replay rows, checked with the fixture IDs temporarily made UUIDs (reverted);
- the RR zoom chips: select, then tap again to return to all ranks;
- phone sort select and direction button;
- the More sheet opening and closing on navigation;
- the pro list with avatars;
- match card separators, with no horizontal page scroll.

Not checked: a real touch device (the tap path was simulated with a
`pointerType: 'touch'` click), and Duos "Show all" with more than eight
partners in the browser; the latter is covered only by the static render.
