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
