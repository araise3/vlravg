"""Local VRF transcription primitives: replay facts, aim math, static ray tests.

No match API or model service is used. Native movement is retained for turn
measurements; the interactive overview samples it separately for playback.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import struct

import duckdb
import numpy as np
from replay_asset_model import extract_asset_state, modeled_smoke_sightline
from replay_status import stance_geometry, crouch_corroboration
from replay_observations import extract_observations

VERSION = "0.4.0"
FRAME_MS = 50
EYE_HEIGHT = 77.0
FOV = 103.0
AGENTS = {"Wraith": "Omen", "Hunter": "Sova", "Wushu": "Jett", "Vampire": "Reyna",
          "Deadeye": "Chamber", "BountyHunter": "Fade", "Rift": "Astra", "Terra": "Waylay"}
MAPS = {"Infinity": {"name": "Abyss", "x_multiplier": .000081, "y_multiplier": -.000081, "x_scalar": .5, "y_scalar": .5},
        "Bonsai": {"name": "Split", "x_multiplier": .000078, "y_multiplier": -.000078, "x_scalar": .842188, "y_scalar": .697578}}


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def unpack_reference(raw):
    result = 0
    for i, byte in enumerate(raw):
        result |= (byte >> 1) << (7*i)
        if not byte & 1:
            if i != len(raw)-1:
                raise ValueError("Trailing actor reference bytes")
            return result
    raise ValueError("Truncated actor reference")


def forward(yaw, pitch):
    y, p = np.radians(yaw), np.radians(pitch)
    return np.array([np.cos(p)*np.cos(y), np.cos(p)*np.sin(y), np.sin(p)])


def angular_distance(yaw1, pitch1, yaw2, pitch2):
    return float(np.degrees(np.arccos(np.clip(np.dot(forward(yaw1, pitch1), forward(yaw2, pitch2)), -1., 1.))))


def pose(track, time_ms, max_gap=100):
    """Latest actual sample; no interpolation across missing data or death."""
    i = np.searchsorted(track[:, 0], time_ms, side="right")-1
    if i < 0 or time_ms-track[i, 0] > max_gap:
        return None
    return track[i]


def aim_error(observer, target, eye_height=EYE_HEIGHT):
    delta = target[1:4] - (observer[1:4] + [0, 0, eye_height])
    length = np.linalg.norm(delta)
    if length < 1e-6:
        return None
    return float(np.degrees(np.arccos(np.clip(np.dot(forward(*observer[4:6]), delta/length), -1., 1.))))


class MeshBVH:
    """Vectorized leaves, nearest 3D segment hit, and a browser binary format."""
    def __init__(self, triangles, leaf_size=48):
        self.triangles = np.asarray(triangles, dtype=np.float32)
        self.nodes = []
        self.ordered = []
        mins, maxs = self.triangles.min(axis=1), self.triangles.max(axis=1)
        centers = (mins+maxs)*.5

        def build(ids):
            low, high = mins[ids].min(axis=0), maxs[ids].max(axis=0)
            index = len(self.nodes)
            self.nodes.append([low, high, -1, -1, 0, 0])
            if len(ids) <= leaf_size:
                start = len(self.ordered)
                self.ordered.extend(ids.tolist())
                self.nodes[index][4:] = [start, len(ids)]
            else:
                axis = int(np.argmax(high-low))
                mid = len(ids)//2
                split = np.argpartition(centers[ids, axis], mid)
                left, right = build(ids[split[:mid]]), build(ids[split[mid:]])
                self.nodes[index][2:4] = [left, right]
            return index
        if len(self.triangles):
            build(np.arange(len(self.triangles), dtype=np.int32))
        self.triangles = self.triangles[np.array(self.ordered, dtype=np.int32)]

    def hit(self, start, end):
        start, direction = np.asarray(start, dtype=np.float64), np.asarray(end, dtype=np.float64)-start
        best = 1.000001
        point = None
        pending = [0] if self.nodes else []
        while pending:
            node = self.nodes[pending.pop()]
            low, high, left, right, offset, count = node
            entry, leave = 0., best
            for axis in range(3):
                if abs(direction[axis]) < 1e-12:
                    if start[axis] < low[axis] or start[axis] > high[axis]:
                        entry, leave = 1., 0.
                        break
                else:
                    a, b = (low[axis]-start[axis])/direction[axis], (high[axis]-start[axis])/direction[axis]
                    entry, leave = max(entry, min(a, b)), min(leave, max(a, b))
                    if entry > leave:
                        break
            if entry > leave:
                continue
            if left >= 0:
                pending.extend((left, right))
                continue
            tris = self.triangles[offset:offset+count].astype(np.float64)
            e1, e2 = tris[:, 1]-tris[:, 0], tris[:, 2]-tris[:, 0]
            p = np.cross(direction, e2)
            det = np.einsum("ij,ij->i", e1, p)
            valid = np.abs(det) > 1e-8
            inv = np.zeros_like(det)
            inv[valid] = 1./det[valid]
            s = start-tris[:, 0]
            u = np.einsum("ij,ij->i", s, p)*inv
            q = np.cross(s, e1)
            v = q @ direction * inv
            t = np.einsum("ij,ij->i", e2, q)*inv
            valid &= (u >= -1e-7) & (v >= -1e-7) & (u+v <= 1.0000001) & (t > 1e-5) & (t < best) & (t < .99999)
            if valid.any():
                best = float(t[valid].min())
                point = (start+best*direction).tolist()
        return point

    def binary(self):
        bounds = np.array([np.concatenate(n[:2]) for n in self.nodes], dtype="<f4").reshape(-1, 6)
        links = np.array([n[2:] for n in self.nodes], dtype="<i4").reshape(-1, 4)
        return b"VRBV" + struct.pack("<III", len(self.nodes), len(self.triangles), 1) + bounds.tobytes() + links.tobytes() + self.triangles.astype("<f4").tobytes()


def static_sightline(mesh, observer, target, eye_height=EYE_HEIGHT, body_offsets=(-60.,0.,60.)):
    eye = observer[1:4]+[0, 0, eye_height]
    # Anatomical approximations around the replicated capsule origin, not
    # decoded skeletal poses. This is deliberately separate from perception.
    targets = [target[1:4]+[0, 0, z] for z in body_offsets]
    hits = [mesh.hit(eye, end) for end in targets]
    count = sum(x is not None for x in hits)
    return {"status": "blocked" if count == 3 else "mixed" if count else "clear",
            "blocked_points": count, "points": 3, "hit": hits[1] or next((h for h in hits if h), None)}


def extract_shots(con, export, manifest, rounds):
    """Observed gun discharges, keyed by RPC identity rather than kills/ammo."""
    fields = str(export / "fields.parquet")
    tags = {f["handle"]: f["name"] for g in manifest.get("net_field_export_groups", [])
            if g["path"] == "NetworkGameplayTagNodeIndex" for f in g["fields"]}
    subjects = {p["actor_net_guid"]: p["subject"] for p in manifest["players"]}
    guids = {}
    for guid, path, outer in con.execute("SELECT * FROM read_parquet(?)", [str(export / "net_guids.parquet")]).fetchall():
        entry = (path, outer)
        guids[guid] = entry if guid not in guids or guids[guid] == entry else None
    actors = defaultdict(list)
    for t, packet, guid, event, path in con.execute("SELECT time_ms,packet_id,actor_net_guid,event,class_path FROM read_parquet(?) ORDER BY time_ms,packet_id", [str(export / "actors.parquet")]).fetchall():
        actors[guid].append(((t, packet), event, path))
    keys = {g: [row[0] for row in rows] for g, rows in actors.items()}

    def weapon_path(guid, time, packet):
        seen = set()
        while guid and guid not in seen:
            seen.add(guid)
            rows = actors.get(guid, [])
            i = bisect_right(keys.get(guid, []), (time, packet))-1
            while i >= 0:
                _, event, path = rows[i]
                if event == "close":
                    break
                if event == "open":
                    if path:
                        return path
                    break
                i -= 1
            entry = guids.get(guid)
            guid = entry[1] if entry else None
        return None

    rpc = "ReplayPlayContinuousEffectAtLocation"
    groups, ambiguous = defaultdict(dict), set()
    for t, packet, actor, obj, handle, name, string, integer, real in con.execute("SELECT time_ms,packet_id,actor_net_guid,object_net_guid,handle,field_name,value_str,value_i64,value_f64 FROM read_parquet(?) WHERE starts_with(field_name,?) ORDER BY time_ms,packet_id", [fields, rpc+"."]).fetchall():
        key = (t, packet, actor, obj, handle)
        name = name[len(rpc)+1:]
        if name in groups[key]:
            ambiguous.add(key)
        groups[key][name] = string if string is not None else integer if integer is not None else real
    stats, shots = Counter(), []
    round_times = [r["start_ms"] for r in rounds]
    for key, values in groups.items():
        if key in ambiguous:
            stats["ambiguous_rpc_groups"] += 1
            continue
        try:
            decoded = {}
            for name in ("ObjectValues", "FloatValues", "VectorValues"):
                decoded[name] = {tags.get(x["tag"], f"unknown:{x['tag']}"): x["value"] for x in json.loads(values.get(name) or "[]")}
        except (ValueError, TypeError, KeyError):
            stats["unresolved_effects"] += 1
            continue
        objects, floats, vectors = (decoded[n] for n in ("ObjectValues", "FloatValues", "VectorValues"))
        subject = subjects.get(objects.get("FiringState.FiringPlayerState"))
        firing = objects.get("FiringState.FiringState")
        if not firing and not subject:
            continue
        t, packet, actor, obj, handle = key
        path = weapon_path(firing, t, packet)
        if path and not (path.startswith("/Game/Equippables/Guns/") or (path.startswith("/Game/Characters/Deadeye/") and "/Gun" in path)):
            stats["non_gun_firing_effects"] += 1
            continue
        count = floats.get("FiringState.NumProjectiles")
        if not subject or not path or not isinstance(count, (int, float)) or count < 1 or not any(k.startswith("FiringState.AttackVector.") for k in vectors):
            stats["unresolved_firing_effects"] += 1
            continue
        ri = bisect_right(round_times, t)-1
        if ri < 0:
            stats["outside_round"] += 1
            continue
        shots.append({"kind": "shot", "time_ms": t, "round": rounds[ri]["index"], "subject": subject,
                      "id": f"{packet}:{actor}:{obj}:{handle}", "weapon_path": path,
                      "projectiles": count, "ammo_remaining": floats.get("FiringState.AmmoRemaining")})
    if len({s["id"] for s in shots}) != len(shots):
        raise ValueError("Duplicate firing RPC identities")
    stats["observed_discharges"] = len(shots)
    return shots, dict(stats)


def rapid_turn(track, target_track, kill_time, round_start, threshold=45., eye_height_at=None):
    """Measured 100 ms camera turn ending near a kill; a retrieval heuristic."""
    times = track[:, 0]
    best = None
    lo = int(np.searchsorted(times, max(round_start, kill_time-600)))
    hi = int(np.searchsorted(times, kill_time, side="right"))
    for end in range(lo+1, hi):
        begin = int(np.searchsorted(times, times[end]-100))
        if begin >= end or times[begin] < round_start or np.max(np.diff(times[begin:end+1])) > 50:
            continue
        duration = times[end]-times[begin]
        if duration < 50:
            continue
        angle = angular_distance(*track[begin, 4:6], *track[end, 4:6])
        target = pose(target_track, times[end])
        error = aim_error(track[end], target,eye_height_at(times[end]) if eye_height_at else EYE_HEIGHT) if target is not None else None
        if angle < threshold or error is None or error > 20 or kill_time-times[end] > 500:
            continue
        old_error = aim_error(track[begin], target,eye_height_at(times[begin]) if eye_height_at else EYE_HEIGHT)
        if old_error is None or old_error-error < 25:
            continue
        candidate = {"start_ms": int(times[begin]), "end_ms": int(times[end]),
                     "duration_ms": int(duration), "angle_deg": round(angle, 2),
                     "speed_deg_s": round(angle*1000/duration, 1),
                     "aim_error_after_deg": round(error, 2),
                     "ms_to_kill": int(kill_time-times[end])}
        if best is None or candidate["angle_deg"] > best["angle_deg"]:
            best = candidate
    return best


def build_transcription(export, map_dir, names=None, asset_model_path=None):
    manifest = json.loads((export / "manifest.json").read_text(encoding="utf-8"))
    quality = manifest["quality"]
    fatal = {"content_blocks_lost", "overlay_decoded_err", "truncated_rpcs", "malformed_packets",
             "event_layout_mismatches", "transform_failures", "field_stream_failures",
             "content_block_framing_failures", "malformed_content_blocks", "partial_errors",
             "unfinished_partials", "movement_rpc_errors", "array_errors", "array_leaf_decode_errors"}
    for container in (quality, quality.get("net", {}), quality.get("sink", {})):
        for key, value in container.items():
            if isinstance(value, int) and value and key in fatal:
                raise ValueError(f"Replay export reports {key}={value}")
    map_code = manifest["level_names_and_times"][0]["name"].split("/")[-1]
    map_meta = json.loads((map_dir / "map.json").read_text(encoding="utf-8"))
    map_transform = map_meta.get("minimap_transform") or MAPS.get(map_code)
    if not map_transform:
        raise ValueError("Minimap transform is missing; re-extract the map UI defaults")
    if map_meta["map_path"] != manifest["level_names_and_times"][0]["name"]:
        raise ValueError("Map asset export belongs to another map")
    if map_meta["mapping_build"] != manifest["replay_build"].split("release-")[-1]:
        raise ValueError("Map mappings and replay build differ")
    if sha(map_dir / "geometry.npz") != map_meta["geometry_sha256"]:
        raise ValueError("Static geometry no longer matches its map provenance")
    model = json.loads(asset_model_path.read_text(encoding="utf-8")) if asset_model_path else None
    if model and (model["mapping_build"] != map_meta["mapping_build"] or model["mapping_sha256"] != map_meta["mapping_sha256"]):
        raise ValueError("Gameplay asset model and map use different mappings")
    if model:
        if model.get('schema_version') != 2:
            raise ValueError('Gameplay asset model needs schema 2; rerun inspect-transcription-assets.py --model')
        asset_inventory = {k: v["sha256"] for k,v in model["archives"].items()}
        if asset_inventory != {k:v[2] for k,v in map_meta["archive_utoc_sha256"].items()}:
            raise ValueError("Gameplay asset model and map came from different installed archives")
    eye_height = model["camera"]["standing_eye_cm"] if model else EYE_HEIGHT
    cap_offset = model["capsule"]["half_height_cm"]-model["capsule"]["radius_cm"] if model else 60.
    body_offsets = [-cap_offset,0.,cap_offset]
    con = duckdb.connect()
    f, e, mv = (str(export / name) for name in ("fields.parquet", "events.parquet", "movement.parquet"))
    event_rows = con.execute('SELECT "group",time1,word0,word1 FROM read_parquet(?) ORDER BY time1', [e]).fetchall()
    round_starts = [(t, a) for group, t, a, b in event_rows if group == "roundStarted"]
    if not round_starts or len({i for _, i in round_starts}) != len(round_starts):
        raise ValueError("Ambiguous round starts")
    results = {}
    for name, integer, string in con.execute("SELECT field_name,value_i64,value_str FROM read_parquet(?) WHERE field_name LIKE 'RoundResults[%].%'", [f]).fetchall():
        index, member = name[len("RoundResults["):].split("].", 1)
        results.setdefault(int(index), {})[member] = string if string is not None else integer
    phases = con.execute("SELECT time_ms,value_i64 FROM read_parquet(?) WHERE field_name='MulticastSetPhase.NewPhase' ORDER BY time_ms", [f]).fetchall()
    rounds = []
    for i, (start, index) in enumerate(round_starts):
        stop = round_starts[i+1][0] if i+1 < len(round_starts) else manifest["duration_ms"]
        phase = [(t, v) for t, v in phases if start <= t < stop]
        result = results.get(index, {})
        rounds.append({"index": index, "number": index+1, "start_ms": start, "end_ms": stop,
                       "combat_start_ms": next((t for t, v in phase if v == 4), None),
                       "combat_end_ms": next((t for t, v in phase if v == 5), None),
                       "winner": result.get("WinningTeam"), "result": result.get("RoundResult"),
                       "winning_role": result.get("WinningTeamRole")})
    assigned = {g: unpack_reference(raw) for g, raw in con.execute("SELECT actor_net_guid,raw_bits FROM read_parquet(?) WHERE field_name='AssignedTeamState'", [f]).fetchall() if raw}
    team_guids = set(assigned.values())
    first_win = con.execute("SELECT actor_net_guid FROM read_parquet(?) WHERE field_name='Wins' ORDER BY time_ms LIMIT 1", [f]).fetchone()
    if len(team_guids) != 2 or not first_win or first_win[0] not in team_guids or rounds[0]["winner"] not in ("Red", "Blue"):
        raise ValueError("Cannot establish Blue/Red team mapping")
    team_map = {first_win[0]: rounds[0]["winner"]}
    team_map[next(g for g in team_guids if g != first_win[0])] = "Blue" if rounds[0]["winner"] == "Red" else "Red"
    loadouts = {}
    for raw in manifest.get("game_specific_data", []):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                loadouts.update({p["subject"]: p.get("characterId") for p in obj.get("playerLoadouts", [])})
        except (ValueError, TypeError):
            pass
    actor_classes = dict(con.execute("SELECT actor_net_guid,arg_min(class_path,time_ms) FROM read_parquet(?) WHERE event='open' GROUP BY 1", [str(export / "actors.parquet")]).fetchall())
    players, by_body, raw_tracks, tracks = [], {}, {}, {}
    for i, p in enumerate(manifest["players"]):
        bodies = p.get("character_net_guids") or [p["character_net_guid"]]
        path = actor_classes.get(bodies[0]) or ""
        codename = path.split("/Characters/")[-1].split("/")[0] if "/Characters/" in path else "Unknown agent"
        player = {"slot": f"P{i+1}", "subject": p["subject"], "agent_id": loadouts.get(p["subject"]),
                  "agent": (model or {}).get('agent_names',{}).get(codename,AGENTS.get(codename, codename)), "name": (names or {}).get(p["subject"]),
                  "team": team_map[assigned[p["actor_net_guid"]]], "bodies": bodies}
        players.append(player)
        for body in bodies:
            if body in by_body:
                raise ValueError("Player body has multiple owners")
            by_body[body] = p["subject"]
        raw = con.execute("SELECT time_ms,pos_x,pos_y,pos_z,yaw,pitch,movement_state FROM read_parquet(?) WHERE character_net_guid IN (SELECT unnest(?)) QUALIFY row_number() OVER(PARTITION BY time_ms ORDER BY packet_id DESC)=1 ORDER BY time_ms", [mv, bodies]).fetchnumpy()
        track = np.column_stack(list(raw.values())).astype(np.float64)
        if len(track) < 2:
            raise ValueError("Missing player movement")
        raw_tracks[p["subject"]] = track
        # Keep actual observed poses (last per 50 ms bucket), never invented
        # coordinates. Death/round boundaries remain their separate events.
        buckets = np.floor(track[:, 0]/FRAME_MS)
        keep = np.r_[buckets[:-1] != buckets[1:], True]
        sampled = track[keep].copy()
        sampled[:, 1:4] = np.round(sampled[:, 1:4], 2)
        sampled[:, 4:6] = np.round(sampled[:, 4:6], 4)
        tracks[p["subject"]] = sampled.tolist()
    all_poses = np.concatenate([t[:, 1:4] for t in raw_tracks.values()])
    sensible = all_poses[np.isfinite(all_poses).all(axis=1) & (all_poses[:, 2] > -5000)]
    low, high = sensible.min(axis=0)-[1000, 1000, 250], sensible.max(axis=0)+[1000, 1000, 250]
    triangles = np.load(map_dir / "geometry.npz")["triangles"]
    chosen = ((triangles.max(axis=1) >= low) & (triangles.min(axis=1) <= high)).all(axis=1)
    mesh = MeshBVH(triangles[chosen])
    print(f"Sightline mesh: {len(mesh.triangles):,} triangles, {len(mesh.nodes):,} BVH nodes", flush=True)
    times = [r["start_ms"] for r in rounds]
    asset_state = extract_asset_state(con,export,manifest,rounds,by_body,model,unpack_reference)
    asset_state['observations'] = extract_observations(con,export,manifest,model,by_body,rounds,asset_state['vision_effects'])
    if model and model.get('asset_catalog'):
        catalog=model['asset_catalog']
        pending={e['effect_class'] for e in asset_state['observations']['effect_events'] if e.get('effect_class')}
        pending.update(e['asset_path'] for e in asset_state['observations']['animation_observations'] if e.get('asset_path'))
        used={}
        while pending:
            key=pending.pop()
            if key in used or key not in catalog:continue
            used[key]=catalog[key]
            for ref in catalog[key].get('animation_references',[]):
                if "'" in ref:pending.add(ref.split("'",2)[1])
        model['catalog_assets_available']=len(catalog)
        model['asset_catalog']=used
    events, kills, unmapped = [], [], Counter()
    for group, t, a, b in event_rows:
        ri = bisect_right(times, t)-1
        if ri < 0:
            continue
        row = {"kind": group, "time_ms": t, "round": rounds[ri]["index"]}
        if group == "characterDeath":
            row.update(killer=by_body.get(a), victim=by_body.get(b))
            row["death_type"] = "self_or_environment" if row["killer"] == row["victim"] else "player_kill" if row["killer"] else "unresolved_or_environment"
            if not row["victim"]:
                unmapped["death_victim"] += 1
            if a and not row["killer"]:
                unmapped["death_killer"] += 1
            row["id"] = f"kill-{len(kills)}"
            if row["killer"] and row["victim"] and row["killer"] != row["victim"]:
                observer = pose(raw_tracks[row["killer"]], t)
                target = pose(raw_tracks[row["victim"]], t)
                if observer is not None and target is not None:
                    killer_stance = stance_geometry(model['camera'],model['capsule'],asset_state['camera']['stance_transitions'].get(row['killer'],[]),t) if model else None
                    victim_stance = stance_geometry(model['camera'],model['capsule'],asset_state['camera']['stance_transitions'].get(row['victim'],[]),t) if model else None
                    modeled_eye = killer_stance['eye_height_cm'] if killer_stance else eye_height
                    modeled_body = victim_stance['body_offsets_cm'] if victim_stance else body_offsets
                    row['stance_model'] = {'killer':killer_stance,'victim':victim_stance}
                    row['vision_effect_ids'] = [s['id'] for s in asset_state['vision_effects'] if s['subject']==row['killer'] and s['start_ms']<=t<s['end_ms']]
                    row["distance_m"] = round(float(np.linalg.norm(target[1:4]-observer[1:4]))/100., 2)
                    row["aim_error_deg"] = round(aim_error(observer, target,modeled_eye), 2)
                    row["static_sightline"] = static_sightline(mesh, observer, target,modeled_eye,modeled_body)
                    row["static_sightline"]["posture_kind"] = "input_driven_asset_stance_model" if model else "standing_fallback"
                    row["smoke_sightline"] = modeled_smoke_sightline(asset_state,(observer[1:4]+[0,0,modeled_eye]).tolist(),target[1:4].tolist(),t,rounds[ri]["index"])
                    row["killer_position_cm"] = observer[1:4].tolist()
                    row["victim_position_cm"] = target[1:4].tolist()
                stance_rows = asset_state['camera']['stance_transitions'].get(row['killer'],[])
                height_at = (lambda tt: stance_geometry(model['camera'],model['capsule'],stance_rows,tt)['eye_height_cm']) if model else None
                row["rapid_turn"] = rapid_turn(raw_tracks[row["killer"]], raw_tracks[row["victim"]], t, rounds[ri]["start_ms"],eye_height_at=height_at)
            kills.append(row)
        elif group == "characterUltimateUsed":
            row["subject"] = by_body.get(a)
        events.append(row)
    shots, shot_diagnostics = extract_shots(con, export, manifest, rounds)
    events.extend(shots)
    events.extend(asset_state["fov_events"])
    observation = asset_state['observations']
    events.extend(observation['effect_events'])
    events.extend(e for e in observation['animation_observations']+observation['resurrections']+observation['camera_observations'] if e['round'] is not None)
    if model:
        asset_state['camera']['crouch_corroboration'] = crouch_corroboration(asset_state['camera']['crouch_inputs'],raw_tracks,rounds,kills,model['camera']['crouch_compression_cm'])
        for subject,rows in asset_state['camera']['crouch_inputs'].items():
            for t,held in rows:
                ri = bisect_right([r['start_ms'] for r in rounds],t)-1
                if ri>=0:
                    events.append({'kind':'crouch_input_observed','time_ms':t,'round':rounds[ri]['index'],
                                   'subject':subject,'held':held,'evidence':'controller_bCrouchHeld','achieved_stance':'unverified'})
    for effect in asset_state['vision_effects']:
        for kind,t in [('vision_effect_started',effect['start_ms']),('vision_effect_stopped',effect['end_ms'])]:
            if kind=='vision_effect_stopped' and effect['end_reason']!='observed_stop_rpc':
                continue
            events.append({'kind':kind,'time_ms':t,'round':effect['round'],'subject':effect['subject'],
                'id':effect['id'],'name':effect['name'],'vision_kind':effect['kind'],'effect_id':effect['effect_id'],
                'source_id':effect['source_id'],'evidence':effect['evidence']})
    for smoke in asset_state["smokes"]:
        events.append({"kind":"smoke_zone_observed","time_ms":smoke["start_ms"],"round":smoke["round"],
                       "subject":smoke["subject"],"id":smoke["id"],"profile":smoke["profile"],
                       "modeled_end_ms":smoke["end_ms"],"end_reason":smoke["end_reason"],
                       "initial_position_cm":smoke["positions"][0][1:],"evidence":"replay_actor_and_asset_defaults"})
    events.sort(key=lambda row: (row["time_ms"], row["kind"]))
    con.close()
    score = Counter(r["winner"] for r in rounds if r["winner"])
    data = {"schema_version": 1, "producer": "vlravg-replay-transcription/"+VERSION,
            "match_id": manifest["friendly_name"], "replay_build": manifest["replay_build"],
            "clock": "replay_time_ms", "duration_ms": manifest["duration_ms"],
            "export_manifest_sha256": sha(export / "manifest.json"),
            "map": {**map_transform, "path": map_meta["map_path"]}, "players": players,
            "rounds": rounds, "score": dict(score), "events": events, "kills": kills, "tracks": tracks,
            "track_columns": ["time_ms", "x_cm", "y_cm", "z_cm", "yaw_deg", "pitch_deg", "movement_state"],
            "playback_sample_ms": FRAME_MS,
            "projection": {"horizontal_fov_deg": FOV, "aspect": 16/9, "eye_height_cm": eye_height,
                           "body_offsets_cm": body_offsets, "kind": "asset_capsule_approximation" if model else "approximate"},
            "asset_state": asset_state,
            "rapid_turn_policy": {"minimum_angle_deg": 45, "window_ms": 100, "maximum_sample_gap_ms": 50,
                                  "maximum_ms_before_kill": 500, "maximum_end_aim_error_deg": 20,
                                  "minimum_aim_error_reduction_deg": 25, "kind": "review_retrieval",
                                  "eye_height_kind":"input_driven_asset_stance_model" if model else "standing_fallback"},
            "geometry": {"kind": "static_opaque_mesh_approximation", "triangles_used": len(mesh.triangles),
                         "bounds_cm": [low.tolist(), high.tolist()], "complete": False,
                         "asset_provenance": map_meta},
            "diagnostics": {"parser_quality": quality, "shot_extraction": shot_diagnostics,
                            "unmapped_events": dict(unmapped), "native_movement_rows": quality["movement_rows"]},
            "limitations": ["Wall colors mean static mesh rays; smoke colors mean an asset model. Neither confirms player perception.",
                            "Static geometry is incomplete; installed asset/replay build parity is unverified.",
                            f"Parser preserved {quality.get('net', {}).get('unresolved_rpc_payloads_preserved', 0)} unresolved RPC payloads; decoded events do not establish complete gameplay semantics.",
                            "Named flash/nearsight intervals are observed effect RPCs, not native blind intensity or exact shader output. Smoke boundaries use an asset envelope model; reveals, dynamic barriers and recoil are not reconstructed.",
                            "World FOV follows the recorded active weapon's SourceFov/TargetFov. World and weapon-mesh FOV streams are retained separately; transition interpolation is approximate.",
                            "The eye height and capsule sample points use serialized defaults when a gameplay asset model is supplied. Actual camera pose, crouch and animated hitboxes remain approximations.",
                            "Motion overview uses observed poses every 50 ms; turn measurements use native samples.",
                            "Slot labels identify replay UUIDs. Display names require a user-supplied mapping.",
                            "Life state uses recorded DamageableComponent alive flags; resurrection broadcasts are retained. Skeletal poses, camera shake, recoil and native animation blending remain unresolved.",
                            "Rapid turns are measured review candidates, with no inferred intent."]}
    if model:
        data["limitations"].extend(model["limitations"])
    provenance_file = export.parent / "source-provenance.json"
    data["source_provenance"] = json.loads(provenance_file.read_text(encoding="utf-8-sig")) if provenance_file.exists() else None
    return data, mesh


def transcript_text(data):
    players = {p["subject"]: p for p in data["players"]}
    def label(subject):
        p = players.get(subject)
        return f"{p['name'] or p['slot']} ({p['agent']})" if p else "unresolved/environment"
    lines = [f"VALORANT REPLAY TRANSCRIPTION | {data['match_id']}",
             f"Map: {data['map']['name']} | Build: {data['replay_build']} | Blue {data['score'].get('Blue', 0)} - Red {data['score'].get('Red', 0)}",
             "Clock: replay time in milliseconds. Positions: Unreal XYZ in centimetres.",
             "Evidence: decoded match events and movement, plus installed static map art meshes.",
             *["LIMIT: "+s for s in data["limitations"]], "", "PLAYERS"]
    lines.extend(f"{label(p['subject'])} | {p['team']} | UUID {p['subject']}" for p in data["players"])
    for r in data["rounds"]:
        lines.extend(["", f"ROUND {r['number']} | replay {r['start_ms']} - {r['end_ms']} ms | {r['winner'] or 'unknown'} wins by {r['result'] or 'unknown'}"])
        for e in data["events"]:
            if e["round"] != r["index"] or e["kind"] == "roundStarted":
                continue
            prefix = f"t={e['time_ms']} ms (+{(e['time_ms']-r['start_ms'])/1000:.3f}s) "
            if e["kind"] == "characterDeath":
                text = (f"{label(e['victim'])} dies (self/environment event; killer and victim references are equal)."
                        if e["death_type"] == "self_or_environment" else f"{label(e['killer'])} kills {label(e['victim'])}.")
                if "distance_m" in e:
                    text += f" Distance {e['distance_m']} m; approximate view-to-target-center angle {e['aim_error_deg']} deg; static three-point sightline {e['static_sightline']['status']}."
                    smoke = e.get("smoke_sightline",{})
                    if smoke.get("boundary_crossings") or smoke.get("observer_inside") or smoke.get("target_inside"):
                        text += f" Smoke asset model: {len(smoke.get('boundary_crossings',[]))} boundary crossings; observer inside {len(smoke.get('observer_inside',[]))}, target inside {len(smoke.get('target_inside',[]))}. Hollow-interior perception unverified."
                    if e.get('vision_effect_ids'):
                        names = [s['name'] for s in data['asset_state']['vision_effects'] if s['id'] in e['vision_effect_ids']]
                        text += ' Killer has an observed vision effect: '+', '.join(names)+'.'
                    if e.get('stance_model',{}).get('killer'):
                        text += f" Input-driven stance model: killer {e['stance_model']['killer']['fraction']:.2f}, victim {e['stance_model']['victim']['fraction']:.2f} crouch fraction. Achieved stance unverified."
                turn = e.get("rapid_turn")
                if turn:
                    text += f" Rapid-turn candidate: {turn['angle_deg']} deg in {turn['duration_ms']} ms ({turn['speed_deg_s']} deg/s), ending {turn['ms_to_kill']} ms before kill; aim error after {turn['aim_error_after_deg']} deg."
            elif e["kind"] == "shot":
                weapon = e["weapon_path"].rsplit("/", 1)[-1].split(".")[0]
                text = f"{label(e['subject'])} gun discharge; weapon {weapon}; {e['projectiles']:g} projectile(s); ammo after {e['ammo_remaining']}; RPC {e['id']}."
            elif e["kind"] == "characterUltimateUsed":
                text = f"{label(e.get('subject'))} ultimate-used event."
            elif e["kind"] == "smoke_zone_observed":
                profile = data["asset_state"]["model"]["smoke_profiles"][e["profile"]]
                text = f"{profile['agent']} smoke zone actor observed; instigator {label(e['subject'])}; asset radius {profile['radius_cm']/100:.2f} m; modeled interval through {e['modeled_end_ms']} ms ({e['end_reason']}); position {e['initial_position_cm']}. Activation and fade are approximate."
            elif e["kind"] == "world_fov_target_observed":
                text = f"{label(e['subject'])} active weapon world FOV target {e['target_fov_deg']:.2f} deg (recorded source {e['source_fov_deg']:.2f} deg, transition duration {e['transition_ms']:.1f} ms). Transition curve is approximate."
            elif e['kind']=='effect_rpc_observed':
                text = f"{label(e.get('subject'))} {e['method']}: {e.get('effect_class') or 'effect class unresolved'}; actor {e['actor_net_guid']}; parameters {json.dumps(e['parameters'],separators=(',',':'))}."
            elif e['kind']=='animation_reference_observed':
                text = f"{label(e.get('subject'))} animation field {e['field']}: {e['asset_path'] or e['value'] or 'unresolved payload'}; native skeleton pose unverified."
            elif e['kind']=='camera_field_observed':
                text = f"Camera component {e['component_net_guid']} on actor {e['actor_net_guid']}: {e['field']} = {e['value']} ({e['group']})."
            elif e['kind']=='resurrection_observed':
                text = f"{label(e['subject'])} resurrection broadcast; resurrector {label(e['resurrector'])}; recorded parameters {json.dumps(e['parameters'])}."
            elif e['kind']=='crouch_input_observed':
                text = f"{label(e['subject'])} crouch input {'held' if e['held'] else 'released'} (recorded controller flag; achieved stance unverified)."
            elif e['kind'] in ('vision_effect_started','vision_effect_stopped'):
                text = f"{label(e['subject'])} {e['name']} effect {'starts' if e['kind']=='vision_effect_started' else 'stops'} (affected-player RPC; effect ID {e['effect_id']}, source {e['source_id']}). Native intensity and visual tails unverified."
            else:
                text = e["kind"]+"."
            lines.append(prefix+text)
    return "\n".join(lines)+"\n"
