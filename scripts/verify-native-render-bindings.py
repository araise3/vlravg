"""Audit serialized render closure, compiled input slices and HUD material route.

Checks source receipts and recomputes structure/value slices. DXC output is
receipt-checked here; native render execution is never claimed.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify(args):
    closure = json.loads(args.closure.read_bytes())
    roots = json.loads(args.root_materials.read_bytes())
    materials = json.loads(args.materials.read_bytes())
    shaders = json.loads(args.shaders.read_bytes())
    widget = json.loads(args.widget_route.read_bytes())
    inventory = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    source_index = {r['package']: r for r in map(json.loads, (args.source / 'index.jsonl').read_text().splitlines())}
    particles = module('render_binding_audit_particles', 'inspect-native-effect-render-closure.py')
    material_module = module('render_binding_audit_materials', 'inspect-native-visibility-materials.py')
    shader_module = module('render_binding_audit_shaders', 'inspect-native-shader-inputs.py')
    widget_module = module('render_binding_audit_widget', 'build-native-widget-material-route.py')
    for report, filename in ((closure, 'inspect-native-effect-render-closure.py'),
        (materials, 'inspect-native-visibility-materials.py'), (shaders, 'inspect-native-shader-inputs.py'),
        (widget, 'build-native-widget-material-route.py')):
        if report['generator_sha256'] != digest((ROOT / 'scripts' / filename).read_bytes()) or \
           report['mapping_sha256'] != inventory['mapping_sha256'] or report['archives'] != inventory['archives'] or \
           any(report[key] is not False for key in ('native_shader_opacity_verified', 'runtime_parameter_binding_verified',
               'activation_clock_verified', 'native_visibility_verified')):
            raise ValueError('Render source/generator differs or native verification was promoted')
    if closure['materials_sha256'] != digest(args.root_materials.read_bytes()) or \
       materials['render_closure_sha256'] != digest(args.closure.read_bytes()) or \
       materials['closure_generator_sha256'] != digest((ROOT / 'scripts/inspect-native-effect-materials.py').read_bytes()) or \
       shaders['materials_sha256'] != digest(args.materials.read_bytes()) or \
       shaders['decode_cache']['generator_sha256'] != digest((ROOT / 'scripts/inspect-native-effect-shader-inputs.py').read_bytes()):
        raise ValueError('Render input/decoder receipt differs')
    decoder_sha = digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes())
    if closure['decoder_sha256'] != decoder_sha or materials['decoder_sha256'] != decoder_sha:
        raise ValueError('Render asset decoder receipt differs')
    if closure['roots'] != sorted(set(roots['blueprint_sources']) | {particles.WIDGET, particles.SMOKE}):
        raise ValueError('Render root policy coverage differs')
    packages, candidates, required = {}, {}, set(closure['roots'])
    for path, record in closure['packages'].items():
        raw = (args.closure.parent / record['file']).read_bytes()
        package = json.loads(gzip.decompress(raw))
        # Canonical JSON changes dictionary traversal order. Reference
        # occurrences are compared as a multiset, retaining duplicate edges.
        edge_key = lambda edge: json.dumps(edge, sort_keys=True)
        if digest(raw) != record['sha256'] or package['package'] != path or package.get('errors') or \
           sorted(record['reference_edges'], key=edge_key) != sorted(particles.reference_edges(package), key=edge_key) or \
           record['particle_systems'] != particles.summarize_particles(package) or \
           record['unexpanded_bulk_exports'] != package.get('omitted_bulk_exports', []):
            raise ValueError('Render package receipt/structure differs: ' + path)
        origin = record['origin']
        if origin['kind'] == 'pinned_behavior_source':
            receipt = source_index[path]
            source_raw = (args.source / receipt['file']).read_bytes()
            if origin != {'kind': 'pinned_behavior_source', 'file': receipt['file'], 'sha256': receipt['sha256']} or \
               digest(source_raw) != receipt['sha256'] or package != json.loads(gzip.decompress(source_raw)):
                raise ValueError('Render cached source differs')
        elif origin['kind'] != 'installed_package' or not isinstance(origin.get('package_bytes_sha256'), str):
            raise ValueError('Render source origin is absent')
        packages[path] = package
        for edge in record['reference_edges']:
            if edge['action'] == 'follow_render_metadata':
                required.add(edge['target_package'])
            elif edge['action'] == 'material_candidate':
                candidates.setdefault(edge['target_package'], set()).add(path)
    if set(closure['widget_owner_sources']) != set(particles.WIDGET_OWNERS):
        raise ValueError('HUD owner source coverage differs')
    for path, record in closure['widget_owner_sources'].items():
        receipt = source_index[path]
        raw = (args.source / receipt['file']).read_bytes()
        source = json.loads(gzip.decompress(raw))
        instances = [e for e in source['exports'] if e['export_class'] == 'BlindsDrivenMaterialOverlay_C']
        if record != {'file': receipt['file'], 'sha256': receipt['sha256'],
            'serialized_widget_instances': instances, 'native_hud_selected': False} or digest(raw) != receipt['sha256']:
            raise ValueError('HUD owner defaults differ')
        for instance in instances:
            path_ref = particles.reference_package(instance['properties'].get('BaseMaterial'))
            candidates.setdefault(path_ref, set()).add(path)
    if closure['material_candidates'] != {p: sorted(v) for p, v in sorted(candidates.items())} or \
       required != set(packages) | set(closure['missing_followed_packages']) or closure['missing_followed_packages']:
        raise ValueError('Render reference closure/candidate coverage differs')
    if materials['direct_material_references'] != closure['material_candidates'] or materials['unresolved_resource_hashes']:
        raise ValueError('Material candidate/resource coverage differs')
    expected, pending = set(), list(candidates)
    while pending:
        path = pending.pop()
        if path in expected:
            continue
        expected.add(path)
        for export in materials['materials'][path]['exports']:
            if export['parent_package']:
                pending.append(export['parent_package'])
    if expected != set(materials['materials']):
        raise ValueError('Material parent coverage differs')
    records = [s for matches in materials['shader_map_matches'].values() for match in matches for s in match['shaders']]
    unique = {}
    sm5 = 0
    for record in records:
        if 'decode_error' in record:
            raise ValueError('Undecoded compiled render shader')
        key = record['shader_hash']
        if key in unique:
            if any(record[name] != unique[key][name] for name in ('compiled_sha256', 'frequency', 'chunks')):
                raise ValueError('Shared compiled shader receipt differs')
            continue
        unique[key] = record
        raw = (args.materials.parent / record['compiled_file']).read_bytes()
        offset, bounded, chunks = material_module.dxbc_container(raw)
        if digest(raw) != record['compiled_sha256'] or offset != 0 or bounded != raw or chunks != record['chunks']:
            raise ValueError('Compiled shader container differs')
        if 'DXIL' not in chunks:
            assembly_raw = (args.materials.parent / record['disassembly_file']).read_bytes()
            if digest(assembly_raw) != record['disassembly_sha256'] or material_module.disassemble(raw).encode() != assembly_raw:
                raise ValueError('SM5 disassembly differs')
            sm5 += 1
    wanted_dxil = {k for k, r in unique.items() if 'DXIL' in r['chunks']}
    if wanted_dxil != set(shaders['shaders']):
        raise ValueError('DXIL shader coverage differs')
    tool = shaders['disassembler']
    executable = Path(tool['executable'])
    if digest(executable.read_bytes()) != tool['sha256'] or any(
        digest((executable.parent / name).read_bytes()) != sha for name, sha in tool['companions'].items()):
        raise ValueError('DXC tool receipt differs')
    for key, row in shaders['shaders'].items():
        record = unique[key]
        raw = (args.shaders.parent / row['file']).read_bytes()
        if row['compiled_sha256'] != record['compiled_sha256'] or row['frequency'] != record['frequency'] or digest(raw) != row['sha256']:
            raise ValueError('DXIL disassembly receipt differs')
        assembly = raw.decode()
        flow = shader_module.alpha_inputs(assembly, row['frequency'] == 'SF_Pixel')
        if any(row[k] != v for k, v in flow.items()) or any(o['runtime_value'] is not None or
            o['unresolved_ssa_values'] for o in flow['alpha_outputs']):
            raise ValueError('DXIL value slice differs or has unresolved values')
        routes = [route for output in flow['alpha_outputs'] if (route := shader_module.direct_alpha_route(output, assembly)) is not None]
        if routes != row['direct_alpha_routes']:
            raise ValueError('DXIL direct compiled route differs')
    resource_owners = {}
    for path, item in materials['materials'].items():
        for export in item['exports']:
            for resource in export['shader_maps']:
                key = resource['resource_hash']
                resource_owners.setdefault(key, []).append({'package': path, 'export': export['name']})
                row = shaders['resources'][key]
                hashes = sorted({s['shader_hash'] for m in materials['shader_map_matches'][key] for s in m['shaders']})
                if row['runtime_shader_selected'] is not False or row['platform'] != resource['platform'] or \
                   row['shader_hashes'] != hashes or row['direct_uniform_parameters'] != shader_module.direct_parameters(resource):
                    raise ValueError('Cooked uniform parameter metadata differs')
                routes = []
                for shader_hash in hashes:
                    for route in shaders['shaders'].get(shader_hash, {}).get('direct_alpha_routes', []):
                        fields = [p for p in row['direct_uniform_parameters'] if route['reflected_cbuffer_name'] == 'UniformBufferConstants_Material'
                            and p['field']['Type']['value__'] == 1 and p['field']['BufferOffset'] == route['float4_slot'] * 4 + route['lane']]
                        routes.append({'shader_hash': shader_hash, **route, 'matching_serialized_scalar_fields': fields,
                            'native_uniform_binding_verified': False})
                if routes != row['compiled_direct_alpha_routes']:
                    raise ValueError('Compiled uniform field correspondence differs')
    if set(resource_owners) != set(shaders['resources']) or any(shaders['resources'][k]['owners'] != v for k, v in resource_owners.items()):
        raise ValueError('Shader resource ownership differs')
    build_args = argparse.Namespace(source=args.source, materials=args.materials, shaders=args.shaders)
    if widget != widget_module.build(build_args):
        raise ValueError('HUD widget material route differs')
    systems = [s for r in closure['packages'].values() for s in r['particle_systems']]
    emitters = [e for s in systems for e in s['emitters']]
    lods = [l for e in emitters for l in e['lods']]
    report = {'schema_version': 1, 'kind': 'native_render_binding_source_audit', 'passed': True,
        'verifier_sha256': digest(Path(__file__).read_bytes()),
        'report_receipts': {name: digest(getattr(args, name).read_bytes()) for name in ('closure', 'materials', 'shaders', 'widget_route')},
        'packages': len(packages), 'particle_systems': len(systems), 'emitters': len(emitters), 'lods': len(lods),
        'dynamic_parameter_modules': sum(len(l['dynamic_parameter_modules']) for l in lods),
        'material_candidates': len(candidates), 'materials_with_parents': len(materials['materials']),
        'compiled_shader_records': len(records), 'unique_sm5_disassemblies_reexecuted': sm5,
        'unique_sm6_disassemblies': len(wanted_dxil), 'sm6_pixel_output_component3_stores': sum(len(s['alpha_outputs']) for s in shaders['shaders'].values()),
        'dxc_disassembly_reexecuted_during_audit': False,
        'reference_actions': dict(Counter(e['action'] for r in closure['packages'].values() for e in r['reference_edges'])),
        'native_camera_reconstructed': False, 'native_body_reconstructed': False,
        'native_shader_opacity_verified': False, 'activation_clock_verified': False, 'native_visibility_verified': False}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'root-materials', 'closure', 'materials', 'shaders', 'widget-route', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    print(json.dumps(verify(parser.parse_args()), indent=2))
