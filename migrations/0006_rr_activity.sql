-- A bounded discovery budget records only participants of recent trusted
-- ranked matches. Duplicate fetches never count as additional games.
CREATE TABLE IF NOT EXISTS rr_candidate_games (
  puuid TEXT NOT NULL,
  platform TEXT NOT NULL,
  match_id TEXT NOT NULL,
  region TEXT NOT NULL,
  tier INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (puuid,platform,match_id)
);
CREATE INDEX IF NOT EXISTS rr_candidate_recent ON rr_candidate_games(played_at,puuid,platform);
CREATE TABLE IF NOT EXISTS rr_candidate_checks (
  puuid TEXT NOT NULL,
  platform TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(puuid,platform)
);
