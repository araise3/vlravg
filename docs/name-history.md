# Name history

The `/names` tab shows each observed Riot ID, its first and last observed dates
(UTC), and whether it is current. Name and tag changes both start a new period;
returning to an earlier ID starts another period. History belongs to the PUUID
and spans acts.

There is no scheduled name refresh or historical backfill. The remaining RR
collector polls tracked accounts under its activity policy.

Searches check names, with a one-hour edge cache for account checks. The
timeline itself is re-read from D1 so backfilled names appear immediately.
Only fresh account responses update the current identity.

Historical scanning is requested through the Name History tab. Full matches and
the compact stored archive provide historical identity evidence; blank archived
rows may require match-by-ID lookups. Full-match and stored-archive cursors are
persisted separately, so interrupted scans resume and completed scans are skipped.

Only the earliest and latest observation of each consecutive Riot ID period
are retained. This preserves displayed date ranges and one-match name changes
without writing indexed evidence rows for every page. Evidence saved before
this optimization remains readable and is merged with the compact periods. RR
rows are also left untouched when a refresh returns byte-for-byte unchanged data.
An isolated historical identity sandwiched between the same Riot ID less than
48 hours apart is discarded as a stale roster observation. A name seen for at
most one day is also discarded when the surrounding observations of the same
ID are less than seven days apart and at least one surrounding run spans a
week. This covers stale matches at the end of a long name period even when the
returning ID has just one match. Longer or less well-supported name reuse stays
separate. The correction is applied while reading existing compact evidence too,
so a completed backfill does not need to run again.
If a scan hits a quota limit, its saved cursor can be resumed later.

An empty full-match page advances to the stored archive; a short full-match page
does not. The archive ends when HenrikDev reports no records after the current
page (or returns an empty page). Each phase has a 10,000-record safety limit that
is explicitly reported as incomplete.
The Name History tab's Load older names button scans until completion or until
the user stops it. Selecting it again resumes from the saved cursor.

Historical evidence fills the time before the first live account observation.
It cannot replace the current identity or split a verified live period. Names
reused after another name get separate ranges. The table labels ranges sourced
from matches, checks, or both. Dates are first/last observations, not exact
rename dates; missing matches or names can leave gaps. The 90-day rename limit
is not used to invent boundaries or skip evidence.

## Database setup

New databases use `schema.sql`. For an existing database, apply the migrations
in order before deploying the new API:

```sh
npx wrangler d1 execute <database-name> --remote --file migrations/0001_name_history.sql
npx wrangler d1 execute <database-name> --remote --file migrations/0002_name_backfill.sql
npx wrangler d1 execute <database-name> --remote --file migrations/0003_compact_name_evidence.sql
npx wrangler d1 execute <database-name> --remote --file migrations/0004_stored_name_backfill.sql
```

Migration 0004 marks the stored-archive phase unfinished for every existing
cursor. A subsequent user-requested scan therefore supplements players whose full-match
scan had already completed; it does not repeat their full-match pages.

The migration preserves each player's last stored name and observation date as
the initial period. It does not infer earlier dates from their match history.

## Verification

With Node.js 24:

```sh
node --test tests/name-history.test.mjs tests/backfill-scheduler.test.mjs
```

Tests cover renames, tag changes, name reuse, stale responses, migration replay,
refresh failures, rate-limit retries, resumable backfills, malformed match
records, proxy persistence/cache behavior, shared request pacing, concurrency,
fairness, and continuation without infinite failure loops.
