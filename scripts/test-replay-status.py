"""Status boundaries: recipient joins, overlapping IDs and interrupted posture."""
import unittest
import numpy as np
from replay_status import (effect_messages,vision_intervals,crouch_transitions,
                           stance_fraction,stance_geometry,crouch_corroboration)


class VisionTests(unittest.TestCase):
    rounds=[{'index':0,'start_ms':0,'end_ms':1000},{'index':1,'start_ms':1000,'end_ms':2000}]
    profiles={'leer':{'kind':'nearsight','name':'Leer'},'flash':{'kind':'flash','name':'Flash'}}

    def call(self,t,method,actor=10,identity=7,source='server',container=90,component=11):
        return {'time_ms':t,'packet_id':t,'actor':actor,'component':component,'method':method,
                'values':{'EffectID':identity,'SourceID':source,'EffectContainer':container}}

    def intervals(self,messages):
        return vision_intervals(messages,self.profiles,{90:'leer',91:'flash'},{10:'alice',20:'bob'},self.rounds)[0]

    def test_stop_must_match_actor_component_source_and_id(self):
        calls=[self.call(100,'MulticastPlayContinuousEffect')]
        calls += [self.call(200,'MulticastStopContinuousEffect',**args) for args in
                  [{'actor':20},{'component':12},{'source':'client'},{'identity':8}]]
        calls += [self.call(300,'MulticastStopContinuousEffect')]
        rows=self.intervals(calls)
        self.assertEqual(rows[0]['subject'],'alice')
        self.assertEqual(rows[0]['end_ms'],300)

    def test_overlapping_flash_and_nearsight_have_independent_ends(self):
        rows=self.intervals([self.call(100,'MulticastPlayContinuousEffect'),
            self.call(110,'MulticastPlayContinuousEffect',identity=8,container=91),
            self.call(200,'MulticastStopContinuousEffect'),
            self.call(250,'MulticastStopContinuousEffect',identity=8)])
        self.assertEqual([(r['kind'],r['start_ms'],r['end_ms']) for r in rows],
                         [('nearsight',100,200),('flash',110,250)])

    def test_reuse_and_missing_stop_do_not_cross_round_or_create_duration_from_assets(self):
        rows=self.intervals([self.call(100,'MulticastPlayContinuousEffect'),
                            self.call(200,'MulticastPlayContinuousEffect'),
                            self.call(1100,'MulticastStopContinuousEffect')])
        self.assertEqual(rows[0]['end_ms'],200)
        self.assertEqual(rows[0]['end_reason'],'effect_id_reused')
        self.assertEqual(rows[1]['end_ms'],1000)
        self.assertEqual(rows[1]['end_reason'],'round_boundary_no_stop_observed')

    def test_unknown_effect_and_nonplayer_recipients_are_excluded(self):
        self.assertEqual(self.intervals([self.call(100,'MulticastPlayContinuousEffect',container=99),
                                        self.call(200,'MulticastPlayContinuousEffect',actor=30)]),[])

    def test_two_calls_in_one_packet_survive_field_assembly(self):
        rows=[]
        for container,identity in [(90,7),(91,8)]:
            for name,value in [('EffectContainer',container),('EffectID',identity)]:
                rows.append((100,1,10,11,'MulticastPlayContinuousEffect.'+name,value,None,None,None))
        assembled=effect_messages(rows)
        self.assertEqual(len(assembled),2)
        self.assertEqual([m['values']['EffectID'] for m in assembled],[7,8])


class PostureTests(unittest.TestCase):
    camera={'standing_eye_cm':77,'crouched_eye_cm':30,'crouch_compression_cm':20}
    capsule={'half_height_cm':98,'radius_cm':42}

    def test_reversal_continues_without_a_snap_and_has_constant_asset_rate(self):
        rows=crouch_transitions([[0,False],[100,True],[200,False],[225,True]],100)
        self.assertEqual(stance_fraction(rows,150),.5)
        self.assertEqual(stance_fraction(rows,200),1)
        self.assertEqual(stance_fraction(rows,225),.75)
        self.assertEqual(stance_fraction(rows,250),1)
        self.assertEqual(stance_fraction(rows,-1),0)

    def test_camera_and_proxy_shape_change_without_reapplying_recorded_xyz(self):
        rows=crouch_transitions([[0,False],[100,True]],275)
        standing=stance_geometry(self.camera,self.capsule,rows,100)
        crouched=stance_geometry(self.camera,self.capsule,rows,375)
        self.assertEqual(standing['eye_height_cm'],77)
        self.assertEqual(crouched['eye_height_cm'],30)
        self.assertEqual(standing['body_offsets_cm'],[-56,0,56])
        self.assertEqual(crouched['body_offsets_cm'],[-36,-13.5,9])
        native_z=680.15
        self.assertAlmostEqual(native_z+crouched['eye_height_cm'],710.15)

    def test_stationary_evidence_rejects_moving_terrain_and_dead_input(self):
        t=np.arange(0,1000,10,dtype=float)
        track=np.zeros((len(t),7));track[:,0]=t
        track[:,3]=700-20*np.clip((t-500)/275,0,1)
        inputs={'a':[[0,False],[500,True]]};rounds=[{'start_ms':0,'end_ms':1000,'index':0}]
        result=crouch_corroboration(inputs,{'a':track},rounds,[],20)
        self.assertEqual(result['matched_transitions'],1)
        deaths=[{'round':0,'victim':'a','time_ms':400}]
        self.assertEqual(crouch_corroboration(inputs,{'a':track},rounds,deaths,20)['candidates'],0)
        track[:,1]=t/100
        self.assertEqual(crouch_corroboration(inputs,{'a':track},rounds,[],20)['candidates'],0)


if __name__=='__main__':
    unittest.main()
