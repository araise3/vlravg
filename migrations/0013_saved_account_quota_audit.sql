-- Saved profiles open while the public quota is spent, and why it was spent
-- (docs/profile-quota-reserve.md).
CREATE INDEX IF NOT EXISTS player_name_history_current_riot_id
  ON player_name_history(lower(name),lower(tag)) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS public_quota_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  event TEXT NOT NULL,
  route TEXT NOT NULL,
  profile INTEGER NOT NULL DEFAULT 0,
  gate_remaining INTEGER,
  header_remaining INTEGER,
  reset_in_ms INTEGER,
  retry_after_ms INTEGER,
  served_saved INTEGER
);
CREATE INDEX IF NOT EXISTS public_quota_audit_observed ON public_quota_audit(observed_at);
