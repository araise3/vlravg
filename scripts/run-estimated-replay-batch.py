"""Run the same provenance-bound estimator on independent matches concurrently."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import importlib.util
import html
import json
import os
from pathlib import Path


def load_builder():
    spec = importlib.util.spec_from_file_location('estimated_builder', Path(__file__).with_name('build-estimated-replay-metrics.py'))
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    return builder


def phase_issues(data):
    issues = []
    for r in data['rounds']:
        start, end = r.get('combat_start_ms'), r.get('combat_end_ms')
        if not isinstance(start, int) or not isinstance(end, int) or start >= end:
            issues.append(f'round[{r["index"]}].combat_clock: missing or invalid observed combat interval')
    if not data['rounds']:
        issues.append('combat_clock: no observed rounds')
    return issues


def build_one(builder, record, review, out, sources):
    data = json.loads((review / 'library' / record['match_id'] / 'replay.json').read_bytes())
    issues = phase_issues(data)
    if not issues:
        return builder.build(record, review, out, dict(builder.POLICY), sources)
    # A private module restricts sampling to observed combat intervals. The
    # strict estimator stays unchanged; only this affected report also pins
    # the corpus driver. No interval is invented for an unfinished round.
    gated = load_builder()
    usable = [r for r in data['rounds'] if not phase_issues({'rounds': [r]})]
    omitted = [dict(round=r['index'], reason='observed_combat_clock_unknown') for r in data['rounds'] if r not in usable]
    if usable:
        ordinary_sampling = gated.sampling_times
        gated.sampling_times = lambda replay, inputs, settings, selected_round=None: ordinary_sampling(
            {**replay, 'rounds': usable}, inputs, settings, selected_round)
    else:
        ordinary_quality = gated.quality_issues
        gated.quality_issues = lambda replay: ordinary_quality(replay) + phase_issues(replay)
    gate_sources = {**sources, Path(__file__).name: builder.digest(Path(__file__))}
    report, path = gated.build(record, review, out, dict(builder.POLICY), gate_sources)
    report['round_clock_coverage'] = dict(total_rounds=len(data['rounds']), usable_rounds=[r['index'] for r in usable], excluded_rounds=omitted)
    if report['status'] == 'estimated':
        note = ' Rounds without an observed combat interval are excluded with unknown timing.'
        if not report['assumptions']['population'].endswith(note):
            report['assumptions']['population'] += note
    pending = path.with_suffix('.phase.tmp')
    pending.write_bytes(builder.packed(report)); os.replace(pending, path)
    return report, path


def render_report(builder, report, path, review):
    builder.render_match(report, path, review)
    coverage = report.get('round_clock_coverage')
    if coverage and report['status'] == 'estimated':
        notice = f'<p class="note">{len(coverage["usable_rounds"])} of {coverage["total_rounds"]} rounds have usable observed combat intervals. Timing stays unknown for excluded rounds: ' + ', '.join(str(r['round'] + 1) for r in coverage['excluded_rounds']) + '.</p>'
        presentation = path.with_suffix('.html')
        text = presentation.read_text(encoding='utf-8')
        presentation.write_text(text.replace('<div class="stats">', notice + '<div class="stats">', 1), encoding='utf-8')


def publish_index(builder, out, reports, total, sources):
    index = builder.write_index(out, reports, total, sources)
    index['round_clock_exclusions'] = [dict(match_id=r['match_id'], **r['round_clock_coverage']) for r, _ in reports if r.get('round_clock_coverage')]
    (out / 'index.json').write_bytes(builder.packed(index))
    builder.render_index(index, out)
    if index['round_clock_exclusions']:
        notices = []
        for entry in index['round_clock_exclusions']:
            mid = entry['match_id']
            notices.append(f'<a href="matches/{html.escape(mid, quote=True)}.html">{html.escape(mid[:8])}</a>: ' + ', '.join(str(r['round'] + 1) for r in entry['excluded_rounds']))
        notice = '<p class="note">Rounds without usable combat clocks remain excluded with unknown timing. Replay / round: ' + '; '.join(notices) + '.</p>'
        presentation = out / 'index.html'
        text = presentation.read_text(encoding='utf-8')
        presentation.write_text(text.replace('<h2>Players across replays</h2>', notice + '<h2>Players across replays</h2>', 1), encoding='utf-8')
    return index


def main():
    builder = load_builder()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus', type=Path)
    parser.add_argument('review', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--jobs', type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 4:
        raise ValueError('Use between one and four independent match workers')
    records = [r for r in json.loads(args.corpus.read_text(encoding='utf-8'))['replays'] if r['status'] == 'validated']
    if not records or len({r['match_id'] for r in records}) != len(records):
        raise ValueError('Expected a nonempty corpus with unique match IDs')
    out = args.out or args.review / 'estimated-metrics'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'matches').mkdir(exist_ok=True)
    sources = {name: builder.digest(builder.ROOT / 'scripts' / name) for name in builder.SOURCES}
    completed, failures = {}, []
    # One job per unique match, one publisher for the index. Run without another
    # batch writing the same directory; unchanged reports are reused by receipt.
    with ThreadPoolExecutor(max_workers=args.jobs) as workers:
        jobs = {workers.submit(build_one, builder, record, args.review, out, sources): record for record in records}
        for future in as_completed(jobs):
            record = jobs[future]
            try:
                result = future.result()
            except Exception as error:
                failures.append((record['match_id'], str(error)))
                print(json.dumps(dict(match_id=record['match_id'], state='failed', error=str(error))), flush=True)
                continue
            completed[record['match_id']] = result
            reports = [completed[r['match_id']] for r in records if r['match_id'] in completed]
            render_report(builder, *result, args.review)
            index = publish_index(builder, out, reports, len(records), sources)
            print(json.dumps(dict(progress=f'{len(reports)}/{len(records)}', match_id=record['match_id'], state=result[0]['status'], **result[0]['summary'])), flush=True)
    if failures:
        raise RuntimeError('Unpublished matches: ' + json.dumps(failures))
    print(json.dumps(dict(out=str(out.resolve()), **index['summary'])), flush=True)


if __name__ == '__main__':
    main()
