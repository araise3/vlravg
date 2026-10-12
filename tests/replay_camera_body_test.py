"""Regression checks for observed possession and its knowledge boundaries."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from replay_camera_body import (CAMERA_PAWN_GROUP, CHECKSUMS, COMPONENT_GROUPS,
                                PAWN_CHECKSUMS, decoded_reference, possession_dependencies)

COMPONENT = '/Game/Characters/States/PossessableActorComponent.PossessableActorComponent_C'
PLAYERS = [{'actor_net_guid': 308, 'subject': 'observer', 'character_net_guid': 832},
           {'actor_net_guid': 40, 'subject': 'other', 'character_net_guid': 850}]
ROUNDS = [{'index': 0, 'start_ms': 0, 'end_ms': 100},
          {'index': 1, 'start_ms': 100, 'end_ms': 200}]


def packed(value):
    raw = []
    while True:
        part = value & 127
        value >>= 7
        raw.append((part << 1) | bool(value))
        if not value:
            return bytes(raw)


def row(t, name, value, *, actor=3872, component=3956, group=COMPONENT, packet=None):
    raw = bytes([int(value)]) if type(value) is bool else packed(value)
    return {'time_ms': t, 'packet_id': packet if packet is not None else t,
            'actor_net_guid': actor, 'object_net_guid': component, 'group_path': group,
            'field_name': name, 'compatible_checksum': (PAWN_CHECKSUMS if group == CAMERA_PAWN_GROUP else CHECKSUMS).get(name),
            'bit_count': 1 if type(value) is bool else len(raw) * 8,
            'raw_bits': raw, 'value_i64': value if type(value) is int else None,
            'value_bool': value if type(value) is bool else None}


def component_start(t=10, component=3956):
    return [row(t, 'SetRotation.OriginalPawn', 832, component=component,
                group=COMPONENT + '_ClassNetCache'), row(t, 'IsPossessed', True, component=component)]


class PossessionTests(unittest.TestCase):
    def result(self, rows, rounds=ROUNDS, actors=()):
        return possession_dependencies(rows, PLAYERS, rounds, actors)

    def test_same_clock_ownership_and_original_observed_clocks(self):
        # These identities and wire payloads are copied from the 13.06 corpus
        # camera actor 3872; row ordering must allow the same-clock owner join.
        rows = component_start(43360) + [row(53657, 'IsPossessed', False)]
        rows.reverse()
        result = self.result(rows, [{'index': 0, 'start_ms': 67, 'end_ms': 148806}])
        item = result['remote_viewpoint_intervals'][0]
        self.assertEqual((item['subject'], item['start_ms'], item['end_ms']), ('observer', 43360, 53657))
        self.assertEqual(item['start_observation']['raw_hex'], '01')
        self.assertEqual(item['ownership_evidence'][0]['raw_hex'], '810c')
        self.assertEqual(item['end_boundary_kind'], 'observed_replication_clock')
        self.assertFalse(item['native_camera_switch_verified'])

    def test_later_ownership_never_backfills(self):
        result = self.result([row(10, 'IsPossessed', True), row(11, 'SetRotation.OriginalPawn', 832,
                            group=COMPONENT + '_ClassNetCache')])
        self.assertEqual(result['remote_viewpoint_intervals'], [])
        self.assertEqual(result['unmatched_records'][0]['reason'], 'ownership_not_observed')

    def test_class_name_alone_does_not_activate(self):
        actors = [{'time_ms': 1, 'packet_id': 1, 'actor_net_guid': 3872, 'event': 'open',
                   'class_path': 'CameraDrone'}]
        result = self.result([], actors=actors)
        self.assertEqual(result['remote_viewpoint_intervals'], [])

    def test_schema_mismatch_cannot_activate(self):
        rows = component_start()
        rows[-1]['compatible_checksum'] += 1
        result = self.result(rows)
        self.assertEqual(result['remote_viewpoint_intervals'], [])
        self.assertEqual(result['unmatched_records'][0]['reason'], 'component_or_schema_mismatch')

    def test_missing_component_identity_is_unresolved(self):
        rows = component_start()
        rows[-1]['object_net_guid'] = None
        self.assertEqual(self.result(rows)['remote_viewpoint_intervals'], [])

    def test_typed_raw_reference_contradiction_is_rejected(self):
        value = row(10, 'SetRotation.OriginalPawn', 832)
        value['value_i64'] = 850
        with self.assertRaisesRegex(ValueError, 'disagree'):
            decoded_reference(value)
        value['group_path'] = COMPONENT + '_ClassNetCache'
        result = self.result([value, row(10, 'IsPossessed', True)])
        self.assertEqual(result['remote_viewpoint_intervals'], [])
        self.assertTrue(any('disagree' in x['reason'] for x in result['unmatched_records']))

    def test_typed_raw_boolean_contradiction_is_rejected(self):
        rows = component_start()
        rows[-1]['value_bool'] = False
        result = self.result(rows)
        self.assertEqual(result['remote_viewpoint_intervals'], [])
        self.assertTrue(any('disagree' in x['reason'] for x in result['unmatched_records']))

    def test_no_observed_stop_caps_at_round_and_does_not_extend(self):
        result = self.result(component_start(99))
        item = result['remote_viewpoint_intervals'][0]
        self.assertEqual(item['end_ms'], 100)
        self.assertEqual(item['end_boundary_kind'], 'round_knowledge_cap')
        self.assertNotIn('stop_observed_ms', item)
        self.assertEqual(len(result['remote_viewpoint_intervals']), 1)

    def test_actor_channel_close_does_not_invent_unpossess(self):
        actors = [{'time_ms': 20, 'packet_id': 20, 'actor_net_guid': 3872, 'event': 'close'}]
        item = self.result(component_start(), actors=actors)['remote_viewpoint_intervals'][0]
        self.assertEqual(item['end_ms'], 100)
        self.assertEqual(item['actor_channel_close_observations'][0]['time_ms'], 20)

    def test_duplicate_true_keeps_first_start(self):
        result = self.result(component_start() + [row(15, 'IsPossessed', True)])
        item = result['remote_viewpoint_intervals'][0]
        self.assertEqual(item['start_ms'], 10)
        self.assertEqual(len(item['additional_start_observations']), 1)

    def test_component_scopes_do_not_erase_each_other(self):
        rows = component_start(component=3956) + component_start(component=3957) + [row(20, 'IsPossessed', False)]
        items = self.result(rows)['remote_viewpoint_intervals']
        self.assertEqual([i['end_ms'] for i in items], [20, 100])

    def test_controller_player_state_joins_only_observed_owner(self):
        controller = row(9, 'PlayerState', 308, actor=176, component=None,
                         group='/Script/Engine.PlayerController')
        controller['compatible_checksum'] = PAWN_CHECKSUMS['PlayerState']
        rows = [controller, row(10, 'SetRotation.PossessingController', 176,
                               group=COMPONENT + '_ClassNetCache'), row(10, 'IsPossessed', True)]
        item = self.result(rows)['remote_viewpoint_intervals'][0]
        self.assertEqual(item['subject'], 'observer')
        self.assertIn('controller_player_state', item['ownership_evidence'][0])

    def test_conflicting_owner_evidence_cannot_activate(self):
        rows = component_start()
        controller = row(9, 'PlayerState', 40, actor=176, component=None,
                         group='/Script/Engine.PlayerController')
        controller['compatible_checksum'] = PAWN_CHECKSUMS['PlayerState']
        rows += [controller, row(10, 'SetRotation.PossessingController', 176,
                                 group=COMPONENT + '_ClassNetCache')]
        result = self.result(rows)
        self.assertEqual(result['remote_viewpoint_intervals'], [])
        self.assertEqual(result['unmatched_records'][0]['reason'], 'conflicting_ownership')

    def test_owner_change_caps_existing_interval(self):
        result = self.result(component_start() + [row(20, 'SetRotation.OriginalPawn', 850,
                                 group=COMPONENT + '_ClassNetCache')])
        item = result['remote_viewpoint_intervals'][0]
        self.assertEqual(item['end_ms'], 20)
        self.assertEqual(item['end_boundary_kind'], 'ownership_knowledge_cap')
        self.assertNotIn('stop_observation', item)

    def test_clear_controller_rpc_is_an_observed_stop(self):
        result = self.result(component_start() + [row(20, 'SetRotation.ClearPossessingController', True,
                                 group=COMPONENT + '_ClassNetCache')])
        item = result['remote_viewpoint_intervals'][0]
        self.assertEqual(item['end_reason'], 'observed_clear_controller_rpc')
        self.assertEqual(item['stop_observed_ms'], 20)

    def test_false_baseline_never_expands_backwards(self):
        result = self.result([row(10, 'IsPossessed', False)])
        self.assertEqual(result['remote_viewpoint_intervals'], [])
        self.assertEqual(result['diagnostics']['false_without_live_start'], 1)

    def test_camera_pawn_requires_exact_schema(self):
        rows = [row(10, 'PlayerState', 308, group=CAMERA_PAWN_GROUP, component=None),
                row(10, 'Possessed', True, group=CAMERA_PAWN_GROUP, component=None)]
        self.assertEqual(self.result(rows)['remote_viewpoint_intervals'][0]['subject'], 'observer')
        rows[-1]['compatible_checksum'] += 1
        self.assertEqual(self.result(rows)['remote_viewpoint_intervals'], [])

    def test_round_overlap_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            self.result([], [{'index': 0, 'start_ms': 0, 'end_ms': 110}, {'index': 1, 'start_ms': 100, 'end_ms': 200}])


if __name__ == '__main__':
    unittest.main()
