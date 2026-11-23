-- Gap-free RR history (docs/rr-collector-gap-healing.md).
--
-- The live mmr-history window lists only the ranked games among a player's
-- last 20 matches of any mode. When a poll's window does not reach the newest
-- payout already saved, games in between may have dropped out of it. The poll
-- records that as an rr_gaps row in the same batch as the window, and the
-- collector fills it from HenrikDev's stored RR history (same entry shape,
-- paginated over the whole history) through /api/rr-heal.
CREATE TABLE IF NOT EXISTS rr_gaps (
  puuid TEXT NOT NULL,
  after_match_id TEXT NOT NULL,   -- newest saved payout before the gap
  after_date TEXT NOT NULL,
  before_match_id TEXT,           -- first payout after the gap (NULL: the window was empty)
  before_date TEXT NOT NULL,      -- its date, or the check time for an empty window
  region TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'window': a poll did not connect; 'scan': a rank discontinuity in saved history
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | incomplete | connected | healed | unresolved
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  recovered INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  PRIMARY KEY (puuid,after_match_id)
);
CREATE INDEX IF NOT EXISTS rr_gaps_queue ON rr_gaps(status,next_attempt_at);

-- Oldest payout date and size of the last live window: how fast the player's
-- last 20 matches (any mode) turn over, for the polling interval.
ALTER TABLE rr_collection ADD COLUMN window_from TEXT;

-- Small collector bookkeeping (last daily audit).
CREATE TABLE IF NOT EXISTS rr_collector_state (
  name TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
