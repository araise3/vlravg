"""Reduce one vrfkit export to the site's compact replay format (version 1).

Runs inside the sandboxed parse job (no network, no secrets). Reads only the
export's manifest.json, events.parquet and movement.parquet and writes one JSON
document. Every value comes from the replay itself; nothing here is HenrikDev
data, and the Function re-validates the result before storing it.

Format: docs/replay-import.md. Kills follow vrfkit's documented characterDeath
order (word0 killer, word1 killed NetGUID); movement keeps the last sample of
each player in every 250 ms bucket, rounded to whole cm and whole degrees.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

import duckdb

FORMAT = "vlravg.replay-compact"
VERSION = 1
INTERVAL_MS = 250
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
QUALITY_KEYS = ("content_blocks_lost", "movement_rows", "event_rows")


def uuid_or_none(value):
    value = str(value or "").strip().lower()
    return value if UUID.match(value) else None


def loadouts(manifest):
    """Agent UUID per subject, from game_specific_data's playerLoadouts JSON."""
    agents = {}
    for blob in manifest.get("game_specific_data") or []:
        try:
            data = json.loads(blob) if isinstance(blob, str) else blob
        except ValueError:
            continue
        for row in (data or {}).get("playerLoadouts") or [] if isinstance(data, dict) else []:
            subject = uuid_or_none(row.get("subject"))
            if subject:
                agents[subject] = uuid_or_none(row.get("characterId"))
    return agents


def delta_encode(rows):
    """[(tick, x, y, z, yaw)] -> flat deltas against the previous sample."""
    out, previous = [], (0, 0, 0, 0, 0)
    for row in rows:
        out.extend(value - before for value, before in zip(row, previous))
        previous = row
    return out


def build(export: Path, match_id: str, source_bytes: int, source_sha256: str, revision: str, patch=None):
    manifest = json.loads((export / "manifest.json").read_text(encoding="utf-8"))
    embedded = uuid_or_none(manifest.get("friendly_name"))
    if embedded != match_id:
        raise SystemExit(f"replay match ID {embedded} does not match {match_id}")
    agents = loadouts(manifest)
    players, by_guid = [], {}
    for row in manifest.get("players") or []:
        subject = uuid_or_none(row.get("subject"))
        if not subject or any(p["subject"] == subject for p in players):
            continue
        index = len(players)
        players.append({"subject": subject, "character_id": agents.get(subject)})
        for guid in row.get("character_net_guids") or [row.get("character_net_guid")]:
            if isinstance(guid, int) and guid > 0:
                by_guid[guid] = index
    quality = manifest.get("quality") or {}
    net = quality.get("net") or {}

    con = duckdb.connect(config={"threads": 2})
    events = con.execute(
        'SELECT "group", time1, word0, word1 FROM read_parquet(?) ORDER BY time1, id',
        [str(export / "events.parquet")]).fetchall()
    who = lambda guid: by_guid.get(guid, -1)
    timeline = {"rounds": [], "kills": [], "plants": [], "defuses": [], "detonations": [],
                "ultimates": [], "switch_teams": []}
    for group, time_ms, word0, word1 in events:
        if time_ms is None:
            continue
        if group == "roundStarted":
            timeline["rounds"].append([time_ms, word0 if word0 is not None else -1])
        elif group == "characterDeath":
            timeline["kills"].append([time_ms, who(word0), who(word1)])
        elif group == "characterUltimateUsed":
            timeline["ultimates"].append([time_ms, who(word0)])
        elif group == "spikePlanted":
            timeline["plants"].append(time_ms)
        elif group == "spikeDefused":
            timeline["defuses"].append(time_ms)
        elif group == "spikeExploded":
            timeline["detonations"].append(time_ms)
        elif group == "switchTeams":
            timeline["switch_teams"].append(time_ms)

    tracks = []
    guids = sorted(by_guid)
    if guids:
        # Last finite sample per character per bucket; ties keep the later packet.
        rows = con.execute(f"""
            SELECT character_net_guid, time_ms // {INTERVAL_MS} AS tick,
                   arg_max(round(pos_x), (time_ms, packet_id)), arg_max(round(pos_y), (time_ms, packet_id)),
                   arg_max(round(pos_z), (time_ms, packet_id)), arg_max(round(yaw) % 360, (time_ms, packet_id))
            FROM read_parquet(?)
            WHERE character_net_guid IN ({",".join("?" * len(guids))})
              AND isfinite(pos_x) AND isfinite(pos_y) AND isfinite(pos_z) AND isfinite(yaw)
            GROUP BY ALL ORDER BY 1, 2""", [str(export / "movement.parquet"), *guids]).fetchall()
        per_player = {}
        for guid, tick, x, y, z, yaw in rows:
            # A reconnect gives one player two pawns; keep one sample per bucket.
            samples = per_player.setdefault(by_guid[guid], {})
            samples[int(tick)] = (int(tick), int(x), int(y), int(z), int(yaw))
        for index in sorted(per_player):
            ordered = [per_player[index][t] for t in sorted(per_player[index])]
            tracks.append({"player": index, "samples": delta_encode(ordered)})
    con.close()

    levels = manifest.get("level_names_and_times") or [{}]
    return {
        "format": FORMAT, "version": VERSION, "match_id": match_id,
        "source": {"bytes": source_bytes, "sha256": source_sha256},
        "decoder": {"name": "vrfkit", "revision": revision, "patch": patch},
        "replay": {"build": str(manifest.get("replay_build") or "")[:64],
                   "map_path": str(levels[0].get("name") or "")[:128],
                   "duration_ms": int(manifest.get("duration_ms") or 0),
                   "recorded_ticks": str(manifest.get("timestamp_ticks") or "")},
        "quality": {**{key: int(quality.get(key) or 0) for key in QUALITY_KEYS},
                    "malformed_packets": int(net.get("malformed_packets") or 0),
                    "transform_failures": int(net.get("transform_failures") or 0)},
        "players": players,
        "events": timeline,
        "movement": {"interval_ms": INTERVAL_MS, "encoding": "delta-v1", "tracks": tracks},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--match-id", required=True)
    parser.add_argument("--source-bytes", type=int, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--decoder-revision", required=True)
    parser.add_argument("--decoder-patch", default="", help="SHA-256 of the patch applied to vrfkit, if any")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    compact = build(args.export, args.match_id.lower(), args.source_bytes,
                    args.source_sha256.lower(), args.decoder_revision.lower(),
                    args.decoder_patch.lower() or None)
    args.out.write_text(json.dumps(compact, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
