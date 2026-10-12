"""Independently audit estimate receipts, observed discharges and aggregation.

This checks the offline calculation; it cannot certify native perception.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent.parent
FLAGS = ['native_visibility_verified', 'native_camera_verified', 'native_body_verified',
         'native_opacity_verified', 'native_activation_clock_verified', 'publishable_as_human_reaction_time']


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def equal(actual, expected, message):
    if expected is None:
        require(actual is None, message)
    else:
        require(isinstance(actual, (float, int)) and not isinstance(actual, bool)
                and math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-6), message)


def summary(rows, value, message):
    accepted = [s for s in rows if s['status'] == 'estimated']
    require(value['sample_count'] == len(accepted), message + ': sample count')
    equal(value['mean_ms'], statistics.mean(s['response_ms'] for s in accepted) if accepted else None, message + ': mean')
    equal(value['median_ms'], statistics.median(s['response_ms'] for s in accepted) if accepted else None, message + ': median')
    bounds = value['mean_sampling_bounds_ms']
    if accepted:
        require(isinstance(bounds, list) and len(bounds) == 2, message + ': bounds inventory')
        equal(bounds[0], statistics.mean(s['response_lower_ms'] for s in accepted), message + ': lower bound')
        equal(bounds[1], statistics.mean(s['response_upper_ms'] for s in accepted), message + ': upper bound')
    else:
        require(bounds is None, message + ': empty bounds')


def audit(corpus, review, out, allow_partial=False):
    records = {r['match_id']: r for r in json.loads(corpus.read_text(encoding='utf-8'))['replays'] if r['status'] == 'validated'}
    raw_index = (out / 'index.json').read_bytes()
    index = json.loads(raw_index)
    ids = [r['match_id'] for r in index['replays']]
    require(len(ids) == len(set(ids)) and set(ids) <= records.keys(), 'Unexpected/duplicate result match IDs')
    require(index['expected_replays'] == len(records) and index['processed_replays'] == len(ids), 'Corpus counts differ')
    require(allow_partial or set(ids) == records.keys(), 'Corpus is incomplete')
    require(index['status'] == ('complete' if len(ids) == len(records) else 'building'), 'Incorrect completion status')
    require(index['native_visibility_verified'] is False and index['publishable_as_human_reaction_time'] is False, 'Index misrepresents verification')
    source_hashes = index['source_hashes']
    require(bool(source_hashes), 'Missing implementation receipts')
    for name, sha in source_hashes.items():
        require(Path(name).name == name and digest(ROOT / 'scripts' / name) == sha, 'Implementation changed: ' + name)
    all_samples, players, receipts = [], defaultdict(list), []
    coverage, exclusions, appearances = {}, {}, {}
    statuses = Counter()
    clock_exclusions = []
    for match in index['replays']:
        mid, record = match['match_id'], records[match['match_id']]
        require(match['report'] == 'matches/' + mid + '.json', 'Unexpected result path')
        path = out / match['report']
        raw_report = path.read_bytes()
        report = json.loads(raw_report)
        require(report['match_id'] == mid and report['map']['path'] == record['map_path'], 'Match/map identity mismatch')
        require(all(report.get(flag) is False for flag in FLAGS), 'Native or human-reaction verification was promoted')
        receipt = report['provenance']
        directory = review / 'library' / mid
        require(all(receipt['source_hashes'].get(name) == sha for name, sha in source_hashes.items()) and receipt['selected_round'] is None, 'Wrong source receipts or partial-round report')
        for name, sha in receipt['source_hashes'].items():
            require(Path(name).name == name and digest(ROOT / 'scripts' / name) == sha, 'Report implementation/gate changed: ' + name)
        require(receipt['source_replay_sha256'] == record['source_sha256'] == digest(record['source']), 'Source replay changed')
        require(receipt['decoder_revision'] == record['decoder_revision'], 'Decoder revision differs')
        require(receipt['export_manifest_sha256'] == digest(Path(record['export']) / 'manifest.json'), 'Export receipt differs')
        require(receipt['movement_parquet_sha256'] == digest(Path(record['export']) / 'movement.parquet'), 'Movement changed')
        require(receipt['published_data_sha256'] == digest(directory / 'replay.json'), 'Published replay changed')
        require(path.with_suffix('.html').is_file(), 'Missing browsable match audit')
        data = json.loads((directory / 'replay.json').read_text(encoding='utf-8'))
        require(data['replay_build'] == record['build'], 'Replay build differs')
        usable_rounds = [r['index'] for r in data['rounds'] if isinstance(r.get('combat_start_ms'), int) and isinstance(r.get('combat_end_ms'), int) and r['combat_start_ms'] < r['combat_end_ms']]
        excluded_rounds = [dict(round=r['index'], reason='observed_combat_clock_unknown') for r in data['rounds'] if r['index'] not in usable_rounds]
        if excluded_rounds or not data['rounds']:
            expected_coverage = dict(total_rounds=len(data['rounds']), usable_rounds=usable_rounds, excluded_rounds=excluded_rounds)
            require(report.get('round_clock_coverage') == expected_coverage and 'run-estimated-replay-batch.py' in receipt['source_hashes'], 'Unclocked rounds lack an explicit pinned exclusion')
            clock_exclusions.append(dict(match_id=mid, **expected_coverage))
        else:
            require(not report.get('round_clock_coverage'), 'Unexpected round clock exclusion')
        statuses[report['status']] += 1
        match_samples = []
        if report['status'] == 'estimated':
            require(report['policy'] == receipt['policy'], 'Report policy differs')
            require({p['subject'] for p in report['observers']} == {p['subject'] for p in data['players']}, 'Observer inventory differs')
            policy = report['policy']
            rounds = {r['index']: r for r in data['rounds']}
            shots = {e['id']: e for e in data['events'] if e['kind'] == 'shot'}
            require(len(shots) == data['diagnostics']['shot_extraction']['observed_discharges'], 'Observed discharge inventory differs')
            by_subject = defaultdict(list)
            teams = {p['subject']: p['team'] for p in data['players']}
            for shot in shots.values():
                by_subject[shot['subject']].append(shot)
            for subject_shots in by_subject.values():
                subject_shots.sort(key=lambda s: (s['time_ms'], str(s['id'])))
            for observer in report['observers']:
                subject, rows = observer['subject'], observer['samples']
                used = set()
                require(observer['encounter_count'] == len(rows), 'Encounter count differs')
                require(observer['excluded_by_reason'] == dict(Counter(s['status'] for s in rows if s['status'] != 'estimated')), 'Exclusion count differs')
                summary(rows, observer, 'Observer ' + subject)
                c = observer['coverage']
                require(0 <= c['known_frames'] <= c['eligible_frames'] <= c['frames'] and c['known_frames'] + c['unknown_frames'] == c['eligible_frames'], 'Coverage frame counts differ')
                require(0 <= c['known_duration_ms'] <= c['eligible_duration_ms'], 'Coverage duration differs')
                equal(c['known_fraction'], c['known_duration_ms'] / c['eligible_duration_ms'] if c['eligible_duration_ms'] else None, 'Coverage fraction differs')
                cov = coverage.setdefault(subject, [0, 0])
                cov[0] += c['known_duration_ms']; cov[1] += c['eligible_duration_ms']
                exclusions.setdefault(subject, Counter()).update(observer['excluded_by_reason'])
                appearances.setdefault(subject, []).append(dict(match_id=mid, slot=observer['slot'], agent=observer['agent'], report=match['report'], **{k: observer[k] for k in ['sample_count', 'mean_ms', 'median_ms']}))
                for row in rows:
                    require(row['observer'] == subject and row['round'] in rounds, 'Encounter identity differs')
                    require(row['round'] in usable_rounds, 'Unclocked round entered encounter population')
                    if row['status'] != 'estimated':
                        require(not any(k in row for k in ['response_ms', 'response_lower_ms', 'response_upper_ms']), 'Excluded row carries a metric')
                        continue
                    shot = shots.get(row['shot_id'])
                    require(shot is not None and shot['id'] not in used, 'Missing or doubly credited discharge')
                    used.add(shot['id'])
                    require(shot['subject'] == subject and shot['round'] == row['round'] and shot['time_ms'] == row['shot_at_ms'] and shot['weapon_path'] == row['weapon_path'], 'Discharge identity differs')
                    h, v, s = row['last_hidden_at_ms'], row['visible_at_ms'], row['shot_at_ms']
                    r = rounds[row['round']]
                    require(r['combat_start_ms'] <= h < v <= s < r['combat_end_ms'], 'Timing leaves combat period')
                    require(v - h <= policy['sample_ms'] and s - v <= policy['max_response_ms'], 'Timing exceeds policy')
                    candidates = [shot for shot in by_subject[subject] if shot['round'] == row['round'] and shot['time_ms'] >= v]
                    require(candidates and candidates[0]['id'] == row['shot_id'], 'Metric did not use first observed discharge')
                    require(not any(v - policy['prefire_quiet_ms'] < shot['time_ms'] < v for shot in by_subject[subject]), 'Prefire entered accepted population')
                    equal(row['response_ms'], s - v, 'Response arithmetic differs')
                    equal(row['response_lower_ms'], s - v, 'Lower sampling bound differs')
                    equal(row['response_upper_ms'], s - h, 'Upper sampling bound differs')
                    require(set(row['targets']) == {w['target'] for w in row['onset_witnesses']} and row['targets'], 'Onset witness inventory differs')
                    for witness in row['onset_witnesses']:
                        require(teams[witness['target']] != teams[subject], 'Friendly target in encounter')
                        point = witness['point']
                        require(point and all(point[k] is True for k in ['in_view', 'wall_clear', 'smoke_clear', 'dynamic_clear']), 'Onset point lacks model clearance')
                        require(len(point['position']) == 3 and all(math.isfinite(x) for x in point['position']), 'Non-finite witness position')
                        require(len(witness['pose_times_ms']) == 2 and all(0 <= v - t <= policy['max_pose_age_ms'] for t in witness['pose_times_ms']), 'Future/stale onset pose')
                    players[subject].append(row)
                    match_samples.append(row)
        else:
            require(report['status'] == 'blocked_source_quality' and report['source_quality_issues'] and not report['observers'], 'Unknown or misleading blocked result')
        summary(match_samples, report['summary'], 'Match ' + mid)
        summary(match_samples, match, 'Match index ' + mid)
        all_samples.extend(match_samples)
        receipts.append(dict(match_id=mid, report_sha256=hashlib.sha256(raw_report).hexdigest(), eligible_responses=len(match_samples)))
        print(json.dumps(dict(audited=mid, eligible_responses=len(match_samples))), flush=True)
    require({p['subject'] for p in index['players']} == set(coverage), 'Aggregated player inventory differs')
    for player in index['players']:
        subject = player['subject']
        summary(players[subject], player, 'Player aggregate ' + subject)
        require(player['appearances'] == appearances[subject] and player['exclusions'] == dict(exclusions[subject]), 'Player appearances/exclusions differ')
        require(player['encounter_count'] == len(players[subject]) + sum(exclusions[subject].values()), 'Player aggregate encounter count differs')
        known, eligible = coverage[subject]
        equal(player['known_fraction'], known / eligible if eligible else None, 'Player aggregate coverage differs')
    summary(all_samples, index['summary'], 'Corpus aggregate')
    require(index.get('round_clock_exclusions', []) == clock_exclusions, 'Corpus round-clock exclusions differ')
    require((out / 'index.html').is_file(), 'Missing browsable corpus report')
    return dict(status='passed', scope='Offline estimate provenance and arithmetic; native perception remains unverified',
                processed_replays=len(ids), expected_replays=len(records), result_statuses=dict(statuses),
                eligible_responses=len(all_samples), index_sha256=hashlib.sha256(raw_index).hexdigest(),
                round_clock_exclusions=clock_exclusions, source_hashes=source_hashes, reports=receipts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus', type=Path); parser.add_argument('review', type=Path)
    parser.add_argument('--out', type=Path); parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    out = args.out or args.review / 'estimated-metrics'
    result = audit(args.corpus, args.review, out, args.allow_partial)
    (out / 'audit.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k not in ['source_hashes', 'reports']}))


if __name__ == '__main__':
    main()
