"""Validate and inventory every local replay, with resumable, hashed exports.

No network or game process is used. Unsupported content is retained by the
decoder and counted in the coverage report, never silently called supported.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

import duckdb

ROOT = Path(__file__).resolve().parent.parent
REVISION = "c4d6cc0e5ec3904fdb64b350b2656b8e3ff33d53"
DECODER = ROOT / ".tools/vrfkit-transcription/target/release/vrfkit.exe"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(export):
    manifest = json.loads((export / "manifest.json").read_text(encoding="utf-8"))
    con = duckdb.connect(config={"threads": 2})
    fields = str(export / "fields.parquet")
    groups = con.execute("SELECT group_path,field_name,CASE WHEN coalesce(value_i64::VARCHAR,value_f64::VARCHAR,value_bool::VARCHAR,value_str) IS NULL THEN 'raw' ELSE 'typed' END,count(*) FROM read_parquet(?) GROUP BY ALL ORDER BY 1,2,3", [fields]).fetchall()
    actors = con.execute("SELECT class_path,count(*) FROM read_parquet(?) WHERE event='open' GROUP BY 1 ORDER BY 1", [str(export / "actors.parquet")]).fetchall()
    con.close()
    return {"build": manifest["replay_build"], "map_path": manifest["level_names_and_times"][0]["name"],
            "duration_ms": manifest["duration_ms"], "players": len(manifest["players"]),
            "quality": manifest["quality"],
            "fields": [{"group": g, "field": f, "status": s, "rows": n} for g,f,s,n in groups],
            "actor_classes": [{"class": c, "opens": n} for c,n in actors]}


def process(source, out, decoder_hash):
    replay_hash = digest(source)
    record_path = out / source.stem / "record.json"
    if record_path.exists():
        old = json.loads(record_path.read_text(encoding="utf-8"))
        export = Path(old.get("export", ""))
        if (old.get("status") == "validated" and old.get("source_sha256") == replay_hash and old.get("decoder_sha256") == decoder_hash
                and (export / "manifest.json").is_file()):
            old.update(inventory(export), status="validated")
            old.pop("error", None)
            record_path.write_text(json.dumps(old, indent=2), encoding="utf-8")
            return old
    run = out / source.stem / "runs" / uuid.uuid4().hex
    run.mkdir(parents=True)
    export = run / "export"
    record = {"match_id": source.stem, "source": str(source), "source_bytes": source.stat().st_size,
              "source_sha256": replay_hash, "decoder_sha256": decoder_hash, "decoder_revision": REVISION,
              "export": str(export), "status": "failed"}
    for action, args in (("validate", ["--diagnostics"]), ("export", ["--out", str(export), "--checkpoints"])):
        with (run / (action + ".txt")).open("wb") as log:
            result = subprocess.run([str(DECODER), action, str(source), *args], stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            record["error"] = f"{action} returned {result.returncode}; see {run / (action + '.txt')}"
            break
    else:
        if digest(source) != replay_hash:
            record["error"] = "Replay changed during export"
        else:
            (run / "source-provenance.json").write_text(json.dumps({
                "source_replay_sha256": replay_hash, "decoder_sha256": decoder_hash,
                "decoder_revision": REVISION}, indent=2), encoding="utf-8")
            try:
                record.update(inventory(export), status="validated")
            except Exception as error:
                record["error"] = f"Inventory failed: {error}"
    record_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--out", type=Path, default=ROOT / ".local/replay-transcripts/corpus")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    sources = sorted(args.folder.glob("*.vrf"))
    if not sources or not 1 <= args.jobs <= 4:
        parser.error("Need at least one .vrf and 1–4 jobs")
    args.out.mkdir(parents=True, exist_ok=True)
    decoder_hash = digest(DECODER)
    records = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        pending = [pool.submit(process, source, args.out, decoder_hash) for source in sources]
        for future in as_completed(pending):
            record = future.result()
            records.append(record)
            print(f"{len(records)}/{len(sources)} {record['match_id']} {record['status']} {record.get('map_path', record.get('error'))}", flush=True)
    totals, classes = Counter(), Counter()
    for record in records:
        for row in record.get("fields", []):
            totals[(row["group"], row["field"], row["status"])] += row["rows"]
        for row in record.get("actor_classes", []):
            classes[row["class"]] += row["opens"]
    report = {"schema_version": 1, "source_folder": str(args.folder.resolve()), "decoder_revision": REVISION,
              "decoder_sha256": decoder_hash, "replays": sorted(records, key=lambda r: r["match_id"]),
              "field_inventory": [{"group": g, "field": f, "status": s, "rows": n} for (g,f,s),n in sorted(totals.items(), key=lambda r: str(r[0]))],
              "actor_inventory": [{"class": c, "opens": n} for c,n in sorted(classes.items(), key=lambda r: str(r[0]))],
              "complete_native_rendering": False}
    (args.out / "corpus.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Report: {args.out / 'corpus.json'}", flush=True)
    if any(r["status"] != "validated" for r in records):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
