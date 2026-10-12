const test=require('node:test'),assert=require('node:assert/strict');
const runtime=require('../scripts/replay-animation-runtime.js'),fixture=require('./fixtures/replay-animation-13.06.json');
test('decompressed real crouch tracks agree with installed converter reference samples',()=>{
  for(const row of fixture.reference_samples){
    const bone=fixture.bones.find(b=>b.index===row.bone),r=runtime.sampleTrack(bone.track,bone.base,row.frame,fixture.sequence.frames);
    for(const key of ['translation','scale'])for(let i=0;i<row[key].length;i++)assert.ok(Math.abs(r[key][i]-row[key][i])<5e-5,`${key}[${i}] at ${row.frame}`);
    // The installed converter's approximate inverse square root can produce
    // non-unit quaternions. Check rotation direction without discarding its raw
    // reference values or widening translation/scale tolerances.
    const a=r.rotation.map(v=>v/Math.hypot(...r.rotation)),b=row.rotation.map(v=>v/Math.hypot(...row.rotation));
    assert.ok(Math.abs(a.reduce((sum,v,i)=>sum+v*b[i],0))>1-1e-8);
  }
});
test('irregular keys, independent channel times and quaternion hemisphere changes',()=>{
  const base={translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]};
  const t={translation:[[0,0,0],[10,0,0],[20,0,0]],translation_times:[0,2,8],rotation:[[0,0,0,1],[0,0,0,-1]],rotation_times:[0,8]};
  const r=runtime.sampleTrack(t,base,5,9);assert.deepEqual(r.translation,[15,0,0]);assert.deepEqual(r.scale,[1,1,1]);assert.deepEqual(r.rotation,[0,0,0,1]);
});
test('step interpolation holds each channel until its next explicit key',()=>{
  const base={translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]};
  const track={translation:[[0,0,0],[10,0,0],[20,0,0]],translation_times:[0,2,8],scale:[[1,1,1],[2,2,2]],scale_times:[0,5]};
  assert.deepEqual(runtime.sampleTrack(track,base,4.999,9,'Step').translation,[10,0,0]);
  assert.deepEqual(runtime.sampleTrack(track,base,4.999,9,'Step').scale,[1,1,1]);
  assert.deepEqual(runtime.sampleTrack(track,base,5,9,'Step').scale,[2,2,2]);
  assert.deepEqual(runtime.sampleTrack(track,base,8,9,'Step').translation,[20,0,0]);
});
test('parent transforms compose while invalid skeletons and clocks fail explicitly',()=>{
  const q=[0,0,Math.SQRT1_2,Math.SQRT1_2],local=[{translation:[10,0,0],rotation:q,scale:[2,2,2]},
    {translation:[1,0,0],rotation:[0,0,0,1],scale:[1,1,1]}];
  const world=runtime.worldPose([{parent:-1},{parent:0}],local);assert.ok(Math.abs(world[1].translation[0]-10)<1e-10);assert.ok(Math.abs(world[1].translation[1]-2)<1e-10);
  assert.throws(()=>runtime.worldPose([{parent:1},{parent:0}],local),/skeleton_cycle/);
  assert.throws(()=>runtime.sampleTrack({},local[0],NaN,2),/invalid_animation_frame/);
});
test('converter zero endpoints sample without fabricating an additive world pose',()=>{
  assert.deepEqual(runtime.slerp([0,0,0,1],[0,0,0,0],.371),[0,0,0,1]);
  assert.deepEqual(runtime.slerp([0,0,0,0],[0,0,0,0],.5),[0,0,0,1]);
  const sequence={pose_kind:'cue_converted_tracks',interpolation:'Linear',skeleton:'rig',additive_type:'AAT_RotationOffsetMeshSpace',converted_is_additive:true};
  assert.equal(runtime.sample(sequence,{object_path:'rig'},0).reason,'unbound_additive_pose_application');
});
test('single-frame absolute poses have a static clock',()=>{
  const base={translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]};
  const sequence={pose_kind:'cue_converted_tracks',interpolation:'Linear',skeleton:'rig',additive_type:'AAT_None',converted_is_additive:false,frames:1,frames_per_second:0,duration_seconds:0,tracks:[{}],base_pose:[base]};
  const pose=runtime.sample(sequence,{object_path:'rig',bones:[{parent:-1}]},100,{loop:true});
  assert.equal(pose.known,true);assert.equal(pose.seconds,0);assert.equal(pose.frame,0);assert.deepEqual(pose.world,[base]);
});
test('large-motion asset sampling retains the converter single-precision frame convention',()=>{
  const source=require('./fixtures/replay-animation-large-motion-13.06.json');
  for(const ref of source.reference_samples){const pose=runtime.sampleTrack(source.track,source.base,ref.frame,source.frames);assert.deepEqual(pose.translation,ref.translation);assert.deepEqual(pose.scale,ref.scale);}
});
test('raw local and mesh additive tracks match independent installed decoder composition',()=>{
  const fs=require('node:fs'),zlib=require('node:zlib'),path=require('node:path');
  const source=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'fixtures/replay-additive-animation-13.06.json.gz'))));
  source.records.forEach((seq,index)=>{
    const rig=source.skeletons[index],base=rig.bones.map(b=>b.rest);
    assert.equal(runtime.sample(seq,rig,0).reason,'unbound_additive_base_pose');
    const deltas=runtime.sample(seq,rig,0,{deltaOnly:true});assert.equal(deltas.known,true);assert.equal(deltas.world,null);
    assert.deepEqual(deltas.local[seq.reference_samples[0].bone],{rotation:seq.reference_samples[0].rotation,translation:seq.reference_samples[0].translation,scale:seq.reference_samples[0].scale});
    for(const ref of seq.composition_reference_samples){
      const delta=seq.tracks.map((t,i)=>runtime.sampleTrack(t,seq.base_pose[i],ref.frame,seq.frames));
      const pose=runtime.applyAdditive(rig.bones,base,delta,seq.additive_type)[ref.bone];
      assert.deepEqual(pose.translation,ref.translation);assert.deepEqual(pose.scale,ref.scale);
      const a=pose.rotation.map(v=>v/Math.hypot(...pose.rotation)),b=ref.rotation.map(v=>v/Math.hypot(...ref.rotation));
      assert.ok(Math.abs(a.reduce((s,v,i)=>s+v*b[i],0))>1-1e-8);
    }
    const original=structuredClone(base),neutral=seq.base_pose;
    assert.deepEqual(runtime.applyAdditive(rig.bones,base,neutral,seq.additive_type,0),base);assert.deepEqual(base,original);
    assert.throws(()=>runtime.applyAdditive(rig.bones,base,neutral,seq.additive_type,.5),/unverified_additive_weight/);
  });
});
test('real death montage follows its stored loop deterministically across seeks',()=>{
  const {asset}=require('./fixtures/replay-animation-montage-13.06.json'),timeline=runtime.compositionTimeline(asset);
  assert.equal(timeline.known,true);assert.equal(timeline.slots[0].name,'Death');
  const loop=timeline.sections.find(s=>s.name==='loop'),end=timeline.duration;
  const initial=runtime.compositionAt(timeline,.5,{slot:'Death',followSections:true});assert.equal(initial.section,'Default');assert.equal(initial.seconds,.5);
  for(const elapsed of [end,end+1000,end+1234567]){
    const r=runtime.compositionAt(timeline,elapsed,{slot:'Death',followSections:true});assert.equal(r.known,true);assert.equal(r.section,'loop');assert.ok(r.clock>=loop.start&&r.clock<end);
    assert.deepEqual(runtime.compositionAt(timeline,elapsed,{slot:'Death',followSections:true}),r);
  }
  assert.equal(runtime.compositionAt(timeline,.2,{slot:'Death',followSections:true}).clock,.2);
  assert.equal(runtime.compositionAt(timeline,end+1,{slot:'Death',followSections:false}).ended,true);
});
test('composition preserves trims, repeat counts, reverse playback and ambiguous slots',()=>{
  const segment={AnimReference:{reference:"AnimSequence'/Game/Test.Test'"},StartPos:2,AnimStartTime:1,AnimEndTime:5,AnimPlayRate:-2,LoopingCount:2};
  const asset={properties:{SlotAnimTracks:[{SlotName:'Upper',AnimTrack:{AnimSegments:[segment]}}]}};
  const t=runtime.compositionTimeline(asset);assert.equal(t.duration,6);
  assert.equal(runtime.compositionAt(t,2).seconds,5);assert.equal(runtime.compositionAt(t,3).seconds,3);assert.equal(runtime.compositionAt(t,4).seconds,5);assert.equal(runtime.compositionAt(t,6).seconds,1);
  assert.equal(runtime.compositionAt(t,1).reason,'animation_slot_has_no_segment');
  asset.properties.SlotAnimTracks.push({SlotName:'Lower',AnimTrack:{AnimSegments:[segment]}});
  assert.equal(runtime.compositionAt(runtime.compositionTimeline(asset),2).reason,'unbound_animation_slot');
  assert.equal(runtime.linkedTime({LinkMethod:'EAnimLinkMethod::Relative',SegmentBeginTime:3,LinkValue:.5}),3.5);
  assert.equal(runtime.linkedTime({LinkMethod:'EAnimLinkMethod::Proportional',SegmentBeginTime:3,SegmentLength:4,LinkValue:.5}),5);
});
test('typed aim-offset grid retains all three weights at corners and between grid nodes',()=>{
  const sources=require('./fixtures/replay-blendspace-13.06.json'),asset=sources[1].asset;
  const at=(x,y)=>runtime.blendWeights(asset,[x,y]);
  assert.equal(at(-89,-89).samples[0].index,6);assert.equal(at(89,-89).samples[0].index,7);
  assert.equal(at(-89,89).samples[0].index,3);assert.equal(at(89,89).samples[0].index,4);
  const middle=at(-22.25,-89);assert.equal(middle.known,true);assert.equal(middle.samples.length,2);
  assert.ok(Math.abs(middle.samples.find(s=>s.index===6).weight-.25)<1e-8);assert.ok(Math.abs(middle.samples.find(s=>s.index===5).weight-.75)<1e-8);
  assert.deepEqual(at(-1000,-1000),at(-89,-89));
  const unknown=structuredClone(asset);unknown.grid_divisions=null;assert.equal(runtime.blendWeights(unknown,[0,0]).reason,'unbound_blendspace_grid_shape');
});
test('typed 1D turn grid and pose interpolation preserve endpoints and quaternion hemisphere',()=>{
  const asset=require('./fixtures/replay-blendspace-13.06.json')[0].asset;
  const a=runtime.blendWeights(asset,[22.5]);assert.equal(a.known,true);assert.equal(a.samples.length,2);
  const p={translation:[2,4,0],rotation:[0,0,0,1],scale:[1,1,1]},q={translation:[6,0,0],rotation:[0,0,0,-1],scale:[2,2,2]};
  const result=runtime.blendTransforms([[p],[q]],[.25,.75])[0];assert.deepEqual(result.translation,[5,1,0]);assert.deepEqual(result.scale,[1.75,1.75,1.75]);assert.deepEqual(result.rotation,[0,0,0,1]);
  assert.throws(()=>runtime.blendTransforms([[p],[q]],[1,1]),/invalid_blend_pose_weights/);
});
