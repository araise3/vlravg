# Gap-free RR history: collector rewrite (24 Nov 2026)

On request, the RR corpus collector (`collect-rr-corpus.yml`) was rewritten so
that players' saved RR history has no missing games. This report covers what
was wrong, the evidence behind the new design, and what it can and cannot
recover.

## What was wrong

- **Every run failed and the backlog never cleared.** All collector runs from
  20 to 23 November 2026 ended as "failure" after their full 180 minutes. The
  sim pilot (docs/ml-sim-pilot.md) enrolled about 13,000 extra players through
  `mmr-history-by-puuid` around 15–17 November, so 23,392 accounts were
  tracked. Runs started with 9,900–16,300 accounts due and committed about
  5,000 each, about 28 a minute: the workflow key's own pool
  (`WORKFLOW_SPACING_MS` 2.1 s). Borrowing idle site-key slots added almost
  nothing (the public pool sat at 29 remaining against a reserve of 30). The
  old intervals (6/8/24/72 hours) needed about 60,000 polls a day for this
  pool; the key allows about 40,000.
- **Polls arrived too late.** On 23 November, 14,325 accounts were last
  checked more than 6 hours ago, 946 more than a day, 58 more than 3 days.
- **Missed games were never noticed.** The old check flagged only a full
  window with no overlap with the previous *window*, and nothing acted on it.
- **Every run overloaded D1 at its end** (whole-table inventory and census),
  see [rr-collector-d1-load.md](rr-collector-d1-load.md).

### Gaps in the saved history

A gap shows as a saved payout whose reported starting rank
(`tier_before_update`, `rr_before_update`) differs from the previous saved
payout's ending rank, in the same act. Immortal 1 and up share one RR axis
from 2100, so a Radiant label change with the same RR is not a gap; that
correction removed about 1,060 false positives from a first count.

- Snapshot of 20 Nov (875,157 payouts, 23,165 players): 779,264 consecutive
  same-act pairs with known values; 163 discontinuities, 114 of them between
  payouts never seen together in one upstream window (the rest are witnessed
  adjacent: rank decay, not a missing game).
- Production on 23 Nov, read-only scan (the new daily scan without writes):
  128 unwitnessed discontinuities across 119 players. 49 of them span under
  24 hours. By day they cluster on 18–19 November (30) and 22 November (6),
  the overload days.
- In 6 short windows checked against the player's stored match list, 5 had 1
  or 2 normal completed competitive matches between the two payouts (for
  example a 13–4 win where the RR jumped +18). 54 of the 57 players with a
  discontinuity under 3 days had full 20-game windows spanning 12 to 267
  hours, so the games were not pushed out by other modes; the polls came too
  late.

## Facts the design rests on

- **The live window.** `v2/by-puuid/mmr-history` returns the ranked games
  among the player's last 20 matches *of any mode*: on 23 Nov it returned 16
  and 5 entries for players whose stored history had 21 and 30. Unrated,
  swiftplay or deathmatch games push ranked ones out. 18,728 of 23,392
  players' last windows held 20 ranked games.
- **Stored RR history.** `v2/by-puuid/stored-mmr-history/{region}/{platform}/{puuid}`
  returns the same entry shape as the live window (reported start, bonuses,
  shield, placement), newest first, paginated (`page`, `size` up to at least
  200) over the whole stored history (1,676 entries for one player).
  - It held 99.87% of the payouts this corpus had for 1,289 sim-pilot players
    (76,083 of 76,185, within each player's stored range).
  - Among those players, 22 real gaps (missing games, not decay): stored
    history closed 20 completely.
  - For 6 active players we had not polled for 5+ hours, stored history
    already held every live entry, including a game from about an hour before.
  - It does not hold everything: in 10 sampled production discontinuities it
    filled 2. The games missing there were absent from both endpoints; they
    are probably stored only when someone fetches the live window in time.
- **Burst risk.** On the 3,531 players tracked continuously since October
  (saved games 25 Oct–19 Nov), the share of moments after which a player
  played 21+ ranked games within an interval, per 10,000:

  | 7-day games | 12 h | 16 h | 24 h | 36 h | 48 h | 72 h |
  | --- | --- | --- | --- | --- | --- | --- |
  | 35+ | 0–1.3 | 15–38 | 64–134 | | | |
  | 15–34 | 0–0.3 | 0–1.5 | 3.4–9.7 | | | |
  | 5–14 | 0 | 0–0.9 | 0–5.6 | | | |
  | 1–4 | 0 | 0 | 0–3.4 | 0.5–30 | | |
  | none, played in 30 days | | | 0.3 | 2.7 | 7.5 | |
  | none in 30 days | | | 0.9 | 5.0 | 11.2 | 46 |

  Ranges are over recency buckets (last game under 6 h … 3–7 days ago).
  These count ranked games only, so mixed-mode players are underestimated;
  the window-turnover rule below covers them. Simulating the old intervals on
  these players with unlimited calls gave 3 overflows in 19 days: the old
  intervals were safe, the calls were not there.

## Design

### Detection at every poll (`collectRR`, lib/rr-corpus.mjs)

Before saving a window, the newest saved payout (the head) is read with one
seek on `(puuid,date)`. The window is contiguous: it lists every ranked game
since its oldest entry. So:

- the window contains the head → nothing between them is lost;
- the window starts after the head, or is empty → games may have dropped
  out: an `rr_gaps` row (`source='window'`) is written **in the same batch** as
  the window, so a crash cannot lose it;
- the window is older than the head (stale upstream answer) → nothing new.

This also covers visitors' own lookups, which go through the same function.
The receipt returns the gap so the collector heals it within the same run.

### Healing (`/api/rr-heal/{puuid}/{after_match_id}`, `healRR`)

Collector-only route (workflow key; 404 for anyone else). Region and platform
come from the gap row. One upstream page (`size=100`) per request, newest
first, until a page reaches the gap's start or ends (at most 10 pages):

- entries strictly between the two payouts that are not saved yet are
  inserted with `vlravg_source: "stored-mmr-history"`; saved (live) payouts
  are never overwritten, and stored adjacency is never recorded in
  `rr_predecessors` (witnessed adjacency stays live-only);
- the stretch is then verified: every reported start must equal the previous
  ending rank. Closed → `healed` (payouts recovered) or `connected` (nothing
  was missing). Not closed → `incomplete`, retried after 1 and 3 days, then
  `unresolved` (stored history lacks the games, or the rank changed without a
  game, such as decay);
- a malformed page is rejected (502) without writes; no stored history (404)
  counts as an empty page.

The daily audit also scans saved history for unwitnessed discontinuities
(`scanGaps`: daily for the players whose history changed, weekly for every
player in paced, self-sizing PUUID ranges) and queues them (`source='scan'`), so earlier gaps get the same treatment. A gap is
recorded once per `(puuid, after_match_id)`.

### Polling (`pollingPolicy`, lib/rr-activity.mjs)

| Cohort | 7-day ranked games | Interval |
| --- | --- | --- |
| heavy | 35+ | 12 h |
| regular | 15–34 | 24 h (16 h until 25 Nov 2026) |
| casual | 5–14 | 36 h (24 h) |
| light | 1–4 | 48 h (24 h) |
| quiet | none, but played in 30 days | 96 h (48 h) |
| inactive | none in 30 days, or never | 96 h (72 h) |

Window turnover: the last window's oldest ranked game bounds how long the
player's last 20 matches took. If that was less than the cohort interval, the
next poll comes within that time (at least 4 hours). This shortens the
interval for players mixing in other modes. Roster evidence and a newly
observed act still wake an account early; a failed probe (404) retries after
the interval, at most a day.

(Lengthened on 25 Nov 2026; see "Intervals fitted to the workflow key"
below.) For the 23,392 players of 23 November the earlier intervals needed
about 29,000 polls a day
(the old intervals: about 60,000), leaving about 11,000 for heals, match
features, discovery and the site's teammate-name lookups.

### The run (`collect-rr-corpus.mjs`)

One run is a continuous scheduler for 330 minutes (job limit 355; GitHub's is
360) and starts the next run itself; the hourly trigger is only a backup.
Four workers always take the most important task:

1. due polls, most overdue first relative to their own interval;
2. gap heals: while polls are due, every fifth task; otherwise all spare calls;
3. match features for payouts of the last 3 days without features, newest
   first (a 15 ms query, against 7.4 s for the old inventory);
4. up to 40 discovery probes per run.

Players are re-read from D1 every 30 minutes, so new enrolments and visitors'
fetches count: a full read at the start of a run and every 3 hours, otherwise
only the accounts that may have changed
([rr-collector-d1-load.md](rr-collector-d1-load.md#reading-less-25-nov-2026)); a poll made in this run is kept over
a lagging replica row. A failed poll or heal is retried 10 minutes later in
the same run. Only a configuration error (pacing not deployed, key mismatch)
or D1 refusing writes stops a run, fails the workflow and skips the chained
run. A backlog is a warning, not a failure. The daily audit runs beside polling, paced, once per 24 hours
(`rr_collector_state`): the gap scan covers the players whose saved history
changed since the last scan, and every player once a week; the act/tier
census runs once a week. The census now also counts payouts filled from
stored history (`stored`).

The step summary lists polls, new payouts, windows that missed the head,
heals by outcome, recovered payouts, features, the backlog the next run starts
with, and all gaps by status.

## Deployment order

`migrations/0012_rr_gap_healing.sql` must be applied **before** the code is
deployed: every RR save (collector and visitors' lookups) writes
`rr_collection.window_from` and may write `rr_gaps`. Without the migration
those saves fail; visitors still get their fresh window, unmerged.

```powershell
npx wrangler d1 execute vlravg-calib --remote --file=migrations/0012_rr_gap_healing.sql
```

Then push (Pages deploys the proxy), then let the workflow run. The first
daily audit queues the existing discontinuities (128 on 23 Nov).

## What is not solved

- Games that neither endpoint holds cannot be recovered. Their gap ends
  `unresolved`, and the RR jump stays visible as a rank discontinuity. Filling
  them from the stored match list with an RR change inferred from the rank
  difference would be an estimate (exact only for exactly one missing game
  without decay or shield); it was not done.
- Discontinuities before 6 October 2026 cannot be detected: the reported
  starting fields were incomplete before then.
- Mixed-mode players' risk is bounded by the turnover rule, not measured: the
  corpus has no counts of their other-mode matches.
- The deathmatch/unrated turnover rule relies on the oldest entry of the last
  window; a player who switches from ranked-only to heavy deathmatch between
  two polls can still outrun one interval. Healing covers that only when
  stored history has the games.

Tests: `tests/rr-gap-healing.test.mjs` (detection, healing, verification,
retries, paging, the route, the scan) and `tests/rr-collector-workflow.test.mjs`
(scheduling order, heal interleaving, retries, reloads, exit and chain rules).

## Intervals fitted to the workflow key, 25 Nov 2026

`lib/rr-activity.mjs` `POLL_HOURS`.

### Why

The collector stopped borrowing the site's HenrikDev key on 25 Nov 2026
([profile-quota-reserve.md](profile-quota-reserve.md#collector-borrowing-removed-25-nov-2026)).
It now has only the workflow key: 30 units a minute, 43,200 a day. The
"about 40,000 calls a day" above counted calls. Since the gate counts
HenrikDev units, a poll (`rr-collect`) costs 2, so the key allows about
21,600 polls a day.

The last full run with borrowing (25 Nov, 07:33 to 12:58 UTC, 23,481 players)
made 8,960 upstream calls, 4,378 of them on borrowed site units: 6,374 polls
(19.3 a minute), 2,564 match features and 10 heals. It ended with 155 due
and none overdue twice. The intervals give the same demand: about 19.1 polls
a minute (27,500 a day, 55,000 units). In the 20 minutes after borrowing was
removed, polls fell to 11-14 a minute.

### Change

| Cohort | Players (25 Nov) | Before | Now |
| --- | --- | --- | --- |
| heavy | 3,067 | 12 h | 12 h |
| regular | 6,563 | 16 h | 24 h |
| casual | 6,366 | 24 h | 36 h |
| light | 3,059 | 24 h | 48 h |
| quiet | 3,803 | 48 h | 96 h |
| inactive | 623 | 72 h | 96 h |

Demand: about 13.6 polls a minute, 19,600 a day, 39,200 units. That leaves
about 4,000 units a day for heals, the site's teammate-name lookups, newly
enrolled accounts (up to 7 units each by the fixed maxima: name history, RR
history, the poll)
and match features. Window turnover (at least 4 h) and wake-ups still
shorten individual intervals, so real demand is somewhat higher.

### Risk

From the burst table above (21+ ranked games within the interval, per
10,000 moments):

- heavy: unchanged at 12 h (16 h would be 15-38);
- regular at 24 h: 3.4-9.7, measured;
- casual at 36 h, light at 48 h, quiet at 96 h and inactive at 96 h: not
  measured. The nearest measured cells are casual 24 h 0-5.6, light 36 h
  0.5-30, quiet 48 h 7.5 and inactive 72 h 46. Inactive gets the same 96 h as
  quiet; at 623 players a shorter interval would save little.

An overflow becomes an `rr_gaps` row. Stored history filled 2 of 10 sampled
discontinuities, so some overflows will lose games.

What else changes: match features and discovery run only when no poll is
due, so with about 4,000 spare units a day they slow down sharply (the
last two runs with borrowing saved 2,564 and 4,916 features in 5.5 hours). Heals still take every fifth task while polls
are due.

Tests: `tests/rr-corpus.test.mjs` (the new intervals per cohort). Not
verified live: the next run's report shows `backlog.due` and
`overdue2x`; due polls should stay near zero.
