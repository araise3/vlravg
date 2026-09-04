# Name history

The `/names` tab shows each observed Riot ID, its first and last observed dates
(UTC), and whether it is current. Name and tag changes both start a new period;
returning to an earlier ID starts another period. History belongs to the PUUID
and spans acts.

`Refresh names and RR history` runs daily at 05:17 UTC. It checks every player
in `rr_players` by PUUID, then refreshes their RR by PUUID. The schedule is
best-effort. A manual run accepts `max_players` for a small verification sample;
scheduled runs always process everyone. Existing Cloudflare secrets are reused.

Searches also check names, with a one-hour edge cache. Only fresh server-fetched
account responses record observations. Match data cannot overwrite names.
Dates are observation bounds: the exact rename time between checks is unknown,
and names from before tracking cannot be reconstructed.

## Database setup

New databases use `schema.sql`. For an existing database, apply the additive,
idempotent migration before deploying the new API:

```sh
npx wrangler d1 execute <database-name> --remote --file migrations/0001_name_history.sql
```

The migration preserves each player's last stored name and observation date as
the initial period. It does not infer earlier dates from their match history.

## Verification

With Node.js 24:

```sh
node --test tests/name-history.test.mjs
```

Tests cover renames, tag changes, name reuse, stale responses, migration replay,
refresh failures, rate-limit retries, and proxy persistence/cache behavior.
