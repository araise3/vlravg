"""Read serialized game-asset defaults and curves with explicit provenance.

Does not run the game or infer native code behavior from property names.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re

from replay_asset_model import make_asset_profile, MODEL_ROOTS, reference_package

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("transcription_map", ROOT / "scripts/export-transcription-map.py")
asset_map = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asset_map)


def value_json(value, depth=0):
    value = getattr(value, "__implementation__", value)
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if depth > 24:
        return {"unexpanded": str(value)}
    # Kismet structs can expose Properties or IEnumerable. Handle their actual
    # type before the generic containers or EX_StructConst loses its opcode.
    if hasattr(value, "GetType"):
        ty = value.GetType()
        namespace = str(ty.Namespace)
        if "Kismet" in namespace and not ty.IsArray:
            fields = {"expression_type": str(ty.Name)}
            for field in ty.GetFields():
                if field.IsStatic:
                    continue
                try:
                    fields[str(field.Name)] = value_json(field.GetValue(value), depth+1)
                except Exception as error:
                    fields[str(field.Name)] = {"unexpanded": str(error).splitlines()[0]}
            return fields
    if hasattr(value, "GetType") and str(value.GetType().Name) in ("FName", "FText"):
        return str(value)
    if hasattr(value, "TryLoad"):
        return {"reference": str(value)}
    if all(hasattr(value, key) for key in ("X", "Y", "Z", "W")):
        return {key: float(getattr(value, key)) for key in ("X", "Y", "Z", "W")}
    if all(hasattr(value, key) for key in ("X", "Y", "Z")):
        return {key: float(getattr(value, key)) for key in ("X", "Y", "Z")}
    if all(hasattr(value, key) for key in ("Pitch", "Yaw", "Roll")):
        return {key: float(getattr(value, key)) for key in ("Pitch", "Yaw", "Roll")}
    if hasattr(value, "StructType"):
        return value_json(value.StructType, depth+1)
    if hasattr(value, "Properties"):
        props = list(value.Properties)
        if props and hasattr(props[0], "Name"):
            return {str(t.Name): value_json(getattr(t.Tag, "Value", None), depth+1) for t in props}
        return [value_json(getattr(v, "Value", v), depth+1) for v in props]
    if hasattr(value, "Keys") and hasattr(value, "GetType"):
        return {str(x): value_json(value[x], depth+1) for x in value.Keys}
    if hasattr(value, "GetType"):
        ty = value.GetType()
        if str(ty.Name) in ("Single", "Double", "Decimal"):
            return float(value)
        if str(ty.Name) in ("Int32", "Int64", "UInt32", "UInt64", "Byte", "Int16"):
            return int(value)
        fields = {}
        for f in ty.GetFields():
            if not f.IsStatic:
                try:
                    fields[str(f.Name)] = value_json(f.GetValue(value), depth+1)
                except Exception:
                    pass
        if fields:
            if str(ty.Name).endswith("Property") and str(ty.Namespace).endswith("UObject"):
                fields["property_type"] = str(ty.Name)
            return fields
    try:
        if not isinstance(value, str):
            return [value_json(v, depth+1) for v in value]
    except TypeError:
        pass
    return str(value)


def package_json(reader, path):
    result = {"package": path, "exports": []}
    try:
        for obj in reader.LoadPackage(path).GetExports():
            row = {"name": str(obj.Name), "type": str(obj.GetType().Name),
                   "properties": {k: value_json(v) for k, v in asset_map.properties(obj).items()}}
            for name in ("SuperStruct", "ClassDefaultObject", "DefaultObject", "FloatCurve", "VectorCurves",
                         "SphereRadius", "CapsuleRadius", "CapsuleHalfHeight", "FieldOfView",
                         "BoneTree", "SkeletalBodySetups", "ScriptBytecode", "FunctionFlags", "RowMap"):
                if hasattr(obj, name):
                    try:
                        row[name] = value_json(getattr(obj, name))
                    except Exception:
                        pass
            result["exports"].append(row)
            if str(obj.GetType().Name) == "UStaticMesh" and obj.RenderData and obj.RenderData.LODs:
                lod = obj.RenderData.LODs[0]
                if lod.PositionVertexBuffer and lod.IndexBuffer:
                    row["mesh_lod0"] = {"vertices": [[float(v.X),float(v.Y),float(v.Z)] for v in lod.PositionVertexBuffer.Verts],
                                        "indices": list(lod.IndexBuffer.Buffer)}
    except Exception as error:
        result["error"] = str(error).splitlines()[0]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paks", type=Path, default=Path(r"C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks"))
    parser.add_argument("--mappings", type=Path, default=ROOT / ".tools/fmodel/mappings/VALORANT_13.06_zs.usmap")
    parser.add_argument("--aes-key", default=asset_map.AES)
    parser.add_argument("--find", action="append", default=[])
    parser.add_argument("--package", action="append", default=[])
    parser.add_argument("--packages-json", type=Path, help="JSON list of installed package paths to inspect")
    parser.add_argument("--follow-inheritance", action="store_true", help="Include Blueprint parent defaults")
    parser.add_argument("--follow-animations", action="store_true", help="Recursively include referenced montage, sequence and blend-space metadata")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", type=Path, help="Also export the replay camera/capsule/smoke model, following asset inheritance and curve references")
    parser.add_argument("--read-script-data", action="store_true", help="Decode shipped Blueprint expressions for behavior inspection")
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    reader, handle = asset_map.initialize(args)
    reader.ReadScriptData = args.read_script_data or bool(args.model)
    keys = sorted(str(x.Key) for x in reader.Files)
    matches = [k for k in keys if k.endswith((".uasset", ".umap")) and any(re.search(p, k, re.I) for p in args.find)]
    inventory = {p.name: {"bytes": p.stat().st_size, "sha256": asset_map.digest(p)} for p in args.paks.glob("*.utoc")}
    requested = json.loads(args.packages_json.read_text(encoding="utf-8")) if args.packages_json else []
    packages, seen, pending = [], set(), list(dict.fromkeys(args.package + requested + (MODEL_ROOTS if args.model else [])))
    while pending:
        path = pending.pop(0)
        if path in seen:
            continue
        seen.add(path)
        package = package_json(reader, path)
        packages.append(package)
        if args.follow_animations:
            def animation_refs(value):
                if isinstance(value, dict):
                    ref=value.get('reference','')
                    if ref.startswith(('AnimMontage\'', 'AnimSequence\'', 'BlendSpace')):
                        target=reference_package(value)
                        if target:yield target
                    for child in value.values():yield from animation_refs(child)
                elif isinstance(value, list):
                    for child in value:yield from animation_refs(child)
            for obj in package.get('exports',[]):
                for target in animation_refs(obj.get('properties',{})):
                    if target not in seen:pending.append(target)
        if args.model or args.follow_inheritance:
            for obj in package.get("exports", []):
                refs = [obj.get("SuperStruct")]
                refs += [obj["properties"].get(k) for k in ("ExpandCurve", "ContractCurve", "BlindByDistanceCurve", "BlindCurve")]
                refs.append(obj["properties"].get("BlindedEffectContainer"))
                if obj["name"] == "HollowVisionBlockingSphere_GEN_VARIABLE":
                    refs.append(obj["properties"].get("StaticMesh"))
                for ref in refs:
                    target = reference_package(ref)
                    if target and target not in seen:
                        pending.append(target)
    if inventory != {p.name: {"bytes": p.stat().st_size, "sha256": asset_map.digest(p)} for p in args.paks.glob("*.utoc")}:
        raise ValueError("Installed asset inventory changed during inspection")
    report = {"schema_version": 1, "mapping_build": "13.06", "mapping_sha256": asset_map.digest(args.mappings),
              "asset_build_verified_against_replay": False, "read_script_data": bool(reader.ReadScriptData),
              "archives": inventory, "matches": matches, "packages": packages}
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    if args.model:
        model = make_asset_profile(report)
        args.model.parent.mkdir(parents=True, exist_ok=True)
        args.model.write_text(json.dumps(model, indent=2, allow_nan=False), encoding="utf-8")
    print(f"{len(matches)} matching packages; {len(packages)} inspected; {args.out}")


if __name__ == "__main__":
    main()
