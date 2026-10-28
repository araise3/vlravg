"""Checks .github/scripts/replay-unpack.py against hostile tar streams.

Run: .venv-replay/Scripts/python.exe tests/replay_unpack_test.py
"""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("replay_unpack", ROOT / ".github/scripts/replay-unpack.py")
unpacker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unpacker)


def archive(path: Path, members):
    with tarfile.open(path, "w") as tar:
        for name, data, kind in members:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif kind == "link":
                info.type = tarfile.SYMTYPE
                info.linkname = data
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))


GOOD = [("compact.json", b"{}", "file"), ("export", None, "dir"),
        ("export/manifest.json", b"{}", "file"), ("export/movement.parquet", b"PAR1", "file")]


class UnpackTest(unittest.TestCase):
    def run_unpack(self, members):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        archive(root / "result.tar", members)
        out = root / "out"
        out.mkdir()
        return unpacker.unpack(root / "result.tar", out), out

    def test_allowlisted_members_are_unpacked(self):
        code, out = self.run_unpack(GOOD)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(p.name for p in (out / "export").iterdir()), ["manifest.json", "movement.parquet"])
        self.assertEqual((out / "compact.json").read_bytes(), b"{}")
        self.assertFalse((out / ".unpack").exists())

    def test_hostile_members_reject_the_whole_archive(self):
        for extra in [("../escape.txt", b"x", "file"), ("/etc/passwd", b"x", "file"), ("export/notes.txt", b"x", "file"),
                      ("export/fields.parquet", "/etc/passwd", "link"), ("compact.json", b"{}", "file"),
                      ("export/../compact.json", b"x", "file")]:
            code, out = self.run_unpack(GOOD + [extra])
            self.assertEqual(code, 2, extra[0])
            self.assertEqual(list(out.iterdir()), [], f"nothing partial is left for {extra[0]}")

    def test_compact_json_is_required(self):
        code, _ = self.run_unpack(GOOD[1:])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
