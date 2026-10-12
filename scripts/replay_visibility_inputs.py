"""Attach separately verified visibility evidence without rewriting replay exports."""
import base64
from functools import lru_cache
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from replay_transcription import MeshBVH

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local/replay-transcripts'
RULES = LOCAL / 'asset-research/visibility-effects-v1/rules.json'
SMOKES = LOCAL / 'asset-research/visibility-smoke-profiles-v1'
ABILITIES = LOCAL / 'asset-research/ability-occluders-v1/model.json'
DYNAMIC_ASSETS = LOCAL / 'asset-research/dynamic-map-assets-v3.json'
DYNAMIC_INPUTS = LOCAL / 'asset-research/dynamic-map-replay-evidence-v3'
NATIVE_BINDINGS = LOCAL / 'asset-research/native-visibility-bindings-v1/bindings.json'
NATIVE_SOURCE = LOCAL / 'asset-research/installed-behavior-source-v5'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def compressed(raw):
    return base64.b64encode(gzip.compress(raw, compresslevel=6, mtime=0)).decode('ascii')


def review_root(directory):
    return directory.parent.parent if directory.parent.name == 'library' else directory


@lru_cache(maxsize=4)
def overlay_bytes(base, overlay, base_map_hash, base_geometry_hash, map_hash, geometry_hash):
    spec = importlib.util.spec_from_file_location('verified_map_overlay', ROOT / 'scripts/audit-map-art-overlay.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    _, metadata = verifier.verified_overlay_metadata(Path(base), Path(overlay))
    with np.load(Path(overlay) / 'geometry.npz') as archive:
        triangles = archive['triangles']
        if (len(triangles) != metadata['triangles'] or triangles.shape[1:] != (3, 3)
                or not np.isfinite(triangles).all() or set(metadata['material_triangles']) != {'BLEND_Opaque'}):
            raise ValueError('Invalid static overlay geometry')
        mesh = MeshBVH(triangles)
    raw = mesh.binary()
    return raw, {'map_path': metadata['map_path'], 'triangles': metadata['triangles'],
        'included_levels': metadata['included_levels'], 'map_metadata_sha256': map_hash,
        'geometry_sha256': geometry_hash, 'bvh_sha256': hashlib.sha256(raw).hexdigest(),
        'base_map_metadata_sha256': base_map_hash, 'base_geometry_sha256': base_geometry_hash,
        'mapping_sha256': metadata['mapping_sha256'], 'archive_utoc_sha256': metadata['archive_utoc_sha256'],
        'complete': False, 'kind': 'verified_additive_opaque_static_art'}


def load_inputs(data, directory, record=None):
    directory = Path(directory)
    inputs = {'schema_version': 1, 'match_id': data['match_id'], 'geometry_overlays': []}
    root = review_root(directory)
    if NATIVE_BINDINGS.exists() and data['asset_state'].get('model'):
        spec = importlib.util.spec_from_file_location('native_visibility_bindings', ROOT / 'scripts/build-native-visibility-bindings.py')
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        bindings = json.loads(NATIVE_BINDINGS.read_text(encoding='utf-8'))
        verified = verifier.build(NATIVE_SOURCE, data['asset_state']['model'])
        if verifier.object_hash(bindings) != verifier.object_hash(verified):
            raise ValueError('Native camera/body/material bindings differ from verified installed source')
        inputs['native_bindings'] = {key: bindings[key] for key in (
            'schema_version', 'kind', 'mapping_sha256', 'archives', 'sources', 'flash_material',
            'remaining_dependencies', 'native_camera_reconstructed', 'native_body_reconstructed', 'native_visibility_verified')}
        inputs['native_bindings_sha256'] = digest(NATIVE_BINDINGS)
    camera = root / 'visibility-inputs' / (data['match_id'] + '.json')
    if camera.exists():
        sidecar = json.loads(camera.read_text(encoding='utf-8'))
        provenance = sidecar['source_provenance']
        published = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
        if (sidecar['match_id'] != data['match_id'] or sidecar['replay_build'] != data['replay_build']
                or provenance['review_replay_sha256'] != digest(directory / 'replay.json')
                or provenance['export_manifest_sha256'] != published['replay_export_manifest_sha256']
                or provenance['source_replay_sha256'] != data['source_provenance']['source_replay_sha256']):
            raise ValueError('Camera dependency sidecar belongs to different replay evidence')
        inputs['camera_body'] = sidecar
        inputs['camera_body_sha256'] = digest(camera)
    if RULES.exists() and data['asset_state'].get('model'):
        rules = json.loads(RULES.read_text(encoding='utf-8'))
        model = data['asset_state'].get('model') or {}
        if rules['mapping_sha256'] != model.get('mapping_sha256') or rules['archives'] != model.get('archives'):
            raise ValueError('Visibility tail rules belong to different installed assets')
        inputs['tail_rules'] = rules
        inputs['tail_rules_sha256'] = digest(RULES)
    smoke_path = SMOKES / 'replays' / (data['match_id'] + '.json')
    if smoke_path.exists() and data['asset_state'].get('model'):
        model = json.loads((SMOKES / 'smoke-model.json').read_text(encoding='utf-8'))
        sidecar = json.loads(smoke_path.read_text(encoding='utf-8'))
        source = sidecar['source_provenance']
        published = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
        canonical = data['asset_state']['model']
        if (sidecar['match_id'] != data['match_id'] or source['published_replay_sha256'] != digest(directory / 'replay.json')
                or source['source_replay_sha256'] != data['source_provenance']['source_replay_sha256']
                or source['replay_export_manifest_sha256'] != published['replay_export_manifest_sha256']
                or model['mapping_sha256'] != canonical['mapping_sha256'] or model['archives'] != canonical['archives']):
            raise ValueError('Additional smoke inputs differ from published replay/asset evidence')
        if record:
            from replay_smoke_profiles import validate_replay
            validate_replay(sidecar, record, directory / 'replay.json', model)
        inputs.update(smoke_model=model, smoke_inputs=sidecar, smoke_instances=sidecar['smoke_instances'],
            smoke_model_sha256=digest(SMOKES / 'smoke-model.json'), smoke_inputs_sha256=digest(smoke_path))
    ability_path = root / 'ability-occluder-inputs-v1' / (data['match_id'] + '.json')
    if ability_path.exists():
        sidecar = json.loads(ability_path.read_text(encoding='utf-8'))
        source = sidecar['source_provenance']
        published = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
        if (sidecar['match_id'] != data['match_id'] or source['review_replay_sha256'] != digest(directory / 'replay.json')
                or source['source_replay_sha256'] != data['source_provenance']['source_replay_sha256']
                or source['export_manifest_sha256'] != published['replay_export_manifest_sha256']
                or source['asset_model_sha256'] != digest(ABILITIES)):
            raise ValueError('Ability occluder inputs differ from published replay/asset evidence')
        if record:
            from replay_ability_occluders import validate_sidecar
            validate_sidecar(sidecar, record, ABILITIES, directory / 'replay.json')
        inputs.update(ability_occluders=sidecar, ability_model_sha256=digest(ABILITIES), ability_inputs_sha256=digest(ability_path))
    dynamic_path = DYNAMIC_INPUTS / (data['match_id'] + '.json')
    if dynamic_path.exists():
        from replay_dynamic_occluders import validate_asset_evidence, validate_sidecar
        assets = json.loads(DYNAMIC_ASSETS.read_text(encoding='utf-8'))
        sidecar = json.loads(dynamic_path.read_text(encoding='utf-8'))
        index = json.loads((DYNAMIC_INPUTS / 'index.json').read_text(encoding='utf-8'))
        source = sidecar.get('source_provenance', {})
        published = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
        canonical = data['asset_state'].get('model') or {}
        assets_hash, inputs_hash = digest(DYNAMIC_ASSETS), digest(dynamic_path)
        helper_hash = digest(ROOT / 'scripts/replay_dynamic_occluders.py')
        receipts = [entry for entry in index.get('replays', []) if entry.get('match_id') == data['match_id']]
        if (assets.get('schema_version') != 3 or sidecar.get('schema_version') != 1
                or index.get('schema_version') != 1 or len(receipts) != 1
                or receipts[0].get('file') != dynamic_path.name or receipts[0].get('sha256') != inputs_hash
                or index.get('assets_sha256') != assets_hash or index.get('helper_sha256') != helper_hash
                or sidecar.get('match_id') != data['match_id'] or sidecar.get('map_path') != data['map']['path']
                or sidecar.get('replay_build') != data['replay_build']
                or sidecar.get('coverage_complete') is not False or sidecar.get('native_visibility_verified') is not False
                or source.get('review_replay_sha256') != digest(directory / 'replay.json')
                or source.get('source_replay_sha256') != data['source_provenance']['source_replay_sha256']
                or source.get('export_manifest_sha256') != published['replay_export_manifest_sha256']
                or source.get('export_manifest_sha256') != data['export_manifest_sha256']
                or source.get('assets_sha256') != assets_hash or source.get('helper_sha256') != helper_hash
                or source.get('decoder_sha256') != data['source_provenance']['decoder_sha256']
                or source.get('decoder_revision') != data['source_provenance']['decoder_revision']
                or any(source.get(key) != published.get('source_provenance', {}).get(key)
                       for key in ('source_replay_sha256', 'decoder_sha256', 'decoder_revision'))
                or source.get('asset_mapping_sha256') != assets.get('mapping_sha256')
                or source.get('asset_archives') != assets.get('archives')
                or assets.get('mapping_sha256') != canonical.get('mapping_sha256')
                or assets.get('archives') != canonical.get('archives')):
            raise ValueError('Dynamic map inputs differ from published replay/asset evidence')
        validate_asset_evidence(assets)
        if record:
            validate_sidecar(sidecar, record, DYNAMIC_ASSETS, directory / 'replay.json')
        inputs.update(dynamic_occluders=sidecar, dynamic_assets_sha256=assets_hash, dynamic_inputs_sha256=inputs_hash)
    geometries = []
    if data['map']['path'].rsplit('/', 1)[-1] == 'Jam':
        base, overlay = LOCAL / 'map-Jam-13.06', LOCAL / 'map-Jam-static-art-overlay-v1'
        if (overlay / 'map.json').exists():
            published = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
            base_map_hash, base_geometry_hash = digest(base / 'map.json'), digest(base / 'geometry.npz')
            if (base_map_hash != published['map_metadata_sha256']
                    or base_geometry_hash != published['geometry_sha256']):
                raise ValueError('Published geometry differs from the verified overlay base')
            raw, receipt = overlay_bytes(str(base), str(overlay), base_map_hash, base_geometry_hash,
                digest(overlay / 'map.json'), digest(overlay / 'geometry.npz'))
            inputs['geometry_overlays'].append(receipt)
            geometries.append(raw)
    return inputs, geometries


def attach_bundle(bundle, data, directory):
    inputs, geometries = load_inputs(data, directory)
    raw = json.dumps(inputs, separators=(',', ':'), allow_nan=False).encode()
    bundle['visibility_inputs'] = compressed(raw)
    bundle['visibility_inputs_sha256'] = hashlib.sha256(raw).hexdigest()
    bundle['visibility_overlays'] = [compressed(raw) for raw in geometries]
    bundle['visibility_effects_sha256'] = digest(ROOT / 'scripts/replay-visibility-effects.js')
    return bundle
