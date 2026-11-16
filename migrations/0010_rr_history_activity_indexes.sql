-- Index the collector's activity query (.github/scripts/rr-activity-query.mjs).
-- latest_season orders rr_history by date; season_start finds the first game of
-- that act. Both previously parsed every row's JSON (~1.6M rows read, 3-7 s)
-- and D1 rejected the startup query as overloaded (7429). See docs/rr-corpus.md.
CREATE INDEX IF NOT EXISTS rr_history_date ON rr_history(date);
CREATE INDEX IF NOT EXISTS rr_history_season_date ON rr_history(LOWER(json_extract(data,'$.season.id')),date);
