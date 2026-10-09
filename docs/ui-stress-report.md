# vlravg UI stress test — 10 October 2026

The existing frontend was tested with API-shaped synthetic matches passed through `processMatch()` and the production renderers. The initial audit made no production changes; all five findings below were subsequently fixed at the user's request. The fixture injector is used only by `scripts/serve-ui-stress.py`, which binds to localhost and disables live account API requests.

Preview: http://127.0.0.1:8767/stress-test?data=worst&page=matches&width=320&zoom=1

## What broke

| # | Severity | Field | Worst-case value | What happens | Proposed fix |
| --- | --- | --- | --- | --- | --- |
| 1 | Broken | Expanded roster identity | `WWWWWWWWWWWWWWWW#WWWWW`, at a 320px viewport | Every player name has a measured width of **0px**. The nonshrinking tag overflows its 23px identity column into ACS. This also affects short names. | Give identity its own row on narrow screens and arrange the four statistics below it, or make the whole roster horizontally scrollable with a minimum identity width. `index.html:400`, `index.html:404`, `index.html:410`, `index.html:6015`. |
| 2 | Broken | Win rate | 15 wins, 9 losses, 6 draws | Overview shows **63%** (15/24), but Match History shows **50%** (15/30), both labeled “Win rate.” Party and teammate breakdowns also include draws in their denominator. | Standardize the denominator and label across views. Recommended: wins / (wins + losses), with an em dash for all-draw sets, matching Overview’s explicit definition. `index.html:6080`, `index.html:6085`, `index.html:4829`, `index.html:5891`; Overview reference `index.html:4778`. |
| 3 | Ugly | Performance DNA axis and game labels | 20 recent games, at 320px | Overview scales a 1000-unit SVG into **215px** of content width while allowing independent X/Y scaling. Its 10px labels become horizontally compressed to 21.5% and are unreadable. The detail chart has a scrollable minimum width already. | Make the overview chart responsive with fewer ticks and stable text sizes, or use the same minimum-width horizontal scroll strategy as the detail chart. `index.html:6312`, `index.html:6317`, `index.html:815`. |
| 4 | Ugly | Overview teammate identity | `KonstantinWWWWW#WWWWW` | The link is **58px** wide for **184px** of text at 320px. It displays roughly “Konstan…” and hides the tag entirely, while K/D and match count take the rest of the row. It has no full-ID tooltip. Other teammates have the same issue. | Put identity above the two numeric values on mobile so the full ID gets the available width; retain tag visibility and expose the complete identity. `index.html:484`, `index.html:495`, `index.html:4795`. |
| 5 | Fragile | Missing roster name/tag | A partial player object with both fields absent | The renderer produces a lone `#` with no usable identity. The numeric columns still render. | Display “Unknown player” or “Identity unavailable”; add `#tag` only when the tag exists. Keep the row unlinked when identity is absent. `index.html:6011`. |

Evidence: `artifacts/ui-stress/roster-mobile.png`, `artifacts/ui-stress/worst-320-overview-full.png`, and the full comparison screenshots and JSON measurements in `artifacts/ui-stress/`.

## Chosen fixes

- **Roster on mobile:** recommend a two-row layout per player. This keeps identity and all four statistics visible without requiring horizontal navigation.
- **Win-rate semantics:** recommend excluding draws everywhere. If a view intentionally counts draws as nonwins, name that value “Wins / all matches” so it cannot be confused with Overview.
- **Overview identity:** recommend wrapping the row into identity plus statistics; a desktop hover tooltip alone does not solve mobile identification.
- **Overview chart:** recommend a compact responsive chart with fewer labels. Horizontal scrolling is a simpler consistent alternative, since the detail chart already uses it.

## What held up

- No document-level horizontal overflow in the 42 demo/worst-case result-view checks: seven views × 320/1180/2560px × two datasets. Browser scrollbar space makes the measured layout widths 305/1165/2545px.
- Both datasets also stayed within the viewport in all seven views under the preview’s 200% CSS zoom simulation (1180px physical preview, about 582px layout width). This is a zoom simulation, not an OS text-size or native browser-zoom test.
- The 15-match page boundary works: 15 hides Load More; 16 renders 15 then one more; 1,000 renders 15 then 30 after one click. The initial parse/render for 1,000 fixtures took about 562ms on this machine; this is not a broader performance benchmark.
- Empty, one-match, loading, and error UI states render in all seven views. The loading/error fixtures exercise presentation directly, not real networking, retries, or quota behavior.
- Missing ACS/PS/RR and unranked lobbies show appropriate unavailable values. Zero kills/deaths do not produce Infinity or NaN. Positive, negative, zero and shielded RR values render; long overtime scores and durations fit the match card.
- Solo, duo, trio, and full-stack fixtures render their party filters and tables. Match MVP, Team MVP, and no-award outcomes appear through the real parser.
- Name-history identities wrap, its table has horizontal scrolling with a sticky identity column, and the full-ID tooltip already exists in the detailed duo table. The overview lacks that tooltip.
- Rank icons keep their aspect ratio; the optional map-art path has a usable no-metadata fallback. An actual remote-image 404 or slow image load was not tested.
- Unicode names, accented text and Arabic identifiers render. The app has no RTL layout setting, so a whole-page RTL mode was not imposed. Its shipped dark theme was used throughout.

## Separate malformed-payload observation

The `malformed` state includes a null `first_seen` value and encoding/short-name probes outside the ordinary Riot-ID constraints. A null date displays **1 Jan 1970** because `new Date(null)` is valid (`index.html:1684`). The database schema requires non-null dates and the observation writer validates timestamps (`migrations/0001_name_history.sql:7`, `lib/name-history.mjs:8`), so this is **not counted as a normal production defect**. A defensive null check would still make the renderer more robust to a malformed response. Text such as `A&B <3` and an emoji sequence is a robustness probe, not an assertion that Riot accepts those IDs.

## Surface map

Riot documents game names as 3–16 characters and tags as 3–5. Source: [Riot Developer Support](https://support-developer.riotgames.com/hc/en-us/articles/22698983117587-Summoner-Name-to-Riot-ID). The primary worst-case identity uses the documented maximum lengths. The frontend’s search parser itself does not impose either length limit.

| Rendered fields | Source / renderer | Type and bounds | Missing/optional behavior exercised |
| --- | --- | --- | --- |
| Search identity, player links, roster/duo/history names and tags | `PLAYER`, `TAG`, player `name`/`tag`; `parseSearchInput`, `buildPlayersGrid`, `renderTeammates`, `renderOverviewPreviews`, `renderNameHistory` | Strings; upstream 3–16 / 3–5; frontend search unbounded. PUUID is a UUID identifier. | Missing roster fields; 3-character, maximum-width, accented, CJK and Arabic names. Out-of-contract encoding probes in `malformed`. |
| Rank icon/name/RR, region badge, average/team/enemy lobby rank | Player `tier`, current rank and pre/post RR maps; `finalizeHeader`, `setRankValue`, rank tables | Tier IDs 0–27; fixed rank/region labels; RR numeric, no frontend hard maximum | Rated versus unranked, Radiant/Immortal labels, four-digit RR, optional rank/RR absent. |
| Act label/count and selection | `TARGET_SEASON`, season option metadata | Canonical upstream act label, UUID, numeric game count; count unbounded locally | Synthetic act/count; 0/1/15/16/30/1,000. Live act fetching and historical season filtering are outside this fixture test. |
| K/D/A, ACS, PS, ADR, headshot-derived metrics | `player.stats`, `performance.score`; `extractStats`, stat and rank tables | Finite numbers; no explicit frontend upper bounds; rounded/weighted values | 0 kills/deaths, 72-kill overtime match, absent stats/PS, large totals in the 1,000-match fixture. |
| Games/wins/losses/draws, rates and RR-eligible coverage | Parsed `won`, statistics aggregations and RR eligibility | Counts 0…collection length; percentages 0–100; scope varies per renderer | Draws mixed with wins/losses, solo/duo/trio/full-stack eligibility, absent RR coverage. |
| RR change/net/refund/shield, rank coordinates, payout groups | RR maps and processed match fields; RR card, trends and tables | Signed numbers, nullable, finite; shield boolean | +35, −30, 0, null and shielded loss. Refunds and fitted-model accuracy were not tested. |
| Map/server labels, scoreline, result, award, start date/time, duration, day totals | Raw metadata/teams and parsed match; `buildMatchCard`, day headers | Fixed map/server labels, numeric rounds/duration, ISO timestamps, result enum; MVP enum | Real map/server labels, 26–24 and 14–14, 105 minutes, local-day rollover, partial stats, all award outcomes. |
| Roster rank/ACS/PS/KD and party highlighting | Parsed `players`, ACS sorting and party IDs | Up to 10 ordinary competitive participants; fixed statistical columns | Both teams and all 10 rows, long tags and names, missing identity, unavailable PS and unranked ranks. |
| Party-size/lobby/server tables, teammate counts/totals, encounters and last-seen dates | Parsed party/rank/server/player data; `buildTeammates`, `renderEncounters`, `renderServers` | Party size 1–5, canonical rank/server labels; aggregate counts/numbers unbounded locally | Mixed party sizes, repeated participants, wide numeric totals, date display, table scrolling and sorting headers. |
| Wintrading signal rows and explanatory copy | `renderWintradeSignals` and repeated-opponent statistics | Heuristic numeric score and row collection | Empty-signal state rendered. A positive suspicious-player fixture was not created; no accuracy claim for the heuristic. |
| Playtime, RR trend, DNA chart, score-margin labels/points/coverage | Aggregate numbers from processed matches; chart renderers | SVG/DOM numeric labels, collection-dependent points/bins; no extra user-supplied strings | Large history, 20-game overview cap, optional score gaps, overtime/draw margins; chart geometry. |
| Name periods, current badge, dates/act range, scan status/count/action | Name-history rows and backfill presentation | String/ISO timestamps; non-null server dates; nullable `ended_at`; counts locally unbounded | Several periods, current period, valid dates, empty history; null timestamp only in malformed state. Live backfill/retry actions were not exercised. |
| Loading, no-results, error messages; static navigation/button labels | `analysisState`, `setStatus`, `updateDetailPages` | State enum and fixed English copy; upstream error string has no frontend size bound | 0/1 matches and all view-state presentations. Translated labels, quotas, permissions and live service failures were not simulated. |
| Clutch outcome counts and ratios | Raw kill feed and round reconstruction | 1v1…1v5, win/loss/save counts and percentages | No-clutch/no-kill-feed presentation only. The empirical detection boundaries were not changed or validated. |
| Rank/map art and static logos | Embedded rank URIs, optional public map metadata, static assets | Fixed-size raster/vector assets; URLs optional | Rank assets present, no map metadata. Image latency/404/panorama tests and the pro-player dropdown are outside the tested surface. |

## Reproduce

```powershell
python scripts/serve-ui-stress.py
```

Open the preview link above. Bottom-center controls offer **Demo data / Worst case / empty / one / 15 / 16 / 1000 / loading / error / malformed**, all seven result views, 320/1180/2560px widths, and 100%/200% scale. Selected controls persist in the URL. Expand the first match to reproduce finding 1.

Only the localhost server injects the fixture script into a served copy of `index.html`. The production file has no references to any of these scripts. Python and JavaScript syntax checks passed; no automated production test suite was added.

## Fix verification

All five findings are fixed in `index.html`:

1. At widths up to 600px, roster identity gets a full-width row, followed by four statistic columns. At 320px, player names retain visible width and no roster row overflows.
2. Match History, party/lobby breakdowns and teammate win rates now divide wins by wins plus losses, matching Overview. Draws still count toward games. The mixed fixture shows 63% in both summaries; all-draw groups display an em dash without a negative color or maximum highlight.
3. The overview DNA chart renders against its actual container width and rerenders on resize, with fewer game ticks and stable label sizes. The 320px fixture uses a 215-unit viewBox at 215px, rather than compressing 1000 units into that width.
4. Mobile overview teammates show identity above the numeric values, preserve the tag, wrap as needed, and expose the full ID in a tooltip.
5. Missing roster names display "Unknown player"; tags are included only when present and incomplete identities remain unlinked.

Validation: 15 relevant Node tests pass, including a new mixed/draw-only regression. Inline-script and fixture syntax checks and whitespace checks pass. All seven worst-case result pages fit 320/1180/2560px viewports (21 checks); the overview also fits the original 1180px/200% zoom simulation. At 320px/200% (about 152 layout pixels), existing minimum-size content still overflows; that extreme combination is outside the original audit's zoom checks. Demo, empty, one-match, loading and error overview states render. Pagination expands 15 to all 30 matches and removes Load More. No browser console warnings or errors were captured during the result-view checks. These checks use synthetic local data, not live API traffic.

Post-fix screenshots and measurements: `artifacts/ui-stress/fixed/roster-mobile.png`, `artifacts/ui-stress/fixed/overview-mobile-full.png`, `artifacts/ui-stress/fixed/geometry.json`, and `artifacts/ui-stress/fixed/states.json`. The `draws` fixture is available in the preview controls for regression checking.
