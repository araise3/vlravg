# Riot capacity versus HenrikDev quotas

Researched 30 September 2026 (Europe/Berlin).

## Verified explanation

HenrikDev's current Tier 3 advertises up to 300 requests/minute. The limit is
global per key and is charged as one unit for the Henrik request plus one for
each background Riot request. A fully cached response costs one unit and uses
no Riot calls. Its documented partial-cache example returns ten matches with
seven already stored: one history call and three detail calls cost five units
including the customer request.

Sources: [premium tiers](https://docs.henrikdev.xyz/general/premium),
[quota calculation](https://docs.henrikdev.xyz/general/rate-limiting).

Thus 300/minute is not a promise of 300 cold ten-match pages/minute. Assuming
one history lookup and ten missing details, one such page would cost twelve
units, allowing 25 pages/minute from a 300-unit allowance before any other
endpoint costs. That is arithmetic under the documented formula, not a live
measurement of our particular key.

Henrik's v4 release also documents Rust and a backend proxy fleet expanded by
7.5 times. The source confirms expanded infrastructure; it does not publish
its current topology, account/session counts, routing rules, or Riot quota
partitioning. No evidence establishes that a single Henrik session can fetch
300 uncached Riot responses per minute.

Source: [v4 release](https://docs.henrikdev.xyz/valorant/changes/v4.0.0).

The stored-matches guide confirms that successful detail fetches are stored
and can satisfy subsequent requests. Fetch failures can leave holes in this
materialized history. Storage does not imply complete Riot history coverage.

Source: [stored matches](https://docs.henrikdev.xyz/valorant/guides/stored-matches).

## What our measurement establishes

The unpaced remote-session run completed 102 data calls plus twelve setup
calls before the next AP detail fetch returned HTTP 429. Total client wall
time was 60.88 seconds. The request runner stopped on rejection.

This is an observed upstream rejection point, not an established 100/minute
Riot limit. Traffic mixed endpoints and regions, and renewed authentication
once per three-player batch. We did not isolate short/long windows, sustained
load, or the partition responsible for the rejection. The 429 transferred
17 bytes in about 2 ms; neither its raw body nor identifying upstream response
headers was retained, so the record cannot distinguish a Riot gateway/WAF
response from the underlying game service's limiter.

The rejection was recorded as a response from an outgoing Riot fetch, not a
429 from our public benchmark route. Each batch performed at most 43 external
fetches. Cloudflare's documented Workers Free subrequest limit is 50 per
invocation; its CPU/memory failures produce Error 1102. The record therefore
does not indicate that our batch exceeded those Worker limits.

Sources: [saved measurement](riot-unpaced-benchmark.md),
[Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/).

The [controlled EU follow-up](riot-capacity-measurement.md) subsequently
captured the full rate-header allowlist using one reused session. Both
unpaced detail runs accepted sixty calls and rejected the sixty-first;
both supplied `Retry-After: 60`. After another 125-second cooldown, the
one-request-per-second phase accepted seventy-four calls and rejected the
seventy-fifth. No numeric app/method limit or count header appeared. This
confirms a repeatable burst boundary, but does not validate a sustainable
sixty-per-minute allowance or establish how the counter is partitioned.

## Recommended design for this repository

1. Store completed full match payloads once under `(region, match_id)`.
   Associate player/season history with those records separately. The current
   `match_archive` stores payloads under `(puuid, match_id)`, so two players
   from the same match can have separate copies. Keep provider/schema version
   in the storage key or metadata; raw Riot and transformed Henrik payloads
   are not interchangeable.
2. Resolve a player's latest history IDs, check the shared detail store, and
   request only missing matches. Deduplicate the same match across visitors
   and players. Serve ten-match responses from storage once populated.
   Treat complete match data as long-lived with explicit repair/refresh,
   rather than assuming every successful response is permanently complete.
3. Use a short TTL for rank, RR and history discovery. Proposed initial
   values are 60–150 seconds, to be validated for desired freshness. Serve
   cached data immediately while one owner refreshes it. Store observations
   with timestamps so stale responses do not claim to be live.
4. Share a valid authenticated session across requests until renewal is
   necessary. Keep credentials and tokens server-side. Add explicit recovery
   for expiration and rejected cookies. Session reuse reduces setup calls;
   it does not create additional upstream quota.
5. Coordinate duplicate fetches and cooldown globally. A Durable Object in
   a separate Worker, bound to Pages, is a possible coordinator; a single
   process is another option. Partition scheduling only where measurements
   establish separate limits. On 429 honor Retry-After where supplied and
   stop dispatching through the affected session; do not immediately shift
   the same work to another region, account or proxy. Cold misses must queue
   when upstream capacity is exhausted. Queue control should not add a
   blanket delay to cached responses.
6. Record public responses/minute, actual upstream calls/minute, cache-hit
   ratio, unique match IDs, warm/cold page latency, and per-endpoint rejection
   summaries separately. For future rejections retain safe classifications
   and numeric Retry-After server-side; never publish credentials, raw errors
   or live Henrik quota headers.

Cloudflare reference: [Durable Objects coordination](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).

For a concrete test, populate the same sample's shared match store once and
then measure repeated page reads, plus an incremental update with one new
match. Report the upstream count for each phase. Only this demonstrates
whether 300 public responses/minute can be served by our design without
requiring 300 live Riot fetches/minute. The raw unpaced benchmark should
remain a separate test, with its cache behavior explicitly recorded.

As an illustrative capacity calculation, if each public request needs one
upstream call on a miss, 300 public requests/minute with a 95% hit rate need
15 upstream calls/minute. If each miss needs thirteen calls, the same traffic
needs 195 upstream calls/minute. The general formula is
`public rate * miss fraction * upstream calls per miss`. These examples are
not proof of either service's allowable rate.

## Decision

For the remote-session experiment, implement the shared detail store and
incremental discovery before attempting another sustained capacity test.
That addresses the cold-fetch amplification observed in the benchmark.
The existing Henrik provider remains the working production source while
Riot schema/rank/damage mapping and session recovery are unresolved.

If the requirement is 300 genuinely fresh upstream fetches/minute, caching
alone cannot satisfy it; use a provider with an approved adequate allowance
or an approved Riot integration with confirmed endpoint limits. An official
integration needs a separate assessment of RR and other data coverage.
Henrik's undocumented internal proxy implementation is not a specification
we can reliably reproduce from the available sources.
