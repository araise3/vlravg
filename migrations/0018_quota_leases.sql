-- Calls in flight hold their maximum HenrikDev cost as leases in the quota
-- row (lib/upstream-pacing.mjs, docs/profile-quota-reserve.md). The gate also
-- adds the column lazily.
ALTER TABLE rate_quota ADD COLUMN leases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflow_rate_quota ADD COLUMN leases TEXT NOT NULL DEFAULT '[]';
