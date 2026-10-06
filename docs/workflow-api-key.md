# Dedicated workflow API key

Save the separate HenrikDev `HDEV-…` API key under **`HENRIK_WORKFLOW_KEY`** in
both places:

1. GitHub repository → Settings → Secrets and variables → Actions → New repository secret.
2. Cloudflare Pages project → Settings → Variables and Secrets → Production → Add,
   using an encrypted secret.

Deploy the updated Pages Function after setting the Cloudflare secret, then run
the updated workflows. The two secret values must match. Keep `HENRIK_KEY` in
Cloudflare for ordinary visitors.

Refresh names/RR, collect RR corpus, and historical name backfill all require the
new secret. The snapshot workflow only reads D1 and needs no HenrikDev key.
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

The workflow concurrency lock and request scheduler remain shared between the
three Henrik jobs. Cloudflare atomically reserves a slot immediately before each
real Henrik call, with at least 2.1 seconds between admissions (at most 29 per
rolling minute). Known remaining quota is reserved for in-flight calls, and
headers can stretch spacing or pause the gate until reset. Late responses cannot
restore capacity already reserved by newer calls; a real 429 pauses upstream
callers using that key even when its response arrives late. Public and workflow
cooldowns never consume or pause each other's capacity.

The workflow client has no fixed wait or global cooldown. D1-only responses run
immediately, including during an upstream cooldown. Each throttled request retries
using `retryAfterMs`. Cloudflare waits for a slot for up to eight seconds before
returning that retry signal; quota exhaustion returns it immediately. Failed gate
storage returns 503 without making an upstream call. Limited manual refresh runs
(`max_players` greater than zero) do not launch a full historical backfill.

Before sending work, each client performs one authenticated, D1-only readiness
probe and requires `X-Workflow-Pacing: upstream-v1`. It fails safely if the new
proxy is not deployed yet, rather than sending unpaced traffic to an old version.

Upstream quota headers stay server-side; clients only receive the existing
`retryAfterMs` body on a 429. Atomic D1 admission coordinates all proxy callers;
it does not control other software independently using the same Henrik key or
eliminate network timing variation between admission and upstream arrival.
