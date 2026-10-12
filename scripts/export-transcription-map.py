"""Extract a minimap and opaque static art meshes for local replay review.

Reads installed game assets only. The result is a static geometry approximation,
not rendered player perception: dynamic effects, masked pixels and camera pose
are outside this exporter. Keeps build and archive provenance explicit.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AES = "0x4BE71AF2459CF83899EC9DC2CB60E22AC4B3047E0211034BBABE9D174C069DD6"
MAPPING_SHA = "5555dd628883df9d9f68272a2099e4f7bfc15bcdcc8cb9bf31216a61bb1174dc"

# This always-loaded Lotus exterior contains static shell walls and pillars, but
# its serialized package name predates the usual `_Art_` separator. Keep the
# exception exact: gameplay, barriers and arbitrary similarly named packages
# still require their own evidence and replay state before they can occlude.
STATIC_ART_LEVEL_EXCEPTIONS = {"Jam": {"Jam_ArtDefPathCExterior"}}


def classify_static_art_level(map_code, asset, streaming_class):
    """Select serialized always-loaded art levels, with an explicit reason."""
    if streaming_class != "ULevelStreamingAlwaysLoaded":
        return False, "streaming_class_not_always_loaded"
    path, separator, object_name = asset.partition(".")
    if not separator or object_name != path.rsplit("/", 1)[-1]:
        return False, "invalid_world_asset_reference"
    prefix = f"/Game/Maps/{map_code}/"
    if not path.startswith(prefix):
        return False, "not_map_static_art"
    name = path.removeprefix(prefix)
    if "/" in name:
        return False, "not_map_static_art"
    if name.startswith(f"{map_code}_Art_"):
        return True, "serialized_always_loaded_art_level"
    if name in STATIC_ART_LEVEL_EXCEPTIONS.get(map_code, set()):
        return True, "explicit_static_art_naming_exception"
    return False, "not_selected_static_art"


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def properties(obj):
    return {str(t.Name): t.Tag.Value for t in obj.Properties if hasattr(t.Tag, "Value")}


def unwrap(value):
    return getattr(value, "Value", value)


def load(ref):
    ref = unwrap(ref)
    if ref is None or not hasattr(ref, "TryLoad"):
        return None
    ok, obj = ref.TryLoad()
    return obj if ok else None


def initialize(args):
    sys.path.insert(0, str(ROOT / ".tools/map-python-libs"))
    import pythonnet
    runtime = ROOT / ".tools/dotnet-runtime"
    versions = sorted((runtime / "shared/Microsoft.NETCore.App").glob("10.*"))
    if not versions:
        raise ValueError("Stage the existing local FModel/.NET map tooling first")
    config = runtime / "transcription.runtimeconfig.json"
    config.write_text(json.dumps({"runtimeOptions": {"tfm": "net10.0", "framework": {
        "name": "Microsoft.NETCore.App", "version": versions[-1].name}}}), encoding="utf-8")
    pythonnet.load("coreclr", runtime_config=str(config), dotnet_root=str(runtime))
    import clr
    libraries = ROOT / ".tools/fmodel/libs"
    sys.path.append(str(libraries))
    native_handle = os.add_dll_directory(str(libraries))
    clr.AddReference("CUE4Parse")
    from CUE4Parse.FileProvider import DefaultFileProvider
    from CUE4Parse.Encryption.Aes import FAesKey
    from CUE4Parse.MappingsProvider.Usmap import FileUsmapTypeMappingsProvider
    from CUE4Parse.UE4.Objects.Core.Misc import FGuid
    from CUE4Parse.UE4.Versions import EGame, VersionContainer
    from System import StringComparer
    from System.IO import SearchOption
    reader = DefaultFileProvider(str(args.paks), SearchOption.TopDirectoryOnly,
                                 VersionContainer(EGame.GAME_Valorant), StringComparer.OrdinalIgnoreCase)
    reader.Initialize()
    reader.SubmitKey(FGuid(0, 0, 0, 0), FAesKey(args.aes_key))
    reader.PostMount()
    reader.MappingsContainer = FileUsmapTypeMappingsProvider(str(args.mappings), StringComparer.OrdinalIgnoreCase)
    return reader, native_handle


def material_mode(ref, cache, seen=None):
    key = str(unwrap(ref))
    if key in cache:
        return cache[key]
    seen = set() if seen is None else seen
    if key in seen:
        return "unknown"
    seen.add(key)
    obj = load(ref)
    mode = "unknown"
    if obj is not None:
        p = properties(obj)
        override = getattr(p.get("BasePropertyOverrides"), "StructType", None)
        op = properties(override) if override is not None and hasattr(override, "Properties") else {}
        if op.get("bOverride_BlendMode"):
            mode = str(op.get("BlendMode", "unknown"))
        elif "Parent" in p:
            mode = material_mode(p["Parent"], cache, seen)
        elif str(obj.GetType().Name) == "UMaterial":
            mode = str(getattr(obj, "BlendMode", p.get("BlendMode", "unknown")))
    cache[key] = mode
    return mode


def affine(transform, FVector):
    origin = transform.TransformPosition(FVector(0.0))
    base = np.array([float(origin.X), float(origin.Y), float(origin.Z)], dtype=np.float64)
    columns = []
    for xyz in ((1., 0., 0.), (0., 1., 0.), (0., 0., 1.)):
        point = transform.TransformPosition(FVector(*xyz))
        columns.append(np.array([float(point.X), float(point.Y), float(point.Z)]) - base)
    matrix = np.eye(4)
    matrix[:3, :3] = np.array(columns).T
    matrix[:3, 3] = base
    return matrix


def export(args):
    from PIL import Image
    args.out.mkdir(parents=True, exist_ok=True)
    if any((args.out / name).exists() for name in ("geometry.npz", "map.json", "minimap.png")):
        raise ValueError("Output already contains map artifacts; use a new directory")
    mapping_hash = digest(args.mappings)
    if args.mapping_sha256 and mapping_hash != args.mapping_sha256:
        raise ValueError("Mapping does not match its expected SHA-256")
    archive_before = {p.name: [p.stat().st_size, p.stat().st_mtime_ns, digest(p)]
                      for p in args.paks.glob("*.utoc")}
    overlay_base = getattr(args, "overlay_base", None)
    overlay_of = None
    base_levels = set()
    if overlay_base is not None:
        base_metadata = json.loads((overlay_base / "map.json").read_text(encoding="utf-8"))
        if base_metadata.get("map_path") != f"/Game/Maps/{args.map}/{args.map}":
            raise ValueError("Overlay base belongs to another map")
        if base_metadata.get("mapping_sha256") != mapping_hash or base_metadata.get("archive_utoc_sha256") != archive_before:
            raise ValueError("Overlay base does not match installed archive and mapping provenance")
        if digest(overlay_base / "geometry.npz") != base_metadata.get("geometry_sha256"):
            raise ValueError("Overlay base geometry no longer matches its provenance")
        base_levels = set(base_metadata.get("included_levels", []))
        overlay_of = {"map_json_sha256": digest(overlay_base / "map.json"),
                      "geometry_sha256": base_metadata["geometry_sha256"],
                      "included_levels": sorted(base_levels),
                      "evidence": "new_static_art_levels_absent_from_verified_base_export"}
    reader, native_handle = initialize(args)
    from CUE4Parse.UE4.Objects.Core.Math import FVector, FRotator, FTransform
    world_package = f"ShooterGame/Content/Maps/{args.map}/{args.map}.umap"
    exports = list(reader.LoadPackage(world_package).GetExports())
    ui_package = f"ShooterGame/Content/Maps/{args.map}/{args.map}_UIData.uasset"
    ui_default = next(x for x in reader.LoadPackage(ui_package).GetExports() if str(x.Name).startswith("Default__"))
    ui = properties(ui_default)
    minimap_transform = {"name": str(ui["DisplayName"]),
                         "x_multiplier": float(ui["XMultiplier"]), "y_multiplier": float(ui["YMultiplier"]),
                         "x_scalar": float(ui["XScalarToAdd"]), "y_scalar": float(ui["YScalarToAdd"]),
                         "source": ui_package, "evidence": "serialized_map_ui_defaults"}
    world = next(x for x in exports if str(x.GetType().Name) == "UWorld")
    levels = []
    included_level_evidence = []
    excluded_levels = []
    for ref in world.StreamingLevels:
        obj = load(ref)
        if obj is None:
            excluded_levels.append({"reason": "unresolved_streaming_reference"})
            continue
        p = properties(obj)
        asset = str(p.get("WorldAsset", ""))
        path = asset.split(".", 1)[0]
        kind = str(obj.GetType().Name)
        # Never add blockout, nav meshes, collision volumes, buy barriers, or
        # inactive dynamic levels merely because their packages are readable.
        include, reason = classify_static_art_level(args.map, asset, kind)
        if not include:
            excluded_levels.append({"asset": asset, "streaming_class": kind, "reason": reason})
            continue
        if "LevelTransform" in p:
            raise ValueError("Streaming level transform needs explicit handling")
        package = "ShooterGame/Content/" + path.removeprefix("/Game/") + ".umap"
        if overlay_base is not None and package in base_levels:
            continue
        levels.append(package)
        included_level_evidence.append({"asset": asset, "streaming_class": kind, "reason": reason})

    if not levels:
        raise ValueError("No newly eligible static art levels to export" if overlay_base is not None else "No eligible static art levels to export")

    skipped = Counter()
    materials = Counter()
    mesh_cache, material_cache = {}, {}
    batches, sources, source_ids = [], [], []
    component_count = 0
    transform_cache = {}

    def component_transform(component, seen=None):
        key = (str(component.Outer), str(component.Name))
        if key in transform_cache:
            return transform_cache[key]
        seen = set() if seen is None else seen
        if key in seen:
            raise ValueError("Cyclic component attachment")
        seen.add(key)
        p = properties(component)
        def struct(name, default):
            value = getattr(p.get(name), "StructType", None)
            return value if value is not None else default
        transform = FTransform(struct("RelativeRotation", FRotator()),
                               struct("RelativeLocation", FVector(0.0)),
                               struct("RelativeScale3D", FVector(1.0)))
        matrix = affine(transform, FVector)
        parent_ref = p.get("AttachParent")
        if parent_ref is not None:
            parent = load(parent_ref)
            if parent is None:
                raise ValueError("Unresolved component attachment")
            matrix = component_transform(parent, seen) @ matrix
        if "ComponentToWorld" in p:
            raise ValueError("Serialized ComponentToWorld needs explicit handling")
        transform_cache[key] = matrix
        return matrix

    for package in levels:
        level = list(reader.LoadPackage(package).GetExports())
        before = sum(len(x) for x in batches)
        roots = {}
        for actor in level:
            if str(actor.GetType().Name) != "AStaticMeshActor":
                continue
            p = properties(actor)
            component = load(p.get("RootComponent"))
            if component is not None:
                roots[(str(component.Outer), str(component.Name))] = (str(actor.Name), bool(p.get("bHiddenInGame", False)))
        for component in level:
            kind = str(component.GetType().Name)
            if kind not in ("UStaticMeshComponent", "UInstancedStaticMeshComponent", "UHierarchicalInstancedStaticMeshComponent"):
                continue
            p = properties(component)
            label, actor_hidden = roots.get((str(component.Outer), str(component.Name)), (str(component.Name), False))
            if actor_hidden or bool(p.get("bHiddenInGame", False)) or p.get("bVisible") is False:
                skipped["hidden_component"] += 1
                continue
            try:
                transform = component_transform(component)
            except ValueError:
                skipped["unresolved_component_transform"] += 1
                continue
            mesh_ref = p.get("StaticMesh")
            key = str(mesh_ref)
            if key not in mesh_cache:
                mesh = load(mesh_ref)
                if mesh is None or mesh.RenderData is None or not mesh.RenderData.LODs:
                    skipped["mesh_missing"] += 1
                    continue
                lod = mesh.RenderData.LODs[0]
                if lod.PositionVertexBuffer is None or lod.IndexBuffer is None:
                    skipped["mesh_buffers_missing"] += 1
                    continue
                vertices = np.array([[float(v.X), float(v.Y), float(v.Z)] for v in lod.PositionVertexBuffer.Verts])
                indices = np.array(list(lod.IndexBuffer.Buffer), dtype=np.int64)
                sections = [(int(s.FirstIndex), int(s.NumTriangles), int(s.MaterialIndex)) for s in lod.Sections]
                mesh_cache[key] = vertices, indices, sections, [m.MaterialInterface for m in mesh.StaticMaterials]
            vertices, indices, sections, default_materials = mesh_cache[key]
            overrides = [unwrap(x) for x in p["OverrideMaterials"].Properties] if "OverrideMaterials" in p else []
            instances = [np.eye(4)]
            if kind != "UStaticMeshComponent":
                if component.PerInstanceSMData is None:
                    skipped["instance_data_missing"] += 1
                    continue
                instances = [affine(i.TransformData, FVector) for i in component.PerInstanceSMData]
            selected = []
            for first, count, mi in sections:
                ref = overrides[mi] if mi < len(overrides) and load(overrides[mi]) is not None else default_materials[mi] if mi < len(default_materials) else None
                mode = material_mode(ref, material_cache)
                materials[mode] += count * len(instances)
                if not mode.endswith("BLEND_Opaque"):
                    skipped["non_opaque_or_unknown_triangles"] += count * len(instances)
                    continue
                if first < 0 or first + count*3 > len(indices):
                    raise ValueError("Invalid mesh section")
                selected.extend(indices[first:first + count*3])
            if not selected:
                continue
            selection = np.array(selected).reshape(-1, 3)
            if selection.min() < 0 or selection.max() >= len(vertices):
                raise ValueError("Invalid mesh vertex reference")
            source_index = len(sources)
            sources.append({"package": package, "component": label, "mesh": key})
            for instance in instances:
                matrix = transform @ instance
                points = vertices @ matrix[:3, :3].T + matrix[:3, 3]
                triangles = points[selection].astype(np.float32)
                normal = np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0])
                triangles = triangles[np.linalg.norm(normal, axis=1) > 1e-4]
                batches.append(triangles)
                source_ids.append(np.full(len(triangles), source_index, dtype=np.int32))
                component_count += 1
        print(f"{package.rsplit('/', 1)[-1]}: {sum(len(x) for x in batches)-before:,} triangles", flush=True)

    if not batches:
        raise ValueError("No opaque static art mesh triangles decoded")
    triangles = np.concatenate(batches)
    np.savez_compressed(args.out / "geometry.npz", triangles=triangles, source_ids=np.concatenate(source_ids))
    # Export the actual game texture, rather than use its image as occlusion.
    import clr
    clr.AddReference("CUE4Parse-Conversion")
    from CUE4Parse_Conversion.Textures import TextureDecoder, TextureEncoder
    from CUE4Parse.UE4.Assets.Exports.Texture import ETexturePlatform
    settings = next(x for x in exports if str(x.Name) == "AresWorldSettings")
    overlay = str(properties(settings)["MinimapVisionOverlay"])
    overlay_path = overlay.split("'", 2)[1].split(".", 1)[0]
    texture_package = "ShooterGame/Content/" + overlay_path.removeprefix("/Game/") + ".uasset"
    texture = next(x for x in reader.LoadPackage(texture_package).GetExports() if str(x.GetType().Name) == "UTexture2D")
    TextureDecoder.UseAssetRipperTextureDecoder = True
    decoded = TextureDecoder.Decode(texture, ETexturePlatform.DesktopMobile)
    # CTexture holds decoded pixels; the export below uses its own Skia bridge.
    bitmap = TextureEncoder.ToSkBitmap(decoded)
    from SkiaSharp import SKEncodedImageFormat
    encoded = bitmap.Encode(SKEncodedImageFormat.Png, 100)
    (args.out / "minimap.png").write_bytes(bytes(encoded.ToArray()))
    bitmap.Dispose()
    encoded.Dispose()
    archive_after = {p.name: [p.stat().st_size, p.stat().st_mtime_ns, digest(p)] for p in args.paks.glob("*.utoc")}
    if archive_before != archive_after:
        raise ValueError("Installed archive inventory changed during extraction")
    metadata = {"schema_version": 1, "map_path": f"/Game/Maps/{args.map}/{args.map}",
                "mapping_build": args.mapping_build, "mapping_sha256": mapping_hash,
                "aes_source": "https://uedb.dev/game/valorant", "geometry_complete": False,
                "asset_build_verified_against_replay": False,
                "archive_utoc_sha256": archive_before, "included_levels": levels,
                "included_level_evidence": included_level_evidence,
                "excluded_levels": excluded_levels, "sources": sources,
                "triangles": len(triangles), "mesh_instances": component_count,
                "material_triangles": dict(materials), "skipped": dict(skipped),
                "minimap_source": texture_package, "geometry_sha256": digest(args.out / "geometry.npz"),
                "minimap_transform": minimap_transform,
                "limitations": ["Static opaque art meshes only; masked and transparent surfaces omitted.",
                                "Dynamic barriers, smokes, flashes and reveals are not reconstructed.",
                                "Installed asset build is not certified by the mapping version.",
                                "Camera eye, anatomy and FOV are approximations in the viewer."]}
    if overlay_of is not None:
        metadata["overlay_of"] = overlay_of
        metadata["limitations"].append("Overlay contains only newly selected static art; combine with its verified base geometry.")
    (args.out / "map.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Exported {len(triangles):,} triangles and minimap to {args.out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", default="Infinity")
    parser.add_argument("--paks", type=Path, default=Path(r"C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks"))
    parser.add_argument("--mappings", type=Path, default=ROOT / ".tools/fmodel/mappings/VALORANT_13.06_zs.usmap")
    parser.add_argument("--mapping-sha256", default=MAPPING_SHA)
    parser.add_argument("--mapping-build", default="13.06")
    parser.add_argument("--aes-key", default=AES)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--overlay-base", type=Path,
                        help="Export only selected art levels missing from this verified map directory, into a new --out directory")
    args = parser.parse_args()
    if not args.map.isalnum():
        parser.error("Map must be its package code, e.g. Infinity")
    export(args)


if __name__ == "__main__":
    main()
