"""Observed recipient vision effects and explicitly modeled crouch posture."""
from bisect import bisect_right
from collections import Counter
import json
import numpy as np


def crouch_transitions(inputs, duration_ms):
    """Constant-rate asset model; reversals continue from the current fraction."""
    rows = []
    previous = None
    for t, held in inputs:
        if previous is not None and held == previous:
            continue
        current = stance_fraction(rows, t)
        target = float(held)
        rows.append([t, current, target, abs(target-current)*duration_ms])
        previous = held
    return rows


def stance_fraction(rows, t):
    i = bisect_right([r[0] for r in rows], t)-1
    if i < 0:
        return 0.
    start, source, target, duration = rows[i]
    u = min(1., max(0., (t-start)/duration)) if duration > 0 else 1.
    return source+(target-source)*u


def stance_geometry(camera, capsule, rows, t):
    fraction = stance_fraction(rows,t)
    eye = camera['standing_eye_cm']+(camera['crouched_eye_cm']-camera['standing_eye_cm'])*fraction
    half = capsule['half_height_cm']-capsule['radius_cm']
    low = -half+camera['crouch_compression_cm']*fraction
    high = half+(camera['crouched_eye_cm']-camera['standing_eye_cm'])*fraction
    # XYZ already contains the recorded compression. Never lower it a second time.
    return {'kind':'input_driven_asset_stance_model','fraction':fraction,
            'eye_height_cm':eye,'body_offsets_cm':[low,(low+high)/2,high]}


def effect_messages(rows):
    """Split repeated calls within one packet, preserving original Parquet order."""
    messages, active = [], {}
    for t,packet,actor,obj,field,integer,real,string,boolean in rows:
        if not field or '.' not in field:
            continue
        method, name = field.split('.',1)
        key = (t,packet,actor,obj,method)
        message = active.get(key)
        if message is None or name in message['values']:
            message = {'time_ms':t,'packet_id':packet,'actor':actor,'component':obj,'method':method,'values':{}}
            active[key] = message
            messages.append(message)
        message['values'][name] = next((v for v in (integer,real,string,boolean) if v is not None),None)
    return messages


def vision_intervals(messages, profiles, guid_paths, by_body, rounds):
    intervals, active, diagnostics = [], {}, Counter()
    starts = [r['start_ms'] for r in rounds]
    for msg in messages:
        values,t = msg['values'],msg['time_ms']
        identity = values.get('EffectID')
        if identity is None:
            continue
        ri = bisect_right(starts,t)-1
        if ri < 0 or t >= rounds[ri]['end_ms']:
            continue
        r = rounds[ri]
        key = (msg['actor'],msg['component'],values.get('SourceID'),identity)
        if msg['method'] == 'MulticastPlayContinuousEffect':
            profile = guid_paths.get(values.get('EffectContainer'))
            if profile not in profiles:
                continue
            subject = by_body.get(msg['actor'])
            if subject is None:
                diagnostics['vision_recipient_unresolved'] += 1
                continue
            if key in active:
                previous = active.pop(key)
                if previous['round'] == r['index']:
                    previous['end_ms'],previous['end_reason'] = t,'effect_id_reused'
            row = {'id':f"vision-{msg['actor']}-{msg['component']}-{identity}-{msg['packet_id']}",
                'subject':subject,'actor_net_guid':msg['actor'],'component_net_guid':msg['component'],
                'effect_id':identity,'source_id':values.get('SourceID'),'profile':profile,
                'kind':profiles[profile]['kind'],'name':profiles[profile]['name'],
                'round':r['index'],'start_ms':t,'end_ms':r['end_ms'],'end_reason':'round_boundary_no_stop_observed',
                'start_packet_id':msg['packet_id'],'evidence':'affected_player_continuous_effect_rpc',
                'start_movement_time_s':values.get('StartMovementTime'),
                'float_parameters':json.loads(values['FloatValues']) if values.get('FloatValues') else [],
                'object_parameters':json.loads(values['ObjectValues']) if values.get('ObjectValues') else []}
            active[key] = row
            intervals.append(row)
        elif msg['method'] == 'MulticastStopContinuousEffect' and key in active:
            row = active.pop(key)
            if row['round'] == r['index']:
                row.update(end_ms=t,end_reason='observed_stop_rpc',stop_packet_id=msg['packet_id'],
                           stop_movement_time_s=values.get('StopMovementTime'))
    diagnostics['vision_intervals'] = len(intervals)
    diagnostics['vision_observed_stops'] = sum(s['end_reason']=='observed_stop_rpc' for s in intervals)
    diagnostics['flash_intervals'] = sum(s['kind']=='flash' for s in intervals)
    diagnostics['nearsight_intervals'] = sum(s['kind']=='nearsight' for s in intervals)
    return intervals, dict(diagnostics)


def extract_vision(con, export, model, by_body, rounds):
    profiles = (model or {}).get('vision_profiles',{})
    if not profiles:
        return [], {'vision_profiles_available':False}
    fields = str(export/'fields.parquet')
    # The ordinal disambiguates same-packet calls; sorting only by packet is insufficient.
    rows = con.execute("""SELECT time_ms,packet_id,actor_net_guid,object_net_guid,field_name,
        value_i64,value_f64,value_str,value_bool FROM
        (SELECT *,row_number() OVER () AS ordinal FROM read_parquet(?))
        WHERE group_path='/Script/ShooterGame.EffectManagerComponent_ClassNetCache'
        AND (starts_with(field_name,'MulticastPlayContinuousEffect.') OR starts_with(field_name,'MulticastStopContinuousEffect.'))
        ORDER BY time_ms,packet_id,ordinal""",[fields]).fetchall()
    # These are class GUIDs: path is FXC_..._C and outer points to /Game/package.
    guids = con.execute('SELECT net_guid,path,outer_net_guid FROM read_parquet(?)',[str(export/'net_guids.parquet')]).fetchall()
    paths = {g:p for g,p,_ in guids}
    class_paths = {g:paths[o]+'.'+p for g,p,o in guids if o in paths and paths[o].startswith('/Game/')}
    return vision_intervals(effect_messages(rows),profiles,class_paths,by_body,rounds)


def crouch_corroboration(inputs, tracks, rounds, kills, compression):
    """Audit stationary transitions against native XYZ, without asserting stance."""
    examples, candidates = [], 0
    for subject,rows in inputs.items():
        track = tracks.get(subject)
        if track is None:
            continue
        for i,(t,held) in enumerate(rows):
            r = next((r for r in rounds if r['start_ms'] <= t < r['end_ms']),None)
            if r is None or t-100 < r['start_ms'] or t+350 >= r['end_ms']:
                continue
            if i==0 or t-rows[i-1][0]<400 or i+1<len(rows) and rows[i+1][0]-t<400:
                continue
            if any(k['round']==r['index'] and k['victim']==subject and k['time_ms']<=t+350 for k in kills):
                continue
            a,b = np.searchsorted(track[:,0],[t-100,t+350])
            segment = track[a:b+1]
            if len(segment)<30 or abs(segment[0,0]-(t-100))>20 or abs(segment[-1,0]-(t+350))>20:
                continue
            if np.max(np.ptp(segment[:,1:3],axis=0)) > .5:
                continue
            candidates += 1
            delta = float(segment[-1,3]-segment[0,3])
            expected = -compression if held else compression
            if abs(delta-expected)<.5:
                examples.append({'subject':subject,'time_ms':t,'round':r['index'],'held':held,'observed_z_delta_cm':round(delta,3)})
    return {'kind':'stationary_native_position_cross_check','candidates':candidates,'matched_transitions':len(examples),
            'compression_cm':compression,'examples':examples,
            'meaning':'Supports the compression model on these stationary transitions; does not establish every achieved stance.'}
