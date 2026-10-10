"""After an act: benchmark per-account payout curves, separately for wins/losses.

python scripts/benchmark-rr-corpus.py SNAPSHOT/corpus.ndjson.gz --act eX aY
(pass the actual act short name without spaces). Uses only the standard library.
No model is automatically installed in the frontend.
"""
import argparse, collections, gzip, hashlib, json, math, random, statistics
from pathlib import Path

MODELS = ['act_mean', 'linear', 'near30_k5_prior8', 'gaussian40_prior8', 'gaussian80_prior8']


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def position(rr):
    tier_data = rr.get('tier')
    tier = tier_data.get('id') if isinstance(tier_data, dict) else None
    rating = rr.get('rr')
    if not isinstance(tier, int) or isinstance(tier, bool) or not finite_number(rating):
        return None
    return 2100 + rating if tier >= 24 else (tier - 3) * 100 + rating


ADJUSTMENT_FIELDS = {
    'performance_bonus': 'rr_performance_bonus', 'afk_penalty': 'afk_penalty',
    'rr_penalty': 'rr_penalty', 'map_forgiveness': 'new_map_incentive_rr_forgiven',
}


def adjustment_details(h, f):
    values = {label: h.get(field) if finite_number(h.get(field)) else None
              for label, field in ADJUSTMENT_FIELDS.items()}
    flags = [label for label, value in values.items() if value is not None and value != 0]
    if f['party'] >= 5 or f['pen'] != 0:
        flags.append('party_penalty_or_five_stack')
    if h.get('was_derank_protected') is True:
        flags.append('shielded')
    if finite_number(h.get('refunded_rr')) and h['refunded_rr'] != 0:
        flags.append('refunded')
    return values, flags


def eligible_rows(records, act=None, include_adjustments=False):
    audit, rows = collections.Counter(), []
    for rec in records:
        h, prev, f = rec['rr'], rec.get('previous_rr'), rec.get('features')
        season = h.get('season', {})
        if act and season.get('short') != act:
            continue
        audit['raw_payouts'] += 1
        if not f:
            audit['missing_match_features'] += 1
            continue
        if h.get('is_placement_match') is True:
            audit['placement_match'] += 1
            continue
        reported = dict(tier=h.get('tier_before_update'), rr=h.get('rr_before_update'))
        x = position(reported)
        if x is not None:
            start, source = reported, 'reported'
        else:
            if not prev:
                audit['starting_rank_not_witnessed'] += 1
                continue
            if prev.get('season', {}).get('id') != season.get('id'):
                audit['act_transition'] += 1
                continue
            start, source, x = prev, 'witnessed_predecessor', position(prev)
        if not season.get('id'):
            audit['act_transition'] += 1
            continue
        end, payout = position(h), h.get('last_change')
        tier = (start.get('tier') or {}).get('id', 0)
        if x is None or end is None or tier < 3 or not finite_number(payout) or abs(payout) > 200:
            audit['invalid_rank_or_payout'] += 1
            continue
        if f.get('season_id') != season['id'].lower():
            audit['season_mismatch'] += 1
            continue
        if not finite_number(f.get('party')) or not finite_number(f.get('pen')):
            audit['party_unknown'] += 1
            continue
        if not include_adjustments and (f['party'] >= 5 or f['pen'] != 0):
            audit['party_penalty_or_five_stack'] += 1
            continue
        if f.get('draw') or not isinstance(f.get('won'), bool):
            audit['draw_or_missing_outcome'] += 1
            continue
        won = f['won']
        if (won and payout <= 0) or (not won and payout >= 0):
            audit['nonstandard_outcome'] += 1
            continue
        refund = h.get('refunded_rr')
        if refund is not None and not finite_number(refund):
            audit['invalid_refund'] += 1
            continue
        applied = 0 if h.get('was_derank_protected') is True and payout < 0 else payout
        delta = end - x - applied - (refund or 0)
        # Promotion floors, double promotions, resets, intervening adjustments
        # and missing-game inconsistencies are kept in raw evidence, excluded
        # from the primary clean benchmark rather than guessed into x.
        if abs(delta) > .01:
            audit['rank_coordinate_discrepancy'] += 1
            continue
        adjustments, flags = adjustment_details(h, f)
        if not include_adjustments and any(label in flags for label in ADJUSTMENT_FIELDS):
            audit['reported_bonus_or_penalty_or_forgiveness'] += 1
            continue
        audit['starting_rank_' + source] += 1
        rows.append(dict(player=rec['player'], season=season['id'], act=season.get('short'),
                         mid=rec['match_id'], date=h['date'], x=x, y=abs(payout), tier=tier,
                         won=won, region=rec.get('region'), platform=rec.get('platform'),
                         starting_source=source, adjustments=adjustments, adjustment_flags=flags))
    audit['eligible'] = len(rows)
    return rows, dict(audit)


def predict(train, target, model):
    mean = statistics.fmean(r['y'] for r in train)
    x = target['x']
    if model == 'act_mean':
        return mean
    if model == 'linear':
        mx = statistics.fmean(r['x'] for r in train)
        denom = sum((r['x'] - mx) ** 2 for r in train)
        slope = sum((r['x'] - mx) * (r['y'] - mean) for r in train) / (denom + 8000)
        return max(0, min(200, mean + slope * (x - mx)))
    if model == 'near30_k5_prior8':
        selected = []
        for row in sorted(train, key=lambda r: (abs(r['x'] - x), r['date'], r['mid'])):
            if abs(row['x'] - x) > 30:
                continue
            if selected and max(row['x'], *(r['x'] for r in selected)) - min(row['x'], *(r['x'] for r in selected)) > 30:
                continue
            selected.append(row)
            if len(selected) == 5:
                break
        return (sum(r['y'] for r in selected) + 8 * mean) / (len(selected) + 8)
    bandwidth = 40 if model == 'gaussian40_prior8' else 80
    weights = [math.exp(-.5 * ((r['x'] - x) / bandwidth) ** 2) for r in train]
    return (sum(w * r['y'] for w, r in zip(weights, train)) + 8 * mean) / (sum(weights) + 8)


def evaluate(rows):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[(row['player'], row['season'], row['won'])].append(row)
    scores = {m: {'tuning': [], 'holdout': []} for m in MODELS}
    tier_errors = {m: collections.defaultdict(list) for m in MODELS}
    groups_used, test_rows = 0, 0
    for (player, season, won), seq in sorted(groups.items()):
        seq.sort(key=lambda r: (r['date'], r['mid']))
        if len(seq) < 20:
            continue
        cut = int(len(seq) * .7)
        train, test = seq[:cut], seq[cut:]
        split = 'tuning' if int(hashlib.sha256(player.encode()).hexdigest()[:8], 16) % 10 < 5 else 'holdout'
        groups_used += 1
        test_rows += len(test)
        for model in MODELS:
            errors = [(predict(train, r, model) - r['y']) ** 2 for r in test]
            scores[model][split].append(dict(player=player, season=season, won=won,
                                           mse=statistics.fmean(errors), n=len(test)))
            if split == 'holdout':
                for row, error in zip(test, errors):
                    tier_errors[model][(row['tier'], row['won'], row['platform'])].append((player, error))
    def summarize(items):
        players = collections.defaultdict(list)
        for item in items:
            players[item['player']].append(item['mse'])
        return dict(players=len(players), groups=len(items), rows=sum(i['n'] for i in items),
                    player_rmse=math.sqrt(statistics.fmean(statistics.fmean(v) for v in players.values())) if players else None)
    table = {model: {split: summarize(values) for split, values in splits.items()} for model, splits in scores.items()}
    candidates = [m for m in MODELS if table[m]['tuning']['player_rmse'] is not None]
    selected = min(candidates, key=lambda m: table[m]['tuning']['player_rmse']) if candidates else None
    def by_player(items):
        values = collections.defaultdict(list)
        for item in items:
            values[item['player']].append(item['mse'])
        return {p: statistics.fmean(v) for p, v in values.items()}
    comparisons = {}
    if selected:
        chosen = by_player(scores[selected]['holdout'])
        for baseline in ['act_mean', 'near30_k5_prior8']:
            control = by_player(scores[baseline]['holdout'])
            ids = sorted(chosen.keys() & control.keys())
            if not ids:
                continue
            rng = random.Random(17431)
            differences = []
            for _ in range(1000):
                sample = rng.choices(ids, k=len(ids))
                differences.append(math.sqrt(statistics.fmean(chosen[p] for p in sample)) -
                                   math.sqrt(statistics.fmean(control[p] for p in sample)))
            differences.sort()
            comparisons[baseline] = dict(players=len(ids),
                rmse_difference=math.sqrt(statistics.fmean(chosen.values())) - math.sqrt(statistics.fmean(control.values())),
                bootstrap_95=[differences[25], differences[974]],
                interpretation='Negative means selected curve has lower error; resampling unit is permanent player.')
    strata = {}
    for model, groups in tier_errors.items():
        strata[model] = []
        for (tier, won, platform), items in sorted(groups.items(), key=lambda v: str(v[0])):
            by = collections.defaultdict(list)
            for player, error in items:
                by[player].append(error)
            strata[model].append(dict(starting_tier=tier, won=won, platform=platform,
                rows=len(items), players=len(by),
                player_rmse=math.sqrt(statistics.fmean(statistics.fmean(v) for v in by.values()))))
    return dict(models=table, tuning_selected=selected, groups=groups_used, temporal_test_rows=test_rows,
                paired_holdout_comparisons=comparisons, holdout_by_starting_tier=strata,
                ready_to_review=bool(selected and table[selected]['holdout']['players'] >= 30),
                method='Permanent-player split for model selection; earliest 70% trains each player/act/outcome curve, later 30% tests; equal player weights. 20 matches per outcome minimum. Nearby curve falls back to training-act mean when local support is empty; frontend currently hides unsupported points. Review rank-specific coverage before shipping.')


def competitive_update_report(rows):
    # Groups overlap: a shielded loss can also have an AFK penalty or refund.
    # Unknown adjustment fields are a separate cohort, never assumed zero.
    groups = collections.defaultdict(list)
    for row in rows:
        values, flags = row['adjustments'], row['adjustment_flags']
        for flag in flags:
            groups[flag].append(row)
        if any(value is None for value in values.values()):
            groups['adjustments_unknown'].append(row)
        elif not flags:
            groups['ordinary_reported'].append(row)
    coverage = {}
    for label in ADJUSTMENT_FIELDS:
        measured = [row['adjustments'][label] for row in rows if row['adjustments'][label] is not None]
        coverage[label] = dict(covered=len(measured), total=len(rows),
                               nonzero=sum(value != 0 for value in measured))
    cohorts = {}
    for label in ['ordinary_reported', 'adjustments_unknown', *ADJUSTMENT_FIELDS,
                  'party_penalty_or_five_stack', 'shielded', 'refunded']:
        group = groups[label]
        outcomes = {}
        for won, name in [(True, 'wins'), (False, 'losses')]:
            seq = [row for row in group if row['won'] == won]
            payouts = collections.defaultdict(list)
            for row in seq:
                payouts[row['player']].append(row['y'])
            outcomes[name] = dict(rows=len(seq), players=len(payouts),
                player_mean_abs_payout=statistics.fmean(statistics.fmean(v) for v in payouts.values()) if payouts else None)
        cohorts[label] = dict(rows=len(group), players=len({row['player'] for row in group}),
                             outcomes=outcomes, evaluation=evaluate(group))
    return dict(rows=len(rows), field_coverage=coverage,
                starting_sources=dict(collections.Counter(row['starting_source'] for row in rows)),
                cohorts=cohorts,
                method='Coordinate-checked non-placement wins/losses with known party context. Cohorts overlap and may contain different players; comparisons are descriptive, not causal. Payouts remain raw last_change; adjustment units/overlap are not assumed and nothing is subtracted. Ordinary reported requires all four adjustment fields to be present and zero, with no party penalty, five-stack, shield or refund.')


def benchmark_report(records, act, checksum):
    rows, audit = eligible_rows(records, act)
    contextual, context_audit = eligible_rows(records, act, include_adjustments=True)
    buckets = collections.defaultdict(list)
    for row in rows:
        buckets[(row['tier'], row['won'])].append(row)
    coverage = [dict(starting_tier=tier, won=won, rows=len(seq), players=len({r['player'] for r in seq}))
                for (tier, won), seq in sorted(buckets.items())]
    return dict(format=2, act=act, snapshot_sha256=checksum, audit=audit, coverage=coverage,
                evaluation=evaluate(rows), competitive_updates=competitive_update_report(contextual),
                competitive_update_audit=context_audit,
                primary_scope='Excludes reported nonzero bonus, AFK/RR penalty and new-map forgiveness, party penalties and five-stacks. Legacy unknown adjustment fields remain eligible for continuity; use ordinary_reported for the fully measured ordinary cohort. Shield/refund behavior retains the coordinate audit.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('--act', help='Act short name, or use --completed-acts')
    parser.add_argument('--completed-acts', action='store_true', help='Benchmark acts superseded by a newer observed act')
    parser.add_argument('--out', type=Path, default=Path('.local/rr-corpus/benchmark'))
    args = parser.parse_args()
    if bool(args.act) == bool(args.completed_acts):
        parser.error('Choose --act or --completed-acts')
    with gzip.open(args.snapshot, 'rt', encoding='utf-8') as stream:
        records = [json.loads(line) for line in stream if line.strip()]
    checksum = hashlib.sha256(args.snapshot.read_bytes()).hexdigest()
    dates = {}
    for rec in records:
        act = rec['rr'].get('season', {}).get('short')
        date = rec['rr'].get('date')
        if act and date:
            dates[act] = max(dates.get(act, ''), date)
    active = max(dates, key=dates.get) if dates else None
    acts = sorted(a for a in dates if a != active) if args.completed_acts else [args.act]
    reports = []
    for act in acts:
        report = benchmark_report(records, act, checksum)
        # Treat upstream labels as data; never use them directly as path segments.
        directory = args.out / hashlib.sha256(act.encode()).hexdigest()[:12] if args.completed_acts else args.out
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'benchmark.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        reports.append(dict(act=act, eligible=report['audit']['eligible'], tuning_selected=report['evaluation']['tuning_selected'],
                            ready_to_review=report['evaluation']['ready_to_review']))
        if not args.completed_acts:
            print(json.dumps(report, indent=2))
    if args.completed_acts:
        args.out.mkdir(parents=True, exist_ok=True)
        index = dict(latest_observed_act=active, snapshot_sha256=checksum, reports=reports,
                     completion_rule='Acts with data earlier than the latest observed act; not a forecast of Riot act-end dates.')
        (args.out / 'index.json').write_text(json.dumps(index, indent=2), encoding='utf-8')
        print(json.dumps(index, indent=2))


if __name__ == '__main__':
    main()
