"""Audit graph, compiled shader input and smoke-clock evidence without certifying LOS."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify(args):
    graphs = json.loads(args.graphs.read_bytes())
    body = json.loads(args.body_bindings.read_bytes())
    shaders = json.loads(args.shaders.read_bytes())
    materials = json.loads(args.materials.read_bytes())
    clocks = json.loads(args.clocks.read_bytes())
    graph_module = module('graph_continuation_audit', 'inspect-native-animation-graphs.py')
    shader_module = module('shader_continuation_audit', 'inspect-native-shader-inputs.py')
    clock_module = module('clock_continuation_audit', 'build-native-activation-clocks.py')
    source = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    for report, file in ((graphs, 'inspect-native-animation-graphs.py'), (shaders, 'inspect-native-shader-inputs.py'),
                         (clocks, 'build-native-activation-clocks.py')):
        if report['mapping_sha256'] != source['mapping_sha256'] or report['archives'] != source['archives'] or \
           report['generator_sha256'] != digest((ROOT / 'scripts' / file).read_bytes()) or report['native_visibility_verified'] is not False:
            raise ValueError('Continuation source/generator differs or native visibility was promoted')
    if graphs['bindings_sha256'] != digest(args.body_bindings.read_bytes()) or graphs['covered_replays'] != body['covered_replays'] or \
       graphs['decoder_sha256'] != digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()) or \
       shaders['materials_sha256'] != digest(args.materials.read_bytes()):
        raise ValueError('Continuation input receipt differs')
    camera = graphs['camera_asset_boundary']
    camera_raw = (args.source / camera['source_file']).read_bytes()
    camera_source = json.loads(gzip.decompress(camera_raw))
    source_index = {r['package']: r for r in map(json.loads, (args.source / 'index.jsonl').read_text().splitlines())}
    row = source_index[graph_module.CAMERA]
    if camera != {'package': graph_module.CAMERA, 'source_file': row['file'], 'source_sha256': row['sha256'],
                  **graph_module.camera_boundary(camera_source)} or digest(camera_raw) != row['sha256']:
        raise ValueError('Camera Blueprint boundary differs from pinned source')
    expected_graphs = {graph_module.CORE: [], graph_module.POST: []}
    for actor, row in body['agent_classes'].items():
        for path, dep in row['mesh_and_animation_dependencies'].items():
            if dep['exports'] and any(e['type'] == 'UAnimBlueprintGeneratedClass' for e in dep['exports']):
                expected_graphs.setdefault(path, []).append({'actor_class': actor, 'bindings': dep['bindings']})
    if set(graphs['packages']) != set(expected_graphs):
        raise ValueError('Animation graph dependency coverage differs')
    node_count = writes = calls = copies = handlers = 0
    for path, row in graphs['packages'].items():
        raw = (args.graphs.parent / row['file']).read_bytes()
        package = json.loads(gzip.decompress(raw))
        if digest(raw) != row['sha256'] or package['package'] != path or graph_module.summarize(package) != row['graphs'] or row['used_by'] != expected_graphs[path]:
            raise ValueError('Graph source/structure receipt differs')
        for graph in row['graphs']:
            if graph['native_node_array_reconstructed'] is not False or graph['native_body_reconstructed'] is not False or \
               any(n['native_node_index'] is not None or n['native_evaluated_pose'] is not None or
                   any(p['resolved_target'] is not None for p in n['pose_links']) for n in graph['nodes']):
                raise ValueError('Serialized graph was promoted to a native pose')
            folded = graph['folded_inputs']
            if folded['sparse_cdo_captured'] is not True or folded['native_property_copy_executed'] is not False or \
               any(h['native_node_index'] is not None or h['native_handler_executed'] is not False
                   for h in folded['exposed_value_handlers']) or \
               any(r['native_property_copy_executed'] is not False or r['native_copy_batch_selected'] is not False or
                   r['source']['runtime_value'] is not None or any(d['runtime_value'] is not None for d in r['destinations'])
                   for r in folded['property_copy_routes']):
                raise ValueError('Sparse graph inputs are missing or were promoted to native execution')
            node_count += len(graph['nodes'])
            writes += len(graph['exposed_input_writes'])
            calls += len(graph['native_calls'])
            copies += len(folded['property_copy_routes'])
            handlers += len(folded['exposed_value_handlers'])
    tool = shaders['disassembler']
    executable = Path(tool['executable'])
    if digest(executable.read_bytes()) != tool['sha256'] or any(
        digest((executable.parent / name).read_bytes()) != sha for name, sha in tool['companions'].items()):
        raise ValueError('DXIL disassembler receipt differs')
    wanted = {s['shader_hash']: s for matches in materials['shader_map_matches'].values() for match in matches
        for s in match['shaders'] if 'DXIL' in s['chunks']}
    if set(wanted) != set(shaders['shaders']):
        raise ValueError('DXIL shader coverage differs')
    for key, row in shaders['shaders'].items():
        compiled = args.materials.parent / wanted[key]['compiled_file']
        assembly_file = args.shaders.parent / row['file']
        assembly_raw = assembly_file.read_bytes()
        if row['frequency'] != wanted[key]['frequency'] or row['compiled_file'] != str(compiled.resolve()) or \
           row['compiled_sha256'] != wanted[key]['compiled_sha256'] or digest(compiled.read_bytes()) != row['compiled_sha256'] or \
           digest(assembly_raw) != row['sha256']:
            raise ValueError('DXIL compiled/disassembly receipt differs')
        actual = subprocess.run([str(executable), '-dumpbin', str(compiled)], capture_output=True, check=True, timeout=30)
        if actual.stdout != assembly_raw or actual.stderr.decode('utf-8') != row['diagnostics']:
            raise ValueError('DXIL disassembly differs from compiled shader')
        assembly = assembly_raw.decode('utf-8')
        flow = shader_module.alpha_inputs(assembly, row['frequency'] == 'SF_Pixel')
        for name, value in flow.items():
            if row[name] != value:
                raise ValueError('Shader input slice differs')
        routes = [route for output in flow['alpha_outputs'] if (route := shader_module.direct_alpha_route(output, assembly)) is not None]
        if routes != row['direct_alpha_routes'] or any(o['runtime_value'] is not None or o['unresolved_ssa_values'] for o in flow['alpha_outputs']):
            raise ValueError('Shader static route differs or runtime value was inferred')
    expected_resources = {r['resource_hash'] for item in materials['materials'].values() for e in item['exports'] for r in e['shader_maps']}
    if set(shaders['resources']) != expected_resources:
        raise ValueError('Material resource coverage differs')
    owners = {key: [{'package': package, 'export': e['name']} for package, item in materials['materials'].items()
        for e in item['exports'] for r in e['shader_maps'] if r['resource_hash'] == key] for key in expected_resources}
    for package, item in materials['materials'].items():
        for export in item['exports']:
            for resource in export['shader_maps']:
                row = shaders['resources'][resource['resource_hash']]
                hashes = sorted({s['shader_hash'] for match in materials['shader_map_matches'][resource['resource_hash']] for s in match['shaders']})
                if row['owners'] != owners[resource['resource_hash']] or row['platform'] != resource['platform'] or row['shader_hashes'] != hashes or \
                   row['direct_uniform_parameters'] != shader_module.direct_parameters(resource) or row['runtime_shader_selected'] is not False:
                    raise ValueError('Cooked uniform field data differs')
                expected_routes = []
                for key in row['shader_hashes']:
                    for route in shaders['shaders'].get(key, {}).get('direct_alpha_routes', []):
                        fields = [p for p in row['direct_uniform_parameters'] if route['reflected_cbuffer_name'] == 'UniformBufferConstants_Material'
                            and p['field']['Type']['value__'] == 1 and p['field']['BufferOffset'] == route['float4_slot'] * 4 + route['lane']]
                        expected_routes.append({'shader_hash': key, **route, 'matching_serialized_scalar_fields': fields,
                            'native_uniform_binding_verified': False})
                if expected_routes != row['compiled_direct_alpha_routes']:
                    raise ValueError('Shader scalar field correspondence differs')
    models = [Path(r['file']) for r in clocks['model_receipts']]
    if clocks != clock_module.build(args.source, models):
        raise ValueError('Smoke clock proof differs from source')
    for report, names in ((graphs, ('native_camera_reconstructed', 'native_node_array_reconstructed', 'native_body_reconstructed')),
        (shaders, ('native_shader_opacity_verified', 'runtime_parameter_binding_verified', 'activation_clock_verified')),
        (clocks, ('activation_clock_verified', 'native_shader_opacity_verified'))):
        if any(report[name] is not False for name in names):
            raise ValueError('Continuation evidence was promoted to runtime verification')
    report = {'schema_version': 1, 'kind': 'native_continuation_evidence_audit', 'passed': True,
        'verifier_sha256': digest(Path(__file__).read_bytes()),
        'report_receipts': {name: digest(getattr(args, name).read_bytes()) for name in ('graphs', 'shaders', 'clocks')},
        'covered_replays': len(graphs['covered_replays']), 'animation_graph_packages': len(graphs['packages']),
        'camera_blueprint_functions': len(camera['decoded_blueprint_function_names']),
        'animation_nodes': node_count, 'exposed_member_writes': writes, 'graph_native_call_sites': calls,
        'serialized_property_copy_routes': copies, 'serialized_exposed_value_handlers': handlers,
        'unique_sm6_disassemblies': len(shaders['shaders']),
        'pixel_alpha_stores': sum(len(s['alpha_outputs']) for s in shaders['shaders'].values()),
        'compiled_direct_alpha_routes': sum(len(r['compiled_direct_alpha_routes']) for r in shaders['resources'].values()),
        'smoke_classes': len(clocks['classes']), 'proven_smoke_timer_requests': len(clocks['parent_clock_proof']['timers']),
        'native_camera_reconstructed': False, 'native_body_reconstructed': False, 'native_shader_opacity_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'body-bindings', 'graphs', 'shaders', 'materials', 'clocks', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    print(json.dumps(verify(parser.parse_args()), indent=2))
