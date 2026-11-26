"""Check that pyarrow reads the Parquet files the Rust write_interop_files test
writes: row counts, column names and order, nullability and dictionary types.
Mismatches are collected, never asserted, so `python -O` checks the same."""
import os
import sys
from pathlib import Path

import pyarrow.parquet as pq
import pyarrow.types

# file -> (rows, columns in order, nullable columns, dictionary columns)
EXPECTED = {
    "fields_interop.parquet": (
        10_000,
        ["time_ms", "packet_id", "channel_index", "actor_net_guid", "object_net_guid",
         "group_path", "handle", "field_name", "compatible_checksum", "bit_count",
         "raw_bits", "value_i64", "value_f64", "value_bool", "value_str"],
        {"object_net_guid", "field_name", "compatible_checksum", "raw_bits",
         "value_i64", "value_f64", "value_bool", "value_str"},
        {"group_path", "field_name", "value_str"},
    ),
    "movement_interop.parquet": (
        50_000,
        # Appended after vel_z, not interleaved: consumers read by position.
        ["time_ms", "packet_id", "character_net_guid", "pos_x", "pos_y", "pos_z",
         "yaw", "pitch", "vel_x", "vel_y", "vel_z",
         "timestamp", "movement_state", "move_type"],
        set(),
        set(),
    ),
}


def interop_dir() -> Path:
    """Only the exact directory the Rust test wrote, never a guessed temp one:
    argv[1] is that directory (as CI passes it); VRFKIT_INTEROP_DIR is the
    root whose `interop` child holds the files."""
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).resolve()
    configured = os.environ.get("VRFKIT_INTEROP_DIR")
    if configured:
        return (Path(configured) / "interop").resolve()
    sys.exit(
        "explicit interop directory required: pass the fixture directory as "
        "argv[1], or set VRFKIT_INTEROP_DIR to the root the Rust "
        "write_interop_files test wrote under"
    )


def problems_in(path: Path, rows, columns, nullable, dictionary) -> list[str]:
    table = pq.read_table(path)
    found = []
    if table.num_rows != rows:
        found.append(f"{path.name}: {table.num_rows} rows, expected {rows}")
    if table.schema.names != columns:
        found.append(f"{path.name}: columns {table.schema.names}, expected {columns}")
    for field in table.schema:
        where = f"{path.name}.{field.name}"
        if field.nullable != (field.name in nullable):
            found.append(f"{where}: nullable={field.nullable}")
        if pyarrow.types.is_dictionary(field.type) != (field.name in dictionary):
            found.append(f"{where}: type {field.type}")
        if field.nullable and table.column(field.name).null_count == 0:
            found.append(f"{where}: no null survived")
    return found


def main() -> int:
    directory = interop_dir()
    print(f"Interop dir: {directory}")
    if not all((directory / name).exists() for name in EXPECTED):
        print("ERROR: Interop parquet files not found. Run `cargo test -p vrf-export` first.")
        return 1
    problems = [p for name, expected in EXPECTED.items()
                for p in problems_in(directory / name, *expected)]
    for problem in problems:
        print(f"FAIL {problem}")
    print(f"{len(problems)} problem(s) in {len(EXPECTED)} files")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
