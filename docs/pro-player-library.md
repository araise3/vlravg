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

## List design (22 Nov 2026)

Redesigned with shadcn parts on request; shared by the desktop popover and the
phone search sheet (`src/app/pro-library.jsx`). Until then each row was the
handle over its full PUUID in one alphabetical list.

- A region filter (ToggleGroup: All, Americas, EMEA, Pacific, China) with
  account counts for the current search. Five pros with no region show under
  All only.
- No search: players grouped under their team (teams A–Z, "No team listed"
  last), the team's region beside the heading, two columns where the popover
  is at least 520px wide. Each row is an Avatar initial, the handle, a
  Main/Alt badge for players with several accounts, and the country.
- A search matches handle, team or PUUID and lists results flat in match
  order, each with team and country. The PUUID is shown only when the search
  matched it rather than the handle; it is always in the row's accessible name.
- Desktop shows keyboard hints (arrows, Enter, Esc) under the list.
