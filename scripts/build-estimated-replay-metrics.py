"""Build local, explicitly estimated visual-response metrics for the replay corpus."""
import argparse
import base64
from collections import Counter
import gzip
import hashlib
import html
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

import duckdb
from replay_visibility_inputs import load_inputs
from replay_camera_body import validate_sidecar

ROOT = Path(__file__).resolve().parent.parent
POLICY = dict(sample_ms=50, max_pose_age_ms=50, rearm_hidden_ms=250,
              prefire_quiet_ms=300, max_response_ms=2000, body_half_width_cm=21)
SOURCES = ['build-estimated-replay-metrics.py', 'analyze-estimated-replay.cjs',
           'replay-estimated-response.js', 'replay-visibility-runtime.js',
           'replay-visibility-effects.js', 'replay-transcription-viewer.js',
           'replay-behavior-runtime.js', 'replay_visibility_inputs.py', 'replay_camera_body.py']
VISION_ROOTS = ['ShooterGame/Content/Characters/_Core/FXC_Blinded_Shared.uasset',
                'ShooterGame/Content/Characters/Global/FXC/FXC_Global_Nearsight.uasset',
                'ShooterGame/Content/Characters/Global/FXC/FXC_Global_NearsightDebuff.uasset',
                'ShooterGame/Content/Characters/Global/FXC/FXC_Nearsight_Parent.uasset']


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def packed(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sampling_times(data, inputs, settings, selected_round=None):
    times = set()
    rounds = [r for r in data['rounds'] if selected_round is None or r['index'] == selected_round]
    if not rounds:
        raise ValueError('Requested round is absent')
    for r in rounds:
        times.update(range(r['combat_start_ms'], r['combat_end_ms'], settings['sample_ms']))
        # Observe the final combat millisecond without treating a later phase as combat.
        times.add(r['combat_end_ms'] - 1)
    def add(t):
        if isinstance(t, (float, int)) and any(r['combat_start_ms'] <= t < r['combat_end_ms'] for r in rounds):
            times.add(t)
    for e in data['events']:
        if e['kind'] == 'shot' or 'fov' in e['kind'] or e['kind'] == 'crouch_input_observed':
            add(e['time_ms'])
    state, model = data['asset_state'], data['asset_state']['model']
    effects = list(state['vision_effects']) + list(state['smokes']) + list(inputs.get('smoke_instances', []))
    for e in state['observations']['continuous_effects']:
        cls = e.get('profile') or e.get('effect_class')
        if cls in model['vision_profiles'] or any(p in VISION_ROOTS for p in model['asset_catalog'].get(cls, {}).get('lineage', [])):
            effects.append(e)
    for e in effects:
        for key in ['start_ms', 'end_ms', 'channel_open_ms', 'channel_close_ms']:
            add(e.get(key))
        rule = inputs.get('tail_rules', {}).get('classes', {}).get(e.get('profile') or e.get('effect_class'))
        if rule and e.get('end_reason') == 'observed_stop_rpc':
            add(e['end_ms'] + rule['duration_seconds'] * 1000)
    for rows in state['observations']['life_states'].values():
        for row in rows:
            add(row[0])
    for row in state['observations']['blind_observations']:
        add(row['time_ms'])
    for interval in inputs.get('camera_body', {}).get('remote_viewpoint_intervals', []):
        add(interval['start_ms']); add(interval['end_ms'])
    for instance in inputs.get('ability_occluders', {}).get('instances', []):
        for key in ['start_ms', 'end_ms', 'observed_flag_end_ms', 'collision_enable_observed_ms']:
            add(instance.get(key))
        for row in instance.get('anchor_observations', []) + instance.get('later_anchor_observations', []) + instance.get('channel_close_observations', []):
            add(row['time_ms'])
    for instance in inputs.get('dynamic_occluders', {}).get('instances', []):
        for row in instance['network_epochs']:
            add(row['start_ms']); add(row['end_ms'])
        for row in instance['observations']:
            add(row['time_ms'])
    return sorted(times), rounds


def quality_issues(data):
    quality = data['diagnostics']['parser_quality']
    required = {'root': ['content_blocks_lost', 'partial_rows', 'event_layout_mismatches'],
                'net': ['malformed_packets', 'partial_errors', 'unfinished_partials', 'bunch_header_failures',
                        'content_block_framing_failures', 'malformed_content_blocks', 'transform_failures',
                        'field_stream_failures', 'channel_state_limit_failures', 'partial_resource_limit_failures'],
                'sink': ['overlay_decoded_err', 'overlay_handle_conflicts_refused', 'truncated_rpcs']}
    issues = []
    for section, keys in required.items():
        values = quality if section == 'root' else quality.get(section, {})
        for key in keys:
            if values.get(key) != 0:
                issues.append(f'{section}.{key}: {values.get(key, "missing")}')
    shots = data['diagnostics']['shot_extraction']
    for key in ['ambiguous_rpc_groups', 'unresolved_effects', 'unresolved_firing_effects', 'outside_round']:
        if shots.get(key, 0):
            issues.append(f'shots.{key}: {shots[key]}')
    if len([e for e in data['events'] if e['kind'] == 'shot']) != shots.get('observed_discharges'):
        issues.append('shot inventory/count mismatch')
    return issues


def native_tracks(export, data, times):
    """ASOF join retains original timestamps; no interpolation or future pose use."""
    with duckdb.connect() as con:
        con.execute('CREATE TEMP TABLE sample_times(time_ms DOUBLE)')
        con.execute('INSERT INTO sample_times SELECT unnest(?)', [times])
        con.execute('CREATE TEMP TABLE bodies(subject VARCHAR, guid BIGINT)')
        bindings = [(p['subject'], guid) for p in data['players'] for guid in p['bodies']]
        if len({g for _, g in bindings}) != len(bindings):
            raise ValueError('Ambiguous player-body mapping')
        con.executemany('INSERT INTO bodies VALUES (?,?)', bindings)
        rows = con.execute('''
            WITH movement AS (
              SELECT b.subject, m.time_ms, m.packet_id, pos_x,pos_y,pos_z,yaw,pitch,movement_state
              FROM read_parquet(?) m JOIN bodies b ON m.character_net_guid=b.guid
              WHERE m.time_ms BETWEEN ? AND ?
              QUALIFY row_number() OVER(PARTITION BY b.subject,m.time_ms ORDER BY m.packet_id DESC)=1
            ), queries AS (SELECT DISTINCT b.subject,s.time_ms FROM bodies b CROSS JOIN sample_times s)
            SELECT DISTINCT q.subject,m.time_ms,pos_x,pos_y,pos_z,yaw,pitch,movement_state
            FROM queries q ASOF LEFT JOIN movement m ON q.subject=m.subject AND q.time_ms>=m.time_ms
            WHERE m.time_ms IS NOT NULL
            ORDER BY q.subject,m.time_ms
        ''', [str(export / 'movement.parquet'), times[0] - 50, times[-1]]).fetchall()
    tracks = {p['subject']: [] for p in data['players']}
    for subject, *row in rows:
        tracks[subject].append(row)
    return tracks


def build(record, review, out, settings, source_hashes, selected_round=None):
    directory = review / 'library' / record['match_id']
    raw = (directory / 'replay.json').read_bytes()
    data = json.loads(raw)
    export = Path(record['export'])
    provenance = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
    manifest_hash = digest(export / 'manifest.json')
    if (record['status'] != 'validated' or data['match_id'] != record['match_id'] or data['replay_build'] != record['build']
            or data['source_provenance']['source_replay_sha256'] != record['source_sha256']
            or data['map']['path'] != record['map_path'] or data['export_manifest_sha256'] != manifest_hash
            or provenance['replay_export_manifest_sha256'] != manifest_hash):
        raise ValueError('Replay/export identity or provenance mismatch')
    bundle = json.loads(re.search(r'<script id="replay-bundle" type="application/json">(.*?)</script>',
                                 (directory / 'viewer.html').read_text(encoding='utf-8'), re.S)[1])
    if gzip.decompress(base64.b64decode(bundle['data'], validate=True)) != raw:
        raise ValueError('Published bundle differs from replay evidence')
    geometry = gzip.decompress(base64.b64decode(bundle['geometry'], validate=True))
    inputs, overlays = load_inputs(data, directory, record)
    if 'camera_body' not in inputs:
        raise ValueError('Camera/possession dependency inventory is required')
    validate_sidecar(inputs['camera_body'], record, directory / 'replay.json')
    input_bytes = packed(inputs)
    if gzip.decompress(base64.b64decode(bundle['visibility_inputs'], validate=True)) != input_bytes:
        raise ValueError('Published visibility inputs changed; refresh the viewer')
    receipt = dict(source_replay_sha256=record['source_sha256'], export_manifest_sha256=manifest_hash,
                   published_data_sha256=hashlib.sha256(raw).hexdigest(), bvh_sha256=hashlib.sha256(geometry).hexdigest(),
                   visibility_inputs_sha256=hashlib.sha256(input_bytes).hexdigest(), movement_parquet_sha256=digest(export / 'movement.parquet'),
                   decoder_revision=record['decoder_revision'], source_hashes=source_hashes,
                   policy=settings, selected_round=selected_round)
    path = out / 'matches' / (record['match_id'] + '.json')
    if path.exists():
        cached = json.loads(path.read_text(encoding='utf-8'))
        if cached.get('provenance') == receipt:
            return cached, path
    issues = quality_issues(data)
    if issues:
        report = dict(schema_version=1, status='blocked_source_quality', match_id=data['match_id'], map=data['map'],
                      summary=dict(sample_count=0, mean_ms=None, median_ms=None, mean_sampling_bounds_ms=None),
                      observers=[], source_quality_issues=issues, native_visibility_verified=False,
                      native_camera_verified=False, native_body_verified=False, native_opacity_verified=False,
                      native_activation_clock_verified=False,
                      publishable_as_human_reaction_time=False, provenance=receipt)
        path.write_bytes(packed(report))
        return report, path
    times, rounds = sampling_times(data, inputs, settings, selected_round)
    print(json.dumps(dict(match_id=data['match_id'], phase='causal_movement_queries', query_times=len(times))), flush=True)
    data['tracks'] = native_tracks(export, data, times)
    data['rounds'] = rounds
    data['events'] = [e for e in data['events'] if e['kind'] == 'shot']
    scene = dict(data=data, visibility_inputs=inputs, visibility_inputs_raw=base64.b64encode(input_bytes).decode(), overlay_bvhs=[base64.b64encode(b).decode() for b in overlays],
                 sample_times=times, policy=settings, provenance=receipt)
    # Staging lives only inside this task's output directory. Game files remain read-only.
    staging = (out / ('metric-' + uuid.uuid4().hex)).resolve()
    if not staging.is_relative_to(out.resolve()):
        raise ValueError('Staging directory escaped output root')
    staging.mkdir()
    try:
        (staging / 'scene.json').write_bytes(packed(scene))
        (staging / 'geometry.bvh').write_bytes(geometry)
        print(json.dumps(dict(match_id=data['match_id'], phase='visibility_and_encounters')), flush=True)
        subprocess.run(['node', str(ROOT / 'scripts/analyze-estimated-replay.cjs'), str(staging / 'scene.json'),
                        str(staging / 'geometry.bvh'), str(path)], check=True)
    finally:
        (staging / 'scene.json').unlink(missing_ok=True)
        (staging / 'geometry.bvh').unlink(missing_ok=True)
        staging.rmdir()
    report = json.loads(path.read_text(encoding='utf-8'))
    if report['provenance'] != receipt or report['native_visibility_verified'] is not False:
        raise ValueError('Invalid estimated result receipt')
    return report, path


def write_index(out, reports, total, source_hashes):
    rows, samples, by_player = [], [], {}
    for report, path in reports:
        rows.append(dict(match_id=report['match_id'], map=report['map']['name'], status=report['status'],
                         report='matches/' + path.name, **report['summary']))
        for observer in report['observers']:
            samples.extend(s for s in observer['samples'] if s['status'] == 'estimated')
            value = by_player.setdefault(observer['subject'], dict(subject=observer['subject'], samples=[], encounters=0,
                eligible_ms=0, known_ms=0, exclusions=Counter(), appearances=[]))
            value['samples'].extend(s for s in observer['samples'] if s['status'] == 'estimated')
            value['encounters'] += observer['encounter_count']
            value['eligible_ms'] += observer['coverage']['eligible_duration_ms']; value['known_ms'] += observer['coverage']['known_duration_ms']
            value['exclusions'].update(observer['excluded_by_reason'])
            value['appearances'].append(dict(match_id=report['match_id'], slot=observer['slot'], agent=observer['agent'], report='matches/' + path.name, **{k: observer[k] for k in ['sample_count', 'mean_ms', 'median_ms']}))
    def summary(values):
        if not values:
            return dict(sample_count=0, mean_ms=None, median_ms=None, mean_sampling_bounds_ms=None)
        ordered = sorted(s['response_ms'] for s in values); middle = len(ordered) // 2
        mean = lambda key: sum(s[key] for s in values) / len(values)
        return dict(sample_count=len(values), mean_ms=mean('response_ms'),
                    median_ms=ordered[middle] if len(ordered) % 2 else (ordered[middle-1]+ordered[middle])/2,
                    mean_sampling_bounds_ms=[mean('response_lower_ms'), mean('response_upper_ms')])
    players = []
    for player in by_player.values():
        players.append(dict(subject=player['subject'], **summary(player['samples']), encounter_count=player['encounters'],
                            known_fraction=player['known_ms']/player['eligible_ms'] if player['eligible_ms'] else None,
                            exclusions=dict(player['exclusions']), appearances=player['appearances']))
    index = dict(schema_version=1, status='complete' if len(reports)==total else 'building', processed_replays=len(reports), expected_replays=total,
                 metric='estimated_visual_response_to_first_discharge', native_visibility_verified=False,
                 publishable_as_human_reaction_time=False, summary=summary(samples), replays=rows,
                 players=sorted(players, key=lambda p: -len(p['appearances'])), source_hashes=source_hashes)
    (out / 'index.json').write_bytes(packed(index))
    return index


STYLE = '''body{font:16px/1.55 system-ui,sans-serif;background:#f6f4ef;color:#232926;margin:0}main{max-width:1100px;margin:auto;padding:32px 24px}h1{font-size:32px;line-height:1.2}h2{margin-top:36px}a{color:#165947}p{max-width:850px}.note{border-left:4px solid #ad722c;padding:12px 18px;background:#fff6e4}.stats{display:flex;flex-wrap:wrap;gap:24px;margin:24px 0}.stats div{padding:16px;background:white;min-width:150px}.stats strong{display:block;font-size:28px}.table{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #d7dcd7;vertical-align:top}th{background:#e8ede8}tr:hover td{background:#fff}select,input{font:inherit;padding:7px}details{margin:12px 0}pre{font-size:12px;max-height:420px;overflow:auto;white-space:pre-wrap;background:#e8ede8;padding:12px}.muted{color:#606e65}.pill{font-weight:600;color:#79501e}button{font:inherit;padding:8px 12px;cursor:pointer}'''


def page(title, body, script=''):
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + html.escape(title) + '</title><style>' + STYLE + '</style><main>' + body + '</main><script>' + script + '</script></html>'


def number(value, unit=' ms'):
    return '—' if value is None else f'{value:.0f}{unit}'


def render_match(report, path, review):
    summary = report['summary']
    replay_link = Path(os.path.relpath(review / 'library' / report['match_id'] / 'viewer.html', path.parent)).as_posix()
    body = f'<a href="../index.html">← All estimates</a><h1>{html.escape(report["map"]["name"])} · estimated visual response</h1><p class="muted">{html.escape(report["match_id"])}</p>'
    body += '<p class="note">A model-based timing estimate, not measured human reaction time. Camera pose, animated bodies, opacity and activation clocks remain unverified. Native LOS remains unknown.</p>'
    body += f'<p><a href="{html.escape(replay_link, quote=True)}">Open replay review</a> · <a href="{path.name}">Download full JSON audit</a></p>'
    if report['status'] != 'estimated':
        body += '<h2>Source quality prevents calculation</h2><pre>' + html.escape(json.dumps(report['source_quality_issues'], indent=2)) + '</pre>'
        path.with_suffix('.html').write_text(page('Source quality · estimated responses', body), encoding='utf-8')
        return
    body += '<p>Starts at modeled contact after 250 ms of known hidden history; ends at the first observed discharge, hit or miss. Shots in the previous 300 ms exclude an encounter. No response within 2 seconds is retained as an exclusion.</p>'
    body += f'<div class="stats"><div>Eligible responses<strong>{summary["sample_count"]}</strong></div><div>Mean<strong>{number(summary["mean_ms"])}</strong></div><div>Median<strong>{number(summary["median_ms"])}</strong></div></div>'
    body += '<label>Observer <select id="observer">' + ''.join(f'<option value="{i}">{html.escape(p["slot"])} · {html.escape(p["agent"])}</option>' for i, p in enumerate(report['observers'])) + '</select></label> <label>Rows <select id="status"><option value="all">All encounters</option><option value="estimated">Eligible responses</option><option value="excluded">Excluded / no response</option></select></label><p id="summary"></p><p id="coverage"></p><div class="table"><table><thead><tr><th>Round</th><th>Contact clock</th><th>Result</th><th>Response bounds</th><th>Inspect</th></tr></thead><tbody id="rows"></tbody></table></div><button id="more">Show next 100</button><details><summary>Unknown coverage and exclusions</summary><pre id="exclusions"></pre></details><details><summary>Sampling and model assumptions</summary><pre id="assumptions"></pre></details>'
    data = packed(report).decode().replace('<', '\\u003c')
    script = '''const report=__DATA__;const select=document.getElementById('observer'),status=document.getElementById('status'),rows=document.getElementById('rows');let limit=100;const ms=x=>x==null?'—':Math.round(x)+' ms';function render(){const p=report.observers[Number(select.value)];document.getElementById('summary').textContent=p.slot+' · '+p.subject+' · '+p.sample_count+' eligible responses · mean '+ms(p.mean_ms)+' · median '+ms(p.median_ms);document.getElementById('coverage').textContent='Usable combat coverage: '+(p.coverage.known_fraction==null?'—':(100*p.coverage.known_fraction).toFixed(1)+'%')+'. Bounds cover sample spacing only; total model error is unbounded.';document.getElementById('exclusions').textContent=JSON.stringify({encounters:p.encounter_count,excluded:p.excluded_by_reason,unknown_frame_reasons:p.unknown_frame_reasons},null,2);document.getElementById('assumptions').textContent=JSON.stringify({policy:report.policy,assumptions:report.assumptions},null,2);rows.replaceChildren();const filtered=p.samples.filter(s=>status.value==='all'||(status.value==='estimated'?s.status==='estimated':s.status!=='estimated'));for(const s of filtered.slice(0,limit)){const tr=document.createElement('tr');for(const v of [s.round+1,(s.visible_at_ms/1000).toFixed(3)+' s',s.status.replaceAll('_',' '),s.status==='estimated'?ms(s.response_lower_ms)+' – '+ms(s.response_upper_ms):'—']){const td=document.createElement('td');td.textContent=v;tr.append(td);}const td=document.createElement('td'),details=document.createElement('details'),label=document.createElement('summary'),pre=document.createElement('pre');label.textContent='Model witness / timing';pre.textContent=JSON.stringify(s,null,2);details.append(label,pre);td.append(details);tr.append(td);rows.append(tr);}document.getElementById('more').hidden=filtered.length<=limit;}select.onchange=status.onchange=()=>{limit=100;render()};document.getElementById('more').onclick=()=>{limit+=100;render()};render();'''.replace('__DATA__', data)
    script = script.replace('let limit=100;', "const initial=new URLSearchParams(location.hash.slice(1)).get('observer'),chosen=report.observers.findIndex(p=>p.subject===initial);if(chosen>=0)select.value=chosen;let limit=100;")
    path.with_suffix('.html').write_text(page('Estimated visual response · ' + report['map']['name'], body, script), encoding='utf-8')


def render_index(index, out):
    body = '<h1>Estimated visual response</h1><p>Modeled visual contact → first observed gun discharge, whether it hits or misses.</p><p class="note">These are offline model estimates. Native camera, body pose, opacity and activation clocks remain unverified. Uncertain native LOS stays unknown.</p>'
    body += f'<p>{index["processed_replays"]} / {index["expected_replays"]} replays processed · {index["summary"]["sample_count"]} eligible responses across all players. Choose a player or match below; the pooled population is not your personal reaction time.</p><p><a href="index.json">Download corpus summary</a></p>'
    body += '<h2>Players across replays</h2><p>Accounts use replay UUIDs. Means weight each eligible encounter equally. Empty populations show —. Coverage excludes dead time and requires usable observations for every enemy.</p><div class="table"><table><thead><tr><th>Account UUID</th><th>Replays</th><th>Responses</th><th>Mean</th><th>Median</th><th>Usable coverage</th><th>Browse</th></tr></thead><tbody>'
    for p in index['players']:
        coverage = '—' if p['known_fraction'] is None else f'{100*p["known_fraction"]:.1f}%'
        links = ' · '.join(f'<a href="{a["report"].replace(".json", ".html")}#observer={p["subject"]}">{html.escape(a["slot"])} / {html.escape(a["agent"])}</a>' for a in p['appearances'])
        body += f'<tr><td>{html.escape(p["subject"])}</td><td>{len(p["appearances"])}</td><td>{p["sample_count"]}</td><td>{number(p["mean_ms"])}</td><td>{number(p["median_ms"])}</td><td>{coverage}</td><td><details><summary>Matches</summary>{links}</details></td></tr>'
    body += '</tbody></table></div><h2>Matches</h2><div class="table"><table><thead><tr><th>Map / match</th><th>Status</th><th>Responses</th><th>Mean</th><th>Median</th></tr></thead><tbody>'
    for r in index['replays']:
        body += f'<tr><td><a href="{r["report"].replace(".json", ".html")}">{html.escape(r["map"])} · {r["match_id"][:8]}</a></td><td>{html.escape(r["status"].replace("_", " "))}</td><td>{r["sample_count"]}</td><td>{number(r["mean_ms"])}</td><td>{number(r["median_ms"])}</td></tr>'
    body += '</tbody></table></div><p class="muted">Sampling brackets do not bound geometry, animation, effect, network or display errors. Prefire, short re-peeks, uncertain visibility and no-response encounters are retained in each match audit.</p>'
    (out / 'index.html').write_text(page('Estimated visual response', body), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus', type=Path); parser.add_argument('review', type=Path)
    parser.add_argument('--out', type=Path); parser.add_argument('--match'); parser.add_argument('--round', type=int)
    parser.add_argument('--body-half-width-cm', type=float, default=21)
    args = parser.parse_args()
    out = args.out or args.review / 'estimated-metrics'
    out.mkdir(parents=True, exist_ok=True); (out / 'matches').mkdir(exist_ok=True)
    records = [r for r in json.loads(args.corpus.read_text(encoding='utf-8'))['replays'] if r['status']=='validated' and (args.match is None or r['match_id']==args.match)]
    if not records or args.round is not None and args.match is None:
        raise ValueError('Round selection requires an existing match')
    settings = {**POLICY, 'body_half_width_cm': args.body_half_width_cm}
    sources = {name: digest(ROOT / 'scripts' / name) for name in SOURCES}
    reports = []
    for i, record in enumerate(records):
        print(json.dumps(dict(progress=f'{i+1}/{len(records)}', match_id=record['match_id'], state='starting')), flush=True)
        reports.append(build(record, args.review, out, settings, sources, args.round))
        index = write_index(out, reports, len(records), sources)
        render_match(*reports[-1], args.review)
        render_index(index, out)
        print(json.dumps(dict(progress=f'{i+1}/{len(records)}', state=reports[-1][0]['status'], **reports[-1][0]['summary'])), flush=True)
    print(json.dumps(dict(out=str(out.resolve()), **index['summary'])), flush=True)


if __name__ == '__main__':
    main()
