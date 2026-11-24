-- Public quota audit rows keep each call's estimated HenrikDev units
-- (lib/upstream-cost.mjs, docs/profile-quota-reserve.md). The proxy also adds
-- the column lazily.
ALTER TABLE public_quota_audit ADD COLUMN cost INTEGER;
