-- Store compressed historical name periods in the existing cursor row. Legacy
-- player_name_matches evidence remains readable, but new pages need only one
-- unindexed row update instead of separate table and index writes.
ALTER TABLE player_name_backfill ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';
