# Cloudflare remote Riot authentication experiment

The isolated Pages endpoint is `POST /riot-probe/run?mode=auth|content|player|custom`.
Open `/riot-probe.html` to run the stages. It returns HTTP status and count
summaries only. It does not change the HenrikDev frontend or persist Riot data.
Missing enablement or access-key configuration returns 404 without contacting Riot.

## Preview configuration

In Cloudflare → Workers & Pages → vlravg → Settings → Variables and Secrets,
select **Preview** and set:

| Binding | Type | Value |
| --- | --- | --- |
| `RIOT_PROBE_ENABLED` | Variable | `true` |
| `RIOT_PROBE_KEY` | Secret | Random access key, at least 32 characters; enter this on the test page |
| `RIOT_EXPECTED_RIOT_ID` | Secret | Dedicated test account `name#tag` |
| `RIOT_SSID` | Secret | `ssid` from that account's interactive Riot sign-in |
| `RIOT_SHARD` | Variable | `eu`, `na`, `ap`, `kr`, or `pbe`; defaults to `eu` |
| `RIOT_CLIENT_VERSION` | Variable | Current Riot client version; needed after authentication stage |
| `RIOT_TARGET_PUUID` | Secret, optional | Consenting player's PUUID; omit to test the dedicated account |

`RIOT_AUTH_COOKIES` can replace `RIOT_SSID` with the complete Cookie header.
Never enter the Riot cookie on the test page, in chat, or in committed files.
Use the dedicated account described in [the prototype guide](riot-client-prototype.md).
Preview settings apply to preview deployments across the project, not just this
branch. Keep these experiment bindings absent from Production.

Redeploy the preview after changing bindings. Session renewal happens on each
test and uses manual redirects; an expired cookie requires interactive sign-in.
Rotated response cookies are not persisted, so this verifies remote access,
not a durable unattended session-refresh design.

For client version, use the installed client's log or inspect
`https://valorant-api.com/v1/version` → `data.riotClientVersion`.

## Test sequence

1. Enter the probe access key and run Authentication. Success verifies cookie
   renewal, dedicated account identity, and entitlement issuance.
2. Run Content to check Riot service access with the client headers.
3. Run Player data for MMR, 20 history entries, up to 20 RR updates, and one
   match detail. A history 404 leaves data availability unverified.
4. Optionally run Custom history for up to 20 custom entries and one detail.

Requests stop on rejection or timeout; no retries, pagination loop, raw upstream
errors, token responses, quota headers, or arbitrary target URLs are exposed.
Each upstream request has a 15-second timeout. This is a manually invoked
experiment, not a public API or a measurement of sustainable request capacity.

Disable by setting `RIOT_PROBE_ENABLED=false` and redeploying; remove preview
cookie secrets when the experiment ends.

## Cached-player comparison

The **Compare cached players** button uses `POST /riot-probe/benchmark?index=0`
through index 23. It uses `RIOT_PROBE_KEY` (or a separate `RIOT_BENCH_KEY` if
configured), and reads the existing cache using the Preview `APP_DB` binding.
There is no fixed target-PUUID requirement for this mode. The current preview
contains the frozen 24-player sample from the recorded experiment; the source
handler can sample PC players directly from `rr_players`, spread across regions.
Names and PUUIDs stay server-side; results contain only a player hash and summaries.

Each player comparison uses paced, sequential requests to Riot and the production
HenrikDev proxy. The UI stops at the first 429; it is not a concurrency stress
test. The comparison also probes an older history range; a 400 for an out-of-range
page should not be interpreted as a failed ordinary player lookup. Add `deep=true`
to the endpoint for up to ten shared full details and history/RR page-two checks.

Recorded results and limitations are in [the benchmark report](riot-vs-henrik-benchmark.md).

## Unpaced Riot workload

`POST /riot-probe/unpaced?batch=0&concurrency=1` runs a finite Riot-only
workload with **no pacing or retry**. Batches 0–7 select three of the same
24 cached PC players; concurrency is restricted to 1, 2 or 4. It uses the
same enablement and access-key configuration as the comparison endpoint.
Authentication is renewed once per batch and reused for its data requests.
Each player gets MMR, 20 history IDs, 20 RR updates and up to ten full details.
The batch stops scheduling on the first rejection or network failure;
already in-flight calls may finish. At most 43 upstream calls occur per batch.
Player identities, credentials and raw responses stay server-side.

The recorded run stopped at its first 429 during the sequential stage; the
planned concurrent stages were not run. Its timings are compared with the
saved Henrik benchmark in [the unpaced report](riot-unpaced-benchmark.md).

## Validation

### Controlled header and rate experiment

`POST /riot-probe/capacity?op=start` creates an EU match-detail test session.
The server discovers up to twenty match IDs from one cached EU sample.
It returns an opaque session ID and safe setup metrics, never Riot credentials.
Session state is encrypted with AES-GCM under the configured probe secret in
the datacenter-local Cache API and expires after fifteen minutes.

`POST /riot-probe/capacity?op=run&session=<id>&phase=burst1|burst2|steady`
performs at most forty sequential detail reads per frame, capped at two hundred
per phase and six hundred per session. Burst phases have no deliberate spacing;
steady spaces dispatches by one second across frames. Every response records
application/method limit/count headers, legacy headers, numeric structured
rate fields, and Retry-After when present. Opaque partition identifiers and
arbitrary response text are excluded. Requests stop at the first rejection.
A 429 blocks session dispatch for at least 120 seconds, or Retry-After when
longer. The local experiment runner waits another five seconds between phases.

The same session must remain available in the same datacenter. A cache miss,
session expiry, changed datacenter or non-rate failure ends the experiment.
`POST /riot-probe/capacity?op=finish&session=<id>` deletes the temporary state.
This isolated sequential runner is not a production distributed rate limiter.

The observed results are in [the controlled measurement](riot-capacity-measurement.md).
Run its local mocked checks with:

```powershell
node --test --test-isolation=none tests/riot-capacity-probe.test.mjs
```

```powershell
node --test --test-isolation=none tests/riot-remote-probe.test.mjs
```

These mocked checks cover disabled/unauthorized access, correct cookie renewal,
identity mismatch, unexpected redirects, bounded player reads, empty history,
and secret-safe failures. They do not prove Cloudflare-to-Riot live access.

Cloudflare references: [Pages secrets](https://developers.cloudflare.com/pages/functions/bindings/#secrets)
and [Pages deployment commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/).
