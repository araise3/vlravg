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
