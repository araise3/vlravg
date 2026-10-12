/* Provenance-bound offline replay model -> per-observer response estimates. */
'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const math=require('./replay-transcription-viewer.js'),behavior=require('./replay-behavior-runtime.js');
const visibility=require('./replay-visibility-runtime.js'),metric=require('./replay-estimated-response.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function analyze(scene,geometry){
  for(const [name,expected] of Object.entries(scene.provenance.source_hashes||{})){
    if(require('node:path').basename(name)!==name||hash(fs.readFileSync(__dirname+'/'+name))!==expected)throw Error('Analyzer source receipt mismatch: '+name);
  }
  if(hash(geometry)!==scene.provenance.bvh_sha256)throw Error('Geometry receipt mismatch');
  const inputRaw=Buffer.from(scene.visibility_inputs_raw,'base64');
  if(hash(inputRaw)!==scene.provenance.visibility_inputs_sha256||JSON.stringify(JSON.parse(inputRaw))!==JSON.stringify(scene.visibility_inputs))throw Error('Visibility inputs receipt mismatch');
  const decode=bytes=>math.decodeBVH(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const mesh=decode(geometry),inputs=scene.visibility_inputs,overlays=(scene.overlay_bvhs||[]).map((raw,i)=>{
    const bytes=Buffer.from(raw,'base64');if(hash(bytes)!==inputs.geometry_overlays?.[i]?.bvh_sha256)throw Error('Overlay receipt mismatch');return decode(bytes);
  });
  if(overlays.length!==(inputs.geometry_overlays||[]).length)throw Error('Overlay count mismatch');
  const data=visibility.dataWithInputs(scene.data,inputs),settings=metric.policy(scene.policy),players=data.players;
  const underlying=behavior.createFrameEvaluator(data,math);let frameClock=null;const frames=new Map();
  const frame=(subject,t,round)=>{const clock=JSON.stringify([t,round.index]);if(frameClock!==clock){frameClock=clock;frames.clear();}if(!frames.has(subject))frames.set(subject,underlying(subject,t,round));return frames.get(subject);};
  const pair=visibility.createPairEvaluator(data,mesh,math,frame,{...inputs,overlay_meshes:overlays});
  const shots=data.events.filter(e=>e.kind==='shot').map(s=>({...s,timing_usable:true}));
  const analyzers=new Map(players.map(p=>[p.subject,metric.createAnalyzer(p.subject,players.filter(e=>e.team!==p.team).map(e=>e.subject),shots,settings)]));
  const life=new Map(),counts={pair_queries:0,native_unknown_pair_samples:0};
  let lastProgress=Date.now();
  for(const round of data.rounds){
    const times=scene.sample_times.filter(t=>t>=round.combat_start_ms&&t<round.combat_end_ms);
    for(const t of times){
      for(const observer of players){
        const state=frame(observer.subject,t,round),previous=life.get(observer.subject);
        const epoch=previous?.round===round.index?previous.epoch+(!previous.alive&&state.alive?1:0):0;
        life.set(observer.subject,{round:round.index,epoch,alive:state.alive});
        const targets=players.filter(p=>p.team!==observer.team).map(target=>{
          if(!state.alive)return {id:target.subject,state:'hidden',reasons:['observer_dead']};
          const r=pair(observer.subject,target.subject,t,round,{body_half_width_cm:settings.body_half_width_cm,max_pose_age_ms:settings.max_pose_age_ms,skip_offscreen_rays:true});
          counts.pair_queries++;if(r.visibility.state==='unknown')counts.native_unknown_pair_samples++;
          const witness=r.contact.points?.find(p=>p.state==='direct');
          return {id:target.subject,state:r.contact.state,reasons:r.contact.reasons,pose_times_ms:r.source_pose_times_ms,
            witness:witness?{id:witness.id,position:witness.position,in_view:witness.in_view,wall_clear:witness.wall_clear,smoke_clear:witness.smoke_clear,dynamic_clear:witness.dynamic_clear}:null};
        });
        analyzers.get(observer.subject).feed({time_ms:t,observer:observer.subject,round:round.index,life:epoch,alive:state.alive,combat:true,complete:true,targets});
      }
    }
    if(Date.now()-lastProgress>20000){process.stdout.write(JSON.stringify({match_id:data.match_id,round:round.number,pair_queries:counts.pair_queries})+'\n');lastProgress=Date.now();}
  }
  const observers=players.map(p=>({...p,...analyzers.get(p.subject).result()}));
  return {schema_version:1,producer:'offline-estimated-visual-response-v1',status:'estimated',match_id:data.match_id,replay_build:data.replay_build,map:data.map,
    clock:'replay_time_ms',metric:'estimated_visual_response_to_first_discharge',definition:'First modeled contact after known hidden history to first observed gun discharge, hit or miss; one sample per observer encounter.',
    native_visibility_verified:false,native_camera_verified:false,native_body_verified:false,native_opacity_verified:false,native_activation_clock_verified:false,
    publishable_as_human_reaction_time:false,policy:settings,summary:metric.summarize(observers.flatMap(p=>p.samples)),observers,diagnostics:counts,source_diagnostics:data.diagnostics,
    provenance:scene.provenance,assumptions:{camera:'Causal movement yaw/pitch and asset eye/stance offsets; active weapon FOV with approximate transitions.',
      body:settings.body_half_width_cm?'Nine silhouette-grid points with explicit lateral width; capsule origin and stance heights, no animated bones.':'Three capsule centerline points; no animated bones.',
      walls:'Published incomplete static opaque geometry plus verified additive overlays.',
      effects:'Existing conservative smoke, flash, remote-camera and dynamic/ability uncertainty exclusions; no radar/relevancy substituted for visibility.',
      sampling:'50 ms combat grid plus shot, effect, life and dependency boundaries; causal original movement selected at each query.',
      bounds:'Sampling brackets only; no bound on model, network, native display or input timing error.',
      population:'Responded encounters satisfying this policy and available decoded evidence; exclusions and nonresponses retained. Unknown native visibility stays unknown.'}};
}
if(require.main===module){
  const [scenePath,meshPath,outPath]=process.argv.slice(2);if(!scenePath||!meshPath||!outPath)throw Error('Expected scene, BVH and output paths');
  const report=analyze(JSON.parse(fs.readFileSync(scenePath)),fs.readFileSync(meshPath));
  fs.writeFileSync(outPath+'.tmp',JSON.stringify(report));fs.renameSync(outPath+'.tmp',outPath);
  process.stdout.write(JSON.stringify({match_id:report.match_id,...report.summary,out:outPath})+'\n');
}
module.exports={analyze};
