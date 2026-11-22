# Match archive payloads in R2 (Nov 2026)

## Why

On 22 Nov 2026 the D1 database `vlravg-calib` reached D1's hard 10 GB limit,
and every write failed (see [d1-storage-full-2026-11.md](d1-storage-full-2026-11.md)).
Measured that day:

| | rows | payload bytes |
| --- | --- | --- |
| `match_archive` | 245,454 (138,460 distinct matches, 2,360 players) | ~7.7 GB (sampled mean 31.3 KB) |
| `rr_history` | 1,012,303 | 0.65 GB |
| `rr_match_features` | 207,535 | 0.16 GB |
| `sim_*` tables | | ~0.27 GB combined |

`match_archive` stored each match once per searched player who played it.
228,838 of the rows were from the current act, so pruning old acts would have
freed only about 0.5 GB.

## Layout

- R2 bucket `vlravg-match-archive`, bound to the Pages project as
  `MATCH_BUCKET`. Each match is one object at `matches/<match_id>.json.gz`,
  gzip JSON in the v4 match shape, shared by every player who has the match.
- D1 `match_archive` stays the per-player index: `(puuid, season_id, match_id,
  started_at)`. `payload` is now an empty blob (`X''`, the column is still
  `NOT NULL`). The new `bytes` column holds the object's compressed size,
  which the page budget uses
  ([migrations/0011_match_archive_r2.sql](../migrations/0011_match_archive_r2.sql)).
- Rows saved before the move still carry their payload inline. Every reader
  goes through `readArchivedPayload` ([lib/match-store.mjs](../lib/match-store.mjs)):
  it uses the inline payload when there is one, and otherwise reads R2.

## Writes

`saveMatchArchivePage` (functions/api/[[path]].js) writes the object first,
then the D1 index row, so an index row never points at a missing object.
Concurrent writers use R2 conditional puts: `If-None-Match: *` to create an
object, and `etagMatches` to update one. A writer that loses a race re-reads
the object and merges onto it. Merging only fills in missing Performance
Scores (`mergePerformance`) and never replaces stats or a real score, so a
newer update always wins, as the old D1 compare-and-swap did. When a visit
touches a row that still holds its payload inline, it moves that payload to
R2 and empties the D1 copy.

Without `MATCH_BUCKET`, nothing is archived. The archive is best-effort, and
writing payloads back into D1 would fill it up again.

The trusted-data rule is unchanged: objects are written only from
server-fetched HenrikDev responses or from D1 rows that were themselves
written that way.

## Migration

`POST /api/match-archive-migrate?after=&before=&limit=` (workflow key only)
handles one step at a time. It reads up to `limit` rows with
`after < rowid < before`, merges each inline payload into its R2 object (eight
at a time), then empties the D1 payloads in a single batch. Each update is a
compare-and-swap on the old payload, so a row that a visit changed in the
meantime is left alone. The `Move match archive to R2` workflow
([migrate-match-archive.mjs](../.github/scripts/migrate-match-archive.mjs))
splits the rowid space into ranges, runs them in parallel and retries failing
steps with backoff. It logs the D1 size before and after. Re-running it is
safe because moved rows are skipped.

Unknown until the migration runs: whether D1's reported size drops when
payloads are emptied, or whether the freed pages are only reused. The
workflow log records both sizes. The collector's headroom check
(`assertD1Headroom`) uses that reported size.

## Not migrated

- `scripts/export-rr-curve-corpus.mjs` reads `hex(payload)` straight from
  D1. Against moved rows it gets empty payloads and `gunzipSync` throws. It
  needs R2 access before it is next used.
- `.github/scripts/sim-pilot-fetch.mjs` `enqueueLive` also reads
  `hex(payload)`. Live collection is switched off (`site_flags`
  `sim_live_collect = off`), so it does not run now. Before switching it back
  on, it needs to read R2; otherwise it would mark moved matches as unusable.
