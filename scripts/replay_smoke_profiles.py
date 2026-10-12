"""Additional smoke shell models and independently recorded native smoke inputs.

All outputs are add-on artifacts. Canonical replay exports/model files remain
unchanged. Serialized shells and clocks are conditional models, not native
visual opacity or validated activation/destruction events.
"""
from __future__ import annotations
import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import duckdb
from replay_asset_model import reference_package, curve_value
from replay_transcription import unpack_reference

ROOT = Path(__file__).resolve().parent.parent
BASE = 'ShooterGame/Content/'
PARENT = BASE+'Characters/Global/Smoke/GameObject_NewSmokeZone_Parent.uasset'
TARGETS = {
    BASE+'Characters/Sarge/S0/Ability_MapTargetSmoke/GameObject_Sarge_4_Smoke_ProductionNEW.uasset': 'Brimstone',
    BASE+'Characters/Smonk/S0/Ability_E/MapTargetSmoke/GameObject_Smonk_NewSmoke.uasset': 'Clove',
}


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def object_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def class_path(path):
    name = path.rsplit('/', 1)[-1][:-7]
    return '/Game/'+path[len(BASE):-7]+'.'+name+'_C'


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():yield from walk(child)
    elif isinstance(value, list):
        for child in value:yield from walk(child)


def make_profiles(source, model):
    if source['archives'] != model['archives'] or source['mapping_sha256'] != model['mapping_sha256']:
        raise ValueError('Smoke source and canonical model mappings/archive receipts differ')
    packages = {p['package']: p for p in source['packages']}
    if any(p.get('error') for p in packages.values()):
        raise ValueError('Smoke source inspection contains an unresolved package')
    def inherited(path, export=None, seen=None):
        seen = set() if seen is None else seen
        if path in seen:raise ValueError('Smoke inheritance cycle')
        seen.add(path); rows = packages[path]['exports']
        cls = next((e for e in rows if e['type']=='UBlueprintGeneratedClass'), None)
        parent = reference_package(cls.get('SuperStruct')) if cls else None
        values, origins = inherited(parent, export, seen) if parent else ({}, {})
        row = next((e for e in rows if e['name']==export), None) if export else next((e for e in rows if e['name'].startswith('Default__')), None)
        if row:
            for name, value in row['properties'].items():values[name], origins[name] = value, path+':'+row['name']+'.'+name
        return values, origins
    parent = {e['name']:e for e in packages[PARENT]['exports']}
    graph = parent['ExecuteUbergraph_GameObject_NewSmokeZone_Parent']['ScriptBytecode']
    def node(index, kind):
        row = next((n for n in graph if n['StatementIndex']==index), None)
        if not row or row['expression_type'] != kind:raise ValueError('Smoke parent behavior differs at '+str(index))
        return row
    for index, name in [(2351,'StartIntroLoopEffect'),(2365,'ResetSmokeScale'),(2380,'StopSmokeContract'),(2394,'ExpandTimeline')]:
        if node(index,'EX_LocalVirtualFunction')['VirtualFunctionName'] != name:
            raise ValueError('Smoke expansion sequence differs')
    rate = node(2197,'EX_Let')['Assignment']
    if not rate['StackNode']['reference'].endswith("KismetMathLibrary:Divide_DoubleDouble'") or \
       rate['Parameters'][0].get('Value') != 1.0 or rate['Parameters'][1]['Variable']['New']['Path'] != ['SmokeExpandDuration']:
        raise ValueError('Smoke expansion rate binding differs')
    scale = parent['SetSmokeScaleByPercentage']['ScriptBytecode']
    if not any(n.get('StackNode',{}).get('reference','').endswith("SceneComponent:SetWorldScale3D'") for n in walk(scale)):
        raise ValueError('SmokeScene scale program is unavailable')
    nodes={e['properties'].get('InternalVariableName'):e for e in parent.values() if e['type']=='USCS_Node'}
    for enclosing,child in [('SmokeScene','VisionBlockingSphere'),('VisionBlockingSphere','HollowVisionBlockingSphere')]:
        refs=[n['reference'] for n in nodes[enclosing]['properties']['ChildNodes']]
        if not any(ref.endswith('.'+nodes[child]['name']+"'") for ref in refs):
            raise ValueError('Smoke shell attachment hierarchy differs')
    profiles, meshes = {}, {}
    def curve(ref):
        path = reference_package(ref)
        row = next(e for e in packages[path]['exports'] if e['type']=='UCurveFloat')
        native = row['properties'].get('FloatCurve', row.get('FloatCurve'))
        keys=[]
        for k in native['Keys']:
            mode, weight=k['InterpMode']['value__'],k['TangentWeightMode']['value__']
            values=[k['Time'],k['Value'],mode,k['ArriveTangent'],k['LeaveTangent']]
            if mode not in (0,1,2) or weight or not all(math.isfinite(v) for v in values):
                raise ValueError('Unverified weighted/nonfinite smoke curve: '+path)
            keys.append(values)
        if not keys or any(a[0]>=b[0] for a,b in zip(keys,keys[1:])):raise ValueError('Invalid smoke curve times')
        return {'source':path,'keys':keys,'source_export_sha256':object_hash(row)}
    for path, agent in TARGETS.items():
        rows=packages[path]['exports']; cls=next(e for e in rows if e['type']=='UBlueprintGeneratedClass')
        if reference_package(cls['SuperStruct'])!=PARENT:raise ValueError('Smoke class no longer inherits verified parent')
        # Overrides must retain the parent call; their remaining observed logic
        # only changes the minimap brush in these exact serialized programs.
        override='ExpandSmoke' if agent=='Brimstone' else 'ReceiveBeginPlay'
        child_graph=next(e['ScriptBytecode'] for e in rows if e['name'].startswith('ExecuteUbergraph_'))
        if not any(n.get('StackNode',{}).get('reference','').endswith('GameObject_NewSmokeZone_Parent_C:'+override+"'") for n in walk(child_graph)):
            raise ValueError('Smoke override does not invoke verified parent callback')
        defaults, origins=inherited(path)
        sphere, sphere_origins=inherited(path,'VisionBlockingSphere_GEN_VARIABLE')
        hollow, hollow_origins=inherited(path,'HollowVisionBlockingSphere_GEN_VARIABLE')
        radii=[sphere['SphereRadius']*sphere['RelativeScale3D'][axis] for axis in 'XYZ']
        if max(radii)-min(radii)>.01 or min(radii)<=0:raise ValueError('Nonuniform/invalid smoke volume sphere')
        mesh_path=reference_package(hollow['StaticMesh']); mesh_exports=packages[mesh_path]['exports']
        fresh=next(e['mesh_lod0'] for e in mesh_exports if 'mesh_lod0' in e)
        collision=next(e['properties']['CollisionTraceFlag'] for e in mesh_exports if e['type']=='UBodySetup')
        if collision!='ECollisionTraceFlag::CTF_UseComplexAsSimple':raise ValueError('Smoke shell collision differs')
        cached=model['shell_meshes'].get(mesh_path)
        if not cached or cached['vertices']!=fresh['vertices'] or cached['indices']!=fresh['indices'] or cached['collision_trace_flag']!=collision:
            raise ValueError('Existing smoke geometry differs from fresh installed asset inspection')
        meshes[mesh_path]=dict(cached)
        scale=[sphere['RelativeScale3D'][axis]*hollow['RelativeScale3D'][axis] for axis in 'XYZ']
        boundary_radius=max(math.sqrt(sum((v[i]*scale[i])**2 for i in range(3))) for v in fresh['vertices'])
        buffs=[reference_package(ref) for ref in defaults.get('InsideSmokeBuffs',[])]
        durations={name:defaults[name]*1000 for name in ['SmokeDelayTime','SmokeExpandDuration','SmokeDuration','SmokeContractDuration']}
        if any(not math.isfinite(v) or v<0 for v in durations.values()):raise ValueError('Invalid smoke timing defaults')
        profiles[class_path(path)]={'agent':agent,'radius_cm':sum(radii)/3,'delay_ms':durations['SmokeDelayTime'],
            'expand_ms':durations['SmokeExpandDuration'],'duration_ms':durations['SmokeDuration'],'contract_ms':durations['SmokeContractDuration'],
            'expand_curve':curve(defaults['ExpandCurve']),'contract_curve':curve(defaults['ContractCurve']),'blind_curve':None,
            'sources':{k:origins[k] for k in durations},'sphere_sources':{k:sphere_origins[k] for k in ['SphereRadius','RelativeScale3D']},
            'boundary_shell':{'mesh':mesh_path,'scale':scale,'bounding_radius_cm':boundary_radius,
                'sources':{k:hollow_origins[k] for k in ['StaticMesh','RelativeScale3D']},'geometry_sha256':object_hash(cached)},
            'interior':{'kind':'unresolved_native_vision','inside_buff_packages':buffs,
                'separate_recipient_nearsight_effect':class_path(BASE+'Characters/Sarge/S0/Ability_MapTargetSmoke/FXC_Sarge_4_SmokeNearsight_Production.uasset') if agent=='Brimstone' else None,
                'meaning':'Volume membership and authored buffs are inputs; they do not certify opaque interior or perceptible distance.'},
            'intro_loop_effect_class':class_path(reference_package(defaults['FXC_SmokeIntroLoop'])),
            'behavior_evidence':{'parent_package':PARENT,'parent_program_sha256':object_hash(graph),
                'child_override':override,'child_program_sha256':object_hash(child_graph),
                'expansion_calls':[2351,2365,2380,2394],'sphere_collision_enabled':sphere['BodyInstance']['CollisionEnabled'],
                'shell_collision_enabled':hollow['BodyInstance']['CollisionEnabled'],
                'shell_attachment_nodes':['SmokeScene','VisionBlockingSphere','HollowVisionBlockingSphere'],
                'shell_attachment_nodes_sha256':object_hash([nodes[k] for k in ['SmokeScene','VisionBlockingSphere','HollowVisionBlockingSphere']])},
            'activation_clock_verified':False,'native_visual_opacity_verified':False,'interior_visibility_verified':False}
    return {'schema_version':1,'kind':'additional_asset_smoke_shell_profiles','mapping_sha256':source['mapping_sha256'],
        'archives':source['archives'],'smoke_profiles':profiles,'shell_meshes':meshes,
        'source_packages':{p:object_hash(row) for p,row in packages.items()},
        'limitations':['Actor channel open/close is not a validated native activation/destruction clock.',
            'Intro-loop RPC supplies a conditional expansion clock; replicated timing versus native client shader/timeline start is unverified.',
            'Shell crossing uses double-sided mesh triangles; native sidedness and visual material behavior remain unverified.',
            'Interior visibility is unresolved. Brimstone recipient nearsight stays an independently observed effect.',
            'Serialized timers/radii can be changed by runtime state; replay/build asset parity is unverified.']}


def extract_instances(actors, fields, effects, profiles, players, rounds, player_states=None):
    diagnostics=Counter(); instances=[]; opens={}; starts=[r['start_ms'] for r in rounds]
    by_body={guid:p['subject'] for p in players for guid in p.get('bodies',[])}
    by_state=player_states or {p['actor_net_guid']:p['subject'] for p in players if 'actor_net_guid' in p}
    bindings=defaultdict(list); by_actor=defaultdict(list)
    for t,packet,actor,name,string,raw in fields:
        by_actor[actor].append((t,packet,name,string,raw))
        if name in ['Owner','PlayerState'] and raw:
            try:bindings[(actor,name)].append((t,packet,unpack_reference(raw)))
            except ValueError:diagnostics['unresolved_owner_reference']+=1
    for rows in bindings.values():rows.sort(key=lambda r:(r[0],r[1]))
    def owner(guid,t,packet,seen=None):
        seen=set() if seen is None else seen
        if guid in by_body:return by_body[guid],[{'actor_net_guid':guid,'kind':'player_body'}]
        if guid in seen or len(seen)>8:return None,[]
        seen.add(guid)
        for name in ['PlayerState','Owner']:
            rows=[r for r in bindings[(guid,name)] if (r[0],r[1])<=(t,packet)]
            if not rows:continue
            observed,observed_packet,target=rows[-1]
            subject,chain=(by_state.get(target),[]) if name=='PlayerState' else owner(target,t,packet,seen.copy())
            if subject:return subject,[{'actor_net_guid':guid,'field':name,'target_net_guid':target,
                'time_ms':observed,'packet_id':observed_packet},*chain]
        return None,[]
    for t,packet,guid,event,cls,x,y,z in actors:
        if event=='open' and cls in profiles:
            ri=bisect_right(starts,t)-1
            if ri<0 or t>=rounds[ri]['end_ms'] or any(v is None or not math.isfinite(v) for v in [x,y,z]):
                diagnostics['missing_smoke_spawn_position_or_round']+=1;continue
            round=rounds[ri]; profile=profiles[cls]
            if guid in opens:
                prior=opens.pop(guid)
                prior.update(end_ms=t,end_reason='observed_channel_reopen',channel_close_ms=t,channel_close_packet_id=packet)
            row={'id':f'additional-smoke-{guid}-{packet}','actor_net_guid':guid,'profile':cls,'round':round['index'],
                'channel_open_ms':t,'channel_open_packet_id':packet,'start_ms':t,
                'end_ms':round['end_ms'],'end_reason':'round_boundary','positions':[[t,x,y,z]],'subject':None,
                'native_actor_open_observation':{'time_ms':t,'packet_id':packet,'class_path':cls,'spawn_cm':[x,y,z]},
                'activation_clock_verified':False,'native_visual_opacity_verified':False,'interior_visibility_verified':False}
            opens[guid]=row;instances.append(row)
        elif event=='close' and guid in opens:
            row=opens.pop(guid)
            if t<row['end_ms']:row.update(end_ms=t,end_reason='observed_channel_close',channel_close_ms=t,channel_close_packet_id=packet)
    for row in instances:
        profile=profiles[row['profile']]; lifecycle_start=row['channel_open_ms']; lifecycle_end=row['end_ms']
        opened=(lifecycle_start,row['channel_open_packet_id'])
        closed=(lifecycle_end,row.get('channel_close_packet_id',float('-inf')))
        loops=[e for e in effects if e['actor_net_guid']==row['actor_net_guid'] and e['round']==row['round'] and
            e['effect_class']==profile['intro_loop_effect_class'] and
            opened<=(e['start_ms'],e.get('start_packet_id',float('inf')))<closed]
        row['intro_loop_observations']=loops
        if len(loops)==1:
            loop=loops[0];row['candidate_expansion_start_ms']=loop['start_ms']
            row['start_ms']=loop['start_ms']-profile['delay_ms']
            row['model_clock_basis']='observed_intro_loop_rpc_minus_serialized_delay'
            diagnostics['smokes_with_intro_loop_rpc_clock']+=1
        else:
            row['model_clock_basis']='channel_open_plus_serialized_delay'
            row['activation_gap']='missing_intro_loop_rpc' if not loops else 'multiple_intro_loop_rpc_starts'
            diagnostics[row['activation_gap']]+=1
        model_end=row['start_ms']+profile['delay_ms']+profile['duration_ms']+profile['contract_ms']
        if model_end<row['end_ms']:row.update(end_ms=model_end,end_reason='serialized_asset_duration_model')
        row['serialized_model_end_ms']=model_end
        for t,packet,name,string,raw in by_actor[row['actor_net_guid']]:
            if not opened<=(t,packet)<closed:continue
            if name=='Instigator' and raw:
                try:
                    target=unpack_reference(raw);subject,chain=owner(target,t,packet)
                    row.setdefault('instigator_observations',[]).append({'time_ms':t,'packet_id':packet,'target_net_guid':target,
                        'subject':subject,'owner_join':chain})
                    if row['subject'] is None and subject:
                        row.update(subject=subject,instigator_join=chain,subject_evidence_time_ms=t,subject_evidence_packet_id=packet)
                except ValueError:diagnostics['unresolved_instigator_reference']+=1
            elif name=='ReplicatedMovement' and string:
                location=json.loads(string)['location'];position=[location[axis] for axis in 'xyz']
                if all(math.isfinite(v) for v in position):
                    row.setdefault('native_movement_observations',[]).append({'time_ms':t,'packet_id':packet,'location_cm':position})
                if all(math.isfinite(v) for v in position) and position!=row['positions'][-1][1:]:
                    row['positions'].append([t,*position])
        diagnostics['smoke_owners_unresolved']+=row['subject'] is None
    diagnostics['additional_smoke_instances']=len(instances)
    return instances,dict(diagnostics)


def validate_replay(sidecar, record, replay_path, smoke_model):
    """Reject stale/mismatched add-ons before merging analysis-only smoke inputs.

    Sidecar smoke_model_sha256 is the canonical object hash, whereas the index
    smoke_model_sha256 hashes the saved JSON file bytes. Both identities matter.
    This verifies input provenance only; native visibility remains unverified.
    """
    replay_path=Path(replay_path);export=Path(record['export'])
    if sidecar.get('schema_version')!=1 or sidecar.get('kind')!='additional_observed_smoke_inputs':
        raise ValueError('Unsupported smoke replay sidecar schema')
    if smoke_model.get('schema_version')!=1 or smoke_model.get('kind')!='additional_asset_smoke_shell_profiles':
        raise ValueError('Unsupported smoke model schema')
    if sidecar.get('match_id')!=record['match_id']:raise ValueError('Smoke sidecar match identity differs')
    data=json.loads(replay_path.read_text(encoding='utf-8'))
    published=json.loads(replay_path.with_name('provenance.json').read_text(encoding='utf-8'))
    provenance=sidecar['source_provenance'];model_provenance=smoke_model['source_provenance']
    if data.get('match_id')!=record['match_id']:raise ValueError('Published replay match identity differs')
    if any(p.get('source_replay_sha256')!=record['source_sha256'] for p in
        [provenance,data['source_provenance'],published['source_provenance']]):
        raise ValueError('Smoke replay source identity differs')
    expected={
        'source_replay_sha256':Path(record['source']),
        'published_replay_sha256':replay_path,
        'replay_export_manifest_sha256':export/'manifest.json',
        'actors_parquet_sha256':export/'actors.parquet',
        'fields_parquet_sha256':export/'fields.parquet',
        'generator_sha256':Path(__file__),
    }
    for key,path in expected.items():
        if provenance.get(key)!=sha(path):raise ValueError('Smoke sidecar '+key+' differs')
    if published.get('replay_export_manifest_sha256')!=provenance['replay_export_manifest_sha256'] or \
       data.get('export_manifest_sha256')!=provenance['replay_export_manifest_sha256']:
        raise ValueError('Published replay/export manifest identity differs')
    if provenance.get('smoke_model_sha256')!=object_hash(smoke_model):raise ValueError('Smoke sidecar model object hash differs')
    expected_model={
        'source_json_sha256':Path(model_provenance['source_json_file']),
        'canonical_model_sha256':Path(model_provenance['canonical_model_file']),
        'generator_sha256':Path(__file__),
        'asset_inspector_sha256':ROOT/'scripts/inspect-transcription-assets.py',
        'asset_decoder_setup_sha256':ROOT/'scripts/export-transcription-map.py',
    }
    for key,path in expected_model.items():
        if model_provenance.get(key)!=sha(path):raise ValueError('Smoke model '+key+' differs')
    if published.get('gameplay_asset_model_sha256')!=model_provenance['canonical_model_sha256']:
        raise ValueError('Published canonical model identity differs')
    baseline=data['asset_state']['model']
    if baseline.get('mapping_sha256')!=smoke_model['mapping_sha256'] or baseline.get('archives')!=smoke_model['archives']:
        raise ValueError('Smoke model and replay asset receipts differ')
    if sidecar.get('native_activation_clock_verified') is not False or sidecar.get('native_visual_opacity_verified') is not False:
        raise ValueError('Smoke sidecar incorrectly claims verified native visibility')
    return {'valid':True,'source_replay_sha256':provenance['source_replay_sha256'],
        'smoke_model_object_sha256':provenance['smoke_model_sha256'],'native_visibility_certified':False}


def build_replay(record, review, smoke_model, output):
    directory=review/'library'/record['match_id'];data=json.loads((directory/'replay.json').read_text(encoding='utf-8'))
    if data['source_provenance']['source_replay_sha256']!=record['source_sha256']:raise ValueError('Published replay identity differs')
    export=Path(record['export']); actors_path=export/'actors.parquet'; fields_path=export/'fields.parquet'
    with duckdb.connect() as con:
        con.execute('SET threads=2')
        actors=con.execute('SELECT time_ms,packet_id,actor_net_guid,event,class_path,spawn_x,spawn_y,spawn_z FROM read_parquet(?) ORDER BY time_ms,packet_id',[str(actors_path)]).fetchall()
        guids=list({r[2] for r in actors if r[3]=='open' and r[4] in smoke_model['smoke_profiles']})
        fields=con.execute("SELECT time_ms,packet_id,actor_net_guid,field_name,value_str,raw_bits FROM read_parquet(?) WHERE object_net_guid IS NULL AND (field_name IN ('Owner','PlayerState') OR (actor_net_guid IN (SELECT unnest(?)) AND field_name IN ('ReplicatedMovement','Instigator'))) ORDER BY time_ms,packet_id",[str(fields_path),guids]).fetchall() if guids else []
    manifest=export/'manifest.json';provenance=json.loads((directory/'provenance.json').read_text(encoding='utf-8'))
    if sha(manifest)!=provenance['replay_export_manifest_sha256']:raise ValueError('Published replay/export manifest differs')
    player_states={p['actor_net_guid']:p['subject'] for p in json.loads(manifest.read_text(encoding='utf-8'))['players']}
    instances,diagnostics=extract_instances(actors,fields,data['asset_state']['observations']['continuous_effects'],smoke_model['smoke_profiles'],data['players'],data['rounds'],player_states)
    result={'schema_version':1,'kind':'additional_observed_smoke_inputs','match_id':record['match_id'],
        'smoke_instances':instances,'diagnostics':diagnostics,'source_provenance':{'source_replay_sha256':record['source_sha256'],
            'replay_export_manifest_sha256':sha(manifest),'published_replay_sha256':sha(directory/'replay.json'),
            'actors_parquet_sha256':sha(actors_path),'fields_parquet_sha256':sha(fields_path),
            'smoke_model_sha256':object_hash(smoke_model),'generator_sha256':sha(__file__)},
        'native_activation_clock_verified':False,'native_visual_opacity_verified':False}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(result,indent=2,allow_nan=False),encoding='utf-8')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('--model',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path);parser.add_argument('--corpus',type=Path);parser.add_argument('--review',type=Path)
    args=parser.parse_args();model=make_profiles(json.loads(args.source.read_text(encoding='utf-8')),json.loads(args.model.read_text(encoding='utf-8')))
    model['source_provenance']={'source_json_file':str(args.source.resolve()),'canonical_model_file':str(args.model.resolve()),
        'source_json_sha256':sha(args.source),'canonical_model_sha256':sha(args.model),'generator_sha256':sha(__file__),
        'asset_inspector_sha256':sha(ROOT/'scripts/inspect-transcription-assets.py'),'asset_decoder_setup_sha256':sha(ROOT/'scripts/export-transcription-map.py')}
    args.out.mkdir(parents=True,exist_ok=True);(args.out/'smoke-model.json').write_text(json.dumps(model,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps({'smoke_profiles':len(model['smoke_profiles']),'shell_meshes':len(model['shell_meshes'])}),flush=True)
    if args.corpus:
        if not args.review:raise ValueError('--review is required with --corpus')
        totals=Counter();replays=[]
        for record in json.loads(args.corpus.read_text(encoding='utf-8'))['replays']:
            if record['status']!='validated':continue
            output=args.out/'replays'/f"{record['match_id']}.json"
            result=build_replay(record,args.review,model,output);totals.update(result['diagnostics'])
            replays.append({'match_id':record['match_id'],'file':str(output.relative_to(args.out)),'sha256':sha(output),'diagnostics':result['diagnostics']})
            print(record['match_id'],len(result['smoke_instances']),flush=True)
        (args.out/'index.json').write_text(json.dumps({'schema_version':1,'smoke_model_file':'smoke-model.json','smoke_model_sha256':sha(args.out/'smoke-model.json'),
            'replays':replays,'totals':dict(totals),'corpus_sha256':sha(args.corpus),'native_visibility_certified':False},indent=2),encoding='utf-8')


if __name__=='__main__':main()
