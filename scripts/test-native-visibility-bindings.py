"""Native material operands checked against the pinned real 13.06 widget."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native_bindings', ROOT / 'scripts/build-native-visibility-bindings.py')
bindings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bindings)


class NativeBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = json.loads(gzip.decompress((ROOT / 'tests/fixtures/replay-visibility-fades-13.06.json.gz').read_bytes()))
        row = fixture['sources']['widget']
        raw = base64.b64decode(row['gzip_base64'], validate=True)
        if hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise ValueError('Real widget fixture source checksum differs')
        cls.widget = json.loads(gzip.decompress(raw))

    def graph(self, package):
        return next(e['ScriptBytecode'] for e in package['exports'] if e['name'].startswith('ExecuteUbergraph_'))

    def test_real_shader_parameter_equation_retains_native_dependencies(self):
        rule = bindings.prove_flash_material(self.widget)
        self.assertEqual(rule['parameter_name'], 'Alpha_ColorMult')
        self.assertEqual(rule['fade_duration_seconds'], 1.0)
        self.assertIn('AttributeFadeEndTime - engine_time_seconds', rule['fade_parameter_expression'])
        self.assertIn('native_time_since_last_blinded_change', rule['fade_end_expression'])
        self.assertIn(299, rule['proof_statements'])
        self.assertFalse(rule['native_clock_binding_verified'])
        self.assertFalse(rule['shader_opacity_equivalent_to_parameter_verified'])

    def test_reversed_subtraction_or_unrelated_uniform_is_rejected(self):
        for index in (178, 224):
            package = copy.deepcopy(self.widget)
            node = next(n for n in self.graph(package) if n['StatementIndex'] == index)
            node['Assignment']['Parameters'].reverse()
            with self.assertRaisesRegex(ValueError, 'data flow'):
                bindings.prove_flash_material(package)
        package = copy.deepcopy(self.widget)
        node = next(n for n in self.graph(package) if n['StatementIndex'] == 299)
        node['ContextExpression']['Parameters'][0]['Variable']['New']['Path'] = ['UnrelatedParam']
        with self.assertRaisesRegex(ValueError, 'scalar write'):
            bindings.prove_flash_material(package)

    def test_rpc_elapsed_clock_cannot_replace_native_accessor(self):
        package = copy.deepcopy(self.widget)
        node = next(n for n in self.graph(package) if n['StatementIndex'] == 2126)
        node['Assignment']['ContextExpression']['StackNode']['reference'] = "Class'/Script/ShooterGame.EffectContainer:GetTimeSinceStop'"
        with self.assertRaisesRegex(ValueError, 'operand differs'):
            bindings.prove_flash_material(package)

    def test_native_clock_assignment_cannot_disconnect_the_material_data_flow(self):
        for index in (2126, 2328, 2257, 2378):
            package = copy.deepcopy(self.widget)
            node = next(n for n in self.graph(package) if n['StatementIndex'] == index)
            node['Variable']['Variable']['New']['Path'] = ['UnusedClock']
            with self.assertRaisesRegex(ValueError, 'clock'):
                bindings.prove_flash_material(package)

    def test_timer_cadence_and_scalar_precision_cannot_change_silently(self):
        package = copy.deepcopy(self.widget)
        node = next(n for n in self.graph(package) if n['StatementIndex'] == 53)
        node['Assignment']['Parameters'][1]['Value'] = 0.1
        with self.assertRaisesRegex(ValueError, 'timer binding'):
            bindings.prove_flash_material(package)
        package = copy.deepcopy(self.widget)
        node = next(n for n in self.graph(package) if n['StatementIndex'] == 270)
        node['Assignment']['ConversionType']['value__'] = 4
        with self.assertRaisesRegex(ValueError, 'precision cast'):
            bindings.prove_flash_material(package)


if __name__ == '__main__':
    unittest.main()
