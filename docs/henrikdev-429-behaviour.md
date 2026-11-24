# What a HenrikDev 429 does

24 Nov 2026, 23:02 to 23:05 UTC. Script `scripts/probe-henrikdev-429.mjs`,
raw log `artifacts/henrikdev-429-probe-20261124.jsonl` (one row per request,
headers and 429 bodies, no key).

## Setup

- Key: the `.dev.vars` `HENRIK_KEY`. It is the production site key (inferred:
  a direct call and a site call 0.35 s apart showed the same window, reset in
  47 s, and one running count, 57 then 56). Site visitors and borrowed
  collector calls shared the key during the test and were blocked with it.
- Calls: `GET /valorant/v1/by-puuid/stored-matches/ap/{puuid}?size=1`, one
  unit each (`x-cache-status: NONE`).
- Plan: spend a window; call 0.5 s before, at, and after the stated reset;
  spend two more windows and keep calling once a second through each 429
  period; compare policy, resets and the next window's count. 290 requests in
  182 s, 165 of them answered 429.

## Results

| question | observed |
| --- | --- |
| Limit | `ratelimit-policy: "per1min";q=60;w=60`, fixed one-minute window. Window 1 answered exactly 60 calls, then 429. |
| 429 response | 20 ms; body `{"errors":[{"code":0,"message":"Rate limit exceeded, please try again later. ..."}]}`; `x-ratelimit-remaining: 0` and the reset counting down. |
| `Retry-After` | Never sent, on any of 165 429s. |
| Does calling while limited extend the wait? | No. 54 calls a second apart in each of two 429 periods; the reset counted down without rising (once per period, at the boundary, below). |
| Do 429'd calls count? | No. After each 429 period the first answered call showed 59 left: the new window was full. |
| Penalty for repeated 429s | None seen: the policy stayed `q=60;w=60` through three exhausted windows and 165 429s, and the third window opened full. Longer-term effects (hours, days) were not tested. |
| Calling at the stated reset | 0.5 s before: 429, reset 1. At 0.0 s: **429 with reset 60**. 0.5 s after: 200, 59 left. The same 429-with-reset-60 came at the boundary of both later windows, each followed one second later by a 200 with 59 left. |

The two later windows answered 58 of our calls, not 60. The missing two
units are most likely site or collector calls on the same key; the test
cannot tell.

## What it means for the gate

- A 429 is not a punishment here: it costs the wait until the window resets,
  the same as running out. Calls made while limited are free and harmless.
- HenrikDev does not send `Retry-After`. The 60 s block at 21:47 on 24 Nov
  came from this gate's former 60 s default (now `NO_HEADER_429_WAIT_MS`,
  5 s).
- A 429 right at the window boundary reports `reset 60` although the window
  opens about a second later. The 60 s block at 21:04 on 24 Nov matches that:
  the call went 0.16 s after the stated reset and the gate trusted the reset
  of 60. Fixed: a 429 whose reset is within 2 s of a whole window
  (`BOUNDARY_429_MS`) now pauses the pool for 2 s (`BOUNDARY_429_WAIT_MS`),
  and the next answer sets the count (`lib/upstream-pacing.mjs`, test in
  `tests/upstream-pacing.test.mjs`). A window genuinely spent in its first two
  seconds then costs one more 429, which is free.
- Staying under the quota still matters for one thing the key cannot do for
  us: keeping the account-lookup reserve.
