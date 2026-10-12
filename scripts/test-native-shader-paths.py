"""Real cooked HUD programs guard pass identity and unknown achieved opacity."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


variants = module('shader_fixture_variants', 'inspect-native-shader-variants.py')
hud = module('shader_fixture_hud', 'build-native-hud-shader-path.py')
slices = module('shader_fixture_slices', 'inspect-native-shader-inputs.py')


def walk(tree):
    if isinstance(tree, dict):
        yield tree
        for value in tree.values():
            yield from walk(value)
    elif isinstance(tree, list):
        for value in tree:
            yield from walk(value)


class NativeShaderPathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = json.loads(gzip.decompress((ROOT / 'tests/fixtures/native-shader-paths-13.06.json.gz').read_bytes()))
        cls.resource = fixture['resource']
        cls.targets = fixture['typed_targets']
        cls.labels = fixture['labels']
        cls.matches = fixture['archive_matches']
        cls.assemblies = {}
        for key, record in fixture['assemblies'].items():
            raw = base64.b64decode(record['base64'], validate=True)
            if hashlib.sha256(raw).hexdigest() != record['sha256']:
                raise ValueError('HUD shader fixture receipt differs')
            cls.assemblies[key] = raw.decode('utf-8')

    def test_simple_alpha_is_bound_to_mobile_pass_not_slate_default(self):
        rows = variants.bind_resource(self.resource, self.targets, self.matches, self.labels)
        direct = next(r for r in rows if r['shader_hash'] == '6D50E46E445885070A871353659EC2839AFDB380')
        self.assertTrue(direct['shader_type_label']['name'].startswith('TMobileBasePassPS'))
        slate = next(r for r in rows if r['shader_type_label']['name'] == 'TSlateMaterialShaderPSDefault')
        self.assertEqual(slate['shader_hash'], '72C1CBE76CB7DE6C83C9872FE5CB22848ECFEE77')
        self.assertEqual(slate['target']['frequency'], 'SF_Pixel')
        self.assertFalse(slate['runtime_shader_selected'])

    def test_wrong_resource_index_cannot_bind_a_vertex_program_as_pixel(self):
        resource = copy.deepcopy(self.resource)
        shader = next(r for r in resource['content']['Shaders'] if r['Type']['Hash'] == 15016778632210042379)
        shader['ResourceIndex'] = 19
        with self.assertRaisesRegex(ValueError, 'Typed shader target'):
            variants.bind_resource(resource, self.targets, self.matches, self.labels)

    def test_shader_code_reuse_keeps_every_type_occurrence(self):
        rows = variants.bind_resource(self.resource, self.targets, self.matches, self.labels)
        reused = [r for r in rows if r['resource_index'] == 5]
        self.assertGreater(len(reused), 1)
        self.assertEqual(len({r['shader_hash'] for r in reused}), 1)
        self.assertEqual(len({r['shader_type_hash'] for r in reused}), len(reused))

    def test_slate_alpha_keeps_product_color_and_draw_flag_unknown(self):
        assembly = self.assemblies['default']
        output = slices.alpha_inputs(assembly)['alpha_outputs'][0]
        result = hud.symbolic_output(output, assembly, self.resource)
        self.assertTrue(result['decoded_scalar_value_flow'])
        self.assertEqual(result['output_signature']['semantic'], 'SV_Target')
        self.assertEqual(result['symbolic_value_tree']['operation'], 'select')
        nodes = list(walk(result['symbolic_value_tree']))
        products = [n for n in nodes if n.get('symbolic_formula') == 'Alpha_ColorMult * GlobalAlpha']
        self.assertTrue(products)
        inputs = [n for n in nodes if n.get('operation') == 'interpolated_input']
        self.assertTrue(all(n['signature']['semantic'] == 'COLOR' and n['signature']['semantic_indices'] == [0]
            and n['component'] == 3 and n['runtime_value'] is None for n in inputs))
        self.assertTrue(any(n.get('reflected_field') == 'DrawFlags.x' for n in nodes))
        self.assertTrue(any(n.get('value') == 0.44999998807907104 for n in nodes))
        self.assertIsNone(result['runtime_value'])
        self.assertFalse(result['control_flow_evaluated'])

    def test_both_vertex_variants_pass_attribute3_to_color_alpha(self):
        for key in ('vertex_false', 'vertex_true'):
            assembly = self.assemblies[key]
            sig = hud.signatures(assembly)
            output = next(o for o in slices.alpha_inputs(assembly, False)['non_pixel_component3_outputs']
                if sig['outputs'][o['output_signature_id']]['semantic'] == 'COLOR' and
                    sig['outputs'][o['output_signature_id']]['semantic_indices'] == [0])
            tree = hud.symbolic_output(output, assembly, self.resource)['symbolic_value_tree']
            self.assertEqual(tree['operation'], 'interpolated_input')
            self.assertEqual(tree['signature']['semantic'], 'ATTRIBUTE')
            self.assertEqual(tree['signature']['semantic_indices'], [3])
            self.assertEqual(tree['component'], 3)
            self.assertIsNone(tree['runtime_value'])

    def test_unsupported_comparison_stays_unknown(self):
        assembly = self.assemblies['default']
        output = slices.alpha_inputs(assembly)['alpha_outputs'][0]
        changed = copy.deepcopy(output)
        node = next(n for n in changed['value_slice'] if 'fcmp fast une' in n['expression'])
        node['expression'] = node['expression'].replace('fcmp fast une', 'fcmp fast olt')
        result = hud.symbolic_output(changed, assembly, self.resource)
        self.assertFalse(result['decoded_scalar_value_flow'])
        self.assertTrue(result['unsupported_expressions'])
        self.assertIsNone(result['runtime_value'])

    def test_invalid_signature_id_is_rejected(self):
        assembly = self.assemblies['default']
        output = slices.alpha_inputs(assembly)['alpha_outputs'][0]
        changed = copy.deepcopy(output)
        node = next(n for n in changed['value_slice'] if '@dx.op.loadInput.f32' in n['expression'])
        node['expression'] = node['expression'].replace('i32 4, i32 1', 'i32 4, i32 99')
        with self.assertRaisesRegex(ValueError, 'outside its signature'):
            hud.symbolic_output(changed, assembly, self.resource)


if __name__ == '__main__':
    unittest.main()
