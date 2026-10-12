"""Behavior checks for asset inheritance, curves, hollow volumes and replay joins."""
import tempfile
from pathlib import Path
import unittest

import duckdb
from replay_asset_model import curve_value,smoke_radius,sphere_segment,extract_asset_state,modeled_smoke_sightline,smoke_intersection
from replay_transcription import unpack_reference


def profile():
    return {"agent":"Test", "radius_cm":100.,"delay_ms":100.,"expand_ms":100.,"duration_ms":500.,"contract_ms":100.,
            "expand_curve":{"keys":[[0,0,0,0,0],[1,1,0,0,0]]},"contract_curve":{"keys":[[0,1,0,0,0],[1,0,0,0,0]]}}


class AssetMathTests(unittest.TestCase):
    def test_curve_modes_and_clamped_endpoints(self):
        linear=[[0,0,0,0,0],[1,1,0,0,0]]
        constant=[[0,1,1,0,0],[1,0,0,0,0]]
        cubic=[[0,0,2,0,0],[1,1,2,3,0]]
        self.assertEqual(curve_value(linear,-1),0)
        self.assertEqual(curve_value(linear,2),1)
        self.assertEqual(curve_value(linear,.5),.5)
        self.assertEqual(curve_value(constant,.99),1)
        self.assertEqual(curve_value(constant,1),0)
        self.assertAlmostEqual(curve_value(cubic,.5),.125)

    def test_delay_expansion_duration_and_decay_do_not_add_expansion_to_lifetime(self):
        p=profile()
        self.assertEqual(smoke_radius(p,99),0)
        self.assertEqual(smoke_radius(p,150),50)
        self.assertEqual(smoke_radius(p,599),100)
        self.assertEqual(smoke_radius(p,650),50)
        self.assertEqual(smoke_radius(p,700),0)

    def test_hollow_interior_is_not_a_boundary_crossing(self):
        h=sphere_segment([-1,0,0],[1,0,0],[0,0,0],2)
        self.assertFalse(h['boundary'])
        self.assertTrue(h['inside_observer'] and h['inside_target'])
        self.assertTrue(sphere_segment([-3,0,0],[3,0,0],[0,0,0],2)['boundary'])
        self.assertFalse(sphere_segment([-3,2,0],[3,2,0],[0,0,0],2)['boundary'])
        self.assertFalse(sphere_segment([0,0,0],[0,0,0],[0,0,0],2)['boundary'])

    def test_modeled_volume_cannot_leak_across_close_or_round(self):
        s={"id":"s", "round":1,"profile":"p","start_ms":0,"end_ms":400,"positions":[[0,0,0,0],[200,1000,0,0]]}
        state={"model":{"smoke_profiles":{"p":profile()}},"smokes":[s]}
        args=(state,[-200,0,0],[200,0,0])
        self.assertEqual(modeled_smoke_sightline(*args,150,1)['boundary_crossings'],['s'])
        for t,r in [(200,1),(400,1),(150,2),(99,1)]:
            self.assertFalse(modeled_smoke_sightline(*args,t,r)['boundary_crossings'])

    def test_shell_geometry_overrides_the_spherical_boundary_approximation(self):
        # A narrow diamond in the XY plane: ray intersects the bounding sphere
        # but misses the actual triangles. This detects sphere-only regressions.
        source={"vertices":[[-1,0,0],[0,1,0],[1,0,0],[0,-1,0]],"indices":[0,1,2,0,2,3]}
        p=profile();p['radius_cm']=1.;p['boundary_shell']={"mesh":"m","scale":[1,1,1],"bounding_radius_cm":1.}
        model={"shell_meshes":{"m":source}}
        self.assertFalse(smoke_intersection(model,p,[.8,.8,-2],[.8,.8,2],[0,0,0],1)['boundary'])
        self.assertTrue(smoke_intersection(model,p,[.1,.1,-2],[.1,.1,2],[0,0,0],1)['boundary'])


class ReplayJoinTests(unittest.TestCase):
    def fixture(self):
        base=Path(__file__).resolve().parent.parent/'.local/test-asset-model'
        base.mkdir(parents=True,exist_ok=True)
        directory=tempfile.TemporaryDirectory(dir=base)
        if not Path(directory.name).resolve().is_relative_to(base.resolve()):
            raise ValueError('Test fixture directory escaped the workspace')
        self.addCleanup(directory.cleanup)
        export=Path(directory.name)
        con=duckdb.connect()
        self.addCleanup(con.close)
        con.execute('CREATE TABLE actors(time_ms INT,packet_id INT,actor_net_guid INT,event VARCHAR,class_path VARCHAR,spawn_x FLOAT,spawn_y FLOAT,spawn_z FLOAT)')
        con.execute("INSERT INTO actors VALUES (100,1,20,'open','Smoke',0,0,0),(100,2,20,'open','Smoke',0,0,0),(350,3,20,'close','Smoke',NULL,NULL,NULL)")
        con.execute('CREATE TABLE fields(time_ms INT,packet_id INT,actor_net_guid INT,object_net_guid INT,group_path VARCHAR,field_name VARCHAR,value_f64 DOUBLE,raw_bits BLOB,value_str VARCHAR,value_bool BOOL)')
        rows=[(5,1,10,None,'Pawn','Owner',None,b'\x04',None,None),
              (100,1,20,None,'Smoke','Instigator',None,b'\x14',None,None),
              (20,1,2,3,'/Script/ShooterGame.AresInventory','NewCurrentEquippable',None,b'\x40',None,None),
              (20,1,2,3,'/Script/ShooterGame.AresInventory','CurrentEquippable',None,b'\x42',None,None),
              (120,1,32,36,'/Script/ShooterGame.ZoomMultiplierComponent','SourceFov',103,None,None,None),
              (120,1,32,36,'/Script/ShooterGame.ZoomMultiplierComponent','TargetFov',51.5,None,None,None),
              (120,1,32,36,'/Script/ShooterGame.ZoomMultiplierComponent','TargetFov1P',5,None,None,None),
              (120,1,32,36,'/Script/ShooterGame.ZoomMultiplierComponent','TotalTransitionTimeDuration',.1,None,None,None)]
        con.executemany('INSERT INTO fields VALUES (?,?,?,?,?,?,?,?,?,?)',rows)
        for table in ('actors','fields'):
            con.execute(f'COPY {table} TO ? (FORMAT PARQUET)',[str(export/(table+'.parquet'))])
        state=extract_asset_state(con,export,{"players":[{"actor_net_guid":1,"subject":"alice"}]},[{"start_ms":0,"end_ms":1000,"index":0}],{2:"alice"},{"smoke_profiles":{"Smoke":profile()}},unpack_reference)
        return state

    def test_smoke_owner_graph_joins_and_duplicate_open_does_not_duplicate_volume(self):
        state=self.fixture()
        self.assertEqual(len(state['smokes']),1)
        smoke=state['smokes'][0]
        self.assertEqual(smoke['subject'],'alice')
        self.assertEqual(smoke['end_ms'],350)
        self.assertEqual(smoke['end_reason'],'observed_channel_close')
        self.assertEqual(smoke['instigator_join'][0]['field'],'Owner')

    def test_world_zoom_joins_new_selected_weapon_and_retains_separate_weapon_mesh_fov(self):
        state=self.fixture()
        self.assertEqual(state['camera']['active_weapon']['alice'],[[20,32]])
        self.assertEqual(state['camera']['weapon_fov']['32'],[[120,103,51.5,100,None,5]])
        self.assertEqual(state['fov_events'][0]['target_weapon_fov_deg'],5)
        self.assertEqual(state['fov_events'][0]['target_fov_deg'],51.5)


if __name__=='__main__':
    unittest.main()
