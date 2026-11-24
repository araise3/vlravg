-- Runtime cost measurement removed (lib/upstream-cost.mjs uses a fixed
-- table; docs/profile-quota-reserve.md). Apply after the code that stops
-- writing these columns is deployed: older code re-adds them lazily.
DROP TABLE IF EXISTS quota_cost_samples;
ALTER TABLE rate_quota DROP COLUMN prev_request_at;
ALTER TABLE rate_quota DROP COLUMN observed_request_at;
ALTER TABLE rate_quota DROP COLUMN header_remaining;
ALTER TABLE rate_quota DROP COLUMN header_reset_at;
ALTER TABLE workflow_rate_quota DROP COLUMN prev_request_at;
ALTER TABLE workflow_rate_quota DROP COLUMN observed_request_at;
ALTER TABLE workflow_rate_quota DROP COLUMN header_remaining;
ALTER TABLE workflow_rate_quota DROP COLUMN header_reset_at;
