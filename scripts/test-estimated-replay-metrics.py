"""Regression checks for causal movement selection and estimated-metric input gates."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import duckdb

spec = importlib.util.spec_from_file_location('estimated_builder', Path(__file__).with_name('build-estimated-replay-metrics.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
batch_spec = importlib.util.spec_from_file_location('estimated_batch', Path(__file__).with_name('run-estimated-replay-batch.py'))
batch = importlib.util.module_from_spec(batch_spec)
batch_spec.loader.exec_module(batch)


class EstimatedInputs(unittest.TestCase):
    def test_asof_keeps_original_timestamps_packet_order_and_never_future_positions(self):
        root = (builder.ROOT / '.local' / ('estimated-input-test-' + uuid.uuid4().hex)).resolve()
        self.assertTrue(root.is_relative_to((builder.ROOT / '.local').resolve()))
        root.mkdir()
        path = root / 'movement.parquet'
        try:
            with duckdb.connect() as con:
                con.execute('CREATE TABLE movement(time_ms DOUBLE,packet_id BIGINT,character_net_guid BIGINT,pos_x DOUBLE,pos_y DOUBLE,pos_z DOUBLE,yaw DOUBLE,pitch DOUBLE,movement_state DOUBLE)')
                con.executemany('INSERT INTO movement VALUES (?,?,?,?,?,?,?,?,?)', [
                    (990, 1, 1, 1, 0, 0, 0, 0, 0), (1003, 2, 1, 2, 0, 0, 0, 0, 0),
                    (1003, 3, 1, 3, 0, 0, 0, 0, 0), (1010, 4, 1, 9, 0, 0, 0, 0, 0),
                    (998, 5, 2, 20, 0, 0, 0, 0, 0)])
                con.execute('COPY movement TO ? (FORMAT PARQUET)', [str(path)])
            data = {'players': [{'subject': 'a', 'bodies': [1]}, {'subject': 'b', 'bodies': [2]}]}
            tracks = builder.native_tracks(root, data, [1000, 1005])
            self.assertEqual([r[0] for r in tracks['a']], [990, 1003])
            self.assertEqual(tracks['a'][-1][1], 3)
            self.assertEqual(tracks['b'][0][0], 998)
            self.assertFalse(any(r[0] > 1005 for rows in tracks.values() for r in rows))
            data['players'][1]['bodies'] = [1]
            with self.assertRaisesRegex(ValueError, 'Ambiguous'):
                builder.native_tracks(root, data, [1000])
        finally:
            path.unlink(missing_ok=True)
            root.rmdir()

    def test_sampling_keeps_short_effect_shot_and_life_boundaries_in_half_open_combat(self):
        data = {'rounds': [{'index': 0, 'combat_start_ms': 1000, 'combat_end_ms': 2000}],
                'events': [{'kind': 'shot', 'time_ms': 1256}, {'kind': 'shot', 'time_ms': 2000}],
                'asset_state': {'vision_effects': [{'start_ms': 1551, 'end_ms': 1556}], 'smokes': [],
                                'observations': {'continuous_effects': [], 'life_states': {'a': [[1261, False]]}, 'blind_observations': []},
                                'model': {'vision_profiles': {}, 'asset_catalog': {}}}}
        times, _ = builder.sampling_times(data, {}, builder.POLICY)
        self.assertTrue(all(t in times for t in [1000, 1256, 1261, 1551, 1556, 1999]))
        self.assertNotIn(2000, times)

    def test_absent_round_and_source_quality_gaps_do_not_become_estimates(self):
        with self.assertRaises(ValueError):
            builder.sampling_times({'rounds': []}, {}, builder.POLICY)
        data = {'diagnostics': {'parser_quality': {}, 'shot_extraction': {'observed_discharges': 0}}, 'events': []}
        self.assertTrue(builder.quality_issues(data))
        data['diagnostics']['shot_extraction']['observed_discharges'] = 1
        self.assertIn('shot inventory/count mismatch', builder.quality_issues(data))

    def check_phase_selection(self, rounds):
        root = (builder.ROOT / '.local' / ('estimated-phase-test-' + uuid.uuid4().hex)).resolve()
        self.assertTrue(root.is_relative_to((builder.ROOT / '.local').resolve()))
        replay_dir, output_dir = root / 'library' / 'test', root / 'output' / 'matches'
        replay_dir.mkdir(parents=True); output_dir.mkdir(parents=True)
        replay, output = replay_dir / 'replay.json', output_dir / 'test.json'
        data = {'rounds': rounds, 'events': [], 'asset_state': {'vision_effects': [], 'smokes': [],
            'observations': {'continuous_effects': [], 'life_states': {}, 'blind_observations': []},
            'model': {'vision_profiles': {}, 'asset_catalog': {}}}}
        replay.write_bytes(builder.packed(data))
        queried = {}
        isolated = SimpleNamespace(sampling_times=builder.sampling_times, quality_issues=lambda value: [])
        def fake_build(record, review, out, policy, sources):
            if output.is_file():
                return json.loads(output.read_bytes()), output
            issues = isolated.quality_issues(data)
            if issues:
                report = {'status': 'blocked_source_quality', 'summary': {'mean_ms': None}, 'source_quality_issues': issues}
            else:
                queried['times'], queried['rounds'] = isolated.sampling_times(data, {}, policy)
                report = {'status': 'estimated', 'assumptions': {'population': 'Clocked encounters.'}}
            report['provenance'] = {'source_hashes': sources}
            return report, output
        isolated.build = fake_build
        try:
            with patch.object(batch, 'load_builder', return_value=isolated):
                report, _ = batch.build_one(builder, {'match_id': 'test'}, root, root / 'output', {})
                repeated, _ = batch.build_one(builder, {'match_id': 'test'}, root, root / 'output', {})
            self.assertEqual(report, repeated, 'Cache reuse must preserve the complete phase result')
            self.assertIn('run-estimated-replay-batch.py', report['provenance']['source_hashes'])
            # The shared strict sampler was never replaced for other workers.
            with self.assertRaises(TypeError):
                builder.sampling_times(data, {}, builder.POLICY)
            return report, queried
        finally:
            replay.unlink(); output.unlink(missing_ok=True)
            for directory in [replay_dir, replay_dir.parent, output_dir, output_dir.parent, root]:
                directory.rmdir()

    def test_unfinished_round_preserves_clocked_round_without_inventing_a_clock(self):
        report, queried = self.check_phase_selection([
            {'index': 0, 'combat_start_ms': 1000, 'combat_end_ms': 2000},
            {'index': 1, 'combat_start_ms': None, 'combat_end_ms': None}])
        self.assertEqual(report['status'], 'estimated')
        self.assertEqual([r['index'] for r in queried['rounds']], [0])
        self.assertEqual(min(queried['times']), 1000); self.assertEqual(max(queried['times']), 1999)
        self.assertEqual(report['round_clock_coverage']['usable_rounds'], [0])
        self.assertEqual(report['round_clock_coverage']['excluded_rounds'][0]['round'], 1)

    def test_no_observed_combat_clock_produces_no_timing_estimate(self):
        report, queried = self.check_phase_selection([{'index': 0, 'combat_start_ms': None, 'combat_end_ms': None}])
        self.assertEqual(report['status'], 'blocked_source_quality')
        self.assertIsNone(report['summary']['mean_ms'])
        self.assertEqual(queried, {})


if __name__ == '__main__':
    unittest.main()
