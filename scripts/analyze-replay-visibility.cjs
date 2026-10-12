/* Called by build-replay-visibility.py with a provenance-bound native clip. */
'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const math=require('./replay-transcription-viewer.js');
const behavior=require('./replay-behavior-runtime.js');
const visibility=require('./replay-visibility-runtime.js');
const sha=path=>crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const [scenePath,meshPath,outPath]=process.argv.slice(2);
if(!scenePath||!meshPath||!outPath)throw Error('Expected scene, geometry and output paths');
const scene=JSON.parse(fs.readFileSync(scenePath)),{data,observer,target,start_ms,end_ms}=scene,options=scene.options||{smoke:true,crouch:true};
const bytes=fs.readFileSync(meshPath),mesh=math.decodeBVH(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
if(sha(meshPath)!==scene.provenance.bvh_sha256)throw Error('Geometry hash mismatch');
const inputs=scene.visibility_inputs||{},overlays=(scene.overlay_bvhs||[]).map((raw,i)=>{
  const bytes=Buffer.from(raw,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==inputs.geometry_overlays?.[i]?.bvh_sha256)throw Error('Overlay geometry hash mismatch');
  return math.decodeBVH(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
});
if(overlays.length!==(inputs.geometry_overlays||[]).length)throw Error('Overlay receipt count mismatch');
const analysisData=visibility.dataWithInputs(data,inputs);
const evaluate=visibility.createPairEvaluator(analysisData,mesh,math,behavior.createFrameEvaluator(analysisData,math),{...inputs,overlay_meshes:overlays});
const times=new Set([start_ms,end_ms]);for(let t=start_ms;t<=end_ms;t+=50)times.add(t);
const add=t=>{if(t>=start_ms&&t<=end_ms)times.add(t)};
for(const subject of [observer,target]){
  for(const row of data.tracks[subject])add(row[0]);
  for(const row of data.asset_state.observations.life_states?.[subject]||[])add(row[0]);
}
for(const effect of [...data.asset_state.vision_effects,...analysisData.asset_state.smokes]){
  add(effect.start_ms);add(effect.end_ms);add(effect.channel_open_ms??effect.positions?.[0]?.[0]);add(effect.channel_close_ms);
}
for(const row of data.asset_state.observations.blind_observations||[])if(row.subject===observer)add(row.time_ms);
for(const effect of data.asset_state.observations.continuous_effects||[]){add(effect.start_ms);add(effect.end_ms);}
for(const effect of [...data.asset_state.vision_effects,...(data.asset_state.observations.continuous_effects||[])]){
  const rule=inputs.tail_rules?.classes?.[effect.profile||effect.effect_class];
  if(effect.end_reason==='observed_stop_rpc'&&rule){const round=data.rounds.find(r=>r.index===effect.round);add(Math.min(effect.end_ms+rule.duration_seconds*1000,round?.end_ms??Infinity));}
}
for(const interval of inputs.camera_body?.remote_viewpoint_intervals||[])if(interval.subject===observer){add(interval.start_ms);add(interval.end_ms);}
for(const t of visibility.dependencyTimes(inputs))add(t);
for(const round of data.rounds){add(round.start_ms);add(round.end_ms);}
const samples=[];for(const t of [...times].sort((a,b)=>a-b)){
  const round=data.rounds.find(r=>t>=r.start_ms&&t<r.end_ms);if(!round)throw Error('Analysis window contains a time outside a round');
  const result=evaluate(observer,target,t,round,options),life=[math.lifeAt(data.asset_state.observations.life_states?.[observer]||[],t,round.start_ms,data.kills.filter(k=>k.round===round.index&&k.victim===observer).map(k=>k.time_ms)),
    math.lifeAt(data.asset_state.observations.life_states?.[target]||[],t,round.start_ms,data.kills.filter(k=>k.round===round.index&&k.victim===target).map(k=>k.time_ms))].join(':');
  samples.push({time_ms:t,observer,target,round:round.index,life,state:result.visibility.state,model_state:result.contact.state,reasons:result.visibility.reasons,
    model_reasons:result.contact.reasons,pose_times_ms:result.source_pose_times_ms||null,observed_effects:result.observed_effects||[],model_points:result.contact.points,
    effect_assessment:result.effect_assessment,camera_dependencies:result.camera_dependencies,ability_dependencies:result.ability_dependencies,dynamic_dependencies:result.dynamic_dependencies,
    pose_assessment:result.pose_assessment||null,smoke_dependencies:result.smoke_dependencies||[],
    wall_state:result.state,smoke_intersects:Boolean(result.smokeBoundary||result.smokeInside)});
}
const model=visibility.intervals(samples.map(s=>({...s,state:s.model_state,reasons:s.model_reasons})));
const report={schema_version:1,producer:'native-movement-visibility-analysis-v1',match_id:data.match_id,replay_build:data.replay_build,clock:data.clock,
  observer,target,window_ms:[start_ms,end_ms],validated_player_visibility:false,provenance:{...scene.provenance,
    evaluator_sha256:sha(__dirname+'/replay-visibility-runtime.js'),effects_sha256:sha(__dirname+'/replay-visibility-effects.js'),math_sha256:sha(__dirname+'/replay-transcription-viewer.js'),behavior_sha256:sha(__dirname+'/replay-behavior-runtime.js'),analyzer_sha256:sha(__filename)},
  sampling:'Original decoded movement timestamps, 50 ms coverage grid and observed effect/life/occluder boundaries',
  display_models:options,
  movement_tracks:data.tracks,
  geometry_overlays:inputs.geometry_overlays,camera_body_sha256:inputs.camera_body_sha256,tail_rules_sha256:inputs.tail_rules_sha256,
  native_bindings:inputs.native_bindings,native_bindings_sha256:inputs.native_bindings_sha256,
  smoke_inputs_sha256:inputs.smoke_inputs_sha256,smoke_model_sha256:inputs.smoke_model_sha256,
  ability_inputs_sha256:inputs.ability_inputs_sha256,ability_model_sha256:inputs.ability_model_sha256,
  dynamic_inputs_sha256:inputs.dynamic_inputs_sha256,dynamic_assets_sha256:inputs.dynamic_assets_sha256,
  timing_bounds_scope:'Evaluator sample brackets only; native render clock and camera/body/effect models unvalidated',
  visibility:visibility.intervals(samples),model,samples};
fs.writeFileSync(outPath+'.tmp',JSON.stringify(report,null,2));
fs.renameSync(outPath+'.tmp',outPath);
process.stdout.write(JSON.stringify({samples:samples.length,model_contacts:model.contacts.length,unknown_visibility_samples:report.visibility.unknown_samples,out:outPath})+'\n');
