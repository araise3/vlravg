"""Extract selected Brotli-compressed web assets from a Tauri v2 PE file.

Usage: python scripts/inspect-tauri-assets.py APP.exe OUTPUT_DIR NAME_FRAGMENT...
This is for local research of a supplied executable; it never runs the app.
"""

import re
import struct
import sys
from pathlib import Path

import brotli


def extract(binary: bytes, output: Path, fragments: list[str]):
    pe = struct.unpack_from("<I", binary, 0x3C)[0]
    if binary[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Not a PE executable")
    section_count = struct.unpack_from("<H", binary, pe + 6)[0]
    optional_size = struct.unpack_from("<H", binary, pe + 20)[0]
    optional = pe + 24
    if struct.unpack_from("<H", binary, optional)[0] != 0x20B:
        raise ValueError("Expected a 64-bit PE executable")
    image_base = struct.unpack_from("<Q", binary, optional + 24)[0]
    section_table = optional + optional_size
    sections = []
    for index in range(section_count):
        entry = section_table + index * 40
        virtual = struct.unpack_from("<I", binary, entry + 12)[0]
        length, offset = struct.unpack_from("<II", binary, entry + 16)
        sections.append((virtual, length, offset))

    def to_va(offset):
        for virtual, length, raw in sections:
            if raw <= offset < raw + length:
                return image_base + virtual + offset - raw
        return None

    def to_offset(va):
        rva = va - image_base
        for virtual, length, raw in sections:
            if virtual <= rva < virtual + length:
                return raw + rva - virtual
        return None

    found = 0
    for match in re.finditer(rb"/assets/[a-zA-Z0-9_.-]{4,200}", binary):
        name = match.group().decode("ascii")
        if not any(fragment in name for fragment in fragments):
            continue
        path_va = to_va(match.start())
        if path_va is None:
            continue
        needle = struct.pack("<Q", path_va)
        search = 0
        while (entry := binary.find(needle, search)) >= 0:
            search = entry + 1
            if entry + 32 > len(binary):
                continue
            _, path_len, data_va, data_len = struct.unpack_from("<QQQQ", binary, entry)
            data_offset = to_offset(data_va)
            if path_len != len(name) or data_offset is None or not 0 < data_len < len(binary) - data_offset:
                continue
            try:
                content = brotli.decompress(binary[data_offset:data_offset + data_len])
            except brotli.error:
                continue
            dest = output / name.lstrip("/")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
            print(f"{dest} ({len(content)} bytes)")
            found += 1
            break
    if not found:
        raise ValueError("No matching Tauri assets found")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit("Usage: inspect-tauri-assets.py APP.exe OUTPUT_DIR NAME_FRAGMENT...")
    extract(Path(sys.argv[1]).read_bytes(), Path(sys.argv[2]), sys.argv[3:])
