'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAnalyzer,summarize,policy}=require('../scripts/replay-estimated-response.js');
const {createPairEvaluator}=require('../scripts/replay-visibility-runtime.js');
const math=require('../scripts/replay-transcription-viewer.js');
const shot=(t,id='s'+t,extra={})=>({subject:'a',time_ms:t,id,round:0,timing_usable:true,weapon_path:'gun',...extra});
const frame=(t,state='hidden',extra={})=>({time_ms:t,observer:'a',round:0,life:0,alive:true,combat:true,complete:true,targets:[{id:'b',state}],...extra});
function feedHidden(a,end=300){for(let t=0;t<=end;t+=50)a.feed(frame(t));}
function run(states,shots=[],enemies=['b']){const a=createAnalyzer('a',enemies,shots);for(const f of states)a.feed(f);return a.result();}

test('first observed discharge after modeled onset carries sampling bounds, hit or miss',()=>{
  const a=createAnalyzer('a',['b'],[shot(425)]);feedHidden(a);a.feed(frame(350,'direct'));a.feed(frame(400,'direct'));a.feed(frame(425,'direct'));
  const r=a.result();assert.equal(r.sample_count,1);assert.equal(r.mean_ms,75);assert.deepEqual(r.samples[0].targets,['b']);
  assert.equal(r.samples[0].response_lower_ms,75);assert.equal(r.samples[0].response_upper_ms,125);
  assert.deepEqual(r.mean_sampling_bounds_ms,[75,125]);
});
test('simultaneous targets and several shots yield one observer encounter, without kill attribution',()=>{
  const a=createAnalyzer('a',['b','c'],[shot(400,'one'),shot(400,'two'),shot(450)]);
  const f=(t,state)=>frame(t,state,{targets:[{id:'b',state},{id:'c',state}]});
  for(let t=0;t<=300;t+=50)a.feed(f(t,'hidden'));a.feed(f(350,'direct'));a.feed(f(400,'direct'));a.feed(f(450,'direct'));
  const r=a.result();assert.equal(r.sample_count,1);assert.deepEqual(r.samples[0].targets,['b','c']);assert.equal(r.samples[0].shot_id,'one');
});
test('unknown or absent enemy inventory invalidates an onset even when another target is modeled visible',()=>{
  const a=createAnalyzer('a',['b','c'],[shot(400)]);
  for(let t=0;t<=300;t+=50)a.feed(frame(t,'hidden',{targets:[{id:'b',state:'hidden'},{id:'c',state:'hidden'}]}));
  a.feed(frame(350,'direct',{targets:[{id:'b',state:'direct'},{id:'c',state:'unknown',reasons:['smoke_activation_or_shader_unverified']}]}));
  a.feed(frame(400,'direct',{targets:[{id:'b',state:'direct'}]}));
  const r=a.result();assert.equal(r.sample_count,0);assert.equal(r.unknown_frame_reasons.smoke_activation_or_shader_unverified,1);
  assert.equal(r.unknown_frame_reasons.enemy_inventory_incomplete,1);
});
test('unknown visibility during a pending response and short effects cancel measurement',()=>{
  const a=createAnalyzer('a',['b'],[shot(400)]);feedHidden(a);a.feed(frame(350,'direct'));a.feed(frame(355,'unknown'));a.feed(frame(360,'direct'));a.feed(frame(400,'direct'));
  const r=a.result();assert.equal(r.sample_count,0);assert.equal(r.excluded_by_reason.unknown_visibility,1);assert.equal(r.excluded_by_reason.onset_not_bracketed,1);
});
test('an existing spray is excluded; a shot exactly on the onset frame has a zero sampling lower bound',()=>{
  const a=createAnalyzer('a',['b'],[shot(300),shot(400)]);feedHidden(a);a.feed(frame(350,'direct'));a.feed(frame(400,'direct'));
  assert.equal(a.result().excluded_by_reason.already_firing,1);
  const b=createAnalyzer('a',['b'],[shot(350)]);feedHidden(b);b.feed(frame(350,'direct'));
  assert.equal(b.result().samples[0].response_lower_ms,0);
});
test('visible stream starts do not invent a reaction; unknown and gaps cannot be interpolated',()=>{
  assert.equal(run([frame(0,'direct'),frame(50,'direct')],[shot(50)]).excluded_by_reason.onset_not_bracketed,1);
  const a=createAnalyzer('a',['b'],[shot(500)]);feedHidden(a);a.feed(frame(350,'direct'));a.feed(frame(500,'direct'));
  const r=a.result();assert.equal(r.sample_count,0);assert.equal(r.excluded_by_reason.sample_gap,1);
});
test('a missing exact shot frame cannot borrow a later visibility sample',()=>{
  const a=createAnalyzer('a',['b'],[shot(375)]);feedHidden(a);a.feed(frame(350,'direct'));a.feed(frame(400,'direct'));
  assert.equal(a.result().excluded_by_reason.shot_frame_missing,1);
});
test('loss of the onset targets is retained as nonresponse and never transferred to a new target',()=>{
  const a=createAnalyzer('a',['b','c'],[shot(400)]);
  const f=(t,b,c)=>frame(t,b,{targets:[{id:'b',state:b},{id:'c',state:c}]});
  for(let t=0;t<=300;t+=50)a.feed(f(t,'hidden','hidden'));a.feed(f(350,'direct','hidden'));a.feed(f(400,'hidden','direct'));
  assert.equal(a.result().excluded_by_reason.onset_targets_lost,1);
});
test('no-shot, timeout, death and resurrection boundaries are retained outside the average',()=>{
  const a=createAnalyzer('a',['b'],[]);feedHidden(a);for(let t=350;t<=2400;t+=50)a.feed(frame(t,'direct'));
  assert.equal(a.result().excluded_by_reason.response_timeout,1);
  const b=createAnalyzer('a',['b'],[shot(400)]);feedHidden(b);b.feed(frame(350,'direct'));b.feed(frame(375,'hidden',{alive:false}));b.feed(frame(400,'direct',{life:1}));
  const r=b.result();assert.equal(r.sample_count,0);assert.equal(r.excluded_by_reason.observer_inactive,1);
});
test('rearming requires continuously known hidden history and excludes brief repeeks',()=>{
  const a=createAnalyzer('a',['b'],[shot(350),shot(450)]);feedHidden(a);a.feed(frame(350,'direct'));a.feed(frame(400,'hidden'));a.feed(frame(450,'direct'));
  assert.equal(a.result().sample_count,1);
});
test('means pool encounters and empty populations are null, with time-based coverage',()=>{
  const r=summarize([{status:'estimated',response_ms:20,response_lower_ms:20,response_upper_ms:70},{status:'estimated',response_ms:80,response_lower_ms:80,response_upper_ms:100},{status:'response_timeout'}]);
  assert.equal(r.mean_ms,50);assert.equal(r.median_ms,50);assert.equal(summarize([]).mean_ms,null);
  const s=run([frame(0),frame(25),frame(50,'unknown'),frame(100)]);
  assert.equal(s.coverage.known_duration_ms,25);assert.equal(s.coverage.eligible_duration_ms,100);
});
test('invalid policy, duplicated shots, reversed clocks and unexpected targets fail closed',()=>{
  assert.throws(()=>policy({sample_ms:0}));assert.throws(()=>policy({invented:1}));
  assert.throws(()=>createAnalyzer('a',['b'],[shot(1,'same'),shot(2,'same')]));
  const a=createAnalyzer('a',['b'],[]);a.feed(frame(50));assert.throws(()=>a.feed(frame(40)));
  assert.throws(()=>run([frame(0,'hidden',{targets:[{id:'c',state:'hidden'}]})]));
});
test('silhouette-grid side exposure changes the estimate while native visibility stays unknown',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,0,0]]},
    projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const mesh={nodes:1,bounds:new Float32Array([50,-2,-100,50,2,100]),links:new Int32Array([-1,-1,0,2]),
    vertices:new Float32Array([50,-2,-100,50,2,-100,50,2,100,50,-2,-100,50,2,100,50,-2,100])};
  const f=(subject,t,r)=>({known:true,subject,time_ms:t,round:r.index,camera:{fov:90},vision:[]});
  const pair=createPairEvaluator(data,mesh,math,f),r={index:0,start_ms:0,end_ms:1000};
  assert.equal(pair('a','b',0,r).contact.state,'hidden');
  const wide=pair('a','b',0,r,{body_half_width_cm:21,skip_offscreen_rays:true});
  assert.equal(wide.contact.state,'direct');assert.equal(wide.contact.points.length,9);assert.equal(wide.visibility.state,'unknown');
  assert.equal(wide.pose_assessment.target.native_skeletal_pose_verified,false);
  assert.throws(()=>pair('a','b',0,r,{body_half_width_cm:-1}));
});
test('early-exit occlusion agrees with nearest-hit clearance and optimized offscreen states',()=>{
  const mesh={nodes:1,bounds:new Float32Array([25,-100,-100,75,100,100]),links:new Int32Array([-1,-1,0,2]),
    vertices:new Float32Array([75,-100,-100,75,100,-100,75,0,100,25,-100,-100,25,100,-100,25,0,100])};
  for(const [a,b] of [[[0,0,0],[100,0,0]],[[0,0,300],[100,0,300]],[[100,0,0],[0,0,0]],[[0,200,0],[100,200,0]]]){
    assert.equal(Boolean(math.rayHit(mesh,a,b,true)),Boolean(math.rayHit(mesh,a,b)));
  }
  assert.deepEqual(math.rayHit(mesh,[0,0,0],[100,0,0]),[25,0,0]);
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],tracks:{a:[[0,0,0,0,180,0]],b:[[0,100,0,0,0,0]]},
    projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  for(const vision of [[],[{id:'flash',subject:'a',round:0,kind:'flash',start_ms:0,end_ms:100}]]){
    const f=(subject,t,r)=>({known:true,subject,time_ms:t,round:r.index,camera:{fov:90},vision:subject==='a'?vision:[]}),r={index:0,start_ms:0,end_ms:1000};
    const pair=createPairEvaluator(data,mesh,math,f);
    assert.equal(pair('a','b',0,r,{body_half_width_cm:21,skip_offscreen_rays:true}).contact.state,pair('a','b',0,r,{body_half_width_cm:21}).contact.state);
  }
});
