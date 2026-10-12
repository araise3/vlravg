'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const runtime=require('./replay-animation-runtime.js'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(source){
  const index=fs.readFileSync(path.join(source,'index.jsonl')),entries=new Map(index.toString().trim().split(/\r?\n/).filter(Boolean).map(l=>{const r=JSON.parse(l);return [r.package,r];}));
  const skeletons=new Map(),gaps=[],types={},compression={};let checks=0,sequences=0,preview=0,maxTranslation=0,maxScale=0,maxAngle=0;
  function compare(a,b,label){
    for(const name of ['translation','scale'])for(let i=0;i<3;i++){
      const error=Math.abs(a[name][i]-b[name][i]);if(name==='translation')maxTranslation=Math.max(maxTranslation,error);else maxScale=Math.max(maxScale,error);
      assert.ok(error<2e-4,label+' '+name+': '+error);checks++;
    }
    const na=Math.hypot(...a.rotation),nb=Math.hypot(...b.rotation);assert.ok(na>1e-10&&nb>1e-10,label+' invalid reference quaternion');
    const dot=Math.abs(a.rotation.reduce((s,v,i)=>s+v/na*b.rotation[i]/nb,0)),angle=2*Math.acos(Math.min(1,dot));maxAngle=Math.max(maxAngle,angle);
    assert.ok(angle<2e-4,label+' rotation angle: '+angle);checks++;
  }
  for(const row of entries.values()){
    const bytes=fs.readFileSync(path.join(source,row.file));assert.equal(sha(bytes),row.sha256);checks++;
    const data=JSON.parse(zlib.gunzipSync(bytes));
    for(const seq of data.exports){
      sequences++;types[seq.additive_type]=(types[seq.additive_type]||0)+1;compression[seq.compression]=(compression[seq.compression]||0)+1;
      assert.equal(seq.pose_kind,'raw_additive_delta_tracks');assert.equal(seq.base_pose_applied,false);checks+=2;
      const ref=seq.skeleton_record;
      if(!skeletons.has(ref.file)){
        const b=fs.readFileSync(path.join(source,ref.file));assert.equal(sha(b),ref.sha256);checks++;
        skeletons.set(ref.file,JSON.parse(zlib.gunzipSync(b)));
      }
      const skeleton=skeletons.get(ref.file),base=skeleton.bones.map(b=>b.rest);assert.equal(seq.skeleton,skeleton.object_path);checks++;
      assert.equal(runtime.sample(seq,skeleton,0).reason,'unbound_additive_base_pose');checks++;
      for(const r of seq.reference_samples)compare(runtime.sampleTrack(seq.tracks[r.bone],seq.base_pose[r.bone],r.frame,seq.frames),r,seq.object_path);
      const poses=new Map();
      for(const r of seq.composition_reference_samples){
        if(!poses.has(r.frame)){
          const deltas=seq.tracks.map((t,i)=>runtime.sampleTrack(t,seq.base_pose[i],r.frame,seq.frames));
          poses.set(r.frame,runtime.applyAdditive(skeleton.bones,base,deltas,seq.additive_type));
        }
        compare(poses.get(r.frame)[r.bone],r,seq.object_path+' composition');
      }
      let gap;
      for(const time of [0,seq.duration_seconds*.371,seq.duration_seconds]){
        const result=runtime.sample(seq,skeleton,time,{basePose:base});checks++;if(!result.known){gap=result.reason;break;}
      }
      if(gap)gaps.push({object_path:seq.object_path,reason:gap});else preview++;
    }
  }
  return {schema_version:1,packages_verified:entries.size,sequences_checked:sequences,explicit_base_pose_sequences_checked:preview,
    skeletons_checked:skeletons.size,checks,additive_types:types,compression_types:compression,preview_gaps:gaps,
    maximum_translation_error_cm:maxTranslation,maximum_scale_error:maxScale,maximum_rotation_error_radians:maxAngle,
    reference:'installed_CUE4Parse_raw_GetBoneTransform_and_FAnimationRuntime_full_weight',
    runtime_sha256:sha(fs.readFileSync(path.join(__dirname,'replay-animation-runtime.js'))),checker_sha256:sha(fs.readFileSync(__filename)),index_sha256:sha(index),
    native_animation_graph_execution_validated:false};
}
module.exports={validate};if(require.main===module)process.stdout.write(JSON.stringify(validate(process.argv[2]),null,2)+'\n');
