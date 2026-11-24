-- Waiting search account lookups claim the next public slot
-- (lib/upstream-pacing.mjs PRIORITY_CLAIM_MARGIN_MS,
-- docs/profile-quota-reserve.md). The proxy also adds it lazily.
ALTER TABLE rate_quota ADD COLUMN priority_until INTEGER NOT NULL DEFAULT 0;
