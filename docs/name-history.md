# Name history

The `/names` tab shows each observed Riot ID, its first and last observed dates
(UTC), and whether it is current. Name and tag changes both start a new period;
returning to an earlier ID starts another period. History belongs to the PUUID
and spans acts.

`Refresh names and RR history` runs daily at 05:17 UTC. It checks every player
in `rr_players` by PUUID, then refreshes their RR by PUUID. The schedule is
best-effort. A manual run accepts `max_players` for a small verification sample;
scheduled runs always process everyone. Existing Cloudflare secrets are reused.

Searches also check names, with a one-hour edge cache for account checks. The
timeline itself is re-read from D1 so backfilled names appear immediately.
Only fresh account responses update the current identity.

After daily name and RR checks, `Backfill all name histories` drains the
unfinished player queue continuously. Four workers share a gate that starts
at most one request per second; proxy rate-limit responses pause the entire
queue. This overlaps network latency without multiplying the request ceiling.
There are no fixed 2.5-second pauses and no per-player daily page cap.
Each page contains up to ten full
match records, identified by PUUID; no act filter is applied. The compact stored
matches endpoint is scanned afterward in pages of 100. HenrikDev only began
including name/tag there for new records in v4.6.0 and is gradually filling old
records. Usable archived identities extend the timeline immediately. Blank archive
rows older than the earliest known identity are queued
and resolved through the full match-by-ID endpoint; unavailable match IDs are
skipped. Both the archive page and pending-detail queue are persisted, so every
upstream call remains resumable and goes through the shared quota gate. The
full-match and stored-archive phases have separate cursors.

Progress and match evidence are saved atomically in one per-player cursor row.
Subsequent jobs resume the cursor, and completed players are skipped before any API request. Pages rotate
between players, with oldest-touched players first after a restart. Each run
has a five-hour budget and dispatches its next run immediately when unfinished
work remains and progress was made. It stops with an error if remaining players
cannot make progress. Daily refreshes share the workflow lock and take priority
at continuation boundaries; afterward they resume the backfill.

Only the earliest and latest observation of each consecutive Riot ID period
are retained. This preserves displayed date ranges and one-match name changes
without writing indexed evidence rows for every page. Evidence saved before
this optimization remains readable and is merged with the compact periods. RR
rows are also left untouched when a refresh returns byte-for-byte unchanged data.
An isolated historical identity sandwiched between the same Riot ID less than
48 hours apart is discarded as a stale roster observation; slower or sustained
name reuse remains separate. This correction is applied while reading existing
compact evidence too, so a completed backfill does not need to run again.
The backfill has its own 00:07 UTC schedule so a Free-plan D1 write-limit pause
resumes just after Cloudflare resets daily usage at 00:00 UTC.

An empty full-match page advances to the stored archive; a short full-match page
does not. The archive ends when HenrikDev reports no records after the current
page (or returns an empty page). Each phase has a 10,000-record safety limit that
is explicitly reported as incomplete.
The Name History tab's Load older names button processes up to 20 pages, and
can be used again to continue. The daily refresh workflow still accepts
`target_puuid` and `backfill_pages` (up to 1000) to complete a player's scan.

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
cursor. The scheduled backfill therefore supplements players whose full-match
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
