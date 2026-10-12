"""Dynamic dependency boundaries using real 13.06 geometry and program sources."""
import copy
import gzip
import json
from pathlib import Path
import struct
import unittest

from replay_dynamic_occluders import (FIELDS,WINDOW,DRAWBRIDGE,WALL,CHILD_ALIVE_GROUP,CHILD_ALIVE_CHECKSUM,
                                     source_profiles,strict_guid_paths,segment_intersects_bounds,
                                     extract_dependencies,region_dependencies,raw_value)


class SourceGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=Path(__file__).resolve().parent.parent/'tests/fixtures/replay-dynamic-occluders-13.06.json.gz'
        cls.evidence=json.loads(gzip.decompress(path.read_bytes()))['asset_evidence']
        cls.profiles=source_profiles(cls.evidence)

    def test_real_source_profiles_cover_exact_map_actors(self):
        self.assertEqual(len(self.profiles),8)
        self.assertEqual(sum(p['class_path']==WINDOW for p in self.profiles),2)
        self.assertEqual(sum(p['class_path']==DRAWBRIDGE for p in self.profiles),2)
        self.assertTrue(all(not p['native_geometry_verified'] for p in self.profiles))

    def test_lotus_sweep_includes_the_explicit_beginplay_mesh_location(self):
        profile=next(p for p in self.profiles if p['id'].endswith('.Drawbridge5'))
        low,high=profile['bounds_cm']
        self.assertLess(low[2],-2000)
        self.assertGreater(high[2],550)  # root 50 + BeginPlay 100 + mesh 403
        self.assertLess(high[0]-low[0],650)
        self.assertEqual(profile['bounds_domain'],'full_yaw_sweep_including_serialized_and_constant_Blueprint_mesh_locations')

    def test_ascent_lift_bounds_do_not_guess_a_native_alpha_range(self):
        profile=next(p for p in self.profiles if p['id'].endswith('.WindowShieldA1'))
        low,high=profile['bounds_cm'];x=(low[0]+high[0])/2;y=(low[1]+high[1])/2
        self.assertEqual([low[2],high[2]],[None,None])
        self.assertTrue(segment_intersects_bounds([x-100,y,1e8],[x+100,y,1e8],profile['bounds_cm']))
        self.assertFalse(segment_intersects_bounds([x-100,high[1]+10,400],[x+100,high[1]+10,400],profile['bounds_cm']))

    def test_unknown_streaming_transform_and_class_program_changes_fail_closed(self):
        evidence=copy.deepcopy(self.evidence)
        for level in evidence['streaming_levels']:
            if 'Ascent_Gameplay_Dynamic.' in level['asset']:level['properties']['LevelTransform']={}
        with self.assertRaisesRegex(ValueError,'level transform'):source_profiles(evidence)
        evidence=copy.deepcopy(self.evidence)
        for record in evidence['class_records']:
            for export in record['data']['exports']:
                if export['name']=='MoveDoorToPosition':export['ScriptBytecode']=[]
        with self.assertRaisesRegex(ValueError,'complete dynamic geometry program'):source_profiles(evidence)


class DynamicStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SourceGeometryTests.setUpClass.__func__(cls)

    def prepare(self):
        self.profile=copy.deepcopy(next(p for p in self.profiles if p['class_path']==WALL and '/Jam/' in p['id']))
        self.guids=[(1,self.profile['actor_object_path'],None),(2,self.profile['health_component_path'],None)]
        self.actors=[{'time_ms':0,'packet_id':1,'channel_index':7,'actor_net_guid':1,'event':'open'}]
        self.rounds=[{'index':0,'start_ms':10,'end_ms':100},{'index':1,'start_ms':100,'end_ms':200}]
        self.groups=[{'path':self.profile['class_path'],'fields':[{'handle':1,'name':'bHidden','compatible_checksum':FIELDS['bHidden'][0]},
                                                               {'handle':15,'name':'IsAlive_0','compatible_checksum':FIELDS['IsAlive_0'][0]},
                                                               {'handle':17,'name':'DoorState','compatible_checksum':FIELDS['DoorState'][0]}]}]
        low,high=self.profile['bounds_cm'];center=[(a+b)/2 for a,b in zip(low,high)]
        self.ray=([low[0]-10,center[1],center[2]],[high[0]+10,center[1],center[2]])

    def row(self,t,packet,name,value,**extra):
        checksum,kind,bits=FIELDS[name]
        raw=struct.pack('<f',value) if kind=='float' else bytes([int(value)])
        return {'time_ms':t,'packet_id':packet,'channel_index':7,'actor_net_guid':1,'object_net_guid':None,
                'group_path':self.profile['actor_object_path'].rsplit('.',1)[-1],
                'handle':{'bHidden':1,'IsAlive_0':15,'DoorState':17}[name],'field_name':None,
                'compatible_checksum':None,'bit_count':bits,'raw_bits':raw,**extra}

    def result(self,rows):
        return extract_dependencies(rows,self.guids,self.actors,self.groups,self.rounds,[self.profile],200)

    def test_desired_open_state_and_dead_health_do_not_create_a_clear_ray(self):
        self.prepare();sidecar=self.result([self.row(20,2,'DoorState',0),self.row(30,3,'IsAlive_0',False)])
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,40,0)),1)

    def test_hidden_boolean_is_round_scoped_and_never_read_from_the_future(self):
        self.prepare();sidecar=self.result([self.row(40,3,'bHidden',True)])
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,39,0)),1)
        self.assertEqual(region_dependencies(sidecar,*self.ray,40,0),[])
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,100,1)),1)

    def test_a_malformed_later_hide_update_invalidates_previous_hidden_knowledge(self):
        self.prepare();sidecar=self.result([self.row(20,2,'bHidden',True),self.row(40,3,'bHidden',False,raw_bits=b'\x02')])
        self.assertEqual(len(sidecar['unresolved_observations']),1)
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,40,0)),1)

    def test_channel_close_and_reopen_do_not_reuse_old_hidden_state(self):
        self.prepare();self.actors.extend([{'time_ms':30,'packet_id':3,'channel_index':7,'actor_net_guid':1,'event':'close'},
                                         {'time_ms':40,'packet_id':4,'channel_index':7,'actor_net_guid':1,'event':'open'}])
        sidecar=self.result([self.row(20,2,'bHidden',True)])
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,35,0)),1)
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,45,0)),1)

    def test_duplicate_channel_open_resets_knowledge_at_the_new_packet(self):
        self.prepare();self.actors.append({'time_ms':40,'packet_id':4,'channel_index':7,'actor_net_guid':1,'event':'open'})
        sidecar=self.result([self.row(20,2,'bHidden',True)])
        self.assertEqual(sidecar['diagnostics']['overlapping_actor_opens'],1)
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,45,0)),1)

    def test_unowned_health_component_is_retained_as_an_ambiguity(self):
        self.prepare();row=self.row(20,2,'bHidden',False,object_net_guid=99,group_path=CHILD_ALIVE_GROUP,
                                 field_name='bAlive',compatible_checksum=CHILD_ALIVE_CHECKSUM,handle=2)
        sidecar=self.result([row]);self.assertEqual(len(sidecar['unresolved_observations']),1)
        self.assertIn('owner/path',sidecar['unresolved_observations'][0]['reason'])

    def test_ambiguous_native_actor_path_does_not_pick_a_guid(self):
        self.prepare();self.guids.append((3,self.profile['actor_object_path'],None))
        sidecar=self.result([]);self.assertIsNone(sidecar['instances'][0]['actor_net_guid'])
        self.assertEqual(len(region_dependencies(sidecar,*self.ray,40,0)),1)

    def test_time_outside_round_and_wrong_checksum_fail_closed(self):
        self.prepare()
        with self.assertRaises(ValueError):region_dependencies(self.result([]),*self.ray,200,1)
        with self.assertRaises(ValueError):raw_value(self.row(20,2,'bHidden',True,compatible_checksum=1),FIELDS['bHidden'])


class IdentityTests(unittest.TestCase):
    def test_cycles_missing_outer_and_conflicting_guid_entries_do_not_resolve(self):
        result=strict_guid_paths([(1,'Actor',2),(2,'Level',1),(3,'Actor',99),(4,'/Game/A',None),(4,'/Game/B',None),(5,'Child',4)])
        self.assertTrue(all(value is None for value in result.values()))


if __name__=='__main__':unittest.main()
