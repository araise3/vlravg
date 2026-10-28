"""Unpack the parse container's stdout tar into <out>/compact.json and <out>/export/.

The tar was written by a process that read hostile input, so only an exact
allowlist of regular files is accepted: no links, devices, absolute or
parent paths, unknown names or oversized members. Anything else rejects the
whole archive (exit 2) and nothing partial is left behind.
Runs in the parse job, which has no secrets.

Usage: python3 -I replay-unpack.py <result.tar> <out dir>
"""
import os
from pathlib import Path
import shutil
import sys
import tarfile

# Keep in sync with EXPORT_FILES in lib/replay-import.mjs (checked by tests).
EXPORT_FILES = ("manifest.json", "movement.parquet", "fields.parquet", "actors.parquet", "events.parquet",
                "net_guids.parquet", "partials.parquet", "checkpoint_fields.parquet", "checkpoint_actors.parquet",
                "checkpoint_net_guids.parquet", "checkpoint_blocks.parquet", "checkpoint_guid_entries.parquet",
                "checkpoint_export_groups.parquet", "checkpoint_export_fields.parquet")
LIMITS = {"compact.json": 8 * 1024 * 1024, **{f"export/{name}": 256 * 1024 * 1024 for name in EXPORT_FILES}}
TOTAL_LIMIT = 520 * 1024 * 1024


def unpack(archive: Path, out: Path):
    staging = out / ".unpack"
    shutil.rmtree(staging, ignore_errors=True)
    (staging / "export").mkdir(parents=True)
    seen, total = set(), 0
    try:
        with tarfile.open(archive, mode="r:") as tar:
            for member in tar:
                name = member.name[2:] if member.name.startswith("./") else member.name
                if member.isdir() and name.rstrip("/") in ("export", "."):
                    continue
                if not member.isreg() or name not in LIMITS or name in seen or member.size > LIMITS[name]:
                    raise ValueError(f"rejected member {member.name!r}")
                seen.add(name)
                total += member.size
                if total > TOTAL_LIMIT:
                    raise ValueError("archive too large")
                source = tar.extractfile(member)
                with open(staging / name, "xb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                if (staging / name).stat().st_size != member.size:
                    raise ValueError(f"short member {name}")
        if "compact.json" not in seen:
            raise ValueError("compact.json missing")
    except (ValueError, tarfile.TarError, OSError) as error:
        shutil.rmtree(staging, ignore_errors=True)
        print(f"unpack rejected: {error}", file=sys.stderr)
        return 2
    os.replace(staging / "compact.json", out / "compact.json")
    os.replace(staging / "export", out / "export")
    shutil.rmtree(staging, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(unpack(Path(sys.argv[1]), Path(sys.argv[2])))
