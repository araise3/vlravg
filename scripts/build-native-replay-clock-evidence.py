"""Preserve raw replay clock samples without inventing render-clock alignment.

Pairs serialized timestamps with their replay frame/packet positions. Local
world, blind accessors, animation evaluation and rendering remain unverified.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct

import duckdb

ROOT = Path(__file__).resolve().parent.parent
WORLD_GROUP = '/Game/GameModes/Bomb/BombGameState.BombGameState_C'
WORLD_FIELD = 'ReplicatedWorldTimeSecondsDouble'
WORLD_CHECKSUM = 3201434597
BLIND_GROUP = '/Script/ShooterGame.BlindManagerComponent'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def decode_clock(row, width):
    """Require whole fixed-width IEEE payload and agreement with the typed value."""
    if row['bit_count'] != width or len(row['raw_bits']) != width // 8:
        raise ValueError('Clock field is not a complete fixed-width payload')
    value = struct.unpack('<d' if width == 64 else '<f', row['raw_bits'])[0]
    if not math.isfinite(value) or value != row['value_f64']:
        raise ValueError('Raw and typed clock values disagree or are non-finite')
    return {'time_ms': row['time_ms'], 'packet_id': row['packet_id'], 'source_ordinal': row['source_ordinal'],
        'actor_net_guid': row['actor_net_guid'], 'object_net_guid': row['object_net_guid'],
        'group': row['group_path'], 'field': row['field_name'], 'compatible_checksum': row['compatible_checksum'],
        'bit_count': width, 'raw_hex': row['raw_bits'].hex(), 'serialized_seconds': value,
        'serialized_seconds_minus_replay_frame_seconds': value - row['time_ms'] / 1000,
        'native_clock_domain_verified': False}


def sample_key(sample):
    return sample['time_ms'], sample['packet_id'], sample['source_ordinal']


def preceding_world_sample(world, keys, sample):
    """No later frame, packet or field can supply a timestamp to an earlier row."""
    index = bisect_right(keys, sample_key(sample)) - 1
    if index < 0:
        return None
    observed = world[index]
    return {'sample_ordinal': index, 'sample_frame_time_ms': observed['time_ms'],
        'sample_packet_id': observed['packet_id'], 'sample_source_ordinal': observed['source_ordinal'],
        'serialized_seconds': observed['serialized_seconds'],
        'replay_frame_age_ms': sample['time_ms'] - observed['time_ms'],
        'serialized_clock_difference_seconds': sample['serialized_seconds'] - observed['serialized_seconds'],
        'scope': 'Difference between two observed serialized values; no clock conversion or extrapolation.'}


def summary(samples):
    if not samples:
        return {'samples': 0}
    offsets = sorted(s['serialized_seconds_minus_replay_frame_seconds'] for s in samples)
    repeats, backwards = 0, []
    previous = {}
    for ordinal, sample in enumerate(samples):
        scope = sample['actor_net_guid'], sample['object_net_guid'], sample['group'], sample['field']
        old = previous.get(scope)
        if old:
            delta = sample['serialized_seconds'] - old[1]['serialized_seconds']
            repeats += delta == 0
            if delta < 0:
                backwards.append({'previous_sample_ordinal': old[0], 'sample_ordinal': ordinal,
                    'serialized_delta_seconds': delta, 'replay_frame_delta_ms': sample['time_ms'] - old[1]['time_ms']})
        previous[scope] = ordinal, sample
    return {'samples': len(samples), 'first_replay_time_ms': samples[0]['time_ms'], 'last_replay_time_ms': samples[-1]['time_ms'],
        'offset_seconds_min': offsets[0], 'offset_seconds_median_observation_only': offsets[len(offsets) // 2],
        'offset_seconds_max': offsets[-1], 'offset_seconds_range': offsets[-1] - offsets[0],
        'repeated_serialized_values': repeats, 'backwards_serialized_steps': backwards,
        'clock_transform_fitted': False, 'native_clock_alignment_verified': False}


def extract(con, path):
    query = """SELECT time_ms,packet_id,source_ordinal,actor_net_guid,object_net_guid,group_path,field_name,
        compatible_checksum,bit_count,raw_bits,value_f64 FROM
        (SELECT *,row_number() OVER() AS source_ordinal FROM read_parquet(?))
        WHERE field_name='ReplicatedWorldTimeSecondsDouble' OR field_name='ReplayLastTransformUpdateTimeStamp'
        OR (group_path='/Script/ShooterGame.BlindManagerComponent' AND
            regexp_full_match(field_name,'ActiveBlinds\\[[0-9]+\\]\\.StartNetMovementTime'))
        ORDER BY time_ms,packet_id,source_ordinal"""
    cursor = con.execute(query, [str(path)])
    columns = [c[0] for c in cursor.description]
    world, movement, blinds = [], [], []
    while batch := cursor.fetchmany(10000):
        for values in batch:
            row = dict(zip(columns, values))
            if row['field_name'] == WORLD_FIELD:
                if row['group_path'] != WORLD_GROUP or row['compatible_checksum'] != WORLD_CHECKSUM:
                    raise ValueError('World clock field group/checksum differs')
                world.append(decode_clock(row, 64))
            elif row['field_name'] == 'ReplayLastTransformUpdateTimeStamp':
                movement.append(decode_clock(row, 32))
            else:
                blinds.append(decode_clock(row, 32))
    if len({s['actor_net_guid'] for s in world}) > 1:
        raise ValueError('Ambiguous observed world clock actor')
    keys = [sample_key(s) for s in world]
    for sample in (*movement, *blinds):
        sample['preceding_world_clock_observation'] = preceding_world_sample(world, keys, sample)
    return {'world_clock_samples': world, 'movement_clock_samples': movement, 'blind_start_clock_samples': blinds,
        'world_clock_summary': summary(world), 'movement_clock_summary': summary(movement), 'blind_start_clock_summary': summary(blinds)}


def build(args):
    corpus = json.loads(args.corpus.read_bytes())
    hud = json.loads(args.hud_path.read_bytes())
    con = duckdb.connect(config={'threads': 2})
    args.out.mkdir(parents=True, exist_ok=True)
    records = {}
    totals = Counter()
    for record in corpus['replays']:
        if record['status'] != 'validated':
            raise ValueError('Clock evidence requires a validated corpus export')
        export = Path(record['export'])
        manifest_path = export / 'manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        if manifest['replay_build'] != record['build']:
            raise ValueError('Clock replay build differs from corpus')
        sources, timelines = {}, {}
        for key, filename in (('stream', 'fields.parquet'), ('checkpoints', 'checkpoint_fields.parquet')):
            path = export / filename
            source_hash = digest(path)
            timelines[key] = extract(con, path)
            if digest(path) != source_hash:
                raise ValueError('Clock source changed while reading')
            sources[key] = {'path': str(path), 'sha256': source_hash}
            for kind in ('world', 'movement', 'blind_start'):
                totals[f'{key}_{kind}_samples'] += timelines[key][f'{kind}_clock_summary']['samples']
        selected_inventory = [row for row in record['fields'] if row.get('field') in
            ('ReplicatedWorldTimeSecondsDouble', 'ReplayLastTransformUpdateTimeStamp', 'SetRotation.InControlRotation', 'bIsActive') or
            row.get('group') in ('/Script/ShooterGame.ZoomMultiplierComponent', '/Script/ShooterGame.AnimatedZoomComponent')]
        report = {'schema_version': 1, 'kind': 'observed_replay_clock_samples', 'match_id': record['match_id'],
            'replay_build': record['build'], 'source_replay_sha256': record['source_sha256'],
            'export_manifest_sha256': digest(manifest_path), 'sources': sources, 'timelines': timelines,
            'pose_and_clock_field_inventory': selected_inventory,
            'replay_to_native_engine_time_transform': None, 'native_camera_reconstructed': False,
            'native_body_reconstructed': False, 'activation_clock_verified': False, 'native_visibility_verified': False}
        filename = record['match_id'] + '.json.gz'
        raw = gzip.compress(json.dumps(report, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(), mtime=0)
        (args.out / filename).write_bytes(raw)
        records[record['match_id']] = {'file': filename, 'sha256': hashlib.sha256(raw).hexdigest(),
            'sources': sources, 'export_manifest_sha256': report['export_manifest_sha256'],
            'stream_summary': {k: v for k, v in timelines['stream'].items() if k.endswith('_summary')},
            'checkpoint_summary': {k: v for k, v in timelines['checkpoints'].items() if k.endswith('_summary')}}
        print(json.dumps({'match_id': record['match_id'], 'world_samples': timelines['stream']['world_clock_summary']['samples']}), flush=True)
    con.close()
    report = {'schema_version': 1, 'kind': 'source_pinned_replay_clock_correspondence',
        'generator_sha256': digest(Path(__file__)), 'corpus_sha256': digest(args.corpus), 'hud_shader_path_sha256': digest(args.hud_path),
        'widget_clock_proof': hud['widget_scalar_and_clock_proof'], 'replays': records, 'totals': dict(totals),
        'replay_to_native_engine_time_transform': None, 'native_camera_reconstructed': False, 'native_body_reconstructed': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'references': ['https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/GameFramework/AGameStateBase?application_version=5.5',
            'https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/Kismet/UGameplayStatics?application_version=5.5',
            'https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UDemoNetDriver'],
        'limitations': ['Replicated server world timestamps, replay frame time, actor movement time and widget local world time are distinct observations/domains.',
            'Observed offsets are diagnostic differences, not a fitted or certified replay-to-engine transform.',
            'Preceding world samples never use a later frame, packet or source row and are never extrapolated.',
            'Checkpoint snapshots are kept separate from the causal replay stream.',
            'Native blind accessor times, local world adjustment, graph evaluation, timer callbacks and render submission remain unknown.']}
    (args.out / 'clocks.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'replays': len(records), 'totals': dict(totals), 'activation_clock_verified': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('corpus', 'hud-path', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    build(parser.parse_args())


if __name__ == '__main__':
    main()
