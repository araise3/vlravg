'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const runtime=require('./replay-animation-runtime.js');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function validate(source){
  let checks=0,sequences=0,zeroQuaternionSamples=0,additiveSequences=0,maxTranslationError=0,maxScaleError=0,maxRotationAngle=0;
  const index=fs.readFileSync(path.join(source,'index.jsonl'));
  const entries=new Map(index.toString().trim().split(/\r?\n/).filter(Boolean).map(l=>{const r=JSON.parse(l);return [r.package,r];}));
  const skeletons=new Map(),previewGaps=[],previewGapCounts={};let absolutePoseSequences=0;
  for(const item of entries.values()){
    const bytes=fs.readFileSync(path.join(source,item.file));assert.equal(sha(bytes),item.sha256);checks++;
    const data=JSON.parse(zlib.gunzipSync(bytes));
    for(const seq of data.exports){
      if(seq.export_class!=='AnimSequence')continue;sequences++;if(seq.converted_is_additive||seq.additive_type!=='AAT_None')additiveSequences++;
      const s=seq.skeleton_record;
      if(!skeletons.has(s.file)){
        const b=fs.readFileSync(path.join(source,s.file));assert.equal(sha(b),s.sha256);checks++;
        const skeleton=JSON.parse(zlib.gunzipSync(b));assert.equal(skeleton.object_path,seq.skeleton);checks++;
        runtime.worldPose(skeleton.bones,skeleton.bones.map(b=>b.rest));checks++;skeletons.set(s.file,skeleton);
      }
      // Try all bones, not just the independent reference subset, before
      // claiming that this converted sequence can be previewed as a pose.
      let poseGap=null;
      for(const time of [0,seq.duration_seconds*.371]){const pose=runtime.sample(seq,skeletons.get(s.file),time);checks++;if(!pose.known){poseGap=pose.reason;break;}}
      if(poseGap){previewGaps.push({object_path:seq.object_path,reason:poseGap});previewGapCounts[poseGap]=(previewGapCounts[poseGap]||0)+1;}else absolutePoseSequences++;
      for(const row of seq.reference_samples){
        let sampled;try{sampled=runtime.sampleTrack(seq.tracks[row.bone],seq.base_pose[row.bone],row.frame,seq.frames);}catch(e){throw Error(seq.object_path+' '+row.bone+'/'+row.frame+': '+e.message);}
        for(const key of ['translation','scale'])for(let i=0;i<3;i++){
          const error=Math.abs(sampled[key][i]-row[key][i]);
          if(key==='translation')maxTranslationError=Math.max(maxTranslationError,error);else maxScaleError=Math.max(maxScaleError,error);
          assert.ok(error<2e-4,`${seq.object_path} ${row.bone}/${row.frame} ${key}[${i}]: ${error}`);checks++;
        }
        const normA=Math.hypot(...sampled.rotation),normB=Math.hypot(...row.rotation);
        if(normA<1e-10||normB<1e-10){assert.deepEqual(sampled.rotation,row.rotation,seq.object_path+' zero quaternion differs');zeroQuaternionSamples++;checks++;continue;}
        const a=sampled.rotation.map(v=>v/normA),b=row.rotation.map(v=>v/normB);
        const dot=Math.abs(a.reduce((s,v,i)=>s+v*b[i],0)),angle=2*Math.acos(Math.min(1,dot));
        maxRotationAngle=Math.max(maxRotationAngle,angle);assert.ok(angle<2e-4,`${seq.object_path} quaternion angle ${angle}`);checks++;
      }
    }
  }
  return {schema_version:1,packages_verified:entries.size,sequences_checked:sequences,additive_sequences_requiring_pose_application:additiveSequences,
    zero_quaternion_reference_samples:zeroQuaternionSamples,skeletons_checked:skeletons.size,checks,
    maximum_translation_error_cm:maxTranslationError,maximum_scale_error:maxScaleError,maximum_rotation_error_radians:maxRotationAngle,
    index_sha256:sha(index),runtime_sha256:sha(fs.readFileSync(path.join(__dirname,'replay-animation-runtime.js'))),
    checker_sha256:sha(fs.readFileSync(__filename)),absolute_pose_sequences_checked:absolutePoseSequences,
    preview_gap_counts:previewGapCounts,preview_gaps:previewGaps,
    reference:'installed_CUE4Parse_GetBoneTransform',native_animation_graph_execution_validated:false};
}
module.exports={validate};
if(require.main===module)process.stdout.write(JSON.stringify(validate(process.argv[2]),null,2)+'\n');
