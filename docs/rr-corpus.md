# Act-long RR corpus

The corpus is for selecting a better **per-account** win/loss payout curve by
starting rank after an act. Pooling payouts across accounts alone would blend
different hidden MMR states; large overall row counts are not sufficient.
Existing frontend estimates remain in place while evidence accumulates.

`Collect act RR corpus` runs every four hours, reads every `rr_players` account
with pagination, and captures RR before slower match-detail work. Four workers
share a 1.5-second request-start gate and pause together on proxy 429s. It shares
the workflow lock with the daily name refresh and historical backfill. Historical
backfill now yields after 30-minute runs and defers continuation when capture is
waiting. GitHub scheduling is best-effort; a four-hour schedule is not a guarantee.

Henrik returns a rolling window of roughly 20 payouts. Expired unseen payouts
cannot be recovered from ordinary match history. The collector records the last
successful check, overlapping IDs and possible window gaps. An entire replaced
window is a warning, not a count of lost games; season changes can also cause it.
Collection succeeds only after the D1 writes commit; storage failures produce
503s and failed accounts make the workflow fail visibly.

Apply `migrations/0005_rr_corpus.sql` to the existing APP_DB before deploying.
No secrets or bindings are added. New tables:

- `rr_collection`: check time and overlap health per account/platform.
- `rr_predecessors`: consecutive match IDs witnessed together in real upstream
  responses. Database neighbors alone do not establish adjacency.
- `rr_match_features`: compact, trusted match context for every saved payout:
  outcome, act, rounds, starting-match tier, party size/penalty, performance,
  lobby tiers, patch, map, region and platform. Unknown fields remain unknown.
- `rr_feature_retry`: unavailable match IDs get a day before their next attempt.

The detail queue joins saved RR to features, reuses existing gzip match archives
first, and otherwise fetches match-by-ID. It prioritizes newest evidence and
processes up to 1,500 missing rows per run. Only already-saved RR match IDs are
accepted. No browser-supplied payout or feature data can enter the corpus.
Compact feature rows avoid storing a full kill feed for every research sample.
Payouts and feature evidence have no act-end expiry.

With repository variable `RR_REPORT_EXPORT_ENABLED=true`, each run uploads
`rr-corpus-coverage`: payouts, unique players, detail coverage,
gains and losses by act/ending tier, plus overdue accounts and possible gaps.
Artifact exports are disabled until explicitly authorized. Collection and
analysis still run, and the source evidence remains in D1.
Ending-tier buckets are collection diagnostics, not model coordinates. Check
these after rollout; increase detail capacity only if API and D1 budgets permit.
Growth in tracked accounts should be accompanied by a sweep-duration check.

`Snapshot RR research corpus` exports weekly, or manually at act end, as an
immutable gzip NDJSON file plus checksum manifest. It always reads fresh pages
using `(puuid,match_id)` cursors; it never reuses stale OFFSET caches. Player keys
are hashes of permanent PUUIDs. Name changes cannot split an account. Snapshot
reports last 90 days; raw D1 evidence remains. For local exports, set `CF_API_TOKEN`,
`CF_ACCOUNT_ID`, and `CF_D1_DATABASE_ID`, then run:

```powershell
node scripts/export-rr-corpus.mjs
python scripts/benchmark-rr-corpus.py .local/rr-corpus/snapshots/<timestamp>/corpus.ndjson.gz --act <act-short>
```

The weekly workflow also benchmarks every act superseded by a newer observed
act and uploads only aggregate reports and the snapshot checksum manifest.
The raw snapshot is temporary on the runner and is not a GitHub artifact;
use the local export command to retain raw evidence for further research.
It does not guess future Riot
act-end dates. With insufficient clean samples it reports that limitation;
`ready_to_review` is not authorization to publish the curve automatically.

The clean benchmark uses the preceding **witnessed** game's ending rank as
starting rank and audits the payout/refund/shield coordinate equation. It
excludes act transitions, coordinate discrepancies, unknown party evidence,
five-stacks/penalties and draws from primary model selection, while retaining
all raw records for sensitivity checks. Immortal+ shares a continuous RR axis.

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
