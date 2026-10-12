# Unpaced Riot remote-session benchmark

Run started 2026-09-29T21:52:41.933Z. All requests originated from the isolated Cloudflare Pages preview, using the existing dedicated Riot account. No sleep, pacing or retry was used. The frozen 24-player PC sample is the same as the earlier Henrik comparison.

One cookie renewal, identity check and entitlement issuance were shared by each three-player batch. Content was fetched once per batch. Tokens were held only in that request; this is session reuse within a batch, not a persistent session across all batches. Data workload: current MMR, 20 history IDs, 20 RR updates and up to ten full competitive match details per player. There were no new Henrik requests; comparison uses the saved earlier benchmark.

The first limit was observed on **detail** in **ap**, in batch 3, at concurrency 1. Before that rejection, 102 data requests succeeded. The entire run took 60.88 seconds, including session setup and client-to-preview overhead. This is a measured rejection point for this account/deployment/workload, not proof of a fixed 102-per-minute quota. The planned two/four-concurrent stages were not run after the rejection.

| Concurrent requests | Batches | Successful data requests | Data wall time, s | Data requests/s | Whole stage requests/s | 429s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3 | 102 | 59.92 | 1.70 | 1.68 | 1 |

Data wall time includes scheduling and transfer, and excludes authentication, content and client-to-preview gaps between batches. Whole-stage rate includes those costs. These are observed finite-workload rates, not a proven sustainable maximum or an extrapolation to hourly capacity.

| Endpoint | Earlier paced Riot median/p95, ms | Unpaced sequential Riot median/p95, ms | Unpaced four concurrent Riot median/p95, ms | Earlier Henrik proxy median/p95, ms |
| --- | ---: | ---: | ---: | ---: |
| rank | 892 / 1047 (n=24) | 493 / 1438 (n=9) | — | 444 / 907 (n=24) |
| history | 175 / 767 (n=24) | 178 / 1082 (n=9) | — | 671 / 2789 (n=24) |
| rr | 178 / 763 (n=24) | 173 / 685 (n=9) | — | 129 / 1915 (n=24) |
| detail | 1016 / 1617 (n=24) | 585 / 1640 (n=75) | — | — |

History responses are not equal work: Riot returns IDs; Henrik returns ten full match records. Earlier Henrik numbers include the production proxy, its cache, quota pacing and persistence. Individual request transfer times in the earlier benchmark already excluded its explicit 500 ms pause. Removing the pause affects workflow duration, not necessarily individual request latency. Planned concurrency stages are ascending; if multiple stages complete, repeat-request warming can affect the comparison.

| Region / sample | Earlier Henrik full-history response, ms | Earlier Riot detail sum, ms / count | New sequential Riot detail wall, ms / count | New four-concurrent Riot detail wall, ms / count |
| --- | ---: | ---: | ---: | ---: |
| ap / 0 | 572 | 8530 / 10 | 8892 / 10 | — |
| eu / 1 | 338 | 682 / 8 | 562 / 8 | — |
| kr / 2 | 601 | 15355 / 10 | 14193 / 10 | — |
| na / 3 | 571 | 9497 / 10 | 6516 / 10 | — |

Detail wall time begins at the first detail dispatch and ends at the last completion for that player; batches may interleave players. It excludes rank/history/RR setup. The new run fetches the first ten accessible recent matches; the old deep check fetched up to ten shared Riot/Henrik matches. Different counts or match sets are not an exact page-for-page speed comparison.

Completed 115 upstream calls, with 1 HTTP 429s and 1 rejected/network calls. The workload stopped on the first rejected request; already in-flight calls were allowed to finish.

The earlier paced run saved 489 Riot calls with zero 429s; this unpaced run reached a rejection. The earlier Henrik-backed proxy saved two 429s, plus one separately recorded 429. Those phases and workloads differ, and the proxy shares quota with live visitors, so they do not provide a numeric Henrik capacity ceiling to compare with this run. This experiment does not establish authentication-renewal capacity, longer-window limits, per-account/IP/region partitioning, or long-term session reliability.
