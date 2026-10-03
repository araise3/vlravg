-- Additive: preserve every raw payout and existing match archive.
CREATE TABLE IF NOT EXISTS rr_collection (
  puuid TEXT NOT NULL,
  platform TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  head_match_id TEXT,
  window_ids TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  possible_gaps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (puuid,platform)
);
CREATE TABLE IF NOT EXISTS rr_match_features (
  puuid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  started_at TEXT,
  data TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (puuid,match_id)
);
CREATE INDEX IF NOT EXISTS rr_features_season ON rr_match_features(season_id,puuid);
CREATE TABLE IF NOT EXISTS rr_feature_retry (
  puuid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT NOT NULL,
  PRIMARY KEY (puuid,match_id)
);
-- Consecutive games witnessed together in a real rolling-window response.
-- This avoids treating two arbitrarily separated database rows as adjacent.
CREATE TABLE IF NOT EXISTS rr_predecessors (
  puuid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  previous_match_id TEXT NOT NULL,
  PRIMARY KEY (puuid,match_id)
);
