"""Build a private, single-file round review from a vrfkit Parquet export.

Usage: python scripts/build-replay-review.py EXPORT_DIR OUTPUT_HTML
Requires duckdb (`python -m pip install duckdb`). Supports the Abyss map for
this first verified replay prototype. The output deliberately omits account IDs.
"""

import bisect
import collections
import json
import math
import re
import sys
from pathlib import Path

import duckdb


MAPS = {
    "/Game/Maps/Infinity/Infinity": {
        "name": "Abyss",
        "image": "https://media.valorant-api.com/maps/224b0a95-48b9-f703-1bd8-67aca101a61f/displayicon.png",
        "x_multiplier": 0.000081,
        "y_multiplier": -0.000081,
        "x_scalar": 0.5,
        "y_scalar": 0.5,
    }
}
SAMPLE_MS = 500
ROUND_FIELD = re.compile(r"^RoundResults\[(\d+)\]\.(RoundNumber|WinningTeam|WinningTeamRole|RoundResult)$")
VECTOR = re.compile(r"^\(([-+0-9.eE]+),([-+0-9.eE]+),([-+0-9.eE]+)\)$")


def map_point(value, map_info):
    match = VECTOR.match(value or "")
    if not match:
        return None
    x, y, _ = map(float, match.groups())
    u = y * map_info["x_multiplier"] + map_info["x_scalar"]
    v = x * map_info["y_multiplier"] + map_info["y_scalar"]
    return [round(u * 1000), round(v * 1000)] if 0 <= u <= 1 and 0 <= v <= 1 else None


def track_point(track, time):
    index = bisect.bisect_right(track, [time, 10**9, 10**9]) - 1
    return track[index] if index >= 0 and time - track[index][0] <= 1500 else None


def build(export_dir: Path, output: Path):
    manifest = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
    map_path = manifest["level_names_and_times"][0]["name"]
    if map_path not in MAPS:
        raise ValueError(f"Map {map_path!r} has not been verified for this prototype")
    map_info = MAPS[map_path]
    if manifest["quality"]["content_blocks_lost"] or manifest["quality"]["event_layout_mismatches"]:
        raise ValueError("Replay export has lost blocks or malformed event layouts")

    players = manifest["players"]
    if len(players) != 10:
        raise ValueError("Expected ten player identities")
    con = duckdb.connect()
    field_file = str(export_dir / "fields.parquet")
    event_file = str(export_dir / "events.parquet")
    movement_file = str(export_dir / "movement.parquet")

    assigned = con.execute(
        "SELECT actor_net_guid,raw_bits FROM read_parquet(?) WHERE field_name='AssignedTeamState'",
        [field_file],
    ).fetchall()
    # In this build the one-byte packed NetGUID is twice the team actor ID.
    team_actor_by_player = {actor: raw[0] // 2 for actor, raw in assigned if len(raw) == 1 and raw[0] % 2 == 0}
    team_actors = {team_actor_by_player[p["actor_net_guid"]] for p in players}
    if len(team_actors) != 2:
        raise ValueError("Could not join all players to two team actors")

    events = con.execute(
        'SELECT "group",time1,word0,word1 FROM read_parquet(?) ORDER BY time1', [event_file]
    ).fetchall()
    starts = [time for group, time, *_ in events if group == "roundStarted"]
    if not starts:
        raise ValueError("No round start events")

    result_rows = con.execute(
        "SELECT field_name,value_i64,value_str FROM read_parquet(?) WHERE field_name LIKE 'RoundResults[%].%'",
        [field_file],
    ).fetchall()
    results = {}
    for field, integer, string in result_rows:
        match = ROUND_FIELD.match(field)
        if match:
            results.setdefault(int(match.group(1)), {})[match.group(2)] = string if string is not None else integer
    if len(results) != len(starts):
        raise ValueError("Round start and result counts disagree")

    first_wins = con.execute(
        "SELECT actor_net_guid FROM read_parquet(?) WHERE field_name='Wins' ORDER BY time_ms LIMIT 1",
        [field_file],
    ).fetchone()[0]
    first_winner = results[0]["WinningTeam"]
    if first_wins not in team_actors or first_winner not in ("Blue", "Red"):
        raise ValueError("Cannot verify Blue/Red team mapping")
    other = next(x for x in team_actors if x != first_wins)
    team_name = {first_wins: first_winner, other: "Red" if first_winner == "Blue" else "Blue"}
    player_rows = []
    by_character = {}
    for number, player in enumerate(players, 1):
        team = team_name[team_actor_by_player[player["actor_net_guid"]]]
        player_rows.append({"id": number, "team": team})
        by_character[player["character_net_guid"]] = number

    rounds = []
    blue_score = red_score = 0
    duration = manifest["duration_ms"]
    for index, start in enumerate(starts):
        result = results[index]
        winner = result["WinningTeam"]
        if winner == "Blue":
            blue_score += 1
        elif winner == "Red":
            red_score += 1
        rounds.append({
            "number": index + 1,
            "start": start,
            "end": starts[index + 1] if index + 1 < len(starts) else duration,
            "winner": winner,
            "reason": result.get("RoundResult", ""),
            "blueScore": blue_score,
            "redScore": red_score,
            "events": [],
        })
    event_labels = {
        "characterDeath": "kill", "spikePlanted": "plant",
        "spikeDefused": "defuse", "spikeExploded": "detonation",
    }
    for group, time, word0, word1 in events:
        if group not in event_labels:
            continue
        index = bisect.bisect_right(starts, time) - 1
        if index < 0 or index >= len(rounds):
            continue
        event = {"type": event_labels[group], "time": time}
        if group == "characterDeath":
            if word0 not in by_character or word1 not in by_character:
                raise ValueError("A death event could not be joined to players")
            event["killer"] = by_character[word0]
            event["victim"] = by_character[word1]
        rounds[index]["events"].append(event)

    objective_rows = con.execute(
        """SELECT time_ms,field_name,value_str FROM read_parquet(?)
           WHERE field_name IN ('BombPlantedRPC.PlantLocation',
                                'BombDefuseStartRPC.Defuser', 'BombDefuseStopRPC')
           ORDER BY time_ms""",
        [field_file],
    ).fetchall()
    for time, field, value in objective_rows:
        index = bisect.bisect_right(starts, time) - 1
        if index < 0 or index >= len(rounds):
            continue
        round_row = rounds[index]
        if field == "BombPlantedRPC.PlantLocation":
            point = map_point(value, map_info)
            if point:
                round_row["spike"] = {"plant": time, "x": point[0], "y": point[1]}
        elif field == "BombDefuseStartRPC.Defuser":
            round_row["events"].append({"type": "defuseStart", "time": time})
        elif field == "BombDefuseStopRPC":
            round_row["events"].append({"type": "defuseStop", "time": time})
    for round_row in rounds:
        round_row["events"].sort(key=lambda event: event["time"])
        if "spike" in round_row:
            terminal = next((event["time"] for event in round_row["events"]
                             if event["type"] in ("defuse", "detonation")), round_row["end"])
            round_row["spike"]["terminal"] = terminal

    # 500 ms samples keep the review interactive while preserving the original
    # high-frequency movement Parquet outside the generated page.
    chars = list(by_character)
    samples = con.execute(
        """SELECT CAST(FLOOR(time_ms / ?) AS BIGINT) AS bucket,
                  character_net_guid, MAX(time_ms) AS time_ms,
                  ARG_MAX(pos_x,time_ms) AS pos_x, ARG_MAX(pos_y,time_ms) AS pos_y,
                  ARG_MAX(pos_z,time_ms) AS pos_z
           FROM read_parquet(?)
           WHERE character_net_guid IN (SELECT UNNEST(?))
             AND pos_x > -10000 AND pos_z > -10000
           GROUP BY 1,2 ORDER BY 1,2""",
        [SAMPLE_MS, movement_file, chars],
    ).fetchall()
    tracks = {str(row["id"]): [] for row in player_rows}
    visible_by_bucket = collections.defaultdict(dict)
    for _, character, time, x, y, z in samples:
        u = y * map_info["x_multiplier"] + map_info["x_scalar"]
        v = x * map_info["y_multiplier"] + map_info["y_scalar"]
        if 0 <= u <= 1 and 0 <= v <= 1:
            number = by_character[character]
            tracks[str(number)].append([time, round(u * 1000), round(v * 1000)])
            visible_by_bucket[time // SAMPLE_MS][number] = time

    # Candidate review only: a late kill plus sustained movement away from a
    # planted spike is evidence worth watching, but cannot establish intent.
    # Map-route feasibility and tactical context still require human review.
    team_by_player = {row["id"]: row["team"] for row in player_rows}
    exit_reviews = []
    for round_row in rounds:
        spike = round_row.get("spike")
        explosion = next((event["time"] for event in round_row["events"]
                          if event["type"] == "detonation"), None)
        if not spike or explosion is None:
            continue
        for event in round_row["events"]:
            if event["type"] != "kill" or not 0 < explosion - event["time"] <= 7000:
                continue
            player = event["killer"]
            if team_by_player[player] == round_row["winner"] or event["killer"] == event["victim"]:
                continue
            track = tracks[str(player)]
            before = track_point(track, max(spike["plant"], explosion - 20000))
            after = track_point(track, explosion - 1000)
            if not before or not after:
                continue
            before_distance = math.hypot(before[1] - spike["x"], before[2] - spike["y"]) / 1000
            after_distance = math.hypot(after[1] - spike["x"], after[2] - spike["y"]) / 1000
            if after_distance - before_distance < 0.06:
                continue
            review = {
                "player": player,
                "from": before[0],
                "to": explosion,
                "kill": event["time"],
                "secondsToExplosion": round((explosion - event["time"]) / 1000, 1),
                "distanceBefore": round(before_distance, 2),
                "distanceAfter": round(after_distance, 2),
                "defuseAttempted": any(item["type"] == "defuseStart" for item in round_row["events"]),
            }
            round_row.setdefault("exitReviews", []).append(review)
            event["review"] = "possibleExit"
            exit_reviews.append({"round": round_row["number"], **review})
    preview_buckets = sorted(bucket for bucket, visible in visible_by_bucket.items() if len(visible) >= 8)
    for round_row in rounds:
        first_kill = next((e["time"] for e in round_row["events"] if e["type"] == "kill"), round_row["start"])
        preview_target = max(round_row["start"], min(round_row["end"] - 5000, first_kill - 10000))
        start_bucket = bisect.bisect_left(preview_buckets, preview_target // SAMPLE_MS)
        if start_bucket < len(preview_buckets):
            preview_time = max(visible_by_bucket[preview_buckets[start_bucket]].values())
            if preview_time < round_row["end"]:
                round_row["previewTime"] = max(round_row["start"], preview_time)

    data = {
        "map": {"name": map_info["name"], "image": map_info["image"]},
        "duration": duration,
        "sampleMs": SAMPLE_MS,
        "players": player_rows,
        "rounds": rounds,
        "tracks": tracks,
        "exitReviews": exit_reviews,
    }
    template = (Path(__file__).with_name("replay-review-template.html")).read_text(encoding="utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(template.replace("__REPLAY_DATA__", json.dumps(data, separators=(",", ":"))), encoding="utf-8")
    print(json.dumps({"output": str(output), "bytes": output.stat().st_size, "rounds": len(rounds),
                      "events": sum(len(r["events"]) for r in rounds),
                      "samples": sum(len(t) for t in tracks.values()), "players": len(players),
                      "exitReviews": len(exit_reviews)}))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: build-replay-review.py EXPORT_DIR OUTPUT_HTML")
    build(Path(sys.argv[1]), Path(sys.argv[2]))
