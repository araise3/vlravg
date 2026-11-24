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
