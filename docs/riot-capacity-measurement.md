# Controlled EU Riot match-detail rate measurement

Started 30/09/2026, 00:12:27 Europe/Berlin. Total elapsed 333.1 seconds.

The test used one dedicated account, one authenticated session, one EU host and one endpoint: `GET https://pd.eu.a.pvp.net/match-details/v1/matches/{id}`. Authentication, entitlement and content ran once; history IDs were discovered once. Detail calls rotated over a fixed list of accessible matches, without a local detail cache. These are repeated detail reads, not discovery of unique uncached matches. Each run was capped at 200 sequential requests, split into frames of at most 40 calls to stay below Worker subrequest limits.

The preview datacenter was HAM, and 1 datacenter value(s) were recorded during detail frames. The same opaque session identifier was used across all frames: true. Encrypted temporary session state was kept server-side in the Cache API; no database schema or production provider was changed.

| Run | Requested pacing | Successful details | Rejected details | Detail interval, s | Max successful dispatches / 1s | / 10s | / 60s | Median / p95 transfer, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| burst1 | none | 60 | 1 | 3.709 | 19 | 60 | 60 | 58 / 82 |
| burst2 | none | 60 | 1 | 4.342 | 17 | 60 | 60 | 75 / 89 |
| steady | 1 request/s | 74 | 1 | 74.001 | 1 | 10 | 60 | 76 / 88 |

Intervals run from first dispatch to final response completion. Whole-run time includes client/preview round trips and cooldowns. Rolling windows count dispatch timestamps and use half-open windows; they are client-side observations, not server quota counters.

## Headers

Rate-control headers observed: `retry-after`.

The allowlist checks application and method limit/count pairs, limit type, legacy limit/remaining/reset, RateLimit, RateLimit-Policy, and Retry-After. Structured RateLimit fields retain numeric quota/window values only, excluding opaque partition identifiers. No cookies, tokens, redirect URLs, raw player records or raw errors are returned.

- burst1: rejection at detail request 61; Retry-After 60 seconds; server classification cloudflare; body type text/plain; Cloudflare Ray header present true; challenge marker false; 17 bytes; 5 ms.
- burst2: rejection at detail request 61; Retry-After 60 seconds; server classification cloudflare; body type text/plain; Cloudflare Ray header present true; challenge marker false; 17 bytes; 4 ms.
- steady: rejection at detail request 75; Retry-After 60 seconds; server classification cloudflare; body type text/plain; Cloudflare Ray header present true; challenge marker false; 17 bytes; 1 ms.

A Cloudflare server header and plain 429 identify an upstream response served through Cloudflare. They do not alone distinguish a Cloudflare rate-limiting rule from a Riot service behind that edge, or reveal whether the quota is keyed by account, IP, route or another attribute.

## Cooldown and accounting

- Before burst2: 125.0 seconds idle.
- Before steady: 125.0 seconds idle.

5 setup requests and 197 detail attempts were recorded. Each phase stopped on its first rejection. A 429 enforces at least 120 seconds idle, or the supplied Retry-After if longer; the client adds five seconds. Missing/changed cache or non-rate failure stops the experiment.

Temporary session cleanup confirmed: true.

## Interpretation

Both unpaced runs accepted 60 details and rejected request 61 after cooldown. That is a reproducible burst boundary for this session, endpoint and deployment. The one-request-per-second run produced 74 successes and 1 rejections.

The sustained run also hit a limit despite client dispatch spacing of one second. The repeated burst result and Retry-After establish neither a reliably sustainable 60/minute budget nor a single fixed-window rule. Server arrival-time variation, longer windows, shared counters or another quota scope could affect this; the retained metadata cannot distinguish them. No lower sustained rate was validated in this experiment.

This is not proof of Riot-wide capacity. More general conclusions require endpoint/region/scope measurements or provider confirmation. A production scheduler should leave headroom and honor Retry-After, including on an already paced workload.
