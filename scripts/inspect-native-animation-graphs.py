"""Recover animation graph structure, folded inputs and exact native dependencies.

Preserves serialized maps that the older cache flattened. LinkID remains an
unresolved runtime index until the engine's transient node array is rebuilt.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = 'ShooterGame/Content/Characters/_Core/3P/TP_Core_AnimGraph_v2.uasset'
POST = 'ShooterGame/Content/Characters/_Core/3P/Models/TP_Core_AnimGraph_post.uasset'
CAMERA = 'ShooterGame/Content/Characters/_Core/BaseShooterCamera.uasset'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def walk(value, path=()):
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            yield from walk(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, path + (index,))


def variable_path(expression):
    kind = expression.get('expression_type')
    if kind in ('EX_InstanceVariable', 'EX_LocalVariable', 'EX_LocalOutVariable'):
        return expression.get('Variable', {}).get('New', {}).get('Path', [])
    if kind == 'EX_StructMemberContext':
        return variable_path(expression['StructExpression']) + expression['Property']['New']['Path']
    if kind == 'EX_Context':
        return variable_path(expression['ObjectExpression']) + variable_path(expression['ContextExpression'])
    return []


def camera_boundary(package):
    classes = [e for e in package['exports'] if e['type'] == 'UBlueprintGeneratedClass']
    if len(classes) != 1:
        raise ValueError('Ambiguous camera generated class')
    cls = classes[0]
    functions = [e for e in package['exports'] if e['type'] == 'UFunction']
    defaults = next(e for e in package['exports'] if e['name'] == 'Default__' + cls['name'])
    return {'class': cls['name'], 'native_parent': cls.get('SuperStruct'),
        'decoded_blueprint_function_names': [e['name'] for e in functions],
        'serialized_camera_defaults': defaults['properties'],
        'serialized_scene_components': [{'name': e['name'], 'properties': e['properties']}
            for e in package['exports'] if e['type'] == 'USceneComponent'],
        'native_camera_reconstructed': False, 'achieved_camera_transform': None,
        'scope': 'Serialized Blueprint boundary; native parent camera implementation and native constructor/runtime defaults are not present here.'}


def folded_inputs(package, default_export, functions):
    """Resolve serialized path/copy tables, without inferring native node order.

    Sparse data lives on the CDO. Handler ordinals and folded field indices
    remain separate from the engine's transient node indices.
    """
    captured = 'SerializedSparseClassData' in default_export
    sparse = default_export.get('SerializedSparseClassData')
    layouts = [{'name': e['name'], 'object_path': e.get('object_path'),
        'child_properties': e.get('ChildProperties', [])} for e in package['exports']
        if e['type'] == 'UScriptStruct' and e['name'].startswith('AnimBlueprintGenerated')]
    result = {'sparse_cdo_captured': captured, 'serialized_sparse_class_data': sparse,
        'generated_struct_layouts': layouts, 'property_copy_routes': [],
        'exposed_value_handlers': [], 'native_property_copy_executed': False,
        'native_node_array_reconstructed': False}
    if sparse is None:
        return result
    if not isinstance(sparse, dict):
        raise ValueError('Sparse animation class data is not a property object')
    library = sparse.get('AnimBlueprintExtension_PropertyAccess', {}).get('Library', {})
    segments = library.get('PathSegments', [])

    def bounded_index(value, limit, description):
        if type(value) is not int or not 0 <= value < limit:
            raise ValueError('Invalid property access ' + description)
        return value

    def path(row):
        start, count = row['PathSegmentStartIndex'], row['PathSegmentCount']
        if type(start) is not int or type(count) is not int or start < 0 or count <= 0 or start + count > len(segments):
            raise ValueError('Invalid property access segment range')
        selected = segments[start:start + count]
        return {'path_names': [s['Name'] for s in selected], 'segments': selected,
            'serialized_path': row, 'runtime_value': None}

    sources = [path(row) for row in library.get('SrcPaths', [])]
    destinations = [path(row) for row in library.get('DestPaths', [])]
    routes = result['property_copy_routes']
    for batch_index, batch in enumerate(library.get('CopyBatchArray', [])):
        for copy_index, copy in enumerate(batch['Copies']):
            access = bounded_index(copy['AccessIndex'], len(sources), 'source index')
            start, end = copy['DestAccessStartIndex'], copy['DestAccessEndIndex']
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(destinations):
                raise ValueError('Invalid property access destination range')
            routes.append({'serialized_batch_index': batch_index, 'serialized_copy_index': copy_index,
                'copy_type': copy['Type'], 'serialized_copy': copy, 'source': sources[access],
                'destinations': destinations[start:end], 'native_copy_batch_selected': False,
                'native_property_copy_executed': False})
    function_names = {f['name'] for f in functions}
    for ordinal, handler in enumerate(sparse.get('AnimBlueprintExtension_Base', {}).get('ExposedValueHandlers', [])):
        bound = handler.get('BoundFunction', 'None')
        if bound != 'None' and bound not in function_names:
            raise ValueError('Bound exposed input function is absent: ' + bound)
        copies = []
        for record in handler.get('CopyRecords', []):
            candidates = [r for r in routes if r['serialized_copy_index'] == record['CopyIndex']]
            if not candidates:
                raise ValueError('Exposed input copy index is absent from the serialized library')
            copies.append({'serialized_record': record,
                'candidate_batch_indices': [r['serialized_batch_index'] for r in candidates],
                'native_copy_batch_selected': False})
        result['exposed_value_handlers'].append({'serialized_handler_ordinal': ordinal,
            'serialized_handler': handler, 'bound_function_exists': bound != 'None',
            'property_copy_records': copies, 'native_node_index': None,
            'native_handler_executed': False})
    return result


def summarize(package):
    graphs = []
    functions = [e for e in package['exports'] if e['type'] == 'UFunction']
    for cls in package['exports']:
        if cls['type'] != 'UAnimBlueprintGeneratedClass':
            continue
        default_name = 'Default__' + cls['name']
        default_export = next(e for e in package['exports'] if e['name'] == default_name)
        defaults = default_export['properties']
        nodes = []
        for position, prop in enumerate(cls.get('ChildProperties', [])):
            struct = prop.get('Struct', {}).get('reference', '')
            if 'AnimNode_' not in struct or prop['Name'] not in defaults:
                continue
            value = defaults[prop['Name']]
            nodes.append({'property': prop['Name'], 'serialized_child_property_position': position,
                'struct': struct, 'serialized_inputs': value,
                'pose_links': sorted([{'property_path': list(p), 'link_id': n['LinkID'], 'resolved_target': None}
                    for p, n in walk(value) if 'LinkID' in n], key=lambda n: json.dumps(n['property_path'])),
                'native_node_index': None, 'native_evaluated_pose': None})
        calls, writes = [], []
        for function in functions:
            for _, expression in walk(function.get('ScriptBytecode')):
                kind = expression.get('expression_type', '')
                ref = expression.get('StackNode', {}).get('reference', '')
                if kind in ('EX_CallMath', 'EX_FinalFunction') and ref.startswith("Class'/Script/"):
                    calls.append({'function': function['name'], 'statement_index': expression['StatementIndex'],
                        'target': ref, 'expression': expression, 'native_return_value': None})
                if kind.startswith('EX_Let') and 'Variable' in expression:
                    target = variable_path(expression['Variable'])
                    if target and (target[0].startswith(('AnimGraphNode_', '__AnimBlueprintMutables'))):
                        writes.append({'function': function['name'], 'statement_index': expression['StatementIndex'],
                            'target_path': target, 'expression': expression})
        graphs.append({'class': cls['name'], 'super_struct': cls.get('SuperStruct'),
            'target_skeleton': cls['properties'].get('TargetSkeleton'),
            'generated_class_properties': cls['properties'], 'nodes': nodes,
            'native_calls': sorted(calls, key=lambda n: (n['function'], n['statement_index'])),
            'exposed_input_writes': sorted(writes, key=lambda n: (n['function'], n['statement_index'])),
            'serialized_mutable_defaults': defaults.get('__AnimBlueprintMutables'),
            'folded_inputs': folded_inputs(package, default_export, functions),
            'native_node_array_reconstructed': False, 'native_body_reconstructed': False,
            'limitations': ['Serialized ChildProperties order is not asserted to equal the transient AnimNodeProperties index.',
                'Handler ordinals and folded field entries are not asserted to be native node indices.',
                'Serialized copy routes do not establish native state values, selected batches or execution times.',
                'Folded node entries, state machine state, phase/weights, curves and native accessor returns need engine evaluation.',
                'Serialized ActualAlpha, blend weights and source mesh defaults are not achieved runtime values.']})
    if not graphs:
        raise ValueError('Referenced package has no animation generated class')
    return graphs


def inspect(args):
    binding_raw = args.bindings.read_bytes()
    body = json.loads(binding_raw)
    inventory = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    if body['mapping_sha256'] != inventory['mapping_sha256'] or body['archives'] != inventory['archives']:
        raise ValueError('Animation binding/source provenance differs')
    if digest(args.mappings.read_bytes()) != inventory['mapping_sha256']:
        raise ValueError('Installed mapping differs')
    actual = lambda: {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())} for p in args.paks.glob('*.utoc')}
    if actual() != inventory['archives']:
        raise ValueError('Installed archive inventory differs')
    packages = {CORE: [], POST: []}
    for actor, row in body['agent_classes'].items():
        for path, dep in row['mesh_and_animation_dependencies'].items():
            if dep['exports'] and any(e['type'] == 'UAnimBlueprintGeneratedClass' for e in dep['exports']):
                packages.setdefault(path, []).append({'actor_class': actor, 'bindings': dep['bindings']})
    spec = importlib.util.spec_from_file_location('animation_graph_inspector', ROOT / 'scripts/inspect-transcription-assets.py')
    inspector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inspector)
    original = inspector.value_json

    def preserve(value, depth=0):
        value = getattr(value, '__implementation__', value)
        if value is not None and hasattr(value, 'GetType'):
            name = str(value.GetType().Name)
            if depth > 24:
                raise ValueError('Animation metadata exceeds decoder depth')
            if name == 'UScriptMap':
                return {'serialized_map': [{'key': preserve(k.Value, depth+1),
                    'value': preserve(value.Properties[k].Value, depth+1)} for k in value.Properties.Keys]}
            if name.endswith('Property') and str(value.GetType().Namespace).endswith('Objects.Properties') and hasattr(value, 'Value'):
                return preserve(value.Value, depth+1)
        return original(value, depth)

    inspector.value_json = preserve
    args.aes_key = inspector.asset_map.AES
    reader, handle = inspector.asset_map.initialize(args)
    reader.ReadScriptData = True
    args.out.mkdir(parents=True, exist_ok=True)
    records = {}
    for path, users in sorted(packages.items()):
        package = inspector.package_json(reader, path)
        if package.get('error'):
            raise ValueError('Animation package decode failed: ' + path + ': ' + package['error'])
        # The common inspector omits field layouts and sparse data on the CDO.
        for obj in reader.LoadPackage(path).GetExports():
            row = next(e for e in package['exports'] if e['name'] == str(obj.Name))
            row['object_path'] = str(obj.GetPathName())
            row['export_class'] = str(obj.ExportType)
            if str(obj.GetType().Name) in ('UAnimBlueprintGeneratedClass', 'UScriptStruct'):
                row['ChildProperties'] = preserve(obj.ChildProperties)
            if str(obj.Name).startswith('Default__'):
                row['SerializedSparseClassData'] = preserve(obj.SerializedSparseClassData)
        raw = json.dumps(package, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        encoded = gzip.compress(raw, mtime=0)
        filename = digest(path.encode())[:24] + '.json.gz'
        (args.out / filename).write_bytes(encoded)
        records[path] = {'file': filename, 'sha256': digest(encoded),
            'package_bytes_sha256': digest(bytes(reader.Files[path].Read())),
            'used_by': users, 'graphs': summarize(package)}
    if actual() != inventory['archives']:
        raise ValueError('Installed archive inventory changed')
    index = {r['package']: r for r in map(json.loads, (args.source / 'index.jsonl').read_text().splitlines())}
    camera_source = index[CAMERA]
    raw = (args.source / camera_source['file']).read_bytes()
    camera_package = json.loads(gzip.decompress(raw))
    if digest(raw) != camera_source['sha256'] or camera_source['errors'] or camera_package.get('errors') or camera_package['package'] != CAMERA:
        raise ValueError('Camera source receipt differs')
    result = {'schema_version': 2, 'kind': 'serialized_animation_graph_input_evidence',
        'generator_sha256': digest(Path(__file__).read_bytes()), 'bindings_sha256': digest(binding_raw),
        'mapping_sha256': inventory['mapping_sha256'], 'archives': inventory['archives'],
        'decoder_sha256': digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()),
        'covered_replays': body['covered_replays'], 'packages': records,
        'camera_asset_boundary': {'package': CAMERA, 'source_file': camera_source['file'],
            'source_sha256': camera_source['sha256'], **camera_boundary(camera_package)},
        'native_camera_reconstructed': False,
        'native_node_array_reconstructed': False, 'native_body_reconstructed': False, 'native_visibility_verified': False}
    (args.out / 'graphs.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    graphs = [g for p in records.values() for g in p['graphs']]
    return {'packages': len(records), 'nodes': sum(len(g['nodes']) for g in graphs),
        'exposed_input_writes': sum(len(g['exposed_input_writes']) for g in graphs),
        'property_copy_routes': sum(len(g['folded_inputs']['property_copy_routes']) for g in graphs),
        'exposed_value_handlers': sum(len(g['folded_inputs']['exposed_value_handlers']) for g in graphs),
        'native_call_sites': sum(len(g['native_calls']) for g in graphs), 'native_body_reconstructed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bindings', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    parser.add_argument('--mappings', type=Path, default=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    print(json.dumps(inspect(parser.parse_args()), indent=2))
