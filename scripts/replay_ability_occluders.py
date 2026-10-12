"""Pinned ability geometry/defaults and observed activation dependencies.

Recorded anchors and RPCs are evidence. Shader opacity, native procedural wall
generation and visual extinction are not certified by a class name or actor
channel lifetime. Those dependencies stay explicit in the addon.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import struct

from replay_camera_body import decoded_bool, decoded_reference

BASE = 'ShooterGame/Content/'
ROOTS = {
    'viper_orb': 'Characters/Pandemic/S0/Ability_4/GameObject_Pandemic_4_SmokeZone',
    'viper_wall': 'Characters/Pandemic/S0/Ability_E/GameObject_Pandemic_E_SmokeScreenManager',
    'viper_ult': 'Characters/Pandemic/S0/Ability_X/Patch_Pandemic_X_Circular',
    'harbor_cove': 'Characters/Mage/S0/Ability_E/GameObject_Mage_E_WorldSmoke',
    'harbor_wall': 'Characters/Mage/S0/Ability_Q/GameObject_Mage_Q_WallManager',
    'vyse_wall': 'Characters/Nox/S0/Ability_Q/GameObject_Nox_Wall',
    'vyse_trap': 'Characters/Nox/S0/Ability_Q/GameObject_Nox_WallTrap',
}
CLASSES = {f'/Game/{path}.{path.rsplit("/", 1)[-1]}_C': family for family, path in ROOTS.items()}
CHECKSUMS = {
    'WallActivated': 1405358241,
    'CurrentFuelLevel': 2492531475,
    'MulticastAddSmokeScreenPoint.Translation': 2794273677,
    'MulticastAddSmokeScreenPoint.ProjectileLocation': 3168914961,
    'MulticastAddSmokeScreenPoint.Scale3D': 1639439377,
    'MulticastAddSmokeScreenPoint.249': 177696787,
    'MulticastAddSmokeScreenPoint.ValveDistance': 2659545020,
    'MulticastAddSmokeScreenPoint.CreatingProjectile': 1904779440,
    'MulticastInitializeWall.WallStartLocation': 3658850132,
    'MulticastInitializeWall.WallEndLocation': 2667605947,
    'MulticastInitializeWall.WallImpactNormal': 2282056711,
    'MulticastInitializeWall.EnemyTrigger': 254389602,
    'MulticastInitializeTrapAnchors.WallStartPoint': 2259333494,
    'MulticastInitializeTrapAnchors.WallEndPoint': 2177329427,
    'MulticastInitializeTrapAnchors.Impact Point': 1673537767,
    'MulticastInitializeTrapAnchors.ImpactNormal': 4144319849,
    'PandemicSmokeLevelUpdate.StartingSmokeLevel': 1177085935,
    'PandemicSmokeLevelUpdate.PandemicInsideSmoke': 1248652635,
    'PandemicSmokeLevelUpdate.TimeOfChange': 1839739669,
}
EMPTY_RPCS = {'MulticastEnableDynamicCollision', 'Multicast Destroy Smoke',
              'BeginBuildingWall', 'MulticastStartTrapOutroEffects'}
VECTOR_FIELDS = {k for k in CHECKSUMS if any(k.endswith('.' + name) for name in (
    'Translation', 'ProjectileLocation', 'Scale3D', '249', 'WallStartLocation',
    'WallEndLocation', 'WallImpactNormal', 'WallStartPoint', 'WallEndPoint', 'Impact Point', 'ImpactNormal'))}


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def package_reference(value):
    match = re.search(r"/Game/([^'.:]+)", (value or {}).get('reference', ''))
    return BASE + match[1] + '.uasset' if match else None


def expressions(value):
    if isinstance(value, dict):
        if 'expression_type' in value:
            yield value
        for child in value.values():
            yield from expressions(child)
    elif isinstance(value, list):
        for child in value:
            yield from expressions(child)


def build_model(source, mesh_probe=None):
    """Extract serialized values with property-level source receipts."""
    index_path = source / 'index.jsonl'
    index = {r['package']: r for r in map(json.loads, index_path.read_text(encoding='utf-8').splitlines())}
    loaded, receipts = {}, {}

    def load(package):
        if package in loaded:
            return loaded[package]
        entry = index[package]
        file = source / entry['file']
        if digest(file) != entry['sha256'] or entry['errors']:
            raise ValueError('Asset source export identity or completeness failure')
        result = json.loads(gzip.decompress(file.read_bytes()))
        if result.get('errors'):
            raise ValueError('Asset export contains errors')
        loaded[package] = result
        receipts[package] = {'file': entry['file'], 'sha256': entry['sha256']}
        return result

    def inherited(package, seen=()):
        if package in seen:
            raise ValueError('Asset inheritance cycle')
        asset = load(package)
        cls = next(e for e in asset['exports'] if e['type'] == 'UBlueprintGeneratedClass')
        parent = package_reference(cls.get('SuperStruct'))
        defaults, components = inherited(parent, (*seen, package)) if parent else ({}, {})
        for export in asset['exports']:
            source_ref = f"{package}:{export['name']}"
            if export['name'].startswith('Default__'):
                defaults.update({k: {'value': v, 'source': source_ref + '.' + k}
                                 for k, v in export.get('properties', {}).items()})
            elif export['type'] not in ('UFunction', 'UBlueprintGeneratedClass', 'USCS_Node'):
                component = components.setdefault(export['name'], {'export_class': export.get('export_class'), 'properties': {}})
                component['properties'].update({k: {'value': v, 'source': source_ref + '.' + k}
                                                 for k, v in export.get('properties', {}).items()})
        return defaults, components

    profiles = {}
    for family, path in ROOTS.items():
        package = BASE + path + '.uasset'
        defaults, components = inherited(package)
        relevant_defaults = {k: v for k, v in defaults.items() if any(x in k.lower() for x in (
            'time', 'duration', 'delay', 'height', 'radius', 'distance', 'thickness', 'cell', 'expand',
            'contract', 'collapse', 'scale', 'buff', 'near', 'collision', 'mesh', 'offset'))}
        relevant_components = {k: v for k, v in components.items() if any(x in k.lower() for x in (
            'sphere', 'box', 'wallmesh', 'cloudmesh', 'collision', 'timeline', 'curvefloat', 'groundvolume'))}
        functions = {}
        for export in load(package)['exports']:
            if export['type'] != 'UFunction':
                continue
            nodes = list(expressions(export.get('ScriptBytecode')))
            refs = sorted({node[key]['reference'] for node in nodes for key in ('StackNode', 'Value')
                           if isinstance(node.get(key), dict) and 'reference' in node[key]})
            functions[export['name']] = {
                'source': f"{package}:{export['name']}",
                'references': refs,
                'virtual_calls': sorted({node['VirtualFunctionName'] for node in nodes if 'VirtualFunctionName' in node}),
                'complete_expression_stream': bool(export.get('ScriptBytecode')) and export['ScriptBytecode'][-1]['expression_type'] == 'EX_EndOfScript',
            }
        profiles[family] = {'actor_class': next(k for k, v in CLASSES.items() if v == family),
                            'serialized_defaults': relevant_defaults, 'components': relevant_components,
                            'functions': functions, 'native_geometry_verified': False,
                            'native_shader_opacity_verified': False}
    result = {'schema_version': 1, 'model_version': 'ability-occluders-v1',
              'profiles': profiles, 'source_assets': receipts,
              'source_provenance': {'source_manifest_sha256': digest(source / 'manifest.json'),
                                    'source_index_sha256': digest(index_path), 'helper_sha256': digest(__file__)},
              'asset_build_verified_against_replay': False,
              'policy': 'Evidence and conditional geometry models only; never assert native blocked or clear.'}
    if mesh_probe:
        probe = json.loads(mesh_probe.read_text(encoding='utf-8'))
        summaries = []
        for package in probe['packages']:
            for export in package.get('exports', []):
                summary = {'package': package['package'], 'export': export['name'], 'type': export['type']}
                if 'mesh_lod0' in export:
                    vertices = export['mesh_lod0']['vertices']
                    summary.update(vertex_count=len(vertices), local_bounds_cm={
                        'min': [min(v[i] for v in vertices) for i in range(3)],
                        'max': [max(v[i] for v in vertices) for i in range(3)]})
                elif export['type'] == 'UMaterialInstanceConstant':
                    summary['serialized_properties'] = export['properties']
                else:
                    continue
                summaries.append(summary)
        result['mesh_and_material_probe'] = {'sha256': digest(mesh_probe), 'summaries': summaries,
                                             'world_position_offset_envelope_verified': False}
    return result


def vector(row):
    if row['bit_count'] != 192 or len(row.get('raw_bits') or b'') != 24:
        raise ValueError('Vector is not the complete serialized double XYZ payload')
    result = list(struct.unpack('<ddd', row['raw_bits']))
    if not all(math.isfinite(v) for v in result):
        raise ValueError('Nonfinite world vector')
    return result


def scalar(row):
    if row['bit_count'] != 64 or len(row.get('raw_bits') or b'') != 8:
        raise ValueError('Scalar is not a complete double payload')
    value = struct.unpack('<d', row['raw_bits'])[0]
    if not math.isfinite(value):
        raise ValueError('Nonfinite scalar')
    if row.get('value_f64') is not None and row['value_f64'] != value:
        raise ValueError('Typed and raw scalar disagree')
    return value


def receipt(row, value):
    return {'time_ms': row['time_ms'], 'packet_id': row['packet_id'],
            'actor_net_guid': row['actor_net_guid'], 'component_net_guid': row.get('object_net_guid'),
            'group': row['group_path'], 'field': row['field_name'],
            'compatible_checksum': row.get('compatible_checksum'), 'bit_count': row['bit_count'],
            'raw_hex': (row.get('raw_bits') or b'').hex(), 'value': value}


def ability_dependencies(rows, actor_rows, rounds, model):
    """Separate explicit activation flags/RPCs from placement and channel facts."""
    starts = [r['start_ms'] for r in rounds]
    if (starts != sorted(starts) or any(r['start_ms'] >= r['end_ms'] for r in rounds) or
            any(a['end_ms'] > b['start_ms'] for a, b in zip(rounds, rounds[1:]))):
        raise ValueError('Invalid round boundaries')
    by_actor, observations, unresolved, instances = {}, [], [], []
    diagnostics = Counter()
    for actor in actor_rows:
        if actor['event'] == 'open' and actor.get('class_path') in CLASSES:
            family = CLASSES[actor['class_path']]
            by_actor[actor['actor_net_guid']] = {'actor_net_guid': actor['actor_net_guid'], 'kind': family,
                'class_path': actor['class_path'], 'channel_open_observation': actor,
                'channel_close_observations': [], 'anchor_observations': [],
                'activation_observations': [], 'native_activation_verified': False}
        elif actor['event'] == 'close' and actor['actor_net_guid'] in by_actor:
            by_actor[actor['actor_net_guid']]['channel_close_observations'].append(actor)

    def round_at(t):
        index = bisect_right(starts, t) - 1
        return rounds[index] if index >= 0 and t < rounds[index]['end_ms'] else None

    pending = {}
    active_flags = {}
    for ordinal, row in sorted(enumerate(rows), key=lambda x: (x[1]['time_ms'], x[1]['packet_id'], x[1].get('ordinal', x[0]))):
        actor, field = by_actor.get(row['actor_net_guid']), row['field_name']
        if not actor:
            continue
        kind = actor['kind']
        own_group = row['group_path'].removesuffix('_ClassNetCache') == actor['class_path']
        if not own_group or not (field in CHECKSUMS or field in EMPTY_RPCS):
            continue
        try:
            if field in EMPTY_RPCS:
                if row['bit_count'] != 0 or row.get('raw_bits'):
                    raise ValueError('Unexpected empty-RPC payload')
                value = None
            elif row.get('compatible_checksum') != CHECKSUMS[field]:
                raise ValueError('Compatible checksum mismatch')
            elif field in VECTOR_FIELDS:
                value = vector(row)
            elif field in ('WallActivated', 'PandemicSmokeLevelUpdate.PandemicInsideSmoke'):
                value = decoded_bool(row)
            elif field.endswith(('.CreatingProjectile', '.EnemyTrigger')):
                value = decoded_reference(row)
            else:
                value = scalar(row)
        except ValueError as error:
            unresolved.append({'observation': receipt(row, None), 'reason': str(error)})
            diagnostics['invalid_observations'] += 1
            continue
        obs = receipt(row, value)
        observations.append(obs)
        t, r = row['time_ms'], round_at(row['time_ms'])
        if field == 'WallActivated' and kind == 'viper_wall':
            actor['activation_observations'].append(obs)
            key = (row['actor_net_guid'], r['index'] if r else None)
            if value and r:
                if key not in active_flags:
                    item = {'id': f"viper-wall-{row['actor_net_guid']}-{row['packet_id']}",
                        'kind': kind, 'actor_net_guid': row['actor_net_guid'], 'round': r['index'],
                        'start_ms': t, 'end_ms': r['end_ms'], 'start_observation': obs,
                        'activation_start_observed_ms': t, 'possible_cosmetic_start_ms': t,
                        'start_policy': 'observed_WallActivated_true',
                        'start_boundary_kind': 'observed_replication_clock', 'end_boundary_kind': 'round_knowledge_cap',
                        'end_policy': 'round_knowledge_cap_no_visual_extinction_observed',
                        'world_bounds_cm': None, 'world_bounds_verified': False,
                        'geometry_reason': 'native_procedural_WallMesh_and_shader_envelope_unresolved',
                        'native_visibility_verified': False, 'policy': 'potential_occluder_unknown'}
                    instances.append(item)
                    active_flags[key] = item
            elif not value and key in active_flags:
                item = active_flags.pop(key)
                item.update(deactivation_observation=obs, observed_flag_end_ms=t,
                    end_policy='deactivation_observed_visual_extinction_unresolved',
                    conditional_asset_tail_ms=(model['profiles']['viper_wall']['serialized_defaults']['WallDeactivationDelay']['value'] +
                        model['profiles']['viper_wall']['serialized_defaults']['DissolveTime']['value']) * 1000)
                # Native/local branch execution is unverified. The conditional
                # tail is guidance, never a synthesized clear boundary.
            elif value:
                unresolved.append({'observation': obs, 'reason': 'activation_outside_round'})
        if '.' in field:
            method, member = field.split('.', 1)
            if method.startswith(('MulticastAddSmokeScreenPoint', 'MulticastInitialize')):
                key = (row['actor_net_guid'], row.get('object_net_guid'), t, row['packet_id'], method)
                message = pending.get(key)
                if message is None or member in message['members']:
                    message = {'time_ms': t, 'packet_id': row['packet_id'], 'actor_net_guid': row['actor_net_guid'],
                               'method': method, 'members': {}, 'receipts': []}
                    pending[key] = message
                    actor['anchor_observations'].append(message)
                message['members'][member] = value
                message['receipts'].append(obs)
                if kind == 'viper_wall' and member == 'Translation':
                    message.update(world_location_cm=value, coordinate_space='world_valve_transform_translation',
                        world_coordinate_evidence='MulticastAddSmokeScreenPoint -> TransformLocation(ValveSetTransform,zero) -> WallMesh.AddWallAnchor; CreateValve -> K2_SetWorldTransform',
                        anchor_application_verified=False,
                        unresolved_condition='native IsLocationTargetBlocked guard and WallMesh.AddWallAnchor execution')
        if kind == 'vyse_wall' and field == 'MulticastEnableDynamicCollision':
            actor['activation_observations'].append(obs)
            if r:
                item = {'id': f"vyse-wall-{row['actor_net_guid']}-{row['packet_id']}", 'kind': kind,
                    'actor_net_guid': row['actor_net_guid'], 'round': r['index'], 'start_ms': t,
                    'end_ms': r['end_ms'], 'start_observation': obs,
                    'activation_start_observed_ms': t,
                    'start_policy': 'observed_enable_dynamic_collision_rpc',
                    'start_boundary_kind': 'observed_replication_clock', 'end_boundary_kind': 'round_knowledge_cap',
                    'end_policy': 'round_knowledge_cap_no_visual_extinction_observed',
                    'conditional_asset_lifetime_ms': model['profiles']['vyse_wall']['serialized_defaults']['ActorLifeTime']['value'] * 1000,
                    'world_bounds_cm': None, 'world_bounds_verified': False,
                    'geometry_reason': 'root_transform_mesh_scaling_and_masked_shader_envelope_unverified',
                    'native_visibility_verified': False, 'policy': 'potential_occluder_unknown'}
                instances.append(item)
        elif kind == 'viper_orb' and field == 'Multicast Destroy Smoke':
            actor['activation_observations'].append(obs)
        elif field.startswith('PandemicSmokeLevelUpdate.'):
            actor['activation_observations'].append(obs)
    for item in instances:
        actor = by_actor[item['actor_net_guid']]
        item['anchor_observations'] = [m for m in actor['anchor_observations'] if m['time_ms'] <= item['start_ms']]
        item['later_anchor_observations'] = [m for m in actor['anchor_observations'] if item['start_ms'] < m['time_ms'] < item['end_ms']]
        item['channel_close_observations'] = actor['channel_close_observations']
        if item['kind'] == 'vyse_wall':
            complete = [m for m in item['anchor_observations'] if m['method'] == 'MulticastInitializeWall' and
                        all(k in m['members'] for k in ('WallStartLocation', 'WallEndLocation', 'WallImpactNormal'))]
            if complete:
                item['world_endpoints_cm'] = {k: complete[-1]['members'][k] for k in ('WallStartLocation', 'WallEndLocation', 'WallImpactNormal')}
                item['initialization_observed_ms'] = complete[-1]['time_ms']
                item['possible_cosmetic_start_ms'] = complete[-1]['time_ms']
                item['collision_enable_observed_ms'] = item['start_ms']
                item['collision_enable_observation'] = item['start_observation']
                item['start_observation'] = complete[-1]
                item['start_ms'] = complete[-1]['time_ms']
                item['start_policy'] = 'observed_initialize_wall_rpc_and_collision_enable'
                item['coordinate_space'] = 'world_RPC_endpoint_inputs'
                # Shader scale/collision are animated after initialization.
                # Cover the entire potential rise, including before collision.
    diagnostics.update(instances=len(instances), actors=len(by_actor), observations=len(observations),
                       unmatched=len(unresolved), placement_only=sum(a['kind'] == 'vyse_trap' for a in by_actor.values()))
    return {'schema_version': 1, 'instances': instances, 'actors': list(by_actor.values()),
        'observations': observations, 'unmatched_records': unresolved, 'diagnostics': dict(diagnostics),
        'native_occlusion_complete': False,
        'policy': 'Unknown dependencies only. Missing bounds never imply a ray is clear. Channel lifetime never activates geometry.'}


def build_sidecar(con, record, review, model_path, model):
    export = Path(record['export'])
    replay_path = review / 'library' / record['match_id'] / 'replay.json'
    replay = json.loads(replay_path.read_text(encoding='utf-8'))
    provenance = json.loads((replay_path.parent / 'provenance.json').read_text(encoding='utf-8'))
    manifest_hash = digest(export / 'manifest.json')
    if (provenance['replay_export_manifest_sha256'] != manifest_hash or
            replay['source_provenance']['source_replay_sha256'] != record['source_sha256']):
        raise ValueError('Replay source identity mismatch')
    result = con.execute("SELECT * FROM read_parquet(?) ORDER BY time_ms,packet_id", [str(export / 'actors.parquet')])
    columns = [d[0] for d in result.description]
    actors = [dict(zip(columns, row)) for row in result.fetchall()]
    actor_ids = sorted({a['actor_net_guid'] for a in actors if a.get('class_path') in CLASSES})
    rows = []
    if actor_ids:
        result = con.execute("SELECT *, row_number() OVER () AS ordinal FROM read_parquet(?) WHERE actor_net_guid IN (SELECT unnest(?)) ORDER BY time_ms,packet_id,ordinal", [str(export / 'fields.parquet'), actor_ids])
        columns = [d[0] for d in result.description]
        rows = [dict(zip(columns, row)) for row in result.fetchall()]
    sidecar = ability_dependencies(rows, actors, replay['rounds'], model)
    sidecar.update(match_id=record['match_id'], replay_build=record['build'], duration_ms=record['duration_ms'],
        source_provenance={'source_replay_sha256': record['source_sha256'], 'export_manifest_sha256': manifest_hash,
            'fields_sha256': digest(export / 'fields.parquet'), 'actors_sha256': digest(export / 'actors.parquet'),
            'review_replay_sha256': digest(replay_path), 'helper_sha256': digest(__file__),
            'camera_helper_sha256': digest(Path(__file__).with_name('replay_camera_body.py')),
            'bit_reader_sha256': digest(Path(__file__).with_name('replay_bitwindows.py')),
            'asset_model_sha256': digest(model_path)})
    return sidecar


def validate_sidecar(sidecar, record, model_path, replay_path=None, verify_parquet=True):
    export = Path(record['export'])
    expected = {'source_replay_sha256': record['source_sha256'],
        'export_manifest_sha256': digest(export / 'manifest.json'),
        'helper_sha256': digest(__file__),
        'camera_helper_sha256': digest(Path(__file__).with_name('replay_camera_body.py')),
        'bit_reader_sha256': digest(Path(__file__).with_name('replay_bitwindows.py')),
        'asset_model_sha256': digest(model_path)}
    if replay_path is not None:
        expected['review_replay_sha256'] = digest(replay_path)
    if verify_parquet:
        expected.update(fields_sha256=digest(export / 'fields.parquet'), actors_sha256=digest(export / 'actors.parquet'))
    if (sidecar.get('schema_version') != 1 or sidecar.get('match_id') != record['match_id'] or
            sidecar.get('replay_build') != record['build'] or sidecar.get('duration_ms') != record['duration_ms'] or
            any(sidecar.get('source_provenance', {}).get(k) != v for k, v in expected.items())):
        raise ValueError('Ability occluder sidecar source/provenance mismatch')
    if sidecar.get('native_occlusion_complete') is not False:
        raise ValueError('Ability dependency evidence cannot certify native occlusion')
    for item in sidecar.get('instances', []):
        if (item.get('kind') not in ('viper_wall', 'vyse_wall') or
                type(item.get('start_ms')) is not int or type(item.get('end_ms')) is not int or
                not 0 <= item['start_ms'] <= item['end_ms'] <= record['duration_ms'] or
                item.get('native_visibility_verified') is not False or item.get('world_bounds_verified') is not False):
            raise ValueError('Invalid ability dependency instance')
    return sidecar


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('corpus', type=Path)
    parser.add_argument('review', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mesh-probe', type=Path)
    args = parser.parse_args()
    model = build_model(args.source, args.mesh_probe)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model, indent=2), encoding='utf-8')
    directory = args.review / 'ability-occluder-inputs-v1'
    directory.mkdir(parents=True, exist_ok=True)
    import duckdb
    totals = Counter()
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    with duckdb.connect() as con:
        for record in corpus['replays']:
            if record['status'] != 'validated':
                continue
            sidecar = build_sidecar(con, record, args.review, args.out, model)
            path = directory / (record['match_id'] + '.json')
            temporary = path.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(sidecar, indent=2), encoding='utf-8')
            temporary.replace(path)
            totals.update(sidecar['diagnostics'])
            print(record['match_id'], sidecar['diagnostics'], flush=True)
    print(json.dumps({'totals': dict(totals)}))


if __name__ == '__main__':
    main()
