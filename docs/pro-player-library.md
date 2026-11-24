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
- **Expected players (23 Nov 2026).** On request, every current player on any
  rostermania roster, partnered or not, counts as a pro the library expects.
  Non-partnered teams only count toward that expectation; their players still
  get no team. The index records `expectedPlayerCount` (389 on 23 Nov 2026),
  `expectedPartnerPlayerCount` (153), `expectedListedCount` (262: 112
  partnered, 150 non-partnered) and `expectedMissingCount` (127). The run lists
  the missing partnered and non-partnered players separately (41 and 86).
  Rostermania's spelling of the name replaces the handle when they match. The run
  lists partnered-roster players without a known PUUID; they cannot be opened, so
  they are not in the library (58 on 22 Nov 2026, 41 after the 23 Nov additions).
- **Manual additions (23 Nov 2026).** On request, partnered-roster players
  without a PUUID were looked for on tracker.gg's V26 Act VI ranked
  leaderboards (top 500 in EU, NA, AP, KR, BR and LATAM). Tracker lists Riot
  IDs, not PUUIDs, so candidates were matched by name, team tag and linked
  Twitter/Twitch, then resolved to PUUIDs through `/api/account`. Added:
  aspas (`aspas#naхy`), oroni (`BJK oroni#donk`), Kring (`MIBR kringv1#jska`),
  turkish (`MIBR turkishv1#MIRA`), raised (`raised 11z#chaos`), N4RRATE
  (`KC N4RRATE#otp`), SUYGETSU (`SUYGETSU#dsr6`), canezerra
  (`canezerra#0114`), Aace (`俺でキャリーでtv#aace`), Akame (`호랑수월가#0124`),
  Leviathan (`FS Leviathan#Bell`) and Splash (`TYLOO 안나#spl`); their 2026
  region is their team's. `Jamelinho213#FDB` became a second account of the
  existing "jamelinho", renamed Jamelinho213 to match Team Heretics' roster.
  These identifications are name-based, not confirmed by the players or
  their teams. The Riot IDs are recorded here only; the index stores PUUIDs.
  t3xture (`Be T3xture#GenGB`) was a candidate and was left out on request;
  the user then gave his account as `WelcometotheShow#1111` (GEN), added.
  The user also confirmed `LEV kiNgg#coni` as kiNgg (G2 in rostermania).
- **Teammate-checked additions (23 Nov 2026).** A rescan of tracker's top
  1,000 per region (6,000 accounts) was matched against the expected players
  still missing. For each name-matched candidate, tracker's Teammates panel
  (top five players by games together this act, on the profile's Matches
  page) was read. On request, the 48 candidates whose top five held a player
  from their own rostermania roster or a pro already in the library were
  added, plus 11 more rostermania players found in those panels: sh1ngo,
  Bishepss, Bruxo, Mited, zaj, Pa1nt, Smoke, alexis, Noia, Mystizip and
  Derrek. Handles, countries and regions come from rostermania (region = the
  team's). envex, sh0ut and sorex had been renamed (`PCF envex#1st`,
  `PCF sh0ut#huh`, `sorex#god`); their PUUIDs come from a match payload of the
  renamed account. Left out as unsupported by teammates: Xeppaa, Flora, Spaz,
  solution, Iceyyy and forbanz. Playing with known pros supports an
  identification but does not prove who owns an account. The user then
  confirmed Xeppaa (`NV xpa#XITER`) and Spaz (`M80 spaz#sae`), added, and
  that `NV pks#1738` is paincakes, already his main account.
- **OQ playoff rosters (23 Nov 2026).** The user confirmed Meteor
  (`QTD Meteor#1219`), TenTen (`TenTen#0813`), Cloudy (`ONG Cloudy#00000`)
  and wezzy (`BJK wezzy#133`, seen in influx's and Yigox's teammates); all
  added. Then, on request, every team in the VCT 2027 Kickoff "Qualifier
  Playoffs" events on vlr.gg (Europe, North America, Brazil, LATAM North,
  LATAM South, SEA: 50 teams) had its roster read from its vlr.gg team page
  (staff and inactive players left out; 505, EL LEGADO and MALAJUNTA list no
  roster there). 140 of those 240 players were not in the library. A tracker
  leaderboard scan (top 1,500 in EU, NA, BR and LATAM, top 1,000 in AP)
  name-matched 69 of them, and each candidate's tracker Teammates panel was
  read. Added: 39 whose top five held a player from their own vlr.gg roster,
  5 whose top five held only pros already in the library (nataNk, Kajuks,
  stunna, Weegle, Zoestol), and 11 found as Riot IDs in those panels (nayte,
  wtex, TakaS, Vince, Wolfen, Jow, drakk, Peloncito, RgLM, none, phc). Players
  rostermania lists keep its name, country and region; the rest take the
  vlr.gg alias and flag, and the region of their qualifier. Not added for
  lack of teammate support: adore, moner, Jesse, shawN, wackie, Dragon,
  solution, theory, Kyu, Winter, yearn, Nilo, aztex, nicksz, jotinha, ativik,
  Kimbo, Miyeon, coiZ, duby, KNZY, mabrik, Iceyyy and Laz.
  A second batch, chosen by the user from the same leaderboards, added cNed
  (`burger warrior#cNed`), Sheydos (`Sheydos#7777`), ticey (`DSY ticey#cream`),
  sunflower (`FMG sunfloweR#047`), Favian (`EF Favian#NEXUS`), Fit1nho
  (`FCB Fit1nho#ESP`), kamyk (`UCAM kamyk#pmiss`), reblyik
  (`MIR reblyik#55x55`), kiles (`kiles#734`), s0m (`NRG s0m#ktwon`), xccurate
  (`T1 xccurate#1802`) and SkRossi (`S8UL SkRossiエース#4646`). The user gave
  Karon's account (`Peter Parker#Karon`, GEN). Countries come from rostermania
  where it lists the player, otherwise from tracker's leaderboard; kiles and
  xccurate have none there and stay unknown. Regions are the leaderboard
  server's VCT region (s0m Americas; xccurate, SkRossi and Karon Pacific;
  the rest EMEA). Only Karon is on a partnered roster; the rest are listed
  under "Other players".
- **spikeziN (24 Nov 2026).** The user confirmed `articuno#ayra` as
  spikeziN. Its PUUID was already listed under the handle "spike", without a
  team, because rostermania spells him spikeziN. Renamed to spikeziN; the
  rebuild matched him to Leviatán's roster (113 partnered players listed;
  263 expected listed, 126 missing). The account's region is AP.
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

### Opening speed (24 Nov 2026)

Opening the list mounted all 416 rows at once (cmdk items on desktop, Items in
the phone sheet), so it appeared after a visible pause. Measured on the dev
machine from click to first frame: desktop ~150 ms in a production build
(~415 ms in dev), the phone sheet ~250 ms in dev. Slower devices take longer.
The first render now draws only the first `PRO_FIRST_ROWS` (48) rows, more than
either list shows without scrolling, and `useDeferredValue` renders the rest in
a background pass right after (`useProRowLimit`, `limitProGroups` in
`src/app/pro-library.jsx`). After the change: desktop ~27 ms in a production
build, the phone sheet ~50–70 ms in dev. Focus, the first-row selection and
the full row count are unchanged.
