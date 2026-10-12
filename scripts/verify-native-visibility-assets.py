"""Audit the asset research receipts and decoded structures, without certifying LOS."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify(args):
    body_module = module('body_binding_audit', 'build-native-body-bindings.py')
    body = json.loads(args.body_bindings.read_bytes())
    if body != body_module.build(args.source, args.corpus):
        raise ValueError('Body bindings differ from pinned corpus/source')
    base = json.loads(args.bindings.read_bytes())
    native_module = module('native_binding_audit', 'build-native-visibility-bindings.py')
    if base != native_module.build(args.source, json.loads(args.model.read_bytes())):
        raise ValueError('Native bindings differ from pinned source/model')
    mesh_root = args.body_assets.parent
    meshes = json.loads(args.body_assets.read_bytes())
    if meshes['bindings_sha256'] != digest(args.body_bindings) or meshes['generator_sha256'] != digest(ROOT / 'scripts/inspect-native-body-assets.py') or \
       meshes['mapping_sha256'] != body['mapping_sha256'] or meshes['archives'] != body['archives'] or meshes['export_errors']:
        raise ValueError('Body asset receipts/provenance differ')
    if sorted(meshes['packages']) != body['uninspected_dependencies']:
        raise ValueError('Body dependency coverage differs')
    vertices, triangles, mesh_count = 0, 0, 0
    for path, row in meshes['packages'].items():
        package_file = mesh_root / row['file']
        package = json.loads(gzip.decompress(package_file.read_bytes()))
        if digest(package_file) != row['sha256'] or package.get('error') or package['package'] != path:
            raise ValueError('Decoded body package receipt differs: ' + path)
        info = row.get('lod0')
        if not info or row.get('mesh_error'):
            raise ValueError('Missing body mesh geometry: ' + path)
        npz = mesh_root / info['file']
        if digest(npz) != info['sha256'] or info['native_body_reconstructed'] is not False or info['native_visibility_verified'] is not False:
            raise ValueError('Body geometry receipt differs')
        with np.load(npz, allow_pickle=False) as data:
            pos, indices = data['positions'], data['indices']
            local, global_bones, weights = data['local_bone_indices'], data['global_bone_indices'], data['integer_bone_weights']
            if pos.shape != (info['vertices'], 3) or indices.shape != (info['triangles'] * 3,) or \
               local.shape != global_bones.shape or weights.shape != local.shape or local.shape[0] != len(pos) or \
               int(indices.max()) >= len(pos) or any(not np.isfinite(data[k]).all() for k in data.files):
                raise ValueError('Invalid decoded body arrays')
            if sorted(int(v) for v in set(weights.sum(axis=1))) != info['weight_sums']:
                raise ValueError('Integer weight sums differ from receipt')
            bones = len(info['bones'])
            if data['rest_translations'].shape != (bones, 3) or data['rest_scales'].shape != (bones, 3) or \
               data['rest_rotations_xyzw'].shape != (bones, 4) or data['rest_parent_indices'].shape != (bones,) or \
               np.any(data['rest_parent_indices'] >= np.arange(bones)):
                raise ValueError('Invalid decoded body rest hierarchy')
            for section in info['sections']:
                begin, end = section['base_vertex'], section['base_vertex'] + section['vertices']
                active = weights[begin:end] > 0
                bone_map = np.array(section['bone_map'])
                if not np.array_equal(global_bones[begin:end][active], bone_map[local[begin:end][active]]):
                    raise ValueError('Global skinning bone map differs from serialized section')
        vertices += info['vertices']
        triangles += info['triangles']
        mesh_count += 1
    materials = json.loads(args.materials.read_bytes())
    material_module = module('material_shader_audit', 'inspect-native-visibility-materials.py')
    roots, receipts = material_module.material_roots(args.source, *[json.loads(p.read_bytes()) for p in (args.model, args.smoke_model, args.effect_rules)])
    if materials['direct_material_references'] != roots or materials['blueprint_sources'] != receipts or \
       materials['generator_sha256'] != digest(ROOT / 'scripts/inspect-native-visibility-materials.py') or \
       materials['mapping_sha256'] != base['mapping_sha256'] or materials['archives'] != base['archives'] or materials['unresolved_resource_hashes']:
        raise ValueError('Material source receipts/provenance differ')
    wanted = {m['resource_hash'] for package in materials['materials'].values() for e in package['exports'] for m in e['shader_maps']}
    if set(materials['shader_map_matches']) != wanted:
        raise ValueError('Material shader-map coverage differs')
    shader_count, sm5, sm6 = 0, 0, 0
    for matches in materials['shader_map_matches'].values():
        for match in matches:
            if match['archive'] not in materials['shader_archives']:
                raise ValueError('Unknown shader archive')
            for shader in match['shaders']:
                compiled = args.materials.parent / shader['compiled_file']
                if shader.get('decode_error') or digest(compiled) != shader['compiled_sha256']:
                    raise ValueError('Compiled shader receipt differs')
                offset, raw, chunks = material_module.dxbc_container(compiled.read_bytes())
                if offset != 0 or len(raw) != shader['compiled_bytes'] or chunks != shader['chunks']:
                    raise ValueError('Compiled shader structure differs')
                if 'DXIL' in chunks:
                    sm6 += 1
                else:
                    asm = args.materials.parent / shader['disassembly_file']
                    if digest(asm) != shader['disassembly_sha256'] or asm.read_bytes().decode('utf-8') != material_module.disassemble(raw):
                        raise ValueError('Shader disassembly differs from compiled bytecode')
                    sm5 += 1
                shader_count += 1
    for report, keys in ((base, ('native_camera_reconstructed', 'native_body_reconstructed', 'native_visibility_verified')),
                         (body, ('native_camera_reconstructed', 'native_body_reconstructed', 'native_visibility_verified')),
                         (meshes, ('native_camera_reconstructed', 'native_body_reconstructed', 'native_visibility_verified')),
                         (materials, ('native_shader_opacity_verified', 'runtime_parameter_binding_verified', 'activation_clock_verified', 'native_visibility_verified'))):
        if any(report.get(k) is not False for k in keys):
            raise ValueError('Asset research was promoted to native visibility validation')
    report = {'schema_version': 1, 'passed': True, 'kind': 'asset_receipt_and_decoding_audit',
        'verifier_sha256': digest(Path(__file__)),
        'receipts': {k: {'file': str(getattr(args, k).resolve()), 'sha256': digest(getattr(args, k))}
            for k in ('bindings', 'body_bindings', 'body_assets', 'materials', 'corpus')},
        'replays': len(body['covered_replays']), 'observed_player_classes': len(body['agent_classes']),
        'mesh_packages': mesh_count, 'rest_vertices': vertices, 'rest_triangles': triangles,
        'materials': len(materials['materials']), 'shader_records': shader_count, 'sm5_disassemblies': sm5, 'sm6_dxil_records': sm6,
        'activation_clock_sites': len(base['activation_clock_sites']), 'native_player_visibility_validated': False}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'corpus', 'model', 'smoke-model', 'effect-rules', 'bindings', 'body-bindings', 'body-assets', 'materials', 'out'):
        p.add_argument('--' + name, required=True, type=Path)
    print(json.dumps(verify(p.parse_args())))
