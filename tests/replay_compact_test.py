"""Checks scripts/replay-compact.py on a small synthetic vrfkit export.

Run: .venv-replay/Scripts/python.exe tests/replay_compact_test.py
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import duckdb

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("replay_compact", ROOT / "scripts/replay-compact.py")
compact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compact)

MATCH = "a27d4487-c781-4b73-8a9e-f4a468139bba"
A, B = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
AGENT = "22697a3d-45bf-8dd7-4fec-84a9e28c69d7"


def export(root: Path, friendly=MATCH):
    root.mkdir(parents=True, exist_ok=True)
    loadouts = json.dumps({"playerLoadouts": [{"subject": A, "characterId": AGENT}, {"subject": B, "characterId": "x"}]})
    (root / "manifest.json").write_text(json.dumps({
        "friendly_name": friendly, "replay_build": "++Ares-Core+release-13.08", "duration_ms": 60000,
        "timestamp_ticks": 639275987627950000, "level_names_and_times": [{"name": "/Game/Maps/Duality/Duality", "time_ms": 0}],
        "game_specific_data": ['{"serializedVersion": 2}', loadouts],
        "players": [{"subject": A, "character_net_guid": 20, "character_net_guids": [10, 20]},
                    {"subject": B, "character_net_guid": 30, "character_net_guids": [30]}],
        "quality": {"content_blocks_lost": 0, "movement_rows": 6, "event_rows": 4, "net": {"malformed_packets": 0, "transform_failures": 0}},
    }), encoding="utf-8")
    con = duckdb.connect()
    con.execute("""COPY (SELECT * FROM (VALUES
        ('e1', 'roundStarted', 100::UINTEGER, 0::UINTEGER, NULL::UINTEGER),
        ('e2', 'characterDeath', 5000, 30, 10),
        ('e3', 'characterDeath', 6000, 99, 20),
        ('e4', 'characterUltimateUsed', 7000, 30, NULL),
        ('e5', 'spikePlanted', 8000, NULL, NULL)) t(id, "group", time1, word0, word1)) TO '%s' (FORMAT parquet)""" % (root / "events.parquet").as_posix())
    con.execute("""COPY (SELECT * FROM (VALUES
        (100::UINTEGER, 1::UINTEGER, 10::UINTEGER, 100.4::FLOAT, 200.0::FLOAT, 10.0::FLOAT, 90.2::FLOAT),
        (200, 2, 10, 101.0, 200.0, 10.0, 91.0),
        (300, 3, 20, 150.0, 210.0, 10.0, 359.7),
        (300, 4, 30, -5.0, -6.0, 0.0, 0.0),
        (900, 5, 30, 'inf'::FLOAT, 0.0, 0.0, 0.0),
        (100, 6, 77, 1.0, 1.0, 1.0, 1.0)) t(time_ms, packet_id, character_net_guid, pos_x, pos_y, pos_z, yaw)) TO '%s' (FORMAT parquet)""" % (root / "movement.parquet").as_posix())
    con.close()
    return root


class ReplayCompactTest(unittest.TestCase):
    def build(self, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            return compact.build(export(Path(tmp) / "export", **kwargs), MATCH, 64, "0" * 64, "b9496df61c40fa304d4f539689c1dd627804946e")

    def test_players_events_and_identity(self):
        doc = self.build()
        self.assertEqual(doc["players"], [{"subject": A, "character_id": AGENT}, {"subject": B, "character_id": None}])
        # (killer, killed): B killed A's first pawn; an unknown killer stays -1.
        self.assertEqual(doc["events"]["kills"], [[5000, 1, 0], [6000, -1, 0]])
        self.assertEqual(doc["events"]["ultimates"], [[7000, 1]])
        self.assertEqual(doc["events"]["rounds"], [[100, 0]])
        self.assertEqual(doc["events"]["plants"], [8000])
        self.assertEqual(doc["replay"]["map_path"], "/Game/Maps/Duality/Duality")

    def test_movement_is_bucketed_rounded_and_delta_encoded(self):
        tracks = {t["player"]: t["samples"] for t in self.build()["movement"]["tracks"]}
        # Player 0: buckets 0 (t=200 wins over t=100) and 1 (second pawn).
        # Yaw 359.7 rounds to 360 and wraps to 0. Non-finite rows are dropped.
        self.assertEqual(tracks[0], [0, 101, 200, 10, 91, 1, 49, 10, 0, -91])
        self.assertEqual(tracks[1], [1, -5, -6, 0, 0])

    def test_wrong_embedded_match_is_refused(self):
        with self.assertRaises(SystemExit):
            self.build(friendly="bd2ea657-0865-4cd7-934c-f6478cd43a64")


if __name__ == "__main__":
    unittest.main()
