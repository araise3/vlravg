"""Regression checks for the static-art overlay composition boundary."""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("overlay_audit", ROOT / "audit-map-art-overlay.py")
overlay_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay_audit)
exporter = overlay_audit.map_export
BASE_LEVEL = "ShooterGame/Content/Maps/Jam/Jam_Art_CSite.umap"
NEW_LEVEL = "ShooterGame/Content/Maps/Jam/Jam_ArtDefPathCExterior.umap"
WORLD_ASSET = "/Game/Maps/Jam/Jam_ArtDefPathCExterior.Jam_ArtDefPathCExterior"


class ClassificationTests(unittest.TestCase):
    def test_exact_exception_and_normal_always_loaded_art(self):
        self.assertEqual(exporter.classify_static_art_level("Jam", WORLD_ASSET, "ULevelStreamingAlwaysLoaded"),
                         (True, "explicit_static_art_naming_exception"))
        self.assertEqual(exporter.classify_static_art_level("Jam", "/Game/Maps/Jam/Jam_Art_CSite.Jam_Art_CSite", "ULevelStreamingAlwaysLoaded"),
                         (True, "serialized_always_loaded_art_level"))

    def test_similar_names_other_maps_and_gameplay_do_not_expand_the_exception(self):
        for asset in (WORLD_ASSET.replace("CExterior", "CExteriorCopy"),
                      WORLD_ASSET.replace("/Jam/", "/Jam_Copy/"),
                      "/Game/Maps/Jam/Jam_Gameplay.Jam_Gameplay",
                      "/Game/Maps/Jam/Jam_BVPawn.Jam_BVPawn",
                      "/Game/Maps/Jam/Jam_Navmesh.Jam_Navmesh",
                      "/Game/Maps/Jam/Other/Jam_Art_CSite.Jam_Art_CSite",
                      WORLD_ASSET.replace(".Jam_ArtDefPathCExterior", ".OtherWorld"),
                      WORLD_ASSET.split(".")[0]):
            with self.subTest(asset=asset):
                self.assertFalse(exporter.classify_static_art_level("Jam", asset, "ULevelStreamingAlwaysLoaded")[0])

    def test_dynamic_art_does_not_become_an_always_active_wall(self):
        self.assertFalse(exporter.classify_static_art_level("Jam", WORLD_ASSET, "ULevelStreamingDynamic")[0])


class OverlayReceiptTests(unittest.TestCase):
    def setUp(self):
        temporary_root = (ROOT.parent / ".local/replay-transcripts").resolve()
        self.temp = tempfile.TemporaryDirectory(prefix="overlay-test-", dir=temporary_root)
        # All cleanup targets are created by this test and stay in the workspace.
        self.assertTrue(Path(self.temp.name).resolve().is_relative_to(temporary_root))
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.base, self.overlay = root / "base", root / "overlay"
        self.base.mkdir()
        self.overlay.mkdir()
        triangle = np.array([[[50, -100, -100], [50, 100, -100], [50, 0, 150]]], dtype=np.float32)
        np.savez_compressed(self.base / "geometry.npz", triangles=triangle + [1000, 0, 0], source_ids=np.array([0], dtype=np.int32))
        np.savez_compressed(self.overlay / "geometry.npz", triangles=triangle, source_ids=np.array([0], dtype=np.int32))
        common = {"map_path": "/Game/Maps/Jam/Jam", "mapping_sha256": "mapping_receipt",
                  "archive_utoc_sha256": {"pak.utoc": [10, 1, "archive_receipt"]},
                  "triangles": 1, "minimap_transform": {"x_multiplier": 0.001}}
        self.base_meta = {**common, "included_levels": [BASE_LEVEL],
                          "geometry_sha256": exporter.digest(self.base / "geometry.npz")}
        self.save(self.base, self.base_meta)
        self.overlay_meta = {**common, "included_levels": [NEW_LEVEL], "mesh_instances": 1,
                             "geometry_sha256": exporter.digest(self.overlay / "geometry.npz"),
                             "material_triangles": {"BLEND_Opaque": 1},
                             "sources": [{"package": NEW_LEVEL, "mesh": "RepresentativeWall", "component": "Wall"}],
                             "included_level_evidence": [{"asset": WORLD_ASSET, "streaming_class": "ULevelStreamingAlwaysLoaded",
                                                          "reason": "explicit_static_art_naming_exception"}],
                             "overlay_of": {"map_json_sha256": exporter.digest(self.base / "map.json"),
                                            "geometry_sha256": self.base_meta["geometry_sha256"], "included_levels": [BASE_LEVEL]}}
        self.save(self.overlay, self.overlay_meta)
        for directory in (self.base, self.overlay):
            (directory / "minimap.png").write_bytes(b"same immutable minimap")

    @staticmethod
    def save(directory, meta):
        (directory / "map.json").write_text(json.dumps(meta), encoding="utf-8")

    def rejected(self):
        self.save(self.overlay, self.overlay_meta)
        with self.assertRaises(ValueError):
            overlay_audit.audit(self.base, self.overlay, "RepresentativeWall")

    def test_composed_wall_and_reverse_ray_match_without_mutating_any_input(self):
        before = {str(p): exporter.digest(p) for p in Path(self.temp.name).rglob("*") if p.is_file()}
        result = overlay_audit.audit(self.base, self.overlay, "RepresentativeWall")
        example = result["missing_geometry_examples"][0]
        self.assertIsNone(example["base_hit"])
        self.assertEqual(example["overlay_hit_fraction"], 0.5)
        self.assertEqual(example["overlay_hit_cm"], example["combined_hit_cm"])
        self.assertEqual(example["overlay_hit_cm"], example["reverse_overlay_hit_cm"])
        self.assertFalse(result["native_visual_fidelity_verified"])
        self.assertEqual(before, {str(p): exporter.digest(p) for p in Path(self.temp.name).rglob("*") if p.is_file()})

    def test_existing_export_directory_is_not_overwritten(self):
        with self.assertRaisesRegex(ValueError, "already contains map artifacts"):
            exporter.export(types.SimpleNamespace(out=self.overlay))

    def test_base_bytes_must_match_parent_receipt(self):
        with (self.base / "geometry.npz").open("ab") as output:
            output.write(b"changed")
        self.rejected()

    def test_overlay_bytes_must_match_geometry_receipt(self):
        with (self.overlay / "geometry.npz").open("ab") as output:
            output.write(b"changed")
        self.rejected()

    def test_mapping_and_archive_must_match_base(self):
        for key in ("mapping_sha256", "archive_utoc_sha256"):
            with self.subTest(key=key):
                value = self.overlay_meta[key]
                self.overlay_meta[key] = "foreign_build"
                self.rejected()
                self.overlay_meta[key] = value

    def test_parent_level_inventory_must_match_base(self):
        self.overlay_meta["overlay_of"]["included_levels"] = []
        self.rejected()

    def test_included_levels_need_matching_serialized_world_evidence(self):
        self.overlay_meta["included_level_evidence"][0]["streaming_class"] = "ULevelStreamingDynamic"
        self.rejected()

    def test_evidence_and_source_must_belong_to_the_exported_overlay_levels(self):
        self.overlay_meta["sources"][0]["package"] = "ShooterGame/Content/Maps/Jam/Jam_Gameplay.umap"
        self.rejected()

    def test_transparent_or_unknown_materials_are_not_certified_as_opaque(self):
        self.overlay_meta["material_triangles"] = {"unknown": 1}
        self.rejected()

    def test_invalid_geometry_cannot_be_composed_even_with_updated_receipt(self):
        np.savez_compressed(self.overlay / "geometry.npz", triangles=np.zeros((1, 3, 3), dtype=np.float32), source_ids=np.array([0], dtype=np.int32))
        self.overlay_meta["geometry_sha256"] = exporter.digest(self.overlay / "geometry.npz")
        self.rejected()


if __name__ == "__main__":
    unittest.main()
