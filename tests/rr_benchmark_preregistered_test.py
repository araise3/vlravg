"""The pre-registered Immortal+ hybrid is fixed code, scored apart from model selection."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'bench', Path(__file__).resolve().parents[1] / 'scripts' / 'benchmark-rr-corpus.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def rows(player, x0, step, payout, slope, n=20, won=True):
    # Payout falls as starting position rises, as observed at Immortal+ in e11a6.
    return [dict(player=player, season='s', act='a', mid=f'{player}-{won}-{i:02d}', date=f'2026-10-{i + 1:02d}',
                 x=x0 + step * i, y=payout - slope * step * i, tier=24 if x0 + step * i >= 2100 else 20,
                 won=won, platform='pc') for i in range(n)]


class PreregisteredHybridTest(unittest.TestCase):
    def test_hybrid_switches_at_immortal_one(self):
        train = rows('p', 1950, 10, 20, .05)[:14]
        below = dict(x=2099)
        above = dict(x=2100)
        self.assertEqual(bench.predict(train, below, bench.HYBRID), bench.predict(train, below, 'act_mean'))
        self.assertEqual(bench.predict(train, above, bench.HYBRID), bench.predict(train, above, 'linear'))

    def test_hybrid_is_reported_but_never_selected(self):
        data = []
        for i in range(40):
            data += rows(f'imm{i}', 2100, 15, 25, .08)            # Immortal+: payout trends with RR
            data += rows(f'low{i}', 900, 5, 18, 0, won=False)     # below: flat payout
        result = bench.evaluate(data)
        self.assertIn(bench.HYBRID, result['models'])
        self.assertIn(result['tuning_selected'], bench.MODELS)
        tests = result['preregistered']
        for key in ['primary_hybrid_vs_current_curve', 'hybrid_vs_act_mean',
                    'immortal_plus_linear_vs_act_mean', 'below_immortal_linear_vs_act_mean']:
            self.assertIn('passes', tests[key])
            self.assertEqual(tests[key]['passes'], tests[key]['bootstrap_95'][1] < 0)
        # With a real Immortal+ trend, linear must beat the act mean there.
        self.assertTrue(tests['immortal_plus_linear_vs_act_mean']['passes'])
        self.assertIn('none of whose games were in the 2026-10-28 snapshot', tests['rule'])

    def test_bootstrap_is_reproducible(self):
        chosen = {f'p{i}': 1.0 + i / 100 for i in range(50)}
        control = {f'p{i}': 2.0 for i in range(50)}
        self.assertEqual(bench.paired_bootstrap(chosen, control), bench.paired_bootstrap(chosen, control))
        self.assertIsNone(bench.paired_bootstrap({'a': 1}, {'b': 1}))


if __name__ == '__main__':
    unittest.main()
