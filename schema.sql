-- All persistent app state (D1) — replaces RATE_LIMIT_KV entirely: rate-limit
-- quota, RR-history persistence, and Hidden-MMR live calibration. Run once
-- against a new D1 database:
--   npx wrangler d1 execute <DB_NAME> --remote --file=schema.sql
-- (drop --remote for local dev only). See functions/api/[[path]].js's header
-- comment for the APP_DB binding this expects.

-- Rate-limit quota state (was KV key "quota") — single row, id always 1.
CREATE TABLE IF NOT EXISTS rate_quota (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  remaining INTEGER,
  reset_at INTEGER,
  last_request_at INTEGER
);
INSERT OR IGNORE INTO rate_quota (id, remaining, reset_at, last_request_at) VALUES (1, NULL, 0, 0);

-- RR-history persistence (was KV key "rrhist:{puuid}", one JSON blob per
-- player). One row per match instead of one blob per player — a fresh
-- upstream entry for an existing match_id just overwrites via ON CONFLICT,
-- so merging needs no read-modify-write of a whole blob the way KV did.
-- `data` keeps the raw HenrikDev entry as JSON rather than exploding every
-- field into its own column, since that shape isn't ours to control.
CREATE TABLE IF NOT EXISTS rr_history (
  puuid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  data TEXT NOT NULL,
  date TEXT,
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX IF NOT EXISTS idx_rr_history_puuid_date ON rr_history(puuid, date);

-- Player identity, so the 12h refresh job (refresh-rr-history.mjs) can list
-- who to re-ping without scanning rr_history — replaces the KV-metadata
-- trick the old cheap-listing relied on.
CREATE TABLE IF NOT EXISTS rr_players (
  puuid TEXT PRIMARY KEY,
  region TEXT,
  platform TEXT,
  name TEXT,
  tag TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS calib_bands (
  lo INTEGER PRIMARY KEY,
  hi INTEGER NOT NULL,
  n_win REAL NOT NULL DEFAULT 0,
  n_loss REAL NOT NULL DEFAULT 0,
  Sww REAL NOT NULL DEFAULT 0,
  Sll REAL NOT NULL DEFAULT 0,
  Swz REAL NOT NULL DEFAULT 0,
  Slz REAL NOT NULL DEFAULT 0,
  Szz REAL NOT NULL DEFAULT 0,
  Swy REAL NOT NULL DEFAULT 0,
  Sly REAL NOT NULL DEFAULT 0,
  Szy REAL NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- One row per HMM_BANDS/FROZEN_BANDS entry — pre-seeded so runtime code only
-- ever UPDATEs (never needs an upsert/insert path). Immortal+/Radiant is
-- split three ways (24, 25, 26-27) rather than one merged 24-27 row — see
-- the comment above FROZEN_BANDS in functions/api/[[path]].js for why.
INSERT OR IGNORE INTO calib_bands (lo, hi) VALUES
  (3, 5), (6, 8), (9, 11), (12, 14), (15, 17), (18, 20), (21, 23), (24, 24), (25, 25), (26, 27);

-- Resetting the live calibration. calib_bands holds running SUMS of a
-- regressand built from the frozen constants of the day (y = last_change −
-- s·(1−pen)·S·max(0,rd−K) − U·gap, see foldCalibration). Change S, K or U in
-- FROZEN_BANDS and every sum already in this table refers to a different
-- model — and CALIB_DECAY (0.9999/fold) means the stale part effectively
-- never ages out on its own. So on any deploy that moves those constants,
-- zero the accumulator once:
--   npx wrangler d1 execute <DB_NAME> --remote --command \
--     "UPDATE calib_bands SET n_win=0,n_loss=0,Sww=0,Sll=0,Swz=0,Slz=0,Szz=0,Swy=0,Sly=0,Szy=0,updated_at=NULL;"
-- The card keeps working throughout — an empty accumulator just means
-- /api/calib-model serves the frozen constants until live data rebuilds.
-- Leave calib_seen alone; it's per-match dedup, not model state.

-- Per-player dedup so re-looking-up someone doesn't double-fold a match
-- already counted. A relational table, not a KV JSON blob, so there's no
-- single-value size cap to manage — old rows just accumulate; storage is
-- cheap (5 GB free tier) and this table only ever grows a few dozen bytes
-- per real ranked match ever played across all looked-up players.
CREATE TABLE IF NOT EXISTS calib_seen (
  puuid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (puuid, match_id)
);
