-- User-uploaded VALORANT replays (docs/replay-import.md). Kept apart from the
-- trusted HenrikDev evidence: nothing here is written into match_archive,
-- rr_history or the corpus. Raw files and compact results live in R2
-- (REPLAY_BUCKET); D1 only indexes them. The removed September prototype used
-- a table named replay_uploads, so this one has its own name.
CREATE TABLE IF NOT EXISTS replay_imports (
  match_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('uploading','pending','parsing','parsed','failed','rejected')),
  uploads INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT,
  upload_id TEXT,
  raw_key TEXT,
  declared_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  claim_id TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  parsed_at TEXT,
  error TEXT,
  summary TEXT,
  compact_key TEXT,
  compact_sha256 TEXT,
  compact_bytes INTEGER,
  export_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_replay_imports_queue ON replay_imports(status, uploaded_at);

CREATE TABLE IF NOT EXISTS replay_import_parts (
  match_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (match_id, part_number)
);

-- Full vrfkit exports (all tables, with checkpoints) of parsed replays, stored
-- opaque in R2 under export/<match>/ for offline line-of-sight research.
CREATE TABLE IF NOT EXISTS replay_export_files (
  match_id TEXT NOT NULL,
  name TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  upload_id TEXT,
  object_key TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, name)
);
CREATE TABLE IF NOT EXISTS replay_export_parts (
  match_id TEXT NOT NULL,
  name TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (match_id, name, part_number)
);

-- Daily upload budgets: scope is 'global' or a day-salted hash of the IP.
CREATE TABLE IF NOT EXISTS replay_import_quota (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  uploads INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);

-- Upload eligibility looks a match up by ID alone.
CREATE INDEX IF NOT EXISTS idx_match_archive_match ON match_archive(match_id);
