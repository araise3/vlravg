(function(root){
  'use strict';
  // Observations identify possible impairment. They do not measure opacity,
  // native IsBlinded(), shader output, or complete recipient-effect coverage.
  const visionRoots=[
    'ShooterGame/Content/Characters/_Core/FXC_Blinded_Shared.uasset',
    'ShooterGame/Content/Characters/Global/FXC/FXC_Global_Nearsight.uasset',
    'ShooterGame/Content/Characters/Global/FXC/FXC_Global_NearsightDebuff.uasset',
    'ShooterGame/Content/Characters/Global/FXC/FXC_Nearsight_Parent.uasset'
  ];
  const finite=x=>typeof x==='number'&&Number.isFinite(x);
  const order=(a,b)=>(a.time_ms-b.time_ms)||((a.packet_id||0)-(b.packet_id||0));
  const sameManager=(a,b)=>a.actor_net_guid===b.actor_net_guid&&a.component_net_guid===b.component_net_guid;
  const sameArchives=(a,b)=>a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>
    b[k]&&a[k].sha256===b[k].sha256&&a[k].bytes===b[k].bytes);
  const inScope=(row,frame,t)=>row.subject===frame.subject&&row.round===frame.round&&finite(row.time_ms)&&row.time_ms<=t;
  function mergeEffects(indexed,framed){
    const rows=new Map();
    for(const e of [...indexed,...framed]){
      const key=JSON.stringify([e.subject,e.round,e.id??[e.actor_net_guid,e.component_net_guid,e.effect_id,e.source_id,
        e.profile||e.effect_class,e.start_ms,e.end_ms]]);
      rows.set(key,e);
    }
    return [...rows.values()];
  }
  function classified(effect,model){
    const cls=effect.profile||effect.effect_class,profile=model?.vision_profiles?.[cls];
    if(profile&&['flash','nearsight'].includes(profile.kind))return {cls,kind:profile.kind,profile};
    const lineage=model?.asset_catalog?.[cls]?.lineage||[];
    if(lineage.some(p=>visionRoots.includes(p)))return {cls,kind:'unmodeled_vision',profile:null};
    return null;
  }
  function assess(frame,model={},options={}){
    const t=options.time_ms??frame?.time_ms,reasons=new Set(),evidence=[],tails=[];
    let positive=false;
    const add=(reason,record,extra={})=>{reasons.add(reason);if(record)evidence.push({reason,...extra,observation:record});};
    if(!frame?.known||!finite(t)||!finite(frame.round)||typeof frame.subject!=='string')
      return {candidate_vision:'unknown',vision:'unknown',positive_impairment_observed:false,
        candidate_reasons:['observer_frame_unresolved'],reasons:['observer_frame_unresolved','impairment_coverage_unverified'],evidence,tails,
        effect_coverage_verified:false,native_perceptibility_verified:false};
    const arrays=(options.blind_arrays??[frame.blind?.array_observation]).filter(x=>x&&inScope(x,frame,t));
    const durations=(options.blind_durations??[frame.blind?.duration_observation]).filter(x=>x&&inScope(x,frame,t));
    const effects=(options.vision_events??frame.vision??[]).filter(x=>x.subject===frame.subject&&x.round===frame.round);
    const continuous=(options.continuous_effects??frame.effects??[]).filter(x=>x.subject===frame.subject&&x.round===frame.round);
    const empty=[];
    for(const array of arrays){
      if(array.status!=='decoded'||array.complete_membership!==true){add('blind_membership_unresolved',array);continue;}
      const members=Array.isArray(array.members)?array.members:[];
      if(!Array.isArray(array.members)||!Number.isInteger(array.declared_length)||array.declared_length!==members.length){
        add('blind_membership_invalid',array);continue;
      }
      if(members.length){positive=true;add('observed_native_blind_membership',array,{members:members.map(m=>({
        effect_id:m.EffectID,source_id:m.SourceID,config_path:m.config_path||null,
        reported_initial_duration_seconds:m.InitialDuration??null,start_movement_time_s:m.StartNetMovementTime??null
      }))});}
      else{empty.push(array);evidence.push({reason:'observed_empty_blind_membership',observation:array,
        meaning:'No members in this observed manager state; complete visual coverage and shader clearance are unverified.'});}
    }
    for(const duration of durations){
      if(!finite(duration.duration_seconds)||duration.duration_seconds<0){add('blind_duration_invalid',duration);continue;}
      if(duration.duration_seconds===0){evidence.push({reason:'observed_zero_blind_duration',observation:duration});continue;}
      const removed=empty.find(a=>sameManager(a,duration)&&order(a,duration)>=0);
      const stopped=effects.find(e=>e.kind==='flash'&&e.end_reason==='observed_stop_rpc'&&finite(e.end_ms)&&e.end_ms<=t&&
        order({time_ms:e.end_ms,packet_id:e.stop_packet_id},duration)>=0&&e.native_blind&&sameManager(e.native_blind,duration));
      if(removed||stopped)evidence.push({reason:'historical_positive_blind_duration',observation:duration,
        superseded_by:removed||{id:stopped.id,time_ms:stopped.end_ms,packet_id:stopped.stop_packet_id},
        meaning:'The earlier scalar cannot establish a continuing blind after this subsequent observation.'});
      else add('positive_blind_duration_currentness_unverified',duration,{meaning:
        'Reported scalar; its age and native meaning do not establish current opacity or an effect endpoint.'});
    }
    const seen=new Set();
    for(const effect of [...effects,...continuous]){
      const type=classified(effect,model)||(effects.includes(effect)?
        {cls:effect.profile||effect.effect_class,kind:['flash','nearsight'].includes(effect.kind)?effect.kind:'unmodeled_vision',
          profile:model?.vision_profiles?.[effect.profile]}:null);
      if(!type||seen.has(effect.id))continue;seen.add(effect.id);
      if(!finite(effect.start_ms)||!finite(effect.end_ms)){add('vision_effect_clock_unresolved',effect);continue;}
      if(effect.start_ms<=t&&t<effect.end_ms){positive=true;add(type.kind==='unmodeled_vision'?'observed_unmodeled_vision_effect':'observed_'+type.kind+'_effect',effect,
        {asset_class:type.cls,meaning:'Recipient effect observed; binary visual blocking is unverified.'});}
      if(effect.end_reason==='observed_stop_rpc'&&effect.end_ms<=t){
        const rule=options.tail_rules?.classes?.[type.cls];
        if(rule&&options.tail_rules.mapping_sha256===model.mapping_sha256&&sameArchives(options.tail_rules.archives,model.archives)&&
          finite(rule.duration_seconds)&&rule.duration_seconds>=0){
          const end=Math.min(effect.end_ms+rule.duration_seconds*1000,finite(options.round_end_ms)?options.round_end_ms:Infinity);
          if(t<end){tails.push({effect_id:effect.id,asset_class:type.cls,start_ms:effect.end_ms,model_end_ms:end,
            rule,evidence:'observed_stop_rpc_with_asset_fade_rule',native_clock_binding_verified:false,
            meaning:'Conditional asset fade window; opacity, native start clock and final clearance remain unverified.'});
            add('asset_visual_fade_window',effect,{model_end_ms:end,rule_id:rule.rule_id});}
        }else if(finite(type.profile?.asset_defaults?.NearsightFadeOutDuration)||type.kind==='flash'){
          // A generic lifetime or fade duration is not an executable stop rule.
          // Keep it as a limitation, not an indefinitely active impairment.
          evidence.push({reason:'visual_tail_rule_unbound',observation:{id:effect.id,asset_class:type.cls,
            stop_time_ms:effect.end_ms,stop_packet_id:effect.stop_packet_id},
            meaning:'Stopped RPC does not prove immediate shader clearance. No duration was synthesized.'});
        }
      }
    }
    const candidate=[...reasons].sort(),bindings=options.native_bindings;
    const material=bindings?.kind==='source_pinned_native_visibility_bindings'&&bindings.mapping_sha256===model.mapping_sha256&&sameArchives(bindings.archives,model.archives)?bindings.flash_material:null;
    return {candidate_vision:candidate.length?'unknown':'clear',vision:'unknown',positive_impairment_observed:positive,
      candidate_reasons:candidate,reasons:[...candidate,'impairment_coverage_unverified'],evidence,tails,
      effect_coverage_verified:false,native_perceptibility_verified:false,
      flash_material_assessment:material?{parameter_name:material.parameter_name,parameter_value:null,
        parameter_expression:material.fade_parameter_expression,fade_end_expression:material.fade_end_expression,
        serialized_timer_period_seconds:material.serialized_timer_period_seconds,
        source_proof_sha256:material.proof_sha256,native_bindings_sha256:options.native_bindings_sha256||null,
        required_runtime_inputs:material.required_runtime_inputs,native_clock_binding_verified:false,
        shader_opacity_verified:false,reason:'native_material_inputs_unobserved'}:null,
      semantics:'observed_impairment_guidance_not_native_visibility_certification'};
  }
  function createAssessor(data,options={}){
    const state=data.asset_state||{},obs=state.observations||{},groups=new Map();
    function index(kind,rows){for(const row of rows||[]){const key=JSON.stringify([kind,row.round,row.subject]);
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}}
    index('blind',obs.blind_observations);index('vision',state.vision_effects);index('effects',obs.continuous_effects);
    for(const [key,rows] of groups)if(key.startsWith('["blind"'))rows.sort(order);
    return function observer(frame,t=frame?.time_ms,round=null){
      if(round&&(round.index!==frame?.round||!finite(t)||t<round.start_ms||t>=round.end_ms))
        return assess({...frame,known:false},state.model,{time_ms:t});
      const key=kind=>JSON.stringify([kind,frame?.round,frame?.subject]);
      const arrays=new Map(),durations=new Map();
      const observed=[...(groups.get(key('blind'))||[]),frame?.blind?.array_observation,frame?.blind?.duration_observation]
        .filter(row=>row&&inScope(row,frame,t)).sort(order);
      for(const row of observed){
        const manager=JSON.stringify([row.actor_net_guid,row.component_net_guid]);
        if(row.kind==='blind_array_observed')arrays.set(manager,row);
        else if(row.kind==='blind_duration_scalar_observed')durations.set(manager,row);}
      return assess(frame,state.model,{...options,time_ms:t,round_end_ms:round?.end_ms,blind_arrays:[...arrays.values()],blind_durations:[...durations.values()],
        vision_events:mergeEffects(groups.get(key('vision'))||[],frame?.vision||[]),
        continuous_effects:mergeEffects(groups.get(key('effects'))||[],frame?.effects||[])});
    };
  }
  const api={assess,createAssessor,visionRoots};
  if(typeof module!=='undefined')module.exports=api;else root.ReplayVisibilityEffects=api;
})(typeof globalThis!=='undefined'?globalThis:this);
