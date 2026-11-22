# Pro player library

`pro-players.json` is the static search index used by the landing page. It is
built from two sibling repositories:

```bash
node scripts/build-pro-player-library.mjs [vct-2026-data-analysis] [rostermania]
```

- **Accounts** (handles, PUUIDs, countries) come from `vct-2026-data-analysis`
  (`src/lib/trackerLinks.json`). That folder no longer exists there (22 Nov 2026),
  so the script falls back to the current `pro-players.json` as its account base.
- **Teams** come from `rostermania` (`data/rostermania.json`, the VCT 2027
  off-season tracker; on request, 22 Nov 2026). A pro gets a team, team code and
  region only when they are on a **partnered** team's current roster there
  (status stay, join or open; rumored moves count like announced ones and are
  not marked, on request). Everyone else has no team,
  keeps their 2026 region (`baseRegion`) and is listed under "Other players".
  Rostermania's spelling of the name replaces the handle when they match. The run
  lists partnered-roster players without a known PUUID; they cannot be opened, so
  they are not in the library (58 on 22 Nov 2026).
- Partner team logos are rostermania's team icons, shrunk to 48px in
  `assets/teams/<code>.png`.

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

- A region filter (Tabs: All, Americas, EMEA, Pacific, China) with
  account counts for the current search. Five pros with no region show under
  All only.
- No search: players grouped under their partnered team with its logo (teams
  A–Z, "Other players" last for everyone not on a partnered roster), the team's region beside the heading, two columns where the popover
  is at least 520px wide. Each row is an Avatar initial, the handle, a
  Main/Alt badge for players with several accounts, and the country.
- A search matches handle, team or PUUID and lists results flat in match
  order, each with team and country. The PUUID is shown only when the search
  matched it rather than the handle; it is always in the row's accessible name.
- Desktop shows keyboard hints (arrows, Enter, Esc) under the list.

### Region logos and colours (22 Nov 2026)

On request, each VCT region carries its league logo and colour
(`PRO_REGION_STYLE`; files and sources in `assets/regions/SOURCES.md`):
Americas `#ff570c`, EMEA `#d3ff1e`, Pacific `#01d2d7`, China `#fd2659`.
The region filter uses the site's Tabs (on request), like the other filters: a
sliding indicator marks the chosen region, whose label takes the league colour;
each tab shows its logo. It was first a ToggleGroup; a white chosen chip and a
coloured outline were tried there and dropped (the joined chips share borders,
so the outline showed open on the left). Team
headings show the region's logo and name in its colour, and each player's
avatar is tinted in their region's colour. Pros without a region keep a grey
avatar. On phones narrower than 380px the filter drops the logos to fit.
