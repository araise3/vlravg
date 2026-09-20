-- Shared, trusted match data for the current-act browser replacement.
CREATE TABLE IF NOT EXISTS match_archive (
  puuid TEXT NOT NULL,
  season_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  started_at TEXT,
  payload BLOB NOT NULL,
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX IF NOT EXISTS idx_match_archive_player_season
  ON match_archive(puuid, season_id, started_at DESC, match_id DESC);
