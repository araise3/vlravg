# Dedicated workflow API key

Save the separate HenrikDev `HDEV-…` API key under **`HENRIK_WORKFLOW_KEY`** in
both places:

1. GitHub repository → Settings → Secrets and variables → Actions → New repository secret.
2. Cloudflare Pages project → Settings → Variables and Secrets → Production → Add,
   using an encrypted secret.

Deploy the updated Pages Function after setting the Cloudflare secret, then run
the updated workflows. The two secret values must match. Keep `HENRIK_KEY` in
Cloudflare for ordinary visitors.

`Collect act RR corpus` is the only remaining workflow and requires this secret.
Missing workflow secrets fail explicitly; jobs do not fall back to the public key.

Jobs authenticate to the existing proxy over HTTPS using `X-Workflow-Key`. The
proxy verifies that credential before reading stored data or contacting HenrikDev,
then uses its configured `HENRIK_WORKFLOW_KEY` upstream. The workflow request
scheduler restricts the credential to `SITE_ORIGIN` under `/api/` and refuses
redirects. The credential never appears in query strings or cache keys.

Workflow requests bypass edge caching so collection sees fresh upstream data.
They still use all existing RR, name-history, and match persistence. Their quota
and atomic admission schedule live in `workflow_rate_quota`; visitors use a
separate atomic gate in `rate_quota`. Both tables and their `next_start_at` columns
are created or upgraded automatically on first upstream use, preserving existing
quota state, so no manual migration is required.

Public calls learn their own key's allowance from its remaining/reset headers.
Known capacity is spread across the remaining window with 5% timing headroom and
a 150ms minimum spacing. Until usable quota headers arrive, or after the known
window expires, public admissions use a conservative 2.1-second fallback. This
does not assume the public key has the workflow key's 30/minute limit, and a
higher public allowance can produce faster admissions. Missing headers never
erase known, reserved quota. Cache hits and D1-only responses bypass both gates,
including while either key is exhausted. No new secret or setting is required.

The workflow concurrency lock serializes scheduled and manual collector runs. Cloudflare atomically reserves a slot immediately before each
real Henrik call, with at least 2.1 seconds between admissions (at most 29 per
rolling minute). Known remaining quota is reserved for in-flight calls, and
headers can stretch spacing or pause the gate until reset. Late responses cannot
restore capacity already reserved by newer calls; a real 429 pauses upstream
callers using that key even when its response arrives late. Public and workflow
cooldowns never consume or pause each other's capacity.

The collector uses a FIFO request queue and shares proxy-requested cooldowns
across its workers. The proxy remains the quota authority. Other script callers
retain immediate D1-only reads, including during an upstream cooldown. Each throttled request retries
using `retryAfterMs`. Cloudflare waits for a slot for up to eight seconds before
returning that retry signal; quota exhaustion returns it immediately. Failed gate
storage returns 503 without making an upstream call.

Before sending work, each client performs one authenticated, D1-only readiness
probe and requires `X-Workflow-Pacing: upstream-v1`. It fails safely if the new
proxy is not deployed yet, rather than sending unpaced traffic to an old version.

Upstream quota headers stay server-side; clients only receive the existing
`retryAfterMs` body on a 429. Atomic D1 admission coordinates all proxy callers;
it does not control other software independently using the same Henrik key or
eliminate network timing variation between admission and upstream arrival.

## Shared-key quota check

Every collector process sends a unique `X-Workflow-Run` identifier to the proxy.
It is never forwarded to HenrikDev. The proxy saves server-only counters in
`workflow_quota_audit`, created automatically on first use; no secret, binding
or manual migration is added. The collector reads a baseline and final snapshot
through its existing authenticated D1 access.

The Actions summary and collection report distinguish other proxy processes
active during the run from possible external usage. Each upstream response is
compared with the expected remaining quota after this proxy's own reservation.
An unexplained same-window decrease produces a warning. Missing headers,
superseded responses and samples near or across a reset are excluded; a three-
second tolerance allows rounded reset headers. Live remaining/reset values are
never included in public responses or the report.

These are diagnostic observations, not proof of exclusive key use. External
instances cannot be identified from rate-limit headers, and no comparable samples
is reported as insufficient evidence. Quota-read failures are reported as
unavailable. The check makes no extra upstream requests and does not stop RR
capture merely because another consumer is detected.
