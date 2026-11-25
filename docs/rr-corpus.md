# Act-long RR corpus

The corpus is for selecting a better **per-account** win/loss payout curve by
starting rank after an act. Pooling payouts across accounts alone would blend
different hidden MMR states; large overall row counts are not sufficient.
Existing frontend estimates remain in place while evidence accumulates.

Opening a profile automatically enrols its permanent PUUID in `rr_players`
through the server's account lookup, including edge-cache hits. No ranked
games or successful RR lookup is required to enrol. Reopening a cached profile
does not change its recorded identity or count as ranked-game activity.

Fresh public `/api/mmr-history` and `/api/mmr-history-by-puuid` responses use
the same atomic collector as scheduled capture: they save raw payouts,
witnessed predecessors and the collection checkpoint before returning success
or populating the edge cache. The browser still receives all saved RR history.
Cached accumulated histories are never treated as fresh upstream windows;
their database neighbours do not prove match adjacency. If the save fails after
the upstream call, the fresh upstream window is still returned, unmerged, with
`Cache-Control: no-store` and no edge-cache entry, and nothing is reported as
collected. A 503 there only made the browser retry and spend more quota (see
[d1-storage-full-2026-11.md](d1-storage-full-2026-11.md)). Account enrolment
failures likewise no longer block a search. Local development without the
dashboard binding continues to show upstream data.

The existing collection job includes these visitor-discovered accounts under
the activity policy below and enriches saved payouts with trusted match details.

`Collect act RR corpus` runs continuously since 24 November 2026: each run is
a 330-minute scheduler that polls due accounts, heals gaps from HenrikDev's
stored RR history and fills match features, then starts the next run itself
(the hourly trigger is the backup). Polling intervals, gap detection and
healing, and the evidence for them are in
[rr-collector-gap-healing.md](rr-collector-gap-healing.md); it supersedes the
earlier 6/8/24/72-hour policy, the 180-minute runs and `shouldChainRun`.
Polling uses actual ranked-game dates, never the date someone searched an
account.

History: the 6/8/24/72-hour intervals came from production RR saved
2026-10-06 to 10-28 (3,206 players): no player reached 20 games within 8 hours
(most 15; 13 within 6 hours), 28 did within 12 hours and 151 within 24. They
replaced a 4/12/24-hour policy capped at 1,000 accounts per run, under which a
read-only check on 2026-10-28 found 38 proven gaps (each needing at least
11.6 hours without a poll; several spanned weeks after a player returned from
a break). In November the tracked pool grew to 23,392 accounts and those
intervals needed about 60,000 polls a day against the key's ~40,000, so polls
fell behind and games were lost again.

Accounts without a prior check get one assessment. Once a newly observed act
appears in saved RR, accounts last checked before its first observed game
receive one new assessment. Act detection uses saved season IDs
and game dates, with no hardcoded act or guessed release date. Fresh, unseen roster evidence
can wake a quiet account once, and its returned RR history determines the
new interval. Existing history is retained. Names are resolved when a profile is loaded; there is no daily name workflow or
automatic enrollment of the static pro library.

Up to 50 recent match rosters per collection run supply discovery evidence via
`rr_candidate_games`. Only trusted match payloads are accepted; duplicate match
fetches never count as extra games. Each run probes at most 40 new accounts from
those rosters, prioritizing observed game frequency within rank bands (three
tiers each) and giving thin bands more slots. A band's coverage is its number of
*frequent* tracked players. Once a band reaches 250, it draws no more probes.

The benchmark needs 20+ clean games per player, act and outcome, so frequent
players supply almost all samples. On 2026-10-28 the tracked pool was already
balanced by rank: 276 Iron, 345 Bronze, 316 Silver, 337 Gold, 666 Immortal,
303 Radiant. Frequent players were not: 59 Iron and 115 Bronze, against 259
Immortal and 214 Radiant. In e11a6, payouts per player ranged from about 15
(Iron) to 37 (Radiant), and 5-stacks or party penalties removed 10–20% of
featured Gold–Diamond rows. Only 29 Iron players had 20+ non-placement payouts
in one outcome, against 233 Immortal players.

The previous coverage measure counted every non-inactive player, so it spread
probes evenly instead of toward the missing frequent players. Supply is not
the limit: rosters from the previous seven days held 300–750 untracked players
per band from Iron to Diamond.

Growth is bounded. The deficit to 250 frequent players per band was about 860
players. At six-hour polling, that adds roughly 3,400 captures a day.

A first probe establishes the player's actual last-week
activity from their RR history; occasional players get fewer subsequent checks.
Trusted competitive placement rosters also admit players reported as Unrated (tier 0),
so the new-act reset does not silently exclude them from discovery.
Failed/unavailable candidate probes cool down for a day, and failures while
scouting do not mark successful tracked-account capture as failed.

Henrik's live window holds the ranked games among the player's last 20
matches of any mode. A poll whose window does not reach the newest saved
payout records an `rr_gaps` row in the same batch; the collector fills it from
stored RR history and verifies the rank chain
([rr-collector-gap-healing.md](rr-collector-gap-healing.md)). Payouts that
neither endpoint holds cannot be recovered; their gap stays `unresolved`.
Collection succeeds only after the D1 writes commit; storage failures produce
503s marked `storage: "unavailable"`. The collector does not retry those (the
upstream call was already spent), stops after 5 in a row, and refuses to start
when D1 is within 200 MB of its 10 GB size limit.

Apply `migrations/0005_rr_corpus.sql`, `migrations/0006_rr_activity.sql`,
`migrations/0010_rr_history_activity_indexes.sql` and
`migrations/0012_rr_gap_healing.sql` to the existing APP_DB before deploying.
No secrets or bindings are added. New tables:

- `rr_collection`: check time, last window and its oldest payout date
  (`window_from`) per account/platform; `possible_gaps` counts windows that
  did not reach the saved history.
- `rr_gaps`: those windows and rank discontinuities found by the daily scan,
  with their healing state (`open`, `incomplete`, `connected`, `healed`,
  `unresolved`). `rr_collector_state` records the last daily audit
  (`audit_at`), the last full gap scan (`gap_scan_full_at`), the marks the
  next changed-player scan starts from (`gap_scan_mark`) and the last census
  (`census_at`, weekly since 25 Nov 2026).
- `rr_predecessors`: consecutive match IDs witnessed together in real upstream
  responses. Database neighbors alone do not establish adjacency.
- `rr_match_features`: compact, trusted match context for every saved payout:
  outcome, act, rounds, starting-match tier, party size/penalty, performance,
  lobby tiers, patch, map, region and platform. Unknown fields remain unknown.
- `rr_feature_retry`: upstream "Match not found" responses are durable deferrals,
  with retries after 1, 3 and then 7 days. The endpoint respects cooldowns even
  when called directly. Deferred details retain their raw RR and are reported
  separately from unexpected request/storage errors.

The detail queue takes payouts of the last 3 days without features, newest
first, and only uses calls left after due polls and gap heals. Archived
matches are read from R2 without an upstream call; others are fetched by
match ID. Only already-saved RR match IDs are accepted. No browser-supplied
payout or feature data can enter the corpus. Expected upstream 404s become
durable retries; other detail errors are counted and retried later, never
fatal. Older payouts without features stay in D1; the census reports feature
coverage per act. Compact feature rows avoid storing a full kill feed for
every research sample. Payouts and feature evidence have no act-end expiry.
Placement payouts remain raw evidence, and witnessed RR predecessors never
cross act boundaries. A full 20-entry window is saved atomically in a fixed
number of statements, leaving room for quota queries under the D1 invocation
limit.

The default run budget is 330 minutes (10–345 for manual runs); five minutes
are reserved for the audit tail and the report, and the job timeout is 355
minutes. Work not done before the deadline stays in D1 for the next run.
Failed polls, heals and details never fail the workflow; only a configuration
error or D1 refusing writes does, and those runs do not chain.

The act/tier census parses every `rr_history` row. As one statement it read
~733k rows and took ~7.8 s on the 1 GB database (D1 query analytics,
3–4 November 2026), and D1 rejected it twice as overloaded (`7429`, "too many
resources consumed within a 10 second window"). Because a D1 database runs one
query at a time, it also stalled site and collector queries. The census now runs
in 16 PUUID-range slices with a 1 s pause between them and merges the results.
Every PUUID falls in exactly one slice, so distinct-player counts add up and
the merged result equals the single statement (tested). On 4 November one
slice read ~43k rows in 0.3–1.4 s, varying with concurrent collector load. The
total work is not reduced, only spread out; raise the slice count if single
slices approach the window again. Coverage reads retry a D1 overload after
15, 30 and 60 s.

Between 5 and 12 November 2026, 17 of 40 collector runs failed about 12 s
after starting, before polling, with the same `7429`. D1 query analytics put
the cause in the startup activity query (`loadActivity`). In the 20:19 UTC run
on 12 November it took 7.3 s and read 1.58M rows. In the 11:44 UTC run it took
10.6 s across two executions. Site queries in those windows totalled under
0.5 s. Its `latest_season` CTE (`ORDER BY date`) and `season_start` CTE (first
game of that act) each parsed every row's JSON, because `rr_history` was only
indexed by `(puuid, date)`. Measured alone, they took 3.3 s and 2.2 s.
`migrations/0010_rr_history_activity_indexes.sql` adds `rr_history(date)` and
an expression index on the query's exact season expression plus date. The
unchanged query then walks the date index and does a covering seek for the act
start, which a query-plan test pins. Startup reads also retry an overload after
15, 30 and 60 s, like coverage reads. Keep the season expression in
`rr-activity-query.mjs` identical to the index, or SQLite falls back to the
JSON scan.

On 23 November 2026 the end of every run still overloaded D1 for minutes, and
the site's archive, coverage and name-history routes returned 503 meanwhile.
The census now runs in 64 slices paced by D1's own reported time, the feature
inventory is sliced and paced the same way, and the health and startup queries
seek indexes instead of reading every row. Measurements and changes are in
[rr-collector-d1-load.md](rr-collector-d1-load.md).
The daily audit (census plus gap scan) now runs once per 24 hours beside
polling instead of at the end of every run, and the per-run health query was
replaced by counts the collector computes from the activity rows it already
reads. Reports identify the latest observed act, its date range, payouts and
placements.

With repository variable `RR_REPORT_EXPORT_ENABLED=true`, each run uploads
`rr-corpus-coverage`: payouts, unique players, detail coverage,
gains and losses by act/ending tier, plus overdue accounts and possible gaps.
Collection reports also count reported starting rank/RR, placement status and
bonus/penalty/forgiveness field coverage by act/tier and overall. Reported zeros
count as coverage; null, absent and incorrectly typed fields do not.
Artifact exports are disabled until explicitly authorized. Collection and
analysis still run, and the source evidence remains in D1.
Ending-tier buckets are collection diagnostics, not model coordinates. Check
these after rollout; increase detail capacity only if API and D1 budgets permit.
Growth in tracked accounts should be accompanied by a sweep-duration check.

Account regions can change after a transfer. When collection returns 404, the
workflow refreshes the account by its immutable PUUID and retries once if the
reported region changed. A successful collection persists the new region while
retaining all previously saved RR. Accounts still returning 404 are reported as
unavailable, rather than failed captures. The proxy's durable failed-probe
timestamp applies a one-day retry cooldown; newer roster evidence can wake an
account sooner. A successful collection supersedes the failed probe. Network,
quota, invalid-response and storage failures remain errors, not unavailable
accounts.

The local export script can be run manually at act end to create an
immutable gzip NDJSON file plus checksum manifest. It always reads fresh pages
using `(puuid,match_id)` cursors; it never reuses stale OFFSET caches. Player keys
are hashes of permanent PUUIDs. Name changes cannot split an account. Snapshot
reports last 90 days; raw D1 evidence remains. For local exports, set `CF_API_TOKEN`,
`CF_ACCOUNT_ID`, and `CF_D1_DATABASE_ID`, then run:

```powershell
node scripts/export-rr-corpus.mjs
python scripts/benchmark-rr-corpus.py .local/rr-corpus/snapshots/<timestamp>/corpus.ndjson.gz --act <act-short>
```

There is no scheduled snapshot workflow. Run the benchmark locally with
`--completed-acts` to evaluate every act superseded by a newer observed act.
Local exports retain the raw evidence for further research.
It does not guess future Riot
act-end dates. With insufficient clean samples it reports that limitation;
`ready_to_review` is not authorization to publish the curve automatically.

The benchmark prefers Henrik's reported `tier_before_update` and
`rr_before_update` as starting rank. These work without a witnessed predecessor
and take priority over an older or conflicting predecessor. If the complete
reported pair is unavailable, it falls back to the preceding **witnessed** game's
ending rank within the same act. It still audits the payout/refund/shield
coordinate equation and match-feature season. Immortal+ uses cumulative RR on
a continuous axis.

Primary model selection excludes reported placements, act transitions in the
fallback path, coordinate discrepancies, unknown party evidence, five-stacks,
party penalties, draws and reported nonzero performance bonuses, AFK/RR penalties
or new-map forgiveness. Legacy unknown adjustment fields remain eligible for
continuity; the primary result does not claim those matches had no adjustments.

Version 2 benchmark reports add `competitive_updates`: per-field coverage,
starting-value provenance, and separate ordinary-reported, unknown-adjustment,
bonus, AFK penalty, RR penalty, forgiveness, party/five-stack, shield and refund
cohorts. Ordinary-reported requires all four adjustment fields to be known zero
and no other listed adjustment context. Groups overlap, so their counts cannot
be summed. Each has per-outcome player-weighted raw payout averages and the same
temporal/player-separated model evaluation when enough samples exist. Cohort
comparisons are descriptive: players differ and no causal effect is implied.
All targets remain Riot's `last_change`; no adjustment is subtracted or added
again, and unspecified penalty units/overlap are not guessed. The local benchmark command runs this analysis;
no new upstream endpoint, database migration or quota budget is needed.

Candidate models are act mean, regularized linear, the nearby-30-RR
5-neighbor/prior-8 curve (the frontend's until 20 Nov 2026; it now uses prior 2; see
[rr-payout-model-2026-11-20.md](rr-payout-model-2026-11-20.md)), and Gaussian curves with two bandwidths. Stable player
hashes separate tuning and holdout accounts. Each player/act/outcome needs 20
clean samples; its earliest 70% trains the curve and later 30% tests it. Errors
give each player equal weight. Model selection uses tuning accounts only.
The report includes starting-tier/outcome sample counts and player counts.

At act end, review the selected model's holdout error against act mean and the
current curve, coverage across ranks, and performance across acts/platforms.
Thirty holdout players is only a review threshold, not proof of superiority.
Use player-level bootstrap intervals and inspect shield/refund/promotion and
missing-context sensitivity before a frontend change. This script deliberately
does not automatically publish a model or claim that sample size makes the
cohort representative of every Valorant player.
