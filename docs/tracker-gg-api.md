# tracker.gg's internal API

How tracker.gg's Valorant data was read for the KAST and ADR checks (`docs/adr-kast.md`,
23 Nov 2026). This is the API tracker's own pages load. It is not a documented public API:
`tracker.gg/developers` and its docs pages return 404, and nothing here is guaranteed to stay
the same.

## How to call it

Call it with `fetch` from a tracker.gg tab in a real browser (Claude in Chrome's
`javascript_tool`; the in-app browser also worked in earlier passes). The request then carries
the browser's tracker cookies and passes CORS and Cloudflare. The same request from other
places fails:

- from another site's tab (vlravg1.pages.dev): `TypeError: Failed to fetch` (CORS);
- from a server-side fetch of tracker.gg pages: HTTP 403.

Open any tracker.gg page first (for example the player's profile), then fetch from that tab.

## Endpoints

`<name>%23<tag>` is the Riot ID with `#` encoded (`Top1Gunz%23oren`). The act ID is the
`season=` value in a profile page's URL; V26 A6 is `d816f426-48ea-f052-117f-9697a155b319`.
Every stat is an object with a raw `value` and the shown `displayValue`.

### Act totals

```
https://api.tracker.gg/api/v2/valorant/standard/profile/riot/<name>%23<tag>/segments/season?playlist=competitive&seasonId=<act id>&source=web
```

`data[]` holds one segment per season; use the one whose `attributes.seasonId` is the act.
Fields used:

| Stat | Example (Top1Gunz, A6) | Notes |
| --- | --- | --- |
| `damagePerRound` | 146.04781533388294, shown "146.0" | stored unrounded, shown rounded straight to 1 decimal |
| `damage`, `roundsPlayed` | 1,240,092 and 8,491 | sums of the per-match values |
| `kAST` | 67.95, shown "68.0%" | stored to 2 decimals, shown to 1 from that |
| `matchesPlayed` | 397 | |
| `kasted` | null | |

This path wasn't seen in the profile page's own network traffic; it was tried directly.

### A player's match list

```
https://api.tracker.gg/api/v2/valorant/standard/matches/riot/<name>%23<tag>?type=competitive&season=<act id>&next=<n>
```

- 20 matches per page. Leave out `next` for the first page, then pass `data.metadata.next`;
  it is `null` after the last page.
- Each entry has `attributes.id` (the Riot match ID, the same as HenrikDev's) and
  `metadata.timestamp`.
- `segments[0].stats` holds that player's match stats, including `roundsPlayed`, `damage`,
  `damagePerRound`, `kAST` (whole percentage), `survived`, `traded` and `tradesAvenger`.
  `kasted` is null.

### One match

```
https://api.tracker.gg/api/v2/valorant/standard/matches/<match id>
```

The match page loads this. `data.segments` is a list of typed segments:

- `player-summary`, one per player, keyed by `attributes.platformUserIdentifier`
  (`name#tag`): `kast`, `attackKast`, `defenseKast` (whole percentages), `survived`, `traded`
  ("Trades Victim"), `tradesAvenger`, `damagePerRound` (2 decimals), `damage` and more.
  `tradesAvenger` is null for matches tracker processed before its trade change on 27 Oct 2026.
- `player-round`, one per player per round: `attributes.round`, `metadata.teamSide`
  (`attacker`/`defender`), round kills, deaths, assists and damage. There is no per-round KAST
  flag.
- `round-summary`, `player-round-damage`, `player-round-kills`, `player-loadout`,
  `team-summary`.

## Limits and working practice

- **Rate limit.** Requests were paced 2.5 to 4 s apart. After a burst, the API answers
  HTTP 429 with `{"errors":[{"code":"Warden::Challenge",...}]}` and pages show a "Human Check"
  captcha. Don't solve the captcha in an automated pass; it cleared by itself after a pause, or
  the user can solve it. Older passes saw "Network Error" on match pages for the same reason.
- **Long loops.** A `javascript_tool` call times out after about 45 s. Start long loops
  without awaiting them, store results on `window.__…`, and poll.
- **Output size.** `javascript_tool` output is cut off at about 1,000 to 1,600 characters, and
  text like `a=b;c=d` gets blocked. Return plain JSON arrays in small chunks, or compare inside
  the page and return only the differences.
- **Navigation clears state.** Page variables are lost when the tab navigates; finish a
  collection before opening another page.
- **Blind checks.** Score matches with vlravg's code and hash the predictions before reading
  tracker's values. To keep it blind, paste the predictions into the page and compare there, so
  tracker's numbers aren't printed first.
