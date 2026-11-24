# Loading a cached player faster (23 Nov 2026)

On request, the load of a player whose act is already saved (match archive in
R2, coverage verified by an earlier search) was measured and shortened.

## Where the time went

Measured on 23 Nov 2026 with hiro#luna (164 saved matches in the current
act, coverage already verified), in the in-app browser, single location.
These are single runs, not a benchmark.

Deployed production build (`vlravg1.pages.dev`), times from navigation start:

| Step | Ends at |
| --- | --- |
| First saved matches on screen | 0.7 s |
| Live scan, two known pages (`history-by-puuid` with a scan ID) | 3.0 s |
| Archive read, 12 requests | 3.9 s |
| Stored-matches index, 3 pages, started only after the archive | 4.6 s |
| Coverage finish (`POST match-coverage`), awaited before showing "found" | 4.8 s |

Main-thread blocking (long animation frames) over the load: 2.6 s in
production and 7.6 s in the Vite dev build. Four causes:

1. **Every engine update re-rendered all nine pages.** Pages stay mounted so
   navigation keeps state, and each one reads the engine snapshot. With React
   profilers around each page (dev build, one full load): Duos 1.8 s, Match
   History 1.7 s, RR Breakdown 1.2 s, while the visible Overview took 0.6 s.
   One update cost about 430 ms in dev and about 80 ms in production. A load
   sends dozens of updates (each archive page, status line and teammate name).
2. **The archive read was chained.** Pages are capped at 512 KB of compressed
   payload, so a 50-row chunk usually came back with about 16 rows, and the
   rest of the chunk could only be requested after that answer arrived.
3. **Scan pages saved one match at a time.** A `history-by-puuid` page with a
   scan ID waits for its 10 matches to be stored before it responds (coverage
   evidence must not be certified for an unsaved page). Each match is an R2
   read, and a write when something changed, done in sequence: about 1 s per
   page.
4. **The stored-matches index waited for everything else.** It needs nothing
   the archive or live history return, but it started only after both.

## Changes

1. **Hidden pages render only when idle** (`PageSlot` in
   [src/app/App.jsx](../src/app/App.jsx)). Each inactive page sits in a
   hidden React `<Activity>`: its state and DOM are kept (open match cards,
   sorts, scroll), but its updates render at idle priority in interruptible
   slices, and its effects pause until it is shown. Server renders contain
   only the active page.
2. **Archive page plan** (`readMatchArchivePages`, route
   `GET /api/match-archive-pages/<puuid>/<act>`, D1 only). It returns
   `{total, pages:[[start,size],…]}` using the same cut as `readMatchArchive`
   (at most 50 rows, the first row always, then rows while the compressed
   total stays within 512 KB). `readServerMatchArchive` requests it beside
   the first page, then loads every other planned page up to six at a time.
   A page that still stops early at the 8 MB JSON budget is finished from its
   cursor, as before. Rows that become ready together publish as one update.
   Without a plan (older proxy, failed request) the 50-row chunks are used.
3. **Parallel saves** (`saveMatchArchivePage`): up to five matches of a page
   are stored at once (`MATCH_ARCHIVE_SAVE_PARALLEL`). R2 conditional writes
   already handle concurrent writers of the same match.
4. **Stored-matches index starts early** (`readStoredSeasonIndex`): once the
   act and scan ID are known, beside the archive and live history.
   `recoverStoredSeasonMatches` waits for it only after both finish, then
   fetches details only for IDs neither supplied. Coverage evidence pages are
   keyed by kind and page number and verified in order at the finish, so the
   new order does not change what is certified.
5. **Coverage finish after the results**: the finished match count and
   status are shown first; certifying coverage only helps the next search.

Nothing else changed: no quota, cache or trusted-data rules, and every page
still publishes in archive order.

## Results

Dev build against the live API (`npm run dev:live`), same player:

| | Before | After, no plan (deployed proxy) | After, stubbed plan |
| --- | --- | --- | --- |
| Main-thread blocking during the load | 7.6 s | 0.1 s | not measured |
| Archive read done | 6.7 s | 7.5 s | 2.4 s |
| Stored-matches index done | 9.1 s | 3.1 s | 2.6 s |
| Search complete (coverage finish) | 9.8 s | 8.2 s | 3.7 s |

"Before" and "no plan" are timed from navigation start. The deployed proxy
has no plan route yet, so that run used the fallback chained paging, which
stayed the critical path. The stubbed-plan run is timed from a repeat search
click in the same tab, so it skips page startup and the account lookup,
which took 0.1 s (before) and 1.2 s (no plan, cold dev server) in the other
runs.

The stubbed plan is a simulation, not the deployed route: the plan
response was stubbed in the page with 16-row pages for the act's real
164-match count, and the archive pages themselves were real requests to the
live proxy. The real plan follows the compressed sizes, so its pages differ
slightly. The parallel saves are covered by tests only; they could not be
timed before deploying. After deploying, the critical path should be the two
live scan pages, which these saves shorten.

### After deploying (23 Nov 2026, about 20:40 UTC)

Production, same player, first load after the deploy:

| | Before (production) | After (production) |
| --- | --- | --- |
| Plan answered | – | 0.6 s (38 ms request) |
| First saved matches on screen | 0.7 s | 1.9 s |
| Archive read done | 3.9 s, 12 requests | 2.8 s, 10 requests |
| Stored-matches index done | 4.6 s | 3.7 s |
| Main-thread blocking (long animation frames) | 2.6 s | 0 s |

The first page arrived later because all ten archive requests ran at once
(each took 0.8–1.2 s instead of about 0.5 s). The whole search could not be
timed cleanly: D1 was rejecting queries with "D1 DB is overloaded. Too many
resources consumed within a 10 second window" (code 7429). In that run the
first live scan page took 7.4 s and the next returned 503 twice before it
succeeded; on a reload every D1 route (archive, plan, counts, coverage, name
history) returned 503, so the site fell back to a full live scan. The
overload predates this change: the RR corpus collector logged "D1
overloaded; retrying read" in its 11:39 and 14:38 UTC runs that day, and
it was still running. This change adds one small D1 query per search (the
plan) and runs the archive's queries at once instead of one after another.

Follow-up the same evening: the other planned pages now start only once the
first page has arrived (the plan still loads beside it), so the first saved
matches are not slowed by the rest. Not yet timed in production.

The result was checked in the browser: 164 matches and 164 rated lobbies,
no duplicate match IDs; an opened match card stays open across page
switches; hidden Duos and RR Breakdown pages show current data when opened;
phone width (375 px) has no sideways scroll.

## Live history look-ahead (24 Nov 2026)

After the saved matches appear, the status reads "Checking for more
matches…" while `loadAll` pages through live history. Timed in production
that day, every `history-by-puuid` page (ten full matches, about 3.7 MB)
took 4–6 s, and the pages were requested one at a time. A full scan of an
act from offset 113 took 5–8 s per page; a cached player with verified
coverage still waited for two or three such pages in a row. The proxy's
inline archive and evidence writes account for about 0.4–0.6 s of a page
(an edge-cached page took 66–156 ms without a scan and 433–632 ms with
one), so the time is upstream.

`loadAll` now requests live pages ahead of the one it is reading and still
reads them strictly in order:

- A full scan keeps three pages in flight (`LIVE_PAGES_AHEAD=2`).
- A search with verified coverage keeps two (`LIVE_PAGES_AHEAD_VERIFIED=1`),
  since it usually ends after two pages.
- Look-ahead pauses after a short page, a page that reaches another act,
  or a page already covered, because the next page probably ends the scan.

Cost in upstream calls, from the tests: verified searches request exactly
what they did before (2 pages with no new games, 3 with a few). A full scan
that reaches the previous act asks for one page past the end; one whose
history runs out inside the act asks for two. The request pool per search
went from two slots to four (three live pages plus the stored-matches
index). Upstream pacing is unchanged; it stays in the proxy.

Off-chain pages: a look-ahead request after a short page lands at an offset
the scan never reads. `verifyPages` (`lib/match-coverage.mjs`) now follows
the chain of page offsets from the first one and ignores pages off it,
instead of failing on them. A missing link in the chain still fails
verification.

Timed locally against the deployed API (`npm run dev:live`) for a
current-act player with 46 saved matches: pages 0 and 10 were requested
together at 3.2 s and answered at 10.4 and 10.9 s, page 20 at 15.4 s, and
the scan finished with 49 matches. That is a single run with no
before/after pair on the same player, so the saving is not measured. Going
by the per-page times, it should be about one page latency (4–7 s) per
search with new games, and more on full scans.

### Starting the scan beside the rank request

The first live page used to wait for the rank request, the act dates and
the coverage ledger: in the production run above it went out at 3.2 s,
after rank answered at about 2.9 s. When the act is certain to be the
current one, `loadAll` now opens the coverage ledger and requests the
scan's first pages (two with verified coverage, three without) right after
the account resolves, beside rank. "Certain" means the route names the
current act, or no act is named and the current act already has saved
matches (`match-archive-counts`); the act picker then selects it, since it
is the newest act with games. In every other case, including a first visit
with nothing saved, the scan starts after rank as before, so no request is
spent on an act the search will not read. Pages are keyed by URL, so the
scan reuses the early ones; request counts in the tests are unchanged. The
per-search request pool went to six slots, because rank, RR history and
name history now share it with the early pages.

Timed locally (`npm run dev:live`) for the same player, a minute later:
the coverage ledger opened at 0.87 s and pages 0 and 10 went out at 0.99 s.
Rank and both pages were edge-cache hits in that run, so it shows the new
order, not the saving: the search finished at 4.3 s, and its tail was the
saved-archive read. The saving is whatever rank takes on a cache miss
(1-2.5 s in the runs above).

### Finding an older act's start

An older act (not the current one) is scanned from the offset where it
begins in the live match list. `findHistoryStartForAct` found that offset
by binary-searching 0–5000 with one-match probes
(`/history/…?size=1&start=N`): 12–13 requests in a row, about 12 s in
production that day, all under "Finding this act's matches…" and before
the first live page.

The offset is the first one whose match started before the next act (or
lies past the end of the list). It is still decided only by live probes:
two neighbouring probes, one newer and one older than the boundary, prove
it. What changed is where the search probes. Each round guesses the offset
and probes the two matches on either side of it together, so a right guess
settles the search in one round of two requests. The guesses, in order:

1. **MMR games of the later acts** (`rank`, already loaded). These totals
   belong to the account's current region and can be wrong after a region
   transfer, which is why they were never used as the offset itself. Here
   they are only a guess, so a wrong one costs one round of probes.
2. **The stored-matches index**, which already loads beside the scan
   (`readStoredSeasonIndex`, 100 rows a page, newest first, with
   `started_at`). Its pages now also feed a timeline
   (`createStoredTimeline`). From the nearest probed match, the number of
   stored rows between that match and the boundary predicts how far away
   the boundary is. The search waits for the index only until a page passes
   the boundary, not for the whole act.
3. After three guesses, or with neither source, it gallops (offset steps of
   10, 20, 40, …) until a probe lands past the act, then bisects, as before.

Options looked at and not used: the saved archive counts cover only matches
this site has saved, so they are a weaker version of guess 1; probing many
offsets at once without a guess would cut the rounds but raise the upstream
calls on the shared quota.

The result is unchanged: the scan starts one full page (`BATCH`) before the
act's first match, so its first page is entirely newer-act matches and
`verifyPages` still sees the scan begin before the act.

How the two sources matched the live list for hiro#luna on 24 Nov 2026: the
stored-index rows newer than the boundary between the current act and the
one before it numbered 164, the same as the live offset the binary search
found (164) and the MMR games of the current act (164). For one act
further back, the stored count was 287 and the MMR games 164 + 123 = 287.
That is one account; other accounts (region transfers, matches missing
from Henrik's store) can differ, which the tests cover.

Measured locally against the deployed API (`npm run dev:live`), hiro#luna,
single runs, times from navigation start:

| Act (live offset of its start) | Before: old probe sequence | After: in the app |
| --- | --- | --- |
| V26 Act V (164) | 12 probes in a row, 12.7 s | 2 probes together at 1.79 s, answered 3.06 and 3.40 s; first page requested at 3.41 s (1.6 s searching) |
| V26 Act IV (287) | 12 probes in a row, 7.7 s | 2 probes, 47 ms: edge-cache hits after the "before" run, so not a cold time |
| V26 Act III (330) | 12 probes in a row, 12.8 s; the last two (48 and 50 ms) were edge-cache hits after the "after" run | 2 probes together at 0.38 s, answered 0.78 and 0.88 s; first page requested at 0.89 s (0.5 s searching) |

"Before" replays the old search's exact request sequence from the page
(same probes, same order, one at a time), since the old code is no longer
in the build; probes cost 0.5–1.7 s each in those runs. "After" is the
real search in the app. In all three, the MMR guess was right, so the
stored-index path did not run against the live API; it and the fallback
are covered by tests only. Act V then loaded 123 matches, the act's MMR
game count.

Cost in upstream calls, from the tests: a right guess costs 2 probes in one
round instead of 12–13 in a row. Over 300 generated cases (wrong guesses
by up to 40, a tenth of stored rows missing, extra stored rows, no MMR or
no stored index in a quarter of cases each, short lists, empty acts), every
case found the binary search's offset, in 1,593 rounds and 1,799 probes,
where the binary search needed 3,705 probes in a row; the worst case was 8
rounds.

## Tests

- `tests/fetch-efficiency.test.mjs`: planned pages load in parallel and
  publish in order with no request past the end; a one-page archive costs one
  page request beside the plan; the plan cuts pages exactly where cursor
  paging does; an empty archive completes; the stored-matches index is
  requested before the live scan ends.
- `tests/fetch-efficiency.test.mjs` (look-ahead): a full scan keeps three
  live pages in flight and publishes every match once, in order; a verified
  search keeps two and requests only pages 0 and 10; look-ahead pauses at
  the previous act.
- `tests/fetch-efficiency.test.mjs` (early start): a current-act search
  requests pages 0 and 10 before rank answers and reuses them; with no act
  named, saved current-act matches start it early and an empty archive does
  not; a search for an older act never starts the current act early.
- `tests/fetch-efficiency.test.mjs` (older-act start): a right MMR guess
  costs one round of two probes where the binary search needed 12; a wrong,
  zero or missing guess is corrected from the stored index in one more
  round; the search waits for the stored index only until it passes the
  boundary; with no usable guess it still proves the offset, and unreadable
  dates still mean a scan from the newest match; 300 generated cases give
  the binary search's offset in under half its requests in a row; in
  `loadAll`, an older act is found with two probes and its scan starts on a
  page of newer-act matches.
- `tests/match-coverage.test.mjs`: look-ahead pages off the chain neither
  block nor fake coverage.
- `tests/performance-archive.test.mjs`: a page of ten matches is stored five
  at a time and indexed once each.
- `tests/mobile-layout.test.mjs`: every page sits in a `PageSlot`, and server
  renders leave the eight hidden slots empty.
