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

The result was checked in the browser: 164 matches and 164 rated lobbies,
no duplicate match IDs; an opened match card stays open across page
switches; hidden Duos and RR Breakdown pages show current data when opened;
phone width (375 px) has no sideways scroll.

## Tests

- `tests/fetch-efficiency.test.mjs`: planned pages load in parallel and
  publish in order with no request past the end; a one-page archive costs one
  page request beside the plan; the plan cuts pages exactly where cursor
  paging does; an empty archive completes; the stored-matches index is
  requested before the live scan ends.
- `tests/performance-archive.test.mjs`: a page of ten matches is stored five
  at a time and indexed once each.
- `tests/mobile-layout.test.mjs`: every page sits in a `PageSlot`, and server
  renders leave the eight hidden slots empty.
