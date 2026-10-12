const test=require('node:test');
const assert=require('node:assert/strict');
const {assess,createAssessor}=require('../scripts/replay-visibility-effects.js');
const frame=(extra={})=>({known:true,time_ms:100,round:0,subject:'a',vision:[],effects:[],blind:{},...extra});
const array=(extra={})=>({kind:'blind_array_observed',time_ms:50,packet_id:1,round:0,subject:'a',actor_net_guid:10,
  component_net_guid:11,status:'decoded',complete_membership:true,declared_length:0,members:[],...extra});
const duration=(extra={})=>({kind:'blind_duration_scalar_observed',time_ms:50,packet_id:1,round:0,subject:'a',
  actor_net_guid:10,component_net_guid:11,duration_seconds:1.5,...extra});
const effect=(extra={})=>({id:'fx',subject:'a',round:0,actor_net_guid:10,component_net_guid:12,profile:'flash',kind:'flash',
  start_ms:50,end_ms:200,end_reason:'observed_stop_rpc',stop_packet_id:9,...extra});
const model={mapping_sha256:'mapping',archives:{a:{sha256:'archive',bytes:7}},vision_profiles:{flash:{kind:'flash'},near:{kind:'nearsight'}}};
const run=(rows,vision=[],continuous=[])=>createAssessor({asset_state:{model,vision_effects:vision,
  observations:{blind_observations:rows,continuous_effects:continuous}}});

test('absence and explicit empty membership never certify clear visual perception',()=>{
  for(const blind of [{},{array_observation:array()},{duration_observation:duration({duration_seconds:0})}]){
    const result=assess(frame({blind}),model);
    assert.equal(result.candidate_vision,'clear');assert.equal(result.vision,'unknown');
    assert.equal(result.effect_coverage_verified,false);assert.equal(result.native_perceptibility_verified,false);
    assert.ok(result.reasons.includes('impairment_coverage_unverified'));
  }
});
test('proven material operands expose missing native inputs without inventing opacity or clock binding',()=>{
  const bindings={kind:'source_pinned_native_visibility_bindings',mapping_sha256:model.mapping_sha256,archives:model.archives,
    flash_material:{parameter_name:'Alpha_ColorMult',fade_parameter_expression:'float32((end-engineTime)/fadeTime)',
      fade_end_expression:'engineTime+(fadeTime-nativeElapsed)',serialized_timer_period_seconds:.01,proof_sha256:'proof',
      required_runtime_inputs:['BlindManagerComponent.IsBlinded','BlindManagerComponent.GetTimeSinceLastBlindedChange','GameplayStatics.GetTimeSeconds']}};
  const result=assess(frame({vision:[effect()]}),model,{native_bindings:bindings,native_bindings_sha256:'source'});
  assert.equal(result.flash_material_assessment.parameter_name,'Alpha_ColorMult');
  assert.equal(result.flash_material_assessment.parameter_value,null);
  assert.equal(result.flash_material_assessment.native_clock_binding_verified,false);
  assert.equal(result.flash_material_assessment.shader_opacity_verified,false);
  assert.equal(result.vision,'unknown');
  assert.equal(assess(frame(),model,{native_bindings:{...bindings,mapping_sha256:'wrong'}}).flash_material_assessment,null);
  assert.equal(assess(frame(),model,{native_bindings:{...bindings,archives:{}}}).flash_material_assessment,null);
});
test('typed blind membership survives absent modeled effect and does not invent opacity or duration',()=>{
  const member={EffectID:7,SourceID:'server',InitialDuration:0,StartNetMovementTime:4,config_path:'unmapped'};
  const result=run([array({declared_length:1,members:[member]})])(frame());
  assert.equal(result.candidate_vision,'unknown');assert.equal(result.positive_impairment_observed,true);
  assert.ok(result.candidate_reasons.includes('observed_native_blind_membership'));
  assert.equal(result.vision,'unknown');assert.equal('blocked' in result,false);
  assert.deepEqual(result.evidence[0].members[0],{effect_id:7,source_id:'server',config_path:'unmapped',
    reported_initial_duration_seconds:0,start_movement_time_s:4});
});
test('newer same-manager empty array supersedes historical scalar without fabricating clearance',()=>{
  const observer=run([duration(),array({time_ms:70,packet_id:2})]);
  assert.equal(observer(frame({time_ms:60})).candidate_vision,'unknown');
  const result=observer(frame());assert.equal(result.candidate_vision,'clear');assert.equal(result.vision,'unknown');
  assert.ok(result.evidence.some(e=>e.reason==='historical_positive_blind_duration'));
  assert.equal(result.positive_impairment_observed,false);
});
test('same-time packet order and round subject actor component boundaries remain separate',()=>{
  const rows=[duration({packet_id:3}),array({packet_id:2}),
    array({actor_net_guid:20,component_net_guid:11,time_ms:70}),array({component_net_guid:21,time_ms:80}),
    array({subject:'b',time_ms:90}),array({round:1,time_ms:90})];
  assert.ok(run(rows)(frame()).candidate_reasons.includes('positive_blind_duration_currentness_unverified'));
  assert.equal(run([duration({packet_id:2}),array({packet_id:3})])(frame()).candidate_vision,'clear');
});
test('multiple observed managers cannot erase each other and reverse seeks do not leak',()=>{
  const observer=run([array({declared_length:1,members:[{EffectID:7,SourceID:1}]}),
    array({component_net_guid:21,time_ms:80}),array({time_ms:120,packet_id:4})]);
  assert.equal(observer(frame()).candidate_vision,'unknown');
  assert.equal(observer(frame({time_ms:130})).candidate_vision,'clear');
  assert.equal(observer(frame({time_ms:100})).candidate_vision,'unknown');
  assert.equal(observer(frame({time_ms:40})).candidate_vision,'clear');
});
test('unresolved array loses knowledge and never reuses old members',()=>{
  const observer=run([array({declared_length:1,members:[{EffectID:7,SourceID:1}]}),
    array({time_ms:80,status:'unresolved',complete_membership:false,reason:'unmeasured delta'})]);
  const result=observer(frame());assert.equal(result.positive_impairment_observed,false);
  assert.deepEqual(result.candidate_reasons,['blind_membership_unresolved']);
});
test('only exact joined observed stop can supersede scalar guidance',()=>{
  for(const component of [11,21]){
    const fx=effect({end_ms:70,native_blind:{actor_net_guid:10,component_net_guid:component}});
    const result=run([duration()],[fx])(frame());
    assert.equal(result.candidate_vision,component===11?'clear':'unknown');
    assert.equal(result.positive_impairment_observed,false);
    assert.ok(result.evidence.some(e=>e.reason==='visual_tail_rule_unbound'));
  }
  assert.equal(run([duration()],[effect({end_ms:70,end_reason:'round_boundary_no_stop_observed',
    native_blind:{actor_net_guid:10,component_net_guid:11}})])(frame()).candidate_vision,'unknown');
});
test('overlapping recipient effects stay independent and partial flash never becomes binary blocked',()=>{
  const observer=run([],[effect(),effect({id:'near',profile:'near',kind:'nearsight',end_ms:300})]);
  assert.deepEqual(observer(frame()).candidate_reasons,['observed_flash_effect','observed_nearsight_effect']);
  assert.deepEqual(observer(frame({time_ms:250})).candidate_reasons,['observed_nearsight_effect']);
});
test('positive frame-only effects and manager observations survive absent indexed histories',()=>{
  const observer=createAssessor({asset_state:{model}});
  assert.deepEqual(observer(frame({vision:[effect()]})).candidate_reasons,['observed_flash_effect']);
  assert.deepEqual(observer(frame({effects:[effect({profile:null,effect_class:'near',kind:null})]})).candidate_reasons,['observed_nearsight_effect']);
  assert.ok(observer(frame({blind:{array_observation:array({declared_length:1,members:[{EffectID:7,SourceID:1}]})}}))
    .candidate_reasons.includes('observed_native_blind_membership'));
  const duplicate=run([],[effect()])(frame({vision:[effect()]}));
  assert.equal(duplicate.evidence.filter(e=>e.reason==='observed_flash_effect').length,1);
  assert.equal(observer(frame({vision:[effect({subject:'b'})]})).candidate_vision,'clear');
  assert.deepEqual(observer(frame({vision:[effect({kind:'unmapped',profile:'unmapped'})]})).candidate_reasons,
    ['observed_unmodeled_vision_effect']);
});
test('a descendant of separate nearsight root remains impairment even absent a vision profile',()=>{
  const cls='new-effect',data={asset_state:{model:{asset_catalog:{[cls]:{lineage:[
    'ShooterGame/Content/Characters/Global/FXC/FXC_Nearsight_Parent.uasset']}}},observations:{continuous_effects:[
    effect({profile:null,kind:null,effect_class:cls})]}}};
  assert.deepEqual(createAssessor(data)(frame()).candidate_reasons,['observed_unmodeled_vision_effect']);
});
test('conditional proven fade rule caps at round boundary, ignores generic lifetime, and requires build match',()=>{
  const fx=effect({end_ms:90}),rules={mapping_sha256:'mapping',archives:model.archives,classes:{flash:{rule_id:'r',duration_seconds:1}}};
  const observer=run([],[fx]);
  const baseData={asset_state:{model,vision_effects:[fx],observations:{}}};
  const withRule=createAssessor(baseData,{tail_rules:rules});
  const result=withRule(frame(),100,{index:0,start_ms:0,end_ms:400});
  assert.deepEqual(result.candidate_reasons,['asset_visual_fade_window']);assert.equal(result.tails[0].model_end_ms,400);
  assert.equal(withRule(frame({time_ms:400}),400,{index:0,start_ms:0,end_ms:400}).candidate_vision,'unknown');
  assert.equal(withRule(frame({time_ms:1090})).candidate_vision,'clear');
  assert.equal(observer(frame()).candidate_vision,'clear');
  assert.equal(createAssessor(baseData,{tail_rules:{...rules,mapping_sha256:'other'}})(frame()).candidate_vision,'clear');
  assert.equal(createAssessor(baseData,{tail_rules:{...rules,archives:{a:{sha256:'other',bytes:7}}}})(frame()).candidate_vision,'clear');
});
