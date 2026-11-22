-- Match payloads move to R2 (MATCH_BUCKET); D1 keeps the per-player index.
-- payload stays NOT NULL and is emptied (X'') once a row's match is in R2;
-- bytes records the object's compressed size for the archive page budget.
-- See docs/match-archive-r2.md.
ALTER TABLE match_archive ADD COLUMN bytes INTEGER;
