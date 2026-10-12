"""Trace cooked visibility materials to their installed shader archive records.

Asset-only evidence: exports serialized properties, shader hashes and compiled
bytecode. It does not certify achieved camera transforms, effect clocks,
runtime material overrides, or player visibility.
"""
from __future__ import annotations

import argparse
import ctypes
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import struct

from replay_asset_model import reference_package

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def material_roots(source, model, smoke_model, rules):
    """Keep every root and source receipt; direct references are not full coverage."""
    manifest = json.loads((source / 'manifest.json').read_bytes())
    for data in (model, smoke_model, rules):
        if data['mapping_sha256'] != manifest['inventory']['mapping_sha256'] or data['archives'] != manifest['inventory']['archives']:
            raise ValueError('Material research source mappings/archives differ')
    index = {r['package']: r for r in map(json.loads, (source / 'index.jsonl').read_text().splitlines())}
    roots = {p for rule in rules['classes'].values() for p in rule['dispatch_lineage']}
    roots.update(reference_package({'reference': c}) for c in model['vision_profiles'])
    for cls, row in {**model['smoke_profiles'], **smoke_model['smoke_profiles']}.items():
        roots.add(reference_package({'reference': cls}))
        if row.get('intro_loop_effect_class'):
            roots.add(reference_package({'reference': row['intro_loop_effect_class']}))
    roots.add('ShooterGame/Content/Characters/Global/Smoke/Comp_PlayerCharacter_SmokeOverlays.uasset')
    materials, receipts = {}, {}
    for path in sorted(roots):
        row = index[path]
        raw = (source / row['file']).read_bytes()
        package = json.loads(gzip.decompress(raw))
        if digest(raw) != row['sha256'] or row['errors'] or package.get('errors') or package['package'] != path:
            raise ValueError('Material root source receipt differs: ' + path)
        receipts[path] = {'file': row['file'], 'sha256': row['sha256']}
        for node in walk(package):
            if node.get('reference', '').startswith(("Material'", "MaterialInstanceConstant'")):
                target = reference_package(node)
                if target:
                    materials.setdefault(target, set()).add(path)
    return {p: sorted(v) for p, v in sorted(materials.items())}, receipts


def dxbc_container(record):
    """Find a bounded DXBC/DXIL container in a UE shader record, never guess its size."""
    candidates = []
    start = 0
    while True:
        offset = record.find(b'DXBC', start)
        if offset < 0:
            break
        start = offset + 4
        if len(record) - offset < 32:
            continue
        version, size, count = struct.unpack_from('<III', record, offset + 20)
        if version != 1 or count > 256 or size < 32 + count * 4 or offset + size > len(record):
            continue
        chunks = []
        for index in range(count):
            chunk_offset = struct.unpack_from('<I', record, offset + 32 + 4 * index)[0]
            if chunk_offset < 32 + count * 4 or chunk_offset + 8 > size:
                break
            tag, length = struct.unpack_from('<4sI', record, offset + chunk_offset)
            if chunk_offset + 8 + length > size:
                break
            chunks.append(tag.decode('ascii', errors='replace'))
        else:
            if any(c in chunks for c in ('SHDR', 'SHEX', 'DXIL')):
                candidates.append((offset, record[offset:offset + size], chunks))
    if len(candidates) != 1:
        raise ValueError('Expected one bounded compiled shader container, found ' + str(len(candidates)))
    return candidates[0]


def disassemble(code):
    """Use the installed Windows SM5 disassembler; preserve failure as evidence."""
    dll = ctypes.WinDLL('d3dcompiler_47.dll')
    method = dll.D3DDisassemble
    method.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_char_p,
                       ctypes.POINTER(ctypes.c_void_p)]
    method.restype = ctypes.c_long
    output = ctypes.c_void_p()
    raw = ctypes.create_string_buffer(code)
    status = method(raw, len(code), 0, None, ctypes.byref(output))
    if status < 0 or not output.value:
        raise ValueError('D3DDisassemble HRESULT ' + hex(status & 0xffffffff))
    table = ctypes.cast(output, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    pointer = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(table[3])
    size = ctypes.WINFUNCTYPE(ctypes.c_size_t, ctypes.c_void_p)(table[4])
    release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(table[2])
    try:
        return ctypes.string_at(pointer(output), size(output)).rstrip(b'\0').decode('utf-8')
    finally:
        release(output)


def inspect(args):
    spec = importlib.util.spec_from_file_location('visibility_inspector', ROOT / 'scripts/inspect-transcription-assets.py')
    inspector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inspector)
    from_source = [json.loads(p.read_bytes()) for p in (args.model, args.smoke_model, args.effect_rules)]
    roots, receipts = material_roots(args.source, *from_source)
    inventory = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    if digest(args.mappings.read_bytes()) != inventory['mapping_sha256']:
        raise ValueError('Installed mappings differ from cached source')
    actual_archives = {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())} for p in args.paks.glob('*.utoc')}
    if actual_archives != inventory['archives']:
        raise ValueError('Installed archive inventory differs from cached source')
    args.aes_key = inspector.asset_map.AES
    reader, handle = inspector.asset_map.initialize(args)
    reader.ReadShaderMaps = True
    from CUE4Parse.UE4.Shaders import FShaderCodeArchive
    from CUE4Parse.Compression import Compression, CompressionMethod
    from System import Array, Byte

    args.out.mkdir(parents=True, exist_ok=True)
    shader_dir = args.out / 'shaders'
    shader_dir.mkdir(exist_ok=True)
    materials, wanted = {}, set()
    pending = list(roots)
    while pending:
        path = pending.pop(0)
        if path in materials:
            continue
        raw = bytes(reader.Files[path].Read())
        exports = []
        for obj in reader.LoadPackage(path).GetExports():
            if not hasattr(obj, 'LoadedMaterialResources'):
                continue
            properties = {k: inspector.value_json(v) for k, v in inspector.asset_map.properties(obj).items()}
            parent = reference_package(properties.get('Parent'))
            if parent:
                pending.append(parent)
            maps = []
            for resource in obj.LoadedMaterialResources:
                m = resource.LoadedShaderMap
                if m is None:
                    continue
                resource_hash = str(m.ResourceHash)
                wanted.add(resource_hash)
                maps.append({'platform': str(m.ShaderPlatform), 'resource_hash': resource_hash,
                    'external_code': m.Code is None,
                    'content': inspector.value_json(m.Content),
                    'pointer_table': inspector.value_json(m.PointerTable)})
            exports.append({'name': str(obj.Name), 'type': str(obj.GetType().Name), 'properties': properties,
                'parent_package': parent, 'serialized_property_names': sorted(properties),
                # RuntimeEntries is a serialized fixed array with repeated tag
                # names. A dictionary keyed by Name silently drops indices 0..6.
                'cached_expression_data_tags': [{'name': str(p.Name), 'array_index': int(p.ArrayIndex),
                    'array_size': int(p.ArraySize), 'value': inspector.value_json(p.Tag.Value)}
                    for p in obj.CachedExpressionData.Properties] if obj.CachedExpressionData is not None else None,
                'shader_maps': maps,
                'cooked_expression_count': len(obj.Expressions) if hasattr(obj, 'Expressions') else None})
        materials[path] = {'package_bytes_sha256': digest(raw), 'package_bytes': len(raw), 'exports': exports}

    archives, matches, groups = {}, {}, {}
    for file in sorted(str(f.Key) for f in reader.Files if str(f.Key).endswith('.ushaderbytecode')):
        ar = reader.CreateReader(file)
        archive_raw = bytes(ar.ReadBytes(int(ar.Length)))
        ar.Position = 0
        library = FShaderCodeArchive(ar).SerializedShaders
        if library is None or str(library.GetType().Name) != 'FIoStoreShaderCodeArchive':
            raise ValueError('Unsupported shader archive type: ' + file)
        archives[file] = {'sha256': digest(archive_raw), 'bytes': len(archive_raw),
            'shader_maps': len(library.ShaderMapHashes), 'shader_records': len(library.ShaderHashes)}
        for index, map_hash in enumerate(library.ShaderMapHashes):
            key = str(map_hash)
            if key not in wanted:
                continue
            entry = library.ShaderMapEntries[index]
            indices = [int(library.ShaderIndices[k]) for k in range(int(entry.ShaderIndicesOffset), int(entry.ShaderIndicesOffset + entry.NumShaders))]
            result = {'archive': file, 'map_index': index, 'shaders': []}
            for shader_index in indices:
                shader = library.ShaderEntries[shader_index]
                gi = int(shader.ShaderGroupIndex)
                group_key = file + ':' + str(gi)
                group_entry = library.ShaderGroupEntries[gi]
                if group_key not in groups:
                    chunk = library.ShaderGroupIoHashes[gi]
                    providers = [getattr(v, '__implementation__', v) for v in reader.MountedVfs]
                    providers = [v for v in providers if hasattr(v, 'DoesChunkExist') and v.DoesChunkExist(chunk)]
                    if len(providers) != 1:
                        raise ValueError('Ambiguous/missing shader group provider: ' + str(chunk))
                    compressed = bytes(providers[0].Read(chunk))
                    if len(compressed) != int(group_entry.CompressedSize):
                        raise ValueError('Shader group compressed length differs')
                    decoded = compressed if len(compressed) == int(group_entry.UncompressedSize) else bytes(Compression.Decompress(
                        Array[Byte](compressed), int(group_entry.UncompressedSize), CompressionMethod.Oodle, ar))
                    if len(decoded) != int(group_entry.UncompressedSize):
                        raise ValueError('Shader group decoded length differs')
                    offsets = sorted(int(library.ShaderEntries[int(library.ShaderIndices[k])].UncompressedOffsetInGroup)
                        for k in range(int(group_entry.ShaderIndicesOffset), int(group_entry.ShaderIndicesOffset + group_entry.NumShaders)))
                    if len(offsets) != len(set(offsets)) or not offsets or offsets[0] != 0 or offsets[-1] >= len(decoded):
                        raise ValueError('Invalid shader group offset table')
                    groups[group_key] = {'chunk_id': str(chunk), 'container': str(providers[0].Name),
                        'compressed_sha256': digest(compressed), 'decoded_sha256': digest(decoded),
                        'compressed_bytes': len(compressed), 'decoded_bytes': len(decoded),
                        '_decoded': decoded, '_offsets': offsets + [len(decoded)]}
                group = groups[group_key]
                offset = int(shader.UncompressedOffsetInGroup)
                end = group['_offsets'][group['_offsets'].index(offset) + 1]
                record = group['_decoded'][offset:end]
                shader_hash = str(library.ShaderHashes[shader_index])
                row = {'index': shader_index, 'shader_hash': shader_hash, 'frequency': str(shader.Frequency),
                    'group': group_key, 'offset': offset, 'record_bytes': len(record), 'record_sha256': digest(record)}
                try:
                    code_offset, code, chunks = dxbc_container(record)
                    filename = shader_hash + '.dxbc'
                    (shader_dir / filename).write_bytes(code)
                    row.update({'container_offset': code_offset, 'compiled_bytes': len(code), 'compiled_sha256': digest(code),
                        'compiled_file': 'shaders/' + filename, 'chunks': chunks})
                    if 'DXIL' not in chunks:
                        assembly = disassemble(code)
                        filename = shader_hash + '.asm.txt'
                        (shader_dir / filename).write_bytes(assembly.encode('utf-8'))
                        row.update({'disassembly_file': 'shaders/' + filename, 'disassembly_sha256': digest(assembly.encode())})
                except (ValueError, OSError) as error:
                    row['decode_error'] = str(error)
                result['shaders'].append(row)
            matches.setdefault(key, []).append(result)
    if actual_archives != {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())} for p in args.paks.glob('*.utoc')} or \
       digest(args.mappings.read_bytes()) != inventory['mapping_sha256']:
        raise ValueError('Installed visibility materials changed during extraction')
    report = {'schema_version': 1, 'kind': 'installed_visibility_material_shader_evidence',
        'generator_sha256': digest(Path(__file__).read_bytes()), 'mapping_sha256': inventory['mapping_sha256'],
        'archives': actual_archives, 'decoder_sha256': digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()),
        'source_manifest_sha256': digest((args.source / 'manifest.json').read_bytes()),
        'source_index_sha256': digest((args.source / 'index.jsonl').read_bytes()),
        'blueprint_sources': receipts, 'direct_material_references': roots,
        'materials': materials, 'shader_archives': archives, 'shader_map_matches': matches,
        'shader_groups': {k: {n: v for n, v in g.items() if not n.startswith('_')} for k, g in groups.items()},
        'unresolved_resource_hashes': sorted(wanted - set(matches)),
        'native_shader_opacity_verified': False, 'runtime_parameter_binding_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'scope': 'Direct materials referenced by pinned vision/smoke Blueprints plus material parents. Particle and FXC material closure is incomplete.',
        'limitations': ['Cooked expression graphs may be stripped; absence is not proof of constant opacity.',
            'Serialized override values apply only when their explicit override flags are set.',
            'Compiled variants do not establish the variant selected by a replay or its runtime uniform values.',
            'Shader output, render blending, camera transform and render-time effect activation still need joint reconstruction.']}
    (args.out / 'materials.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'materials': len(materials), 'resource_hashes': len(wanted), 'resolved_resource_hashes': len(matches),
        'shader_groups': len(groups), 'native_visibility_verified': False}))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', required=True, type=Path)
    p.add_argument('--model', required=True, type=Path)
    p.add_argument('--smoke-model', required=True, type=Path)
    p.add_argument('--effect-rules', required=True, type=Path)
    p.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings', type=Path, default=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    p.add_argument('--out', required=True, type=Path)
    inspect(p.parse_args())


if __name__ == '__main__':
    main()
