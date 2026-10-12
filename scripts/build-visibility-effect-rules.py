"""Bind conditional effect fade windows to verified cached Blueprint source.

This does not execute native effect/shader code. It proves which asset StopEffect
implementation and serialized duration a conditional preview window uses.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
from replay_asset_model import reference_package

CORE = 'ShooterGame/Content/Characters/_Core/FXC_Blinded_Shared.uasset'
NEAR = 'ShooterGame/Content/Characters/Global/FXC/FXC_Global_NearsightDebuff.uasset'
WIDGET = 'ShooterGame/Content/UI/InGame/HUD/BlindsDrivenMaterialOverlay.uasset'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def variable(expression):
    return expression.get('Variable', {}).get('New', {}).get('Path')


def require_node(graph, index, kind, predicate=lambda node: True):
    row = next((n for n in graph if n.get('StatementIndex') == index), None)
    if not row or row.get('expression_type') != kind or not predicate(row):
        raise ValueError(f'Fade rule proof differs at statement {index}: {kind}')
    return row


def prove_root(package, kind, widget=None):
    """Check executable operands, rather than only matching field names."""
    exports = {e['name']: e for e in package['exports']}
    graph = next(e['ScriptBytecode'] for e in package['exports'] if e['name'].startswith('ExecuteUbergraph_'))
    stop = exports['StopEffect']['ScriptBytecode']
    entry = 3346 if kind == 'flash' else 1356
    if not any(n.get('expression_type') == 'EX_IntConst' and n.get('Value') == entry for n in walk(stop)):
        raise ValueError('StopEffect wrapper does not invoke expected graph entry')
    if kind == 'flash':
        proof = [require_node(graph, 3346, 'EX_LocalFinalFunction', lambda n:
            n['StackNode']['reference'].endswith("EffectContainer:StopEffect'")),
            require_node(graph, 3365, 'EX_Jump', lambda n: n['CodeOffset'] == 3077),
            require_node(graph, 3077, 'EX_PushExecutionFlow', lambda n: n['PushingAddress'] == 3087),
            require_node(graph, 3082, 'EX_Jump', lambda n: n['CodeOffset'] == 3033),
            require_node(graph, 3072, 'EX_Jump', lambda n: n['CodeOffset'] == 2876)]
        binding = require_node(graph, 2887, 'EX_Let')
        context = binding['Assignment']['Target']
        if variable(context['ObjectExpression']) != ['BuffMaterialOverlay'] or variable(context['ContextExpression']) != ['AttributeFadeTime']:
            raise ValueError('Flash AddTailTime is not bound to overlay AttributeFadeTime')
        call = require_node(graph, 2938, 'EX_FinalFunction', lambda n:
            n['StackNode']['reference'].endswith("EffectContainer:AddTailTime'"))
        if variable(call['Parameters'][0]) != variable(binding['Variable']):
            raise ValueError('Flash tail call does not use verified duration binding')
        default = next(e['properties'] for e in widget['exports'] if e['name'].startswith('Default__'))
        value = default['AttributeFadeTime']
        widget_graph = next(e['ScriptBytecode'] for e in widget['exports'] if e['name'].startswith('ExecuteUbergraph_'))
        # Actual overlay opacity still depends on two unbound native accessors.
        for index, method in [(1945, 'IsBlinded'), (2126, 'GetTimeSinceLastBlindedChange')]:
            require_node(widget_graph, index, 'EX_LetBool' if method == 'IsBlinded' else 'EX_Let', lambda n:
                any(c.get('StackNode', {}).get('reference', '').endswith('BlindManagerComponent:' + method + "'") for c in walk(n)))
        proof += [binding, call]
        return {'rule_id': 'shared_flash_overlay_attribute_fade', 'duration_field': 'AttributeFadeTime',
                'duration_source_package': WIDGET, 'duration_seconds': value,
                'conditions': ['Valid BuffMaterialOverlay instance', 'Inherited shared StopEffect dispatch',
                               'Serialized widget duration remains unchanged'],
                'unbound_native_accessors': ['BlindManagerComponent.IsBlinded', 'BlindManagerComponent.GetTimeSinceLastBlindedChange'],
                'proof_statements': [n['StatementIndex'] for n in proof], 'proof_sha256': digest(json.dumps(proof, sort_keys=True).encode())}
    proof = [require_node(graph, 1386, 'EX_LocalVirtualFunction', lambda n: n['VirtualFunctionName'] == 'Nearsight Fade Out')]
    fade = exports['Nearsight Fade Out']['ScriptBytecode']
    if not any(n.get('expression_type') == 'EX_IntConst' and n.get('Value') == 1526 for n in walk(fade)):
        raise ValueError('Nearsight Fade Out wrapper differs')
    binding = require_node(graph, 1526, 'EX_Let')
    if variable(binding['Assignment']['Target']) != ['NearsightFadeOutDuration']:
        raise ValueError('Nearsight tail duration field differs')
    call = require_node(graph, 1555, 'EX_FinalFunction', lambda n:
        n['StackNode']['reference'].endswith("EffectContainer:AddTailTime'"))
    if variable(call['Parameters'][0]) != variable(binding['Variable']):
        raise ValueError('Nearsight tail does not use verified duration binding')
    divide = require_node(graph, 1574, 'EX_Let')['Assignment']
    if divide['StackNode']['reference'].endswith("KismetMathLibrary:SafeDivide'") is False or \
       divide['Parameters'][0].get('Value') != 1.0 or variable(divide['Parameters'][1]) != ['NearsightFadeOutDuration']:
        raise ValueError('Nearsight timeline rate does not divide by fade duration')
    proof += [binding, call, require_node(graph, 1649, 'EX_Context', lambda n:
        variable(n['ObjectExpression']) == ['NearsightTimeline'] and n['ContextExpression']['StackNode']['reference'].endswith("TimelineComponent:SetPlayRate'")),
        require_node(graph, 1690, 'EX_LocalVirtualFunction', lambda n: n['VirtualFunctionName'] == 'ReversNearsightFadeIn'),
        require_node(graph, 1705, 'EX_Jump', lambda n: n['CodeOffset'] == 433),
        require_node(graph, 433, 'EX_Context', lambda n:
            variable(n['ObjectExpression']) == ['NearsightTimeline'] and n['ContextExpression']['StackNode']['reference'].endswith("TimelineComponent:Reverse'"))]
    length = exports['NearsightTimeline_Template']['properties']['TimelineLength']
    if length != 1.0:
        raise ValueError('Nearsight reversed timeline no longer has unit length')
    return {'rule_id': 'global_nearsight_debuff_reverse_timeline', 'duration_field': 'NearsightFadeOutDuration',
            'timeline_length_seconds': length, 'conditions': ['Inherited global debuff StopEffect dispatch',
                'Serialized duration remains unchanged', 'Timeline position is within its serialized unit length'],
            'proof_statements': [n['StatementIndex'] for n in proof], 'proof_sha256': digest(json.dumps(proof, sort_keys=True).encode())}


def build(source, model):
    manifest = json.loads((source/'manifest.json').read_text(encoding='utf-8'))
    inventory = manifest['inventory']
    if inventory['mapping_sha256'] != model['mapping_sha256'] or inventory['archives'] != model['archives']:
        raise ValueError('Model and cached behavior source do not share mappings/archives')
    index = {r['package']: r for r in map(json.loads, (source/'index.jsonl').read_text(encoding='utf-8').splitlines())}
    cache, provenance = {}, {}
    def load(path):
        if path not in cache:
            row = index[path]
            blob = (source/row['file']).read_bytes()
            if digest(blob) != row['sha256'] or row['errors']:
                raise ValueError('Changed or incomplete source package: ' + path)
            cache[path] = json.loads(gzip.decompress(blob))
            if cache[path]['package'] != path or cache[path].get('errors'):
                raise ValueError('Invalid source export package: ' + path)
            provenance[path] = {'file': row['file'], 'sha256': row['sha256']}
        return cache[path]
    def lineage(path):
        chain, seen = [], set()
        while path:
            if path in seen:
                raise ValueError('Class inheritance cycle: ' + path)
            seen.add(path); package = load(path); chain.append(path)
            cls = next(e for e in package['exports'] if e['type'] == 'UBlueprintGeneratedClass')
            path = reference_package(cls.get('SuperStruct'))
        return chain
    roots = {'flash': prove_root(load(CORE), 'flash', load(WIDGET)), 'nearsight': prove_root(load(NEAR), 'nearsight')}
    profiles = dict(model['vision_profiles'])
    # The observed catalog can include a recipient impairment omitted from the
    # hand-selected profile list (e.g. GoopFlash). Verify its actual inheritance.
    for cls, record in model.get('asset_catalog', {}).items():
        chain = record.get('lineage', [])
        if CORE in chain:
            profiles.setdefault(cls, {'kind': 'flash', 'asset_defaults': {}})
        elif NEAR in chain or 'ShooterGame/Content/Characters/Global/FXC/FXC_Nearsight_Parent.uasset' in chain:
            profiles.setdefault(cls, {'kind': 'nearsight', 'asset_defaults': {}})
    rules, gaps = {}, []
    for cls, profile in sorted(profiles.items()):
        package = 'ShooterGame/Content/' + cls.split('.')[0][6:] + '.uasset'
        chain = lineage(package)
        owner = next((p for p in chain if any(e['type'] == 'UFunction' and e['name'] == 'StopEffect' for e in load(p)['exports'])), None)
        kind = profile['kind']; expected = CORE if kind == 'flash' else NEAR
        if owner != expected:
            gaps.append({'asset_class': cls, 'reason': 'StopEffect implementation differs from proven fade root', 'stop_owner': owner})
            continue
        values, sources = {}, {}
        for p in reversed(chain):
            default = next((e for e in load(p)['exports'] if e['name'].startswith('Default__')), {})
            for key, value in default.get('properties', {}).items():
                values[key], sources[key] = value, p
        rule = dict(roots[kind])
        if kind == 'nearsight':
            field = rule['duration_field']; rule['duration_seconds'] = values[field]
            rule['duration_source_package'] = sources[field]
            if cls in model['vision_profiles'] and profile['asset_defaults'].get(field) != values[field]:
                raise ValueError('Profile fade duration differs from verified class source: ' + cls)
        if not isinstance(rule['duration_seconds'], (int, float)) or not math.isfinite(rule['duration_seconds']) or rule['duration_seconds'] < 0:
            raise ValueError('Invalid fade duration: ' + cls)
        rules[cls] = {**rule, 'kind': kind, 'stop_owner_package': owner, 'dispatch_lineage': chain,
                      'modeled_vision_profile_available': cls in model['vision_profiles'],
                      'native_shader_perceptibility_verified': False, 'native_effect_clock_binding_verified': False}
    return {'schema_version': 1, 'kind': 'conditional_asset_effect_fade_rules', 'mapping_sha256': model['mapping_sha256'],
            'archives': model['archives'], 'classes': rules, 'gaps': gaps, 'sources': provenance,
            'source_manifest_sha256': digest((source/'manifest.json').read_bytes()),
            'source_index_sha256': digest((source/'index.jsonl').read_bytes()),
            'generator_sha256': digest(Path(__file__).read_bytes()),
            'limitations': ['An observed RPC stop is not a native visual-clearance event.',
                'These conditional windows do not certify native shader opacity, final clearance or wall visibility.',
                'EffectTailTime is not used as an impairment duration.',
                'Runtime field changes, effect subclass overrides and native animation/timer clocks are unbound.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path); parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    result = build(args.source, json.loads(args.model.read_text(encoding='utf-8')))
    result['model_sha256'] = digest(args.model.read_bytes())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'out': str(args.out), 'verified_conditional_rules': len(result['classes']),
                      'unsupported_stop_implementations': len(result['gaps']), 'source_packages': len(result['sources'])}))


if __name__ == '__main__':
    main()
