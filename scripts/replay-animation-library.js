'use strict';
const $=id=>document.getElementById(id),canvas=$('pose'),ctx=canvas.getContext('2d');
let catalog,assetMap,selected,scene,playing=false,time=0,yaw=-.5,zoom=1,last=0,loadId=0;
const cache=new Map();
async function gzip(url,expected){
  if(cache.has(url))return cache.get(url);
  const promise=(async()=>{
    const response=await fetch(url);if(!response.ok)throw Error('Asset record unavailable');
    const bytes=await response.arrayBuffer();
    if(expected){const digest=await crypto.subtle.digest('SHA-256',bytes),hex=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');if(hex!==expected)throw Error('Asset record checksum differs');}
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  })();cache.set(url,promise);return promise;
}
async function recordFor(path){
  const item=assetMap.get(path);if(!item)throw Error('Reference has no decoded asset: '+path);
  const record=await gzip(item.file,item.source_record_sha256),asset=record.exports.find(e=>e.object_path===path);
  if(!asset)throw Error('Export missing from record');return {item,record,asset};
}
function references(value){
  const paths=new Set();function walk(v){
    if(!v||typeof v!=='object')return;
    if(typeof v.reference==='string'){try{const path=ReplayAnimation.referencePath(v);if(path!==selected.object_path&&assetMap.has(path))paths.add(path);}catch{}}
    for(const child of Object.values(v))walk(child);
  }walk(value);$('references').replaceChildren();if(!paths.size)return;
  const label=document.createElement('p');label.textContent='Referenced animation assets';$('references').append(label);
  for(const path of paths){const button=document.createElement('button');button.textContent=path.split('.').at(-1);button.title=path;button.addEventListener('click',()=>select(path));$('references').append(button,document.createTextNode(' '));}
}
function list(){
  const text=$('search').value.toLowerCase(),kind=$('kind').value,rows=catalog.assets.filter(a=>a.object_path.toLowerCase().includes(text)&&(!kind||a.class===kind));
  $('assets').replaceChildren(...rows.slice(0,2000).map(a=>{const o=document.createElement('option');o.value=a.object_path;o.textContent=a.object_path.split('.').at(-1);o.title=a.object_path;return o;}));
  $('assets').value=selected?.object_path||'';$('count').textContent=`${rows.length.toLocaleString()} matches${rows.length>2000?' · showing first 2,000; narrow the search':''}`;
}
async function buildScene(asset,trail=new Set()){
  if(assetMap.get(asset.object_path)?.typed_metadata_gap)return {kind:'gap',reason:assetMap.get(asset.object_path).typed_metadata_gap};
  if(trail.has(asset.object_path))throw Error('Recursive animation reference');
  trail=new Set([...trail,asset.object_path]);
  if(asset.export_class==='Skeleton')return {kind:'skeleton',asset,rig:asset,duration:0};
  if(asset.export_class==='AnimSequence'){
    const prefix=asset.pose_kind==='raw_additive_delta_tracks'?'records/additive/':'records/';
    const rig=await gzip(prefix+asset.skeleton_record.file,asset.skeleton_record.sha256),result={kind:'sequence',asset,rig,duration:asset.duration_seconds};
    if(rig.object_path!==asset.skeleton)throw Error('Animation skeleton binding differs');
    if(asset.pose_kind==='raw_additive_delta_tracks'){
      const ref=asset.reference_pose;result.referenceType=ref?.type;
      if(ref?.type!=='ABPT_RefPose'){
        try{
          if(!['ABPT_AnimFrame','ABPT_AnimScaled'].includes(ref?.type))throw Error('Stored authoring reference cannot be reconstructed: '+ref?.type);
          const path=ReplayAnimation.referencePath(ref.sequence),other=(await recordFor(path)).asset;
          if(other.export_class!=='AnimSequence')throw Error('Authoring reference is not an animation sequence');
          result.reference=await buildScene(other,trail);
          if(result.reference.rig.object_path!==rig.object_path)throw Error('Authoring reference uses a different skeleton');
        }catch(e){result.referenceGap=e.message;}
      }
    }
    return result;
  }
  if(['AnimMontage','AnimComposite'].includes(asset.export_class)){
    const initial=ReplayAnimation.compositionTimeline(asset);if(!initial.known)throw Error(initial.reason);
    const children=new Map(),rates={};
    for(const path of new Set(initial.slots.flatMap(s=>s.segments.map(s=>s.path)))){
      try{const next=(await recordFor(path)).asset;rates[path]=next.rate_scale??next.RateScale??1;children.set(path,await buildScene(next,trail));}
      catch(e){children.set(path,{kind:'gap',reason:e.message});}
    }
    const timeline=ReplayAnimation.compositionTimeline(asset,rates);if(!timeline.known)throw Error(timeline.reason);
    return {kind:'composition',asset,children,timeline,duration:timeline.duration};
  }
  if(asset.metadata_kind==='typed_blendspace_arrays'){
    const children=new Map();
    for(let i=0;i<asset.samples.length;i++){
      try{const next=(await recordFor(ReplayAnimation.referencePath(asset.samples[i].Animation))).asset;children.set(i,await buildScene(next,trail));}
      catch(e){children.set(i,{kind:'gap',reason:e.message});}
    }
    return {kind:'blend',asset,children,duration:1};
  }
  return {kind:'gap',reason:'This asset contains blend metadata; graph inputs are unbound.'};
}
function baseForSequence(current,clock,mode,depth){
  const asset=current.asset;
  if(mode==='rest'||current.referenceType==='ABPT_RefPose')return {known:true,local:current.rig.bones.map(b=>b.rest)};
  if(current.referenceGap)return {known:false,reason:current.referenceGap+'; choose Skeleton rest pose for an explicit test base.'};
  const ref=current.reference;if(!ref)return {known:false,reason:'Additive authoring reference is unbound'};
  const refClock=current.referenceType==='ABPT_AnimScaled'?(current.duration?clock/current.duration*ref.duration:0):
    Math.max(0,Math.min(ref.asset.frames-1,asset.reference_pose.frame_index))*ref.duration/ref.asset.frames;
  return sampleScene(ref,refClock,'asset',depth+1,true);
}
function sampleScene(current,seconds,mode='asset',depth=0,forceDelta){
  if(depth>32)return {known:false,reason:'Animation composition depth limit'};
  if(current.kind==='gap')return {known:false,reason:current.reason};
  if(current.kind==='skeleton')return {known:true,rig:current.rig,world:ReplayAnimation.worldPose(current.rig.bones,current.rig.bones.map(b=>b.rest)),note:'Skeleton rest pose'};
  if(current.kind==='blend'){
    const weights=ReplayAnimation.blendWeights(current.asset,Array.from($('blend-inputs').querySelectorAll('input'),e=>Number(e.value)));
    if(!weights.known)return weights;
    const failure=reason=>({known:false,reason,weights});
    const active=weights.samples.map(s=>({sample:s,child:current.children.get(s.index)}));
    if(active.some(v=>v.child?.kind!=='sequence'))return failure(active.find(v=>v.child?.kind!=='sequence')?.child?.reason||'Blend sample is not a sequence');
    const rig=active[0].child.rig;if(active.some(v=>v.child.rig.object_path!==rig.object_path))return failure('Blend samples use different skeletons');
    const phase=Math.max(0,Math.min(1,seconds)),additive=active[0].child.asset.pose_kind==='raw_additive_delta_tracks';
    if(active.some(v=>(v.child.asset.pose_kind==='raw_additive_delta_tracks')!==additive))return failure('Mixed absolute and additive sample composition is unbound');
    const poses=[];let base=null,type=null,signature=null;
    for(const {sample,child} of active){
      const clock=phase*child.duration;
      const result=additive?ReplayAnimation.sample(child.asset,rig,clock,{assetClock:true,deltaOnly:true}):sampleScene(child,clock,mode,depth+1);
      if(!result.known)return {...result,weights};poses.push(result.local);
      if(additive){
        if(type&&type!==child.asset.additive_type)return failure('Mixed additive spaces are unbound');type=child.asset.additive_type;
        const currentSignature=mode==='rest'?'rest':JSON.stringify(child.asset.reference_pose);
        if(signature&&signature!==currentSignature)return failure('Samples have different authoring bases; choose an explicit Skeleton rest pose base.');signature=currentSignature;
        if(!base){const binding=baseForSequence(child,clock,mode,depth);if(!binding.known)return {...binding,weights};base=binding.local;}
      }
    }
    let local=ReplayAnimation.blendTransforms(poses,weights.samples.map(s=>s.weight));
    if(additive)local=ReplayAnimation.applyAdditive(rig.bones,base,local,type,(forceDelta??$('additive').checked)?1:0);
    return {known:true,local,world:ReplayAnimation.worldPose(rig.bones,local),rig,weights,seconds:phase,
      note:`Stored grid weights · normalized preview phase ${phase.toFixed(3)}${additive?' · '+(mode==='rest'?'explicit skeleton rest base':'stored authoring reference'):''}; native smoothing and synchronization unbound`};
  }
  if(current.kind==='composition'){
    const binding=ReplayAnimation.compositionAt(current.timeline,seconds,{slot:$('slot').value,followSections:$('sections').checked,loop:$('loop').checked});
    if(!binding.known)return binding;
    const child=current.children.get(binding.path);if(!child)return {known:false,reason:'Animation segment is unbound'};
    const result=sampleScene(child,binding.seconds,mode,depth+1);
    return {...result,binding,note:`Slot ${binding.slot} · ${binding.section?'section '+binding.section+' · ':''}${binding.path.split('.').at(-1)} · asset ${binding.seconds.toFixed(3)} s${result.note?' · '+result.note:''}`};
  }
  const asset=current.asset,duration=asset.duration_seconds,clock=duration?Math.min(seconds,duration):0;
  const options={assetClock:true},applyDelta=forceDelta??$('additive').checked;
  if(asset.pose_kind==='raw_additive_delta_tracks'){
    const binding=baseForSequence(current,clock,mode,depth);if(!binding.known)return binding;options.basePose=binding.local;
    options.weight=applyDelta?1:0;
  }
  const result=ReplayAnimation.sample(asset,current.rig,clock,options);
  return {...result,rig:current.rig,note:asset.pose_kind==='raw_additive_delta_tracks'?
    `${asset.additive_type} · ${mode==='rest'?'explicit skeleton rest base':'stored authoring reference'} · ${applyDelta?'delta applied once':'base only'}`:'Decompressed asset tracks'};
}
function configurePlayer(){
  function hasAdditive(s){return s?.asset?.pose_kind==='raw_additive_delta_tracks'||(s?.children&&Array.from(s.children.values()).some(hasAdditive));}
  $('composition-controls').hidden=scene?.kind!=='composition';$('base-controls').hidden=!hasAdditive(scene);
  $('blend-controls').hidden=scene?.kind!=='blend';$('blend-inputs').replaceChildren();$('blend-weights').textContent='';
  if(scene?.kind==='blend'){
    for(const axis of scene.asset.axes.slice(0,scene.asset.export_class.endsWith('1D')?1:2)){
      const label=document.createElement('label'),input=document.createElement('input');label.textContent=axis.DisplayName||'Axis';
      input.type='number';input.min=axis.Min;input.max=axis.Max;input.step='any';input.value=Math.max(axis.Min,Math.min(axis.Max,0));input.setAttribute('aria-label','Blend '+(axis.DisplayName||'axis'));
      input.addEventListener('input',draw);label.append(input);$('blend-inputs').append(label);
    }
  }
  if(scene?.kind==='composition'){
    $('slot').replaceChildren(...scene.timeline.slots.map(s=>{const option=document.createElement('option');option.value=s.name;option.textContent=s.name;return option;}));
    $('section').replaceChildren(...scene.timeline.sections.map(s=>{const option=document.createElement('option');option.value=s.name;option.textContent=s.name;return option;}));
    $('section').disabled=!scene.timeline.sections.length;
  }
  const playable=scene&&['sequence','composition','blend'].includes(scene.kind);$('play').disabled=!playable;$('time').disabled=!playable;
  $('time').max=scene?.duration||1;$('time').value=time;
}
async function select(path){
  const token=++loadId;playing=false;$('play').textContent='Play';selected=assetMap.get(path);scene=null;time=0;configurePlayer();$('references').replaceChildren();$('notify-state').textContent='';$('segment-clock').textContent='';$('name').textContent=path;$('status').textContent='Loading asset…';draw();
  try{
    if(!selected)throw Error('Asset is absent from this decoded catalog');
    if(!Array.from($('assets').options).some(o=>o.value===path)){$('search').value=path.split('.').at(-1);$('kind').value='';list();}$('assets').value=path;
    const url=new URL(location.href);url.searchParams.set('asset',path);history.replaceState(null,'',url);
    const {record,asset}=await recordFor(path);if(token!==loadId)return;
    const {tracks,base_pose,retarget_basis,...metadata}=asset;$('metadata').textContent=JSON.stringify({source:selected,...metadata,errors:record.errors},null,2);references(metadata);
    const result=await buildScene(asset);if(token!==loadId)return;scene=result;configurePlayer();draw();
  }catch(e){if(token===loadId){$('status').textContent=e.message;draw();}}
}
function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#ddd';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,440);ctx.lineTo(canvas.width,440);ctx.stroke();$('clock').textContent=(scene?.kind==='blend'?'phase ':'')+time.toFixed(3)+(scene?.kind==='blend'?'':' s');if(!scene)return;
  let result;try{result=sampleScene(scene,time,$('base').value);}catch(e){result={known:false,reason:e.message};}
  if(result.weights)$('blend-weights').textContent=result.weights.samples.map(s=>s.path.split('.').at(-1)+' '+(s.weight*100).toFixed(1)+'%').join(' · ');
  if(!result.known){$('status').textContent=result.reason;return;}
  const skeleton=result.rig,positions=result.world.map(b=>b.translation),xs=positions.map(p=>p[0]),ys=positions.map(p=>p[1]),zs=positions.map(p=>p[2]);
  $('status').textContent=`${skeleton.bones.length} bones · ${result.note} · asset preview; replay graph activation is unbound.`;
  if(result.binding){$('section').value=result.binding.section||'';$('segment-clock').textContent=`Track ${result.binding.clock.toFixed(3)} s${result.binding.ended?' · ended':''}`;}
  const center=[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2,(Math.min(...zs)+Math.max(...zs))/2];
  const span=Math.max(1,Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),Math.max(...zs)-Math.min(...zs)),scale=350/span*zoom;
  const project=p=>{const x=p[0]-center[0],y=p[1]-center[1],z=p[2]-center[2];return [450+(x*Math.cos(yaw)-y*Math.sin(yaw))*scale,250-z*scale];};
  ctx.strokeStyle='#283e50';ctx.lineWidth=1.8;ctx.beginPath();skeleton.bones.forEach((b,i)=>{if(b.parent<0)return;const a=project(positions[b.parent]),p=project(positions[i]);ctx.moveTo(...a);ctx.lineTo(...p);});ctx.stroke();ctx.fillStyle='#257dac';positions.forEach(p=>{const a=project(p);ctx.beginPath();ctx.arc(...a,2,0,Math.PI*2);ctx.fill();});
  const notifies=scene.asset.Notifies||scene.asset.properties?.Notifies||scene.asset.notifies||[],clock=result.binding?.clock??result.seconds??0;
  $('notify-state').textContent=notifies.flatMap(n=>{try{const start=ReplayAnimation.linkedTime(n);return n.Duration>0&&clock>=start&&clock<start+n.Duration?[String(n.NotifyName)]:[];}catch{return [];}}).join(', ')||'No notify state active';
}
$('search').addEventListener('input',list);$('kind').addEventListener('change',list);$('assets').addEventListener('change',()=>select($('assets').value));
$('time').addEventListener('input',()=>{time=Number($('time').value);draw();});
for(const id of ['loop','sections','slot','base','additive'])$(id).addEventListener('change',draw);
$('section').addEventListener('change',()=>{const section=scene.timeline.sections.find(s=>s.name===$('section').value);if(section){time=section.start;$('sections').checked=false;$('time').value=time;draw();}});
$('play').addEventListener('click',()=>{playing=!playing;$('play').textContent=playing?'Pause':'Play';});$('reset').addEventListener('click',()=>{yaw=-.5;zoom=1;draw();});
canvas.addEventListener('pointerdown',e=>canvas.setPointerCapture(e.pointerId));canvas.addEventListener('pointermove',e=>{if(canvas.hasPointerCapture(e.pointerId)){yaw+=e.movementX*.01;draw();}});
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.25,Math.min(4,zoom*Math.exp(-e.deltaY*.001)));draw();},{passive:false});
function tick(stamp){
  if(playing&&scene){time+=(stamp-last)/1000;
    const follows=scene.kind==='composition'&&$('sections').checked&&scene.timeline.sections.length;
    if(follows){const r=ReplayAnimation.compositionAt(scene.timeline,time,{slot:$('slot').value,followSections:true});if(r.ended||!r.known){playing=false;$('play').textContent='Play';}else $('time').max=Math.max(scene.duration,time+1);}
    else if(time>=scene.duration){if($('loop').checked&&scene.duration>0)time%=scene.duration;else{time=scene.duration;playing=false;$('play').textContent='Play';}}
    $('time').value=time;draw();
  }last=stamp;requestAnimationFrame(tick);
}requestAnimationFrame(tick);
fetch('catalog.json').then(r=>r.json()).then(c=>{
  if(c.typed_blendspaces){
    const gaps=[...c.typed_blendspaces.validation.preview_gaps];
    for(const error of c.typed_blendspaces.errors)for(const item of c.assets.filter(a=>a.package===error.package)){
      item.typed_metadata_gap='Typed blend-space metadata gap: '+error.details.map(d=>d.error).join('; ');gaps.push({object_path:item.object_path,reason:item.typed_metadata_gap});
    }
    $('blend-gaps').hidden=!gaps.length;$('blend-gaps-title').textContent=gaps.length+' blend-space metadata dependencies';
    for(const gap of gaps){const li=document.createElement('li'),button=document.createElement('button');button.textContent=gap.object_path.split('.').at(-1);button.addEventListener('click',()=>select(gap.object_path));li.append(button,document.createTextNode(' · '+gap.reason));$('blend-errors').append(li);}
  }
  catalog=c;assetMap=new Map(c.assets.map(a=>[a.object_path,a]));
  $('coverage').textContent=`${c.processed_packages.toLocaleString()} / ${c.discovered_packages.toLocaleString()} installed packages inspected · ${c.sequence_tracks_decoded.toLocaleString()} sequences decompressed · ${c.validation.absolute_pose_sequences_checked.toLocaleString()} absolute poses${c.raw_additive?' · '+c.raw_additive.validation.explicit_base_pose_sequences_checked.toLocaleString()+' additive poses with an explicit base':''}${c.typed_blendspaces?' · '+c.typed_blendspaces.validation.instantaneous_grid_weight_assets_checked.toLocaleString()+' blend-space grids checked':''} · ${c.export_errors} original decoding gaps.`;
  for(const error of c.errors){const li=document.createElement('li'),a=document.createElement('a');a.href=error.file;a.textContent=error.package;li.append(a,document.createTextNode(' · '+(error.details?.map(d=>d.error).join('; ')||`${error.count} export error(s)`)));$('errors').append(li);}
  $('errors-title').textContent=`${c.export_errors} original decoding gaps`;list();
  const wanted=new URLSearchParams(location.search).get('asset');if(wanted)select(wanted);
}).catch(e=>$('coverage').textContent=e.message);
