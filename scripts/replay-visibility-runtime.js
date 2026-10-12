/* Observer-specific visibility evidence and bounded contact intervals. */
(function(root){
  'use strict';
  const states=new Set(['direct','reveal','hidden','unknown']);
  const visible=s=>s==='direct'||s==='reveal';
  function dataWithInputs(data,inputs={}){
    if(!inputs.smoke_model)return data;
    const state=data.asset_state||{},model=state.model||{},addon=inputs.smoke_model;
    const profiles={...model.smoke_profiles};
    for(const [name,profile] of Object.entries(addon.smoke_profiles||{})){
      if(name in profiles)throw Error('Additional smoke profile duplicates canonical profile');profiles[name]=profile;
    }
    const shells={...model.shell_meshes};
    for(const [name,mesh] of Object.entries(addon.shell_meshes||{})){
      if(name in shells&&JSON.stringify(shells[name])!==JSON.stringify(mesh))throw Error('Additional smoke shell differs from canonical mesh');shells[name]=mesh;
    }
    const ids=new Set((state.smokes||[]).map(s=>s.id));
    for(const smoke of inputs.smoke_instances||[]){
      if(ids.has(smoke.id)||!profiles[smoke.profile])throw Error('Invalid additional smoke identity');ids.add(smoke.id);
    }
    return {...data,asset_state:{...state,model:{...model,smoke_profiles:profiles,shell_meshes:shells},smokes:[...(state.smokes||[]),...(inputs.smoke_instances||[])]}};
  }
  function sceneRayHit(meshes,math,start,end,firstOnly=false){
    if(firstOnly){for(const mesh of meshes){const hit=math.rayHit(mesh,start,end,true);if(hit)return hit;}return null;}
    return meshes.map(mesh=>math.rayHit(mesh,start,end)).filter(Boolean)
      .sort((a,b)=>a.reduce((n,x,i)=>n+(x-start[i])**2,0)-b.reduce((n,x,i)=>n+(x-start[i])**2,0))[0]||null;
  }
  function segmentIntersectsBounds(start,end,bounds){
    const [low,high]=bounds;let entry=0,leave=1;
    if(start.length!==3||end.length!==3||low.length!==3||high.length!==3||![...start,...end].every(Number.isFinite))throw Error('Invalid dynamic-region ray');
    for(let axis=0;axis<3;axis++){
      if(low[axis]===null&&high[axis]===null)continue;
      if(!Number.isFinite(low[axis])||!Number.isFinite(high[axis])||low[axis]>high[axis])throw Error('Invalid source dynamic-region bounds');
      const direction=end[axis]-start[axis];
      if(Math.abs(direction)<1e-12){if(start[axis]<low[axis]||start[axis]>high[axis])return false;}
      else{const a=(low[axis]-start[axis])/direction,b=(high[axis]-start[axis])/direction;entry=Math.max(entry,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(entry>leave)return false;}
    }
    return true;
  }
  function dynamicDependencies(sidecar,start,end,t,round){
    const dependencies=[];
    for(const instance of sidecar?.instances||[]){
      if(!instance.rounds.some(r=>r.round===round&&r.start_ms<=t&&t<r.end_ms))throw Error('Time is outside the requested dynamic round');
      if(!segmentIntersectsBounds(start,end,instance.bounds_cm))continue;
      const epochs=instance.network_epochs.filter(e=>e.start_ms<=t&&t<e.end_ms),epoch=epochs.length===1?epochs[0].start_packet_id:null;
      const hidden=instance.observations.filter(r=>r.round===round&&r.time_ms<=t&&r.field_name==='bHidden'&&epoch!==null&&r.epoch_start_packet_id===epoch).at(-1)||null;
      if(hidden?.status==='decoded'&&hidden.value===true)continue;
      dependencies.push({id:instance.id,actor_net_guid:instance.actor_net_guid,reason:'dynamic_occluder_geometry_unknown',bounds_cm:instance.bounds_cm,hidden_observation:hidden,native_visibility_verified:false});
    }
    return dependencies;
  }
  function abilityDependencies(sidecar,t,round){
    const latest=new Map();
    for(const instance of sidecar?.instances||[]){
      if(instance.round!==round||t<instance.start_ms||t>=instance.end_ms)continue;
      const key=JSON.stringify([instance.actor_net_guid,instance.kind]),previous=latest.get(key);
      if(!previous||instance.start_ms>previous.start_ms)latest.set(key,instance);
    }
    return [...latest.values()].map(i=>{
      const row={id:i.id,kind:i.kind,actor_net_guid:i.actor_net_guid,round:i.round,start_ms:i.start_ms,end_ms:i.end_ms,
        start_policy:i.start_policy,end_boundary_kind:i.end_boundary_kind,geometry_reason:i.geometry_reason,
        world_bounds_cm:i.world_bounds_cm,world_bounds_verified:false,native_visibility_verified:false,
        reason:'ability_occluder_geometry_unknown',start_observation:i.start_observation,
        anchor_observations:[...(i.anchor_observations||[]),...(i.later_anchor_observations||[])].filter(a=>a.time_ms<=t),
        channel_close_observations:(i.channel_close_observations||[]).filter(a=>a.time_ms<=t)};
      if(i.initialization_observed_ms<=t){row.initialization_observed_ms=i.initialization_observed_ms;row.world_endpoints_cm=i.world_endpoints_cm;}
      if(i.collision_enable_observed_ms<=t){row.collision_enable_observed_ms=i.collision_enable_observed_ms;row.collision_enable_observation=i.collision_enable_observation;}
      if(i.observed_flag_end_ms<=t){row.observed_flag_end_ms=i.observed_flag_end_ms;row.deactivation_observation=i.deactivation_observation;row.conditional_asset_tail_ms=i.conditional_asset_tail_ms;}
      return row;
    });
  }
  function cameraDependencies(sidecar,subject,t,round){
    // The sidecar is a whole-replay history. A current-time report must not
    // present a later unpossess, ownership update or channel close as evidence.
    const observed=value=>{
      if(Array.isArray(value))return value.map(observed).filter(v=>v!==undefined);
      if(value&&typeof value==='object'){
        if(Number.isFinite(value.time_ms)&&value.time_ms>t)return undefined;
        return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,observed(v)]).filter(([,v])=>v!==undefined));
      }
      return value;
    };
    return (sidecar?.remote_viewpoint_intervals||[]).filter(i=>i.subject===subject&&i.round===round.index&&i.start_ms<=t&&t<i.end_ms).map(i=>{
      const row={id:i.id,subject:i.subject,round:i.round,actor_net_guid:i.actor_net_guid,
        component_net_guid:i.component_net_guid,source_group:i.source_group,actor_class:i.actor_class,
        start_ms:i.start_ms,start_observed_ms:i.start_observed_ms,start_reason:i.start_reason,
        start_boundary_kind:i.start_boundary_kind,start_observation:observed(i.start_observation),
        ownership_evidence:observed(i.ownership_evidence||[]),
        additional_start_observations:observed(i.additional_start_observations||[]),
        actor_channel_close_observations:observed(i.actor_channel_close_observations||[]),
        evidence_cap_ms:round.end_ms,camera_pose_reconstructed:false,native_camera_switch_verified:false,
        visibility_dependency:'remote_viewpoint_pose_unresolved'};
      // An interval capped by a future stop still means "unresolved now".
      // Its eventual stop clock remains available in the whole-replay sidecar.
      if(i.stop_observation?.time_ms<=t)row.stop_observation=observed(i.stop_observation);
      return row;
    });
  }
  function smokeDependencies(smokes,profiles,start,end,t,round,math){
    const dependencies=[];
    for(const instance of smokes){
      const opened=instance.channel_open_ms??instance.native_actor_open_observation?.time_ms??instance.positions?.[0]?.[0];
      if(instance.round!==round.index||!Number.isFinite(opened)||opened>t||t>=round.end_ms)continue;
      const profile=profiles[instance.profile],position=math.latest(instance.positions||[],t,Infinity);
      if(!profile||!position||position[0]<opened)continue;
      // This bounds the serialized display shell, not every shader pixel. The
      // formal evaluator still declares native geometry/effect coverage unknown.
      const radius=Math.max(profile.radius_cm,profile.boundary_shell?.bounding_radius_cm||0);
      const hit=math.sphereSegment(start,end,position.slice(1,4),radius);
      if(!Object.values(hit).some(Boolean))continue;
      if(instance.activation_clock_verified===true&&instance.native_visual_opacity_verified===true)continue;
      const row={id:instance.id,actor_net_guid:instance.actor_net_guid,profile:instance.profile,
        reason:'smoke_activation_or_shader_unverified',channel_open_observed_ms:opened,
        position_observed_ms:position[0],center_cm:position.slice(1,4),candidate_envelope_radius_cm:radius,
        envelope_scope:'serialized_display_shell_only',native_envelope_verified:false,
        model_clock_basis:instance.model_clock_basis||'channel_open_plus_serialized_delay',
        model_active:t>=instance.start_ms&&t<instance.end_ms,
        knowledge_cap_ms:round.end_ms,knowledge_cap_kind:'round_evidence_boundary',
        activation_clock_verified:false,native_visual_opacity_verified:false,
        intro_loop_observations:(instance.intro_loop_observations||[]).filter(e=>e.start_ms<=t).map(e=>({
          start_ms:e.start_ms,start_packet_id:e.start_packet_id,effect_class:e.effect_class}))};
      if(instance.channel_close_ms<=t)row.channel_close_observed_ms=instance.channel_close_ms;
      dependencies.push(row);
    }
    return dependencies;
  }
  function dependencyTimes(inputs){
    const times=[];
    for(const i of inputs.ability_occluders?.instances||[]){
      times.push(i.start_ms,i.end_ms,i.observed_flag_end_ms,i.collision_enable_observed_ms);
      for(const a of [...(i.anchor_observations||[]),...(i.later_anchor_observations||[]),...(i.channel_close_observations||[])])times.push(a.time_ms);
    }
    for(const i of inputs.dynamic_occluders?.instances||[]){
      for(const e of i.network_epochs)times.push(e.start_ms,e.end_ms);
      for(const r of i.observations)times.push(r.time_ms);
    }
    return times.filter(Number.isFinite);
  }
  function evaluate(input){
    const reasons=new Set(),points=[],add=r=>reasons.add(r);
    if(input.enemy===false||input.observer_alive===false||input.target_alive===false)
      return {state:'hidden',reasons:[input.enemy===false?'not_enemy':input.observer_alive===false?'observer_dead':'target_dead'],points};
    for(const key of ['enemy','observer_alive','target_alive'])if(input[key]!==true)add(key+'_unknown');
    if(input.vision==='blocked'||input.perceptible===false)
      return {state:'hidden',reasons:[input.vision==='blocked'?'observer_blind':'target_not_perceptible'],points};
    if(input.vision!=='clear')add('observer_vision_unknown');
    if(input.perceptible!==true)add('target_perceptibility_unknown');
    const evidence=input.evidence||{};
    if(evidence.camera!==true)add('camera_unverified');
    if(evidence.body!==true)add('target_body_unverified');
    if(evidence.build!==true)add('asset_replay_build_unverified');
    if(evidence.effect_coverage!==true)add('effect_coverage_incomplete');
    if(!(input.points||[]).length)add('no_body_points');
    let direct=false,reveal=false,uncertain=false;
    for(const point of input.points||[]){
      const row={...point,reasons:[]};
      if(point.in_view===false){row.state='hidden';row.reasons.push('outside_view');}
      else if(point.in_view!==true){row.state='unknown';row.reasons.push('point_projection_unknown');uncertain=true;}
      else if(point.wall_clear===true&&point.smoke_clear===true&&point.dynamic_clear!==null&&point.dynamic_clear!==false){row.state='direct';direct=true;}
      else if(point.reveal===true){row.state='reveal';reveal=true;}
      else if((point.wall_clear===false||point.smoke_clear===false)&&point.reveal===false){
        row.state='hidden';if(point.wall_clear===false)row.reasons.push('wall');if(point.smoke_clear===false)row.reasons.push('smoke');
      }else{
        row.state='unknown';uncertain=true;
        if(point.wall_clear!==false&&point.wall_clear!==true)row.reasons.push('wall_coverage_incomplete');
        if(point.dynamic_clear===null)row.reasons.push('dynamic_occluder_geometry_unknown');
        if(point.smoke_clear!==false&&point.smoke_clear!==true)row.reasons.push('smoke_rule_unresolved');
        if(point.reveal!==false&&point.reveal!==true)row.reasons.push('reveal_rule_unresolved');
      }
      points.push(row);
    }
    const candidate=direct?'direct':reveal?'reveal':uncertain?'unknown':'hidden';
    if(candidate==='unknown')for(const point of points)for(const r of point.reasons)add(r);
    return {state:reasons.size?'unknown':candidate,reasons:reasons.size?[...reasons].sort():candidate==='hidden'?[...new Set(points.flatMap(p=>p.reasons))].sort():[],points};
  }
  function intervals(samples,{max_gap_ms=50}={}){
    if(!Number.isFinite(max_gap_ms)||max_gap_ms<=0)throw Error('Invalid maximum sample gap');
    const contacts=[],transitions=[],segments=[];let previous=null,contact=null,segment=null;
    const finish=(reason,bound)=>{
      if(contact){contact.end_reason=reason;contact.loss_bounds_ms=bound;contacts.push(contact);contact=null;}
    };
    for(const sample of samples){
      if(!Number.isFinite(sample.time_ms)||sample.time_ms<0||previous&&sample.time_ms<=previous.time_ms)throw Error('Samples must be strictly increasing');
      if(!states.has(sample.state))throw Error('Invalid visibility state');
      if(typeof sample.observer!=='string'||!sample.observer||typeof sample.target!=='string'||!sample.target||sample.round==null||sample.life==null)throw Error('Missing pair/context identity');
      if(previous&&(sample.observer!==previous.observer||sample.target!==previous.target))throw Error('Mixed observer-target stream');
      const context=previous&&sample.round===previous.round&&sample.life===previous.life;
      const continuous=!!context&&sample.time_ms-previous.time_ms<=max_gap_ms;
      if(previous&&!continuous)finish(context?'sample_gap':'context_changed',null);
      if(!segment||!continuous||segment.state!==sample.state||JSON.stringify(segment.reasons)!==JSON.stringify(sample.reasons||[])){
        segment={state:sample.state,reasons:sample.reasons||[],first_sample_ms:sample.time_ms,last_sample_ms:sample.time_ms,sample_count:0,round:sample.round,life:sample.life};segments.push(segment);
      }
      segment.last_sample_ms=sample.time_ms;segment.sample_count++;
      if(previous&&continuous&&sample.state!==previous.state)transitions.push({from:previous.state,to:sample.state,bounds_ms:[previous.time_ms,sample.time_ms],reasons:sample.reasons||[]});
      if(visible(sample.state)){
        if(!contact)contact={observer:sample.observer,target:sample.target,round:sample.round,life:sample.life,
          acquisition_bounds_ms:continuous&&previous.state==='hidden'?[previous.time_ms,sample.time_ms]:null,
          start_reason:continuous&&previous.state==='hidden'?'hidden_to_visible':continuous&&previous.state==='unknown'?'after_unknown':!previous?'visible_at_window_start':context?'after_gap':'context_changed',
          first_visible_sample_ms:sample.time_ms,last_visible_sample_ms:sample.time_ms,modes:[]};
        contact.last_visible_sample_ms=sample.time_ms;
        if(!contact.modes.includes(sample.state))contact.modes.push(sample.state);
      }else finish(sample.state==='hidden'?'hidden':'unknown',continuous&&sample.state==='hidden'?[previous.time_ms,sample.time_ms]:null);
      previous=sample;
    }
    finish('end_of_window',null);
    return {contacts,transitions,segments,samples:samples.length,
      unknown_samples:samples.filter(s=>s.state==='unknown').length,max_gap_ms};
  }
  function createPairEvaluator(data,mesh,math,frameEvaluator,inputs={}){
    const players=new Map(data.players.map(p=>[p.subject,p])),state=data.asset_state||{},shells=new Map(),deaths=new Map();
    const effectAPI=typeof module!=='undefined'?require('./replay-visibility-effects.js'):root.ReplayVisibilityEffects;
    const assessEffects=effectAPI.createAssessor(data,{tail_rules:inputs.tail_rules,native_bindings:inputs.native_bindings,native_bindings_sha256:inputs.native_bindings_sha256});
    let assessmentClock=null;const assessmentCache=new Map();
    const assessment=(observer,frame,t,round)=>{
      const clock=JSON.stringify([t,round.index]);
      if(clock!==assessmentClock){assessmentClock=clock;assessmentCache.clear();}
      if(!assessmentCache.has(observer))assessmentCache.set(observer,assessEffects(frame,t,round));
      return assessmentCache.get(observer);
    };
    const meshes=[mesh,...(inputs.overlay_meshes||[])];
    const wallHit=(start,end,firstOnly=false)=>sceneRayHit(meshes,math,start,end,firstOnly);
    for(const k of data.kills||[]){const key=JSON.stringify([k.round,k.victim]);if(!deaths.has(key))deaths.set(key,[]);deaths.get(key).push(k.time_ms);}
    for(const profile of Object.values(state.model?.smoke_profiles||{}))if(profile.boundary_shell)
      shells.set(profile,math.shellMesh(state.model.shell_meshes[profile.boundary_shell.mesh],profile.boundary_shell.scale));
    return function pair(observer,target,t,round,{smoke=true,crouch=true,max_pose_age_ms=50,tracks=data.tracks,body_half_width_cm=0,skip_offscreen_rays=false}={}){
      if(!Number.isFinite(body_half_width_cm)||body_half_width_cm<0)throw Error('Invalid model body width');
      const alive=subject=>math.lifeAt(state.observations?.life_states?.[subject]||[],t,round.start_ms,deaths.get(JSON.stringify([round.index,subject]))||[]);
      const pose=subject=>{const p=math.latest(tracks[subject]||[],t,max_pose_age_ms);return alive(subject)&&p&&p[0]>=round.start_ms?p:null};
      const a=pose(observer),b=pose(target),frame=frameEvaluator(observer,t,round),effects=frame.vision||[];
      const impairment=assessment(observer,frame,t,round);
      const remote=cameraDependencies(inputs.camera_body,observer,t,round);
      const ability=abilityDependencies(inputs.ability_occluders,t,round.index);
      const input={enemy:players.has(observer)&&players.has(target)?players.get(observer).team!==players.get(target).team:null,observer_alive:alive(observer),target_alive:alive(target),
        vision:impairment.candidate_vision,perceptible:true,points:[],evidence:{camera:remote.length===0,body:true,build:true,effect_coverage:true}};
      let dynamic=[],smokeDependenciesAtTime=[];
      const annotate=result=>result.state==='unknown'?{...result,reasons:[...new Set([...result.reasons,...impairment.candidate_reasons,...(remote.length?['remote_viewpoint_dependency_observed']:[]),...(ability.length?['ability_occluder_geometry_unknown']:[]),...(dynamic.length?['dynamic_occluder_geometry_unknown']:[]),...(smokeDependenciesAtTime.length?['smoke_activation_or_shader_unverified']:[])])].sort()}:result;
      const candidate=value=>{const result=evaluate(value);return annotate(ability.length&&visible(result.state)?{...result,state:'unknown',reasons:['ability_occluder_geometry_unknown']}:result);};
      const formal=value=>annotate(evaluate({...value,vision:impairment.vision,perceptible:null,evidence:{camera:false,body:false,build:data.geometry.asset_provenance?.asset_build_verified_against_replay===true,effect_coverage:false},
        points:value.points.map(p=>({...p,wall_clear:null,smoke_clear:null,reveal:null}))}));
      const inBounds=p=>p.slice(1,4).every((v,i)=>Number.isFinite(v)&&v>=data.geometry.bounds_cm[0][i]&&v<=data.geometry.bounds_cm[1][i]);
      if(!a||!b||!inBounds(a)||!inBounds(b))return {state:0,known:false,reason:!input.target_alive?'Target dead':!input.observer_alive?'Observer dead':'No valid pose',a,b,contact:candidate({...input,vision:'unknown'}),visibility:formal(input),effect_assessment:impairment,camera_dependencies:remote,ability_dependencies:ability,dynamic_dependencies:dynamic};
      const shape=subject=>crouch&&state.model?(frameEvaluator(subject,t,round).stance):{eyeHeight:data.projection.eye_height_cm,offsets:data.projection.body_offsets_cm};
      const eye=[a[1],a[2],a[3]+shape(observer).eyeHeight],centerPoints=shape(target).offsets.map(z=>[b[1],b[2],b[3]+z]);
      const dx=b[1]-a[1],dy=b[2]-a[2],distance=Math.hypot(dx,dy),lateral=distance>1e-9?[-dy/distance,dx/distance]:[0,1];
      // Optional silhouette grid is an explicit estimate, never native anatomy.
      const points=body_half_width_cm?centerPoints.flatMap(p=>[0,-body_half_width_cm,body_half_width_cm].map(w=>[p[0]+lateral[0]*w,p[1]+lateral[1]*w,p[2]])):centerPoints;
      const poseAssessment={observer:{subject:observer,movement_observed_ms:a[0],pawn_origin_cm:a.slice(1,4),
        movement_yaw_pitch_deg:a.slice(4,6),model_eye_cm:eye,model_fov_deg:frame.camera.fov,
        model_fov_basis:frame.camera.kind||'supplied_display_model',model_stance:shape(observer),
        native_camera_transform_verified:false,native_fov_verified:false,remote_dependencies:remote},
        target:{subject:target,movement_observed_ms:b[0],pawn_origin_cm:b.slice(1,4),
          movement_yaw_pitch_deg:b.slice(4,6),model_body_points_cm:points,model_stance:shape(target),
          native_skeletal_pose_verified:false,body_coverage:body_half_width_cm?'nine_point_silhouette_grid':'three_capsule_centerline_points',model_half_width_cm:body_half_width_cm},
        reasons:['native_camera_transform_unresolved','native_fov_pipeline_unresolved','native_skeletal_pose_unresolved'],
        native_bindings_sha256:inputs.native_bindings_sha256||null,
        source_kind:'decoded_movement_with_explicit_display_assumptions'};
      const projections=points.map(point=>math.project(a,point,1,1,frame.camera.fov,shape(observer).eyeHeight,data.projection.aspect));
      // The estimated batch path needs no occlusion work for an entirely
      // off-screen silhouette. Camera/impairment uncertainty still takes part
      // in the same candidate evaluation, and formal visibility stays separate.
      if(skip_offscreen_rays&&projections.every(p=>!p.inside)){
        input.points=points.map((position,i)=>({id:'offscreen_'+i,position,in_view:false,wall_clear:null,smoke_clear:null,dynamic_clear:null,reveal:false}));
        return {state:0,known:true,inside:false,a,b,projections,contact:candidate(input),visibility:formal(input),
          effect_assessment:impairment,camera_dependencies:remote,ability_dependencies:ability,dynamic_dependencies:[],
          pose_assessment:poseAssessment,source_pose_times_ms:[a[0],b[0]],smoke_dependencies:[]};
      }
      const hits=points.map((point,i)=>skip_offscreen_rays&&!projections[i].inside?null:wallHit(eye,point,skip_offscreen_rays));
      const smokes=smoke&&state.model?(state.smokes||[]).filter(s=>s.round===round.index&&t>=s.start_ms&&t<s.end_ms).map(s=>{
        const profile=state.model.smoke_profiles[s.profile],radius=math.smokeRadius(profile,t-s.start_ms),position=math.latest(s.positions,t,Infinity);return {...s,profile,radius,center:position?.slice(1,4)};
      }).filter(s=>s.radius>0&&s.center):[];
      const irrelevant=i=>skip_offscreen_rays&&(!projections[i].inside||hits[i]);
      const perPoint=points.map((point,i)=>irrelevant(i)?[]:smokes.map(s=>({smoke_id:s.id,...math.smokeIntersection(s.profile,eye,point,s.center,s.radius,shells.get(s.profile))})));
      const smokePoints=smoke?points.map((point,i)=>irrelevant(i)?[]:smokeDependencies(state.smokes||[],state.model?.smoke_profiles||{},eye,point,t,round,math)):points.map(()=>[]);
      smokeDependenciesAtTime=[...new Map(smokePoints.flat().map(i=>[i.id,i])).values()];
      const dynamicPoints=points.map((point,i)=>irrelevant(i)?[]:dynamicDependencies(inputs.dynamic_occluders,eye,point,t,round.index));
      dynamic=[...new Map(dynamicPoints.flat().map(i=>[i.id,i])).values()];
      input.points=points.map((position,i)=>({id:body_half_width_cm?['lower','middle','upper'][Math.floor(i/3)]+'_'+['center','left','right'][i%3]:['lower','middle','upper'][i],position,in_view:projections[i].inside,wall_clear:!hits[i],wall_hit:hits[i],
        smoke_clear:smokePoints[i].length||perPoint[i].some(s=>s.insideObserver||s.insideTarget)?null:!perPoint[i].some(s=>s.boundary),smoke_hits:perPoint[i],smoke_dependencies:smokePoints[i],dynamic_clear:dynamicPoints[i].length?null:true,dynamic_dependencies:dynamicPoints[i],reveal:false}));
      const inside=projections.some(p=>p.inside),onScreenBlocked=projections.filter((p,i)=>p.inside&&hits[i]).length,onScreenCount=projections.filter(p=>p.inside).length;
      return {state:!inside?0:onScreenBlocked===onScreenCount?1:onScreenBlocked?2:3,known:true,blocked:hits.filter(Boolean).length,inside,a,b,
        hit:hits[1]||hits.find(Boolean),projections,smokes,smokeBoundary:perPoint.filter(rows=>rows.some(s=>s.boundary)).length,
        smokeInside:perPoint.some(rows=>rows.some(s=>s.insideObserver||s.insideTarget)),contact:candidate(input),visibility:formal(input),effect_assessment:impairment,camera_dependencies:remote,ability_dependencies:ability,dynamic_dependencies:dynamic,
        smoke_dependencies:smokeDependenciesAtTime,pose_assessment:poseAssessment,
        source_pose_times_ms:[a[0],b[0]],observed_effects:effects.map(e=>({id:e.id,name:e.name,kind:e.kind,start_ms:e.start_ms,end_ms:e.end_ms}))};
    };
  }
  const api={evaluate,intervals,createPairEvaluator,sceneRayHit,dataWithInputs,segmentIntersectsBounds,dynamicDependencies,abilityDependencies,cameraDependencies,smokeDependencies,dependencyTimes};if(typeof module!=='undefined')module.exports=api;else root.ReplayVisibility=api;
})(typeof globalThis!=='undefined'?globalThis:this);
