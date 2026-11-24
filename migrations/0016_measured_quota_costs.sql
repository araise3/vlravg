-- Measure each upstream call's HenrikDev units instead of estimating them
-- (lib/upstream-cost.mjs, docs/profile-quota-reserve.md). The gate also adds
-- the quota columns and the samples table lazily.
ALTER TABLE rate_quota ADD COLUMN prev_request_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rate_quota ADD COLUMN observed_request_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rate_quota ADD COLUMN header_remaining INTEGER;
ALTER TABLE rate_quota ADD COLUMN header_reset_at INTEGER;
ALTER TABLE workflow_rate_quota ADD COLUMN prev_request_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_rate_quota ADD COLUMN observed_request_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_rate_quota ADD COLUMN header_remaining INTEGER;
ALTER TABLE workflow_rate_quota ADD COLUMN header_reset_at INTEGER;
CREATE TABLE IF NOT EXISTS quota_cost_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  pool TEXT NOT NULL,
  route TEXT NOT NULL,
  cache_status TEXT,
  status INTEGER,
  cost INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_cost_samples_route ON quota_cost_samples(route,id);
CREATE INDEX IF NOT EXISTS quota_cost_samples_observed ON quota_cost_samples(observed_at);
