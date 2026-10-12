"""Reproduce Python/browser dynamic-region checks from immutable native sidecars.

These checks compare source-bound unknown gating, not native rendered visibility.
The output directory must be new; source bytes are checked before and after Node.
"""
from __future__ import annotations
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess

from replay_dynamic_occluders import digest, region_dependencies, segment_intersects_bounds, validate_sidecar

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local/replay-transcripts'
DEFAULT_REVIEW = LOCAL / '8dac718f-24f5-4042-99a7-4a2a27f2d22f/review'


def rays(bounds):
    low, high = bounds
    finite = [axis for axis in range(3) if low[axis] is not None and high[axis] is not None]
    middle = [(low[axis] + high[axis]) / 2 if axis in finite else 0. for axis in range(3)]
    axis = min(finite, key=lambda index: high[index] - low[index])
    start, end = middle.copy(), middle.copy()
    start[axis], end[axis] = low[axis] - 10, high[axis] + 10
    result = [('crossing', start, end), ('reverse', end, start)]
    miss_axis = next(index for index in finite if index != axis)
    missed_start, missed_end = start.copy(), end.copy()
    missed_start[miss_axis] = missed_end[miss_axis] = high[miss_axis] + 10
    result.extend([('miss', missed_start, missed_end), ('reverse_miss', missed_end, missed_start)])
    result.append(('point_inside', middle, middle))
    face = middle.copy(); face[axis] = low[axis]
    result.append(('point_on_face', face, face))
    if len(finite) < 3:
        unbounded = next(index for index in range(3) if index not in finite)
        high_start, high_end = start.copy(), end.copy()
        high_start[unbounded] = high_end[unbounded] = 1_000_000.
        result.extend([('unbounded_crossing', high_start, high_end), ('unbounded_reverse', high_end, high_start)])
    for name, first, last in result:
        expected = segment_intersects_bounds(first, last, bounds)
        assert expected is ('miss' not in name), name
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=LOCAL / 'corpus/corpus.json')
    parser.add_argument('--review', type=Path, default=DEFAULT_REVIEW)
    parser.add_argument('--assets', type=Path, default=LOCAL / 'asset-research/dynamic-map-assets-v3.json')
    parser.add_argument('--inputs', type=Path, default=LOCAL / 'asset-research/dynamic-map-replay-evidence-v3')
    parser.add_argument('--node', default='node')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError('Proof output exists; use a new directory')
    runtime = ROOT / 'scripts/replay-visibility-runtime.js'
    checker = ROOT / 'scripts/check-replay-dynamic-occluders.cjs'
    index_path = args.inputs / 'index.json'
    index = json.loads(index_path.read_text(encoding='utf-8'))
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    records = {row['match_id']: row for row in corpus['replays'] if row.get('status') == 'validated'}
    assert index['schema_version'] == 1
    assert index['assets_sha256'] == digest(args.assets)
    assert index['helper_sha256'] == digest(ROOT / 'scripts/replay_dynamic_occluders.py')
    source_paths = {args.corpus, args.assets, index_path, runtime, checker, Path(__file__),
                    ROOT / 'scripts/replay_dynamic_occluders.py', ROOT / 'scripts/probe-dynamic-map-assets.py',
                    ROOT / 'scripts/inspect-transcription-assets.py',
                    LOCAL / 'asset-research/installed-behavior-source-v5/manifest.json'}
    evidence = json.loads(args.assets.read_text(encoding='utf-8'))
    source_paths.update(LOCAL / 'asset-research/installed-behavior-source-v5' / row['receipt']['file']
                        for row in evidence['class_records'])
    proof = {'schema_version': 1, 'runtime_sha256': digest(runtime),
             'python_checker_sha256': digest(__file__), 'node_checker_sha256': digest(checker),
             'assets_sha256': digest(args.assets), 'replays': [], 'dependency_cases': [], 'geometry_cases': [],
             'native_visibility_verified': False}
    labels = Counter(); field_names = Counter(); hidden_crossings = 0; desired_state_checks = 0
    unique_receipts = {row['match_id'] for row in index['replays']}
    assert len(unique_receipts) == len(index['replays']) == 6
    for receipt in index['replays']:
        match = receipt['match_id']; record = records[match]
        sidecar_path = args.inputs / receipt['file']
        assert sidecar_path.name == match + '.json' and digest(sidecar_path) == receipt['sha256']
        sidecar = json.loads(sidecar_path.read_text(encoding='utf-8'))
        replay_path = args.review / 'library' / match / 'replay.json'
        validate_sidecar(sidecar, record, args.assets, replay_path)
        assert len(sidecar['instances']) == receipt['instances']
        assert not sidecar['unresolved_observations']
        export = Path(record['export'])
        source_paths.update([sidecar_path, replay_path, replay_path.parent / 'provenance.json',
                             *(export / name for name in ['manifest.json', 'fields.parquet', 'actors.parquet', 'net_guids.parquet'])])
        proof['replays'].append({'match_id': match, 'file': str(sidecar_path.resolve()),
                                'sha256': digest(sidecar_path), 'instances': len(sidecar['instances'])})
        for instance in sidecar['instances']:
            ray_set = rays(instance['bounds_cm'])
            for label, start, end in ray_set:
                proof['geometry_cases'].append({'id': match + ':' + instance['id'] + ':' + label,
                    'start_cm': start, 'end_cm': end, 'bounds_cm': instance['bounds_cm'],
                    'expected': segment_intersects_bounds(start, end, instance['bounds_cm'])})
            times = {}
            def add(time, label, forced_round=None):
                current = next((row['round'] for row in instance['rounds'] if row['start_ms'] <= time < row['end_ms']), None)
                round_index = forced_round if forced_round is not None else current
                if round_index is None: round_index = instance['rounds'][0]['round']
                times.setdefault((time, round_index), set()).add(label)
            for row in instance['rounds']:
                for boundary in ['start_ms', 'end_ms']:
                    for offset in [-1, 0, 1]: add(row[boundary] + offset, 'round_' + boundary)
                add(row['start_ms'] - 1, 'invalid_requested_round', row['round'])
                add(row['end_ms'], 'invalid_requested_round', row['round'])
            for epoch in instance['network_epochs']:
                for boundary in ['start_ms', 'end_ms']:
                    for offset in [-1, 0, 1]: add(epoch[boundary] + offset, 'epoch_' + boundary)
            for observation in instance['observations']:
                assert observation['status'] == 'decoded'
                field_names[observation['field_name']] += 1
                for offset in [-1, 0, 1]: add(observation['time_ms'] + offset, 'native_' + observation['field_name'])
            for (time, round_index), tags in sorted(times.items()):
                for label, start, end in ray_set:
                    if label in ['point_inside', 'point_on_face']: continue
                    test = {'id': match + ':' + instance['id'] + ':' + str(time) + ':' + str(round_index) + ':' + label,
                            'match_id': match, 'target_actor': instance['id'], 'time_ms': time, 'round': round_index,
                            'labels': sorted(tags), 'ray_kind': label, 'start_cm': start, 'end_cm': end}
                    try:
                        test['expected'] = region_dependencies(sidecar, start, end, time, round_index)
                    except ValueError:
                        test['expected_error'] = True
                    if label == 'crossing' and 'expected' in test:
                        if any(tag.startswith('native_DoorState') or tag.startswith('native_IsAlive') for tag in tags):
                            desired_state_checks += 1
                        if not any(row['id'] == instance['id'] for row in test['expected']): hidden_crossings += 1
                    labels.update(tags); proof['dependency_cases'].append(test)
    assert sum(row['instances'] for row in proof['replays']) == 22
    assert sum(field_names.values()) == 851
    assert hidden_crossings > 0 and desired_state_checks > 0
    panel_match = '161ed113-3628-49a5-835f-dbdad07fe812'
    panel_sidecar = json.loads((args.inputs / (panel_match + '.json')).read_text())
    panel = next(row for row in panel_sidecar['instances'] if row['id'].endswith('RespawningWallPlate_2'))
    _, start, end = rays(panel['bounds_cm'])[0]
    assert any(row['id'] == panel['id'] for row in region_dependencies(panel_sidecar, start, end, 123204, 1))
    assert not any(row['id'] == panel['id'] for row in region_dependencies(panel_sidecar, start, end, 123205, 1))
    for name, bounds in [('half_null', [[0, 0, None], [1, 1, 1]]), ('inverted', [[2, 0, 0], [1, 1, 1]])]:
        test = {'id': name, 'bounds_cm': bounds, 'start_cm': [.5, .5, .5], 'end_cm': [.5, .5, .5]}
        try: segment_intersects_bounds(test['start_cm'], test['end_cm'], bounds)
        except ValueError: test['expected_error'] = True
        else: raise AssertionError('Accepted malformed bounds')
        proof['geometry_cases'].append(test)
    proof['native_scope_checks'] = {'observations': dict(field_names), 'boundary_labels': dict(labels),
        'display_model_hidden_crossings': hidden_crossings, 'desired_state_observation_checks': desired_state_checks,
        'panel_hide_boundary_checked': {'match_id': panel_match, 'before_ms': 123204, 'observed_hidden_ms': 123205},
        'source_pose_verified': False, 'native_visibility_verified': False}
    proof['sources'] = [{'file': str(source.resolve()), 'sha256': digest(source)} for source in sorted(source_paths)]
    assert digest(runtime) == proof['runtime_sha256']
    args.out.mkdir(parents=True)
    output = args.out / 'python-expected.json'
    output.write_text(json.dumps(proof, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    result = subprocess.run([args.node, str(checker), str(output)], capture_output=True, text=True, check=True)
    summary = json.loads(result.stdout)
    for source in proof['sources']: assert digest(source['file']) == source['sha256'], source['file']
    (args.out / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__': main()
