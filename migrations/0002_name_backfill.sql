-- Historical evidence is separate from authoritative current-account checks.
CREATE TABLE IF NOT EXISTS player_name_matches (
  puuid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  played_at TEXT NOT NULL,
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX IF NOT EXISTS player_name_matches_dates ON player_name_matches(puuid,played_at);
CREATE TABLE IF NOT EXISTS player_name_backfill (
  puuid TEXT NOT NULL,
  region TEXT NOT NULL,
  platform TEXT NOT NULL,
  next_start INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (puuid,region,platform)
);
