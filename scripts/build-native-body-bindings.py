"""Pin the serialized body/camera component bindings of every observed agent class.

Follows asset inheritance and mesh/animation references. Serialized component
defaults are not achieved transforms, native graph evaluation, or silhouettes.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re

from replay_asset_model import reference_package


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def build(source, corpus_path):
    manifest = json.loads((source / 'manifest.json').read_bytes())
    index = {r['package']: r for r in map(json.loads, (source / 'index.jsonl').read_text().splitlines())}
    corpus_raw = corpus_path.read_bytes()
    records = [r for r in json.loads(corpus_raw)['replays'] if r['status'] == 'validated']
    observed = {}
    for record in records:
        for row in record['actor_classes']:
            if re.fullmatch(r'/Game/Characters/[^/]+/[^/.]+_PC\.[^/.]+_PC_C', row['class'] or ''):
                observed.setdefault(row['class'], []).append({'match_id': record['match_id'], 'actor_opens': row['opens']})
    packages, receipts = {}, {}

    def load(path):
        if path not in packages:
            row = index[path]
            raw = (source / row['file']).read_bytes()
            data = json.loads(gzip.decompress(raw))
            if digest(raw) != row['sha256'] or row['errors'] or data.get('errors') or data['package'] != path:
                raise ValueError('Body binding package source differs: ' + path)
            packages[path] = data
            receipts[path] = {'file': row['file'], 'sha256': row['sha256']}
        return packages[path]

    bindings = {}
    for actor_class, matches in sorted(observed.items()):
        lineage, seen = [], set()
        path = reference_package({'reference': actor_class})
        native_parent = None
        while path:
            if path in seen:
                raise ValueError('Body Blueprint inheritance cycle')
            seen.add(path)
            package = load(path)
            classes = [e for e in package['exports'] if e['type'] == 'UBlueprintGeneratedClass']
            if len(classes) != 1:
                raise ValueError('Ambiguous body Blueprint class: ' + path)
            lineage.append(path)
            parent = classes[0].get('SuperStruct')
            next_path = reference_package(parent)
            if not next_path:
                native_parent = parent
            path = next_path
        components, default_mesh_slots = {}, {}
        for path in reversed(lineage):
            for e in load(path)['exports']:
                if e['name'].startswith('Default__'):
                    for key in ('Mesh', 'Mesh1P', 'MeshOverlay1P', 'MeshCosmetic3P', 'FollowRecoilCameraComponent',
                                'DeathCameraComponent', 'SkeletalPoseRewinderComponent', 'AnimationState'):
                        if key in e['properties']:
                            default_mesh_slots[key] = {'value': e['properties'][key], 'source_package': path, 'source_export': e['name']}
                if e.get('export_class') in ('SkeletalMeshComponent', 'CameraComponent', 'CharacterCapsuleComponent') or \
                   e['name'] in ('AnimationState_GEN_VARIABLE', 'AnimInstanceReplicationComponent', 'SkeletalPoseRewinderComponent'):
                    component = components.setdefault(e['name'], {'type': e['type'], 'serialized_properties': {}, 'property_sources': {}, 'source_exports': []})
                    component['source_exports'].append({'package': path, 'export': e['name'], 'object_path': e.get('object_path')})
                    for key, value in e['properties'].items():
                        component['serialized_properties'][key] = value
                        component['property_sources'][key] = {'package': path, 'export': e['name']}
        dependencies = {}
        for name, component in components.items():
            for key in ('AnimClass', 'SkeletalMesh', 'SkinnedAsset'):
                target = reference_package(component['serialized_properties'].get(key))
                if not target:
                    continue
                package = load(target) if target in index else None
                dependencies.setdefault(target, {'bindings': [], 'exports': [
                    {'name': e['name'], 'type': e['type'], 'properties': e['properties'],
                     **{k: e[k] for k in ('BoneTree', 'SuperStruct') if k in e}}
                    for e in package['exports'] if e['type'] != 'UFunction'] if package else None,
                    'serialized_source_available': package is not None})['bindings'].append({'component': name, 'property': key})
        bindings[actor_class] = {'observed_replays': matches, 'lineage': lineage, 'native_parent': native_parent,
            'default_component_slots': default_mesh_slots, 'components': components, 'mesh_and_animation_dependencies': dependencies,
            'native_camera_reconstructed': False, 'native_body_reconstructed': False}
    covered = sorted({r['match_id'] for b in bindings.values() for r in b['observed_replays']})
    if covered != sorted(r['match_id'] for r in records):
        raise ValueError('Some validated replays have no source-resolved player class')
    return {'schema_version': 1, 'kind': 'source_pinned_observed_agent_body_bindings',
        'generator_sha256': digest(Path(__file__).read_bytes()), 'corpus_sha256': digest(corpus_raw),
        'source_manifest_sha256': digest((source / 'manifest.json').read_bytes()),
        'source_index_sha256': digest((source / 'index.jsonl').read_bytes()),
        'mapping_sha256': manifest['inventory']['mapping_sha256'], 'archives': manifest['inventory']['archives'],
        'sources': receipts, 'agent_classes': bindings, 'covered_replays': covered,
        'uninspected_dependencies': sorted({p for b in bindings.values() for p, d in b['mesh_and_animation_dependencies'].items()
            if not d['serialized_source_available']}),
        'native_camera_reconstructed': False, 'native_body_reconstructed': False, 'native_visibility_verified': False,
        'limitations': ['Observed class membership does not identify every per-player runtime mesh override.',
            'Merged serialized component properties exclude unrecorded native constructor defaults and runtime mutation.',
            'CharacterMesh0 and CosmeticCharacterMesh3P are separate bindings; the base mesh is not the final agent silhouette.',
            'Copy-pose, post-process graph, animation phase/weights, component-space transforms and skinning remain unresolved.']}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('corpus', type=Path)
    p.add_argument('--out', required=True, type=Path)
    args = p.parse_args()
    report = build(args.source, args.corpus)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'agent_classes': len(report['agent_classes']), 'covered_replays': len(report['covered_replays']),
                      'source_packages': len(report['sources']), 'native_visibility_verified': False}))


if __name__ == '__main__':
    main()
