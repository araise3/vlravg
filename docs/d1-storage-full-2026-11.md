# D1 at its size limit: slow searches and wasted quota (22 Nov 2026)

## Symptom

Searches sat on "Showing N matches, checking the rest of this act…" for one to
three minutes or longer.

## Evidence

Measured on 22 Nov 2026 against production (vlravg.com, deployment `c5bd3ef`):

- `wrangler d1 info vlravg-calib` reported `database_size 10 GB`. A query's
  `meta.size_after` was 9,999,998,976 bytes, which is D1's per-database limit.
  `match_archive` held 245,454 gzip match payloads, `rr_history` 1,012,303 rows.
- A live search for one Immortal 3 account (216 matches in the act), timed with
  the browser's resource timings:
  - every `mmr-history` call returned 503 after about 0.2–2 s. The browser
    retried each 503 up to five times;
  - `match-coverage` returned 503, so the search had no verified coverage and
    paged the whole act live (23 history pages);
  - the history pages took about 1 s each when admitted, but two calls got a
    429 and one page waited about 12 s.
- An 8-minute `wrangler pages deployment tail` recorded 89 requests. 40 were
  `rr-collect` 503s from the RR collector and 7 were `rr-collect` 429s. The logs
  read "RR corpus persistence failed" and "Profile RR corpus persistence
  failed". The collector runs that day failed or were cancelled after about
  3 hours each.

Inference, not directly observed: the D1 writes fail because the database is
full. The proxy swallows the D1 error text, so the logs do not show it. The
database sitting exactly at the limit while every write route fails and the
read routes succeed supports this.

## Why that slowed searches

Each failing route already spent its HenrikDev call before the save failed.
The browser retried those 503s with backoff, at up to 6 upstream calls per
lookup. The collector kept spending its own pool and borrowed idle public
slots for payloads it could not save. The public pool's pacing then pushed
the visitor's history pages into 429 waits.

## Changes

- Proxy: a save failure after the upstream call returns 503 with
  `storage: "unavailable"` and `no-store`. `mmr-history` and account
  enrolment no longer fail the request: they serve the upstream body unmerged
  and uncached.
- Browser (`apiGet`): a `storage: "unavailable"` 503 is not retried.
- Collector (`requestJSON`): storage 503s are not retried. Five in a row throw
  `WORKFLOW_STORAGE` and end the run without chaining another.
  `assertD1Headroom` refuses to start a run within 200 MB of the 10 GB limit.
- The collector run in progress (45056939794) was cancelled.

## Follow-up

Match payloads, about 7.7 GB of the 10 GB, are moving to R2. See
[match-archive-r2.md](match-archive-r2.md).
