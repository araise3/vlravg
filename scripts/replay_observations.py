"""Named replay observations and coverage, separate from rendered game behavior."""
from __future__ import annotations
from bisect import bisect_right
from collections import Counter, defaultdict
import json
import re

from replay_status import effect_messages
from replay_bitwindows import array_delta


def guid_paths(rows):
    values = {g:(p,o) for g,p,o in rows}
    cache = {}
    def resolve(g, seen=None):
        if g in cache:
            return cache[g]
        seen = set() if seen is None else seen
        if g in seen or g not in values:
            return None
        seen.add(g)
        name, outer = values[g]
        parent = resolve(outer, seen)
        cache[g] = name if name.startswith('/') else parent+'.'+name if parent else name
        return cache[g]
    return {g:resolve(g) for g in values}


def observed_effects(messages, paths, by_body, rounds):
    intervals, events, active, diagnostics = [], [], {}, Counter()
    starts = [r['start_ms'] for r in rounds]
    for serial, msg in enumerate(messages):
        values, t = msg['values'], msg['time_ms']
        ri = bisect_right(starts,t)-1
        if ri < 0 or t >= rounds[ri]['end_ms']:
            continue
        r = rounds[ri]
        cls = paths.get(values.get('EffectContainer'))
        key = (msg['actor'],msg['component'],values.get('SourceID'),values.get('EffectID'))
        event = {'kind':'effect_rpc_observed','id':f"fx-rpc-{serial}-{msg['packet_id']}",
            'time_ms':t,'round':r['index'],'subject':by_body.get(msg['actor']),
            'actor_net_guid':msg['actor'],'component_net_guid':msg['component'],
            'method':msg['method'],'effect_class':cls,'parameters':values,
            'evidence':'native_effect_manager_rpc','gameplay_semantics':'unverified'}
        events.append(event)
        if msg['method']=='MulticastPlayContinuousEffect' and values.get('EffectID') is not None:
            if key in active:
                old=active.pop(key)
                if old['round']==r['index']:
                    old.update(end_ms=t,end_reason='effect_id_reused')
            row={'id':event['id'],'subject':event['subject'],'actor_net_guid':msg['actor'],
                'component_net_guid':msg['component'],'effect_id':values['EffectID'],
                'source_id':values.get('SourceID'),'effect_class':cls,
                'name':(cls or 'Unresolved effect class').rsplit('.',1)[-1],
                'round':r['index'],'start_ms':t,'end_ms':r['end_ms'],
                'end_reason':'round_boundary_no_stop_observed','start_packet_id':msg['packet_id'],
                'parameters':values,'updates':[],'evidence':'native_effect_manager_rpc',
                'gameplay_semantics':'unverified'}
            intervals.append(row);active[key]=row
        elif msg['method']=='MulticastStopContinuousEffect':
            old=active.pop(key,None)
            if old and old['round']==r['index']:
                old.update(end_ms=t,end_reason='observed_stop_rpc',stop_packet_id=msg['packet_id'])
                event['effect_class']=old['effect_class']
            else:
                diagnostics['effect_stops_without_live_start']+=1
        elif msg['method']=='MulticastUpdateContinuousEffect':
            old=active.get(key)
            if old and old['round']==r['index']:
                old['updates'].append({'time_ms':t,'packet_id':msg['packet_id'],'parameters':values})
                event['effect_class']=old['effect_class']
            else:
                diagnostics['effect_updates_without_live_start']+=1
    diagnostics.update(named_continuous_effects=len(intervals),effect_rpc_observations=len(events),
        effect_classes_unresolved=sum(e['effect_class'] is None for e in events if e['method'].startswith(('MulticastPlay','ReplayRecord'))))
    return intervals,events,dict(diagnostics)


def blind_membership(rows, paths, by_body, rounds, vision):
    """Apply measured struct-array deltas; never reuse old values for new IDs.

    Native InitialDuration is a reported duration, not a measured opacity or
    an invented endpoint. Array removal and effect stop remain distinct facts.
    """
    frames=defaultdict(list)
    for row in rows:
        frames[row[:4]].append(row)
    states,active,observations,intervals,diagnostics={}, {}, [], [], Counter()
    starts=[r['start_ms'] for r in rounds]
    for (t,packet,actor,obj),frame in sorted(frames.items()):
        ri=bisect_right(starts,t)-1
        if ri<0:continue
        r=rounds[ri];scope=(actor,obj,r['index'])
        parent=[x for x in frame if x[4]=='ActiveBlinds']
        # The scalar is retained independently, including its observed zero.
        for x in frame:
            if x[4]=='LongestActiveBlindDuration':
                observations.append({'kind':'blind_duration_scalar_observed','time_ms':t,'packet_id':packet,
                    'round':r['index'],'subject':by_body.get(actor),'actor_net_guid':actor,
                    'component_net_guid':obj,'duration_seconds':x[6]})
        if not parent:continue
        raw,bits,checksum=parent[0][9:12]
        record={'kind':'blind_array_observed','time_ms':t,'packet_id':packet,'round':r['index'],
            'subject':by_body.get(actor),'actor_net_guid':actor,'component_net_guid':obj}
        try:
            if len(parent)!=1 or checksum!=3853965310:
                raise ValueError('Unmeasured or ambiguous blind array')
            try:size,changed=array_delta(raw,bits)
            except ValueError:
                # The decoder measures one extra zero packed terminator only
                # on empty arrays; no nonempty payload gets truncated.
                if bits==24 and raw==b'\0\0\0':size,changed=array_delta(raw,16)
                else:raise
            state_key=(actor,obj)
            old=states.get(state_key,{})
            state={i:dict(v) for i,v in old.items() if i<size}
            children=defaultdict(dict)
            for x in frame:
                match=re.fullmatch(r'ActiveBlinds\[(\d+)\]\.(.+)',x[4])
                if match:
                    value=next((v for v in x[5:9] if v is not None),None)
                    children[int(match[1])][match[2]]=value
            if any(i not in children for i,fields in changed.items() if fields):
                raise ValueError('Typed blind members missing; raw delta preserved')
            for i,values in children.items():
                if i>=size:raise ValueError('Blind child index outside array')
                # RepLayout updates array positions, not semantic effect IDs.
                # Unchanged members remain authoritative when an ID changes.
                state.setdefault(i,{}).update(values)
            complete=len(state)==size and all('EffectID' in v and 'SourceID' in v for v in state.values())
            states[state_key]=state
            record.update(status='decoded',complete_membership=complete,declared_length=size,
                members=[{'index':i,**v,'config_path':paths.get(v.get('BlindConfig'))} for i,v in sorted(state.items())])
            if not complete:raise ValueError('Blind membership baseline incomplete')
            now={(v['SourceID'],v['EffectID']):v for v in state.values()}
            current=active.setdefault(scope,{})
            for identity in list(current):
                if identity not in now:
                    current.pop(identity).update(end_ms=t,end_reason='observed_array_removal',stop_packet_id=packet)
            for identity,v in now.items():
                if identity not in current:
                    item={'id':f"blind-{actor}-{obj}-{v['EffectID']}-{packet}",**record,
                        'kind':'native_blind_membership','effect_id':v['EffectID'],'source_id':v['SourceID'],
                        'start_ms':t,'end_ms':r['end_ms'],'end_reason':'round_boundary_no_removal_observed',
                        'reported_initial_duration_seconds':v.get('InitialDuration'),
                        'start_movement_time_s':v.get('StartNetMovementTime'),
                        'config_path':paths.get(v.get('BlindConfig')),'causing_actor_net_guid':v.get('CausingActor'),
                        'evidence':'native_active_blinds_array','members':None}
                    intervals.append(item);current[identity]=item
                current[identity]['last_members']=v
        except ValueError as error:
            record.update(status='unresolved',reason=str(error),raw_hex=raw.hex(),bit_count=bits)
            states.pop((actor,obj),None)
            for item in active.pop(scope,{}).values():
                item.update(end_ms=t,end_reason='knowledge_lost_unresolved_delta')
            diagnostics['blind_unresolved_deltas']+=1
        observations.append(record)
    for effect in vision:
        matches=[b for b in intervals if b['actor_net_guid']==effect['actor_net_guid']
                 and b['round']==effect['round'] and b['effect_id']==effect['effect_id']
                 and b['source_id']==effect['source_id']]
        if len(matches)==1:
            effect['native_blind']=matches[0]
        elif matches:
            diagnostics['blind_ambiguous_effect_join']+=1
    diagnostics.update(native_blind_intervals=len(intervals),native_blind_removals=sum(b['end_reason']=='observed_array_removal' for b in intervals),
        vision_intervals_with_native_blind=sum('native_blind' in v for v in vision))
    return observations,intervals,dict(diagnostics)


def extract_observations(con,export,manifest,model,by_body,rounds,vision):
    fields=str(export/'fields.parquet')
    paths=guid_paths(con.execute('SELECT net_guid,path,outer_net_guid FROM read_parquet(?)',[str(export/'net_guids.parquet')]).fetchall())
    rows=con.execute("""SELECT time_ms,packet_id,actor_net_guid,object_net_guid,field_name,value_i64,value_f64,value_str,value_bool
        FROM (SELECT *,row_number() OVER() AS ordinal FROM read_parquet(?))
        WHERE group_path='/Script/ShooterGame.EffectManagerComponent_ClassNetCache' ORDER BY time_ms,packet_id,ordinal""",[fields]).fetchall()
    continuous,effects,diagnostics=observed_effects(effect_messages(rows),paths,by_body,rounds)
    blind_rows=con.execute("SELECT time_ms,packet_id,actor_net_guid,object_net_guid,field_name,value_i64,value_f64,value_bool,value_str,raw_bits,bit_count,compatible_checksum FROM read_parquet(?) WHERE group_path='/Script/ShooterGame.BlindManagerComponent' ORDER BY time_ms,packet_id",[fields]).fetchall()
    blinds,blind_intervals,blind_diag=blind_membership(blind_rows,paths,by_body,rounds,vision)
    diagnostics.update(blind_diag)
    starts=[r['start_ms'] for r in rounds]
    round_index=lambda t: rounds[bisect_right(starts,t)-1]['index'] if t>=starts[0] else None
    animation=[]
    for t,packet,actor,obj,group,name,i,real,boolean,string,raw,bits in con.execute("""SELECT time_ms,packet_id,actor_net_guid,object_net_guid,group_path,field_name,value_i64,value_f64,value_bool,value_str,raw_bits,bit_count
        FROM read_parquet(?) WHERE regexp_matches(field_name,'Anim|Montage') ORDER BY time_ms,packet_id""",[fields]).fetchall():
        if i==0:continue
        animation.append({'kind':'animation_reference_observed','time_ms':t,'packet_id':packet,'round':round_index(t),
            'subject':by_body.get(actor),'actor_net_guid':actor,'component_net_guid':obj,'group':group,'field':name,
            'asset_path':paths.get(i),'value':next((v for v in (i,real,boolean,string) if v is not None),None),
            'raw_hex':raw.hex() if raw else None,'bit_count':bits,'evidence':'native_replicated_field',
            'skeletal_pose_reconstructed':False})
    player_states={p['actor_net_guid']:p['subject'] for p in manifest['players']}
    rr=con.execute("""SELECT time_ms,packet_id,actor_net_guid,object_net_guid,field_name,value_i64,value_f64,value_str,value_bool
        FROM (SELECT *,row_number() OVER() AS ordinal FROM read_parquet(?)) WHERE starts_with(field_name,'MulticastReceivePlayerResurrectEvent.') ORDER BY time_ms,packet_id,ordinal""",[fields]).fetchall()
    revives=[{'kind':'resurrection_observed','time_ms':m['time_ms'],'packet_id':m['packet_id'],'round':round_index(m['time_ms']),
              'subject':player_states.get(m['values'].get('ResurrectedPlayer')),
              'resurrector':player_states.get(m['values'].get('ResurrectorPlayer')),'parameters':m['values'],
              'evidence':'native_player_resurrect_event'} for m in effect_messages(rr)]
    life=defaultdict(list)
    for t,packet,actor,name,alive in con.execute("""SELECT time_ms,packet_id,actor_net_guid,field_name,value_bool FROM read_parquet(?)
        WHERE group_path='/Script/ShooterGame.DamageableComponent_ClassNetCache'
        AND field_name IN ('MulticastSectionLifeChange.bAliveOnServer','MulticastNotifyDamage_Point.bAliveAfterDamage','MulticastNotifyDamage_Base.bAliveAfterDamage')
        ORDER BY time_ms,packet_id""",[fields]).fetchall():
        s=by_body.get(actor)
        if s and alive is not None and (not life[s] or life[s][-1][1]!=alive):life[s].append([t,alive,packet,name])
    zoom_rows=[{'kind':'camera_field_observed','time_ms':t,'packet_id':p,'round':round_index(t),
        'actor_net_guid':a,'component_net_guid':o,'group':g,'field':n,
        'value':next((v for v in (i,r,b,s) if v is not None),None),'raw_hex':raw.hex() if raw else None,'bit_count':bits}
        for t,p,a,o,g,n,i,r,b,s,raw,bits in con.execute("""SELECT time_ms,packet_id,actor_net_guid,object_net_guid,group_path,field_name,value_i64,value_f64,value_bool,value_str,raw_bits,bit_count FROM read_parquet(?)
        WHERE group_path IN ('/Script/ShooterGame.ZoomMultiplierComponent','/Script/ShooterGame.AnimatedZoomComponent') ORDER BY time_ms,packet_id""",[fields]).fetchall()]
    diagnostics.update(animation_observations=len(animation),resurrections=len(revives),camera_field_observations=len(zoom_rows),
        unresolved_rpc_payloads=manifest['quality']['net']['unresolved_rpc_payloads_preserved'])
    return {'continuous_effects':continuous,'effect_events':effects,'blind_observations':blinds,
            'native_blind_intervals':blind_intervals,'animation_observations':animation,'resurrections':revives,
            'life_states':dict(life),'camera_observations':zoom_rows,'diagnostics':diagnostics,
            'complete_native_rendering':False}
