# Pro player library

`pro-players.json` is the static search index used by the landing page. It is
generated from the sibling `vct-2026-data-analysis` repository:

```bash
node scripts/build-pro-player-library.mjs
```

Each player can have multiple known accounts. A resolved account includes its
permanent Riot PUUID, current Riot ID, and Tracker.gg URL. Accounts without a
PUUID remain available as Tracker/Riot-ID searches, but are not eligible for
automated backfill until the source project resolves them.

## Automated refresh and backfill

The existing **Refresh names and RR history** workflow runs daily at 05:17 UTC.
Its queue is the union of:

- accounts already stored in D1's `rr_players` table; and
- every resolved PUUID in `pro-players.json`.

The first `/api/name-history/{puuid}` request enrolls a new pro account in D1.
The same pass refreshes that account's rolling RR history by PUUID. After the
refresh job, the existing **Backfill all name histories** continuation scans
all unfinished D1 players, including the newly enrolled pros, until their live
and stored match indexes are complete.

Both jobs share the `refresh-rr-history` concurrency lock and the proxy's
server-side quota pacing, so adding the pro library does not create a competing
request stream or expose the HenrikDev API key.

To seed the pro library immediately after deployment, manually run **Refresh
names and RR history** with the default inputs. The continuation workflow starts
automatically afterward.

## Verification

```bash
node --test tests/pro-player-backfill.test.mjs tests/name-history.test.mjs tests/backfill-scheduler.test.mjs
```
