"""Prove smoke event/timer operands and disclose unresolved clock origins.

Symbolic control-flow reachability includes both sides of every condition;
it is not a native timer scheduler and supplies no replay activation time.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

from replay_asset_model import reference_package

SMOKE = 'ShooterGame/Content/Characters/Global/Smoke/GameObject_NewSmokeZone_Parent.uasset'
GRAPH = 'ExecuteUbergraph_GameObject_NewSmokeZone_Parent'


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


def variable(node):
    return node.get('Variable', {}).get('New', {}).get('Path')


def call(node, name):
    if node.get('expression_type') not in ('EX_CallMath', 'EX_FinalFunction') or \
       node.get('StackNode', {}).get('reference') != "Class'/Script/" + name + "'":
        raise ValueError('Clock native call differs: ' + name)
    return node['Parameters']


def reachable(graph, entry):
    """Follow exact jump/push/pop operands without selecting condition values."""
    nodes = {n['StatementIndex']: n for n in graph}
    order = list(nodes)
    following = dict(zip(order, order[1:]))
    pending, states, offsets = [(0, ())], set(), set()
    while pending:
        offset, stack = pending.pop()
        if (offset, stack) in states:
            continue
        states.add((offset, stack))
        if len(states) > 20000 or len(stack) > 32:
            raise ValueError('Unbounded symbolic clock control flow')
        if offset not in nodes:
            raise ValueError('Jump targets a non-statement offset')
        offsets.add(offset)
        node = nodes[offset]
        kind = node['expression_type']
        next_offset = following.get(offset)

        def forward():
            if next_offset is None:
                raise ValueError('Missing clock control-flow fallthrough')
            pending.append((next_offset, stack))

        if kind in ('EX_Return', 'EX_EndOfScript'):
            continue
        if kind == 'EX_ComputedJump':
            if variable(node['CodeOffsetExpression']) != ['EntryPoint']:
                raise ValueError('Unresolved computed jump')
            pending.append((entry, stack))
        elif kind == 'EX_Jump':
            pending.append((node['CodeOffset'], stack))
        elif kind == 'EX_JumpIfNot':
            pending.append((node['CodeOffset'], stack))
            forward()
        elif kind == 'EX_PushExecutionFlow':
            pending.append((next_offset, stack + (node['PushingAddress'],)))
        elif kind in ('EX_PopExecutionFlow', 'EX_PopExecutionFlowIfNot'):
            if not stack:
                raise ValueError('Clock execution-flow stack underflow')
            pending.append((stack[-1], stack[:-1]))
            if kind == 'EX_PopExecutionFlowIfNot':
                forward()
        else:
            forward()
    return sorted(offsets)


def prove_smoke(package):
    exports = {e['name']: e for e in package['exports']}
    graph = exports[GRAPH]['ScriptBytecode']
    nodes = {n['StatementIndex']: n for n in graph}
    proof = []

    def node(index, kind):
        value = nodes[index]
        if value['expression_type'] != kind:
            raise ValueError('Smoke clock statement differs: ' + str(index))
        proof.append(value)
        return value

    entries = {}
    expected = {'ReceiveBeginPlay': 1555, 'Event Play Start Telegraph': 3550,
        'ExpandSmoke': 2346, 'ExpandTimeline': 3286, 'DestroySmoke': 1560,
        'Event Play End Telegraph': 3664, 'MulticastStartEndTelegraphAndDestroySmoke': 3937,
        'DefaultSmokeExpandTimeline__UpdateFunc': 3879,
        'DefaultSmokeContractTimeline__FinishedFunc': 1234}
    for name, entry in expected.items():
        code = exports[name]['ScriptBytecode']
        first = code[0]
        if first['expression_type'] != 'EX_LocalFinalFunction' or \
           first['StackNode']['reference'] != "Function'/Game/Characters/Global/Smoke/GameObject_NewSmokeZone_Parent.GameObject_NewSmokeZone_Parent_C:" + GRAPH + "'" or \
           len(first['Parameters']) != 1 or first['Parameters'][0].get('Value') != entry or \
           first['Parameters'][0]['expression_type'] != 'EX_IntConst':
            raise ValueError('Smoke event graph entry differs: ' + name)
        entries[name] = {'entry_point': entry, 'source_dispatch': first,
            'reachable_statement_indices': reachable(graph, entry),
            'achieved_dispatch_time_ms': None}

    def cast(index, target, source):
        value = node(index, 'EX_Let')
        rhs = value['Assignment']
        if variable(value['Variable']) != [target] or rhs['expression_type'] != 'EX_Cast' or \
           rhs['ConversionType']['value__'] != 3 or variable(rhs['Target']) != [source]:
            raise ValueError('Smoke timer precision/data flow differs')

    timers = []
    definitions = [(3550, 'ExpandSmoke', 3573, 'CallFunc_K2_SetTimerDelegate_Time_ImplicitCast', 'SmokeDelayTime', 3602,
                    'Event Play Start Telegraph', 'float32(SmokeDelayTime)'),
        (2480, 'DestroySmoke', 2526, 'CallFunc_K2_SetTimerDelegate_Time_ImplicitCast_2', 'CallFunc_GetSmokeDuration_Duration', 2555,
                    'ExpandSmoke', 'float32(virtual_GetSmokeDuration())'),
        (2687, 'Event Play End Telegraph', 2779, 'CallFunc_K2_SetTimerDelegate_Time_ImplicitCast_3', 'CallFunc_Subtract_DoubleDouble_ReturnValue', 2808,
                    'ExpandSmoke', 'float32(virtual_GetSmokeDuration() - SmokeEndTelegraphDuration)'),
        (3997, 'DestroySmoke', 4020, 'CallFunc_K2_SetTimerDelegate_Time_ImplicitCast_1', 'SmokeEndTelegraphDuration', 4049,
                    'MulticastStartEndTelegraphAndDestroySmoke', 'float32(SmokeEndTelegraphDuration)')]
    for bind_index, function, cast_index, target, source, timer_index, origin, expression in definitions:
        bind = node(bind_index, 'EX_BindDelegate')
        cast(cast_index, target, source)
        timer = node(timer_index, 'EX_Let')
        params = call(timer['Assignment'], 'Engine.KismetSystemLibrary:K2_SetTimerDelegate')
        if bind['FunctionName'] != function or variable(params[0]) != variable(bind['Delegate']) or \
           variable(params[1]) != [target] or params[2]['expression_type'] != 'EX_False' or \
           [p.get('Value') for p in params[3:]] != [0.0, 0.0] or len(params) != 5:
            raise ValueError('Smoke timer delegate/operands differ')
        if timer_index not in entries[origin]['reachable_statement_indices']:
            raise ValueError('Smoke timer is not reachable from claimed event')
        timers.append({'callback': function, 'source_event': origin,
            'timer_statement_index': timer_index, 'interval_expression': expression,
            'repeating': False, 'initial_start_delay': 0.0, 'initial_start_delay_variance': 0.0,
            'native_timer_schedule_ms': None, 'native_callback_time_ms': None,
            'channel_open_is_clock_origin': False})
    subtract = node(2733, 'EX_Let')
    args = call(subtract['Assignment'], 'Engine.KismetMathLibrary:Subtract_DoubleDouble')
    if variable(subtract['Variable']) != ['CallFunc_Subtract_DoubleDouble_ReturnValue'] or \
       [variable(p) for p in args] != [['CallFunc_GetSmokeDuration_Duration_2'], ['SmokeEndTelegraphDuration']]:
        raise ValueError('Smoke end-telegraph interval differs')
    for index, name in ((2503, 'CallFunc_GetSmokeDuration_Duration'), (2710, 'CallFunc_GetSmokeDuration_Duration_2')):
        value = node(index, 'EX_LocalVirtualFunction')
        if value['VirtualFunctionName'] != 'GetSmokeDuration' or [variable(p) for p in value['Parameters']] != [[name]]:
            raise ValueError('Smoke duration virtual dispatch differs')
    for index, left, right in ((2432, 'CallFunc_GetSmokeDuration_Duration_1', 0.0), (2639, 'SmokeEndTelegraphDuration', 0.0)):
        condition = node(index, 'EX_LetBool')
        params = call(condition['Assignment'], 'Engine.KismetMathLibrary:Greater_DoubleDouble')
        if variable(params[0]) != [left] or params[1].get('Value') != right:
            raise ValueError('Smoke timer enabling condition differs')
        branch = node(2470 if index == 2432 else 2677, 'EX_PopExecutionFlowIfNot')
        if variable(branch['BooleanExpression']) != variable(condition['Variable']):
            raise ValueError('Smoke timer enabling branch is disconnected')
    delay = node(1473, 'EX_LetBool')
    params = call(delay['Assignment'], 'Engine.KismetMathLibrary:Greater_DoubleDouble')
    if variable(params[0]) != ['SmokeDelayTime'] or params[1].get('Value') != 0.0:
        raise ValueError('Smoke delay enabling condition differs')
    begin_branch = node(1511, 'EX_JumpIfNot')
    if begin_branch['CodeOffset'] != 1540 or variable(begin_branch['BooleanExpression']) != variable(delay['Variable']):
        raise ValueError('Smoke delayed begin branch differs')
    for index, name in ((1525, 'Event Play Start Telegraph'), (1540, 'ExpandSmoke'), (2351, 'StartIntroLoopEffect'),
                        (2365, 'ResetSmokeScale'), (2380, 'StopSmokeContract'), (2394, 'ExpandTimeline')):
        if node(index, 'EX_LocalVirtualFunction')['VirtualFunctionName'] != name:
            raise ValueError('Smoke expansion sequence differs')
    if nodes[2365]['Parameters'][0]['expression_type'] != 'EX_True':
        raise ValueError('Smoke expansion reset differs')
    for index, duration in ((2197, 'SmokeExpandDuration'), (1642, 'SmokeContractDuration')):
        params = call(node(index, 'EX_Let')['Assignment'], 'Engine.KismetMathLibrary:Divide_DoubleDouble')
        if params[0].get('Value') != 1.0 or variable(params[1]) != [duration]:
            raise ValueError('Smoke timeline play-rate differs')
    return {'event_entries': entries, 'timers': timers, 'source_statements': proof,
        'intro_loop_dispatch_source': exports['StartIntroLoopEffect']['ScriptBytecode'],
        'authority_early_end_source': exports['AuthStartEndTelegraphAndDestroySmoke']['ScriptBytecode'],
        'timeline_requested_play_rates': {'expand': 'float32(1.0 / SmokeExpandDuration)',
            'contract': 'float32(1.0 / SmokeContractDuration)'},
        'duration_dispatch': 'Virtual GetSmokeDuration; child override and runtime property may differ.',
        'timeline_progress_ms': None, 'native_activation_time_ms': None,
        'activation_clock_verified': False,
        'limitations': ['Reachability includes both conditional paths and does not certify a branch was taken.',
            'Timer requests are relative to achieved method execution, not replay actor-channel creation.',
            'Native timer-manager time, replication delivery, FXC dispatch and render clocks remain unresolved.',
            'Timeline play rate is distinct from actual curve duration and shader coverage.']}


def build(source, model_paths):
    manifest = json.loads((source / 'manifest.json').read_bytes())
    inventory = manifest['inventory']
    index = {r['package']: r for r in map(json.loads, (source / 'index.jsonl').read_text().splitlines())}
    loaded, receipts = {}, {}

    def load(path):
        if path not in loaded:
            row = index[path]
            raw = (source / row['file']).read_bytes()
            package = json.loads(gzip.decompress(raw))
            if digest(raw) != row['sha256'] or row['errors'] or package.get('errors') or package['package'] != path:
                raise ValueError('Activation source receipt differs: ' + path)
            loaded[path] = package
            receipts[path] = {'file': row['file'], 'sha256': row['sha256']}
        return loaded[path]

    parent = prove_smoke(load(SMOKE))
    classes = set()
    for path in model_paths:
        model = json.loads(path.read_bytes())
        if model['mapping_sha256'] != inventory['mapping_sha256'] or model['archives'] != inventory['archives']:
            raise ValueError('Activation model source differs')
        classes.update(model['smoke_profiles'])
    dispatch = {}
    names = ['ReceiveBeginPlay', 'GetSmokeDuration', 'ExpandSmoke', 'ExpandTimeline', 'DestroySmoke',
        'Event Play Start Telegraph', 'Event Play End Telegraph', 'StartIntroLoopEffect']
    for cls in sorted(classes):
        path, lineage, resolved, defaults = reference_package({'reference': cls}), [], {}, {}
        while path:
            if path in lineage:
                raise ValueError('Smoke class inheritance cycle')
            lineage.append(path)
            package = load(path)
            generated = [e for e in package['exports'] if e['type'] == 'UBlueprintGeneratedClass']
            if len(generated) != 1:
                raise ValueError('Ambiguous smoke generated class')
            for export in package['exports']:
                if export['type'] == 'UFunction' and export['name'] in names and export['name'] not in resolved:
                    resolved[export['name']] = {'package': path, 'function': export['name'],
                        'bytecode': export.get('ScriptBytecode'), 'function_flags': export.get('FunctionFlags')}
                if export['name'].startswith('Default__'):
                    for key, value in export['properties'].items():
                        if key in ('SmokeDelayTime', 'SmokeDuration', 'SmokeEndTelegraphDuration', 'SmokeExpandDuration',
                                   'SmokeContractDuration', 'ExpandCurve', 'ContractCurve') and key not in defaults:
                            defaults[key] = {'value': value, 'package': path, 'export': export['name']}
            path = reference_package(generated[0].get('SuperStruct'))
        dispatch[cls] = {'lineage': lineage, 'virtual_method_sources': resolved,
            'serialized_clock_defaults': defaults,
            'parent_smoke_event_graph_in_lineage': SMOKE in lineage,
            'activation_clock_verified': False, 'native_activation_time_ms': None}
    return {'schema_version': 1, 'kind': 'source_pinned_smoke_clock_dataflow_evidence',
        'generator_sha256': digest(Path(__file__).read_bytes()),
        'source_manifest_sha256': digest((source / 'manifest.json').read_bytes()),
        'source_index_sha256': digest((source / 'index.jsonl').read_bytes()),
        'mapping_sha256': inventory['mapping_sha256'], 'archives': inventory['archives'],
        'model_receipts': [{'file': str(p.resolve()), 'sha256': digest(p.read_bytes())} for p in model_paths],
        'sources': receipts, 'parent_clock_proof': parent, 'classes': dispatch,
        'activation_clock_verified': False, 'native_shader_opacity_verified': False, 'native_visibility_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--model', type=Path, action='append', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = build(args.source, args.model)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'smoke_classes': len(report['classes']), 'source_packages': len(report['sources']),
        'proven_timer_requests': len(report['parent_clock_proof']['timers']), 'activation_clock_verified': False}))
