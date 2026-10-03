import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('benchmark',Path(__file__).with_name('benchmark-rr-corpus.py'))
B=importlib.util.module_from_spec(spec);spec.loader.exec_module(B)

def record(change=20,shield=False,refund=0):
    before=dict(tier={'id':12},rr=30,season={'id':'act','short':'test'})
    after=dict(tier={'id':12},rr=30+(0 if shield else change)+refund,season={'id':'act','short':'test'},
               last_change=change,was_derank_protected=shield,refunded_rr=refund,date='2026-10-01')
    return dict(player='permanent',match_id='match',platform='pc',rr=after,previous_rr=before,
                features=dict(season_id='act',party=1,pen=0,won=change>0,draw=False))

class ResearchTests(unittest.TestCase):
    def test_starting_rank_uses_witnessed_previous_rating(self):
        rows,audit=B.eligible_rows([record()], 'test')
        self.assertEqual(rows[0]['x'],930);self.assertEqual(rows[0]['y'],20)
    def test_shield_loss_keeps_actual_payout_and_refund_is_not_added(self):
        rows,_=B.eligible_rows([record(-19,True),record(20,False,8)],'test')
        self.assertEqual([r['y'] for r in rows],[19,20])
    def test_missing_adjacency_and_unknown_party_are_excluded(self):
        a,b=record(),record();a['previous_rr']=None;b['features']['party']=None
        rows,audit=B.eligible_rows([a,b],'test')
        self.assertEqual(rows,[]);self.assertEqual(audit['starting_rank_not_witnessed'],1)
        self.assertEqual(audit['party_unknown'],1)
    def test_transition_and_coordinate_discrepancy_remain_audited(self):
        a,b=record(),record();a['previous_rr']['season']['id']='old';b['rr']['rr']+=10
        rows,audit=B.eligible_rows([a,b],'test')
        self.assertEqual(rows,[]);self.assertEqual(audit['act_transition'],1)
        self.assertEqual(audit['rank_coordinate_discrepancy'],1)
    def test_temporal_fit_cannot_read_test_payouts(self):
        rows=[dict(player='account',season='act',won=True,platform='pc',tier=12,
                   date=f'{i:03d}',mid=str(i),x=930,y=10 if i<14 else 100) for i in range(20)]
        result=B.evaluate(rows)
        summaries=result['models']['act_mean']
        split=next(v for v in summaries.values() if v['rows'])
        self.assertEqual(split['player_rmse'],90)
        self.assertFalse(result['ready_to_review'])
    def test_empty_dataset_has_no_selected_model(self):
        self.assertIsNone(B.evaluate([])['tuning_selected'])

if __name__=='__main__':unittest.main()
