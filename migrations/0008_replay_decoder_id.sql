-- Records which parser build produced each result, so a decoder change can
-- re-queue uploads the previous build could not read (docs/replay-import.md).
ALTER TABLE replay_imports ADD COLUMN decoder_id TEXT;
