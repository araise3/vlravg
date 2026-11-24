-- Search account lookups are answered live only; the saved-account answer
-- and its Riot-ID index are gone (docs/profile-quota-reserve.md).
DROP INDEX IF EXISTS player_name_history_current_riot_id;
