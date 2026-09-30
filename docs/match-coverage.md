# Durable match coverage

Match coverage is stored in `APP_DB`, separately for each player, act, region,
and platform. It has no expiry and survives new tabs and devices. Each search
still checks recent competitive matches and the compact stored index.

The proxy records trusted history and stored-index pages in a scan ledger.
Finishing a scan checks consecutive offsets, chronological order, the act
boundary (or an empty terminal page), and whether every required full match
exists in the archive. A previous verified scan permits stopping after two
known live pages. The browser must also finish reading all previously covered
matches before using that shortcut.

The finish request supplies only a scan ID. Browser counts, match payloads,
and completeness assertions cannot establish coverage. Concurrent valid scans
merge their verified IDs instead of overwriting one another. Missing archived
IDs invalidate coverage; failed or incomplete scans cannot create it.

The earlier tab cache and its five-minute lifetime have been removed. Only
abandoned scan ledgers are cleaned up after a day; this never expires verified
coverage or triggers a full rescan.

## Deployment

Apply the additive tables in `schema.sql` to the existing `APP_DB` before
deploying the frontend and Pages Function together:

```powershell
npx wrangler d1 execute vlravg-calib --remote --file=schema.sql
```

If the binding or migration is unavailable, ordinary fetching and archive
display still work; durable incremental refresh stays disabled.

## Validation

```powershell
node --test --test-isolation=none tests/match-coverage.test.mjs tests/fetch-efficiency.test.mjs tests/stored-history.test.mjs tests/region-transfer.test.mjs tests/name-backfill-ui.test.mjs
```
