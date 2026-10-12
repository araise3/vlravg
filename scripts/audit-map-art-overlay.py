"""Validate a new static-art overlay and show rays missing from its exact base.

The ray examples establish a static geometry coverage difference. They do not
certify a player's camera, gameplay state, material culling or visual perception.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np

from replay_transcription import MeshBVH

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("map_export", ROOT / "scripts/export-transcription-map.py")
map_export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(map_export)


def segment_candidates(triangles, minimums, maximums, start, end):
    low, high = np.minimum(start, end) - 1e-3, np.maximum(start, end) + 1e-3
    selection = ((maximums >= low) & (minimums <= high)).all(axis=1)
    return triangles[selection]


def verified_overlay_metadata(base_dir, overlay_dir):
    """Validate an additive overlay receipt against its exact immutable base.

    No artifact is modified. A caller may concatenate triangles only after
    this guard succeeds; original source IDs must remain scoped to each layer.
    """
    base_meta = json.loads((base_dir / "map.json").read_text(encoding="utf-8"))
    overlay_meta = json.loads((overlay_dir / "map.json").read_text(encoding="utf-8"))
    parent = overlay_meta.get("overlay_of", {})
    if map_export.digest(base_dir / "map.json") != parent.get("map_json_sha256"):
        raise ValueError("Base metadata no longer matches overlay parent receipt")
    if map_export.digest(base_dir / "geometry.npz") != parent.get("geometry_sha256") or parent.get("geometry_sha256") != base_meta.get("geometry_sha256"):
        raise ValueError("Base geometry no longer matches overlay parent receipt")
    if map_export.digest(overlay_dir / "geometry.npz") != overlay_meta.get("geometry_sha256"):
        raise ValueError("Overlay geometry no longer matches its receipt")
    for key in ("map_path", "mapping_sha256", "archive_utoc_sha256"):
        if base_meta.get(key) != overlay_meta.get(key):
            raise ValueError(f"Base and overlay have different {key}")
    if sorted(base_meta["included_levels"]) != parent.get("included_levels"):
        raise ValueError("Overlay parent level inventory differs from its base")
    if set(base_meta["included_levels"]) & set(overlay_meta["included_levels"]):
        raise ValueError("Overlay duplicates a level already included by the base")
    if len(set(overlay_meta["included_levels"])) != len(overlay_meta["included_levels"]):
        raise ValueError("Overlay contains duplicate level names")
    map_code = overlay_meta["map_path"].rsplit("/", 1)[-1]
    evidence_packages = []
    for level in overlay_meta["included_level_evidence"]:
        include, reason = map_export.classify_static_art_level(map_code, level["asset"], level["streaming_class"])
        if not include or level.get("reason") != reason:
            raise ValueError("Overlay includes an unverified static art level")
        path = level["asset"].split(".", 1)[0]
        evidence_packages.append("ShooterGame/Content/" + path.removeprefix("/Game/") + ".umap")
    if sorted(evidence_packages) != sorted(overlay_meta["included_levels"]):
        raise ValueError("Overlay level evidence differs from its exported inventory")
    if any(row.get("package") not in overlay_meta["included_levels"] for row in overlay_meta["sources"]):
        raise ValueError("Overlay source belongs to an unverified level")
    if overlay_meta.get("minimap_transform") != base_meta.get("minimap_transform"):
        raise ValueError("Overlay and base minimap coordinates differ")
    if map_export.digest(overlay_dir / "minimap.png") != map_export.digest(base_dir / "minimap.png"):
        raise ValueError("Overlay minimap differs from its base")
    return base_meta, overlay_meta


def audit(base_dir, overlay_dir, mesh_fragment):
    base_meta, overlay_meta = verified_overlay_metadata(base_dir, overlay_dir)
    parent = overlay_meta["overlay_of"]
    with np.load(base_dir / "geometry.npz") as base:
        base_triangles = base["triangles"].copy()
    with np.load(overlay_dir / "geometry.npz") as overlay:
        triangles, source_ids = overlay["triangles"].copy(), overlay["source_ids"].copy()
    if len(base_triangles) != base_meta["triangles"] or not np.isfinite(base_triangles).all():
        raise ValueError("Base geometry counts or coordinates differ from its metadata")
    if len(triangles) != overlay_meta["triangles"] or source_ids.shape != (len(triangles),):
        raise ValueError("Overlay counts differ from metadata")
    if triangles.shape != (len(triangles), 3, 3) or not np.isfinite(triangles).all():
        raise ValueError("Invalid overlay triangle coordinates")
    if not np.issubdtype(source_ids.dtype, np.integer) or len(source_ids) == 0 or source_ids.min() < 0 or source_ids.max() >= len(overlay_meta["sources"]):
        raise ValueError("Invalid overlay source references")
    if np.any(np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) <= 1e-4):
        raise ValueError("Overlay contains degenerate triangles")
    if set(overlay_meta["material_triangles"]) != {"BLEND_Opaque"}:
        raise ValueError("The verified overlay contains non-opaque or unknown material sections")
    if overlay_meta["material_triangles"]["BLEND_Opaque"] < len(triangles):
        raise ValueError("Overlay contains more triangles than its material-section inventory")

    mins, maxs = base_triangles.min(axis=1), base_triangles.max(axis=1)
    overlay_mins, overlay_maxs = triangles.min(axis=1), triangles.max(axis=1)
    examples = []
    fragments = [mesh_fragment] if isinstance(mesh_fragment, str) else mesh_fragment
    for fragment in fragments:
        selected_sources = [i for i, row in enumerate(overlay_meta["sources"]) if fragment in row["mesh"]]
        if not selected_sources:
            raise ValueError(f"Requested demonstration mesh is absent from the overlay: {fragment}")
        found = False
        for source_id in selected_sources:
            for triangle_id in np.flatnonzero(source_ids == source_id):
                triangle = triangles[triangle_id].astype(np.float64)
                normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
                normal /= np.linalg.norm(normal)
                # A short segment through a vertical face proves local coverage;
                # it does not claim both endpoints are reachable player cameras.
                if abs(normal[2]) > 0.2:
                    continue
                center = triangle.mean(axis=0)
                start, end = center - 25 * normal, center + 25 * normal
                base_near = segment_candidates(base_triangles, mins, maxs, start, end)
                if MeshBVH(base_near).hit(start, end) is not None:
                    continue
                overlay_near = segment_candidates(triangles, overlay_mins, overlay_maxs, start, end)
                hit = MeshBVH(overlay_near).hit(start, end)
                if hit is None:
                    raise ValueError("Ray failed to intersect its demonstrated overlay surface")
                # Check both segment directions and the composed geometry.
                reverse_hit = MeshBVH(overlay_near).hit(end, start)
                combined_hit = MeshBVH(np.concatenate([base_near, overlay_near])).hit(start, end)
                if reverse_hit is None or not np.allclose(combined_hit, hit, atol=1e-4):
                    raise ValueError("Overlay ray composition or reverse-direction regression failed")
                fraction = np.dot(np.asarray(hit) - start, end - start) / np.dot(end - start, end - start)
                examples.append({"mesh_fragment": fragment, "source": overlay_meta["sources"][source_id],
                                 "triangle_index": int(triangle_id), "triangle_cm": triangle.tolist(),
                                 "start_cm": start.tolist(), "end_cm": end.tolist(), "base_hit": None,
                                 "overlay_hit_fraction": float(fraction), "overlay_hit_cm": list(map(float, hit)),
                                 "reverse_overlay_hit_cm": list(map(float, reverse_hit)),
                                 "combined_hit_cm": list(map(float, combined_hit)),
                                 "base_candidate_triangles": len(base_near)})
                found = True
                break
            if found:
                break
        if not found:
            raise ValueError(f"Could not establish a new static ray obstruction for this mesh: {fragment}")
    if not examples:
        raise ValueError("Could not establish a new static ray obstruction for this mesh")
    return {"schema_version": 1, "passed": True, "map_path": overlay_meta["map_path"],
            "base_map_sha256": parent["map_json_sha256"], "base_geometry_sha256": parent["geometry_sha256"],
            "overlay_map_sha256": map_export.digest(overlay_dir / "map.json"),
            "overlay_geometry_sha256": overlay_meta["geometry_sha256"],
            "overlay_levels": overlay_meta["included_levels"], "overlay_triangles": len(triangles),
            "sources": len(overlay_meta["sources"]), "mesh_instances": overlay_meta["mesh_instances"],
            "audit_source_sha256": map_export.digest(Path(__file__)),
            "classifier_source_sha256": map_export.digest(ROOT / "scripts/export-transcription-map.py"),
            "bvh_source_sha256": map_export.digest(ROOT / "scripts/replay_transcription.py"),
            "missing_geometry_examples": examples, "native_visual_fidelity_verified": False,
            "limitations": ["Examples prove missing static mesh intersections, not actual player visibility.",
                            "Per-face material culling, runtime deformations and detail settings remain unverified.",
                            "Dynamic doors and barriers remain outside this overlay."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--mesh-fragment", action="append", help="Repeat for each representative obstruction mesh")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bvh-out", type=Path, help="Write full base/overlay BVH proof files into a new directory")
    args = parser.parse_args()
    result = audit(args.base, args.overlay, args.mesh_fragment or ["Atlas_0_CrateB", "Shell_0_CSitePillarA", "Shell_0_DefPathCVistaWall"])
    if args.bvh_out is not None:
        args.bvh_out.mkdir(parents=True, exist_ok=True)
        if any(args.bvh_out.iterdir()):
            raise ValueError("BVH proof output must be a new empty directory")
        proof = {}
        for label, directory in (("base", args.base), ("overlay", args.overlay)):
            expected = result[f"{label}_geometry_sha256"]
            if map_export.digest(directory / "geometry.npz") != expected:
                raise ValueError("Geometry changed before BVH proof export")
            with np.load(directory / "geometry.npz") as geometry:
                mesh = MeshBVH(geometry["triangles"])
            output = args.bvh_out / f"{label}.bvh"
            output.write_bytes(mesh.binary())
            if map_export.digest(directory / "geometry.npz") != expected:
                raise ValueError("Geometry changed during BVH proof export")
            proof[label] = {"file": str(output.resolve()), "sha256": map_export.digest(output),
                            "triangles": len(mesh.triangles), "nodes": len(mesh.nodes),
                            "source_geometry_sha256": expected}
            print(f"Exported {label} BVH proof: {len(mesh.triangles):,} triangles", flush=True)
        result["bvh_proof"] = proof
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Validated {result['overlay_triangles']:,} overlay triangles; {len(result['missing_geometry_examples'])} missing static obstruction examples")


if __name__ == "__main__":
    main()
