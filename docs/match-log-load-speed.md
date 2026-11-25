# Match log speed under load

25 Nov 2026. I looked for slow interactions with many matches loaded, using a
new dev fixture with realistic player variety: `?fixture=crowd` (169 matches)
or `?fixture=crowd<n>`. The older fixtures repeat the same nine players, so
their teammate and encounter tables stay tiny. Search typing is covered
separately in [search-typing-speed.md](search-typing-speed.md).

## Method

Times run from the click until a zero-delay timeout after the next frame.
"Production" means a `vite build` with fixtures enabled, served from a scratch
folder; the fixtures are dev-only in the real build. "Dev" is `npm run dev`.

## Findings and fixes

### Load More got slower with every click

Each click re-rendered every card already shown, because `MatchLogCard`
received the whole engine snapshot as `s`, and the snapshot is new on every
engine change. Dev build, `?fixture=500`: 98 ms for the first click, rising to
about 1 s per click at 500 cards.

Fix: cards get `useMatchCardState(s)`, an object holding only the fields a
card reads (`PUUID`, `PLAYER`, `TAG`, `mhIncludeReset`) that changes only when
one of them does. `postReset` is passed as a prop of its own because
`tagPostResetPlacements` re-tags it on the same match object on each publish.
Load More now costs the same at any length: about 100 ms in dev, and 25–50 ms
in production at 500 cards.

### Showing Match History again was slow with many cards shown

Switching back to Match History with every card shown: about 210 ms at 169
cards and 600 ms at 500 cards in production. With 500 cards shown, leaving the
page cost about 90 ms. Measured by toggling the page's `hidden` attribute
directly, style and layout took about 275 ms and paint 60 ms. React's work to
re-show the page (re-running effects for 26,000 DOM nodes and about 4 tooltips
per card) took the rest.

Fixes:

- `.match-card` has `content-visibility: auto` (with `contain-intrinsic-size:
  auto 66px`, a closed card's height on desktop and phones). Off-screen cards
  skip style, layout and paint: 335 ms became 33 ms for the browser's share at
  500 cards. Cards already clip to their border, so paint containment hides
  nothing. Focus rings and tooltips were checked.
- A card mounts `CollapsibleContent` only while open. Radix measures the content
  with `getBoundingClientRect` in a layout effect, and its `Presence` reads
  `getComputedStyle` when the ref attaches. Both re-run for every card each time
  the page is shown. Together with `content-visibility`, that forced a layout
  of every skipped card, and the page switch took about 600 ms even with 169
  cards. Closed cards lose only the empty details `div`.

Result in production: about 93 ms at 169 cards and about 255 ms at 500.

| Production build | before | after |
|---|---|---|
| Match History shown again, 169 cards | ~210 ms | ~93 ms |
| Match History shown again, 500 cards | ~600 ms | ~255 ms |
| Load More at 500 cards | not measured in production (dev: ~1 s) | 25–50 ms |
| Open a card, 500 shown | 38 ms | 21 ms |

## Checked, no change needed

These were measured in production with `?fixture=crowd169`; the 500-match
figures use `crowd500`:

- Page switches: Overview, Duos, Lobby Rank, Servers, Clutches and Name History
  take 15–80 ms. RR Breakdown takes about 85 ms, or 170 ms at 500 matches.
- Duos table sorts at 126 party-teammate rows took about 70 ms in dev. The
  encounter filter and pages took under 20 ms.
- The RR range picker took about 200 ms in dev at 500 matches.
- No console errors in any run.

## Left open

- At 500 cards, React's share of showing Match History (about 200 ms) is
  mostly the Radix tooltips: each `Hint` mounts a provider, root, Popper and
  trigger even while closed. A build where `Hint` rendered only its child cut
  the switch at 169 cards from about 210 to 120 ms. Mounting only the tooltip
  content while open gained about 15 ms. Making `Hint` lazy needs care with
  keyboard focus (re-wrapping the trigger remounts it), so it is not done here.
- `content-visibility` placeholders are 66px, so the scrollbar can shift a
  little as unseen cards render for the first time. Scrolling 169 cards to the
  end changed the page height by 50px.

Tests: `tests/match-card-expand.test.mjs`.
