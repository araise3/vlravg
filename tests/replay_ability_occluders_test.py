"""Ability activation/geometry evidence must not invent shader clearance."""
import math
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from replay_ability_occluders import CLASSES, CHECKSUMS, ability_dependencies, vector

MODEL = {'profiles': {
    'viper_wall': {'serialized_defaults': {'WallDeactivationDelay': {'value': .8}, 'DissolveTime': {'value': 1.}}},
    'vyse_wall': {'serialized_defaults': {'ActorLifeTime': {'value': 6.}}},
}}
ROUNDS = [{'index': 0, 'start_ms': 0, 'end_ms': 10000}]


def actor(kind, event='open', t=0):
    return {'actor_net_guid': 42, 'event': event, 'time_ms': t, 'packet_id': t,
            'class_path': next(c for c, k in CLASSES.items() if k == kind)}


def row(kind, t, field, value=None):
    if type(value) is bool:
        raw, bits = bytes([int(value)]), 1
    elif isinstance(value, list):
        raw, bits = struct.pack('<ddd', *value), 192
    elif isinstance(value, float):
        raw, bits = struct.pack('<d', value), 64
    else:
        raw, bits = b'', 0
    group = actor(kind)['class_path'] + ('_ClassNetCache' if field != 'WallActivated' else '')
    return {'actor_net_guid': 42, 'object_net_guid': None, 'time_ms': t, 'packet_id': t,
            'group_path': group, 'field_name': field, 'compatible_checksum': CHECKSUMS.get(field),
            'raw_bits': raw, 'bit_count': bits, 'value_bool': value if type(value) is bool else None}


class AbilityTests(unittest.TestCase):
    def result(self, kind, rows=(), actors=None):
        return ability_dependencies(rows, actors or [actor(kind)], ROUNDS, MODEL)

    def test_actor_channel_alone_never_activates(self):
        for kind in ('viper_wall', 'vyse_wall', 'vyse_trap', 'viper_orb', 'viper_ult'):
            with self.subTest(kind=kind):
                self.assertEqual(self.result(kind)['instances'], [])

    def test_false_flag_baseline_is_not_an_activation(self):
        self.assertEqual(self.result('viper_wall', [row('viper_wall', 10, 'WallActivated', False)])['instances'], [])

    def test_true_flag_opens_exact_observed_clock(self):
        item = self.result('viper_wall', [row('viper_wall', 10, 'WallActivated', True)])['instances'][0]
        self.assertEqual((item['start_ms'], item['end_ms']), (10, 10000))
        self.assertEqual(item['start_observation']['raw_hex'], '01')
        self.assertFalse(item['native_visibility_verified'])

    def test_false_does_not_fabricate_visual_extinction(self):
        item = self.result('viper_wall', [row('viper_wall', 10, 'WallActivated', True),
                                        row('viper_wall', 1000, 'WallActivated', False)])['instances'][0]
        self.assertEqual(item['observed_flag_end_ms'], 1000)
        self.assertEqual(item['conditional_asset_tail_ms'], 1800)
        self.assertEqual(item['end_ms'], 10000)
        self.assertEqual(item['end_boundary_kind'], 'round_knowledge_cap')

    def test_channel_close_is_not_a_deactivation(self):
        item = self.result('viper_wall', [row('viper_wall', 10, 'WallActivated', True)],
                           [actor('viper_wall'), actor('viper_wall', 'close', 20)])['instances'][0]
        self.assertEqual(item['end_ms'], 10000)
        self.assertNotIn('deactivation_observation', item)
        self.assertEqual(item['channel_close_observations'][0]['time_ms'], 20)

    def test_checksum_or_typed_payload_disagreement_is_unresolved(self):
        for mutation in ('compatible_checksum', 'value_bool'):
            value = row('viper_wall', 10, 'WallActivated', True)
            value[mutation] = 0 if mutation == 'compatible_checksum' else False
            result = self.result('viper_wall', [value])
            self.assertEqual(result['instances'], [])
            self.assertEqual(len(result['unmatched_records']), 1)

    def test_placed_trap_does_not_become_active_wall(self):
        result = self.result('vyse_trap', [row('vyse_trap', 10, 'MulticastEnableDynamicCollision')])
        self.assertEqual(result['instances'], [])
        self.assertEqual(result['diagnostics']['placement_only'], 1)

    def test_exact_world_points_are_preserved_without_bounds_claim(self):
        location = [1425.123456789, -150.987654321, 33.5]
        rows = [row('viper_wall', 5, 'MulticastAddSmokeScreenPoint.Translation', location),
                row('viper_wall', 10, 'WallActivated', True)]
        item = self.result('viper_wall', rows)['instances'][0]
        self.assertEqual(item['anchor_observations'][0]['world_location_cm'], location)
        self.assertIsNone(item['world_bounds_cm'])
        self.assertFalse(item['world_bounds_verified'])

    def test_future_anchor_never_backfills_start_geometry(self):
        rows = [row('viper_wall', 10, 'WallActivated', True),
                row('viper_wall', 20, 'MulticastAddSmokeScreenPoint.Translation', [1, 2, 3])]
        item = self.result('viper_wall', rows)['instances'][0]
        self.assertEqual(item['anchor_observations'], [])
        self.assertEqual(item['later_anchor_observations'][0]['time_ms'], 20)

    def test_repeated_rpc_members_split_calls_inside_same_packet(self):
        rows = [row('viper_wall', 5, 'MulticastAddSmokeScreenPoint.Translation', [1, 2, 3]),
                row('viper_wall', 5, 'MulticastAddSmokeScreenPoint.Translation', [4, 5, 6])]
        anchors = self.result('viper_wall', rows)['actors'][0]['anchor_observations']
        self.assertEqual([a['world_location_cm'] for a in anchors], [[1, 2, 3], [4, 5, 6]])

    def test_vyse_endpoint_join_covers_potential_cosmetic_rise(self):
        rows = [row('vyse_wall', 5, 'MulticastInitializeWall.WallStartLocation', [1, 2, 3]),
                row('vyse_wall', 5, 'MulticastInitializeWall.WallEndLocation', [4, 5, 3]),
                row('vyse_wall', 5, 'MulticastInitializeWall.WallImpactNormal', [1, 0, 0]),
                row('vyse_wall', 10, 'MulticastEnableDynamicCollision')]
        item = self.result('vyse_wall', rows)['instances'][0]
        self.assertEqual(item['start_ms'], 5)
        self.assertEqual(item['collision_enable_observed_ms'], 10)
        self.assertEqual(item['world_endpoints_cm']['WallEndLocation'], [4, 5, 3])
        self.assertIsNone(item['world_bounds_cm'])

    def test_vector_decoder_rejects_partial_and_nonfinite_payloads(self):
        value = row('viper_wall', 5, 'MulticastAddSmokeScreenPoint.Translation', [1, 2, 3])
        value['bit_count'] = 191
        with self.assertRaises(ValueError):
            vector(value)
        value = row('viper_wall', 5, 'MulticastAddSmokeScreenPoint.Translation', [math.nan, 2, 3])
        with self.assertRaisesRegex(ValueError, 'Nonfinite'):
            vector(value)


if __name__ == '__main__':
    unittest.main()
