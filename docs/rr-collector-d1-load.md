# RR collector D1 load (23 Nov 2026)

On request, the D1 overload caused by the RR corpus collector was traced and
reduced.

## Symptom

On 23 November 2026, around 20:35–20:45 UTC, D1 rejected queries with
"D1 DB is overloaded. Too many resources consumed within a 10 second window"
(code 7429). On the site every D1-backed route (`match-archive`,
`match-archive-pages`, `match-archive-counts`, `match-coverage`,
`name-history`) answered 503 for a time, so a cached player's search fell back
to a full live scan (about 16 s instead of about 4 s). A direct one-row query
from wrangler got the same error.

The collector's own logs show the pattern in every run that day: "D1
overloaded; retrying read" once at startup (before "Polling…") and eight times
in a row at the end (after "Database inventory"), never during the three hours
of polling. The 20:35 UTC failures came at the end of the run that started at
17:37 UTC with a 180-minute budget.

## Where the load came from

D1 query analytics (GraphQL `d1QueriesAdaptiveGroups`, last 24 hours, read on
23 November 2026; `wrangler d1 insights` returned nothing for this token):

| Statement | Runs | Average D1 time | Average rows read |
| --- | --- | --- | --- |
| Census slice (1 of 16) | 91 | 4.4 s (another variant 7.0 s) | 146k |
| Feature inventory (`loadFeaturePlan`) | 12 | 8.2 s | 2.37M |
| Health report (`corpusReport`) | 14 | 3.9 s | 5.1M |
| Startup activity (`loadActivity`) | 5 | 5.6 s | 2.24M |
| Each polling, site or quota statement | thousands | 0–2 ms | 1–90 |

At the end of a run the inventory count (8.2 s), the 16 census slices (about
70 s of D1 time with only 1 s pauses, so D1 was about 80% busy for over a
minute) and the health query ran back to back. The inventory had no overload
retry. Two other large entries were one-off statements, not the collector: the
R2 migration of 22 November and ad-hoc size queries.

Why the single statements were heavy:

- **Health report.** Each player's latest game was `MAX(julianday(date))` and
  their last-week count filtered on `julianday(date)`. Neither can use an
  index, so every row of every player was read twice.
- **Startup activity.** The last-week counts were a `GROUP BY` over the whole
  table, and the act's first game was `MIN(date)` over every row of the act.
- **Inventory.** Every `rr_history` row (about a million) is joined to four
  tables, once for counts and once more for the queue, which also sorts every
  missing row.
- **Census.** About 15 `json_extract` calls per row on every row.

## Changes

- **Paced, sliced passes** (`pacedQuery` in
  [.github/scripts/d1-query.mjs](../.github/scripts/d1-query.mjs)). Before each
  statement of a pass the collector waits four times the D1 time the previous
  one reported (`meta.duration`, attached by `d1Query`), at least 0.5 s and at
  most 20 s, so it keeps D1 busy at most about a fifth of the time. When D1
  reports no time (a failed statement), the whole round trip is used.
- **Census**: 64 slices instead of 16, paced; the health query shares the
  pacing. One 1/64 slice measured 248 ms and read 24,823 rows.
- **Inventory**: 64 PUUID slices on the primary key, paced, with the overload
  retry. Counts add up per slice. Each slice returns its first `limit` queued
  rows in the queue order (archived first, then newest, then PUUID and match
  ID), and the merged list is cut to `limit`, so the result equals the single
  statement (tested). One count slice measured 81 ms (46,224 rows), one queue
  slice 75 ms (61,623 rows).
- **Health report**: the latest game is one seek on `(puuid,date)`
  (`ORDER BY date DESC LIMIT 1`). The last-week count is a range on the same
  index (`date >= bound AND julianday(date) >= …`). That index holds both
  columns, so no table row is read. Measured: 565,207 rows, 0.45 s (was
  5.1M rows, 3.9 s).
- **Startup activity**: the last-week count is the same per-player range, and
  the act's first game is a single seek on the season index. Measured:
  562,059 rows, 0.75 s (was 2.24M rows, 5.6 s).

The date bound (`recentDateBound`) is the window start minus one second, cut
to whole seconds, as an ISO string. Stored dates are ISO UTC strings
(`YYYY-MM-DDTHH:MM:SS[.fff]Z`; the newest 20,000 rows all had that shape), so
every date in the window sorts at or above the bound, and the exact
`julianday` test keeps the result unchanged (tested with 0–3 fractional
digits).

Tried and reverted: an index range on `rr_history(date)` for the startup
`GROUP BY` (forced with `INDEXED BY`). The last week held 411,360 of the
roughly one million rows, and the date-only index needs a table lookup per row
for the PUUID: measured once on D1 it read 822,720 rows in 12 s. That single
measurement overloaded D1 again; the next query was rejected with 7429.

## What is not measured yet

The pacing only takes effect when the collector runs the new scripts. The
expected peak is the largest single statement (now under about 1 s) with at
least four times that idle afterwards, instead of 70 s of slices at 80% load.
Whether that is enough to keep D1 from rejecting site queries has to be
confirmed from the next runs' logs ("D1 overloaded; retrying read") and D1
analytics. The census and inventory now take longer in wall time (roughly
3–4 minutes and 1–2 minutes per run). The job's 220-minute timeout leaves
about 35 minutes past the 180-minute budget for them.

## Tests

`tests/rr-corpus.test.mjs`:

- pacing waits four times the D1-reported time within its bounds, never
  before the first statement, and also after a failed one;
- `d1Query` attaches D1's time without changing the rows;
- the health and startup plans use `idx_rr_history_puuid_date (puuid=? AND
  date>?)`, never a whole-index scan, and the act start needs no sort;
- the date bound keeps the same rows as the exact filter for every fractional
  format at the window edge;
- the sliced inventory equals one statement for limits 0, 3, 7 and 50;
- the rewritten startup query returns the same last-week counts, latest game
  and act start as before (also run against the old query).

## Overlapping player reloads (24 Nov 2026)

### Symptom

Two earlier live quota drains against the site
([profile-quota-reserve.md](profile-quota-reserve.md)) got bursts of
`503 Upstream quota storage unavailable`, and the drain at 23:20 UTC got one
too: 98 responses from 23:20:14.8 to 23:20:20.8. The proxy's gate-failure log
(`wrangler pages deployment tail`) gave the D1 error for the first time:

```
Quota gate admission failed on rank: D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.
```

The same error failed three of the collector's own `rr-collect` calls.
Cloudflare describes this error as the database using too much CPU and memory
within ten seconds (developers.cloudflare.com/d1/observability/debug-d1).

### Where the load came from

D1 analytics per minute (`d1AnalyticsAdaptiveGroups`, 20:50 to 23:30 UTC)
normally show 5,000 to 20,000 rows read. Some minutes read far more:

| UTC minute | rows read | drain at that time | 503s |
| --- | --- | --- | --- |
| 20:59 | 2,307,312 | second drain | yes |
| 21:17 to 21:18 | 651,821 | fourth drain (logged as 21:13; its traffic shows in D1 at 21:16 to 21:18) | yes |
| 21:48 to 21:49 | 2,295,364 | none | none to observe |
| 22:19 | 1,717,052 | none | none to observe |
| 22:49 to 22:50 | 2,322,124 | none (the next drain started at 22:52) | none to observe |
| 23:20 | 1,710,066 | fifth drain | yes |

The third drain (21:03) and the 22:52 drain fell in quiet minutes and had no
503s. The collector run that was in progress started at 21:17:42 UTC. Its
reload interval (`RELOAD_MS`) is 30 minutes, which matches the spikes at
21:48, 22:19, 22:49 and 23:20. The 20:59 spike was during an earlier run
(started 16:14 UTC, later cancelled); which statement caused it was not
checked.

The heavy statements do not appear in the per-query analytics
(`d1QueriesAdaptiveGroups`) at all. There only the site's single-row
statements show up, at well under a millisecond each. So the following
attribution comes from timing and one measurement, not from per-query data.

A reload reads every tracked account with its activity (`loadTracked` in
[.github/scripts/rr-activity-query.mjs](../.github/scripts/rr-activity-query.mjs)).
Measured once on D1 at 23:28 UTC, outside the drains: 568,153 rows read,
2.2 s of D1 time, for 23,476 accounts (363,961 games in the last week). Its
plan uses the intended indexes. D1's per-minute analytics counted it once (23:27:
656,377 rows, which includes two `COUNT(*)` checks of 82,464 rows run just
before it). The 1.71M rows of the 23:20 minute are about three times that.

The cause is in the collector's scheduler (`runCollector` in
[.github/scripts/collect-rr-corpus.mjs](../.github/scripts/collect-rr-corpus.mjs)).
Four workers each ask `next()` for a task. A worker that finds the reload due
runs it, but `loaded` moves only once the reload finishes. Every other worker
that asked during those 2.2 s found it due too and started its own reload. In
a test with four workers and a slow load, four reloads ran at once. So every
30 minutes D1 got up to four copies of its heaviest regular statement at
once. Inference: that alone uses up most of the ten-second budget, and the
extra site traffic of a drain (about 19 gate statements a second) pushes it
over.

The drain's own gate load was also measured, as background. Over the 165 s
drain the public gate ran 1,807 admission updates and 1,283 state reads,
with 694 ms and 136 ms of D1 time. Only 90 of those updates admitted a call;
the rest were waiting calls polling again. Cheap per statement, but most of
the drain's D1 statements.

### Change

One reload at a time: a `reloading` flag is set while a reload runs, and
other workers carry on with the current plan instead of starting their own.
A fatal error still stops the run, and a failed reload still waits for the
next interval.

Test (`tests/rr-collector-workflow.test.mjs`): four workers and a load that
takes 2.2 s run one reload at a time and one per interval. Without the fix,
four overlapped.

## Keeping script load off the site (24 Nov 2026)

The overlapping reloads were one bug, but the cause underneath is structural:
the site and every script share one D1 database, and an overload rejects
every query of that database for a few seconds, the site's single-row
quota-gate statements included. So the fix has two sides: scripts can take
only a bounded share of D1, and the site rides out a brief overload instead
of answering 503.

### Script side: one governor per process

Every statement a script sends goes through `d1Query` in
[.github/scripts/d1-query.mjs](../.github/scripts/d1-query.mjs), and so
through one governor per process (`createD1Governor`, shared via
`d1Governor()`):

- **One statement at a time.** However many workers or callers a script has,
  its statements are queued, so no bug like the overlapping reloads can stack
  heavy reads again.
- **Pacing.** After each statement the governor leaves D1 alone for
  `PACE_FACTOR` (4) times the D1 time that statement took, at most 20 s. So
  scripts use at most about a fifth of D1's time. A failed statement, which
  reports no D1 time, counts its round trip instead.
- **Early warning.** A statement that kept D1 busy longer than `D1_SLOW_MS`
  (1 s) is logged as a GitHub `::warning::` with its SQL, so a read that
  grows with its tables shows up before it can overload D1. The collector's
  report gains a `d1` block: statements, total D1 time, slow count and the
  slowest statement.
- **No bypasses.** `listPlayers` (refresh-rr-history), `d1DatabaseSize` and
  [scripts/export-rr-curve-corpus.mjs](../scripts/export-rr-curve-corpus.mjs)
  used to call D1's REST API directly and now go through `d1Query`. A test
  fails if any script calls the D1 query endpoint itself.

### Script side: the player reload in self-sizing ranges

`loadTracked` ([.github/scripts/rr-activity-query.mjs](../.github/scripts/rr-activity-query.mjs))
now reads through `readByPuuidRange`. It starts with 16 PUUID ranges and,
after each range, resizes the next one so that it should take about
`SLICE_TARGET_MS` (250 ms) of D1 time, at most doubling or quartering per
step; without a reported time the size stays. The ranges cover every string
(the first starts at `''`, the last ends at `'~'`), so each PUUID is read
exactly once whatever its case. As the tables grow the read uses more,
smaller ranges instead of one longer statement. Each range repeats the two act
lookups, which are single index seeks.

Not measured against production yet: the number of ranges and the D1 time per
range of a real reload. The collector's report and the slow-statement warning
will show both.

### Site side: retrying a brief overload

[lib/d1-retry.mjs](../lib/d1-retry.mjs) wraps `env.APP_DB` for every request
of the API proxy (`onRequestGet`, `onRequestPost`) and of the replay routes
(`withD1RetryContext`). A statement (`first`, `run`, `all`, `raw`) or a
batch that fails with "D1 DB is overloaded" is retried after about 0.15, 0.4,
1 and 2.5 s (each ±25% jitter), about 4 s in all; a batch is retried whole.
Any other error, or an overload that outlasts the waits, is thrown unchanged,
so the quota gate still fails closed with a 503.

Retried writes are safe: they are upserts, conditional updates or quota-gate
leases, and an extra lease only holds units back until it expires. Inference,
not documented by Cloudflare: an overloaded database rejects a statement
before running it, so a retried write has not run twice.

### Options ruled out

- **D1 read replicas.** Cloudflare documents them only through the Worker
  binding's Sessions API, not the REST API the scripts use, so they cannot
  move script reads off the primary.
- **A Durable Object for the quota gate.** It would shield only the gate, not
  the other D1-backed routes (`match-archive`, `name-history`, …), and it
  needs a separate Worker plus dashboard setup.

### Tests

- `tests/d1-governor.test.mjs`: one statement at a time across callers; the
  pause is four times the D1 time, capped, and a failure counts its round
  trip; slow statements are reported with their SQL; PUUID ranges read every
  row exactly once (case and edge values) and shrink or grow with their D1
  time; every script reaches D1 through `d1Query`.
- `tests/d1-retry.test.mjs`: an overload is retried with growing waits; one
  that outlasts the waits, and any other error, is thrown unchanged; a batch
  is retried whole; the quota gate admits through a brief overload and still
  fails closed when it lasts; the request context only swaps `APP_DB`.
- `tests/rr-corpus.test.mjs`: the ranged player read returns the same rows as
  one statement, each range searching the PUUID key.

### Not yet done or verified

- Deployed on 25 Nov 2026 (commits 09bc1b6 and 0d37c60). The collector picks
  up the scripts at its next run; the current run keeps the old ones.
- Whether the 503 bursts stop has to be checked with a quota drain that
  overlaps a reload (about :20 or :50 past the hour while a run is going).
- `wrangler d1 execute` and other ad-hoc queries bypass the governor. Heavy
  one-off reads should go through a script that uses `d1Query`.
- The census and inventory reads still use fixed slices (`pacedQuery`). They
  are paced and get the slow-statement warning, but do not resize themselves.
- The gate's polling (most of a drain's D1 statements) is untouched.
