"""Recover conditional Slate HUD alpha and its vertex/clock dependencies.

The limited symbolic decoder never evaluates runtime values or chooses a pass.
Unsupported expressions remain unknown.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import struct

ROOT = Path(__file__).resolve().parent.parent
HUD_PARENT = 'ShooterGame/Content/VFX/BuffsDebuffs/1P_FlashBackground_main.uasset'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def signatures(assembly):
    """Read signature IDs from DXIL metadata rather than assuming table order."""
    metadata = dict(re.findall(r'^!(\d+) = !\{(.+)\}\s*$', assembly, re.M))
    root = re.search(r'^!dx\.entryPoints = !\{!(\d+)\}\s*$', assembly, re.M)
    if not root:
        raise ValueError('Expected one DXIL entry point metadata record')
    entry = re.fullmatch(r'void \(\)\* @[^,]+, !"[^\"]+", !(\d+), (?:null|!\d+), (?:null|!\d+)', metadata[root[1]])
    if not entry:
        raise ValueError('Unsupported DXIL entry point metadata layout')
    groups = re.fullmatch(r'(null|!\d+), (null|!\d+), (null|!\d+)', metadata[entry[1]])
    if not groups:
        raise ValueError('Unsupported DXIL signature metadata layout')
    result = {}
    for kind, group in zip(('inputs', 'outputs', 'patch'), groups.groups()):
        values = {}
        refs = [] if group == 'null' else re.findall(r'!(\d+)', metadata[group[1:]])
        for ref in refs:
            row = re.fullmatch(r'i32 (\d+), !"([^\"]+)", i8 (\d+), i8 (\d+), !(\d+), i8 (\d+), i32 (\d+), i8 (\d+), i32 (\d+), i8 (\d+), (null|!\d+)', metadata[ref])
            if not row:
                raise ValueError('Unsupported DXIL signature element')
            indices = re.findall(r'i32 (\d+)', metadata[row[5]])
            sid = int(row[1])
            if sid in values:
                raise ValueError('Duplicate DXIL signature ID')
            values[sid] = {'signature_id': sid, 'semantic': row[2], 'semantic_indices': list(map(int, indices)),
                'component_type': int(row[3]), 'system_value': int(row[4]), 'interpolation_code': int(row[6]),
                'rows': int(row[7]), 'columns': int(row[8]), 'start_row': int(row[9]), 'start_column': int(row[10]),
                'metadata_record': '!' + ref, 'metadata_text': metadata[ref]}
        result[kind] = values
    return result


def symbolic_output(output, assembly, resource):
    """Recognize scalar loads, Saturate, fmul, fcmp une, select and constants."""
    definitions = {v['value']: v['expression'].split(';', 1)[0].strip() for v in output['value_slice']}
    signature = signatures(assembly)
    products = module('hud_shader_products', 'build-native-widget-material-route.py').scalar_parameter_products(resource)
    unsupported = []
    active = set()

    def cbuffer_leaf(handle, slot, lane):
        annotate = re.fullmatch(r'call %dx\.types\.Handle @dx\.op\.annotateHandle\(i32 216, %dx\.types\.Handle (%\d+), %dx\.types\.ResourceProperties \{ i32 13, i32 (\d+) \}\)', definitions.get(handle, ''))
        if not annotate:
            return unknown(handle)
        bind = re.fullmatch(r'call %dx\.types\.Handle @dx\.op\.createHandleFromBinding\(i32 217, %dx\.types\.ResBind \{ i32 (\d+), i32 (\d+), i32 0, i8 2 \}, i32 (\d+), i1 false\)', definitions.get(annotate[1], ''))
        if not bind or len({bind[1], bind[2], bind[3]}) != 1:
            return unknown(handle)
        register = int(bind[1])
        reflection = re.search(r'^; (\S+)\s+cbuffer\s+NA\s+NA\s+CB\d+\s+cb' + str(register) + r'\s+1\s*$', assembly, re.M)
        if not reflection:
            return unknown(handle)
        name = reflection[1]
        block = re.search(r'^; cbuffer ' + re.escape(name) + r'\s*$(.*?)(?=^; cbuffer |^; Resource Bindings:)', assembly, re.M | re.S)
        byte_offset = slot * 16 + lane * 4
        if byte_offset + 4 > int(annotate[2]):
            raise ValueError('Compiled scalar cbuffer load is outside its reflected size')
        fields = []
        if block:
            for field in re.finditer(r'^;\s+float4 (\w+)(?:\[(\d+)\])?;\s+; Offset:\s+(\d+)\s*$', block[1], re.M):
                count, offset = int(field[2] or 1), int(field[3])
                if offset <= byte_offset < offset + 16 * count:
                    index = (byte_offset - offset) // 16
                    field_lane = (byte_offset - offset) % 16 // 4
                    fields.append(field[1] + (f'[{index}]' if field[2] else '') + '.' + 'xyzw'[field_lane])
        matches = [p for p in products if name == 'UniformBufferConstants_Material' and p['field']['BufferOffset'] == slot * 4 + lane]
        return {'operation': 'cbuffer_scalar', 'register': register, 'name': name, 'float4_slot': slot, 'lane': lane,
            'reflected_field': fields[0] if len(fields) == 1 else None,
            'matching_serialized_scalar_products': matches, 'runtime_value': None, 'native_uniform_binding_verified': False}

    def unknown(value):
        unsupported.append({'value': value, 'expression': definitions.get(value)})
        return {'operation': 'unknown', 'value': value, 'runtime_value': None}

    def decode(value):
        if value in active:
            raise ValueError('Cyclic scalar shader slice')
        if not value.startswith('%'):
            try:
                literal = struct.unpack('>d', bytes.fromhex(value[2:]))[0] if re.fullmatch(r'0x[0-9A-Fa-f]{16}', value) else float(value)
                float32 = struct.unpack('<f', struct.pack('<f', literal))[0]
                if not math.isfinite(float32) or (value.startswith('0x') and float32 != literal):
                    return unknown(value)
                return {'operation': 'literal_float32', 'serialized_literal': value, 'value': float32}
            except (ValueError, OverflowError, struct.error):
                return unknown(value)
        active.add(value)
        try:
            expr = definitions.get(value, '')
            match = re.fullmatch(r'extractvalue %dx\.types\.CBufRet\.f32 (%\d+), ([0-3])', expr)
            if match:
                load = re.fullmatch(r'call %dx\.types\.CBufRet\.f32 @dx\.op\.cbufferLoadLegacy\.f32\(i32 59, %dx\.types\.Handle (%\d+), i32 (\d+)\)', definitions.get(match[1], ''))
                if load:
                    return cbuffer_leaf(load[1], int(load[2]), int(match[2]))
            match = re.fullmatch(r'call float @dx\.op\.loadInput\.f32\(i32 4, i32 (\d+), i32 (\d+), i8 ([0-3]), i32 undef\)', expr)
            if match:
                sid, row, component = map(int, match.groups())
                sig = signature['inputs'].get(sid)
                if not sig or row >= sig['rows'] or component >= sig['columns']:
                    raise ValueError('Scalar shader input is outside its signature')
                return {'operation': 'interpolated_input', 'signature': sig, 'row': row, 'component': component, 'runtime_value': None}
            match = re.fullmatch(r'call float @dx\.op\.unary\.f32\(i32 7, float (%\d+)\)', expr)
            if match:
                return {'operation': 'saturate', 'operand': decode(match[1])}
            match = re.fullmatch(r'fmul( fast)? float ([^,]+), (.+)', expr)
            if match:
                return {'operation': 'fmul', 'fast_math': bool(match[1]), 'operands': [decode(match[2]), decode(match[3])]}
            match = re.fullmatch(r'fcmp( fast)? une float ([^,]+), (.+)', expr)
            if match:
                return {'operation': 'fcmp_une', 'fast_math': bool(match[1]), 'operands': [decode(match[2]), decode(match[3])]}
            match = re.fullmatch(r'select i1 (%\d+), float ([^,]+), float (.+)', expr)
            if match:
                return {'operation': 'select', 'condition': decode(match[1]), 'if_true': decode(match[2]), 'if_false': decode(match[3])}
            return unknown(value)
        finally:
            active.remove(value)

    tree = decode(output['value'])
    out_sig = signature['outputs'].get(output['output_signature_id'])
    if not out_sig or output['row'] >= out_sig['rows'] or output['component'] >= out_sig['columns']:
        raise ValueError('Scalar shader output is outside its signature')
    return {'output_signature': out_sig, 'row': output['row'], 'component': output['component'],
        'symbolic_value_tree': tree, 'unsupported_expressions': unsupported,
        'decoded_scalar_value_flow': not unsupported, 'control_flow_evaluated': False, 'runtime_value': None}


def build(args):
    inputs = {key: json.loads(path.read_bytes()) for key, path in
        (('materials', args.materials), ('shaders', args.shaders), ('variants', args.variants), ('widget', args.widget_route))}
    materials, shaders, variants, widget = (inputs[k] for k in ('materials', 'shaders', 'variants', 'widget'))
    if variants['materials_sha256'] != digest(args.materials.read_bytes()) or shaders['materials_sha256'] != digest(args.materials.read_bytes()) or \
       widget['materials_sha256'] != digest(args.materials.read_bytes()) or widget['shaders_sha256'] != digest(args.shaders.read_bytes()) or \
       any(r['mapping_sha256'] != materials['mapping_sha256'] or r['archives'] != materials['archives'] for r in inputs.values()):
        raise ValueError('HUD shader sources differ')
    helper = module('hud_shader_slices', 'inspect-native-shader-inputs.py')
    resources = {}
    for export in materials['materials'][HUD_PARENT]['exports']:
        for resource in export['shader_maps']:
            if resource['platform'] != 'SP_PCD3D_SM6':
                continue
            rh = resource['resource_hash']
            selected = []
            vertex = []
            for variant in variants['resources'][rh]['variants']:
                name = variant['shader_type_label']['name']
                if name != 'TSlateMaterialShaderPSDefault' and not name.startswith('TSlateMaterialShaderVS'):
                    continue
                program = shaders['shaders'][variant['shader_hash']]
                assembly_raw = (args.shaders.parent / program['file']).read_bytes()
                if digest(assembly_raw) != program['sha256']:
                    raise ValueError('HUD shader disassembly receipt differs')
                assembly = assembly_raw.decode('utf-8')
                slice_report = helper.alpha_inputs(assembly, variant['target']['frequency'] == 'SF_Pixel')
                if any(slice_report[k] != program[k] for k in slice_report):
                    raise ValueError('HUD shader input slices differ')
                if name == 'TSlateMaterialShaderPSDefault':
                    outputs = [symbolic_output(o, assembly, resource) for o in program['alpha_outputs']]
                    selected.append({'variant': variant, 'disassembly_sha256': program['sha256'], 'outputs': outputs,
                        'branch_instructions': program['branch_instructions'], 'runtime_shader_selected': False})
                else:
                    sig = signatures(assembly)
                    outputs = [o for o in program['non_pixel_component3_outputs']
                        if sig['outputs'][o['output_signature_id']]['semantic'] == 'COLOR' and
                            sig['outputs'][o['output_signature_id']]['semantic_indices'] == [0]]
                    if len(outputs) != 1:
                        raise ValueError('Slate vertex COLOR0 alpha output coverage differs')
                    vertex.append({'variant': variant, 'disassembly_sha256': program['sha256'],
                        'color_alpha_output': symbolic_output(outputs[0], assembly, resource),
                        'runtime_shader_selected': False})
            if len(selected) != 1 or len(vertex) != 2:
                raise ValueError('Slate default/vertex variant coverage differs')
            resources[rh] = {'platform': resource['platform'], 'slate_default_pixel_paths': selected,
                'slate_vertex_color_alpha_paths': vertex,
                'earlier_direct_alpha_shader_variants': [v for v in variants['resources'][rh]['variants']
                    if v['shader_hash'] in {r['shader_hash'] for r in shaders['resources'][rh]['compiled_direct_alpha_routes']}]}
    return {'schema_version': 1, 'kind': 'conditional_slate_hud_shader_value_paths',
        'generator_sha256': digest(Path(__file__).read_bytes()),
        'helper_sha256': {f: digest((ROOT / 'scripts' / f).read_bytes()) for f in
            ('inspect-native-shader-inputs.py', 'build-native-widget-material-route.py')},
        'source_sha256': {k: digest(p.read_bytes()) for k, p in (('materials', args.materials), ('shaders', args.shaders),
            ('variants', args.variants), ('widget', args.widget_route))},
        'mapping_sha256': materials['mapping_sha256'], 'archives': materials['archives'], 'hud_parent_package': HUD_PARENT,
        'resources': resources, 'widget_scalar_and_clock_proof': widget['widget_route']['scalar_and_clock_proof'],
        'required_runtime_inputs': ['selected HUD/material/shader pass', 'Alpha_ColorMult after native blind accessor and engine timer callbacks',
            'GlobalAlpha on the achieved dynamic material instance', 'Slate vertex COLOR0.w', '$Globals.DrawFlags.x',
            'actual blend/render state and render submission time'],
        'clock_requirements': {'widget_engine_time': None, 'native_blind_transition_time': None, 'native_timer_callback_time': None,
            'render_submission_time': None, 'replay_to_engine_time_transform': None,
            'scope': 'The widget updates a material scalar from engine time and native blind state; shader, vertex and render inputs remain required at render submission.'},
        'native_shader_opacity_verified': False, 'runtime_parameter_binding_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'references': ['https://github.com/microsoft/DirectXShaderCompiler/blob/main/docs/DXIL.rst',
            'https://llvm.org/docs/LangRef.html#fcmp-instruction'],
        'limitations': ['Symbolic compiled output is not achieved or composited opacity.',
            'The default Slate path is identified as a cooked variant, not asserted to be the selected native replay path.',
            'These two compiled Slate vertex variants pass ATTRIBUTE3.w to COLOR0.w; the native vertex stream and CPU-produced value are unknown.',
            'Fast-math flags and fcmp une/select remain serialized operations, not evaluated clock/visibility assumptions.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('materials', 'shaders', 'variants', 'widget-route', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    report = build(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'hud_resources': len(report['resources']), 'native_visibility_verified': False}))


if __name__ == '__main__':
    main()
