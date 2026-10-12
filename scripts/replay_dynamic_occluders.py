"""Source-bound dynamic map dependencies, separate from native visibility.

Exact map object paths and replay export schemas identify actors and raw fields.
Conservative program-domain regions gate unresolved geometry; desired door state
never becomes achieved motion. No source/cache/game/replay data is modified.
"""
from __future__ import annotations
import argparse
from bisect import bisect_right
from collections import Counter,defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import struct

import numpy as np

ROOT=Path(__file__).resolve().parent.parent
WINDOW='/Game/Interactable/WindowShield.WindowShield_C'
DRAWBRIDGE='/Game/Maps/Jam/Drawbridge.Drawbridge_C'
WALL='/Game/Interactable/WallPlates/RespawningWallPlate.RespawningWallPlate_C'
DESTRUCTIBLE='/Game/Interactable/RespawningDestructible.RespawningDestructible_C'
CLASSES={WINDOW,DRAWBRIDGE,WALL,DESTRUCTIBLE}
FIELDS={
    'bHidden':(4123802426,'bool',1), 'IsAlive_0':(445799890,'bool',1),
    'DoorState':(1168757683,'uint',3), 'Transition':(3431642597,'uint',2),
    'LocalDoorPos':(1427094873,'float',32),
    'DoorOpenStartTime':(3711280657,'float',32),
    'DoorCloseStartTime':(2070739121,'float',32), 'Rotated':(1308555297,'bool',1),
}
CHILD_ALIVE_GROUP='/Script/ShooterGame.ChildDamageSectionComponent'
CHILD_ALIVE_CHECKSUM=622178691


def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def validate_asset_evidence(evidence):
    import gzip
    behavior=ROOT/'.local/replay-transcripts/asset-research/installed-behavior-source-v5'
    fingerprint=json.loads((behavior/'manifest.json').read_text())
    if evidence.get('probe_sha256')!=digest(ROOT/'scripts/probe-dynamic-map-assets.py') or evidence.get('serializer_sha256')!=digest(ROOT/'scripts/inspect-transcription-assets.py'):
        raise ValueError('Dynamic asset probe/serializer source changed')
    if evidence.get('behavior_source_manifest_sha256')!=digest(behavior/'manifest.json'):
        raise ValueError('Dynamic asset behavior source manifest changed')
    if evidence.get('archives')!=fingerprint['inventory']['archives'] or evidence.get('mapping_sha256')!=fingerprint['inventory']['mapping_sha256']:
        raise ValueError('Dynamic map/class source archive or mapping differs')
    for record in evidence['class_records']:
        receipt=record['receipt'];source=behavior/receipt['file']
        if receipt.get('errors') or digest(source)!=receipt['sha256'] or json.loads(gzip.decompress(source.read_bytes()))!=record['data']:
            raise ValueError('Dynamic asset class source receipt or payload differs')


def object_path(value):
    if isinstance(value,dict):value=value.get('reference','')
    if not isinstance(value,str):return None
    match=re.search(r"(/Game/[^']+)",value)
    return match[1].replace(':','.') if match else None


def strict_guid_paths(rows):
    values={};ambiguous=set();result={}
    for guid,name,outer in rows:
        value=(name,outer)
        if guid in values and values[guid]!=value:ambiguous.add(guid)
        else:values[guid]=value
    def resolve(guid,seen=()):
        if guid in result:return result[guid]
        if guid in seen or guid in ambiguous or guid not in values:return None
        name,outer=values[guid]
        if not isinstance(name,str) or not name:return None
        if name.startswith('/'):path=name
        elif outer is None:path=None
        else:
            parent=resolve(outer,seen+(guid,))
            path=parent+'.'+name if parent else None
        result[guid]=path
        return path
    for guid in values:resolve(guid)
    return result


def walk(value):
    if isinstance(value,dict):
        yield value
        for v in value.values():yield from walk(v)
    elif isinstance(value,list):
        for v in value:yield from walk(v)


def function_source(record,name):
    row=next((e for e in record['data']['exports'] if e['name']==name and e['type']=='UFunction'),None)
    if not row or not row.get('ScriptBytecode') or row['ScriptBytecode'][-1].get('expression_type')!='EX_EndOfScript':
        raise ValueError('Missing complete dynamic geometry program: '+name)
    return row


def transformed(points,matrix):
    points=np.asarray(points,dtype=np.float64);matrix=np.asarray(matrix,dtype=np.float64)
    if matrix.shape!=(4,4) or points.ndim!=2 or points.shape[1]!=3 or not np.isfinite(matrix).all() or not np.isfinite(points).all():
        raise ValueError('Invalid source mesh transform')
    return points@matrix[:3,:3].T+matrix[:3,3]


def corners(low,high):
    return [[x,y,z] for x in [low[0],high[0]] for y in [low[1],high[1]] for z in [low[2],high[2]]]


def source_profiles(evidence):
    """Return immutable actor placement and conservative program-domain bounds.

    The bounds do not certify shader deformation or native scene activation.
    Window translation uses an unbounded vertical column, so desired-state and
    interpolation overshoot cannot create an incorrectly clear modeled ray.
    """
    if evidence.get('schema_version')!=3:raise ValueError('Unsupported dynamic asset evidence')
    classes={object_path(next(e['object_path'] for e in r['data']['exports'] if e['type']=='UBlueprintGeneratedClass')):r for r in evidence['class_records']}
    profiles=[]
    for selected in evidence['selected_actors']:
        actor=selected['actor'];cls=actor['class_path']
        if cls not in CLASSES or cls not in classes:raise ValueError('Unsupported or unbound dynamic actor class')
        path=object_path(actor['object_path']);components={object_path(c['object_path']):c for c in selected['components']}
        source_level=path.split('.PersistentLevel.',1)[0]
        stream=[s for s in evidence['streaming_levels'] if object_path(s['asset'])==source_level]
        if len(stream)!=1 or 'LevelTransform' in stream[0]['properties']:
            raise ValueError('Missing/ambiguous streaming level or unhandled level transform')
        root=object_path(actor['properties'].get('RootComponent'))
        if root not in components:raise ValueError('Dynamic actor root transform is unbound')
        def matrix(component_path,seen=()):
            if component_path in seen or component_path not in components:raise ValueError('Unresolved dynamic component attachment')
            component=components[component_path];props=component['effective_properties']
            if any(props.get(k) is True for k in ['bAbsoluteLocation','bAbsoluteRotation','bAbsoluteScale']) or 'ComponentToWorld' in props:
                raise ValueError('Unsupported absolute dynamic component transform')
            local=np.asarray(component['relative_matrix_cm'],dtype=np.float64)
            parent=object_path(props.get('AttachParent'))
            if parent:return matrix(parent,seen+(component_path,))@local
            if component_path!=root:raise ValueError('Unattached dynamic mesh component')
            return local
        defaults=next(e['properties'] for e in classes[cls]['data']['exports'] if e['name'].startswith('Default__'))
        values={**defaults,**actor['properties']}
        is_door=cls in [WINDOW,DRAWBRIDGE]
        component_name='DoorPiece1' if is_door else 'GameObjectMesh'
        component_path=path+'.'+component_name
        if component_path not in components:raise ValueError('Dynamic render component is missing')
        component=components[component_path];mesh_path=object_path(component['effective_properties'].get('StaticMesh'))
        mesh=evidence['meshes'].get(mesh_path)
        if not mesh:raise ValueError('Dynamic mesh source is unbound')
        vertices=mesh['vertices_cm'];programs=[];domain='serialized_static_render_positions'
        if cls==WINDOW:
            program=function_source(classes[cls],'MoveDoorToPosition');text=json.dumps(program)
            if not all(token in text for token in [':VLerp\'',':K2_SetRelativeLocation\'','DoorStart','DoorOpen']):
                raise ValueError('Window shield motion program changed')
            programs.append(program['object_path'])
            door_path=path+'.Door';parent=object_path(components[door_path]['effective_properties'].get('AttachParent'))
            if not parent:raise ValueError('Window shield motion parent is unbound')
            begin=np.array([float(values['DoorStart'][axis]) for axis in 'XYZ'])
            finish=np.array([float(values['DoorOpen'][axis]) for axis in 'XYZ'])
            delta=finish-begin
            parent_matrix=matrix(parent);world_delta=parent_matrix[:3,:3]@delta
            if abs(world_delta[0])>1e-4 or abs(world_delta[1])>1e-4 or abs(world_delta[2])<1e-4:
                raise ValueError('Window translation no longer follows one world vertical axis')
            mesh_local=np.asarray(component['relative_matrix_cm'],dtype=np.float64)
            door_local=np.asarray(components[door_path]['relative_matrix_cm'],dtype=np.float64).copy()
            poses=[]
            for location in [begin,finish]:
                door_local[:3,3]=location
                poses.append(transformed(vertices,parent_matrix@door_local@mesh_local))
            points=np.concatenate(poses)
            sweep=[points.min(axis=0).tolist(),points.max(axis=0).tolist()]
            bounds=[list(sweep[0]),list(sweep[1])];bounds[0][2]=bounds[1][2]=None
            domain='unbounded_world_vertical_translation_of_serialized_VLerp_program'
        elif cls==DRAWBRIDGE:
            program=function_source(classes[cls],'GetDoorRotation');graph=function_source(classes[cls],'ExecuteUbergraph_Drawbridge')
            rotation=values.get('DoorOpen',{})
            if any(abs(rotation.get(k,math.inf))>1e-5 for k in ['Pitch','Roll']) or ':RLerp\'' not in json.dumps(program):
                raise ValueError('Lotus rotation is not established as a yaw-only source program')
            programs.extend([program['object_path'],graph['object_path']])
            door_path=path+'.Door';parent=object_path(components[door_path]['effective_properties'].get('AttachParent'))
            if not parent:raise ValueError('Lotus rotation parent is unbound')
            local=np.asarray(component['relative_matrix_cm'],dtype=np.float64)
            variants=[local.copy()]
            # ReceiveBeginPlay sets the visible DoorPiece1 location to +100 cm;
            # its serialized -2075 cm position alone would miss the real doorway.
            for node in walk(graph['ScriptBytecode']):
                if node.get('expression_type')!='EX_Context':continue
                text=json.dumps(node.get('ObjectExpression',{}));call=node.get('ContextExpression',{})
                if 'DoorPiece1' not in text or ':K2_SetRelativeLocation\'' not in json.dumps(call.get('StackNode',{})):continue
                first=(call.get('Parameters') or [{}])[0]
                if first.get('expression_type')!='EX_VectorConst':raise ValueError('Unbounded Lotus mesh-local translation')
                variant=local.copy();variant[:3,3]=[first['Value'][axis] for axis in 'XYZ'];variants.append(variant)
            local_points=np.concatenate([transformed(vertices,v) for v in variants])
            radius=float(np.linalg.norm(local_points[:,:2],axis=1).max())
            low=[-radius,-radius,float(local_points[:,2].min())];high=[radius,radius,float(local_points[:,2].max())]
            door_local=np.asarray(components[door_path]['relative_matrix_cm'],dtype=np.float64)
            points=transformed(corners(low,high),matrix(parent)@door_local)
            bounds=sweep=[points.min(axis=0).tolist(),points.max(axis=0).tolist()]
            domain='full_yaw_sweep_including_serialized_and_constant_Blueprint_mesh_locations'
        else:
            points=transformed(vertices,matrix(component_path))
            bounds=sweep=[points.min(axis=0).tolist(),points.max(axis=0).tolist()]
        profiles.append({'id':path,'map_path':'/Game/Maps/'+selected['package'].split('/Maps/')[1].split('/')[0]+'/'+selected['package'].split('/Maps/')[1].split('/')[0],
                         'actor_object_path':path,'class_path':cls,'source_package':selected['package'],
                         'render_component_path':component_path,'health_component_path':object_path(values.get('HealthSection')),
                         'bounds_cm':bounds,'authoring_sweep_bounds_cm':sweep,'bounds_domain':domain,
                         'mesh_source':mesh_path,'program_sources':programs,
                         'streaming_level':stream[0],
                         'material_modes':mesh['material_modes'],'instance_material_overrides':component['effective_properties'].get('OverrideMaterials',[]),
                         'native_geometry_verified':False,'native_activation_verified':False,
                         'dependencies':['achieved_dynamic_geometry_unverified','shader_and_visibility_culling_unverified','asset_replay_build_unverified']})
    if len({p['id'] for p in profiles})!=len(profiles):raise ValueError('Duplicate source dynamic actor profiles')
    return profiles


def segment_intersects_bounds(start,end,bounds):
    low,high=bounds;entry,leave=0.,1.
    if len(start)!=3 or len(end)!=3 or len(low)!=3 or len(high)!=3 or not all(math.isfinite(v) for v in [*start,*end]):
        raise ValueError('Invalid dynamic-region ray')
    for axis in range(3):
        if low[axis] is None and high[axis] is None:continue
        if low[axis] is None or high[axis] is None or not math.isfinite(low[axis]) or not math.isfinite(high[axis]) or low[axis]>high[axis]:
            raise ValueError('Invalid source dynamic-region bounds')
        direction=end[axis]-start[axis]
        if abs(direction)<1e-12:
            if start[axis]<low[axis] or start[axis]>high[axis]:return False
        else:
            a,b=(low[axis]-start[axis])/direction,(high[axis]-start[axis])/direction
            entry=max(entry,min(a,b));leave=min(leave,max(a,b))
            if entry>leave:return False
    return True


def raw_value(row,schema):
    checksum,kind,bits=schema;raw=row.get('raw_bits');bit_count=row.get('bit_count')
    if row.get('compatible_checksum') not in [None,checksum] or bit_count!=bits or not isinstance(raw,bytes) or len(raw)!=(bits+7)//8:
        raise ValueError('Dynamic field payload does not match measured declaration')
    if kind=='float':
        value=struct.unpack('<f',raw)[0]
        if not math.isfinite(value):raise ValueError('Non-finite dynamic motion value')
    else:
        value=int.from_bytes(raw,'little')
        if value>>bits:raise ValueError('Nonzero bits outside dynamic field payload')
        if kind=='bool':value=bool(value)
    typed=[row.get(k) for k in ['value_bool','value_i64','value_f64','value_str'] if row.get(k) is not None]
    if typed and (len(typed)!=1 or typed[0]!=value):raise ValueError('Typed/raw dynamic field disagreement')
    return value


def actor_epochs(rows,duration_ms):
    active={};epochs=[];diagnostics=Counter()
    for row in sorted(rows,key=lambda r:(r['time_ms'],r['packet_id'])):
        guid=row['actor_net_guid'];channel=row['channel_index'];key=(guid,channel)
        if row['event']=='open':
            if key in active:
                active.pop(key).update(end_ms=row['time_ms'],end_packet_id=row['packet_id'],end_reason='overlapping_actor_open_knowledge_reset')
                diagnostics['overlapping_actor_opens']+=1
            epoch={'actor_net_guid':guid,'channel_index':channel,'start_ms':row['time_ms'],'start_packet_id':row['packet_id'],
                   'end_ms':duration_ms,'end_packet_id':None,'end_reason':'export_end_no_close_observed'}
            active[key]=epoch;epochs.append(epoch)
        elif row['event']=='close':
            if key not in active:diagnostics['close_without_actor_open']+=1;continue
            epoch=active.pop(key);epoch.update(end_ms=row['time_ms'],end_packet_id=row['packet_id'],end_reason='channel_close_not_geometry_destruction')
    return epochs,dict(diagnostics)


def extract_dependencies(field_rows,guid_rows,actor_rows,groups,rounds,profiles,duration_ms):
    starts=[r['start_ms'] for r in rounds]
    if starts!=sorted(starts) or any(r['start_ms']>=r['end_ms'] for r in rounds) or any(a['end_ms']>b['start_ms'] for a,b in zip(rounds,rounds[1:])):
        raise ValueError('Dynamic dependencies need disjoint sorted rounds')
    paths=strict_guid_paths(guid_rows);inverse=defaultdict(list)
    for guid,path in paths.items():
        if path:inverse[path].append(guid)
    declarations=defaultdict(list)
    for group in groups:declarations[group['path']].append(group)
    epochs,diagnostics=actor_epochs(actor_rows,duration_ms);bound={};instances=[]
    for profile in profiles:
        guids=inverse[profile['actor_object_path']]
        instance={**profile,'actor_net_guid':guids[0] if len(guids)==1 else None,
                  'actor_identity_status':'exact_source_object_join' if len(guids)==1 else 'missing_or_ambiguous_native_actor',
                  'observations':[],'network_epochs':[],'rounds':[]}
        instances.append(instance)
        if len(guids)!=1:continue
        guid=guids[0];bound[guid]=instance
        instance['network_epochs']=[e for e in epochs if e['actor_net_guid']==guid]
        schema=declarations[profile['class_path']]
        instance['field_declarations']=schema[0]['fields'] if len(schema)==1 else []
    unresolved=[]
    for row in sorted(field_rows,key=lambda r:(r['time_ms'],r['packet_id'],r.get('ordinal',0))):
        if row['actor_net_guid'] not in bound:continue
        instance=bound[row['actor_net_guid']];t=row['time_ms'];packet=row['packet_id'];ri=bisect_right(starts,t)-1
        round_index=rounds[ri]['index'] if ri>=0 and t<rounds[ri]['end_ms'] else None
        own_epoch=[e for e in instance['network_epochs'] if e['channel_index']==row['channel_index'] and
                   (t,packet)>=(e['start_ms'],e['start_packet_id']) and
                   (e['end_packet_id'] is None or (t,packet)<(e['end_ms'],e['end_packet_id']))]
        declaration=None;name=row.get('field_name');schema=None;ownership_valid=True
        if row.get('object_net_guid') is None and row['group_path'] in [instance['class_path'],instance['actor_object_path'].rsplit('.',1)[-1]]:
            matches=[f for f in instance['field_declarations'] if f['handle']==row['handle']]
            if len(matches)==1 and matches[0]['name'] in FIELDS:
                declaration=matches[0];name=declaration['name'];schema=FIELDS[name]
        elif row['group_path']==CHILD_ALIVE_GROUP and name=='bAlive':
            schema=(CHILD_ALIVE_CHECKSUM,'bool',1)
            ownership_valid=(paths.get(row.get('object_net_guid'))==instance['health_component_path'] and
                             inverse[instance['health_component_path']]==[row.get('object_net_guid')])
        if schema is None:continue
        observation={k:row.get(k) for k in ['time_ms','packet_id','channel_index','actor_net_guid','object_net_guid','group_path','handle','compatible_checksum','bit_count']}
        observation.update(field_name=name,round=round_index,raw_hex=row['raw_bits'].hex() if row.get('raw_bits') else '',
                           source_declaration=declaration,evidence='native_field_with_exact_map_actor_and_export_schema',native_geometry_semantics='unverified')
        if len(own_epoch)==1:observation['epoch_start_packet_id']=own_epoch[0]['start_packet_id']
        try:
            if len(own_epoch)!=1:raise ValueError('Native field is outside an unambiguous actor channel epoch')
            if not ownership_valid:raise ValueError('Dynamic health component owner/path is missing or ambiguous')
            if declaration and (declaration['compatible_checksum']!=schema[0] or row.get('field_name') not in [None,name]):
                raise ValueError('Class export field declaration changed')
            observation.update(value=raw_value(row,schema),status='decoded')
        except ValueError as error:
            observation.update(status='unresolved',reason=str(error));unresolved.append(observation)
        instance['observations'].append(observation)
    for instance in instances:
        for round in rounds:
            rows=[r for r in instance['observations'] if r['round']==round['index']]
            instance['rounds'].append({'round':round['index'],'start_ms':round['start_ms'],'end_ms':round['end_ms'],
                                      'observed_field_names':sorted({r['field_name'] for r in rows if r['status']=='decoded'}),
                                      'observed_transition_times_ms':sorted({r['time_ms'] for r in rows}),
                                      'achieved_geometry_status':'unknown','missing_actor_identity':instance['actor_net_guid'] is None})
    return {'schema_version':1,'scope':'source_bound_Ascent_and_Lotus_dynamic_map_dependencies',
            'instances':instances,'unresolved_observations':unresolved,'diagnostics':diagnostics,
            'native_visibility_verified':False,'coverage_complete':False,
            'policy':['An intersected region with unresolved achieved geometry interrupts modeled contacts.',
                      'Desired DoorState, Transition, LocalDoorPos and timestamps are observations, not continuous achieved pose.',
                      'Channel close does not remove map geometry; pre-round and earlier-round state is never silently reused.',
                      'A current-round native bHidden=true observation may omit that actor body in the display model only.']}


def region_dependencies(sidecar,start,end,time_ms,round_index):
    """Positive unknown gating for a pair ray. No native LOS is certified."""
    dependencies=[]
    for instance in sidecar['instances']:
        if not any(r['round']==round_index and r['start_ms']<=time_ms<r['end_ms'] for r in instance['rounds']):
            raise ValueError('Time is outside the requested dynamic round')
        if not segment_intersects_bounds(start,end,instance['bounds_cm']):continue
        current_epochs=[e for e in instance['network_epochs'] if e['start_ms']<=time_ms<e['end_ms']]
        epoch_packet=current_epochs[0]['start_packet_id'] if len(current_epochs)==1 else None
        before=[r for r in instance['observations'] if r['round']==round_index and r['time_ms']<=time_ms and r['field_name']=='bHidden'
                and epoch_packet is not None and r.get('epoch_start_packet_id')==epoch_packet]
        hidden=before[-1] if before else None
        if hidden and hidden['status']=='decoded' and hidden['value'] is True:
            continue
        dependencies.append({'id':instance['id'],'actor_net_guid':instance['actor_net_guid'],
                             'reason':'dynamic_occluder_geometry_unknown','bounds_cm':instance['bounds_cm'],
                             'hidden_observation':hidden,'native_visibility_verified':False})
    return dependencies


def extract_native(con,export,manifest,rounds,profiles):
    guid_rows=con.execute('SELECT net_guid,path,outer_net_guid FROM read_parquet(?)',[str(export/'net_guids.parquet')]).fetchall()
    paths=strict_guid_paths(guid_rows);selected={p['actor_object_path'] for p in profiles}
    ids=[guid for guid,path in paths.items() if path in selected]
    fields=con.execute('SELECT *,row_number() OVER() AS ordinal FROM read_parquet(?) WHERE actor_net_guid IN (SELECT unnest(?)) ORDER BY time_ms,packet_id,ordinal',
                       [str(export/'fields.parquet'),ids])
    names=[x[0] for x in fields.description];field_rows=[dict(zip(names,row)) for row in fields.fetchall()]
    actors=con.execute('SELECT time_ms,packet_id,channel_index,actor_net_guid,event FROM read_parquet(?) WHERE actor_net_guid IN (SELECT unnest(?)) ORDER BY time_ms,packet_id',
                       [str(export/'actors.parquet'),ids])
    names=[x[0] for x in actors.description];actor_rows=[dict(zip(names,row)) for row in actors.fetchall()]
    return extract_dependencies(field_rows,guid_rows,actor_rows,manifest['net_field_export_groups'],rounds,profiles,manifest['duration_ms'])


def validate_sidecar(sidecar,record,assets_path,replay_path=None,verify_parquet=True):
    """Read-only acceptance guard for a published dependency sidecar."""
    export=Path(record['export']);expected={
        'assets_sha256':digest(assets_path),'helper_sha256':digest(__file__),
        'export_manifest_sha256':digest(export/'manifest.json'),'source_replay_sha256':record['source_sha256'],
        'decoder_sha256':record['decoder_sha256'],'decoder_revision':record['decoder_revision']}
    if verify_parquet:
        expected.update(fields_sha256=digest(export/'fields.parquet'),actors_sha256=digest(export/'actors.parquet'),
                        net_guids_sha256=digest(export/'net_guids.parquet'))
    if replay_path is not None:expected['review_replay_sha256']=digest(replay_path)
    if any(sidecar.get('source_provenance',{}).get(k)!=v for k,v in expected.items()):
        raise ValueError('Dynamic sidecar source identity differs')
    if (sidecar.get('match_id')!=record['match_id'] or sidecar.get('map_path')!=record['map_path'] or
        sidecar.get('replay_build')!=record['build'] or sidecar.get('native_visibility_verified') is not False or
        sidecar.get('coverage_complete') is not False):
        raise ValueError('Dynamic sidecar coverage/identity contract differs')
    evidence=json.loads(Path(assets_path).read_text());validate_asset_evidence(evidence)
    profiles={p['id']:p for p in source_profiles(evidence) if p['map_path']==record['map_path']}
    instances=sidecar.get('instances',[])
    if len(instances)!=len(profiles) or len({p.get('id') for p in instances})!=len(instances):
        raise ValueError('Dynamic sidecar source actor inventory differs')
    for instance in instances:
        profile=profiles.get(instance.get('id'))
        if profile is None or any(instance.get(k)!=v for k,v in profile.items()):
            raise ValueError('Dynamic sidecar actor placement/program contract differs')
    return True


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus',type=Path);parser.add_argument('review',type=Path)
    parser.add_argument('--assets',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    if args.out.exists():raise ValueError('Dynamic evidence output already exists; use a new directory')
    evidence=json.loads(args.assets.read_text());validate_asset_evidence(evidence);profiles=source_profiles(evidence)
    corpus=json.loads(args.corpus.read_text());import duckdb
    con=duckdb.connect();args.out.mkdir(parents=True)
    index=[]
    for record in corpus['replays']:
        if record.get('status')!='validated' or not any(p['map_path']==record['map_path'] for p in profiles):continue
        export=Path(record['export']);manifest_path=export/'manifest.json';manifest=json.loads(manifest_path.read_text())
        replay_path=args.review/'library'/record['match_id']/'replay.json';replay=json.loads(replay_path.read_text())
        provenance=json.loads((replay_path.parent/'provenance.json').read_text())
        if (provenance.get('replay_export_manifest_sha256')!=digest(manifest_path) or replay['replay_build']!=record['build'] or
            replay['match_id']!=record['match_id'] or manifest['replay_build']!=record['build'] or
            replay['source_provenance']['source_replay_sha256']!=record['source_sha256']):
            raise ValueError('Dynamic evidence corpus/viewer/export identity mismatch')
        relevant=[p for p in profiles if p['map_path']==record['map_path']]
        result=extract_native(con,export,manifest,replay['rounds'],relevant)
        result.update(match_id=record['match_id'],map_path=record['map_path'],replay_build=record['build'],clock='decoded replay milliseconds',
                      source_provenance={'assets_sha256':digest(args.assets),'helper_sha256':digest(__file__),
                                         'export_manifest_sha256':digest(manifest_path),'review_replay_sha256':digest(replay_path),
                                         'source_replay_sha256':record['source_sha256'],'fields_sha256':digest(export/'fields.parquet'),
                                         'actors_sha256':digest(export/'actors.parquet'),'net_guids_sha256':digest(export/'net_guids.parquet'),
                                         'decoder_sha256':record['decoder_sha256'],'decoder_revision':record['decoder_revision'],
                                         'asset_mapping_sha256':evidence['mapping_sha256'],'asset_archives':evidence['archives']})
        output=args.out/(record['match_id']+'.json');output.write_text(json.dumps(result,indent=2),encoding='utf-8')
        index.append({'match_id':record['match_id'],'file':output.name,'sha256':digest(output),'instances':len(result['instances']),
                      'observations':sum(len(i['observations']) for i in result['instances']),
                      'unresolved':len(result['unresolved_observations'])})
    (args.out/'index.json').write_text(json.dumps({'schema_version':1,'assets_sha256':digest(args.assets),'helper_sha256':digest(__file__),
                                                'replays':index,'source_profiles':profiles,'native_visibility_verified':False},indent=2),encoding='utf-8')
    print(json.dumps({'replays':len(index),'instances':sum(x['instances'] for x in index),'observations':sum(x['observations'] for x in index),
                      'unresolved':sum(x['unresolved'] for x in index),'out':str(args.out)}))


if __name__=='__main__':main()
