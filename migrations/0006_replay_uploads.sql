-- Apply to the existing APP_DB before enabling replay uploads.
-- Original files are stored privately in R2; this table is only an index.
CREATE TABLE IF NOT EXISTS replay_uploads (
  match_id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_parser', 'parsed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_replay_uploads_uploaded_at ON replay_uploads(uploaded_at DESC);
