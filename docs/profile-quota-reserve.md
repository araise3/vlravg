# Profile lookups keep a slice of the public quota

24 Nov 2026. `lib/upstream-pacing.mjs`, `functions/api/[[path]].js`.

## Why

A player whose matches are saved needs exactly one upstream call to open:
the account lookup that turns a Riot ID (or PUUID) into the account. The
saved matches, counts and coverage come from D1/R2 and never touch the
quota, and they render while rank and the live scan are still waiting. When
a busy minute had spent the public key's window, that one lookup queued
behind everything else, so a fully cached profile showed nothing until the
window reset.

## What changed

- Other public calls (rank, RR history, live history, stored matches, match
  details, name history, teammate names on the public key) stop when the
  known window has `PUBLIC_PROFILE_RESERVE` (6) calls left. With the 60/min
  public key that is ten percent.
- Account lookups for a search (`/account/{name}/{tag}` and
  `/account-by-puuid/{puuid}`, the routes with `trackAccount`) may spend
  those last six. Teammate-name lookups (`X-Name-Lookup: teammate`) are
  excluded; with the workflow key configured they use its pool anyway.
- A call held back by a reserve (this one or the workflow's borrowing
  reserve) is now told to return at the window's reset in one answer,
  instead of the gate re-polling D1 every 50 ms for up to 8 s and then
  sending a short `retryAfterMs`.
- Unchanged: an unknown window (no headers seen yet, or a fresh window)
  enforces no reserve, so the first call can learn the quota. Spacing is the
  same shared schedule for every caller, and a real upstream 429 still
  stops account lookups too. Edge-cache hits never reach the gate, and name
  lookups are cached for a day (by Riot ID) or five minutes (by PUUID).

What it does not do: it adds no quota. Searches that need upstream data
(rank, new matches) still wait for the next window, and a flood of account
lookups can still spend the reserve itself.

## Tests

- `tests/upstream-pacing.test.mjs`: other public calls stop at the reserve
  and are told to come back at the reset; account lookups spend it down to
  zero; a new window opens to everyone; an unknown window enforces no
  reserve.
- `tests/workflow-api-key.test.mjs`: with the window at the reserve, `rank`
  and a teammate-name lookup get 429 while `/account/Alpha/EU` reaches
  upstream on the public key.

Not verified against production traffic: the local proxy cannot reproduce a
spent shared window with real searches.

## Follow-up, 24 Nov 2026: saved account answers and a public quota audit

`lib/saved-account.mjs`, `lib/public-quota-audit.mjs`, migration
`0013_saved_account_quota_audit.sql`.

### Why the reserve was not enough

A search for a saved profile still stalled on its account lookup with
"Rate limit reached — waiting 43s", so the profile header (tracker link,
region) never appeared. The reserve only limits what the gate admits. The
stored count can still reach zero three ways:

- HenrikDev's headers lower it: every response sets
  `remaining = MIN(our count, header)`, so calls the gate never saw (the same
  key used elsewhere, or HenrikDev counting differently) skip the reserve.
- A real upstream 429 sets it to 0 and holds every caller until the reset.
- Account lookups may spend the reserve themselves, down to 0.

Which of these happened in production is unknown: the public pool kept no
record. That is what the audit below is for.

### Saved account answers

When a search's account lookup (`/account/{name}/{tag}` or
`/account-by-puuid/{puuid}`, not teammate names) is refused by the gate or
gets a 429 from HenrikDev, the proxy answers from D1 instead:

- the identity is the account's current row in `player_name_history`
  (`ended_at IS NULL`), which only server-fetched HenrikDev account responses
  write; the region comes from `rr_players`;
- a Riot ID matches case-insensitively (SQLite `lower()`, ASCII only; other
  case differences miss and get the 429 as before), through the new partial
  index `player_name_history_current_riot_id`;
- it is served only when exactly one account currently claims the Riot ID,
  the identity was observed in the last 30 days (`SAVED_ACCOUNT_MAX_AGE_MS`),
  and a region is saved. Otherwise the client gets the 429, as before;
- the response has the client's usual `{data:{puuid,name,tag,region}}`
  shape plus `vlravg_source: "saved-account"` and `observed_at`, header
  `X-Account-Source: saved`, `Cache-Control: no-store`, and is never put in
  the edge cache. It does not enrol the account (no fresh response).

So a saved profile opens with no upstream call: header, saved matches,
counts and coverage. Rank and new matches still wait for the reset.

Risk kept narrow, not removed: within 30 days, a Riot ID that was renamed
away and taken by another account, without either change reaching D1, would
open the old owner until a live lookup succeeds. The 30-day limit is a
judgment call, not measured.

### Public quota audit

Table `public_quota_audit` (14 days, pruned on write, no player identity):

| event | written when |
| --- | --- |
| `upstream-429` | HenrikDev refused a public-pool call the gate admitted |
| `low-window` | a public response's header shows `PUBLIC_PROFILE_RESERVE` (6) or fewer left |
| `profile-refused` | a search's account lookup could not reach upstream; `served_saved` says whether D1 answered |

Each row keeps the route's first path segment (`borrowed:` prefix for
collector loans), `gate_remaining` (our count after admitting the call, or
the stored count for refusals), `header_remaining`, `reset_in_ms` and
`retry_after_ms`. Reading it:

- `header_remaining` well below `gate_remaining`: something outside the gate
  spent the key, or HenrikDev counts differently. A difference of one or two
  can be our own concurrent calls arriving out of order.
- `low-window`/`profile-refused` rows on `account` driving the count to 0:
  account lookups spent the reserve.

```bash
npx wrangler d1 execute vlravg-calib --remote --command "SELECT * FROM public_quota_audit ORDER BY id DESC LIMIT 50"
```

Apply migration 0013 before deploying (the audit table is also created
lazily; the index is not).

### Tests

`tests/workflow-api-key.test.mjs`: a spent window serves a saved account by
Riot ID (case-insensitive) and by PUUID, uncached; unknown, renamed-away,
40-day-old, region-less and doubly-claimed identities still get the 429;
teammate names and other routes never get the fallback; a real upstream 429
falls back and writes `upstream-429` and `profile-refused`; responses inside
the reserve write `low-window` with both counts, others write nothing.

Not verified against production traffic.

## Live drain test and slot priority, 24 Nov 2026

### What the drain showed

16 parallel uncached `mmr-history-by-puuid` calls ran against the live site
for 150 s, with account lookups probed every 4 s. Results from
`public_quota_audit`:

- The reserve held: non-account calls stopped at our count 7 (header 6);
  only account lookups took both windows down to 0.
- HenrikDev's header matched our count within one throughout. No upstream
  429. Our own traffic reached 0 only about 7 s before a reset, so a long
  wait like the original 43 s points to a real upstream 429 or an early zero
  in the headers (inference; the audit will now record either).
- Seven account lookups were answered from saved identities, two of them
  with our count at 0.
- Most refused account lookups had 13 to 41 calls left, with 1 to 3 s retry
  waits: every waiting request polls for the next slot, and with 16 pollers
  an account lookup could lose every round for the gate's 8 s wait. The
  reserve kept quota for them but gave them no turn.

### Slot priority

`lib/upstream-pacing.mjs`, migration `0014_quota_priority_claim.sql`
(`rate_quota.priority_until`; the gate also adds it lazily).

- A search account lookup that has to wait for a slot claims it: it sets
  `priority_until` to that slot plus `PRIORITY_CLAIM_MARGIN_MS` (500 ms),
  keeping a longer claim made by another lookup.
- Other public calls and collector loans take no slot while a claim is live,
  and wait until it lapses or is cleared. Account lookups ignore claims.
- The lookup's admission clears the claim, so the following slot is open to
  everyone. A claim left by a lookup that gave up lapses on its own, holding
  other calls back at most the margin.
- A lookup that would wait beyond its 8 s, or that an empty window refuses,
  makes no claim. The workflow pool has no claims.

Priority decides the order of waiting calls only; it adds no quota. Several
account lookups at once still share the slots among themselves, and
non-account calls lose at most one slot plus the margin per waiting lookup.

Tests (`tests/upstream-pacing.test.mjs`): a waiting lookup claims its slot,
public calls and collector loans stand back at it, admission clears the
claim and the next slot is open; a left-behind claim lapses; a lookup that
will not wait, or an empty window, leaves no claim; five-column public tables
gain the column and the workflow table does not.

Not yet verified on the live site.

## Reset guard, 24 Nov 2026

A third live drain (90 s, 21:03 UTC) had no 503s but reproduced the original
long wait:

| UTC | event | our count | HenrikDev header |
| --- | --- | --- | --- |
| 21:04:04.829 | account lookup spends the last call | 0 | 0, reset in 973 ms |
| 21:04:05.960 | first call after our computed reset (`mmr-history-by-puuid`) | unknown (window treated as fresh) | 429, 0 left, reset 59.9 s, `Retry-After: 60` |

The call went out 0.16 s after the stated reset. HenrikDev refused it and
asked for 60 s, and a real 429 stops every caller in the pool until then, so
searches waited up to a minute; saved accounts still opened from D1.

Inference, not confirmed: HenrikDev states the reset in whole seconds, so
"973 ms" can mean up to about a second more, and our call reached it just
before its window reset. Why it then answers with a full 60 s is unknown.
It was not probed further, because that risks more 429s on the site's key.

Fix: `parseUpstreamQuota` stores every reset (relative seconds or epoch
seconds) `RESET_GUARD_MS` (1000 ms) later (`lib/upstream-pacing.mjs`). It
applies to both pools. Cost: at most one second per window, plus slightly
wider pacing. Test: `tests/workflow-api-key.test.mjs`, both header forms
store the reset a second later and an exhausted window stays shut until
then.

Not yet verified live. The 503 burst from the second drain (20:59:07 to
20:59:22 UTC, every route, fast responses) did not recur and its cause is
unknown; the drain script now records 5xx bodies.

## Drain side effect: pro regions, repaired; visitor RR requests keep saved regions

A fourth drain (21:13 UTC, after the reset guard deployed) ran 150 s with no
upstream 429. The `503 Upstream quota storage unavailable` burst came back
(49 responses in about 2 s); it is a D1 failure in the gate, whose error the
proxy does not log yet, so its cause is still unknown.

The drains themselves damaged data. They called
`/mmr-history-by-puuid/eu/pc/{puuid}` for pro accounts, and every 200 went
through `collectRR`, which set `rr_players.region` to the region in the URL.
HenrikDev answers RR history for the account whatever region the URL names
(inference: for `kIt#1029`, an ap account, all 30 archived ap matches are in
its RR rows), so the RR data looked right while the region was wrong. The
saved-account answer then served `kIt#1029` as eu.

Repair (24 Nov 2026): the 182 pro accounts the drains touched were looked up
once each through the public account route, ignoring saved answers. 96 had the
wrong region (68 na, 28 ap) and were set back, each update conditional on the
backed-up value; 86 were right. The 2 still-open gaps the drains created now
carry the live region; the 80 connected or healed ones keep `eu` (nothing
reads a closed gap's region). Backup, SQL and report:
`.local/repairs/rr_players-pro-regions-*-20261124.*` (local only).

Fix (`lib/rr-corpus.mjs` `collectRR`, `regionFromRequest`): a visitor's
`mmr-history` request no longer replaces a saved region, and a gap it finds
takes the saved region. With nothing saved, the URL region is still stored.
The collector's `rr-collect` requests still update the region, since their
region comes from `rr_players` or a fresh account lookup; that is how region
transfers are followed. Platform is unchanged: it selects which RR data
HenrikDev returns.

Tests: `tests/rr-corpus.test.mjs` (saved region kept, collector transfer
still applies, nothing saved stores the URL region, gap takes the saved
region) and `tests/workflow-api-key.test.mjs` (an `eu` visitor request for an
`ap` account saves the RR window and keeps `ap`). All three fail without the
fix.

Future drain tests must not use RR or other evidence-writing routes.

## Gate failure logging

When D1 fails during admission or the quota update, the proxy still answers
503 (fail closed) and now also logs
`Quota gate <admission|update> failed on <route>: <D1 message>` (route's first
path segment only, message cut to 300 characters). Read it with
`npx wrangler pages deployment tail <deployment-id> --project-name vlravg`
or in the Pages Function logs. Test: `tests/workflow-api-key.test.mjs`.

## Counting HenrikDev units, 24 Nov 2026

`lib/upstream-pacing.mjs`, `lib/upstream-cost.mjs`, migration
`0015_public_quota_audit_cost.sql`.

### Why

HenrikDev's rate-limit docs (docs.henrikdev.xyz, general/rate-limiting):
limits are "tied to your API key and are enforced globally per key", and cost
is "1 request to the API = +1" plus "1 background request to Riot = +1". The
site key has 60 units a minute and the workflow key 30. The gate counted one
per call. Evidence that real costs are higher:

- Workflow quota audit: on about 90% of comparable calls HenrikDev reported
  one more unit used than the collector's count (419 of 458 samples in the
  run of 24 Nov, similar in every run since 23 Nov). About 4,760 calls in
  5.3 h, roughly 15 a minute: 30 units at about 2 each.
- Public audit, gate count minus header at low windows: `account` (by Riot
  ID) 0, `account-by-puuid` (`force=true`) 1.25 on average, `rank` during a
  bulk drain 10.5 (up to 14). In the last drain the header was already 12
  below our count; the gate admitted calls HenrikDev had no units for and
  its 429 stopped the pool for 60 s.

Inference, not measured per call: a call HenrikDev fetches from Riot costs 2;
answers from its store cost 1.

### What changed

- Each call reserves its estimated units (`upstreamCost`): 1 for stored
  endpoints (`stored-matches`, `stored-mmr-history`, `rr-heal`, the stored
  name-backfill phase); 1 + size for live match lists (`history`,
  `history-by-puuid`, the live name-backfill phase; size from the query,
  capped at 10, a full page assumed when absent); 2 for everything else
  (account, rank, RR history, match details). These are upper estimates.
- A call is admitted only when the window holds its units; reserves are now
  units left after the call: `PUBLIC_PROFILE_RESERVE` 12 (six account
  lookups at 2) for non-account public calls, `PUBLIC_BORROW_RESERVE` 30 for
  collector loans.
- Spacing stays per call (remaining units spread over the window), so costly
  calls widen the gaps on their own; the collector's 2.1 s floor stays.
- The newest admitted call's response header now sets the count both ways
  (it was `MIN(count, header)`), so a cached answer gives back the units its
  estimate over-reserved. Older responses are still ignored.
- `public_quota_audit.cost` records each audited call's estimate; the
  workflow audit's expected count now includes the estimate, so its
  "unexplained" figure measures estimate error.

### Trade-offs and risks

- Pessimistic match-list estimates: with fewer than 23 units left (11 for a
  page plus the 12-unit reserve), live history pages wait for the reset even
  when HenrikDev would have answered from its store. Edge-cache hits are
  unaffected.
- Setting the count from the newest header assumes earlier calls already
  reached HenrikDev and that it charges the Riot unit when the request
  arrives. If it charges on completion, the count can briefly run high;
  `upstream-429` rows with `gate_remaining` above 0 would show it.

Tests: `tests/upstream-cost.test.mjs` (estimates per route, audit column
upgrade), `tests/upstream-pacing.test.mjs` (units reserved, reserve after the
call, header settles the real cost both ways), and the updated proxy and
reserve tests in `tests/workflow-api-key.test.mjs`. Not verified live.

## Measured costs instead of estimates, 24 Nov 2026

`lib/upstream-cost.mjs`, `lib/upstream-pacing.mjs`, migration
`0016_measured_quota_costs.sql`. Replaces the per-route estimates of the
previous section (1 stored, 2 single objects, 1 + size for match lists).

HenrikDev reports no cost per call. Its responses carry the key's remaining
count (`ratelimit`, `x-ratelimit-remaining`), the window's reset and
`x-cache-status` (`HIT`, `NONE` seen), nothing more (checked on two calls,
24 Nov 2026). So the gate measures:

- Every admission stores the previous admission (`prev_request_at`); every
  response raises `observed_request_at`; the newest call's response stores
  HenrikDev's count (`header_remaining`, `header_reset_at`).
- A call is a clean sample when the previous call's response had arrived
  before it was admitted and its own response is the newest: between the two
  headers nothing else of ours used the key. If both headers belong to one
  window (resets within `SAME_WINDOW_MS`, 1500 ms) and the count did not
  rise, the drop is the call's cost.
- Samples go to `quota_cost_samples` with pool, route key (path segment;
  `history:10`-style page size for match lists; phase for name backfill),
  HenrikDev's `x-cache-status`, status and cost. Kept 14 days. A failed
  sample write never fails the request.
- Admission reserves the route's 90th percentile over its newest 30 samples,
  so a single call that shared the key with something outside the gate does
  not set the price. A route without samples reserves the highest measured
  route cost; with no samples at all, 1 (HenrikDev's documented minimum).
  The table is read at most once a minute per isolate.
- The newest header still sets the count both ways after every response.

Limits:

- Calls that overlap are not measured. The collector's spaced calls and
  quiet-hour site traffic give most samples; busy minutes give few.
- Usage of the key outside the gate (another tool with the same key) makes
  a sample too high; the percentile limits its effect. The two header
  checks above used the local development key (`.dev.vars`) directly;
  whether it is the production site key is unknown, so those calls may
  themselves have been such outside usage.
- Until a route has samples, it reserves the highest measured cost, or 1 on
  an empty table; the first minutes after deploy behave like counting calls.

Tests: `tests/upstream-cost.test.mjs` (route keys, sample rule, serial calls
measured and overlapping ones skipped, percentile, fallback, cache refresh,
pruning).

## Saved-account answers removed, 24 Nov 2026

The fallback that answered a refused account lookup from D1 (section
"Saved account answers" above, `lib/saved-account.mjs`) is gone; migration
`0017_drop_saved_account_index.sql` drops its Riot-ID index.

Why (user decision): the account lookup is meant to work live, which is
what the reserve, slot priority and measured costs are for. In the last
drain refusals came only at window ends with waits of 11 s or less. The
fallback answered from stored identity and region, and the region proved
fragile (the drain incident above). It never set the rank badge, which comes
only from the live `rank` call.

Now a refused search account lookup gets the 429 like any other call and is
recorded as `profile-refused` (`served_saved` stays empty on new rows).
Tests: `tests/workflow-api-key.test.mjs`.

## Exact count, capped calls in flight, documented maximum costs, 24 Nov 2026

`lib/upstream-pacing.mjs`, `lib/upstream-cost.mjs`, migration
`0018_quota_leases.sql`. Replaces admission by measured cost (previous
sections); the samples stay, as evidence.

### Why

Measured costs were least accurate when they mattered: calls overlap under
load, so samples are scarce exactly then; a match list costs 1 to 11 by
HenrikDev's cache, which a percentile cannot know per call; and an
unmeasured route started at 1. HenrikDev's header is exact after every
response, so the only unknown is calls still in flight.

### Rules

- `remaining` is HenrikDev's count from the newest response; admissions no
  longer subtract from it.
- At most `PUBLIC_IN_FLIGHT` (3) site calls and `WORKFLOW_IN_FLIGHT` (1)
  collector call run at once. Each admitted call takes a lease in the quota
  row (`leases`, JSON `[{s, u, e}]`): its start, its documented maximum cost
  and an expiry `LEASE_MS` (30 s) later. Its response releases it; a failed
  fetch releases it at once; a Worker that dies leaves it to expire.
- Documented maximum (`maxUnits`), from "1 request = +1, 1 background
  request to Riot = +1": 1 for HenrikDev's stored endpoints, 2 for one
  object (account, rank, RR history, match), 1 + page size for match lists
  (pages capped at 10). These are upper bounds, not guesses: a call cannot
  make more Riot requests than objects it asks for.
- A call is admitted only while HenrikDev's count minus every held maximum
  minus its own leaves `QUOTA_MARGIN` (2) plus the pool's reserve: 12 for
  non-account site calls, 30 for collector loans, none for account lookups.
  Unless something outside the gate uses the key, no admitted call can find
  it empty.
- Refusals: not enough units even with nothing in flight waits for the
  reset; units or places held by calls in flight wait up to 250 ms and retry.
  Spacing still spreads the free units over the window; priority claims and
  the reset guard are unchanged.
- An unknown window (no header yet) checks no units; the cap and the unknown
  spacing bound it until the first response.

### 429 handling

A 429 now pauses the pool until the later of HenrikDev's reset (plus the
guard) and `Retry-After`; with neither, `NO_HEADER_429_WAIT_MS` (5 s). It was
`max(reset, Retry-After or 60 s)`: the second 60 s block of 24 Nov 2026 came
with a reset header of about one second, so it was either HenrikDev's
`Retry-After: 60` or that default. `public_quota_audit` now keeps
HenrikDev's own `Retry-After` in `retry_after_ms` (no longer the derived wait)
next to its reset, so the next 429 settles which.

### Trade-offs

- A match list needs 11 + 12 + 2 = 25 free units; under load it waits near
  window ends.
- Throughput with 3 in flight depends on HenrikDev's response times; not yet
  measured live.
- One more JSON update per call in the quota row (take and release).

Tests: `tests/upstream-pacing.test.mjs` (cap, answer and expiry free a
place, held maxima, margin and reserves, spread spacing, 429 waits, schema
upgrades, claims) and `tests/upstream-cost.test.mjs` (maxima per route,
sample rule and recording).

## Held maxima raised by repeated measurements, 24 Nov 2026

The live drain of the lease-based gate (22:52 UTC, 150 s, rank lookups
only): no HenrikDev 429, no D1 errors, refusals only at window ends (8.8 s
or less), 44 drain calls answered against 50 before. Measured samples so
far:

| route | cache status | samples | average | highest |
| --- | --- | --- | --- | --- |
| `rr-collect` (collector key) | HIT | 452 | 2.0 | 2 |
| `rr-collect` (borrowed site slots) | HIT | 408 | 1.99 | 2 |
| `rank` | HIT | 42 | 1.98 | 3 |
| `account-by-puuid` | HIT | 23 | 2.83 | 3 |
| `account-by-puuid` | NONE | 3 | 1 | 1 |

`account-by-puuid` (`force=true`) mostly cost 3, above the documented
maximum of 2; the 2-unit margin absorbed it. Why it costs 3 is not known.

Change (`lib/upstream-cost.mjs` `heldUnits`): a call in flight holds the
higher of its documented maximum and the highest cost measured at least
twice (`QUOTA_COST_MIN_REPEATS`) for its route in the kept samples (14 days),
capped at 11. A single high sample may be a call that shared the key with
outside use, which the margin covers; a repeated one is the route's own.
Measurements only ever raise the bound. The maxima are read at most once a
minute per isolate; without a readable samples table the documented maxima
apply.

Tests: `tests/upstream-cost.test.mjs` (repeated cost raises the bound, a
single one does not, cap, expiry, cache, unreadable table) and
`tests/workflow-api-key.test.mjs` (an account lookup with a measured cost of
3 holds 3).

## 429s tested on purpose, 24 Nov 2026

See [henrikdev-429-behaviour.md](henrikdev-429-behaviour.md). A 429 carries no
penalty: 429'd calls are not counted, calling while limited does not extend
the wait, and the policy stayed `q=60;w=60`. HenrikDev never sends
`Retry-After`. A 429 at the window boundary claims a 60 s reset although the
window opens a second later; the gate now waits 2 s after such a 429.

## Fixed maximum costs, runtime measurement removed, 25 Nov 2026

The 429 test showed a 429 costs nothing beyond the wait. The gate's cost
tracking therefore matters only for keeping the account-lookup reserve, and
needs bounds that are safe, not exact. Changes:

- `lib/upstream-cost.mjs` is a fixed table (`maxUnits`): 1 for HenrikDev's
  stored endpoints, 2 for one object, 1 + page size for match lists, and 3
  for forced account lookups by PUUID (`account-by-puuid`, `name-history`;
  `FORCED_ACCOUNT_UNITS`), the one place the measurements exceeded the rule.
- The runtime measurement is gone: no per-call sample write, no measured
  maximum lookup, no baseline columns. Migration
  `0019_drop_cost_measurement.sql` drops `quota_cost_samples` and the four
  measurement columns; apply it after this code is deployed, because older
  code re-adds them lazily.
- Unchanged: HenrikDev's exact count, the in-flight cap, leases, the 2-unit
  margin, the reserves, the 429 handling and `public_quota_audit` (its
  `cost` column now holds the fixed maximum).

The sections above on measured costs and held maxima are kept as history.

## Cause of the 503 bursts, 24 Nov 2026

A sixth drain (23:20 UTC, 150 s, `rank` only, as at 22:52) got 98 `503 Upstream quota storage
unavailable` responses within 6 s, and the gate-failure log gave the D1 error:
"D1 DB is overloaded. Too many resources consumed within a 10 second window".
Of the drains since 20:59, every one with 503s overlapped a minute with more
than 0.6M D1 rows read, and the ones without did not. Those minutes match the RR
collector's 30-minute player reload, which up to four of its workers ran at
once. Details, measurements and the fix:
[rr-collector-d1-load.md](rr-collector-d1-load.md#overlapping-player-reloads-24-nov-2026).

In the same drain, 6 of 31 account lookups by PUUID were refused, all in the
last 10 s of a window, with 2 or 4 units left. Each one holds 3 units and
needs the 2-unit margin on top. The probes (about 15 forced lookups a minute,
3 units each) used up the 12-unit reserve within the window. That is more
than the reserve is meant to cover, not a gate fault.

A seventh drain (25 Nov 2026, 00:29:30 UTC, 360 s, `rank` only) ran around
a reload of a collector run on the fixed scripts, with the site's D1 overload
retry deployed. It got no 503 and the tail logged no gate failure; the reload
minute read 572,236 rows instead of 1.71M. 107 of 112 account-lookup probes
were answered. Details:
[rr-collector-d1-load.md](rr-collector-d1-load.md#live-check-25-nov-2026).

## Collector borrowing removed, 25 Nov 2026

`functions/api/[[path]].js`, `lib/upstream-pacing.mjs`.

### Live test

A random saved EU account was searched on the live site at 15:18 UTC, with
every `/api` call logged in the browser and the `rate_quota` row read about
every 3 s:

| UTC | site key units left | what used them |
| --- | --- | --- |
| 15:18:05 | 54, window just opened | no visitor traffic: borrowed `rr-collect` calls, 2 units about every 3 s |
| 15:18:26 | 32 | borrowing stops: `PUBLIC_BORROW_RESERVE` (30) plus the 2-unit margin |
| 15:18:29 | 32 to 21 | the search: account, rank, mmr-history, name-history, stored-matches, all 200 (about 11 units) |
| 15:18:31 | 21 | all three history pages (`start=0/10/20`) answered 429, `retryAfterMs` 26,370 |
| 15:19:03 | window reset | the pages load; 32 matches shown a few seconds later |

A history page may cost 11 units (1 + 10 matches), and a non-account call
needs its units plus `PUBLIC_PROFILE_RESERVE` (12) plus the margin (2) free:
25 units. With the collector keeping every quiet window at about 32, a search
had about 21 left after its own lookups, so no page could start before the
reset. Other visitors were not involved. Earlier `low-window` and
`upstream-429` rows on `history-by-puuid` (25 Nov 13:16 UTC) fit the same
pattern.

### Change

Collector calls (`X-Workflow-Key`) wait on their own pool only and never use
`HENRIK_KEY`. `acquireBorrowedPublicPermit` and `PUBLIC_BORROW_RESERVE` are
gone, `X-Workflow-Upstream-Pool` is always `workflow`, and the `borrowed:`
route prefix no longer appears in `public_quota_audit`. Teammate-name lookups
still use the workflow key, unchanged.

Cost: the collector loses up to about 14 calls a minute that it took from the
site key (28 units at 2 each). Its own key still allows 30 units a minute.

Not changed: a full window (60 units) admits only about three uncached
live pages after a search's own lookups (49 left, each page needing 25 free), so a long act still waits for one or more
resets. A 60-match load is about 6 pages, up to 66 units, more than one window.

Tests: `tests/workflow-api-key.test.mjs` (a busy or exhausted workflow pool
gets a 429 and never touches the site key, even with the site window full;
both fail on the old proxy), plus the removed borrowing tests in
`tests/upstream-pacing.test.mjs`.

### Live check, 25 Nov 2026 (deployment `84e009f`)

- Collector: for 40 s with no visitors (15:23:47 to 15:24:24 UTC) the
  workflow key went from 14 to 2 units left while `rate_quota` stayed
  untouched (last call 39 s earlier).
- First search, `haimiya#waifu` (9 matches this act), in a window no one else
  had used: rank, RR history and pages 0 and 20 were answered at once. Page
  10 got one 429 from the gate, not from HenrikDev, with a 1.7 s wait. It had
  spent the gate's 8 s waiting behind three slow calls in flight (name history
  took 8.7 s), and it loaded on the retry.
- Second search, `marta#0001` (143 matches), 50 s later in the same window:
  the first pages and RR history got 429s with 10.5 s waits until the reset,
  because the first search had spent that window. After the reset, six live
  pages loaded within 15 s.
- No `public_quota_audit` rows between 15:20 and 15:27 UTC: no HenrikDev 429,
  and no response showed 12 or fewer units left.

One sample per case. Two searches in one minute still share one window.

## No spread spacing and six calls in flight for a known site window, 25 Nov 2026

`lib/upstream-pacing.mjs`.

### What was measured

Two production searches for hiro#luna (164 saved matches, coverage verified),
in the in-app browser, single runs:

- 15:59 UTC: saved matches on screen at 3.7 s, all 164 at 6.1 s. Rank and
  live pages 0 and 10 were held about 7 s and then answered 429 by the gate;
  the retry of page 10 waited for the next window and loaded at 61 s.
  `public_quota_audit` has no row for that search, so HenrikDev refused
  nothing: every 429 came from the gate.
- 16:02 UTC, with `rate_quota` read every 3 s: the whole search took about
  6 s, no 429. HenrikDev's count went from 59 to 55; most answers were
  edge-cache or HenrikDev-cache hits from the first search.

Correction: rows from 13:16 UTC (`gate_remaining` 14, `header_remaining` 3)
were first read as part of the 15:59 search. They are not: the query
compared `datetime('now', …)` (space-separated) with ISO `observed_at`
values, which matched every row of the day. They predate the end of
collector borrowing.

Why the 15:59 search's page 10 then needed a new window is not known: the
search's own calls explain about 20 units by then, and at least 35 were
gone. Another visitor in the same window is likely but not shown.

### Cause

With a known count, the gate spaced every site call so the free units would
last the window: about 1 s apart with a full window, whatever the call
cost, and at most 3 calls in flight. A search asks for rank, RR history,
name history and two or three live pages at once, so they queued; with slow
answers (name history took 7.6 s at 15:59) the queue passed the gate's 8 s
wait and the gate answered 429.

The held maxima already make overspending impossible once the count is
known (a call is admitted only while the count minus every held maximum
leaves the margin and reserve), so neither rule protected the key there.

A replay of the search through the real gate with a fake clock and the
first search's timings (account 2.5 s, RR history 3.5 s, name history 3 s,
rank 2 s, pages 5 s; full window):

| Gate | Pages 0 and 10 admitted | Last call answered |
| --- | --- | --- |
| Before | 6.2 s and 7.3 s | 12.3 s |
| 6 in flight only | 5.7 s and 6.8 s | 11.8 s |
| No spread spacing only | 2.8 s and 5.8 s | 10.8 s |
| Both (this change) | 2.8 s and 3.0 s | 8.0 s |

A model, not a measurement; the live saving depends on HenrikDev's times.

### Change

- Site pools with a known count space calls by their 150 ms floor only
  (`percent: 0`); the collector still spreads its units (`percent: 100`).
- Site calls in flight: `PUBLIC_IN_FLIGHT_KNOWN` (6) with a known count,
  `PUBLIC_IN_FLIGHT` (3) while it is unknown.
- Unchanged: an unknown window's 2.1 s spacing and 3-call cap (there
  admission checks no units), held maxima, margin, account-lookup reserve,
  priority claims, 429 handling, the collector pool.

Trade-off: a busy window is now spent at its start instead of spread over
it, so a visitor arriving late in a window spent by another waits for the
reset either way; before, both waited part of it. The account-lookup
reserve still keeps 12 units for profile lookups.

Tests (`tests/upstream-pacing.test.mjs`): a search's six opening calls are
admitted 150 ms apart with a known count and a seventh waits; an unknown
window keeps the 3-call cap and 2.1 s spacing; 40 public calls start 150 ms
apart. The first two fail on the old gate.
