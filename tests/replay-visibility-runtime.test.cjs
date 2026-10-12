const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluate,intervals,createPairEvaluator,dataWithInputs,segmentIntersectsBounds,dynamicDependencies,abilityDependencies,cameraDependencies,smokeDependencies,dependencyTimes}=require('../scripts/replay-visibility-runtime.js');
const math=require('../scripts/replay-transcription-viewer.js');
const point=(extra={})=>({in_view:true,wall_clear:true,smoke_clear:true,reveal:false,...extra});
const input=(extra={})=>({enemy:true,observer_alive:true,target_alive:true,vision:'clear',perceptible:true,
  evidence:{camera:true,body:true,build:true,effect_coverage:true},points:[point()],...extra});
const sample=(t,state,extra={})=>({time_ms:t,state,observer:'a',target:'b',round:0,life:'a0:b0',...extra});

test('one body point must pass view, wall and smoke together',()=>{
  assert.equal(evaluate(input({points:[point({in_view:false}),point({wall_clear:false})]})).state,'hidden');
  assert.equal(evaluate(input({points:[point({wall_clear:false}),point({smoke_clear:false})]})).state,'hidden');
  assert.equal(evaluate(input({points:[point({wall_clear:false}),point()]})).state,'direct');
  assert.deepEqual(evaluate(input({points:[point({wall_clear:false})]})).reasons,['wall']);
});
test('one-way visibility and revealed outlines require the observer view',()=>{
  assert.equal(evaluate(input({points:[point({wall_clear:false,smoke_clear:false,reveal:true})]})).state,'reveal');
  assert.equal(evaluate(input({points:[point({in_view:false,wall_clear:false,reveal:true})]})).state,'hidden');
  assert.equal(evaluate(input({points:[point({in_view:false})]})).state,'hidden');
});
test('unknown camera, body, version and coverage never become certified contacts',()=>{
  for(const field of ['camera','body','build','effect_coverage']){
    for(const p of [point(),point({wall_clear:false})]){
      const source=input();source.evidence[field]=false;source.points=[p];assert.equal(evaluate(source).state,'unknown');
    }
  }
  assert.equal(evaluate(input({points:[]})).state,'unknown');
});
test('partial flash, nearsight and unresolved smoke interiors remain unknown',()=>{
  assert.equal(evaluate(input({vision:'unknown'})).state,'unknown');
  assert.equal(evaluate(input({vision:'blocked'})).state,'hidden');
  assert.equal(evaluate(input({perceptible:null})).state,'unknown');
  assert.equal(evaluate(input({perceptible:false})).state,'hidden');
  assert.equal(evaluate(input({points:[point({smoke_clear:null})]})).state,'unknown');
  assert.equal(evaluate(input({points:[point({wall_clear:false,smoke_clear:null})]})).state,'hidden');
  assert.equal(evaluate(input({points:[point({wall_clear:false,reveal:null})]})).state,'unknown');
});
test('an unresolved point does not suppress a separate fully verified visible point',()=>{
  assert.equal(evaluate(input({points:[point({wall_clear:null}),point()]})).state,'direct');
  assert.equal(evaluate(input({points:[point({wall_clear:null})]})).state,'unknown');
});
test('contacts bracket acquisition and loss without reaction-time rearming',()=>{
  const report=intervals([sample(0,'hidden'),sample(8,'direct'),sample(16,'reveal'),sample(24,'hidden'),sample(32,'direct')]);
  assert.equal(report.contacts.length,2);
  assert.deepEqual(report.contacts[0].acquisition_bounds_ms,[0,8]);
  assert.deepEqual(report.contacts[0].loss_bounds_ms,[16,24]);
  assert.deepEqual(report.contacts[0].modes,['direct','reveal']);
  assert.deepEqual(report.contacts[1].acquisition_bounds_ms,[24,32]);
  assert.equal(report.contacts[1].loss_bounds_ms,null);
});
test('unknown intervals and gaps terminate contacts without fabricated onset or loss',()=>{
  const report=intervals([sample(0,'hidden'),sample(50,'direct'),sample(60,'unknown'),sample(70,'direct'),sample(200,'direct'),sample(210,'hidden')]);
  assert.equal(report.contacts.length,3);
  assert.equal(report.contacts[0].end_reason,'unknown');assert.equal(report.contacts[0].loss_bounds_ms,null);
  assert.equal(report.contacts[1].acquisition_bounds_ms,null);assert.equal(report.contacts[1].start_reason,'after_unknown');
  assert.equal(report.contacts[1].end_reason,'sample_gap');assert.equal(report.contacts[2].start_reason,'after_gap');
  assert.equal(report.transitions.some(t=>t.bounds_ms[0]===70&&t.bounds_ms[1]===200),false);
});
test('already visible window starts and round/life changes cannot invent an acquisition',()=>{
  const report=intervals([sample(10,'direct'),sample(20,'direct',{round:1}),sample(30,'direct',{round:1,life:'a1:b0'})]);
  assert.equal(report.contacts.length,3);assert.ok(report.contacts.every(c=>c.acquisition_bounds_ms===null));
  assert.equal(report.contacts[0].start_reason,'visible_at_window_start');
  assert.equal(report.contacts[0].end_reason,'context_changed');
});
test('short observed impairment boundaries split an otherwise visible contact',()=>{
  const report=intervals([sample(0,'hidden'),sample(50,'direct'),sample(55,'unknown'),sample(60,'direct'),sample(100,'direct')]);
  assert.equal(report.contacts.length,2);assert.equal(report.contacts[1].acquisition_bounds_ms,null);
  assert.equal(report.unknown_samples,1);
});
test('invalid clocks and mixed pairs fail instead of corrupting the timeline',()=>{
  assert.throws(()=>intervals([sample(10,'hidden'),sample(10,'direct')]),/strictly increasing/);
  assert.throws(()=>intervals([sample(10,'direct'),sample(20,'direct',{observer:'b',target:'a'})]),/Mixed/);
  assert.throws(()=>intervals([sample(10,'direct',{life:null})]),/identity/);
  assert.throws(()=>intervals([sample(10,'invented')]),/state/);
});
test('shared replay evaluator cannot combine an off-screen clear ray with an on-screen blocked ray',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,0,0]]},projection:{eye_height_cm:0,body_offsets_cm:[-600,0,600],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const mesh={nodes:1,bounds:new Float32Array([50,-100,-10,50,100,10]),links:new Int32Array([-1,-1,0,1]),vertices:new Float32Array([50,-100,-10,50,100,-10,50,0,10])};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:[]});
  const pair=createPairEvaluator(data,mesh,math,frame),round={index:0,start_ms:0,end_ms:1000};
  const result=pair('a','b',0,round);
  assert.equal(result.contact.state,'hidden');assert.equal(result.state,1);
  assert.deepEqual(result.contact.points.map(p=>[p.in_view,p.wall_clear]),[[false,true],[true,false],[false,true]]);
  assert.equal(result.visibility.state,'unknown');
  assert.equal(pair('a','b',51,round).contact.state,'unknown');
});
test('pair reconstruction is seek-independent and visual overlay settings cannot clear a flash',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0],[8,0,0,0,180,0]],b:[[0,100,0,0,0,0],[8,100,0,0,0,0]]},
    projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:t>=5&&t<7?[{id:'flash',subject,round:round.index,kind:'flash',start_ms:5,end_ms:7}]:[]});
  const pair=createPairEvaluator(data,{nodes:0},math,frame),round={index:0,start_ms:0,end_ms:100};
  assert.equal(pair('a','b',0,round).contact.state,'direct');
  assert.equal(pair('a','b',5,round,{vision:false}).contact.state,'unknown');
  assert.equal(pair('a','b',7,round).contact.state,'direct');
  assert.equal(pair('a','b',8,round).contact.state,'hidden');
  assert.equal(pair('a','b',0,round).contact.state,'direct');
});
test('remote possession interrupts modeled contact only for the observed owner round and interval',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,180,0]]},projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:[]});
  const inputs={camera_body:{remote_viewpoint_intervals:[{subject:'a',round:0,start_ms:5,end_ms:20,actor_net_guid:3872,native_camera_switch_verified:false}]}};
  const pair=createPairEvaluator(data,{nodes:0},math,frame,inputs),round={index:0,start_ms:0,end_ms:100};
  assert.equal(pair('a','b',4,round).contact.state,'direct');
  assert.equal(pair('a','b',5,round).contact.state,'unknown');
  assert.ok(pair('a','b',5,round).contact.reasons.includes('remote_viewpoint_dependency_observed'));
  assert.equal(pair('b','a',5,round).contact.state,'direct');
  assert.equal(pair('a','b',20,round).contact.state,'direct');
  assert.equal(pair('a','b',4,round).contact.state,'direct');
});
test('current camera dependencies exclude future stops, owner updates and channel closes',()=>{
  const interval={id:'camera',subject:'a',round:0,start_ms:5,end_ms:20,start_observation:{time_ms:5},
    stop_observation:{time_ms:20},stop_observed_ms:20,end_reason:'observed_possession_false',
    ownership_evidence:[{time_ms:5},{controller_reference:{time_ms:5},controller_player_state:{time_ms:15}}],
    additional_start_observations:[{time_ms:5},{time_ms:10}],actor_channel_close_observations:[{time_ms:19}]};
  const round={index:0,start_ms:0,end_ms:100},sidecar={remote_viewpoint_intervals:[interval]},before=JSON.stringify(sidecar);
  const [row]=cameraDependencies(sidecar,'a',5,round);
  assert.equal(row.evidence_cap_ms,100);
  assert.equal(row.end_ms,undefined);assert.equal(row.stop_observation,undefined);assert.equal(row.end_reason,undefined);
  assert.deepEqual(row.additional_start_observations,[{time_ms:5}]);assert.deepEqual(row.actor_channel_close_observations,[]);
  assert.equal(row.ownership_evidence[1].controller_player_state,undefined);
  assert.equal(cameraDependencies(sidecar,'a',20,round).length,0);
  assert.equal(cameraDependencies(sidecar,'b',5,round).length,0);
  assert.equal(JSON.stringify(sidecar),before);
});
test('pose report identifies the same estimated eye and body points actually used by each ray',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,180,0]]},projection:{eye_height_cm:3,body_offsets_cm:[-10,0,10],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90,kind:'fixture estimate'},vision:[]});
  const pair=createPairEvaluator(data,{nodes:0},math,frame),round={index:0,start_ms:0,end_ms:100};
  const result=pair('a','b',0,round),pose=result.pose_assessment;
  assert.deepEqual(pose.observer.model_eye_cm,[0,0,3]);assert.equal(pose.observer.model_fov_deg,90);
  assert.deepEqual(pose.target.model_body_points_cm,result.contact.points.map(p=>p.position));
  assert.equal(pose.target.native_skeletal_pose_verified,false);assert.equal(pose.observer.native_camera_transform_verified,false);
  assert.equal(result.visibility.state,'unknown');
});
const smokeFixture=()=>({id:'smoke',actor_net_guid:8,profile:'p',round:0,channel_open_ms:5,channel_close_ms:25,
  start_ms:5,end_ms:25,positions:[[5,50,0,0],[30,50,50,0]],activation_clock_verified:false,native_visual_opacity_verified:false,
  intro_loop_observations:[{start_ms:10,start_packet_id:1,effect_class:'intro',end_ms:25,stop_packet_id:2}]});
const smokeProfiles=()=>({p:{radius_cm:10,delay_ms:5,expand_ms:5,duration_ms:15,contract_ms:5,
  expand_curve:{keys:[[0,0,0,0,0],[1,1,0,0,0]]},contract_curve:{keys:[[0,1,0,0,0],[1,0,0,0,0]]}}});
test('unverified smoke timing retains a per-ray dependency before growth and after modeled extinction',()=>{
  const smoke=smokeFixture(),round={index:0,start_ms:0,end_ms:100},a=[0,0,0],b=[100,0,0],profiles=smokeProfiles();
  const deps=t=>smokeDependencies([smoke],profiles,a,b,t,round,math);
  assert.equal(deps(4).length,0);assert.equal(deps(5).length,1);assert.equal(deps(26).length,1);
  assert.equal(deps(5)[0].model_active,true);assert.equal(deps(26)[0].model_active,false);
  assert.equal(deps(5)[0].channel_close_observed_ms,undefined);assert.equal(deps(26)[0].channel_close_observed_ms,25);
  assert.deepEqual(deps(5)[0].intro_loop_observations,[]);assert.equal(deps(26)[0].intro_loop_observations[0].end_ms,undefined);
  assert.equal(deps(30).length,0); // later recorded center is outside this display-model ray
  assert.equal(deps(100).length,0);
  assert.equal(smokeDependencies([smoke],profiles,[0,20,0],[100,20,0],5,round,math).length,0);
});
test('smoke uncertainty breaks modeled contacts while leaving independent clear rays usable',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,180,0]]},projection:{eye_height_cm:0,body_offsets_cm:[-2,0,2],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},
    asset_state:{model:{smoke_profiles:smokeProfiles(),shell_meshes:{}},smokes:[smokeFixture()]}};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:[]});
  const pair=createPairEvaluator(data,{nodes:0},math,frame),round={index:0,start_ms:0,end_ms:100};
  const before=pair('a','b',4,round,{crouch:false}),early=pair('a','b',5,round,{crouch:false}),after=pair('a','b',26,round,{crouch:false});
  assert.equal(before.contact.state,'direct');assert.equal(early.contact.state,'unknown');assert.equal(after.contact.state,'unknown');
  assert.equal(early.smokes.length,0);assert.equal(after.smokes.length,0);
  assert.equal(early.smoke_dependencies.length,1);assert.equal(after.smoke_dependencies.length,1);
  assert.ok(after.contact.reasons.includes('smoke_activation_or_shader_unverified'));
  data.projection.body_offsets_cm=[-40,0,40];
  const clear=createPairEvaluator(data,{nodes:0},math,frame)('a','b',5,round,{crouch:false});
  assert.equal(clear.contact.state,'direct');assert.deepEqual(clear.contact.points.map(p=>p.smoke_clear),[true,null,true]);
  assert.equal(clear.visibility.state,'unknown');
});
test('additional opaque static layer participates in the same body ray and nearest hit',()=>{
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,180,0]]},projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const wall=x=>({nodes:1,bounds:new Float32Array([x,-100,-100,x,100,100]),links:new Int32Array([-1,-1,0,1]),vertices:new Float32Array([x,-100,-100,x,100,-100,x,0,100])});
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:[]}),round={index:0,start_ms:0,end_ms:100};
  assert.equal(createPairEvaluator(data,{nodes:0},math,frame)('a','b',0,round).contact.state,'direct');
  const result=createPairEvaluator(data,wall(70),math,frame,{overlay_meshes:[wall(50)]})('a','b',0,round);
  assert.equal(result.contact.state,'hidden');assert.equal(result.hit[0],50);
  assert.equal(result.visibility.state,'unknown');
});
test('smoke additions stay separate from canonical replay and reject conflicting identity',()=>{
  const data={asset_state:{model:{smoke_profiles:{old:{radius_cm:1}},shell_meshes:{mesh:{vertices:[[1,2,3]]}}},smokes:[{id:'old',profile:'old'}]}};
  const before=JSON.stringify(data),addon={smoke_model:{smoke_profiles:{new:{radius_cm:2}},shell_meshes:{mesh:{vertices:[[1,2,3]]}}},smoke_instances:[{id:'new',profile:'new'}]};
  const merged=dataWithInputs(data,addon);
  assert.equal(merged.asset_state.smokes.length,2);
  assert.equal(merged.asset_state.model.smoke_profiles.new.radius_cm,2);
  assert.equal(JSON.stringify(data),before);
  assert.throws(()=>dataWithInputs(data,{smoke_model:{smoke_profiles:{old:{radius_cm:2}}}}),/duplicates/);
  assert.throws(()=>dataWithInputs(data,{smoke_model:{shell_meshes:{mesh:{vertices:[]}}}}),/differs/);
  assert.throws(()=>dataWithInputs(data,{...addon,smoke_instances:[{id:'old',profile:'new'}]}),/identity/);
});
const dynamic=()=>({instances:[{id:'door',actor_net_guid:10,bounds_cm:[[40,-5,null],[60,5,null]],
  rounds:[{round:0,start_ms:0,end_ms:100},{round:1,start_ms:100,end_ms:200}],
  network_epochs:[{start_ms:0,end_ms:30,start_packet_id:1},{start_ms:40,end_ms:200,start_packet_id:4}],
  observations:[{round:0,time_ms:10,field_name:'DoorState',value:0,status:'decoded',epoch_start_packet_id:1},
    {round:0,time_ms:15,field_name:'bHidden',value:true,status:'decoded',epoch_start_packet_id:1},
    {round:0,time_ms:50,field_name:'bHidden',value:true,status:'decoded',epoch_start_packet_id:4}]}]});
test('moving-map bounds support unbounded height and enforce round and channel epochs',()=>{
  const sidecar=dynamic(),a=[0,0,1e8],b=[100,0,1e8];
  assert.equal(segmentIntersectsBounds(a,b,sidecar.instances[0].bounds_cm),true);
  assert.equal(segmentIntersectsBounds([0,6,0],[100,6,0],sidecar.instances[0].bounds_cm),false);
  assert.equal(dynamicDependencies(sidecar,a,b,10,0).length,1); // desired open state is not achieved geometry
  assert.equal(dynamicDependencies(sidecar,a,b,14,0).length,1); // future hidden observation cannot clear it
  assert.equal(dynamicDependencies(sidecar,a,b,15,0).length,0);
  assert.equal(dynamicDependencies(sidecar,a,b,30,0).length,1); // closed channel is not invisible geometry
  assert.equal(dynamicDependencies(sidecar,a,b,40,0).length,1); // reopen cannot reuse prior bHidden
  assert.equal(dynamicDependencies(sidecar,a,b,50,0).length,0);
  assert.equal(dynamicDependencies(sidecar,a,b,100,1).length,1); // new round cannot reuse it either
  assert.throws(()=>dynamicDependencies(sidecar,a,b,100,0),/round/);
  assert.throws(()=>segmentIntersectsBounds(a,b,[[0,0,null],[1,1,10]]),/bounds/);
});
test('dynamic uncertainty applies to each body ray and leaves a separate clear ray usable',()=>{
  assert.equal(evaluate(input({points:[point({dynamic_clear:null})]})).state,'unknown');
  assert.equal(evaluate(input({points:[point({dynamic_clear:null}),point()]})).state,'direct');
  assert.equal(evaluate(input({points:[point({wall_clear:false,dynamic_clear:null})]})).state,'hidden');
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,180,0]]},projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:[]}),round={index:0,start_ms:0,end_ms:100};
  const sidecar=dynamic(),pair=createPairEvaluator(data,{nodes:0},math,frame,{dynamic_occluders:sidecar});
  assert.equal(pair('a','b',10,round).contact.state,'unknown');
  assert.equal(pair('a','b',15,round).contact.state,'direct');
  sidecar.instances[0].bounds_cm=[[40,-5,-1],[60,5,1]];
  assert.equal(pair('a','b',10,round).contact.state,'direct');
  assert.deepEqual(pair('a','b',10,round).contact.points.map(p=>p.dynamic_clear),[true,null,true]);
});
test('potential ability walls persist to knowledge cap and never expose future observations',()=>{
  const sidecar={instances:[{id:'viper',kind:'viper_wall',actor_net_guid:1,round:0,start_ms:10,end_ms:100,
    start_observation:{time_ms:10},world_bounds_cm:null,observed_flag_end_ms:30,deactivation_observation:{time_ms:30},
    anchor_observations:[{time_ms:5}],later_anchor_observations:[{time_ms:20}],channel_close_observations:[{time_ms:40}]},
    {id:'vyse',kind:'vyse_wall',actor_net_guid:2,round:0,start_ms:10,end_ms:100,initialization_observed_ms:10,
      start_observation:{time_ms:10},collision_enable_observed_ms:25,collision_enable_observation:{time_ms:25}}]};
  assert.equal(abilityDependencies(sidecar,9,0).length,0);
  const before=abilityDependencies(sidecar,10,0);
  assert.equal(before[0].anchor_observations.length,1);
  assert.equal(before[0].observed_flag_end_ms,undefined);
  assert.equal(before[0].channel_close_observations.length,0);
  assert.equal(before[1].collision_enable_observation,undefined);
  assert.equal(abilityDependencies(sidecar,40,0)[0].deactivation_observation.time_ms,30);
  assert.equal(abilityDependencies(sidecar,99,0).length,2);
  assert.equal(abilityDependencies(sidecar,100,0).length,0);
  assert.equal(abilityDependencies(sidecar,15,1).length,0);
  assert.ok(dependencyTimes({ability_occluders:sidecar,dynamic_occluders:dynamic()}).includes(25));
  const data={players:[{subject:'a',team:'Red'},{subject:'b',team:'Blue'}],kills:[],
    tracks:{a:[[0,0,0,0,0,0]],b:[[0,100,0,0,180,0]]},projection:{eye_height_cm:0,body_offsets_cm:[-10,0,10],aspect:1},
    geometry:{bounds_cm:[[-1000,-1000,-1000],[1000,1000,1000]],asset_provenance:{}},asset_state:{}};
  const frame=(subject,t,round)=>({known:true,subject,time_ms:t,round:round.index,camera:{fov:90},vision:[]}),round={index:0,start_ms:0,end_ms:100};
  const pair=createPairEvaluator(data,{nodes:0},math,frame,{ability_occluders:sidecar});
  assert.equal(pair('a','b',9,round).contact.state,'direct');
  assert.equal(pair('a','b',10,round).contact.state,'unknown');
  assert.ok(pair('a','b',10,round).contact.reasons.includes('ability_occluder_geometry_unknown'));
  assert.equal(pair('a','b',40,round).contact.state,'unknown');
  assert.equal(pair('a','b',10,round).ability_dependencies[0].channel_close_observations.length,0);
});
