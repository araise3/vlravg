"""Disassemble recovered DXIL and disclose pixel-alpha input dependencies.

This is compiled value-flow evidence. It does not select a runtime shader,
execute its control flow, resolve uniforms, or certify composited opacity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SSA = re.compile(r'%[-a-zA-Z$._0-9]+')
ALPHA = re.compile(r'call void @dx\.op\.storeOutput\.f32\(i32 5, i32 (\d+), i32 (\d+), i8 3, float ([^\)]+)\)')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def alpha_inputs(assembly, pixel_shader=True):
    """Return exact SSA slices, keeping branch/control and resource inputs open."""
    bodies = re.findall(r'^define void @([-a-zA-Z$._0-9]+)\(\)\s*\{\s*$(.*?)^\}', assembly, re.M | re.S)
    if len(bodies) != 1:
        raise ValueError('Expected one decoded zero-argument void shader entry point')
    entry_point, body = bodies[0]
    labels = set(re.findall(r'^\s*; <label>:(\d+)', body, re.M))
    labels.update(re.findall(r'^\s*(\d+):', body, re.M))
    labels.update(re.findall(r'label %(\d+)', body))
    # Phi incoming pairs contain a value followed by a predecessor block,
    # including the implicit entry block, which has no printed label header.
    labels.update(re.findall(r'\[\s*[^,\]\n]+,\s*%(\d+)\s*\]', body))
    definitions, outputs, branches = {}, [], []
    for line in body.splitlines():
        line = line.strip()
        match = re.match(r'(%[-a-zA-Z$._0-9]+) = (.+)', line)
        if match:
            if match[1] in definitions:
                raise ValueError('Duplicate SSA definition')
            definitions[match[1]] = match[2]
        if line.startswith(('br ', 'switch ', 'indirectbr ')):
            branches.append(line)
        match = ALPHA.search(line)
        if match:
            outputs.append((int(match[1]), int(match[2]), match[3].strip(), line))
    results = []
    for signature, row, value, instruction in outputs:
        seen, pending = set(), [value] if value.startswith('%') else []
        unresolved = set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            if name not in definitions:
                unresolved.add(name)
                continue
            seen.add(name)
            expression = definitions[name].split(';', 1)[0]
            # Named LLVM type tokens also start with %. Only value definitions
            # are edges; numeric tokens with no definition remain explicit gaps.
            for token in SSA.findall(expression):
                if token in definitions:
                    pending.append(token)
                elif token[1:].isdigit() and token[1:] not in labels:
                    unresolved.add(token)
        selected = [{'value': name, 'expression': expression} for name, expression in definitions.items() if name in seen]
        results.append({'output_signature_id': signature, 'row': row, 'component': 3,
            'value': value, 'store_instruction': instruction, 'value_slice': selected,
            'unresolved_ssa_values': sorted(unresolved),
            'input_operations': [n for n in selected if any(x in n['expression'] for x in
                ('@dx.op.cbufferLoad', '@dx.op.loadInput', '@dx.op.sample', '@dx.op.textureLoad', '@dx.op.bufferLoad'))],
            'control_flow_evaluated': False, 'runtime_value': None})
    return {'entry_point': entry_point, 'alpha_outputs': results if pixel_shader else [],
        'non_pixel_component3_outputs': [] if pixel_shader else results, 'branch_instructions': branches,
        'scope': 'Value dependencies for f32 output component 3; all control flow, signature interpretation and blending remain unresolved.'}


def direct_parameters(resource):
    """Decode only one known cooked preshader instruction: Parameter(u16)."""
    uniform = resource['content']['MaterialCompilationOutput']['UniformExpressionSet']
    data = uniform['UniformPreshaderData']
    parameters = uniform['UniformNumericParameters']
    fields = uniform['UniformPreshaderFields']
    result = []
    if data.get('bPreshader2'):
        return result
    for header in uniform['UniformPreshaders']:
        offset, size = header['OpcodeOffset'], header['OpcodeSize']
        code = data['Data'][offset:offset + size]
        if header['NumFields'] != 1 or size != 3 or len(code) != 3 or code[0] != 3:
            continue
        index = code[1] | code[2] << 8
        if index >= len(parameters) or header['FieldIndex'] >= len(fields):
            raise ValueError('Invalid cooked Parameter preshader operand')
        field = fields[header['FieldIndex']]
        result.append({'parameter_index': index, 'parameter': parameters[index],
            'header': header, 'field': field, 'serialized_opcode_bytes': code,
            'runtime_parameter_value': None,
            'scope': 'Direct cooked uniform parameter field; runtime override and shader register binding are unresolved.'})
    return result


def direct_alpha_route(output, assembly):
    """Recognize an exact saturate(cbuffer[constant].lane) SSA chain only."""
    definitions = {n['value']: n['expression'].split(';', 1)[0].strip() for n in output['value_slice']}
    expression = definitions.get(output['value'], '')
    clamp = re.fullmatch(r'call float @dx\.op\.unary\.f32\(i32 7, float (%\d+)\)', expression)
    if not clamp:
        return None
    extract = re.fullmatch(r'extractvalue %dx\.types\.CBufRet\.f32 (%\d+), ([0-3])', definitions.get(clamp[1], ''))
    if not extract:
        return None
    load = re.fullmatch(r'call %dx\.types\.CBufRet\.f32 @dx\.op\.cbufferLoadLegacy\.f32\(i32 59, %dx\.types\.Handle (%\d+), i32 (\d+)\)', definitions.get(extract[1], ''))
    if not load:
        return None
    annotate = re.fullmatch(r'call %dx\.types\.Handle @dx\.op\.annotateHandle\(i32 216, %dx\.types\.Handle (%\d+), %dx\.types\.ResourceProperties \{ i32 13, i32 \d+ \}\)', definitions.get(load[1], ''))
    if not annotate:
        return None
    bind = re.fullmatch(r'call %dx\.types\.Handle @dx\.op\.createHandleFromBinding\(i32 217, %dx\.types\.ResBind \{ i32 (\d+), i32 (\d+), i32 0, i8 2 \}, i32 (\d+), i1 false\)', definitions.get(annotate[1], ''))
    if not bind or len({bind[1], bind[2], bind[3]}) != 1:
        return None
    register, slot, lane = int(bind[1]), int(load[2]), int(extract[2])
    reflection = re.search(r'^; (\S+)\s+cbuffer\s+NA\s+NA\s+CB\d+\s+cb' + str(register) + r'\s+1\s*$', assembly, re.M)
    if not reflection:
        return None
    return {'output_signature_id': output['output_signature_id'], 'row': output['row'],
        'cbuffer_register': register, 'reflected_cbuffer_name': reflection[1],
        'float4_slot': slot, 'lane': lane, 'formula': f'saturate(cb{register}[{slot}].{"xyzw"[lane]})',
        'control_flow_evaluated': False, 'runtime_value': None,
        'scope': 'Exact compiled store value; selected permutation, dispatch and compositing remain unresolved.'}


def inspect(args):
    material_bytes = args.materials.read_bytes()
    source = json.loads(material_bytes)
    if source['generator_sha256'] != digest((ROOT / 'scripts/inspect-native-visibility-materials.py').read_bytes()):
        raise ValueError('Stale material evidence generator')
    tool = {'executable': str(args.dxc.resolve()), 'sha256': digest(args.dxc.read_bytes()),
        'companions': {name: digest((args.dxc.parent / name).read_bytes()) for name in ('dxcompiler.dll', 'dxil.dll')}}
    args.out.mkdir(parents=True, exist_ok=True)
    shaders = {}
    for matches in source['shader_map_matches'].values():
        for match in matches:
            for shader in match['shaders']:
                if 'DXIL' not in shader['chunks']:
                    continue
                path = args.materials.parent / shader['compiled_file']
                if digest(path.read_bytes()) != shader['compiled_sha256']:
                    raise ValueError('Compiled shader receipt differs')
                key = shader['shader_hash']
                if key in shaders:
                    continue
                result = subprocess.run([str(args.dxc), '-dumpbin', str(path)], capture_output=True, check=True, timeout=30)
                assembly = result.stdout.decode('utf-8')
                flow = alpha_inputs(assembly, shader['frequency'] == 'SF_Pixel')
                flow['direct_alpha_routes'] = [route for output in flow['alpha_outputs']
                    if (route := direct_alpha_route(output, assembly)) is not None]
                out = args.out / (key + '.dxil.txt')
                out.write_bytes(result.stdout)
                shaders[key] = {'compiled_file': str(path.resolve()), 'compiled_sha256': shader['compiled_sha256'],
                    'frequency': shader['frequency'], 'file': out.name, 'sha256': digest(result.stdout),
                    'diagnostics': result.stderr.decode('utf-8'), **flow}
    resources = {}
    for package, item in source['materials'].items():
        for export in item['exports']:
            for resource in export['shader_maps']:
                definition = {
                    'platform': resource['platform'], 'direct_uniform_parameters': direct_parameters(resource),
                    'shader_hashes': sorted({s['shader_hash'] for m in source['shader_map_matches'][resource['resource_hash']] for s in m['shaders']}),
                    'runtime_shader_selected': False}
                if resource['resource_hash'] in resources:
                    current = resources[resource['resource_hash']]
                    if any(current[key] != value for key, value in definition.items()):
                        raise ValueError('Shared shader resource has inconsistent uniform metadata')
                    current['owners'].append({'package': package, 'export': export['name']})
                    continue
                resources[resource['resource_hash']] = {**definition,
                    'owners': [{'package': package, 'export': export['name']}]}
                routes = []
                for shader_hash in resources[resource['resource_hash']]['shader_hashes']:
                    for route in shaders.get(shader_hash, {}).get('direct_alpha_routes', []):
                        fields = [p for p in resources[resource['resource_hash']]['direct_uniform_parameters']
                            if route['reflected_cbuffer_name'] == 'UniformBufferConstants_Material' and
                            p['field']['Type']['value__'] == 1 and p['field']['BufferOffset'] == route['float4_slot'] * 4 + route['lane']]
                        routes.append({'shader_hash': shader_hash, **route,
                            'matching_serialized_scalar_fields': fields,
                            'native_uniform_binding_verified': False})
                resources[resource['resource_hash']]['compiled_direct_alpha_routes'] = routes
    report = {'schema_version': 1, 'kind': 'compiled_pixel_alpha_input_evidence',
        'generator_sha256': digest(Path(__file__).read_bytes()),
        'materials_sha256': digest(material_bytes), 'mapping_sha256': source['mapping_sha256'],
        'archives': source['archives'], 'disassembler': tool, 'shaders': shaders, 'resources': resources,
        'native_shader_opacity_verified': False, 'runtime_parameter_binding_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'limitations': ['SSA value slices do not execute branches, phi nodes, texture sampling or compositing.',
            'Output signature IDs and component 3 do not alone establish a composited alpha channel.',
            'Runtime shader permutation, uniform overrides, UI opacity and blend state remain unknown.']}
    (args.out / 'inputs.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return {'shaders': len(shaders), 'pixel_shaders': sum(s['frequency'] == 'SF_Pixel' for s in shaders.values()),
        'alpha_output_stores': sum(len(s['alpha_outputs']) for s in shaders.values()),
        'unresolved_ssa_values': sum(len(o['unresolved_ssa_values']) for s in shaders.values() for o in s['alpha_outputs']),
        'native_visibility_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--materials', type=Path, required=True)
    parser.add_argument('--dxc', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    print(json.dumps(inspect(parser.parse_args()), indent=2))
