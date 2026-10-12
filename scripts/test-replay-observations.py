"""Native flash fixture and failure boundaries for expanded replay coverage."""
import json
from pathlib import Path
import unittest
from replay_bitwindows import array_delta
from replay_observations import blind_membership, observed_effects, guid_paths

ROOT=Path(__file__).resolve().parent.parent


class BlindTests(unittest.TestCase):
    def rows(self):
        fixture=json.loads((ROOT/'tests/fixtures/replay-blind-13.06.json').read_text())
        return [tuple([*r[:9],bytes.fromhex(r[9]) if r[9] is not None else None,*r[10:]]) for r in fixture['rows']]

    def decode(self,rows,vision=None):
        return blind_membership(rows,{4381:'Phoenix config'},{732:'player-a',932:'player-b'},
            [{'index':0,'start_ms':0,'end_ms':100000}],vision or [])

    def test_native_full_and_glance_flashes_have_independent_removals(self):
        observations,intervals,diagnostics=self.decode(self.rows())
        self.assertEqual([(r['subject'],r['start_ms'],r['end_ms']) for r in intervals],
                         [('player-a',78025,79525),('player-b',78025,78064)])
        self.assertEqual(diagnostics.get('blind_unresolved_deltas',0),0)
        self.assertEqual(intervals[0]['reported_initial_duration_seconds'],1.5)
        self.assertAlmostEqual(intervals[1]['reported_initial_duration_seconds'],.0377286896109581)
        self.assertEqual(intervals[1]['config_path'],'Phoenix config')
        self.assertEqual(len([r for r in observations if r['kind']=='blind_duration_scalar_observed']),4)

    def test_native_blind_joins_only_matching_actor_source_and_effect(self):
        vision=[{'actor_net_guid':732,'round':0,'effect_id':724,'source_id':'DedicatedServerWorldSourceID'},
                {'actor_net_guid':932,'round':0,'effect_id':724,'source_id':'DedicatedServerWorldSourceID'},
                {'actor_net_guid':732,'round':0,'effect_id':724,'source_id':'other'}]
        self.decode(self.rows(),vision)
        self.assertIn('native_blind',vision[0]);self.assertNotIn('native_blind',vision[1]);self.assertNotIn('native_blind',vision[2])

    def test_failed_delta_ends_knowledge_without_inventing_duration(self):
        rows=self.rows();row=list(next(r for r in rows if r[0]==78064 and r[4]=='ActiveBlinds'))
        row[9]=b'\xff';row[10]=8
        rows=[tuple(row) if r[0]==78064 and r[4]=='ActiveBlinds' else r for r in rows]
        _,intervals,diagnostics=self.decode(rows)
        self.assertEqual(diagnostics['blind_unresolved_deltas'],1)
        b=next(r for r in intervals if r['subject']=='player-b')
        self.assertEqual(b['end_reason'],'knowledge_lost_unresolved_delta')

    def test_raw_array_rejects_unconsumed_bits_and_oversized_windows(self):
        self.assertEqual(array_delta(b'\0\0',16),(0,{}))
        with self.assertRaises(ValueError):array_delta(b'\0\0\0',24)
        with self.assertRaises(ValueError):array_delta(b'\0',9)


class EffectTests(unittest.TestCase):
    def call(self,t,method,identity=1,component=2,source='server'):
        return {'time_ms':t,'packet_id':t,'actor':10,'component':component,'method':method,
                'values':{'EffectID':identity,'SourceID':source,'EffectContainer':90,'FloatValues':'[]'}}

    def test_updates_one_shots_and_unresolved_classes_remain_observations(self):
        calls=[self.call(100,'MulticastPlayContinuousEffect'),self.call(120,'MulticastUpdateContinuousEffect'),
               self.call(150,'MulticastPlayOneShotEffect'),self.call(160,'MulticastStopContinuousEffect',component=3),
               self.call(180,'MulticastStopContinuousEffect')]
        intervals,events,d=observed_effects(calls,{}, {10:'player'},[{'index':0,'start_ms':0,'end_ms':1000}])
        self.assertEqual(len(events),5);self.assertEqual(len(intervals),1)
        self.assertEqual(intervals[0]['end_ms'],180);self.assertEqual(len(intervals[0]['updates']),1)
        self.assertEqual(d['effect_stops_without_live_start'],1)
        self.assertEqual(d['effect_classes_unresolved'],2)
        self.assertEqual(events[0]['gameplay_semantics'],'unverified')

    def test_guid_outer_paths_resolve_once_and_cycles_are_bounded(self):
        paths=guid_paths([(1,'/Game/Example',0),(2,'FXC_Example_C',1),(3,'Loop',4),(4,'Loop',3)])
        self.assertEqual(paths[2],'/Game/Example.FXC_Example_C')
        self.assertLess(len(paths[3] or ''),30)


if __name__=='__main__':unittest.main()
