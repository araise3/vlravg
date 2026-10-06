import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('overtime', Path(__file__).resolve().parents[1]/'scripts/analyze-rr-overtime.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


def record(mid, rw, rl):
    payout = 20 if rw > rl else -20
    return dict(player=mid, match_id=mid, platform='pc', region='eu',
                rr=dict(tier={'id': 10}, rr=50+payout, last_change=payout,
                        season={'id': 'act', 'short': 'e11a5'}, date='2026-10-01T12:00:00Z'),
                previous_rr=dict(tier={'id': 10}, rr=50, season={'id': 'act'}),
                features=dict(season_id='act', rw=rw, rl=rl, rd=rw-rl, won=rw>rl,
                              mode='competitive', party=1, pen=0, acs_z=0, lobby_mean_tier=10, my_tier=10))


class OvertimeTests(unittest.TestCase):
    def test_exact_score_definition_excludes_early_finishes_and_other_margins(self):
        recs = [record('regwin', 13, 11), record('regloss', 11, 13),
                record('otwin', 14, 12), record('otloss', 18, 20),
                record('early', 4, 2), record('wide', 13, 10)]
        result = R.analyze(recs)
        self.assertEqual(result['n'], 4)
        for outcome in result['outcomes'].values():
            self.assertEqual(outcome['regulation']['n'], 1)
            self.assertEqual(outcome['overtime']['n'], 1)
        self.assertEqual(result['comparison_exclusions']['nonstandard_finish_or_inconsistent_score'], 1)

    def test_duplicate_player_match_records_cannot_inflate_results(self):
        rec = record('same', 13, 11)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            R.analyze([rec, rec])

    def test_rank_adjustment_recovers_known_effect_despite_player_and_rank_confounding(self):
        rows = []
        for player in range(30):
            for j in range(8):
                ot = j >= 4
                x = 100+player*10+(j % 4)*10+50*ot
                rows.append(dict(player=str(player), season='act', mid=f'{player}-{j}',
                                 ot=ot, x=x, day=j, y=10+player*2+.02*x+1.5*ot))
        fit = R.adjusted(rows, False)
        self.assertAlmostEqual(fit['difference'], 1.5, places=8)
        self.assertEqual(fit['players'], 30)
        self.assertEqual(fit['n'], 240)
        self.assertAlmostEqual(R.paired(rows)['difference'], 2.5, places=8)


if __name__ == '__main__':
    unittest.main()
