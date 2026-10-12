"""Extract referenced agent rest skeletons, LOD0 geometry, and skin influences.

Preserves disabled sections and integer weights. No native pose, cloth, morph,
graph evaluation or visibility result is inferred from this rest geometry.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def mesh_data(obj):
    reference = obj.ReferenceSkeleton
    infos, poses = list(reference.FinalRefBoneInfo), list(reference.FinalRefBonePose)
    if not infos or len(infos) != len(poses) or any(int(b.ParentIndex) >= i for i, b in enumerate(infos)):
        raise ValueError('Invalid skeletal hierarchy/rest pose')
    lod = obj.LODModels[0]
    buffer = lod.VertexBufferGPUSkin
    arrays = [(k, getattr(buffer, k)) for k in ('VertsHalf', 'VertsFloat', 'VertsHalfPacked', 'VertsFloatPacked')]
    arrays = [(k, a) for k, a in arrays if a is not None and len(a)]
    if len(arrays) != 1 or arrays[0][0].endswith('Packed'):
        raise ValueError('Ambiguous or unsupported packed skeletal positions')
    vertices = list(arrays[0][1])
    if len(vertices) != int(lod.NumVertices):
        raise ValueError('Skeletal vertex count differs')
    positions = np.array([[float(v.Pos.X), float(v.Pos.Y), float(v.Pos.Z)] for v in vertices], dtype=np.float32)
    indices = np.array(list(lod.Indices.Buffer), dtype=np.uint32)
    if not len(indices) or len(indices) % 3 or int(indices.max()) >= len(vertices) or not np.isfinite(positions).all():
        raise ValueError('Invalid skeletal triangles/positions')
    influence_count = max(len(v.Infs.BoneIndex) for v in vertices)
    local_bones = np.full((len(vertices), influence_count), -1, dtype=np.int32)
    weights = np.zeros((len(vertices), influence_count), dtype=np.uint16)
    weight_bits = np.array([16 if v.Infs.bUse16BitBoneWeight else 8 for v in vertices], dtype=np.uint8)
    for i, v in enumerate(vertices):
        bones, values = list(v.Infs.BoneIndex), list(v.Infs.BoneWeight)
        if len(bones) != len(values) or any(w < 0 or w > (65535 if weight_bits[i] == 16 else 255) for w in values):
            raise ValueError('Invalid skeletal influences')
        local_bones[i, :len(bones)] = bones
        weights[i, :len(values)] = values
    global_bones = np.full(local_bones.shape, -1, dtype=np.int32)
    assigned = np.zeros(len(vertices), dtype=np.uint8)
    sections = []
    for section in lod.Sections:
        begin, count = int(section.BaseVertexIndex), int(section.NumVertices)
        end = begin + count
        base_index, triangles = int(section.BaseIndex), int(section.NumTriangles)
        bone_map = np.array(list(section.BoneMap), dtype=np.int32)
        if begin < 0 or end > len(vertices) or base_index < 0 or base_index + triangles * 3 > len(indices) or \
           np.any(bone_map < 0) or np.any(bone_map >= len(infos)) or np.any(assigned[begin:end]):
            raise ValueError('Invalid or overlapping skeletal section')
        assigned[begin:end] = 1
        active = weights[begin:end] > 0
        if np.any(local_bones[begin:end][active] < 0) or np.any(local_bones[begin:end][active] >= len(bone_map)):
            raise ValueError('Weighted vertex exceeds section bone map')
        section_bones = global_bones[begin:end]
        section_bones[active] = bone_map[local_bones[begin:end][active]]
        sections.append({'material_index': int(section.MaterialIndex), 'base_index': base_index, 'triangles': triangles,
            'base_vertex': begin, 'vertices': count, 'bone_map': bone_map.tolist(), 'disabled': bool(section.bDisabled),
            'clothing_asset_index': int(section.CorrespondClothAssetIndex), 'max_bone_influences': int(section.MaxBoneInfluences)})
    if np.any(assigned == 0):
        raise ValueError('Skeletal vertices not covered by section maps')
    arrays = {'positions': positions, 'indices': indices, 'local_bone_indices': local_bones,
        'global_bone_indices': global_bones, 'integer_bone_weights': weights, 'weight_bits': weight_bits,
        'rest_parent_indices': np.array([int(b.ParentIndex) for b in infos], dtype=np.int32),
        'rest_translations': np.array([[float(p.Translation.X), float(p.Translation.Y), float(p.Translation.Z)] for p in poses]),
        'rest_rotations_xyzw': np.array([[float(p.Rotation.X), float(p.Rotation.Y), float(p.Rotation.Z), float(p.Rotation.W)] for p in poses]),
        'rest_scales': np.array([[float(p.Scale3D.X), float(p.Scale3D.Y), float(p.Scale3D.Z)] for p in poses])}
    if any(not np.isfinite(v).all() for v in arrays.values()):
        raise ValueError('Non-finite rest/skinning data')
    return arrays, {'bones': [str(b.Name) for b in infos], 'sections': sections,
        'vertices': len(vertices), 'triangles': len(indices) // 3,
        'weight_sums': sorted(int(v) for v in set(weights.sum(axis=1))),
        'native_body_reconstructed': False, 'native_visibility_verified': False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('bindings', type=Path)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings', type=Path, default=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    args = p.parse_args()
    bindings = json.loads(args.bindings.read_bytes())
    archives = {f.name: {'bytes': f.stat().st_size, 'sha256': digest(f.read_bytes())} for f in args.paks.glob('*.utoc')}
    if archives != bindings['archives'] or digest(args.mappings.read_bytes()) != bindings['mapping_sha256']:
        raise ValueError('Body assets differ from source-pinned bindings')
    spec = importlib.util.spec_from_file_location('body_asset_inspector', ROOT / 'scripts/inspect-transcription-assets.py')
    inspector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inspector)
    args.aes_key = inspector.asset_map.AES
    reader, handle = inspector.asset_map.initialize(args)
    reader.ReadScriptData = True
    args.out.mkdir(parents=True, exist_ok=True)
    packages, errors = {}, {}
    for path in bindings['uninspected_dependencies']:
        raw = bytes(reader.Files[path].Read())
        package = inspector.package_json(reader, path)
        row = {'package_bytes_sha256': digest(raw), 'package_bytes': len(raw)}
        if package.get('error'):
            errors[path] = package['error']
        else:
            filename = digest(path.encode()) + '.json.gz'
            encoded = gzip.compress(json.dumps(package, separators=(',', ':'), allow_nan=False).encode(), mtime=0)
            (args.out / filename).write_bytes(encoded)
            row.update(file=filename, sha256=digest(encoded))
        for obj in reader.LoadPackage(path).GetExports():
            if str(obj.GetType().Name) == 'USkeletalMesh' and str(obj.Name) == Path(path).stem:
                try:
                    arrays, info = mesh_data(obj)
                    filename = digest(path.encode()) + '.npz'
                    np.savez_compressed(args.out / filename, **arrays)
                    row['lod0'] = {**info, 'file': filename, 'sha256': digest((args.out / filename).read_bytes())}
                except (ValueError, AttributeError) as error:
                    row['mesh_error'] = str(error)
        packages[path] = row
    if archives != {f.name: {'bytes': f.stat().st_size, 'sha256': digest(f.read_bytes())} for f in args.paks.glob('*.utoc')} or \
       digest(args.mappings.read_bytes()) != bindings['mapping_sha256']:
        raise ValueError('Installed body assets changed during extraction')
    report = {'schema_version': 1, 'kind': 'installed_body_rest_and_skinning_evidence',
        'bindings_sha256': digest(args.bindings.read_bytes()), 'generator_sha256': digest(Path(__file__).read_bytes()),
        'mapping_sha256': bindings['mapping_sha256'], 'archives': archives,
        'decoder_sha256': digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()),
        'packages': packages, 'export_errors': errors,
        'native_camera_reconstructed': False, 'native_body_reconstructed': False, 'native_visibility_verified': False,
        'limitations': ['Rest geometry requires actual native graph poses and mesh transforms before visibility use.',
            'LOD0 is an asset reference, not a recorded native LOD selection.',
            'Disabled and cloth sections are preserved; no clothing deformation or runtime section visibility is invented.',
            'Raw integer skinning weights are preserved without renormalization.']}
    (args.out / 'index.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'packages': len(packages), 'meshes': sum('lod0' in r for r in packages.values()),
        'export_errors': len(errors), 'mesh_errors': sum('mesh_error' in r for r in packages.values()),
        'native_visibility_verified': False}))


if __name__ == '__main__':
    main()
