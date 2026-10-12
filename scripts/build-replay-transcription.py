"""Build a self-contained replay viewer and text/JSON exports from local data."""
from __future__ import annotations

import argparse
import base64
import gzip
import json
from pathlib import Path

from replay_transcription import build_transcription, transcript_text, sha
from replay_visibility_inputs import attach_bundle

ROOT = Path(__file__).resolve().parent.parent


def compressed(raw):
    return base64.b64encode(gzip.compress(raw, compresslevel=6, mtime=0)).decode("ascii")


def build(export, map_dir, out, names_path=None, asset_model_path=None, library_url='library.json'):
    out.mkdir(parents=True, exist_ok=True)
    names = json.loads(names_path.read_text(encoding="utf-8-sig")) if names_path else None
    data, mesh = build_transcription(export, map_dir, names, asset_model_path)
    data_bytes = json.dumps(data, separators=(",", ":"), allow_nan=False).encode("utf-8")
    text = transcript_text(data)
    (out / "replay.json").write_bytes(data_bytes)
    (out / "transcript.txt").write_text(text, encoding="utf-8")
    header = {k: data[k] for k in ("schema_version", "producer", "match_id", "replay_build", "clock", "map", "players", "rounds", "score", "projection", "rapid_turn_policy", "diagnostics", "source_provenance", "limitations")}
    header["geometry"] = {k: data["geometry"][k] for k in ("kind", "triangles_used", "complete")}
    header["geometry"]["asset_build_verified_against_replay"] = data["geometry"]["asset_provenance"]["asset_build_verified_against_replay"]
    header["asset_state"] = data["asset_state"]
    with (out / "events.jsonl").open("w", encoding="utf-8") as f:
        f.write(json.dumps({"kind": "metadata", **header}, allow_nan=False)+"\n")
        for e in data["events"]:
            f.write(json.dumps(e, allow_nan=False)+"\n")
    provenance = {"replay_export_manifest_sha256": sha(export / "manifest.json"),
                  "geometry_sha256": sha(map_dir / "geometry.npz"),
                  "map_metadata_sha256": sha(map_dir / "map.json"),
                  "producer": data["producer"], "source_data": "local VRF and installed game assets",
                  "source_provenance": data["source_provenance"]}
    provenance["gameplay_asset_model_sha256"] = sha(asset_model_path) if asset_model_path else None
    (out / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    template = (ROOT / "scripts/replay-transcription-template.html").read_text(encoding="utf-8")
    script = (ROOT / "scripts/replay-transcription-viewer.js").read_text(encoding="utf-8")
    visibility = (ROOT / "scripts/replay-visibility-runtime.js").read_text(encoding="utf-8")
    effects = (ROOT / "scripts/replay-visibility-effects.js").read_text(encoding="utf-8")
    behavior = (ROOT / "scripts/replay-behavior-runtime.js").read_text(encoding="utf-8")
    bindings = json.loads((ROOT / "scripts/replay-behavior-asset-bindings.json").read_text(encoding="utf-8"))
    behavior += '\nReplayBehavior.bindAssetPrograms('+json.dumps(bindings).replace('<','\\u003c')+');'
    font = ROOT / "scripts/replay-font/DejaVuSans.ttf"
    font_license = (ROOT / "scripts/replay-font/LICENSE_DEJAVU").read_text(encoding="utf-8")
    bundle = {"data": compressed(data_bytes), "geometry": compressed(mesh.binary()),
              "text": base64.b64encode(text.encode("utf-8")).decode("ascii"),
              "minimap": "data:image/png;base64,"+base64.b64encode((map_dir / "minimap.png").read_bytes()).decode("ascii"),
              "font_license": font_license,"library_url":library_url,
              "visibility_runtime_sha256":sha(ROOT / 'scripts/replay-visibility-runtime.js')}
    attach_bundle(bundle, data, out)
    html = template.replace("__REFERENCE_FONT__", base64.b64encode(font.read_bytes()).decode("ascii")).replace("__BUNDLE__", json.dumps(bundle)).replace("__BEHAVIOR_SCRIPT__", behavior).replace("__VISIBILITY_EFFECTS_SCRIPT__", effects).replace("__VISIBILITY_SCRIPT__", visibility).replace("__VIEWER_SCRIPT__", script)
    (out / "viewer.html").write_text(html, encoding="utf-8")
    turns = sum(bool(k.get("rapid_turn")) for k in data["kills"])
    print(f"{len(data['rounds'])} rounds, {len(data['kills'])} deaths, {data['diagnostics']['shot_extraction'].get('observed_discharges',0)} gun discharges, {turns} rapid-turn candidates")
    print(f"Viewer: {out / 'viewer.html'}")
    return data


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("export", type=Path)
    p.add_argument("--map", required=True, type=Path, dest="map_dir")
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--names", type=Path, help="Optional user-supplied {account UUID: display name} JSON")
    p.add_argument("--asset-model", type=Path, help="Inherited camera/capsule/smoke defaults exported by inspect-transcription-assets.py --model")
    p.add_argument("--library-url", default='library.json', help='Optional local replay library index URL')
    args = p.parse_args()
    build(args.export, args.map_dir, args.out, args.names, args.asset_model,args.library_url)


if __name__ == "__main__":
    main()
