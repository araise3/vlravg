"""Bind cooked shader type/permutation/target records to archived programs.

Reads installed material packages and cross-checks the previous extraction.
Shader selection, achieved inputs, clocks and compositing remain unknown.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def name_input(name):
    """Canonical numeric FName suffixes become the CityHash seed, otherwise 0."""
    match = re.fullmatch(r'(.+)_([0-9]+)', name, re.ASCII)
    if match and (match[2] == '0' or not match[2].startswith('0')) and int(match[2]) <= 2147483647:
        return match[1].upper().encode('utf-8'), int(match[2]) + 1
    return name.upper().encode('utf-8'), 0


def shader_rows(content):
    """Retain root, mesh and pipeline occurrences, including reused programs."""
    for scope, group in [('material', content), *[(f'mesh:{i}', g)
            for i, g in enumerate(content.get('OrderedMeshShaderMaps', []))]]:
        shaders = group['Shaders']
        if len(group['ShaderTypes']) != len(shaders) or len(group['ShaderPermutations']) != len(shaders):
            raise ValueError('Cooked shader arrays have different lengths')
        for i, shader in enumerate(shaders):
            if shader['Type'] != group['ShaderTypes'][i]:
                raise ValueError('Shader type and parallel lookup table differ')
            yield scope, i, group['ShaderPermutations'][i], shader
        for p, pipeline in enumerate(group['ShaderPipelines']):
            if len(pipeline['Shaders']) != len(pipeline['PermutationIds']):
                raise ValueError('Pipeline shader/permutation lengths differ')
            for i, shader in enumerate(pipeline['Shaders']):
                if shader is not None:
                    yield f'{scope}/pipeline:{p}', i, pipeline['PermutationIds'][i], shader


def bind_resource(resource, targets, matches, labels):
    identity = lambda match: [(p['shader_hash'], p.get('compiled_sha256'), p['frequency']) for p in match['shaders']]
    if not matches or any(identity(m) != identity(matches[0]) for m in matches[1:]):
        raise ValueError('Missing or conflicting archived resource programs')
    programs = matches[0]['shaders']
    hashes = [p['shader_hash'] for p in programs]
    if hashes != sorted(set(hashes)):
        raise ValueError('Resource shader hashes must retain the unique sorted code order')
    pointer_types = {v['Hash'] for v in resource['pointer_table']['Types']}
    pointer_vfs = {v['Hash'] for v in resource['pointer_table']['VFTypes']}
    rows = []
    used_targets = set()
    for scope, ordinal, permutation, shader in shader_rows(resource['content']):
        key = f'{scope}/{ordinal}'
        target = targets[key]
        used_targets.add(key)
        index = shader['ResourceIndex']
        if not isinstance(index, int) or not 0 <= index < len(programs):
            raise ValueError('Shader ResourceIndex is outside its archived resource')
        program = programs[index]
        if target['frequency'] != program['frequency'] or target['platform'] != resource['platform']:
            raise ValueError('Typed shader target disagrees with the archived indexed program')
        th, vh = shader['Type']['Hash'], shader['VFType']['Hash']
        if th not in pointer_types or vh not in pointer_vfs:
            raise ValueError('Shader type/vertex factory is absent from its pointer table')
        structs, buffers = shader['UniformBufferParameterStructs'], shader['UniformBufferParameters']
        if len(structs) != len(buffers):
            raise ValueError('Uniform buffer type/binding lengths differ')
        rows.append({'scope': scope, 'serialized_ordinal': ordinal, 'permutation': permutation,
            'shader_type_hash': th, 'shader_type_label': labels.get(str(th)),
            'vertex_factory_hash': vh, 'vertex_factory_label': labels.get(str(vh)),
            'resource_index': index, 'shader_hash': program['shader_hash'], 'target': target,
            'compiled_sha256': program['compiled_sha256'],
            'uniform_buffers': [{'name_hash': t['Hash'], 'label': labels.get(str(t['Hash'])),
                'base_index': b['BaseIndex']} for t, b in zip(structs, buffers)],
            'serialized_parameter_map': shader['ParameterMapInfo'],
            'runtime_shader_selected': False, 'runtime_parameter_values': None})
    if used_targets != set(targets):
        raise ValueError('Typed shader target coverage differs')
    return rows


def inspect(args):
    raw = args.materials.read_bytes()
    materials = json.loads(raw)
    assets = module('shader_variants_assets', 'inspect-transcription-assets.py')
    if digest(args.mappings.read_bytes()) != materials['mapping_sha256']:
        raise ValueError('Shader variant mapping receipt differs')
    archives = {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())}
        for p in args.paks.glob('*.utoc')}
    if archives != materials['archives'] or materials['decoder_sha256'] != digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()):
        raise ValueError('Shader variant installed source/decoder differs')
    args.aes_key = assets.asset_map.AES
    reader, handle = assets.asset_map.initialize(args)
    reader.ReadShaderMaps = True
    from CUE4Parse.Utils import CityHash
    from CUE4Parse.UE4.Assets.Exports.Material import HashedNamesProvider
    from System import Array, Byte, UInt64
    from System.IO import StreamReader
    import clr
    assembly = clr.GetClrType(HashedNamesProvider).Assembly
    stream = assembly.GetManifestResourceStream('CUE4Parse.Resources.ShaderHashedNames.json')
    text_reader = StreamReader(stream)
    try:
        dictionary_raw = str(text_reader.ReadToEnd()).encode('utf-8')
    finally:
        text_reader.Dispose()
    dictionary = json.loads(dictionary_raw)
    candidates = {}
    for package in materials['materials'].values():
        for export in package['exports']:
            for resource in export['shader_maps']:
                for dep in resource['pointer_table']['TypeDependencies']:
                    candidates.setdefault(dep['Name'], set()).add('serialized_type_layout')
    for name in dictionary.values():
        candidates.setdefault(name, set()).add('decoder_embedded_dictionary')
    labels = {}
    for name, origins in sorted(candidates.items()):
        data, seed = name_input(name)
        hashed = int(CityHash.CityHash64WithSeed(Array[Byte](data), UInt64(seed)))
        label = {'name': name, 'origins': sorted(origins), 'hash_input_hex': data.hex(), 'hash_seed': seed}
        if str(hashed) in labels and labels[str(hashed)]['name'].upper() != name.upper():
            raise ValueError('Ambiguous shader name hash candidates')
        labels[str(hashed)] = label
    resources, owners = {}, {}
    for path, cached in sorted(materials['materials'].items()):
        package_raw = bytes(reader.Files[path].Read())
        if digest(package_raw) != cached['package_bytes_sha256']:
            raise ValueError('Installed shader material package differs: ' + path)
        loaded = {str(o.Name): o for o in reader.LoadPackage(path).GetExports() if hasattr(o, 'LoadedMaterialResources')}
        if set(loaded) != {e['name'] for e in cached['exports']}:
            raise ValueError('Installed material export coverage differs')
        for export in cached['exports']:
            maps = [r.LoadedShaderMap for r in loaded[export['name']].LoadedMaterialResources if r.LoadedShaderMap is not None]
            if len(maps) != len(export['shader_maps']):
                raise ValueError('Installed material shader map count differs')
            for shader_map, resource in zip(maps, export['shader_maps']):
                if str(shader_map.ResourceHash) != resource['resource_hash'] or str(shader_map.ShaderPlatform) != resource['platform'] or \
                   assets.value_json(shader_map.Content) != resource['content'] or assets.value_json(shader_map.PointerTable) != resource['pointer_table']:
                    raise ValueError('Installed shader map structure differs')
                targets = {}
                groups = [('material', shader_map.Content), *[(f'mesh:{i}', g)
                    for i, g in enumerate(shader_map.Content.OrderedMeshShaderMaps)]]
                for scope, group in groups:
                    for i, shader in enumerate(group.Shaders):
                        targets[f'{scope}/{i}'] = {'frequency': str(shader.Target.Frequency), 'platform': str(shader.Target.Platform)}
                    for p, pipeline in enumerate(group.ShaderPipelines):
                        for i, shader in enumerate(pipeline.Shaders):
                            if shader is not None:
                                targets[f'{scope}/pipeline:{p}/{i}'] = {'frequency': str(shader.Target.Frequency), 'platform': str(shader.Target.Platform)}
                rh = resource['resource_hash']
                rows = bind_resource(resource, targets, materials['shader_map_matches'][rh], labels)
                if rh in resources and resources[rh]['variants'] != rows:
                    raise ValueError('Shared resource variant records differ')
                resources[rh] = {'platform': resource['platform'], 'typed_targets': targets, 'variants': rows}
                owners.setdefault(rh, []).append({'package': path, 'export': export['name']})
    if archives != {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())} for p in args.paks.glob('*.utoc')}:
        raise ValueError('Installed shader archives changed during extraction')
    used = {str(r[k]) for v in resources.values() for r in v['variants'] for k in ('shader_type_hash', 'vertex_factory_hash')}
    used.update(str(b['name_hash']) for v in resources.values() for r in v['variants'] for b in r['uniform_buffers'])
    report = {'schema_version': 1, 'kind': 'cooked_shader_variant_program_bindings',
        'generator_sha256': digest(Path(__file__).read_bytes()), 'materials_sha256': digest(raw),
        'mapping_sha256': materials['mapping_sha256'], 'archives': archives, 'decoder_sha256': materials['decoder_sha256'],
        'name_dictionary_sha256': digest(dictionary_raw), 'labels': {h: labels[h] for h in sorted(used) if h in labels},
        'source_reference_commit': (args.references / 'commit.txt').read_text().strip(),
        'source_references': {p.name: digest(p.read_bytes()) for p in args.references.glob('*.cs')},
        'resources': {h: {**r, 'owners': owners[h]} for h, r in sorted(resources.items())},
        'native_shader_opacity_verified': False, 'runtime_parameter_binding_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'limitations': ['Typed target and archived index agreement binds serialized variants to compiled programs; it does not select the replay render pass.',
            'Name labels require a matching CityHash input; embedded dictionary labels are decoder evidence, not serialized name strings.',
            'Shader inputs, render state and achieved clocks remain unknown.']}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'resources': len(resources), 'variant_records': sum(len(r['variants']) for r in resources.values()),
        'unlabeled_shader_type_hashes': sorted({r['shader_type_hash'] for v in resources.values() for r in v['variants'] if not r['shader_type_label']}),
        'native_visibility_verified': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--materials', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--references', required=True, type=Path)
    parser.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    parser.add_argument('--mappings', type=Path, default=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    inspect(parser.parse_args())


if __name__ == '__main__':
    main()
