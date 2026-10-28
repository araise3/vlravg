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
their database neighbours do not prove match adjacency. Storage failures with
APP_DB bound return 503 and are not cached. Local development without the
dashboard binding continues to show upstream data.

The existing collection job includes these visitor-discovered accounts under
the activity policy below and enriches saved payouts with trusted match details.

`Collect act RR corpus` is triggered hourly. The concurrency group keeps one
run queued behind the active one, so runs follow each other back to back; a
newer queued trigger replaces an older one and shows as cancelled. Each run
reads the activity index for every tracked account and captures every account
due under the activity policy before slower match-detail work. Four workers
share a FIFO client queue. The proxy atomically paces actual upstream calls;
a 429 pauses queued client requests too, preventing workers from repeatedly
racing for the same slot. Manual and scheduled collector runs share one workflow lock. No name refresh
or historical backfill workflows run alongside collection. GitHub scheduling is best-effort; hourly triggers make a dropped trigger cost minutes instead of hours.

Polling uses actual ranked-game dates, never the date someone searched an account.
Henrik keeps about 20 payouts, so every interval must end before a player can
finish 20 more games:

- Frequent: 10+ games in the last week and a game in the last 48 hours; every 6 hours.
- Active: any other ranked game in the last week; every 8 hours.
- Dormant: last ranked game 7–30 days ago; once a day.
- Inactive: last ranked game over 30 days ago, or no ranked game; every 3 days.

These bounds come from production RR saved 2026-10-06 to 10-28 (3,206 players).
No player reached 20 games within 8 hours (most: 15; within 6 hours: 13). Within
12 hours 28 players did, and within 24 hours 151. These are lower bounds,
because games lost in gaps are not counted.

The previous policy (4/12/24 hours, nothing for accounts quiet for a week, at
most 1,000 accounts per run, a four-hourly trigger) lost payouts. A read-only
check on 2026-10-28 found 38 proven gaps (one per player) where a payout's
reported starting rank/RR did not match the previous saved payout's ending
rank/RR and the two were never seen in the same 20-game window. Each needed at
least 11.6 hours (median 32.5) without a poll. From Oct 15, almost every run
logged `Polling 1000/<tracked>`, and GitHub started only 3–4 of the six daily
triggers. Several gaps spanned 2–6 weeks: players returned from a quiet week
and played a full window before roster evidence woke them. Detection needs the
reported starting fields, which were complete only from Oct 6, so earlier gaps
are undercounted.

Accounts without a prior check get one assessment. Once a newly observed act
appears in saved RR, accounts last checked before its first observed game
receive one new assessment. Act detection uses saved season IDs
and game dates, with no hardcoded act or guessed release date. Fresh, unseen roster evidence
can wake an inactive account once, and its returned RR history determines the
new interval. Existing history is retained. Names are resolved when a profile is loaded; there is no daily name workflow or
automatic enrollment of the static pro library.
There is no per-run account cap; the run deadline bounds capture. Due accounts
are ordered by how overdue they are relative to their interval, then by
frequency, so the most at-risk windows are fetched first. Optional scouting and
match details only run once every due account has been captured. With the
2026-10-28 pool (1,009 frequent, 1,333 active, 958 dormant, 234 inactive) this
is about 9,100 captures a day. At the measured ~4.2 s per capture, that is
about 10.6 hours of run time, leaving the rest of the day for details.
Growth in tracked accounts should be accompanied by a check of the
`Polling <due>/<tracked>` line and the report's overdue count.

Up to 50 recent match rosters per collection run supply discovery evidence via
`rr_candidate_games`. Only trusted match payloads are accepted; duplicate match
fetches never count as extra games. Each run probes at most 25 new accounts from
those rosters, prioritizing observed game frequency within rank bands and giving
thin bands more slots. A first probe establishes the player's actual last-week
activity from their RR history; occasional players get fewer subsequent checks.
Trusted competitive placement rosters also admit players reported as Unrated (tier 0),
so the new-act reset does not silently exclude them from discovery.
Failed/unavailable candidate probes cool down for a day, and failures while
scouting do not mark successful tracked-account capture as failed.

Henrik returns a rolling window of roughly 20 payouts. Expired unseen payouts
cannot be recovered from ordinary match history. The collector records the last
successful check, overlapping IDs and possible window gaps. An entire replaced
window is a warning, not a count of lost games; season changes can also cause it.
Collection succeeds only after the D1 writes commit; storage failures produce
503s and failed accounts make the workflow fail visibly.

Apply `migrations/0005_rr_corpus.sql` and `migrations/0006_rr_activity.sql` to
the existing APP_DB before deploying.
No secrets or bindings are added. New tables:

- `rr_collection`: check time and overlap health per account/platform.
- `rr_predecessors`: consecutive match IDs witnessed together in real upstream
  responses. Database neighbors alone do not establish adjacency.
- `rr_match_features`: compact, trusted match context for every saved payout:
  outcome, act, rounds, starting-match tier, party size/penalty, performance,
  lobby tiers, patch, map, region and platform. Unknown fields remain unknown.
- `rr_feature_retry`: upstream "Match not found" responses are durable deferrals,
  with retries after 1, 3 and then 7 days. The endpoint respects cooldowns even
  when called directly. Deferred details retain their raw RR and are reported
  separately from unexpected request/storage errors.

The detail queue joins saved RR to features, reuses existing gzip match archives
first, and otherwise fetches match-by-ID. It prioritizes newest evidence plus due retries of older unavailable matches, and
processes up to 1,500 missing rows per run. Missing older rows remain eligible
after the recent-game window; an act transition never discards their evidence. Only already-saved RR match IDs are
accepted. No browser-supplied payout or feature data can enter the corpus.
Expected upstream 404s do not fail a run; unexpected detail errors do. Transient
tracked-account capture failures get one final retry pass. If transient failures
or the run budget leave capture incomplete, optional scouting and enrichment
are skipped so capture has priority on the next run. Permanent account errors
remain visible without blocking enrichment for every other player. Retry
rows remain eligible after the seven-day recent-match cutoff, so the longer
backoff cannot silently strand an older payout without future enrichment.
Compact feature rows avoid storing a full kill feed for every research sample.
Payouts and feature evidence have no act-end expiry. Placement payouts remain
raw evidence, and witnessed RR predecessors never cross act boundaries. A full
20-entry window is saved atomically using five write statements, leaving room
for quota queries under the D1 invocation limit.

The default run budget is 180 minutes, configurable from 10 to 210 minutes for
manual runs. Five minutes are reserved for reporting; the job timeout is 220
minutes. The next queued run starts when this one ends. Work not attempted before the deadline
remains in D1 and is reported as deferred. Capture results are written before optional scouting, detail queries or aggregate
coverage queries, so later failures cannot erase the capture report. These
failures remain visible in the job outcome.
Reports identify the latest observed act, its date range, payouts and placements.

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

Candidate models are act mean, regularized linear, the current nearby-30-RR
5-neighbor/prior-8 curve, and Gaussian curves with two bandwidths. Stable player
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
