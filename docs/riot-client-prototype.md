# Direct VALORANT client endpoint probe

This is an isolated experiment for a dedicated Riot account. It does not change
the site's current HenrikDev search flow. In local mode, the probe makes one
loopback token request and at most six remote, read-only GET requests. It prints HTTP
status, elapsed time, selected rate headers, and response shape counts, never
tokens, cookies, names, or raw match details. It never accesses the local Riot
client or game process.

Riot's terms address unauthorized programs that interact with its services, so
there is no guarantee that even a read-only request to an internal client
endpoint is safe for the authenticated account. Do not use a personal/main
account for this experiment. The script checks the authenticated Riot ID
against `RIOT_EXPECTED_RIOT_ID` before any player-data request and stops on a
mismatch. It does not attempt to bypass login, captcha, MFA, or rate limits.

Mullvad can replace the public IP visible to Riot, but it cannot erase device
identifiers, browser signals, cookies, or account links. A private browser
profile also does not make a device unrecognizable. If unlinkability from a
personal device is a requirement, do not sign in to the test account on that
device or run this probe there. No live test in this guide can guarantee that
Riot will not link an account or restrict it.

## Local Riot Client route (recommended for this experiment)

Use a separate physical Windows test host with Riot Client and Node.js installed.
Connect Mullvad there, if desired, before signing in to the dedicated test
account. Sign in through the normal Riot Client UI and leave it running. Start
VALORANT if needed for the lockfile to appear. This route uses the Riot Client's
localhost API for tokens; match data still comes from Riot's remote HTTPS
player-data service. It does not require a browser cookie or a password in the
script.

Riot says VALORANT/Vanguard does not support virtual machines. The launcher
alone might expose its local API in a VM, but that has not been verified here;
do not plan this route around a VM or try to conceal virtualization from
Vanguard. A normal Windows machine is the reliable starting point.

On that Windows host, open PowerShell in the repository checkout. First check
only whether the lockfile exists; **do not print or share its contents**:

```powershell
Test-Path (Join-Path $env:LOCALAPPDATA 'Riot Games\Riot Client\Config\lockfile')
```

When that returns `True`, run the bounded stages:

```powershell
$env:RIOT_AUTH_SOURCE = 'local'
$env:RIOT_EXPECTED_RIOT_ID = '<dedicated account name#tag>'
node scripts/probe-riot-client.mjs eu self --auth-only

# Only after identity verification succeeds:
$env:RIOT_CLIENT_VERSION = (Invoke-RestMethod -Uri 'https://valorant-api.com/v1/version').data.riotClientVersion
node scripts/probe-riot-client.mjs eu self --content-only
node scripts/probe-riot-client.mjs eu self

Remove-Item Env:RIOT_AUTH_SOURCE, Env:RIOT_EXPECTED_RIOT_ID, Env:RIOT_CLIENT_VERSION
```

Replace `eu` with the dedicated account's actual shard (`na`, `eu`, `ap`, `kr`,
or `pbe`). `--auth-only` verifies the client account before any player-data
request. `--content-only` then makes one content request. The final command
reads the test account's rank, recent competitive history, RR updates, and
one match detail. The script does not print tokens, cookies, or match details.
Share only the script's status/count output if you want help interpreting it.
If Competitive history returns 404, the probe makes one additional request
without a queue filter and reports whether other modes have history. This is
useful for a new test account with no Competitive matches.
In the first live test, an account with no completed matches returned 404 for
both filtered and unfiltered history, while local tokens, identity, content,
and MMR succeeded. That observation is consistent with empty history; it does
not verify the match-detail or RR endpoints.

In a second live test using the same local-client credentials and a consenting
EU player with completed Competitive matches, MMR, Competitive history,
competitive updates, and match details all returned HTTP 200. The history and
updates each returned 20 entries, with all 20 match IDs overlapping; one match
detail contained 10 players, 18 rounds, 135 kills, party IDs, and a season ID.
No rate-limit headers were reported. This verifies basic access and response
shape, not sustained request capacity or equivalence to Henrik's transformed
responses. The target PUUID is intentionally not stored in this document.

Do not run these steps on the main gaming PC if separating this account from
that device is a requirement. A previous sign-in on that PC cannot be undone
by moving the account to a VM. No setup can guarantee Riot will not associate
the account with a device or take action against it.

## Remote cookie route (alternative)

Use a dedicated VM or server with its own browser session and the separate
Riot test account. This alternative does not use the local Riot Client API, so
the host can run Windows or Linux. If using Mullvad,
connect it on that host before signing in and confirm the connection there.
Run the probe on the same host as that browser session; moving a session cookie
back to the main PC defeats the intended separation. An account previously
signed in on the main PC may already be associated with it, and moving the
account cannot undo that history.

The bare `https://auth.riotgames.com/` address returns 404; it is not a login
page. Start at [Riot account sign-in](https://account.riotgames.com/) instead.
If using Mullvad, first connect on the test host and confirm its IP status at
[Mullvad's connection check](https://mullvad.net/en/check). This
checks IP routing only and does not prove device unlinkability. If Riot's
normal account page fails to load, stop and diagnose that error before trying
the probe.

Use an `ssid` cookie from an interactive sign-in to the **separate test
account**, or the full Cookie request header from that sign-in. On a dedicated
test environment, use a separate browser profile so an existing
personal-account session cannot be selected by mistake. In browser developer
tools, find the `ssid` cookie under
`auth.riotgames.com`. Keep it in a process environment variable or secret
store, not in a repo file or chat message. The identity check below stops if
the cookie belongs to any other Riot ID.

On a Windows test host, from the repository checkout:

```powershell
$env:RIOT_EXPECTED_RIOT_ID = '<dedicated account name#tag>'
$env:RIOT_SSID = Read-Host -MaskInput 'Dedicated account ssid'
node scripts/probe-riot-client.mjs eu self --auth-only

# Only after identity verification succeeded:
$env:RIOT_CLIENT_VERSION = (Invoke-RestMethod -Uri 'https://valorant-api.com/v1/version').data.riotClientVersion
$targetPuuid = '<PUUID of consenting account>'
node scripts/probe-riot-client.mjs eu self --content-only
node scripts/probe-riot-client.mjs eu self
node scripts/probe-riot-client.mjs eu $targetPuuid

Remove-Item Env:RIOT_SSID
```

On a Linux test host, use the same stages with a hidden shell prompt:

```bash
export RIOT_EXPECTED_RIOT_ID='<dedicated account name#tag>'
read -r -s -p 'Dedicated account ssid: ' RIOT_SSID; printf '\n'
export RIOT_SSID
node scripts/probe-riot-client.mjs eu self --auth-only

# Only after identity verification succeeded:
export RIOT_CLIENT_VERSION='<current Valorant client version>'
node scripts/probe-riot-client.mjs eu self --content-only
node scripts/probe-riot-client.mjs eu self

unset RIOT_SSID
```

Choose the account's actual shard in place of `eu`. Close the shell after the
test so its environment no longer holds the session cookie.

Do not put a session cookie into a remote shell command, command-line
argument, GitHub issue, chat, or repository file. Enter it only at the masked
prompt on the test host. The first probe stage stops after verifying the
account identity. The second adds one content request; inspect their status
output before running the player-data stage.

`RIOT_AUTH_COOKIES` can replace `RIOT_SSID` when supplying the complete Cookie
header value. Alternatively, supply both `RIOT_ACCESS_TOKEN` and
`RIOT_ENTITLEMENTS_JWT` for a short-lived test. The version command above uses
the public, unauthenticated [Valorant-API version endpoint](https://valorant-api.com/v1/version);
you can instead set `RIOT_CLIENT_VERSION` from the installed client's
ShooterGame log. The first argument is the target's Riot shard (`na`, `eu`,
`ap`, `kr`, or `pbe`), not necessarily the
dedicated account's home region. A PUUID is needed because these endpoints do
not accept a Riot name and tag.

The script renews the access token from the saved cookie and obtains an
entitlement token. If renewal redirects to login, sign in interactively again
and replace the cookie. It does not automate username/password login, captcha,
or MFA. One documented observation is that `ssid` renewal lasts about a week
and full auth cookies about three weeks; neither is a durable server credential.

Run the stages in order. The first only renews credentials and verifies the
dedicated account's identity. The second reads public game content with the
client headers. The third reads that account's rank, history, RR updates, and
one match detail. Only then consider a consenting second account on the same
shard. The script does not perform a rate stress test: one run is insufficient
to establish safe sustained capacity. Repeat the minimal tests later from a
Cloudflare preview or staging environment to measure Cloudflare egress behavior.
If either cross-account access or Cloudflare egress fails, this dedicated
server-account architecture cannot power general player searches.

## Data mapping to vlravg

| Current need | Client endpoint | Remaining work |
| --- | --- | --- |
| Act list | `shared.{shard}/content-service/v3/content` | Map act IDs and active dates. |
| Current rank and RR | `pd.{shard}/mmr/v1/players/{puuid}` | Map competitive season tier and RankedRating. |
| Match list | `pd.{shard}/match-history/v1/history/{puuid}` | Paginate and cache match IDs. |
| Per-match RR | `pd.{shard}/mmr/v1/players/{puuid}/competitiveupdates` | Join by MatchID; verify rank shield and placement parity with Henrik records. |
| Full match | `pd.{shard}/match-details/v1/matches/{matchID}` | Translate Riot's raw schema into `processMatch()` input, including party, round, kill, and server fields. |

The client name service resolves **PUUID → name/tag**, not name/tag → PUUID.
The existing Henrik account route or another suitable lookup would still be
needed for the site's name#tag search. A direct endpoint migration also needs
live response samples to verify full stat parity; the documentation alone does
not establish rate capacity or long term stability.

Riot's published VALORANT developer policy requires player opt-in for apps
showing individual player stats. This must be resolved before making a public
site use a shared server account to retrieve arbitrary players' histories.

## Completed custom games

The unofficial client documentation describes queue filtering for match
history and marks custom matches in detail records with `matchInfo.provisioningFlowID` set
to `CustomGame`. This is separate from live custom lobby control. To check a
consenting player's completed customs, with the local-client environment
variables already set, run:

```powershell
node scripts/probe-riot-client.mjs eu '<consenting-player-puuid>' --custom-only
```

Use the player's actual shard. This mode makes one userinfo check, one custom
history request, and at most one detail request. It prints only counts and
custom-game flags, not match IDs, player names, or custom lobby names. A 404
does not prove custom games are unavailable: the player may have no eligible
custom history, or the lobby may have used `SkipMatchHistory`.

This probe does not discover custom games with **Hide from Match History**
enabled. [Riot added that setting](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-2-01/)
so custom results would stay out of player history. The unofficial API docs
repository contains a match-detail example named `custom-hidehistory`,
suggesting a detail record may exist when a match
ID is already known. That does not establish a way to enumerate hidden match
IDs or guarantee that a current hidden match can still be fetched by ID.

The target players' PUUIDs do not make the organizer's local game log useful:
that log only records matches played on that machine. The documented PD
match-history endpoint lists matches for a PUUID, but the hide setting is
intended to remove custom results from that list. MMR/competitive updates are
competitive data, and match-details requires an already known match ID. Riot's
official recent-matches-by-queue endpoint is not a documented way to list a
specific player's hidden customs. We found no verified retroactive PUUID-to-ID
route for hidden customs.

For a **future** organizer-approved match, the documented GLZ current-game
player endpoint may return the live match ID for one of the provided PUUIDs.
This is unverified with a different signed-in account, and it only works while
the target is in a game. Run one bounded read during that game:

```powershell
node scripts/probe-riot-client.mjs eu '<consenting-player-puuid>' --current-only
```

For NA shard accounts in LATAM or BR, set `RIOT_REGION` to `latam` or `br`.
The mode makes one userinfo request and one current-game request. A 200 prints
the returned match ID; a 404 means no current-game record was found and does
not prove the endpoint is self-only. Once the match ends, test that ID with a
separate bounded match-details read before relying on it for hidden customs.

In a live read-only test for a consenting EU player, `queue=custom` returned
10 matches. One fetched detail had `provisioningFlowID: "CustomGame"`,
`isCompleted: true`, 12 player records, and 23 rounds. The history's `QueueID`
and detail's `queueID` were both empty strings, and `customGameName` was empty.
Therefore use `provisioningFlowID` rather than the queue ID to identify a
custom match in detail data. The 12 player records should not be treated as
12 active players without checking observer flags. The target PUUID and match
ID are not saved here.

References: [client endpoint documentation](https://valapidocs.techchrism.me/endpoint/fetch-content),
[cookie renewal](https://valapidocs.techchrism.me/endpoint/cookie-reauth),
[name service](https://valapidocs.techchrism.me/endpoint/name-service),
[Riot VALORANT policy](https://developer.riotgames.com/docs/valorant),
[Riot terms](https://www.riotgames.com/en/terms-of-service),
[Riot privacy notice](https://www.riotgames.com/en/privacy-notice),
[Mullvad VPN limits](https://mullvad.net/en/vpn/what-is-vpn).
