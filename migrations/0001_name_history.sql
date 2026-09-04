-- Safe to re-run; records observed dates, never an inferred account-creation date.
CREATE TABLE IF NOT EXISTS player_name_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  puuid TEXT NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  ended_at TEXT,
  CHECK (first_seen <= last_seen),
  CHECK (ended_at IS NULL OR ended_at >= last_seen)
);
CREATE UNIQUE INDEX IF NOT EXISTS player_name_history_current
  ON player_name_history(puuid) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS player_name_history_player_dates
  ON player_name_history(puuid,first_seen DESC);

-- The old player index only retained its latest identity observation.
-- Preserve that evidence without claiming knowledge of earlier names/dates.
INSERT INTO player_name_history (puuid,name,tag,first_seen,last_seen)
SELECT puuid,name,tag,updated_at,updated_at FROM rr_players p
WHERE name IS NOT NULL AND name<>'' AND tag IS NOT NULL AND tag<>''
  AND updated_at IS NOT NULL AND julianday(updated_at) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM player_name_history h WHERE h.puuid=p.puuid);
