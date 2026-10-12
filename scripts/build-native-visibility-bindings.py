"""Recover source-pinned camera/body and flash-material bindings.

These are serialized operands and native-call dependencies, not reconstructed
engine poses or measured shader opacity. No replay flag substitutes for a
native accessor return value or a rendered frame.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

BASE = 'ShooterGame/Content/'
PAWN = BASE + 'Characters/_Core/BasePawn.uasset'
PLAYER = BASE + 'Characters/_Core/BasePlayerCharacter.uasset'
CAMERA = BASE + 'Characters/_Core/BaseShooterCamera.uasset'
BODY = BASE + 'Characters/_Core/3P/TP_Core_AnimGraph_v2.uasset'
POST_BODY = BASE + 'Characters/_Core/3P/Models/TP_Core_AnimGraph_post.uasset'
PITCH = BASE + 'Characters/_Core/Comp_Character_PitchMeshToVelocity.uasset'
WIDGET = BASE + 'UI/InGame/HUD/BlindsDrivenMaterialOverlay.uasset'
SMOKE = BASE + 'Characters/Global/Smoke/GameObject_NewSmokeZone_Parent.uasset'
OVERLAYS = BASE + 'Characters/Global/Smoke/Comp_PlayerCharacter_SmokeOverlays.uasset'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def object_hash(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


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
        raise ValueError('Native binding operand differs: ' + name)
    return node['Parameters']


def prove_flash_material(package):
    """Verify the actual data flow to Alpha_ColorMult, including its clocks."""
    exports = {e['name']: e for e in package['exports']}
    default = exports['Default__BlindsDrivenMaterialOverlay_C']['properties']
    if default.get('MaterialParamName') != 'Alpha_ColorMult' or default.get('AttributeFadeTime') != 1.0:
        raise ValueError('Flash widget defaults differ')
    graph = exports['ExecuteUbergraph_BlindsDrivenMaterialOverlay']['ScriptBytecode']
    nodes = {n['StatementIndex']: n for n in graph}
    proof = []

    def node(index, kind):
        row = nodes[index]
        if row.get('expression_type') != kind:
            raise ValueError(f'Flash binding statement {index} differs')
        proof.append(row)
        return row

    def assignment(index, target, method, operands):
        row = node(index, 'EX_Let')
        if variable(row['Variable']) != [target]:
            raise ValueError('Flash binding assignment differs')
        args = call(row['Assignment'], method)
        if [variable(arg) for arg in args] != [[name] for name in operands]:
            raise ValueError('Flash binding data flow differs')

    # Timer cadence is a serialized request, not an achieved 10 ms render tick.
    bind = node(30, 'EX_BindDelegate')
    timer = call(node(53, 'EX_Let')['Assignment'], 'Engine.KismetSystemLibrary:K2_SetTimerDelegate')
    if bind['FunctionName'] != 'UpdateMaterialFadeV2' or variable(timer[0]) != variable(bind['Delegate']) or \
       timer[1].get('Value') != 0.009999999776482582 or timer[2].get('expression_type') != 'EX_True':
        raise ValueError('Flash fade timer binding differs')
    clock = node(149, 'EX_Let')
    call(clock['Assignment'], 'Engine.GameplayStatics:GetTimeSeconds')
    if variable(clock['Variable']) != ['CallFunc_GetTimeSeconds_ReturnValue_2']:
        raise ValueError('Flash engine clock binding differs')
    assignment(178, 'CallFunc_Subtract_DoubleDouble_ReturnValue_1', 'Engine.KismetMathLibrary:Subtract_DoubleDouble',
               ['AttributeFadeEndTime', 'CallFunc_GetTimeSeconds_ReturnValue_2'])
    assignment(224, 'CallFunc_Divide_DoubleDouble_ReturnValue', 'Engine.KismetMathLibrary:Divide_DoubleDouble',
               ['CallFunc_Subtract_DoubleDouble_ReturnValue_1', 'AttributeFadeTime'])
    cast = node(270, 'EX_Let')
    if variable(cast['Variable']) != ['CallFunc_SetScalarParameterValue_Value_ImplicitCast'] or \
       cast['Assignment']['expression_type'] != 'EX_Cast' or cast['Assignment']['ConversionType']['value__'] != 3 or \
       variable(cast['Assignment']['Target']) != ['CallFunc_Divide_DoubleDouble_ReturnValue']:
        raise ValueError('Flash scalar precision cast differs')
    write = node(299, 'EX_Context')
    params = call(write['ContextExpression'], 'Engine.MaterialInstanceDynamic:SetScalarParameterValue')
    if variable(write['ObjectExpression']) != ['MaterialInstance'] or \
       [variable(p) for p in params] != [['MaterialParamName'], ['CallFunc_SetScalarParameterValue_Value_ImplicitCast']]:
        raise ValueError('Flash material scalar write differs')
    # Native blind state controls full intensity. An RPC stop is not this input.
    blind = node(1945, 'EX_LetBool')
    call(blind['Assignment']['ContextExpression'], 'ShooterGame.BlindManagerComponent:IsBlinded')
    jump = node(1987, 'EX_JumpIfNot')
    if variable(jump['BooleanExpression']) != variable(blind['Variable']) or jump['CodeOffset'] != 2084:
        raise ValueError('Flash native blind branch differs')
    full = node(2017, 'EX_Context')
    params = call(full['ContextExpression'], 'Engine.MaterialInstanceDynamic:SetScalarParameterValue')
    if variable(full['ObjectExpression']) != ['MaterialInstance'] or variable(params[0]) != ['MaterialParamName'] or \
       params[1].get('Value') != 1.0 or params[1].get('expression_type') != 'EX_FloatConst':
        raise ValueError('Flash full-intensity material write differs')
    elapsed = node(2126, 'EX_Let')
    call(elapsed['Assignment']['ContextExpression'], 'ShooterGame.BlindManagerComponent:GetTimeSinceLastBlindedChange')
    elapsed2 = node(2328, 'EX_Let')
    call(elapsed2['Assignment']['ContextExpression'], 'ShooterGame.BlindManagerComponent:GetTimeSinceLastBlindedChange')
    if variable(elapsed['Variable']) != ['CallFunc_GetTimeSinceLastBlindedChange_ReturnValue'] or \
       variable(elapsed2['Variable']) != variable(elapsed['Variable']):
        raise ValueError('Flash elapsed-clock assignment differs')
    for index, target in ((2176, 'CallFunc_Less_DoubleDouble_A_ImplicitCast'),
                          (2378, 'CallFunc_Subtract_DoubleDouble_B_ImplicitCast')):
        cast = node(index, 'EX_Let')
        if variable(cast['Variable']) != [target] or cast['Assignment']['expression_type'] != 'EX_Cast' or cast['Assignment']['ConversionType']['value__'] != 4 or \
           variable(cast['Assignment']['Target']) != variable(elapsed['Variable']):
            raise ValueError('Flash elapsed-clock cast differs')
    assignment(2407, 'CallFunc_Subtract_DoubleDouble_ReturnValue', 'Engine.KismetMathLibrary:Subtract_DoubleDouble',
               ['AttributeFadeTime', 'CallFunc_Subtract_DoubleDouble_B_ImplicitCast'])
    assignment(2453, 'CallFunc_Add_DoubleDouble_ReturnValue', 'Engine.KismetMathLibrary:Add_DoubleDouble',
               ['CallFunc_GetTimeSeconds_ReturnValue', 'CallFunc_Subtract_DoubleDouble_ReturnValue'])
    engine = node(2257, 'EX_Let')
    call(engine['Assignment'], 'Engine.GameplayStatics:GetTimeSeconds')
    if variable(engine['Variable']) != ['CallFunc_GetTimeSeconds_ReturnValue']:
        raise ValueError('Flash fade end engine clock binding differs')
    end = node(2499, 'EX_Let')
    if variable(end['Variable']) != ['AttributeFadeEndTime'] or \
       variable(end['Assignment']) != ['CallFunc_Add_DoubleDouble_ReturnValue']:
        raise ValueError('Flash fade end-clock assignment differs')
    return {'package': WIDGET, 'parameter_name': default['MaterialParamName'], 'fade_duration_seconds': 1.0,
        'full_intensity_condition': 'native BlindManagerComponent.IsBlinded() is true',
        'full_intensity_parameter': 1.0,
        'fade_end_expression': 'engine_time_seconds + (AttributeFadeTime - native_time_since_last_blinded_change)',
        'fade_parameter_expression': 'float32((AttributeFadeEndTime - engine_time_seconds) / AttributeFadeTime)',
        'serialized_timer_period_seconds': timer[1]['Value'],
        'required_runtime_inputs': ['BlindManagerComponent.IsBlinded', 'BlindManagerComponent.GetTimeSinceLastBlindedChange',
            'GameplayStatics.GetTimeSeconds', 'valid MaterialInstance', 'current widget visibility and blind-overlay settings'],
        'proof_statements': [n['StatementIndex'] for n in proof], 'proof_sha256': object_hash(proof),
        'native_accessor_semantics_verified': False, 'native_clock_binding_verified': False,
        'shader_opacity_equivalent_to_parameter_verified': False,
        'limitation': 'A material input value is not measured opacity or a visibility decision; no clamp or stop-RPC clock is synthesized.'}


def build(source, model):
    source = Path(source)
    manifest_raw = (source / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    inventory = manifest['inventory']
    if inventory['mapping_sha256'] != model['mapping_sha256'] or inventory['archives'] != model['archives']:
        raise ValueError('Native binding source and replay model mappings/archives differ')
    index_raw = (source / 'index.jsonl').read_bytes()
    index = {r['package']: r for r in map(json.loads, index_raw.decode().splitlines())}
    packages, receipts = {}, {}
    for path in (PAWN, PLAYER, CAMERA, BODY, POST_BODY, PITCH, WIDGET, SMOKE, OVERLAYS):
        row = index[path]
        raw = (source / row['file']).read_bytes()
        data = json.loads(gzip.decompress(raw))
        if digest(raw) != row['sha256'] or row['errors'] or data.get('errors') or data['package'] != path:
            raise ValueError('Native binding package source differs: ' + path)
        packages[path] = data
        receipts[path] = {'file': row['file'], 'sha256': row['sha256']}
    evidence, clock_sites = [], []
    for path, package in packages.items():
        for export in package['exports']:
            if export['type'] == 'UFunction':
                for node in walk(export.get('ScriptBytecode', [])):
                    ref = node.get('StackNode', {}).get('reference', '')
                    if ref.startswith("Class'/Script/ShooterGame."):
                        evidence.append({'package': path, 'export': export['name'],
                            'statement': node['StatementIndex'], 'native_call': ref})
                    if path in (WIDGET, SMOKE, OVERLAYS) and any(name in ref for name in
                        ('GetTimeSeconds', 'GetTimeSince', 'SetTimer', 'ClearTimer', 'Delay', 'GetTimer')):
                        clock_sites.append({'package': path, 'export': export['name'],
                            'function_flags': export.get('FunctionFlags'), 'statement': node['StatementIndex'],
                            'clock_call': ref, 'serialized_expression': node,
                            'native_dispatch_clock_verified': False})
    components = []
    for path in (PAWN, PLAYER, CAMERA, BODY, POST_BODY, PITCH, OVERLAYS):
        for e in packages[path]['exports']:
            if e['type'] != 'UFunction' and (e['name'].startswith('Default__') or
                e['name'] in ('FollowRecoilCameraComponent', 'CharacterMesh0', 'PawnMesh1P',
                              'CollisionCylinder', 'AnimationState_GEN_VARIABLE')):
                components.append({'package': path, 'export': e['name'], 'type': e['type'],
                    'properties': e.get('properties', {})})
    return {'schema_version': 1, 'kind': 'source_pinned_native_visibility_bindings',
        'mapping_sha256': model['mapping_sha256'], 'archives': model['archives'],
        'source_manifest_sha256': digest(manifest_raw), 'source_index_sha256': digest(index_raw),
        'generator_sha256': digest(Path(__file__).read_bytes()), 'sources': receipts,
        'camera_body_components': components, 'native_call_sites': evidence,
        'activation_clock_sites': clock_sites,
        'flash_material': prove_flash_material(packages[WIDGET]),
        'native_camera_reconstructed': False, 'native_body_reconstructed': False, 'native_visibility_verified': False,
        'remaining_dependencies': {
            'camera': ['achieved FollowRecoilCameraComponent transform', 'final native FOV and view rotation',
                       'remote camera switching', 'render-clock binding'],
            'body': ['agent-specific mesh binding', 'native animation graph state/phase/weights',
                     'component-space pose, mesh transforms and skinning', 'partial-cover silhouette validation'],
            'shader': ['native blind accessors and their clocks', 'runtime material instance and overrides',
                       'compiled shader behavior and measured pixel opacity'],
            'activation': ['native effect/timer dispatch clock', 'smoke visual expansion/extinction',
                           'actual dynamic-barrier pose rather than desired state']}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('model', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    report = build(args.source, json.loads(args.model.read_text(encoding='utf-8')))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'packages': len(report['sources']), 'native_call_sites': len(report['native_call_sites']),
                      'flash_parameter': report['flash_material']['parameter_name'], 'native_visibility_verified': False}))


if __name__ == '__main__':
    main()
