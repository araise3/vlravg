"""Analyze a replay pair using its original movement samples and published assets."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid

import duckdb
from replay_visibility_inputs import load_inputs
from replay_camera_body import validate_sidecar

ROOT = Path(__file__).resolve().parent.parent


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def build(corpus_path, review_root, match_id, observer, target, start_ms, end_ms, out, smoke=True, crouch=True):
    records = json.loads(corpus_path.read_text(encoding='utf-8'))['replays']
    record = next(r for r in records if r['match_id'] == match_id and r['status'] == 'validated')
    directory = review_root / 'library' / match_id
    raw = (directory / 'replay.json').read_bytes()
    data = json.loads(raw)
    export = Path(record['export'])
    manifest_raw = (export / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    provenance = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
    if sha(manifest_raw) != provenance['replay_export_manifest_sha256']:
        raise ValueError('Published review and native export manifests differ')
    if (data['match_id'] != match_id or data['replay_build'] != record['build']
            or data['map']['path'] != record['map_path']
            or data['source_provenance']['source_replay_sha256'] != record['source_sha256']):
        raise ValueError('Replay identity/build/provenance mismatch')
    if not 0 <= start_ms < end_ms < manifest['duration_ms']:
        raise ValueError('Window must be inside the replay')
    players = data['players']
    resolve = lambda name: next(p for p in players if name in (p['subject'], p['slot']))
    a, b = resolve(observer), resolve(target)
    if a['team'] == b['team']:
        raise ValueError('Select opposing players')
    html = (directory / 'viewer.html').read_text(encoding='utf-8')
    bundle = json.loads(re.search(r'<script id="replay-bundle" type="application/json">(.*?)</script>', html, re.S)[1])
    if gzip.decompress(base64.b64decode(bundle['data'], validate=True)) != raw:
        raise ValueError('Published replay bundle differs from its evidence')
    geometry = gzip.decompress(base64.b64decode(bundle['geometry'], validate=True))
    inputs, overlays = load_inputs(data, directory, record)
    if inputs.get('camera_body'):
        validate_sidecar(inputs['camera_body'], record, directory / 'replay.json')
    inputs_raw = json.dumps(inputs, separators=(',', ':'), allow_nan=False).encode()
    if (bundle.get('visibility_inputs_sha256') != sha(inputs_raw)
            or gzip.decompress(base64.b64decode(bundle['visibility_inputs'], validate=True)) != inputs_raw):
        raise ValueError('Visibility evidence changed; refresh the published viewer')
    movement = export / 'movement.parquet'
    with duckdb.connect() as con:
        for player in (a, b):
            data['tracks'][player['subject']] = [list(row) for row in con.execute(
                'SELECT time_ms,pos_x,pos_y,pos_z,yaw,pitch,movement_state FROM read_parquet(?) '
                'WHERE character_net_guid IN (SELECT unnest(?)) AND time_ms BETWEEN ? AND ? '
                'QUALIFY row_number() OVER(PARTITION BY time_ms ORDER BY packet_id DESC)=1 ORDER BY time_ms',
                [str(movement), player['bodies'], max(0, start_ms - 50), end_ms]).fetchall()]
    data['tracks'] = {p['subject']: data['tracks'][p['subject']] for p in (a, b)}
    data['events'] = []
    data['playback_sample_ms'] = None
    scene = {'data': data, 'observer': a['subject'], 'target': b['subject'],
             'start_ms': start_ms, 'end_ms': end_ms,
             'options': {'smoke': smoke, 'crouch': crouch},
             'visibility_inputs': inputs,
             'overlay_bvhs': [base64.b64encode(raw).decode('ascii') for raw in overlays],
             'provenance': {'replay_sha256': record['source_sha256'], 'manifest_sha256': sha(manifest_raw),
                            'published_data_sha256': sha(raw), 'movement_parquet_sha256': sha(movement.read_bytes()),
                            'bvh_sha256': sha(geometry), 'visibility_inputs_sha256': sha(inputs_raw), 'builder_sha256': sha(Path(__file__).read_bytes()),
                            'decoder_revision': record['decoder_revision'], 'source_provenance': data['source_provenance']}}
    out.parent.mkdir(parents=True, exist_ok=True)
    # Default inherited ACLs keep the directory readable by the local service
    # and sandbox on Windows; tempfile's 0700 directory is owner-only there.
    staging = (out.parent / ('visibility-' + uuid.uuid4().hex)).resolve()
    if not staging.is_relative_to(out.parent.resolve()):
        raise ValueError('Staging directory escaped the output directory')
    staging.mkdir()
    scene_path, mesh_path = staging / 'scene.json', staging / 'geometry.bvh'
    try:
        scene_path.write_text(json.dumps(scene, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        mesh_path.write_bytes(geometry)
        subprocess.run(['node', str(ROOT / 'scripts/analyze-replay-visibility.cjs'),
                        str(scene_path), str(mesh_path), str(out.resolve())], check=True, timeout=150)
    finally:
        # Remove only these two owned files and their empty staging directory.
        scene_path.unlink(missing_ok=True)
        mesh_path.unlink(missing_ok=True)
        staging.rmdir()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('corpus', type=Path)
    p.add_argument('review', type=Path)
    p.add_argument('--match', required=True)
    p.add_argument('--observer', required=True, help='Replay slot (e.g. P3) or subject UUID')
    p.add_argument('--target', required=True)
    p.add_argument('--start-ms', required=True, type=int)
    p.add_argument('--end-ms', required=True, type=int)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--no-smoke', action='store_true', help='Disable the illustrative smoke model')
    p.add_argument('--no-crouch', action='store_true', help='Use the standing projection model')
    a = p.parse_args()
    build(a.corpus, a.review, a.match, a.observer, a.target, a.start_ms, a.end_ms, a.out,
          smoke=not a.no_smoke, crouch=not a.no_crouch)


if __name__ == '__main__':
    main()
