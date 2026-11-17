# ML simulation pilot (research for ascend-companion-re)

Not part of the site. ascend-companion-re's lobby win predictor learns from the user's own
games (about 20 so far). The pilot tests whether archived matches can be turned into training
games by rebuilding every player's tracker-style current-act stats as they stood when the match
started, from the player's own earlier games.

- **Matches:** 2,000 competitive matches of act e11a6 (13 Oct to 12 Nov 2026) from
  `match_archive`, spread evenly over the act.
- **Players:** their 13,568 players, listed in D1 `sim_pilot_players` (puuid, region).
- **Histories:** `.github/workflows/sim-pilot-fetch.yml` fetches each player's e11a6 history
  through the site's own `/api/stored-matches/{region}/{puuid}?page=N` route: the public key
  behind the same atomic quota gate as live visitors, paced to 40 requests a minute (the key
  allows 60), up to 4 pages of 100. Each player row gets the HTTP status, the match count and a
  gzip+base64 list of compact matches (agent, team, K/D/A, score, damage, shots, rounds, tier;
  no names or tags). Runs log only counts, since the repository's Action logs are public.
- **Unattended runs:** the first night's second run died on one `ECONNRESET` from the D1 API,
  and GitHub dropped the hourly triggers for six hours. Now every D1 call and page request
  retries network errors, 5xx and 429; a player is saved only when every page came back (one
  had been stored with page 1 only), otherwise the row stays open and counts an attempt, closed
  with status 0 after 3; the script never throws. Each run starts the next one itself while
  players remain and it made progress (GitHub's job limit is 6 h); the hourly schedule is the
  backup. Two workers share one 40/min pacer; the site's quota gate (live visitors, the RR
  collector borrowing public slots) holds it nearer 20–25/min. `tests/sim-pilot-fetch.test.mjs`
  covers resets, 429s, failed pages, a dead D1 and the run budget.
- **KAST and ADR:** taken from `computeRoundStats` (docs/adr-kast.md) for matches in the
  archive, with tracker's older trade rule for matches before 27 Oct 2026 17:00 UTC, since
  tracker's act totals add up its stored per-match values. On 4 archive matches from September
  and October that gave 40 of 40 KAST rows equal to tracker's match pages.

## Gate: identical inputs before training

The user's rule (14 Nov 2026): the pilot trains only when every input the predictor uses is
present for every player of every match and built exactly as the live app gets it.
ascend-companion-re's `tools/ml_pilot/gate.mjs` checks this. A parity check rebuilt the user's
own stats at 8 live lobbies from HenrikDev data and matched all 85 values the app had stored
from tracker and Riot (games, K/D, ACS, ADR, KAST, HS%, games on the agent, tier, RR, last 12
results, last game start), with tracker's 2-decimal rounding. One lobby matched only after
modelling an app bug: it reused a player's tracker answer for an hour across lobbies when their
agent didn't change. The app now looks every lobby up fresh (fixed 14 Nov 2026 17:05 UTC), and
the simulation builds every player's stats as of the lobby itself, as the fixed app does. The
fetched data needs no change: it holds every game, and the cut-off is applied when the stats
are rebuilt.

That needs three more queues for the 1,000 matches (13–31 Oct) with the fewest downloads:

- `sim_pilot_rr` (7,255 players): `/api/stored-mmr-history/{region}/{puuid}?page=N`, a route
  added for this, fixed at 100 per page like stored-matches. Tier and RR after every game
  since 1 Aug 2026, for each player's rank as it stood before a match.
- `sim_pilot_prev` (4,478 players with fewer than 12 act games before a match): their last 20
  games before the act, for results and Ascend's Riot fallback (last 20 games of any act).
- `sim_pilot_kast` (62,872 matches): each earlier game's full match through
  `/api/match-detail`, reduced in the job to every player's KAST rounds and enemy damage with
  `computeRoundStats` from `index.html` at commit f2dd31f (the workflow pins it), older trade
  rule before 27 Oct 17:00 UTC. That code gives 40 of 40 on the tracker rows above. KAST can't
  be skipped: without it the predictor's leave-one-out log loss rose from 0.645 to 0.661.

The queues run in that order after the histories, about 80k requests (about 2.5 days at the
gate's 20–25/min).

## Live RR collector (15 Nov 2026)

The 1,000-match pilot can't pass the gate: HenrikDev's stored RR history skips stretches of games,
so only 32 matches had every player's rank from their previous game (35 with this site's own
`rr_history`), and stored match histories miss 3,593 act games that the RR history shows. Riot's
RR feed only returns a player's ~20 latest ranked games, so a past match's ranks are only
reachable while it is recent.

So each run of the workflow first queues the players of every competitive PC match that reached
`match_archive` and started within the last 36 hours (`enqueueLive`: walks the archive by rowid
from a cursor in `sim_live_state`, remembers each match in `sim_live_matches`), then fetches each
player's live window through `/api/mmr-history-by-puuid` before the other queues (`sim_live_rr`,
one row per player and match). The match's own entry carries `tier_before_update` and
`rr_before_update`: the rank Ascend's roster showed in that lobby. In `rr_history` those fields
equal the previous game's rank after it in 56,672 of 57,222 consecutive pairs; the rest have days
to weeks between them, i.e. games missing. A window that doesn't list the match yet is retried in
a later run (3 tries). About 10 requests a match; the archive gets 25–45 matches a day lately.
The route also merges each window into `rr_history`, as for any visitor.

Once all 10 windows of a collected match are saved, the next run's `enqueueLiveFollowups` queues
its players' act histories (`sim_live_players`, act = the match's season; a player fetched before
a newer collected match started is queued again). Saving a history queues the last 20 games before
the act (`sim_live_prev`) when one of their collected lobbies had fewer than 12 act games. KAST is
needed for every earlier act game that isn't archived or already done. The stored list has no
rounds, so the job walks the player's full-match list (`/api/history-by-puuid`, 10 competitive
matches with rounds and kills per request, newest first) until it has seen every wanted game or
passed the oldest one, and saves those games' KAST rows straight into `sim_pilot_kast`. Games the
list doesn't hold (it misses some stored games) or doesn't reach, and any page that fails, fall
back to the single-match queue (`/api/match-detail`). The act history itself still comes from the
stored list, since that is the record the parity check matched. About 90 earlier games then cost
roughly 9 requests instead of 90. On 17 Nov 2026, 6 matches from 3 players' first pages gave the
same KAST rows from the page as from `/api/match-detail` (identical players, rounds and kills).
A match whose window was closed after 3 tries is dropped (`followed = 0`) and costs no further
downloads.

The simulation and training run locally in ascend-companion-re. Once the pilot is evaluated,
delete the workflow and, if not needed, the `sim_pilot_*` tables.

## Maintenance mode (17 Nov 2026)

To give the pilot the public key's full 60 requests a minute, the site can be switched off
without a redeploy (`lib/site-flags.mjs`):

```sql
CREATE TABLE IF NOT EXISTS site_flags (name TEXT PRIMARY KEY, value TEXT, until INTEGER);
INSERT OR REPLACE INTO site_flags VALUES ('maintenance', '<random token>', <end in ms, or NULL>);
DELETE FROM site_flags WHERE name = 'maintenance';  -- back online (or wait for `until`)
```

While it is on, visitors' API requests get a 503 that the app shows as "offline for
maintenance", collector workflows keep their own key pool but don't borrow public slots, and
only requests with `X-Sim-Pilot: <token>` use the public key. Each pilot run reads the token
from D1 at start and then paces itself to 60 a minute with 4 workers. The proxy rereads the
switch every 15 s per isolate; a missing table or a storage error counts as off.
