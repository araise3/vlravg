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

    def test_reported_start_works_without_predecessor_and_overrides_conflicting_previous(self):
        a,b=record(),record()
        for rec in [a,b]:
            rec['rr'].update(tier_before_update={'id':12},rr_before_update=30)
        a['previous_rr']=None;b['previous_rr']['rr']=80;b['previous_rr']['season']['id']='old'
        rows,audit=B.eligible_rows([a,b],'test')
        self.assertEqual([r['x'] for r in rows],[930,930])
        self.assertEqual(audit['starting_rank_reported'],2)

    def test_partial_reported_start_falls_back_and_placement_is_excluded(self):
        a,b=record(),record()
        a['rr']['rr_before_update']=99;b['rr']['is_placement_match']=True
        rows,audit=B.eligible_rows([a,b],'test')
        self.assertEqual(rows[0]['starting_source'],'witnessed_predecessor')
        self.assertEqual(audit['placement_match'],1)

    def test_reported_immortal_start_uses_cumulative_rr(self):
        rec=record();rec['previous_rr']=None
        rec['rr'].update(tier_before_update={'id':24},rr_before_update=199,tier={'id':25},rr=219)
        rows,_=B.eligible_rows([rec],'test')
        self.assertEqual(rows[0]['x'],2299)

    def test_reported_start_still_requires_correct_coordinates_and_act(self):
        a,b=record(),record()
        for rec in [a,b]:rec['rr'].update(tier_before_update={'id':12},rr_before_update=30)
        a['rr']['rr']+=5;b['features']['season_id']='other'
        rows,audit=B.eligible_rows([a,b],'test')
        self.assertEqual(rows,[])
        self.assertEqual(audit['rank_coordinate_discrepancy'],1)
        self.assertEqual(audit['season_mismatch'],1)

    def test_adjusted_payouts_are_separate_and_never_subtracted(self):
        records=[]
        for key,value in [('rr_performance_bonus',5),('afk_penalty',-3),('rr_penalty',.25),('new_map_incentive_rr_forgiven',8)]:
            rec=record();rec['rr'][key]=value;records.append(rec)
        primary,audit=B.eligible_rows(records,'test')
        contextual,_=B.eligible_rows(records,'test',include_adjustments=True)
        self.assertEqual(primary,[])
        self.assertEqual(audit['reported_bonus_or_penalty_or_forgiveness'],4)
        self.assertEqual([r['y'] for r in contextual],[20]*4)

    def test_coverage_keeps_zeros_unknowns_and_overlapping_flags_distinct(self):
        ordinary,unknown,adjusted=record(),record(),record(-19,True,4)
        for rec in [ordinary,adjusted]:
            rec['rr'].update({field:0 for field in B.ADJUSTMENT_FIELDS.values()})
        adjusted['rr'].update(afk_penalty=3,rr_penalty=.25)
        adjusted['features'].update(party=5,pen=.25)
        report=B.benchmark_report([ordinary,unknown,adjusted],'test','checksum')
        detail=report['competitive_updates'];cohorts=detail['cohorts']
        self.assertEqual(report['audit']['eligible'],2)
        self.assertEqual(detail['field_coverage']['performance_bonus'],{'covered':2,'total':3,'nonzero':0})
        self.assertEqual(cohorts['ordinary_reported']['rows'],1)
        self.assertEqual(cohorts['adjustments_unknown']['rows'],1)
        for key in ['afk_penalty','rr_penalty','party_penalty_or_five_stack','shielded','refunded']:
            self.assertEqual(cohorts[key]['rows'],1)
        self.assertEqual(cohorts['afk_penalty']['outcomes']['losses']['player_mean_abs_payout'],19)

    def test_invalid_numeric_values_cannot_enter_coordinates(self):
        rec=record();rec['rr']['refunded_rr']=float('nan')
        self.assertEqual(B.eligible_rows([rec],'test')[1]['invalid_refund'],1)
        self.assertIsNone(B.position({'tier':{'id':12},'rr':True}))
        self.assertIsNone(B.position({'tier':{'id':12},'rr':float('inf')}))
        self.assertIsNone(B.position({'tier':'unavailable','rr':30}))

    def test_cohort_payout_averages_give_players_equal_weight(self):
        records=[record(20) for _ in range(3)]+[record(10)]
        records[-1]['player']='other'
        for rec in records:rec['rr'].update({field:0 for field in B.ADJUSTMENT_FIELDS.values()})
        rows,_=B.eligible_rows(records,'test',include_adjustments=True)
        wins=B.competitive_update_report(rows)['cohorts']['ordinary_reported']['outcomes']['wins']
        self.assertEqual(wins['rows'],4)
        self.assertEqual(wins['players'],2)
        self.assertEqual(wins['player_mean_abs_payout'],15)

if __name__=='__main__':unittest.main()
