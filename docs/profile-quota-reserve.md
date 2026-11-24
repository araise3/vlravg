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
