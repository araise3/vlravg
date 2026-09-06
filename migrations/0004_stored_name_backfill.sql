-- Supplement the full-match scan with HenrikDev's separately retained archive.
-- Existing full-match completions intentionally start this new phase unfinished.
ALTER TABLE player_name_backfill ADD COLUMN stored_page INTEGER NOT NULL DEFAULT 1;
ALTER TABLE player_name_backfill ADD COLUMN stored_scanned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_name_backfill ADD COLUMN stored_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_name_backfill ADD COLUMN stored_pending TEXT NOT NULL DEFAULT '[]';
