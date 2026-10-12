"""Serialized asset models, kept separate from observed replay facts.

Blueprint expressions and defaults are inspectable. Native camera behavior,
achieved posture and shader output still require separate evidence.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict, Counter
import json
import math
import re
import numpy as np
from replay_status import extract_vision, crouch_transitions

BASE = "ShooterGame/Content/"
SMOKES = {
    "Characters/Wraith/S0/Ability_4/Zone_Wraith_4_Smoke": "Omen",
    "Characters/Wushu/S0/Ability_4/GameObject_Wushu_4_SmokeZone": "Jett",
    "Characters/Rift/S0/Ability_E/GameObject_Rift_E_SmokeZone": "Astra",
    "Characters/Rift/S0/Ability_E/GameObject_Rift_E_SmokeZone_Fake": "Astra recall",
}
NEARSIGHTS = {
    "Characters/Wraith/S0/Ability_Q/FXC_Wraith_Q_NearsightMissile_Nearsight": "Omen Paranoia",
    "Characters/Vampire/S0/Ability_4/FXC_Vampire_4_NearsightAOE_Nearsight": "Reyna Leer",
    "Characters/Wushu/S0/Ability_4/FXC_Wushu_4_SmokeNearsight": "Jett smoke interior",
}
FLASH_CONFIGS = {
    "Characters/Breach/S0/Ability_Q/BlindConfig_Breach_Q_Flash": "Breach",
    "Characters/Grenadier/S0/Ability_4/BlindConfig_Grenadier_Flash": "KAY/O",
    "Characters/Guide/S0/Ability_E/BlindConfig_Guide_E_Flash": "Skye",
    "Characters/Nox/S0/Ability_E/BlindConfig_Nox_Flash": "Vyse",
    "Characters/Phoenix/S0/Ability_E/Production/BlindConfig_Phoenix_E_Flash": "Phoenix",
    "Characters/Stealth/S0/Ability_Q/BlindConfig_Stealth_Q_Flash": "Yoru",
    "Characters/Stealth/S0/Ability_4/BlindConfig_Stealth_4_Flash": "Yoru clone",
}
MODEL_ROOTS = [BASE+p+".uasset" for p in ["Characters/_Core/BasePawn", "Characters/_Core/BasePlayerCharacter", *SMOKES,
    *NEARSIGHTS, *FLASH_CONFIGS, "Characters/_Core/FXC_Blinded_Shared",
    "Characters/Wraith/S0/Ability_Q/Buff_Wraith_Q_NearsightMissile_Nearsight",
    "Characters/Vampire/S0/Ability_4/Buff_Vampire_4_NearsightAOE_NearSight_Infinite"]]


def reference_package(ref):
    if not isinstance(ref, dict) or "reference" not in ref:
        return None
    match = re.search(r"(/Game/[^'.:]+)", ref["reference"])
    return BASE+match[1][6:]+".uasset" if match else None


def make_asset_profile(report):
    packages = {p["package"]: p for p in report["packages"]}

    def inherited(path, export=None, seen=None):
        seen = set() if seen is None else seen
        if path in seen:
            raise ValueError("Asset inheritance cycle")
        seen.add(path)
        pkg = packages.get(path)
        if not pkg or pkg.get("error"):
            raise ValueError(f"Missing model asset: {path}")
        rows = pkg["exports"]
        cls = next((x for x in rows if x["type"] == "UBlueprintGeneratedClass"), None)
        parent = reference_package(cls.get("SuperStruct")) if cls else None
        result, sources = inherited(parent, export, seen) if parent else ({}, {})
        row = next((x for x in rows if x["name"] == export), None) if export else next((x for x in rows if x["name"].startswith("Default__")), None)
        if row:
            for k, v in row["properties"].items():
                result[k], sources[k] = v, f"{path}:{row['name']}.{k}"
        return result, sources

    def curve(ref):
        path = reference_package(ref)
        if not path or path not in packages:
            raise ValueError("Unresolved smoke curve")
        row = next(x for x in packages[path]["exports"] if x["type"] == "UCurveFloat")
        keys = row["properties"]["FloatCurve"]["Keys"]
        compact = []
        for key in keys:
            mode, weight = key["InterpMode"]["value__"], key["TangentWeightMode"]["value__"]
            if mode not in (0, 1, 2) or weight:
                raise ValueError("Unsupported curve interpolation; refusing to approximate weighted tangents silently")
            compact.append([key["Time"], key["Value"], mode, key["ArriveTangent"], key["LeaveTangent"]])
        return {"source": path, "keys": compact}

    pawn, ps = inherited(BASE+"Characters/_Core/BasePlayerCharacter.uasset")
    capsule, cs = inherited(BASE+"Characters/_Core/BasePlayerCharacter.uasset", "CollisionCylinder")
    profiles, shell_meshes = {}, {}
    parent_path = BASE+"Characters/Global/Smoke/GameObject_NewSmokeZone_Parent.uasset"
    parent_exports = {x["name"]:x for x in packages[parent_path]["exports"]}
    graph = parent_exports["ExecuteUbergraph_GameObject_NewSmokeZone_Parent"].get("ScriptBytecode") or []
    scale_code = parent_exports["SetSmokeScaleByPercentage"].get("ScriptBytecode") or []
    def script_references(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k == "reference":
                    yield v
                yield from script_references(v)
        elif isinstance(value,list):
            for v in value:
                yield from script_references(v)
    references = list(script_references(graph))
    if not graph or graph[-1].get("expression_type") != "EX_EndOfScript" or not scale_code or scale_code[-1].get("expression_type") != "EX_EndOfScript":
        raise ValueError("Smoke Blueprint expression decoding is incomplete")
    if not any(":SetWorldScale3D'" in r for r in script_references(scale_code)) or not any(":SetPlayRate'" in r for r in references):
        raise ValueError("Smoke Blueprint behavior evidence is missing; enable script reading")
    for path, agent in SMOKES.items():
        package = BASE+path+".uasset"
        defaults, sources = inherited(package)
        sphere, sphere_sources = inherited(package, "VisionBlockingSphere_GEN_VARIABLE")
        scale = sphere["RelativeScale3D"]
        radii = [sphere["SphereRadius"]*scale[a] for a in "XYZ"]
        if max(radii)-min(radii) > .01:
            raise ValueError("Smoke sphere is nonuniform")
        hollow, hollow_sources = inherited(package,"HollowVisionBlockingSphere_GEN_VARIABLE")
        mesh_path = reference_package(hollow["StaticMesh"])
        mesh_exports = packages[mesh_path]["exports"]
        mesh = next(e["mesh_lod0"] for e in mesh_exports if "mesh_lod0" in e)
        body = next(e for e in mesh_exports if e["type"] == "UBodySetup")
        if body["properties"]["CollisionTraceFlag"] != "ECollisionTraceFlag::CTF_UseComplexAsSimple":
            raise ValueError("Smoke shell no longer uses complex mesh collision")
        shell_meshes[mesh_path] = {**mesh,"source":mesh_path,"collision_trace_flag":body["properties"]["CollisionTraceFlag"]}
        shell_scale = [scale[a]*hollow["RelativeScale3D"][a] for a in "XYZ"]
        shell_radius = max(math.sqrt(sum((v[i]*shell_scale[i])**2 for i in range(3))) for v in mesh["vertices"])
        profiles[f"/Game/{path}.{path.rsplit('/',1)[-1]}_C"] = {
            "agent": agent, "radius_cm": sum(radii)/3,
            "delay_ms": defaults["SmokeDelayTime"]*1000,
            "expand_ms": defaults["SmokeExpandDuration"]*1000,
            "duration_ms": defaults["SmokeDuration"]*1000,
            "contract_ms": defaults["SmokeContractDuration"]*1000,
            "expand_curve": curve(defaults["ExpandCurve"]),
            "contract_curve": curve(defaults["ContractCurve"]),
            "blind_curve": curve(defaults["BlindByDistanceCurve"]) if "BlindByDistanceCurve" in defaults else None,
            "sources": {k: sources[k] for k in ("SmokeDelayTime", "SmokeExpandDuration", "SmokeDuration", "SmokeContractDuration")},
            "sphere_sources": {k: sphere_sources[k] for k in ("SphereRadius", "RelativeScale3D")},
            "boundary_shell": {"mesh":mesh_path,"scale":shell_scale,"bounding_radius_cm":shell_radius,
                               "sources": {k:hollow_sources[k] for k in ("StaticMesh","RelativeScale3D")}},
        }
    vision_profiles = {}
    def vision_profile(path, name, kind, config=None):
        values, sources = inherited(BASE+path+".uasset")
        props = {k:values[k] for k in ("OccluderRadius", "FadeRadius", "NearsightFadeInDuration", "NearsightFadeOutDuration",
                                      "OccluderBaseColor", "FadeBaseColor", "EffectTailTime") if k in values}
        class_path = "/Game/"+path+"."+path.rsplit("/",1)[-1]+"_C"
        vision_profiles[class_path] = {"name":name,"kind":kind,"asset_defaults":props,
            "sources":{k:sources[k] for k in props},"config_source":config,
            "render_kind":"illustrative_overlay_not_shader_reconstruction"}
    for path,name in NEARSIGHTS.items():
        vision_profile(path,name,"nearsight")
    for config,name in FLASH_CONFIGS.items():
        values,_ = inherited(BASE+config+".uasset")
        path = reference_package(values["BlindedEffectContainer"])
        vision_profile(path[len(BASE):-7],name+" flash","flash",BASE+config+".uasset")
    vision_profile("Characters/_Core/FXC_Blinded_Shared","Shared flash","flash")
    return {"schema_version": 2, "kind": "serialized_asset_model", "mapping_build": report["mapping_build"],
            "mapping_sha256": report["mapping_sha256"], "archives": report["archives"],
            "asset_build_verified_against_replay": False,
            "camera": {"standing_eye_cm": pawn["BaseEyeHeight"], "crouched_eye_cm": pawn["CrouchedEyeHeight"],
                       "crouch_time_ms": pawn["CrouchTimeSeconds"]*1000,
                       "crouch_compression_cm": pawn["CrouchCompressionAmount"],
                       "standing_eye_offset_cm": pawn["StandingEyeOffset"], "crouching_eye_offset_cm": pawn["CrouchingEyeOffset"],
                       "sources": {k: ps[k] for k in ("BaseEyeHeight", "CrouchedEyeHeight", "CrouchTimeSeconds", "CrouchCompressionAmount", "StandingEyeOffset", "CrouchingEyeOffset")}},
            "capsule": {"half_height_cm": capsule["CapsuleHalfHeight"], "radius_cm": capsule["CapsuleRadius"], "sources": cs},
            "smoke_profiles": profiles,
            "vision_profiles": vision_profiles,
            "shell_meshes": shell_meshes,
            "behavior_evidence": {"source":parent_path,"kind":"decoded_blueprint_expressions",
                                  "graph_expression_count":len(graph),
                                  "scale_function":"SetSmokeScaleByPercentage:SmokeScene.SetWorldScale3D",
                                  "expand_play_rate":"1 / SmokeExpandDuration",
                                  "contract_play_rate":"1 / SmokeContractDuration",
                                  "lifetime":"GetSmokeDuration timer starts with ExpandSmoke; expansion overlaps duration",
                                  "jett_duration":"GetSmokeDuration override reads AbilityTuning.Wushu.4.SmokeDuration; runtime tuning may override the serialized default"},
            "limitations": ["Crouch eye/body shape uses controller input and asset defaults. Input can be blocked; achieved stance, camera offsets and animated skeletons are not decoded.",
                            "Vision effect intervals use affected-player effect RPC observations. Overlay appearance, native blind intensity, shader radii and visual tails are not reconstructed.",
                            "Smoke actor channel openings/closures are observations, not proven activation/destruction events.",
                            "Smoke scaling follows decoded Blueprint timelines and complex shell meshes; activation clock, runtime tuning and native vision behavior remain unverified.",
                            "Smoke shell rays use double-sided triangles. Native backface rules and hollow-interior nearsight remain unverified.",
                            "Asset/replay build parity is unverified."]}


def curve_value(keys, x):
    i = bisect_right([k[0] for k in keys], x)-1
    if i < 0:
        return keys[0][1]
    if i >= len(keys)-1:
        return keys[-1][1]
    a, b = keys[i:i+2]
    delta = b[0]-a[0]
    u = (x-a[0])/delta
    if a[2] == 1:
        return a[1]
    if a[2] == 0:
        return a[1]+u*(b[1]-a[1])
    return (2*u**3-3*u*u+1)*a[1] + (u**3-2*u*u+u)*delta*a[4] + (-2*u**3+3*u*u)*b[1] + (u**3-u*u)*delta*b[3]


def smoke_radius(profile, age_ms):
    age = age_ms-profile["delay_ms"]
    if age < 0 or age >= profile["duration_ms"]+profile["contract_ms"]:
        return 0.
    if age < profile["expand_ms"]:
        scale = curve_value(profile["expand_curve"]["keys"], age/profile["expand_ms"])
    elif age < profile["duration_ms"]:
        scale = 1.
    else:
        scale = curve_value(profile["contract_curve"]["keys"], (age-profile["duration_ms"])/profile["contract_ms"])
    return profile["radius_cm"]*max(0., min(1., scale))


def sphere_segment(start, end, center, radius):
    """Return boundary crossing and interior occupancy separately for hollow smoke."""
    d = [b-a for a,b in zip(start,end)]
    q = [a-c for a,c in zip(start,center)]
    r = [b-c for b,c in zip(end,center)]
    inside_start = sum(x*x for x in q) < radius*radius
    inside_end = sum(x*x for x in r) < radius*radius
    a = sum(x*x for x in d)
    b = 2*sum(x*y for x,y in zip(q,d))
    c = sum(x*x for x in q)-radius*radius
    disc = b*b-4*a*c
    roots = [] if a < 1e-12 or disc <= 0 else [(-b-math.sqrt(disc))/(2*a),(-b+math.sqrt(disc))/(2*a)]
    return {"boundary": any(0 <= t <= 1 for t in roots), "inside_observer": inside_start, "inside_target": inside_end}


def smoke_intersection(model, profile, start, end, center, radius):
    hit = sphere_segment(start,end,center,radius)
    shell = profile.get("boundary_shell")
    if not shell:
        return hit
    factor = radius/profile["radius_cm"]
    broad = sphere_segment(start,end,center,shell["bounding_radius_cm"]*factor)
    hit["boundary"] = False
    if not any(broad.values()):
        return hit
    source = model["shell_meshes"][shell["mesh"]]
    vertices = np.asarray(source["vertices"])*shell["scale"]
    triangles = vertices[np.asarray(source["indices"]).reshape(-1,3)]
    eye,end = ((np.asarray(p)-center)/factor for p in (start,end))
    d = end-eye
    e1,e2 = triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]
    p = np.cross(d,e2)
    det = np.einsum('ij,ij->i',e1,p)
    valid = np.abs(det)>1e-8
    inv = np.divide(1.,det,out=np.zeros_like(det),where=valid)
    s = eye-triangles[:,0]
    u = np.einsum('ij,ij->i',s,p)*inv
    q = np.cross(s,e1)
    v = q@d*inv
    t = np.einsum('ij,ij->i',e2,q)*inv
    hit["boundary"] = bool((valid&(u>=-1e-7)&(v>=-1e-7)&(u+v<=1.0000001)&(t>1e-5)&(t<.99999)).any())
    return hit


def extract_asset_state(con, export, manifest, rounds, by_body, model, unpack_reference):
    """Join observed actor lifecycle/positions and active weapon FOV, never guess an owner."""
    fields = str(export/"fields.parquet")
    actor_rows = con.execute("SELECT time_ms,packet_id,actor_net_guid,event,class_path,spawn_x,spawn_y,spawn_z FROM read_parquet(?) ORDER BY time_ms,packet_id",[str(export/"actors.parquet")]).fetchall()
    profiles = model["smoke_profiles"] if model else {}
    diagnostics, smokes, opens = Counter(), [], {}
    player_states = {p["actor_net_guid"]:p["subject"] for p in manifest["players"]}
    bindings = defaultdict(list)
    for t,guid,name,raw in con.execute("SELECT time_ms,actor_net_guid,field_name,raw_bits FROM read_parquet(?) WHERE object_net_guid IS NULL AND field_name IN ('Owner','PlayerState') ORDER BY time_ms,packet_id",[fields]).fetchall():
        if raw:
            bindings[(guid,name)].append([t,unpack_reference(raw)])

    def instigator_subject(guid,t,seen=None):
        seen = set() if seen is None else seen
        if guid in seen or len(seen)>8:
            return None,[]
        if guid in by_body:
            return by_body[guid],[{"guid":guid,"kind":"player_body"}]
        seen.add(guid)
        for field in ("PlayerState","Owner"):
            rows = bindings[(guid,field)]
            i = bisect_right([v[0] for v in rows],t)-1
            if i < 0:
                continue
            target = rows[i][1]
            if field == "PlayerState":
                subject,chain = player_states.get(target),[]
            else:
                subject,chain = instigator_subject(target,t,seen.copy())
            if subject:
                return subject,[{"guid":guid,"field":field,"target_guid":target,"observed_ms":rows[i][0]},*chain]
        return None,[]
    round_times = [r["start_ms"] for r in rounds]
    for t, packet, guid, event, cls, x,y,z in actor_rows:
        if event == "open" and cls in profiles and guid not in opens:
            ri = bisect_right(round_times,t)-1
            if ri < 0 or None in (x,y,z):
                diagnostics["smoke_missing_open_position"] += 1
                continue
            profile = profiles[cls]
            row = {"id": f"smoke-{guid}-{packet}", "actor_net_guid": guid,"profile": cls,"round": rounds[ri]["index"],
                   "start_ms": t,"end_ms": min(rounds[ri]["end_ms"], t+profile["delay_ms"]+profile["duration_ms"]+profile["contract_ms"]),
                   "end_reason": "asset_duration_or_round_boundary", "positions": [[t,x,y,z]], "subject": None}
            opens[guid] = row
            smokes.append(row)
        elif event == "close" and guid in opens:
            row = opens.pop(guid)
            if t < row["end_ms"]:
                row["end_ms"],row["end_reason"] = t,"observed_channel_close"
    smoke_ids = list({s["actor_net_guid"] for s in smokes})
    if smoke_ids:
        states = con.execute("SELECT time_ms,actor_net_guid,field_name,value_str,raw_bits FROM read_parquet(?) WHERE actor_net_guid IN (SELECT unnest(?)) AND field_name IN ('ReplicatedMovement','Instigator') ORDER BY time_ms,packet_id",[fields,smoke_ids]).fetchall()
        by_guid = defaultdict(list)
        for smoke in smokes:
            by_guid[smoke["actor_net_guid"]].append(smoke)
        for t,guid,name,string,raw in states:
            for row in by_guid[guid]:
                if row["start_ms"] <= t < row["end_ms"]:
                    if name == "Instigator":
                        row["subject"],row["instigator_join"] = instigator_subject(unpack_reference(raw),t)
                    elif string:
                        loc = json.loads(string)["location"]
                        position = [loc[a] for a in "xyz"]
                        if position != row["positions"][-1][1:]:
                            row["positions"].append([t,*position])
        diagnostics["modeled_smoke_zones"] = len(smokes)
        diagnostics["smoke_owners_unresolved"] = sum(s["subject"] is None for s in smokes)

    zoom, current, snapshots = defaultdict(dict), defaultdict(list), {}
    rows = con.execute("SELECT time_ms,packet_id,actor_net_guid,object_net_guid,group_path,field_name,value_f64,raw_bits FROM read_parquet(?) WHERE group_path='/Script/ShooterGame.ZoomMultiplierComponent' OR field_name='NewCurrentEquippable' ORDER BY time_ms,packet_id",[fields]).fetchall()
    changes = defaultdict(dict)
    for t,packet,actor,obj,group,name,real,raw in rows:
        if name == "NewCurrentEquippable" and actor in by_body:
            current[by_body[actor]].append([t,unpack_reference(raw)])
        elif group == "/Script/ShooterGame.ZoomMultiplierComponent" and name in ("TargetFov", "SourceFov", "TargetFov1P", "SourceFov1P", "TotalTransitionTimeDuration"):
            changes[(t,packet,actor,obj)][name] = real
    for (t,packet,actor,obj),values in changes.items():
        state = zoom[(actor,obj)]
        state.update(values)
        if "TargetFov" in values:
            target, source, duration = state.get("TargetFov"), state.get("SourceFov"), state.get("TotalTransitionTimeDuration",0)
            if source is None or target is None or not (0<source<180 and 0<target<180):
                diagnostics["invalid_or_missing_zoom_values"] += 1
                continue
            snapshots.setdefault(actor,defaultdict(list))[obj].append([t,source,target,duration*1000,state.get('SourceFov1P'),state.get('TargetFov1P')])
    weapon_fovs = {}
    for actor, components in snapshots.items():
        if len(components) == 1:
            weapon_fovs[str(actor)] = next(iter(components.values()))
        else:
            diagnostics["ambiguous_zoom_components_excluded"] += 1
    diagnostics["zoom_target_samples"] = sum(len(v) for v in weapon_fovs.values())
    diagnostics["active_weapon_samples"] = sum(len(v) for v in current.values())
    fov_events = []
    for subject, active_rows in current.items():
        times = [v[0] for v in active_rows]
        for weapon, settings in weapon_fovs.items():
            for setting in settings:
                t,source,target,duration = setting[:4]
                i,ri = bisect_right(times,t)-1,bisect_right(round_times,t)-1
                if i >= 0 and ri >= 0 and str(active_rows[i][1]) == weapon and (source != target or target != 103):
                    fov_events.append({"kind":"world_fov_target_observed","round":rounds[ri]["index"],"time_ms":t,
                                       "subject":subject,"weapon_net_guid":int(weapon),"source_fov_deg":source,
                                       "target_fov_deg":target,"transition_ms":duration,
                                       "source_weapon_fov_deg":setting[4],"target_weapon_fov_deg":setting[5],
                                       "evidence":"active_equippable_and_zoom_multiplier_fields"})
    controller_subject, crouch = {}, defaultdict(list)
    inputs = con.execute("SELECT time_ms,actor_net_guid,field_name,raw_bits,value_bool FROM read_parquet(?) WHERE (field_name='PlayerState' OR field_name='bCrouchHeld') AND regexp_matches(group_path, '/Characters/[^/]+/[^/]+_PC[.]') ORDER BY time_ms,packet_id",[fields]).fetchall()
    for t,controller,name,raw,held in inputs:
        if name == "PlayerState":
            controller_subject[controller] = player_states.get(unpack_reference(raw))
        elif held is not None and controller_subject.get(controller):
            rows = crouch[controller_subject[controller]]
            if not rows or rows[-1][1] != held:
                rows.append([t,held])
    diagnostics["fov_events_with_active_weapon_join"] = len(fov_events)
    diagnostics["crouch_input_changes"] = sum(len(v) for v in crouch.values())
    vision, vision_diagnostics = extract_vision(con,export,model,by_body,rounds)
    diagnostics.update(vision_diagnostics)
    stance = {s:crouch_transitions(rows,model['camera']['crouch_time_ms']) for s,rows in crouch.items()} if model and 'camera' in model else {}
    return {"model": model, "smokes": smokes, "camera": {"active_weapon": dict(current), "weapon_fov": weapon_fovs,
            "active_weapon_field":"AresInventory.NewCurrentEquippable",
            "sample_columns": ["time_ms", "source_world_fov_deg", "target_world_fov_deg", "transition_ms", "source_weapon_fov_deg", "target_weapon_fov_deg"],
            "transition_kind": "linear_approximation", "fallback_fov_deg": 103.,
            "crouch_kind": "input_driven_asset_stance_model", "crouch_inputs":dict(crouch),
            "stance_transitions":stance,"stance_columns":["time_ms","source_fraction","target_fraction","transition_ms"]},
            "vision_effects":vision,
            "fov_events": fov_events, "diagnostics": dict(diagnostics)}


def modeled_smoke_sightline(asset_state, start, end, time_ms, round_index):
    result = {"kind": "asset_smoke_model", "boundary_crossings": [], "observer_inside": [], "target_inside": []}
    for s in asset_state["smokes"]:
        if s["round"] != round_index or not s["start_ms"] <= time_ms < s["end_ms"]:
            continue
        radius = smoke_radius(asset_state["model"]["smoke_profiles"][s["profile"]],time_ms-s["start_ms"])
        if radius <= 0:
            continue
        i = bisect_right([p[0] for p in s["positions"]],time_ms)-1
        profile = asset_state["model"]["smoke_profiles"][s["profile"]]
        hit = smoke_intersection(asset_state["model"],profile,start,end,s["positions"][i][1:],radius)
        for field,key in (("boundary","boundary_crossings"),("inside_observer","observer_inside"),("inside_target","target_inside")):
            if hit[field]:
                result[key].append(s["id"])
    return result
