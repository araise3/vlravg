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
state lives in `workflow_rate_quota`; visitors keep using `rate_quota`. The new
table is created automatically on first upstream workflow use in existing D1
deployments, so no manual migration is required.

The workflow concurrency lock and request scheduler remain shared between the
three Henrik jobs. The key's 30 requests/minute allowance is paced at one start
every 2.1 seconds, at most 29 starts per rolling minute. Limited manual refresh
runs (`max_players` greater than zero) do not launch a full historical backfill.
Upstream quota headers stay server-side; clients only receive
the existing `retryAfterMs` body on a 429.
