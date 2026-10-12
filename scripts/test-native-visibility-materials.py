"""Bounded shader-container decoding against a pinned real installed record."""
import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('material_evidence', ROOT / 'scripts/inspect-native-visibility-materials.py')
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)


class MaterialEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(gzip.decompress((ROOT / 'tests/fixtures/native-smoke-shader-13.06.json.gz').read_bytes()))
        cls.record = base64.b64decode(cls.fixture['record_base64'], validate=True)
        if hashlib.sha256(cls.record).hexdigest() != cls.fixture['record_sha256']:
            raise ValueError('Real shader fixture checksum differs')

    def test_real_shader_record_resolves_to_the_pinned_compiled_container(self):
        offset, compiled, chunks = materials.dxbc_container(self.record)
        self.assertEqual(offset, self.fixture['container_offset'])
        self.assertEqual(len(compiled), self.fixture['compiled_bytes'])
        self.assertEqual(hashlib.sha256(compiled).hexdigest(), self.fixture['compiled_sha256'])
        self.assertEqual(chunks, self.fixture['chunks'])
        self.assertFalse(self.fixture['native_visibility_verified'])

    def test_truncated_or_oversized_container_cannot_consume_another_shader_record(self):
        offset, compiled, _ = materials.dxbc_container(self.record)
        with self.assertRaisesRegex(ValueError, 'bounded'):
            materials.dxbc_container(self.record[:offset + len(compiled) - 1])
        broken = bytearray(self.record)
        struct.pack_into('<I', broken, offset + 24, len(self.record) + 100)
        with self.assertRaisesRegex(ValueError, 'bounded'):
            materials.dxbc_container(broken)

    def test_corrupt_chunk_offsets_and_format_versions_are_rejected(self):
        offset, _, _ = materials.dxbc_container(self.record)
        for field, value in ((32, 0), (32, len(self.record)), (20, 2)):
            broken = bytearray(self.record)
            struct.pack_into('<I', broken, offset + field, value)
            with self.assertRaisesRegex(ValueError, 'bounded'):
                materials.dxbc_container(broken)

    def test_multiple_valid_containers_are_ambiguous(self):
        with self.assertRaisesRegex(ValueError, 'found 2'):
            materials.dxbc_container(self.record + self.record)


if __name__ == '__main__':
    unittest.main()
