"""Compare 13-11 with completed overtime +/-2 games in a fresh D1 snapshot.

Read-only, aggregate output; no Henrik requests. Requires numpy. Run:
python scripts/analyze-rr-overtime.py SNAPSHOT/corpus.ndjson.gz --out artifacts/rr-overtime-analysis
"""
import argparse, collections, datetime, gzip, hashlib, importlib.util, json, math
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('benchmark', Path(__file__).with_name('benchmark-rr-corpus.py'))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)


def mean(values):
    return float(np.mean(values)) if len(values) else None


def describe(rows):
    y = [r['y'] for r in rows]
    return dict(n=len(rows), players=len({r['player'] for r in rows}),
                unique_matches=len({r['mid'] for r in rows}), mean=mean(y),
                median=float(np.median(y)) if y else None,
                sd=float(np.std(y, ddof=1)) if len(y) > 1 else None)


def paired(rows):
    groups = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        groups[r['player'], r['season']][r['ot']].append(r['y'])
    by_player = collections.defaultdict(list)
    for (player, _), g in groups.items():
        if g[True] and g[False]:
            by_player[player].append(mean(g[True])-mean(g[False]))
    differences = np.array([mean(v) for v in by_player.values()])
    if len(differences) < 2:
        return dict(players=len(differences), difference=None, bootstrap_95=None)
    rng = np.random.default_rng(17431)
    draws = rng.choice(differences, (5000, len(differences)), replace=True).mean(axis=1)
    return dict(players=len(differences), difference=mean(differences),
                bootstrap_95=np.quantile(draws, [.025, .975]).tolist(),
                method='Equal player weights; within player/act/outcome OT minus regulation means; 5000 permanent-player bootstrap draws. Shared matches may still couple players.')


def adjusted(rows, full=True):
    # Only accounts with both finishes identify the within-player contrast.
    selected = [r for r in rows if not full or all(isinstance(r.get(k), (int, float)) and math.isfinite(r[k]) for k in ['acs_z', 'lobby_gap'])]
    groups = collections.defaultdict(list)
    for r in selected:
        groups[r['player'], r['season']].append(r)
    groups = {key: seq for key, seq in groups.items() if {r['ot'] for r in seq} == {False, True}}
    selected = [r for seq in groups.values() for r in seq]
    if len(selected) < 10:
        return dict(n=len(selected), reason='Insufficient paired evidence')
    baseline = min(r['day'] for r in selected)
    def covariates(r):
        values = [int(r['ot']), r['x']/100]
        if full:
            values += [r['acs_z'], r['lobby_gap'], (r['day']-baseline)/7, int(r['party']==2), int(r['party']==3)]
        return values
    x = np.array([covariates(r) for r in selected], dtype=float)
    y = np.array([r['y'] for r in selected], dtype=float)
    cursor = 0
    for seq in groups.values():
        sl = slice(cursor, cursor+len(seq))
        x[sl] -= x[sl].mean(axis=0)
        y[sl] -= y[sl].mean()
        cursor += len(seq)
    rank = int(np.linalg.matrix_rank(x))
    if rank <= np.linalg.matrix_rank(x[:, 1:]):
        return dict(n=len(selected), reason='OT contrast not identified separately from controls')
    beta = np.linalg.lstsq(x, y, rcond=None)[0]
    residual = y-x@beta
    bread = np.linalg.pinv(x.T@x)
    n = len(selected)
    df = n-len(groups)-rank
    def meat(keys):
        scores = collections.defaultdict(lambda: np.zeros(x.shape[1]))
        for key, xi, ei in zip(keys, x, residual):
            scores[key] += xi*ei
        count = len(scores)
        if count < 2 or df <= 0:
            raise ValueError('Insufficient independent clusters')
        return sum(np.outer(s, s) for s in scores.values()) * count/(count-1) * (n-1)/df
    # Two-way cluster covariance: accounts + shared matches - intersections.
    covariance = bread @ (meat([r['player'] for r in selected]) + meat([r['mid'] for r in selected]) -
                         meat([(r['player'], r['mid']) for r in selected])) @ bread
    if covariance[0, 0] < 0:
        return dict(n=n, reason='Unstable two-way cluster covariance')
    se = math.sqrt(covariance[0, 0])
    return dict(n=n, players=len({r['player'] for r in selected}), unique_matches=len({r['mid'] for r in selected}),
                groups=len(groups), difference=float(beta[0]), se=se,
                approximate_95=[float(beta[0]-1.96*se), float(beta[0]+1.96*se)],
                controls=['player/act fixed effects', 'witnessed starting rank + RR'] +
                         (['within-match standardized ACS', 'lobby rank gap', 'linear date', 'party size'] if full else []),
                uncertainty='Approximate normal interval; covariance clustered by permanent player and match ID, allowing multiple accounts from the same game.')


def compare(rows):
    reg = [r for r in rows if not r['ot']]
    ot = [r for r in rows if r['ot']]
    return dict(regulation=describe(reg), overtime=describe(ot),
                raw_difference=mean([r['y'] for r in ot])-mean([r['y'] for r in reg]) if ot and reg else None,
                paired=paired(rows), rank_adjusted=adjusted(rows, False), adjusted=adjusted(rows, True))


def analyze(records):
    if len({(r['player'], r['match_id']) for r in records}) != len(records):
        raise ValueError('Snapshot contains duplicate player/match records')
    clean, audit = B.eligible_rows(records)
    lookup = {(r['player'], r['match_id']): r['features'] for r in records}
    rows, exclusions = [], collections.Counter()
    for r in clean:
        f = lookup[r['player'], r['mid']]
        rw, rl = f.get('rw'), f.get('rl')
        if type(rw) is not int or type(rl) is not int or abs(rw-rl) != 2:
            exclusions['not_two_round_margin'] += 1
            continue
        if min(rw, rl) < 11 or max(rw, rl) < 13 or f.get('rd') != rw-rl or f['won'] != (rw > rl):
            exclusions['nonstandard_finish_or_inconsistent_score'] += 1
            continue
        if f.get('mode') != 'competitive':
            exclusions['not_confirmed_competitive'] += 1
            continue
        gap = f['lobby_mean_tier']-f['my_tier'] if all(isinstance(f.get(k), (int, float)) for k in ['lobby_mean_tier', 'my_tier']) else None
        rows.append(dict(r, ot=max(rw, rl)>=14, rw=rw, rl=rl, acs_z=f.get('acs_z'),
                         lobby_gap=gap, party=f['party'], day=datetime.datetime.fromisoformat(r['date'].replace('Z', '+00:00')).timestamp()/86400))
    outcomes = {label: compare([r for r in rows if r['won']==won]) for label, won in [('wins', True), ('losses', False)]}
    sensitivities = {}
    for label, subset in [('solo_only', [r for r in rows if r['party']==1]),
                          ('pc_only', [r for r in rows if r['platform']=='pc']),
                          ('below_immortal', [r for r in rows if r['tier']<24]),
                          ('immortal_plus', [r for r in rows if r['tier']>=24])]:
        sensitivities[label] = {outcome: compare([r for r in subset if r['won']==won]) for outcome, won in [('wins', True), ('losses', False)]}
    overtime_lengths = {}
    for label, lower, upper in [('14-12', 14, 14), ('15-13', 15, 15), ('16-14', 16, 16), ('17-15_or_longer', 17, math.inf)]:
        subset = [r for r in rows if not r['ot'] or lower <= max(r['rw'], r['rl']) <= upper]
        overtime_lengths[label] = {outcome: compare([r for r in subset if r['won']==won]) for outcome, won in [('wins', True), ('losses', False)]}
    coverage = []
    for tier in sorted({r['tier'] for r in rows}):
        for won in [True, False]:
            s = [r for r in rows if r['tier']==tier and r['won']==won]
            if s:
                coverage.append(dict(starting_tier=tier, won=won,
                                     regulation=describe([r for r in s if not r['ot']]), overtime=describe([r for r in s if r['ot']])))
    return dict(audit=audit, comparison_exclusions=dict(exclusions), n=len(rows),
                players=len({r['player'] for r in rows}), unique_matches=len({r['mid'] for r in rows}),
                acts=dict(collections.Counter(r['act'] for r in rows)),
                dates=[min(r['date'] for r in rows), max(r['date'] for r in rows)],
                outcomes=outcomes, sensitivities=sensitivities, overtime_lengths=overtime_lengths, starting_rank_coverage=coverage,
                definition='Regulation: exactly 13-11 or 11-13. OT: winner at least 14, loser at least 12, margin exactly 2. Draws, incomplete/abnormal scores excluded. RR is absolute last_change; loss differences above zero mean a larger cost.',
                limitations=['Observed cohort, not a causal estimate of Riot overtime rules.',
                             'MMR is unobserved and can change within a player/act; performance and lobby ranks are imperfect proxies.',
                             'Only records with witnessed starting rank, trusted scores, known parties and consistent payout coordinates enter the primary comparison.',
                             'Missing match detail coverage can select the cohort; all clean comparisons here come from the acts reported above.',
                             'Pooled or within-player averages do not prove identical payouts for every rank, player or overtime length.'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('--out', type=Path, default=Path('artifacts/rr-overtime-analysis'))
    args = parser.parse_args()
    with gzip.open(args.snapshot, 'rt', encoding='utf-8') as stream:
        records = [json.loads(line) for line in stream if line.strip()]
    result = analyze(records)
    result['snapshot_sha256'] = hashlib.sha256(args.snapshot.read_bytes()).hexdigest()
    result['analyzed_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({k: result[k] for k in ['n', 'players', 'unique_matches', 'acts', 'outcomes']}, indent=2))


if __name__ == '__main__':
    main()
