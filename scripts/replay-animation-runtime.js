/* Decompressed asset track sampling and skeleton composition.
 * Track time convention follows CUE4Parse CAnimTrack; reference outputs are
 * checked against the installed converter. Native graph/retarget parity is
 * separate from this asset preview, which never invents an activation clock.
 */
(function(root){
  'use strict';
  const finite=v=>{if(!Number.isFinite(v))throw Error('nonfinite_animation_value');return v;};
  function vector(v,n){if(!Array.isArray(v)||v.length!==n)throw Error('invalid_animation_vector');return v.map(finite);}
  function normalize(q){q=vector(q,4);const size=Math.hypot(...q);if(size<1e-10)throw Error('zero_quaternion');return q.map(v=>v/size);}
  function slerp(a,b,t){
    // CUE's FQuat.Slerp uses the raw endpoint dot product and normalizes the
    // result. Additive conversion can retain zero endpoints; normalizing each
    // input would change the converter's result or reject a valid sample.
    a=vector(a,4);b=vector(b,4);const raw=a.reduce((s,v,i)=>s+v*b[i],0),dot=Math.abs(raw);
    let wa=1-t,wb=t;
    if(dot<.9999){const angle=Math.acos(dot),den=Math.sin(angle);wa=Math.sin((1-t)*angle)/den;wb=Math.sin(t*angle)/den;}
    if(raw<0)wb=-wb;
    const q=a.map((v,i)=>v*wa+b[i]*wb);
    return q.reduce((s,v)=>s+v*v,0)<1e-8?[0,0,0,1]:normalize(q);
  }
  function keyPair(times,frame,count,keys){
    if(keys<2||count===1||frame===0)return [0,0,0];
    if(times.length){
      if(times.length!==keys||times.some((v,i)=>!Number.isFinite(v)||(i&&v<=times[i-1])))throw Error('invalid_animation_key_times');
      let lo=0,hi=times.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<=frame)lo=mid+1;else hi=mid;}
      const a=Math.max(0,lo-1),b=Math.min(a+1,keys-1);
      return [a,b,a===b?0:Math.fround(Math.fround(frame-times[a])/Math.fround(times[b]-times[a]))];
    }
    const position=Math.fround(Math.fround(frame/count)*keys),a=Math.min(keys-1,Math.floor(position)),b=Math.min(keys-1,a+1);
    return [a,b,a===b?0:Math.fround(position-a)];
  }
  function sampleTrack(track,base,frame,frames,interpolation='Linear'){
    if(!['Linear','Step'].includes(interpolation))throw Error('unsupported_animation_interpolation:'+interpolation);
    if(!Number.isInteger(frames)||frames<1||!Number.isFinite(frame)||frame<0||frame>=frames)throw Error('invalid_animation_frame');
    frame=Math.fround(frame);
    const result={};
    for(const [name,size] of [['translation',3],['rotation',4],['scale',3]]){
      const keys=track[name]||[],times=(track.times||[]).length?track.times:(track[name+'_times']||[]);
      if(!keys.length){result[name]=vector(base[name],size);continue;}
      const [a,b,t]=keyPair(times,frame,frames,keys.length),left=vector(keys[a],size),right=vector(keys[b],size);
      if(t===0||interpolation==='Step')result[name]=left;
      else result[name]=name==='rotation'?slerp(left,right,t):left.map((v,i)=>Math.fround(v+Math.fround(Math.fround(right[i]-v)*t)));
    }
    return result;
  }
  function rotate(q,v){
    q=normalize(q);v=vector(v,3);const [x,y,z,w]=q,[a,b,c]=v;
    const tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);
    return [a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];
  }
  function multiply(a,b){
    const [x,y,z,w]=normalize(a),[u,v,s,t]=normalize(b);
    return normalize([w*u+x*t+y*s-z*v,w*v-x*s+y*t+z*u,w*s+x*v-y*u+z*t,w*t-x*u-y*v-z*s]);
  }
  function compose(parent,child){
    const pos=rotate(parent.rotation,child.translation.map((v,i)=>v*parent.scale[i]));
    return {translation:pos.map((v,i)=>v+parent.translation[i]),rotation:multiply(parent.rotation,child.rotation),scale:child.scale.map((v,i)=>v*parent.scale[i])};
  }
  function worldPose(bones,locals){
    if(!Array.isArray(bones)||bones.length!==locals.length)throw Error('skeleton_pose_count');
    const worlds=new Array(bones.length),visiting=new Set();
    function bone(i){
      if(worlds[i])return worlds[i];if(visiting.has(i))throw Error('skeleton_cycle');visiting.add(i);
      const p=bones[i].parent;
      if(!Number.isInteger(p)||p< -1||p>=bones.length)throw Error('invalid_bone_parent');
      const local=locals[i];for(const [k,n] of [['translation',3],['rotation',4],['scale',3]])vector(local[k],n);
      worlds[i]=p===-1?structuredClone(local):compose(bone(p),local);visiting.delete(i);return worlds[i];
    }
    bones.forEach((_,i)=>bone(i));return worlds;
  }
  function applyAdditive(bones,base,delta,type,weight=1){
    if(weight!==0&&weight!==1)throw Error('unverified_additive_weight');
    if(base.length!==bones.length||delta.length!==bones.length)throw Error('skeleton_pose_count');
    worldPose(bones,base); // Validate the hierarchy and explicit base before mutation.
    for(const pose of delta)for(const [k,n] of [['translation',3],['rotation',4],['scale',3]])vector(pose[k],n);
    if(weight===0)return structuredClone(base);
    if(!['AAT_LocalSpaceBase','AAT_RotationOffsetMeshSpace'].includes(type))throw Error('unsupported_additive_type:'+type);
    let rotations;
    if(type==='AAT_LocalSpaceBase')rotations=base.map((b,i)=>multiply(delta[i].rotation,b.rotation));
    else{
      const component=worldPose(bones,base).map((b,i)=>multiply(delta[i].rotation,b.rotation));
      rotations=component.map((q,i)=>{
        const p=bones[i].parent;if(p<0)return q;
        const parent=normalize(component[p]);return multiply([-parent[0],-parent[1],-parent[2],parent[3]],q);
      });
    }
    return base.map((b,i)=>({rotation:rotations[i],translation:b.translation.map((v,j)=>Math.fround(v+delta[i].translation[j])),
      scale:b.scale.map((v,j)=>Math.fround(v*Math.fround(1+delta[i].scale[j])))}));
  }
  function sample(sequence,skeleton,seconds,options={}){
    try{
      const additive=sequence.pose_kind==='raw_additive_delta_tracks';
      if(sequence.pose_kind!=='cue_converted_tracks'&&!additive)throw Error('unbound_animation_format');
      if(!['Linear','Step'].includes(sequence.interpolation))throw Error('unsupported_animation_interpolation:'+sequence.interpolation);
      if(skeleton.object_path!==sequence.skeleton)throw Error('skeleton_binding_mismatch');
      if(!additive&&(sequence.converted_is_additive||sequence.additive_type!=='AAT_None'))throw Error('unbound_additive_pose_application');
      if(additive&&!Array.isArray(options.basePose)&&!options.deltaOnly)throw Error('unbound_additive_base_pose');
      if(options.deltaOnly&&!additive)throw Error('sequence_is_not_raw_additive');
      if(!Number.isFinite(seconds)||seconds<0)throw Error('invalid_animation_clock');
      const duration=sequence.duration_seconds;
      const staticPose=sequence.frames===1&&duration===0;
      if(!Number.isFinite(duration)||duration<0||(!staticPose&&(duration===0||!Number.isFinite(sequence.frames_per_second)||sequence.frames_per_second<=0)))throw Error('invalid_animation_duration');
      const time=staticPose?0:options.loop?seconds%duration:Math.min(seconds,duration);
      const fps=options.assetClock?sequence.frames/duration:sequence.frames_per_second;
      const frame=staticPose?0:Math.min(sequence.frames-1,time*fps);
      if(sequence.tracks.length!==skeleton.bones.length||sequence.base_pose.length!==sequence.tracks.length)throw Error('skeleton_pose_count');
      let local=sequence.tracks.map((t,i)=>sampleTrack(t,sequence.base_pose[i],frame,sequence.frames,sequence.interpolation));
      if(options.deltaOnly)return {known:true,local,world:null,frame,seconds:time,evidence:'decompressed_additive_delta_tracks',native_graph_execution:false};
      if(additive)local=applyAdditive(skeleton.bones,options.basePose,local,sequence.additive_type,options.weight??1);
      return {known:true,local,world:worldPose(skeleton.bones,local),frame,seconds:time,
        evidence:additive?'decompressed_additive_tracks_explicit_base':'decompressed_asset_tracks',native_graph_execution:false,
        gaps:['native_graph_activation_and_blending','native_mesh_retargeting','native_root_motion_application']};
    }catch(e){return {known:false,reason:e.message,local:null,world:null};}
  }
  function referencePath(value){
    const text=typeof value==='string'?value:value?.reference;
    if(typeof text!=='string')throw Error('unbound_animation_reference');
    const match=text.match(/^(?:[^']+')?(\/Game\/[^']+)'?$/);if(!match)throw Error('unbound_animation_reference');return match[1];
  }
  function linkedTime(value){
    const method=String(typeof value.LinkMethod==='object'?['Absolute','Relative','Proportional'][value.LinkMethod?.value__]:value.LinkMethod||''),time=finite(value.LinkValue);
    if(method.endsWith('::Absolute')||method==='Absolute')return time;
    if(method.endsWith('::Relative')||method==='Relative')return finite(value.SegmentBeginTime)+time;
    if(method.endsWith('::Proportional')||method==='Proportional')return finite(value.SegmentBeginTime)+time*finite(value.SegmentLength);
    throw Error('unverified_animation_link_method:'+method);
  }
  function compositionTimeline(asset,rates={}){
    try{
      const p=asset.properties||{},source=asset.SlotAnimTracks||p.SlotAnimTracks||
        (p.AnimationTrack?[{SlotName:'Composite',AnimTrack:p.AnimationTrack}]:null);
      if(!Array.isArray(source)||!source.length)throw Error('unbound_animation_composition');
      const slots=source.map(slot=>({name:String(slot.SlotName),segments:slot.AnimTrack.AnimSegments.map(s=>{
        const path=referencePath(s.AnimReference),start=finite(s.StartPos),from=finite(s.AnimStartTime),to=finite(s.AnimEndTime),
          rate=finite(s.AnimPlayRate)*finite(rates[path]??1),loops=s.LoopingCount;
        if(start<0||from<0||to<=from||rate===0||!Number.isInteger(loops)||loops<1)throw Error('invalid_animation_segment');
        return {path,start,from,to,rate,loops,end:start+(to-from)*loops/Math.abs(rate)};
      })}));
      const duration=Math.max(...slots.flatMap(s=>s.segments.map(v=>v.end)));
      if(!Number.isFinite(duration)||duration<=0)throw Error('invalid_animation_composition_duration');
      const sections=(asset.CompositeSections||p.CompositeSections||[]).map(s=>({name:String(s.SectionName),next:String(s.NextSectionName),start:linkedTime(s)})).sort((a,b)=>a.start-b.start);
      const names=new Set();sections.forEach((s,i)=>{
        if(names.has(s.name)||s.start<0||s.start>=duration||(i&&s.start<=sections[i-1].start))throw Error('invalid_animation_sections');
        names.add(s.name);s.end=sections[i+1]?.start??duration;
      });
      for(const s of sections)if(s.next!=='None'&&!names.has(s.next))throw Error('unbound_animation_next_section:'+s.next);
      return {known:true,slots,sections,duration,evidence:'serialized_animation_segments',native_graph_execution:false};
    }catch(e){return {known:false,reason:e.message};}
  }
  function compositionAt(timeline,seconds,options={}){
    try{
      if(!timeline.known)throw Error(timeline.reason);if(!Number.isFinite(seconds)||seconds<0)throw Error('invalid_animation_clock');
      let clock=Math.min(seconds,timeline.duration),section=null,ended=seconds>=timeline.duration;
      if(options.followSections&&timeline.sections.length){
        let current=timeline.sections.find(s=>s.name===(options.startSection||timeline.sections[0].name));
        if(!current)throw Error('unbound_animation_start_section');
        let remaining=seconds;const seen=new Map();ended=false;
        for(let steps=0;;steps++){
          if(steps>timeline.sections.length*3+3)throw Error('invalid_animation_section_cycle');
          if(seen.has(current.name)){
            const cycle=seen.get(current.name)-remaining;if(cycle<=0)throw Error('invalid_animation_section_cycle');
            remaining%=cycle;seen.clear();
          }
          seen.set(current.name,remaining);
          const span=current.end-current.start;
          if(remaining<span){clock=current.start+remaining;section=current.name;break;}
          remaining-=span;
          if(current.next==='None'){clock=current.end;section=current.name;ended=true;break;}
          current=timeline.sections.find(s=>s.name===current.next);
        }
      }else if(options.loop){clock=seconds%timeline.duration;ended=false;}
      const slot=options.slot?timeline.slots.find(s=>s.name===options.slot):(timeline.slots.length===1?timeline.slots[0]:null);
      if(!slot)throw Error('unbound_animation_slot');
      const active=slot.segments.filter(s=>clock>=s.start&&(clock<s.end||(clock===timeline.duration&&clock===s.end)));
      if(active.length!==1)throw Error(active.length?'overlapping_animation_segments':'animation_slot_has_no_segment');
      const s=active[0],length=s.to-s.from,position=(clock-s.start)*Math.abs(s.rate),atEnd=clock===s.end;
      const within=atEnd?length:position%length;
      return {known:true,path:s.path,seconds:s.rate>0?s.from+within:s.to-within,clock,section,slot:slot.name,ended,
        segment:s,loop_index:Math.min(s.loops-1,Math.floor(position/length)),native_graph_execution:false};
    }catch(e){return {known:false,reason:e.message};}
  }
  function blendWeights(asset,inputs){
    try{
      if(asset.metadata_kind!=='typed_blendspace_arrays')throw Error('unbound_blendspace_metadata');
      if(asset.properties?.bInterpolateUsingGrid!==true)throw Error('unbound_blendspace_triangulation');
      const divisions=asset.grid_divisions;if(!Array.isArray(divisions)||![1,2].includes(divisions.length))throw Error('unbound_blendspace_grid_shape');
      if(divisions.some(v=>!Number.isInteger(v)||v<1)||asset.grid.length!==divisions.reduce((n,v)=>n*(v+1),1))throw Error('invalid_blendspace_grid_shape');
      if(!Array.isArray(inputs)||inputs.length!==divisions.length)throw Error('unbound_blendspace_inputs');
      const coordinate=divisions.map((n,i)=>{
        const axis=asset.axes[i],min=finite(axis.Min),max=finite(axis.Max);if(max<=min)throw Error('invalid_blendspace_axis');
        let value=finite(inputs[i]);if(axis.bWrapInput&&(value<min||value>max))value=min+((value-min)%(max-min)+(max-min))%(max-min);
        value=Math.max(min,Math.min(max,value));let position=(value-min)/(max-min)*n;if(axis.bSnapToGrid)position=Math.round(position);
        const lo=Math.min(n-1,Math.floor(position));return {lo,hi:lo+1,t:position-lo};
      });
      const points=[];
      for(let y=0;y<(coordinate.length===2?2:1);y++)for(let x=0;x<2;x++){
        const a=coordinate[0],b=coordinate[1],index=(x?a.hi:a.lo)+(b?(y?b.hi:b.lo)*(divisions[0]+1):0),factor=(x?a.t:1-a.t)*(b?(y?b.t:1-b.t):1);
        if(factor>0)points.push({index,factor});
      }
      const weights=new Map();
      for(const {index,factor} of points){
        const node=asset.grid[index];if(node.Indices?.length!==3||node.Weights?.length!==3)throw Error('incomplete_blendspace_grid_weights');
        let sum=0;
        for(let i=0;i<3;i++){
          const id=node.Indices[i],weight=finite(node.Weights[i]);if(weight<0||!Number.isInteger(id)||id< -1||id>=asset.samples.length)throw Error('invalid_blendspace_grid_weight');
          if(id===-1){if(weight!==0)throw Error('invalid_blendspace_grid_weight');continue;}
          sum+=weight;if(weight>0)weights.set(id,(weights.get(id)||0)+weight*factor);
        }
        if(Math.abs(sum-1)>1e-3)throw Error('incomplete_blendspace_grid_weights');
      }
      const total=Array.from(weights.values()).reduce((a,b)=>a+b,0);if(total<1e-8)throw Error('empty_blendspace_weights');
      const samples=Array.from(weights,([index,weight])=>({index,weight:weight/total,path:referencePath(asset.samples[index].Animation),rate:asset.samples[index].RateScale})).sort((a,b)=>a.index-b.index);
      return {known:true,samples,evidence:'serialized_blendspace_grid',native_graph_execution:false,
        gaps:['native_input_and_per_bone_weight_smoothing','native_blendspace_phase_and_sync']};
    }catch(e){return {known:false,reason:e.message};}
  }
  function blendTransforms(poses,weights){
    if(!Array.isArray(poses)||!poses.length||poses.length!==weights.length||poses.some(p=>p.length!==poses[0].length))throw Error('invalid_blend_pose_count');
    if(weights.some(w=>!Number.isFinite(w)||w<0)||Math.abs(weights.reduce((a,b)=>a+b,0)-1)>1e-6)throw Error('invalid_blend_pose_weights');
    return poses[0].map((_,bone)=>{
      const first=normalize(poses[0][bone].rotation),rotation=[0,0,0,0],translation=[0,0,0],scale=[0,0,0];
      poses.forEach((pose,i)=>{
        const p=pose[bone],q=normalize(p.rotation),sign=first.reduce((n,v,j)=>n+v*q[j],0)<0?-1:1;
        for(let j=0;j<4;j++)rotation[j]+=q[j]*weights[i]*sign;
        for(let j=0;j<3;j++){translation[j]+=vector(p.translation,3)[j]*weights[i];scale[j]+=vector(p.scale,3)[j]*weights[i];}
      });
      return {rotation:normalize(rotation),translation:translation.map(Math.fround),scale:scale.map(Math.fround)};
    });
  }
  const api={sampleTrack,worldPose,sample,slerp,applyAdditive,referencePath,linkedTime,compositionTimeline,compositionAt,blendWeights,blendTransforms};
  if(typeof module!=='undefined')module.exports=api;if(root)root.ReplayAnimation=api;
})(typeof window==='undefined'?null:window);
