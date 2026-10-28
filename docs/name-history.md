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
is never used to invent boundaries, but it is used to hide impossible
match-derived periods (below).

## Rename cooldown

Since the 2023-11-20 Riot ID transition, Riot allows one Riot ID change per 90
days (the transition plan first said 365 days and was then reworked to 90).
Before that, VALORANT allowed one per 30 days. HenrikDev match data can still put
an ID on a match outside the period it was used. Verified case: `PRC Squirrel#dead`
(PUUID `00268c23-62f3-5f9b-a6f4-1cdf59c0776a`) is returned with his current ID
on match `66c92aec-1ed2-4448-b8a0-fcd58f389847` from 2026-03-20. That match falls
between `Eggster#greg` (last seen 2026-03-19) and `F4Q Bunny#hop` (first seen
2026-04-19), and it showed up as a one-day period.

`mergeNameTimeline` therefore checks every three consecutive periods A → B → C.
Each rename happened somewhere between the last observation of one ID and the
first of the next, so the widest possible spacing of the two renames is
`C.first_seen − A.last_seen`. Days without games only widen this window, so
infrequent players are not penalised; the window shrinks only when matches
were actually observed close together. B is hidden when all of these hold:

1. the window is shorter than the cooldown in force: 90 days when A's last
   observation is on or after 2023-11-20, otherwise 30 days;
2. B is a match-only period that spans at most one day; and
3. B's ID is used again later. Together with (2), that is the signature of the
   verified bug: a later name showing up briefly on older matches.

Adjacent periods with the same ID are then joined, and the check repeats.

- Live account checks are never hidden.
- A cooldown conflict without that signature is left as observed, because the
  data cannot say which side is wrong.
- The rule is applied when the timeline is read. Stored evidence is not changed,
  so the rule can be revised without rescanning.
- Name reuse (A → B → A) is kept when the renames can be a cooldown apart.

### Production check (2026-10-28)

Before the rule was enabled, it was compared against every saved timeline in the
production D1 (`vlravg-calib`). That covered 2,160 players, 1,102 of them with
more than one period. The tables read were `player_name_history`, the compact
`player_name_backfill.evidence` and the legacy `player_name_matches` rows that
reads use. The comparison was read-only.

- A first version without conditions (2) and the 30-day pre-transition limit
  changed 111 players and hid 198 periods. 125 of those periods lasted longer
  than a day: real names held for weeks or months by frequent renamers, for
  example six month-long `Movv#rina` periods, or monthly renamers in 2022–23.
  The 90-day cooldown does not hold well enough for long periods to be
  rejected by it.
- The final rule changes 48 players and hides 56 periods. Every one lasts at
  most one day, and all fall in 2025-09 (20), 2026-03 (6) or 2026-04 (30). Each
  is an ID the player takes on later, 5–229 days afterwards (median 69). In 50
  of the 56 it is the player's current name, the same pattern as the verified
  PRC Squirrel match.
- Unknown: whether any hidden one-day period was a real name. HenrikDev is the
  only source for these matches, so the data cannot confirm it either way.

For PRC Squirrel, the Mar 20 blip is hidden: Eggster (last Mar 19) to Bunny
(first Apr 19) is 30 days, and `PRC Squirrel#dead` is used again from May 2.
The Eggster → `F4Q Bunny#hop` → Squirrel sequence also spans only 44 days
(Mar 19 to May 2), but Bunny never reappears, and the v4 match details for its
matches (`aa6e81c7…`, `af07d5cd…`) still report `F4Q Bunny#hop`. It stays.

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

Tests cover renames, tag changes, name reuse, the 90-day cooldown (including the
PRC Squirrel timeline), stale responses, migration replay,
refresh failures, rate-limit retries, resumable backfills, malformed match
records, proxy persistence/cache behavior, shared request pacing, concurrency,
fairness, and continuation without infinite failure loops.
