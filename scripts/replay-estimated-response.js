/* Offline model contact -> observed gun discharge. No native LOS certification. */
'use strict';
const DEFAULT_POLICY=Object.freeze({sample_ms:50,max_pose_age_ms:50,rearm_hidden_ms:250,prefire_quiet_ms:300,max_response_ms:2000,body_half_width_cm:21});
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function policy(values={}){
  const p={...DEFAULT_POLICY,...values};
  if(Object.keys(p).some(k=>!(k in DEFAULT_POLICY))||Object.entries(p).some(([k,v])=>!finite(v)||(k==='body_half_width_cm'?v<0:v<=0)))throw Error('Invalid estimated response policy');
  return p;
}
function summarize(rows){
  const values=rows.filter(r=>r.status==='estimated'),sorted=values.map(r=>r.response_ms).sort((a,b)=>a-b);
  const mean=key=>values.length?values.reduce((n,r)=>n+r[key],0)/values.length:null;
  const middle=Math.floor(sorted.length/2);
  return {sample_count:values.length,mean_ms:mean('response_ms'),median_ms:sorted.length?(sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2):null,
    mean_sampling_bounds_ms:values.length?[mean('response_lower_ms'),mean('response_upper_ms')]:null};
}
function createAnalyzer(observer,enemyIds,shots,settings={}){
  const p=policy(settings),enemies=new Set(enemyIds),ids=new Set();
  if(!observer||!enemies.size||enemies.size!==enemyIds.length||enemies.has(observer))throw Error('Invalid observer/enemy inventory');
  shots=shots.filter(s=>s.subject===observer).slice().sort((a,b)=>a.time_ms-b.time_ms||String(a.id).localeCompare(String(b.id)));
  for(const s of shots){if(!finite(s.time_ms)||s.time_ms<0||!s.id||ids.has(s.id)||s.round==null)throw Error('Invalid shot identity or time');ids.add(s.id);}
  const samples=[],coverage={frames:0,eligible_frames:0,known_frames:0,unknown_frames:0,eligible_duration_ms:0,known_duration_ms:0},unknownReasons={};
  let previous=null,hiddenSince=null,episode=null,consumed=false,shotIndex=0,lastShot=null;
  const finish=(status,shot=null)=>{
    if(!episode)return;
    const row={...episode,status};
    if(shot){row.shot_id=shot.id;row.shot_at_ms=shot.time_ms;row.weapon_path=shot.weapon_path;
      if(status==='estimated'){row.response_ms=shot.time_ms-row.visible_at_ms;row.response_lower_ms=row.response_ms;row.response_upper_ms=shot.time_ms-row.last_hidden_at_ms;}}
    samples.push(row);episode=null;consumed=true;
  };
  function feed(frame){
    const t=frame.time_ms;
    if(!finite(t)||t<0||previous&&t<=previous.time_ms||frame.observer!==observer||frame.round==null||frame.life==null)throw Error('Invalid observer frame clock/context');
    const states=new Map();
    for(const target of frame.targets||[]){if(!enemies.has(target.id)||states.has(target.id)||!['direct','hidden','unknown'].includes(target.state))throw Error('Invalid target state/inventory');states.set(target.id,target);}
    const eligible=frame.alive===true&&frame.combat===true;
    const known=eligible&&frame.complete===true&&states.size===enemies.size&&[...states.values()].every(r=>r.state!=='unknown');
    const continuous=previous&&previous.round===frame.round&&previous.life===frame.life&&t-previous.time_ms<=p.sample_ms;
    if(!continuous){finish(previous&&previous.round===frame.round&&previous.life===frame.life?'sample_gap':'context_changed');hiddenSince=null;consumed=false;}
    coverage.frames++;if(eligible){coverage.eligible_frames++;coverage[known?'known_frames':'unknown_frames']++;
      if(continuous&&previous.eligible){coverage.eligible_duration_ms+=t-previous.time_ms;if(known&&previous.known)coverage.known_duration_ms+=t-previous.time_ms;}}
    if(eligible&&!known){const reasons=new Set([...[...states.values()].filter(s=>s.state==='unknown').flatMap(s=>s.reasons||['visibility_unknown']),...(states.size!==enemies.size?['enemy_inventory_incomplete']:[])]);
      for(const reason of reasons)unknownReasons[reason]=(unknownReasons[reason]||0)+1;}
    const pending=[];while(shotIndex<shots.length&&shots[shotIndex].time_ms<=t)pending.push(shots[shotIndex++]);
    const visible=[...states.values()].filter(r=>r.state==='direct');
    if(!known){finish(eligible?'unknown_visibility':'observer_inactive');hiddenSince=null;consumed=false;}
    else if(visible.length){
      if(episode&&!visible.some(r=>episode.targets.includes(r.id)))finish('onset_targets_lost');
      if(!consumed&&!episode){
        episode={observer,round:frame.round,life:frame.life,visible_at_ms:t,last_hidden_at_ms:continuous&&previous.known?previous.time_ms:null,
          targets:visible.map(r=>r.id).sort(),onset_witnesses:visible.map(r=>({target:r.id,point:r.witness||null,pose_times_ms:r.pose_times_ms||null}))};
        if(!continuous||hiddenSince===null)finish('onset_not_bracketed');
        else if(previous.time_ms-hiddenSince<p.rearm_hidden_ms)finish('insufficient_hidden_history');
        else{
          const preceding=pending.filter(s=>s.time_ms<t).map(s=>s.time_ms),recent=Math.max(lastShot??-Infinity,...preceding);
          if(t-recent<p.prefire_quiet_ms)finish('already_firing');
        }
      }
      hiddenSince=null;
    }else{finish('lost_before_shot');if(hiddenSince===null)hiddenSince=t;if(t-hiddenSince>=p.rearm_hidden_ms)consumed=false;}
    for(const shot of pending){
      if(episode&&shot.time_ms>=episode.visible_at_ms){
        if(shot.round!==episode.round)finish('shot_round_mismatch',shot);
        else if(shot.time_ms!==t)finish('shot_frame_missing',shot);
        else if(shot.time_ms-episode.visible_at_ms>p.max_response_ms)finish('response_timeout',shot);
        else if(shot.timing_usable!==true)finish('shot_timing_unusable',shot);
        else finish('estimated',shot);
      }
      lastShot=shot.time_ms;
    }
    if(episode&&t-episode.visible_at_ms>=p.max_response_ms)finish('response_timeout');
    previous={...frame,targets:undefined,eligible,known};
  }
  function result(){
    finish('end_of_coverage');const excluded={};for(const row of samples)if(row.status!=='estimated')excluded[row.status]=(excluded[row.status]||0)+1;
    return {subject:observer,...summarize(samples),encounter_count:samples.length,coverage:{...coverage,known_fraction:coverage.eligible_duration_ms?coverage.known_duration_ms/coverage.eligible_duration_ms:null},
      unknown_frame_reasons:unknownReasons,excluded_by_reason:excluded,samples};
  }
  return {feed,result};
}
module.exports={DEFAULT_POLICY,policy,summarize,createAnalyzer};
