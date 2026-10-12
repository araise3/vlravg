"""Observed possession dependencies for replay visibility, not a native camera.

Only explicit replicated possession flags can open an interval. Ownership comes
from recorded PlayerState, OriginalPawn or controller PlayerState references.
Actor class names describe an observed actor; they never activate a camera.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import Counter, defaultdict
import argparse
import hashlib
import json
from pathlib import Path

from replay_bitwindows import Bits


COMPONENT_GROUPS = {
    '/Game/Characters/States/PossessableActorComponent.PossessableActorComponent_C',
    '/Game/Characters/Rift/S0/Ability_X/WorldTargeting/Rift_PossessableActorComponent.Rift_PossessableActorComponent_C',
}
CAMERA_PAWN_GROUP = '/Game/Characters/Gumshoe/S0/Ability_E/Pawn_Gumshoe_E_PossessableCamera.Pawn_Gumshoe_E_PossessableCamera_C'
CHECKSUMS = {
    'IsPossessed': 1066899736,
    'SetRotation.OriginalPawn': 3611687831,
    'SetRotation.PossessingController': 631909918,
    'SetRotation.ClearPossessingController': 546531464,
    'SetRotation.InControlRotation': 740084253,
}
PAWN_CHECKSUMS = {'PlayerState': 3964024390, 'Controller': 1134544246,
                  'Possessed': 2181339745}


def decoded_reference(record):
    """Read an entire canonical object-reference payload or a typed GUID."""
    bits = Bits(record.get('raw_bits') or b'', record['bit_count'])
    value = bits.packed()
    if bits.pos != bits.count:
        raise ValueError('Unconsumed object-reference bits')
    if record.get('value_i64') is not None:
        typed = record['value_i64']
        if type(typed) is not int or not 0 <= typed <= 0xffffffff:
            raise ValueError('Invalid typed net GUID')
        if typed != value:
            raise ValueError('Typed and raw object reference disagree')
    return value


def decoded_bool(record):
    bits = Bits(record.get('raw_bits') or b'', record['bit_count'])
    if bits.count != 1:
        raise ValueError('Possession Boolean is not one bit')
    value = bool(bits.read(1))
    typed = record.get('value_bool')
    if typed is not None and (type(typed) is not bool or typed != value):
        raise ValueError('Typed and raw Boolean disagree')
    return value


def receipt(row, value):
    return {
        'time_ms': row['time_ms'], 'packet_id': row['packet_id'],
        'actor_net_guid': row['actor_net_guid'],
        'component_net_guid': row.get('object_net_guid'),
        'group': row['group_path'], 'field': row['field_name'],
        'compatible_checksum': row.get('compatible_checksum'),
        'bit_count': row['bit_count'],
        'raw_hex': (row.get('raw_bits') or b'').hex(), 'value': value,
    }


def possession_dependencies(rows, players, rounds, actor_rows=()):
    """Return conservative intervals and every unmatched possession signal.

    Rows must preserve source ordinal inside a packet. A same-clock frame may
    contain ownership after the flag; this joins only that exact replay clock.
    Ownership observed at a later time never backfills earlier possession.
    Round caps are knowledge bounds, never invented unpossess events.
    """
    player_states = {p['actor_net_guid']: p['subject'] for p in players}
    bodies = {g: p['subject'] for p in players
              for g in p.get('character_net_guids', [p.get('character_net_guid')]) if g is not None}
    starts = [r['start_ms'] for r in rounds]
    if starts != sorted(starts) or any(r['start_ms'] >= r['end_ms'] for r in rounds):
        raise ValueError('Invalid round boundaries')
    if any(a['end_ms'] > b['start_ms'] for a, b in zip(rounds, rounds[1:])):
        raise ValueError('Overlapping rounds')
    observations, unresolved, intervals = [], [], []
    diagnostic = Counter()
    state, controller_states = {}, {}
    active = {}
    actor_classes, actor_closes = defaultdict(list), defaultdict(list)
    for actor in actor_rows:
        if actor['event'] == 'open':
            actor_classes[actor['actor_net_guid']].append(actor)
        elif actor['event'] == 'close':
            actor_closes[actor['actor_net_guid']].append(actor)

    def round_at(t):
        i = bisect_right(starts, t) - 1
        return rounds[i] if i >= 0 and t < rounds[i]['end_ms'] else None

    def owner(scope, t):
        facts = state[scope]
        candidates = []
        for key, lookup in (('PlayerState', player_states), ('OriginalPawn', bodies)):
            evidence = facts.get(key)
            if evidence is not None and evidence['value'] in lookup:
                candidates.append((lookup[evidence['value']], evidence))
        evidence = facts.get('Controller')
        if evidence is not None and evidence['value'] in controller_states:
            controller = controller_states[evidence['value']]
            if controller['value'] in player_states:
                candidates.append((player_states[controller['value']],
                                   {'controller_reference': evidence, 'controller_player_state': controller}))
        subjects = {s for s, _ in candidates}
        if len(subjects) == 1:
            return next(iter(subjects)), [e for _, e in candidates], None
        return None, [e for _, e in candidates], 'conflicting_ownership' if subjects else 'ownership_not_observed'

    def finish(scope, t, reason, evidence=None):
        item = active.pop(scope, None)
        if item is None:
            return False
        item['end_ms'] = min(t, item['end_ms'])
        item['end_reason'] = reason
        item['end_boundary_kind'] = ('observed_replication_clock' if evidence else
                                     'ownership_knowledge_cap' if reason == 'ownership_knowledge_lost' else
                                     'round_knowledge_cap')
        if evidence:
            item['stop_observation'] = evidence
            item['stop_observed_ms'] = t
        return True

    def open_interval(scope, row):
        t = row['time_ms']
        r = round_at(t)
        subject, chain, reason = owner(scope, t)
        if r is None or reason:
            unresolved.append({'observation': row, 'reason': reason or 'outside_round',
                               'ownership_evidence': chain})
            diagnostic[reason or 'outside_round'] += 1
            return
        if scope in active:
            active[scope]['additional_start_observations'].append(row)
            return
        actor, component, group = scope
        cls = [v for v in actor_classes[actor] if v['time_ms'] <= t]
        item = {
            'id': f"possession-{actor}-{component or 0}-{row['packet_id']}",
            'subject': subject, 'round': r['index'], 'actor_net_guid': actor,
            'component_net_guid': component, 'source_group': group,
            'actor_class': cls[-1].get('class_path') if cls else None,
            'start_ms': t, 'end_ms': r['end_ms'],
            'start_observed_ms': t, 'start_reason': 'observed_possession_true',
            'end_reason': 'round_boundary_no_stop_observed',
            'start_boundary_kind': 'observed_replication_clock',
            'end_boundary_kind': 'round_knowledge_cap',
            'start_observation': row, 'ownership_evidence': chain,
            'additional_start_observations': [],
            'camera_pose_reconstructed': False, 'native_camera_switch_verified': False,
            'visibility_dependency': 'remote_viewpoint_pose_unresolved',
        }
        intervals.append(item)
        active[scope] = item

    # Exact clock grouping also avoids treating arbitrary packet spacing as a
    # permissible future join. PlayerState facts are read before this clock's
    # starts while preserving repeated RPC member occurrences below.
    frames = defaultdict(list)
    for ordinal, row in enumerate(rows):
        frames[row['time_ms']].append((row.get('ordinal', ordinal), row))
    for t, frame in sorted(frames.items()):
        frame.sort(key=lambda x: (x[1]['packet_id'], x[0]))
        for scope, item in list(active.items()):
            if t >= item['end_ms']:
                active.pop(scope)
        events = []
        for _, raw in frame:
            group, name = raw['group_path'], raw['field_name']
            component_group = group.removesuffix('_ClassNetCache') in COMPONENT_GROUPS
            pawn_group = group == CAMERA_PAWN_GROUP
            if name == 'PlayerState' and not component_group:
                if raw.get('compatible_checksum') != PAWN_CHECKSUMS['PlayerState']:
                    if pawn_group:
                        unresolved.append({'observation': receipt(raw, None), 'reason': 'pawn_schema_mismatch'})
                        diagnostic['pawn_schema_mismatch'] += 1
                    continue
                try:
                    obs = receipt(raw, decoded_reference(raw))
                    controller_states[raw['actor_net_guid']] = obs
                    if pawn_group:
                        state.setdefault((raw['actor_net_guid'], None, group), {})['PlayerState'] = obs
                    continue
                except ValueError as error:
                    if pawn_group:
                        unresolved.append({'observation': receipt(raw, None), 'reason': str(error)})
                        diagnostic['invalid_payload'] += 1
                    # This is an ownership source only; unrelated malformed
                    # PlayerState fields are never converted into starts.
                    continue
            if not (component_group or pawn_group):
                continue
            if pawn_group and name in PAWN_CHECKSUMS and raw.get('compatible_checksum') != PAWN_CHECKSUMS[name]:
                unresolved.append({'observation': receipt(raw, None), 'reason': 'pawn_schema_mismatch'})
                diagnostic['pawn_schema_mismatch'] += 1
                continue
            if component_group and (raw.get('object_net_guid') is None or
                                    raw.get('compatible_checksum') != CHECKSUMS.get(name)):
                if name == 'IsPossessed' or name.startswith('SetRotation.'):
                    obs = receipt(raw, None)
                    unresolved.append({'observation': obs, 'reason': 'component_or_schema_mismatch'})
                    diagnostic['component_or_schema_mismatch'] += 1
                continue
            if component_group:
                scope = (raw['actor_net_guid'], raw['object_net_guid'], group.removesuffix('_ClassNetCache'))
                member = name.removeprefix('SetRotation.')
            else:
                scope = (raw['actor_net_guid'], None, group)
                member = name
            facts = state.setdefault(scope, {})
            try:
                if member in ('OriginalPawn', 'PossessingController', 'Controller', 'PlayerState'):
                    obs = receipt(raw, decoded_reference(raw))
                    facts['Controller' if member == 'PossessingController' else member] = obs
                    observations.append(obs)
                elif member in ('IsPossessed', 'Possessed', 'ClearPossessingController'):
                    obs = receipt(raw, decoded_bool(raw))
                    observations.append(obs)
                    events.append((scope, obs))
                elif member == 'InControlRotation':
                    unresolved.append({'observation': receipt(raw, None),
                                       'reason': 'control_rotation_not_bound_to_camera_pose'})
                    diagnostic['control_rotation_unbound'] += 1
            except ValueError as error:
                unresolved.append({'observation': receipt(raw, None), 'reason': str(error)})
                diagnostic['invalid_payload'] += 1
        for scope, obs in events:
            if obs['field'] == 'SetRotation.ClearPossessingController':
                if obs['value']:
                    if not finish(scope, t, 'observed_clear_controller_rpc', obs):
                        unresolved.append({'observation': obs, 'reason': 'stop_without_live_start'})
                        diagnostic['stop_without_live_start'] += 1
            elif obs['value']:
                open_interval(scope, obs)
            elif not finish(scope, t, 'observed_possession_false', obs):
                # An observed false baseline is retained, not treated as a
                # missing event and not expanded backwards into the replay.
                diagnostic['false_without_live_start'] += 1
        # Ownership changes inside an active interval are dependencies too:
        # never silently assign the remainder to the old subject.
        for scope, item in list(active.items()):
            subject, chain, reason = owner(scope, t)
            if reason or subject != item['subject']:
                finish(scope, t, 'ownership_knowledge_lost')
                unresolved.append({'observation': item['start_observation'],
                                   'time_ms': t, 'reason': reason or 'ownership_changed',
                                   'ownership_evidence': chain})
                diagnostic['active_ownership_lost'] += 1
    for item in intervals:
        closes = [a for a in actor_closes[item['actor_net_guid']]
                  if item['start_ms'] <= a['time_ms'] < item['end_ms']]
        item['actor_channel_close_observations'] = [
            {'time_ms': a['time_ms'], 'packet_id': a['packet_id'], 'event': 'close'} for a in closes]
        # A channel close is deliberately not equated with native unpossess.
    intervals.sort(key=lambda x: (x['start_ms'], x['actor_net_guid'], x['component_net_guid'] or 0))
    diagnostic.update(intervals=len(intervals), unmatched=len(unresolved),
                      recorded_stops=sum('stop_observation' in x for x in intervals),
                      round_capped=sum(x['end_reason'] == 'round_boundary_no_stop_observed' for x in intervals))
    return {'schema_version': 1, 'remote_viewpoint_intervals': intervals,
            'possession_observations': observations, 'unmatched_records': unresolved,
            'diagnostics': dict(diagnostic), 'camera_reconstruction_complete': False,
            'body_reconstruction_complete': False,
            'limitations': [
                'Recorded possession flags identify a camera dependency; native camera switches and camera pose are unverified.',
                'Start and stop clocks are replicated observations, not sub-frame native transition times.',
                'Round and ownership caps bound evidence coverage; they do not establish unpossess.',
                'Actor channel closure does not establish an unpossess or visibility transition.',
                'Recorded movement and crouch input do not establish achieved camera height or animated body silhouette.',
            ]}


def extract_camera_dependencies(con, export, manifest, rounds):
    fields = str(export / 'fields.parquet')
    # All PlayerState references are possible controller joins. Exact known
    # component classes and the explicitly replicated camera flag restrict
    # activations; general controller/pawn names do not imply possession.
    # Fetch typed records directly: fetchdf would coerce nullable GUIDs to floats.
    result = con.execute("""SELECT *, row_number() OVER () AS ordinal FROM read_parquet(?)
        WHERE field_name='PlayerState' OR contains(group_path, 'PossessableActorComponent')
        OR group_path=? ORDER BY time_ms,packet_id,ordinal""", [fields, CAMERA_PAWN_GROUP])
    names = [d[0] for d in result.description]
    rows = [dict(zip(names, row)) for row in result.fetchall()]
    result = con.execute("SELECT time_ms,packet_id,actor_net_guid,event,class_path FROM read_parquet(?) ORDER BY time_ms,packet_id",
                         [str(export / 'actors.parquet')])
    actor_names = [d[0] for d in result.description]
    actors = [dict(zip(actor_names, row)) for row in result.fetchall()]
    return possession_dependencies(rows, manifest['players'], rounds, actors)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build_sidecar(con, record, review):
    """Pin a dependency sidecar to its exact immutable export and round evidence."""
    export = Path(record['export'])
    manifest_path = export / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    replay_path = review / 'library' / record['match_id'] / 'replay.json'
    replay = json.loads(replay_path.read_text(encoding='utf-8'))
    provenance_path = replay_path.parent / 'provenance.json'
    provenance = json.loads(provenance_path.read_text(encoding='utf-8'))
    export_hash = digest(manifest_path)
    if provenance.get('replay_export_manifest_sha256') != export_hash:
        raise ValueError('Viewer and original export manifest disagree')
    if (replay['match_id'] != record['match_id'] or replay['replay_build'] != record['build'] or
            manifest['replay_build'] != record['build'] or
            replay['source_provenance']['source_replay_sha256'] != record['source_sha256']):
        raise ValueError('Corpus and viewer source identity disagree')
    if {p['subject'] for p in manifest['players']} != {p['subject'] for p in replay['players']}:
        raise ValueError('Corpus and viewer subjects disagree')
    result = extract_camera_dependencies(con, export, manifest, replay['rounds'])
    result.update(match_id=record['match_id'], replay_build=record['build'],
                  duration_ms=manifest['duration_ms'], clock='original decoded replay milliseconds',
                  source_provenance={
                      'source_replay_sha256': record['source_sha256'],
                      'export_manifest_sha256': export_hash,
                      'fields_sha256': digest(export / 'fields.parquet'),
                      'actors_sha256': digest(export / 'actors.parquet'),
                      'review_replay_sha256': digest(replay_path),
                      'helper_sha256': digest(Path(__file__)),
                      'bit_reader_sha256': digest(Path(__file__).with_name('replay_bitwindows.py')),
                      'decoder_sha256': record['decoder_sha256'],
                      'decoder_revision': record['decoder_revision'],
                  })
    return result


def validate_sidecar(sidecar, record, replay_path=None, verify_parquet=True):
    """Verify exact source/helper identities before accepting a cached sidecar.

    Presentation-only changes do not affect this identity. This helper performs
    no writes and callers may cache successful checks by source file metadata.
    """
    export = Path(record['export'])
    expected = {
        'source_replay_sha256': record['source_sha256'],
        'export_manifest_sha256': digest(export / 'manifest.json'),
        'helper_sha256': digest(Path(__file__)),
        'bit_reader_sha256': digest(Path(__file__).with_name('replay_bitwindows.py')),
        'decoder_sha256': record['decoder_sha256'],
        'decoder_revision': record['decoder_revision'],
    }
    if replay_path is not None:
        expected['review_replay_sha256'] = digest(replay_path)
    if verify_parquet:
        expected.update(fields_sha256=digest(export / 'fields.parquet'),
                        actors_sha256=digest(export / 'actors.parquet'))
    if (sidecar.get('schema_version') != 1 or sidecar.get('match_id') != record['match_id'] or
            sidecar.get('replay_build') != record['build'] or
            sidecar.get('duration_ms') != record['duration_ms']):
        raise ValueError('Camera dependency sidecar source identity mismatch')
    if any(sidecar.get('source_provenance', {}).get(key) != value for key, value in expected.items()):
        raise ValueError('Camera dependency sidecar provenance mismatch')
    manifest = json.loads((export / 'manifest.json').read_text(encoding='utf-8'))
    subjects = {p['subject'] for p in manifest['players']}
    if sidecar.get('camera_reconstruction_complete') is not False or sidecar.get('body_reconstruction_complete') is not False:
        raise ValueError('Camera/body reconstruction cannot be certified by possession evidence')
    for item in sidecar.get('remote_viewpoint_intervals', []):
        if (item.get('subject') not in subjects or
                type(item.get('start_ms')) is not int or type(item.get('end_ms')) is not int or
                not 0 <= item['start_ms'] <= item['end_ms'] <= record['duration_ms'] or
                item.get('native_camera_switch_verified') is not False or
                item.get('camera_pose_reconstructed') is not False):
            raise ValueError('Invalid camera dependency interval')
    return sidecar


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus', type=Path)
    parser.add_argument('review', type=Path)
    parser.add_argument('--match-id')
    args = parser.parse_args()
    import duckdb
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    records = [r for r in corpus['replays'] if r['status'] == 'validated' and
               (not args.match_id or r['match_id'] == args.match_id)]
    if not records:
        parser.error('No matching validated replay')
    out = args.review / 'visibility-inputs'
    out.mkdir(parents=True, exist_ok=True)
    totals = Counter()
    with duckdb.connect() as con:
        for record in records:
            result = build_sidecar(con, record, args.review)
            path = out / (record['match_id'] + '.json')
            temporary = path.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(result, indent=2), encoding='utf-8')
            temporary.replace(path)
            totals.update(result['diagnostics'])
            print(record['match_id'], result['diagnostics'])
    print(json.dumps({'replays': len(records), 'totals': dict(totals)}, sort_keys=True))


if __name__ == '__main__':
    main()
