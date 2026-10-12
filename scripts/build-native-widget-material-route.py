"""Prove the serialized HUD instance -> dynamic material -> image/scalar route."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

from replay_asset_model import reference_package

ROOT = Path(__file__).resolve().parent.parent
WIDGET = 'ShooterGame/Content/UI/InGame/HUD/BlindsDrivenMaterialOverlay.uasset'
OWNERS = ('ShooterGame/Content/UI/InGame/HUD/FirstPersonHUD.uasset',
    'ShooterGame/Content/UI/InGame/HUD/BroadcastHUD.uasset')
GRAPH = 'ExecuteUbergraph_BlindsDrivenMaterialOverlay'
OPCODE_REFERENCE = 'https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/Shader/UE__Shader__EPreshaderOpcode?application_version=5.5'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def scalar_parameter_products(resource):
    """Recognize Parameter(u16), Parameter(u16), Mul; keep all values symbolic."""
    uniform = resource['content']['MaterialCompilationOutput']['UniformExpressionSet']
    data = uniform['UniformPreshaderData']
    if data.get('bPreshader2'):
        return []
    parameters, fields, products = uniform['UniformNumericParameters'], uniform['UniformPreshaderFields'], []
    for header in uniform['UniformPreshaders']:
        start, size = header['OpcodeOffset'], header['OpcodeSize']
        code = data['Data'][start:start + size]
        if header['NumFields'] != 1 or size != 7 or len(code) != 7 or (code[0], code[3], code[6]) != (3, 3, 6):
            continue
        indices = [code[1] | code[2] << 8, code[4] | code[5] << 8]
        if any(i >= len(parameters) for i in indices) or not 0 <= header['FieldIndex'] < len(fields):
            raise ValueError('Invalid scalar product preshader operand')
        operands = [parameters[i] for i in indices]
        field = fields[header['FieldIndex']]
        if any(p['ParameterType']['value__'] != 0 for p in operands) or field['Type']['value__'] != 1:
            continue
        products.append({'operation': 'Mul', 'parameter_indices': indices, 'parameters': operands,
            'field': field, 'header': header, 'serialized_opcode_bytes': code,
            'symbolic_formula': ' * '.join(p['ParameterInfo']['Name'] for p in operands),
            'runtime_value': None, 'native_uniform_binding_verified': False})
    return products


def resource_routes(resource, shader_resource):
    products = scalar_parameter_products(resource)
    routes = []
    for route in shader_resource['compiled_direct_alpha_routes']:
        matches = [p for p in products if route['reflected_cbuffer_name'] == 'UniformBufferConstants_Material'
            and p['field']['BufferOffset'] == route['float4_slot'] * 4 + route['lane']]
        routes.append({**route, 'matching_serialized_scalar_products': matches,
            'conditional_parameter_formula': 'saturate(' + matches[0]['symbolic_formula'] + ')' if len(matches) == 1 else None})
    return {'resource_hash': resource['resource_hash'], 'platform': resource['platform'],
        'direct_uniform_parameters': shader_resource['direct_uniform_parameters'],
        'shader_hashes': shader_resource['shader_hashes'], 'scalar_parameter_products': products,
        'compiled_direct_alpha_routes': routes, 'runtime_shader_selected': False}


def prove_widget(package, owners):
    clocks = module('widget_route_clock_flow', 'build-native-activation-clocks.py')
    bindings = module('widget_route_scalar_flow', 'build-native-visibility-bindings.py')
    exports = {e['name']: e for e in package['exports']}
    graph = exports[GRAPH]['ScriptBytecode']
    nodes = {n['StatementIndex']: n for n in graph}
    entry = exports['Construct']['ScriptBytecode'][0]
    if entry['expression_type'] != 'EX_LocalFinalFunction' or entry['Parameters'][0].get('Value') != 499 or \
       entry['StackNode']['reference'] != "Function'/Game/UI/InGame/HUD/BlindsDrivenMaterialOverlay.BlindsDrivenMaterialOverlay_C:" + GRAPH + "'":
        raise ValueError('Widget construct entry differs')
    reached = clocks.reachable(graph, 499)
    if any(i not in reached for i in (614, 643, 658, 703, 722)):
        raise ValueError('Widget material route is disconnected from Construct')
    valid, branch, create, assign, image = (nodes[i] for i in (614, 643, 658, 703, 722))
    params = bindings.call(valid['Assignment'], 'Engine.KismetSystemLibrary:IsValid')
    if [bindings.variable(p) for p in params] != [['MaterialInstance']] or \
       branch['expression_type'] != 'EX_JumpIfNot' or branch['CodeOffset'] != 658 or \
       bindings.variable(branch['BooleanExpression']) != bindings.variable(valid['Variable']):
        raise ValueError('Widget material reuse/create condition differs')
    params = bindings.call(create['Assignment'], 'Engine.KismetMaterialLibrary:CreateDynamicMaterialInstance')
    if create['expression_type'] != 'EX_LetObj' or len(params) != 4 or params[0]['expression_type'] != 'EX_Self' or \
       bindings.variable(params[1]) != ['BaseMaterial'] or params[2].get('Value') != 'None' or params[3].get('Value') != 0 or \
       assign['expression_type'] != 'EX_LetObj' or bindings.variable(assign['Variable']) != ['MaterialInstance'] or \
       bindings.variable(assign['Assignment']) != bindings.variable(create['Variable']):
        raise ValueError('Widget dynamic material input/storage differs')
    call = image['ContextExpression']
    if image['expression_type'] != 'EX_Context' or bindings.variable(image['ObjectExpression']) != ['OverlayImage'] or \
       call['expression_type'] != 'EX_VirtualFunction' or call['VirtualFunctionName'] != 'SetBrushFromMaterial' or \
       [bindings.variable(p) for p in call['Parameters']] != [['MaterialInstance']]:
        raise ValueError('Widget image brush route differs')
    instances = []
    for owner in owners:
        for export in owner['exports']:
            if export.get('export_class') != 'BlindsDrivenMaterialOverlay_C':
                continue
            properties = export['properties']
            material = reference_package(properties.get('BaseMaterial'))
            if material is None:
                raise ValueError('HUD widget instance lacks its material default')
            instances.append({'owner_package': owner['package'], 'object_path': export['object_path'],
                'serialized_instance_properties': properties, 'base_material_package': material,
                'native_hud_selected': False, 'runtime_material_instance': None})
    if len(instances) != len(owners):
        raise ValueError('HUD blind overlay instance coverage differs')
    proof = [valid, branch, create, assign, image]
    return {'widget_package': WIDGET, 'construct_entry_point': 499,
        'construct_reachable_statements': reached, 'creation_condition': 'native IsValid(MaterialInstance) is false',
        'serialized_hud_instances': instances,
        'dynamic_material_route': 'HUD instance BaseMaterial -> CreateDynamicMaterialInstance -> MaterialInstance -> OverlayImage.SetBrushFromMaterial',
        'image_serialized_brush': exports['OverlayImage']['properties'].get('Brush'),
        'proof_statements': [n['StatementIndex'] for n in proof],
        'proof_sha256': bindings.object_hash(proof), 'scalar_and_clock_proof': bindings.prove_flash_material(package),
        'runtime_parameter_binding_verified': False, 'native_shader_opacity_verified': False,
        'activation_clock_verified': False}


def build(args):
    index = {r['package']: r for r in map(json.loads, (args.source / 'index.jsonl').read_text().splitlines())}
    inventory = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    receipts, packages = {}, {}
    for path in (WIDGET, *OWNERS):
        receipt = index[path]
        raw = (args.source / receipt['file']).read_bytes()
        package = json.loads(gzip.decompress(raw))
        if digest(raw) != receipt['sha256'] or receipt['errors'] or package.get('errors') or package['package'] != path:
            raise ValueError('Widget material source receipt differs')
        receipts[path] = {k: receipt[k] for k in ('file', 'sha256')}
        packages[path] = package
    materials_raw, shaders_raw = args.materials.read_bytes(), args.shaders.read_bytes()
    materials, shaders = json.loads(materials_raw), json.loads(shaders_raw)
    if shaders['materials_sha256'] != digest(materials_raw) or any(r['mapping_sha256'] != inventory['mapping_sha256'] or
        r['archives'] != inventory['archives'] for r in (materials, shaders)):
        raise ValueError('Widget material/shader provenance differs')
    proof = prove_widget(packages[WIDGET], [packages[p] for p in OWNERS])
    routes = {}
    for instance in proof['serialized_hud_instances']:
        path = instance['base_material_package']
        if path in routes:
            continue
        pending, seen, lineage = [path], set(), []
        while pending:
            current = pending.pop(0)
            if current in seen:
                raise ValueError('HUD widget material inheritance cycle or ambiguous parent')
            seen.add(current)
            exports = materials['materials'][current]['exports']
            if not exports:
                raise ValueError('HUD widget material lineage was not decoded')
            for e in exports:
                if e['parent_package']:
                    pending.append(e['parent_package'])
                lineage.append({'package': current, 'export': e['name'], 'serialized_properties': e['properties'],
                    'parent_package': e['parent_package'],
                    'compiled_resources': [resource_routes(r, shaders['resources'][r['resource_hash']]) for r in e['shader_maps']]})
        routes[path] = lineage
    return {'schema_version': 1, 'kind': 'serialized_hud_widget_material_route',
        'generator_sha256': digest(Path(__file__).read_bytes()),
        'proof_helper_sha256': {f: digest((ROOT / 'scripts' / f).read_bytes())
            for f in ('build-native-activation-clocks.py', 'build-native-visibility-bindings.py')},
        'mapping_sha256': inventory['mapping_sha256'], 'archives': inventory['archives'],
        'source_receipts': receipts, 'materials_sha256': digest(materials_raw), 'shaders_sha256': digest(shaders_raw),
        'preshader_opcode_reference': OPCODE_REFERENCE,
        'widget_route': proof, 'material_routes': routes,
        'runtime_parameter_binding_verified': False, 'native_shader_opacity_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'limitations': ['HUD template defaults establish a serialized route, not the HUD selected for a replay.',
            'Runtime material reuse/overrides, widget render opacity, selected permutation and native blind/time accessors remain unknown.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'materials', 'shaders', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    result = build(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'hud_instances': len(result['widget_route']['serialized_hud_instances']),
        'base_materials': len(result['material_routes']), 'native_visibility_verified': False}))
