# RR by session

Added 21 Nov 2026 on request. It replaces "RR payout over time"
([rr-payout-over-time.md](rr-payout-over-time.md)) on the RR page, right
after the RR trend card.

## Why the replacement

Payout size barely moves within an act ([rr-and-hidden-mmr.md](rr-and-hidden-mmr.md)).
From Platinum up, most wins and losses land within about ±4 RR of 18, and round
margin causes most of that spread. So the old chart's 5-game trailing averages
were two nearly flat lines. What actually moves RR is how many games are won,
so the new chart shows the net result of each sitting.

## What it shows

- **Data** (`rrSessionRows` in `src/engine/core.mjs`): matches with a recorded
  RR change (`myRR`) and a start time, in play order. A new session starts when
  more than `RR_SESSION_BREAK_MS` (3 hours) passes between one match's end and
  the next match's start. A match ends at its start plus `durationMs`, or 40
  minutes when the duration is unknown. Each session carries its start and end,
  its matches, W–L–D, its net RR (every recorded change, placements and
  5-stacks included, like the summary's Net RR) and the rank after its last match.
- **Chart** (`RRSessionChart`/`RRSessionCard` in `src/app/pages/RR.jsx`): one
  bar per session from a zero line, green up for a net gain and red down for a
  net loss (a zero session is a thin yellow mark). Above the chart:
  - number of sessions
  - average net RR per session
  - how many sessions ended with a net gain
  - best and worst session with their dates

  Values sit at the bar ends once bars are at least 28px apart (24px on
  phones). Date labels thin out to stay 64px apart (52px on phones). Hover or
  focus shows net RR, games and record, rank after, and the date and time span.
- **Range**: the card's own range menu (all time, or the 50/30/20 most recent
  matches; independent of the summary and trend cards since 21 Nov 2026). With
  a recent-matches range, the oldest session can be cut part-way.

## Limits

- The 3-hour break is a choice, not a measured value. Long evenings with breaks
  under 3 hours count as one session; one real example ran 16:46–02:01 with
  6 games.
- Match times come from the match start time; a missing duration is estimated
  at 40 minutes.

## Verification

- `tests/rr-sessions.test.mjs` covers:
  - session splitting at the boundary (exactly 3 hours stays one session, just
    over splits)
  - unknown durations, and placements and 5-stacks counting
  - matches left out for having no RR or no start time
  - rank after, label thinning, bars, summary and aria labels
  - the empty state, and the card's place in the page
- Checked in the browser with `npm run dev:live` on a real Immortal account
  (44 sessions in e11a6, 5 in the last-20 range):
  - at about 575px, 375px (no horizontal scroll) and 1280px wide
  - hover tooltip and value labels
