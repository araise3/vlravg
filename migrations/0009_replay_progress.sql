-- Live pipeline progress for the Replays page (header build, dispatch, parser
-- run, decode time, supported builds), as JSON (docs/replay-import.md).
ALTER TABLE replay_imports ADD COLUMN progress TEXT;
