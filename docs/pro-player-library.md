# Pro player library

`pro-players.json` is the static search index used by the landing page. It is
generated from the sibling `vct-2026-data-analysis` repository:

```bash
node scripts/build-pro-player-library.mjs
```

Each player has a pro handle and one or more permanent Riot PUUIDs. Generated
accounts contain no Riot IDs or Tracker links. Accounts without a valid PUUID
are omitted until the source project resolves them.

The pro list displays and searches pro handles and PUUIDs without account API
requests. Choosing an account or submitting an exact pro handle opens the profile
by PUUID; its account lookup resolves the current Riot ID. The act picker also
uses that PUUID when explicitly requested. The loaded profile retains its current
Riot ID and Tracker link.

There is no scheduled pro-name refresh or automatic library enrollment. Opening
a profile enrolls the account in D1, where the remaining `Collect act RR corpus`
workflow can capture its RR history under the usual activity policy. Historical
name scans remain available through the profile's Load older names button.
