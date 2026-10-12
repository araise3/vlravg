"""Fade lifecycle proof checked against exact cached 13.06 Blueprint fixtures."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('visibility_effect_rules', ROOT/'scripts/build-visibility-effect-rules.py')
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)


class EffectRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = json.loads(gzip.decompress((ROOT/'tests/fixtures/replay-visibility-fades-13.06.json.gz').read_bytes()))
        cls.packages = {}
        for key, row in fixture['sources'].items():
            raw = base64.b64decode(row['gzip_base64'], validate=True)
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise ValueError('Exact source fixture checksum differs')
            cls.packages[key] = json.loads(gzip.decompress(raw))

    def graph(self, package):
        return next(e['ScriptBytecode'] for e in package['exports'] if e['name'].startswith('ExecuteUbergraph_'))

    def test_real_flash_rule_uses_widget_duration_and_exposes_unbound_native_accessors(self):
        result = rules.prove_root(self.packages['flash'], 'flash', self.packages['widget'])
        self.assertEqual(result['duration_field'], 'AttributeFadeTime')
        self.assertEqual(result['duration_seconds'], 1.0)
        self.assertEqual(result['unbound_native_accessors'],
                         ['BlindManagerComponent.IsBlinded', 'BlindManagerComponent.GetTimeSinceLastBlindedChange'])
        self.assertIn(2938, result['proof_statements'])

    def test_generic_effect_lifetime_is_not_a_flash_fade_rule(self):
        package = copy.deepcopy(self.packages['flash'])
        default = next(e for e in package['exports'] if e['name'].startswith('Default__'))
        default['properties']['EffectTailTime'] = 123.0
        self.assertEqual(rules.prove_root(package, 'flash', self.packages['widget'])['duration_seconds'], 1.0)

    def test_exact_flash_tail_argument_and_native_widget_bindings_must_match(self):
        package = copy.deepcopy(self.packages['flash'])
        call = next(n for n in self.graph(package) if n['StatementIndex'] == 2938)
        call['Parameters'][0]['Variable']['New']['Path'] = ['UnrelatedDuration']
        with self.assertRaisesRegex(ValueError, 'verified duration binding'):
            rules.prove_root(package, 'flash', self.packages['widget'])
        widget = copy.deepcopy(self.packages['widget'])
        assignment = next(n for n in self.graph(widget) if n['StatementIndex'] == 1945)
        for n in rules.walk(assignment):
            if n.get('StackNode', {}).get('reference', '').endswith("BlindManagerComponent:IsBlinded'"):
                n['StackNode']['reference'] = "Class'/Script/ShooterGame.BlindManagerComponent:IsAlive'"
        with self.assertRaisesRegex(ValueError, 'statement 1945'):
            rules.prove_root(self.packages['flash'], 'flash', widget)

    def test_real_nearsight_rule_proves_stop_dispatch_reverse_and_unit_timeline(self):
        result = rules.prove_root(self.packages['nearsight'], 'nearsight')
        self.assertEqual(result['duration_field'], 'NearsightFadeOutDuration')
        self.assertEqual(result['timeline_length_seconds'], 1.0)
        self.assertIn(1386, result['proof_statements'])
        self.assertIn(433, result['proof_statements'])

    def test_nearsight_duration_rate_and_timeline_extent_cannot_silently_change(self):
        package = copy.deepcopy(self.packages['nearsight'])
        node = next(n for n in self.graph(package) if n['StatementIndex'] == 1574)
        node['Assignment']['Parameters'][0]['Value'] = 2.0
        with self.assertRaisesRegex(ValueError, 'divide by fade duration'):
            rules.prove_root(package, 'nearsight')
        package = copy.deepcopy(self.packages['nearsight'])
        timeline = next(e for e in package['exports'] if e['name'] == 'NearsightTimeline_Template')
        timeline['properties']['TimelineLength'] = 2.0
        with self.assertRaisesRegex(ValueError, 'unit length'):
            rules.prove_root(package, 'nearsight')


if __name__ == '__main__':
    unittest.main()
