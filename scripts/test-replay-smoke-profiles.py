"""Extra smoke shapes, source receipts and exact replay observation boundaries."""
import copy
from contextlib import contextmanager
import gzip
import json
from pathlib import Path
import shutil
import unittest
import uuid
from replay_smoke_profiles import make_profiles, extract_instances, class_path, TARGETS, validate_replay, sha, object_hash
from replay_asset_model import smoke_radius, smoke_intersection

ROOT=Path(__file__).resolve().parent.parent


@contextmanager
def scratch_directory():
    # tempfile's restrictive Windows directory ACL prevents sandbox access.
    directory=ROOT/'.local'/('smoke-profile-test-'+uuid.uuid4().hex)
    directory.mkdir()
    try:yield directory
    finally:
        if not directory.resolve().is_relative_to((ROOT/'.local').resolve()):raise ValueError('Unsafe test cleanup path')
        shutil.rmtree(directory)


def ref(value):
    raw=[]
    while True:
        rest=value>>7;raw.append(((value&127)<<1)|bool(rest));value=rest
        if not rest:return bytes(raw)


class SmokeProfilesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=json.loads(gzip.decompress((ROOT/'tests/fixtures/replay-smoke-profiles-13.06.json.gz').read_bytes()))
        cls.addon=make_profiles(cls.fixture['source'],cls.fixture['canonical_model'])
        cls.classes={value:class_path(path)for path,value in TARGETS.items()}

    def test_real_brim_and_clove_defaults_and_interior_uncertainty_are_separate(self):
        brim=self.addon['smoke_profiles'][self.classes['Brimstone']];clove=self.addon['smoke_profiles'][self.classes['Clove']]
        self.assertEqual(brim['radius_cm'],410);self.assertEqual(clove['radius_cm'],410)
        self.assertEqual([brim[k]for k in ['delay_ms','expand_ms','duration_ms','contract_ms']],[1000,750,19250,500])
        self.assertEqual([clove[k]for k in ['delay_ms','expand_ms','duration_ms','contract_ms']],[1000,750,13500,500])
        self.assertIsNotNone(brim['interior']['separate_recipient_nearsight_effect'])
        self.assertIsNone(clove['interior']['separate_recipient_nearsight_effect'])
        for profile in [brim,clove]:
            self.assertFalse(profile['interior_visibility_verified']);self.assertFalse(profile['activation_clock_verified'])
            self.assertEqual(profile['behavior_evidence']['sphere_collision_enabled'],'ECollisionEnabled::NoCollision')
            self.assertEqual(profile['behavior_evidence']['shell_collision_enabled'],'ECollisionEnabled::QueryOnly')

    def test_class_specific_shell_scales_do_not_collapse_to_volume_radius(self):
        brim=self.addon['smoke_profiles'][self.classes['Brimstone']];clove=self.addon['smoke_profiles'][self.classes['Clove']]
        self.assertGreater(brim['boundary_shell']['bounding_radius_cm'],410)
        self.assertLess(clove['boundary_shell']['bounding_radius_cm'],400)
        self.assertEqual(self.addon['shell_meshes'],self.fixture['canonical_model']['shell_meshes'])
        hit=smoke_intersection(self.addon,clove,[-1000,0,0],[1000,0,0],[0,0,0],410)
        self.assertTrue(hit['boundary']);self.assertFalse(hit['inside_observer']);self.assertFalse(hit['inside_target'])
        inside=smoke_intersection(self.addon,clove,[0,0,0],[100,0,0],[0,0,0],410)
        self.assertFalse(inside['boundary']);self.assertTrue(inside['inside_observer']);self.assertTrue(inside['inside_target'])

    def test_actual_curve_growth_and_contract_are_sampled_at_distinct_phase_times(self):
        brim=self.addon['smoke_profiles'][self.classes['Brimstone']];clove=self.addon['smoke_profiles'][self.classes['Clove']]
        self.assertEqual(smoke_radius(brim,999),0)
        self.assertAlmostEqual(smoke_radius(brim,1000),41,places=5)
        self.assertAlmostEqual(smoke_radius(clove,1270),205,places=3)
        self.assertAlmostEqual(smoke_radius(clove,1750),410,places=4)
        self.assertEqual(smoke_radius(brim,1000+19250+250),0)
        self.assertAlmostEqual(smoke_radius(clove,1000+13500+390),410,places=4)
        self.assertEqual(smoke_radius(clove,1000+13500+450),0)

    def test_build_mismatch_changed_geometry_and_weighted_curves_fail_explicitly(self):
        model=copy.deepcopy(self.fixture['canonical_model']);model['mapping_sha256']='changed'
        with self.assertRaisesRegex(ValueError,'receipts differ'):make_profiles(self.fixture['source'],model)
        model=copy.deepcopy(self.fixture['canonical_model']);next(iter(model['shell_meshes'].values()))['vertices'][0][0]+=1
        with self.assertRaisesRegex(ValueError,'geometry differs'):make_profiles(self.fixture['source'],model)
        source=copy.deepcopy(self.fixture['source'])
        curve=next(p for p in source['packages']if p['package'].endswith('Curve_Sarge_4_SmokeExpand.uasset'))
        curve['exports'][0]['properties']['FloatCurve']['Keys'][0]['TangentWeightMode']['value__']=1
        with self.assertRaisesRegex(ValueError,'weighted/nonfinite'):make_profiles(source,self.fixture['canonical_model'])
        source=copy.deepcopy(self.fixture['source'])
        parent=next(p for p in source['packages'] if p['package'].endswith('GameObject_NewSmokeZone_Parent.uasset'))
        sphere=next(e for e in parent['exports'] if e['type']=='USCS_Node' and e['properties'].get('InternalVariableName')=='VisionBlockingSphere')
        sphere['properties']['ChildNodes']=[]
        with self.assertRaisesRegex(ValueError,'attachment hierarchy'):make_profiles(source,self.fixture['canonical_model'])

    def test_override_must_invoke_verified_parent_callback(self):
        source=copy.deepcopy(self.fixture['source']);package=next(p for p in source['packages']if p['package'].endswith('GameObject_Sarge_4_Smoke_ProductionNEW.uasset'))
        graph=next(e['ScriptBytecode']for e in package['exports']if e['name'].startswith('ExecuteUbergraph_'))
        graph[1]['StackNode']['reference']="Class'/Script/Engine.Actor:ReceiveTick'"
        with self.assertRaisesRegex(ValueError,'parent callback'):make_profiles(source,self.fixture['canonical_model'])

    def instances(self,actors=None,fields=None,effects=None):
        cls=self.classes['Clove'];profile=self.addon['smoke_profiles'][cls]
        actors=actors or [(100,2,30,'open',cls,0,0,0),(16000,40,30,'close',None,None,None,None)]
        effects=effects if effects is not None else [{'id':'loop','actor_net_guid':30,'effect_class':profile['intro_loop_effect_class'],
            'round':0,'start_ms':1120,'end_ms':14620,'start_packet_id':4,'end_reason':'observed_stop_rpc'}]
        return extract_instances(actors,fields or [],effects,self.addon['smoke_profiles'],
            [{'subject':'a','bodies':[10]},{'subject':'b','bodies':[20]}],[{'index':0,'start_ms':0,'end_ms':20000}],{90:'a'})

    def test_matching_intro_loop_observation_supplies_only_a_conditional_model_clock(self):
        rows,diagnostics=self.instances();row=rows[0]
        self.assertEqual(row['channel_open_ms'],100);self.assertEqual(row['start_ms'],120)
        self.assertEqual(row['candidate_expansion_start_ms'],1120)
        self.assertEqual(row['end_ms'],15120)
        self.assertFalse(row['activation_clock_verified']);self.assertEqual(row['end_reason'],'serialized_asset_duration_model')
        self.assertEqual(diagnostics['smokes_with_intro_loop_rpc_clock'],1)

    def test_rpc_actor_round_and_lifecycle_identity_do_not_bind_other_smoke_clocks(self):
        profile=self.addon['smoke_profiles'][self.classes['Clove']]
        for extra in [{'actor_net_guid':40},{'round':1},{'start_ms':50},{'effect_class':'other'}]:
            effect={'actor_net_guid':30,'round':0,'start_ms':1120,'effect_class':profile['intro_loop_effect_class'],**extra}
            row=self.instances(effects=[effect])[0][0]
            self.assertEqual(row['start_ms'],100);self.assertEqual(row['activation_gap'],'missing_intro_loop_rpc')
        effect={'actor_net_guid':30,'round':0,'start_ms':1120,'effect_class':profile['intro_loop_effect_class']}
        row=self.instances(effects=[effect,{**effect,'start_ms':2120}])[0][0]
        self.assertEqual(row['activation_gap'],'multiple_intro_loop_rpc_starts')

    def test_owner_join_and_native_position_updates_use_exact_observed_time_and_packet(self):
        fields=[(90,1,70,'Owner',None,ref(10)),(120,3,30,'Instigator',None,ref(70)),
            (121,4,30,'ReplicatedMovement',json.dumps({'location':{'x':1,'y':2,'z':3}}),None)]
        row=self.instances(fields=fields)[0][0]
        self.assertEqual(row['subject'],'a');self.assertEqual(row['instigator_join'][0]['time_ms'],90)
        self.assertEqual([row['subject_evidence_time_ms'],row['subject_evidence_packet_id']],[120,3])
        self.assertEqual(row['positions'],[[100,0,0,0],[121,1,2,3]])
        self.assertEqual(row['native_movement_observations'],[{'time_ms':121,'packet_id':4,'location_cm':[1,2,3]}])
        row=self.instances(fields=[(120,4,70,'Owner',None,ref(10)),(120,3,30,'Instigator',None,ref(70))])[0][0]
        self.assertIsNone(row['subject']);self.assertEqual(row['instigator_observations'][0]['owner_join'],[])
        row=self.instances(fields=[(120,2,70,'PlayerState',None,ref(90)),(120,3,30,'Instigator',None,ref(70))])[0][0]
        self.assertEqual(row['subject'],'a')

    def test_channel_same_time_packet_order_and_reopen_do_not_leak_old_membership(self):
        cls=self.classes['Clove']
        actors=[(100,2,30,'open',cls,0,0,0),(200,5,30,'open',cls,2,0,0),(300,8,30,'close',None,None,None,None)]
        fields=[(100,1,30,'Instigator',None,ref(20)),(100,2,30,'Instigator',None,ref(10)),
            (200,4,30,'Instigator',None,ref(10)),(200,5,30,'Instigator',None,ref(20)),
            (300,7,30,'ReplicatedMovement',json.dumps({'location':{'x':3,'y':0,'z':0}}),None),
            (300,8,30,'ReplicatedMovement',json.dumps({'location':{'x':99,'y':0,'z':0}}),None)]
        rows,_=self.instances(actors=actors,fields=fields,effects=[])
        self.assertEqual([r['subject'] for r in rows],['a','b'])
        self.assertEqual(rows[0]['end_reason'],'observed_channel_reopen')
        self.assertEqual([e['packet_id'] for e in rows[0]['instigator_observations']],[2,4])
        self.assertEqual(rows[1]['positions'],[[200,2,0,0],[300,3,0,0]])
        profile=self.addon['smoke_profiles'][cls]
        effects=[{'actor_net_guid':30,'round':0,'start_ms':100,'start_packet_id':1,'effect_class':profile['intro_loop_effect_class']}]
        self.assertEqual(self.instances(effects=effects)[0][0]['activation_gap'],'missing_intro_loop_rpc')

    def test_provenance_guard_checks_source_exports_published_replay_model_and_generator(self):
        with scratch_directory() as temporary:
            directory=Path(temporary);export=directory/'export';export.mkdir()
            for name in ['manifest.json','actors.parquet','fields.parquet']:(export/name).write_text(name)
            source=directory/'source.vrf';source.write_text('native replay')
            asset_source=directory/'source.json';asset_source.write_text('serialized asset receipt')
            canonical=directory/'canonical-model.json';canonical.write_text('canonical source bytes')
            model=copy.deepcopy(self.addon)
            model['source_provenance']={'source_json_file':str(asset_source),'canonical_model_file':str(canonical),
                'source_json_sha256':sha(asset_source),'canonical_model_sha256':sha(canonical),
                'generator_sha256':sha(ROOT/'scripts/replay_smoke_profiles.py'),
                'asset_inspector_sha256':sha(ROOT/'scripts/inspect-transcription-assets.py'),
                'asset_decoder_setup_sha256':sha(ROOT/'scripts/export-transcription-map.py')}
            record={'match_id':'match','source':str(source),'source_sha256':sha(source),'export':str(export)}
            data={'match_id':'match','source_provenance':{'source_replay_sha256':sha(source)},
                'export_manifest_sha256':sha(export/'manifest.json'),
                'asset_state':{'model':{'mapping_sha256':model['mapping_sha256'],'archives':model['archives']}}}
            replay=directory/'replay.json';replay.write_text(json.dumps(data))
            published={'source_provenance':data['source_provenance'],
                'replay_export_manifest_sha256':sha(export/'manifest.json'),'gameplay_asset_model_sha256':sha(canonical)}
            (directory/'provenance.json').write_text(json.dumps(published))
            sidecar={'schema_version':1,'kind':'additional_observed_smoke_inputs','match_id':'match',
                'native_activation_clock_verified':False,'native_visual_opacity_verified':False,
                'source_provenance':{'source_replay_sha256':sha(source),'published_replay_sha256':sha(replay),
                    'replay_export_manifest_sha256':sha(export/'manifest.json'),
                    'actors_parquet_sha256':sha(export/'actors.parquet'),'fields_parquet_sha256':sha(export/'fields.parquet'),
                    'smoke_model_sha256':object_hash(model),'generator_sha256':sha(ROOT/'scripts/replay_smoke_profiles.py')}}
            self.assertTrue(validate_replay(sidecar,record,replay,model)['valid'])
            for key in list(sidecar['source_provenance']):
                broken=copy.deepcopy(sidecar);broken['source_provenance'][key]='changed'
                with self.subTest(key=key),self.assertRaises(ValueError):validate_replay(broken,record,replay,model)
            changed=copy.deepcopy(model);changed['smoke_profiles'][self.classes['Clove']]['radius_cm']+=1
            with self.assertRaisesRegex(ValueError,'model object hash'):validate_replay(sidecar,record,replay,changed)
            (export/'fields.parquet').write_text('later decoded rows')
            with self.assertRaisesRegex(ValueError,'fields_parquet_sha256'):validate_replay(sidecar,record,replay,model)


if __name__=='__main__':unittest.main()
