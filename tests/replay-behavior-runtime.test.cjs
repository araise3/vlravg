const test=require('node:test'),assert=require('node:assert/strict');
const {validate}=require('../scripts/check-replay-behavior.cjs');
const {execute,createFrameEvaluator}=require('../scripts/replay-behavior-runtime.js');
const math=require('../scripts/replay-transcription-viewer.js');
test('extracted Blueprint fixtures and generated interaction sequences',()=>{
  const report=validate();assert.equal(report.generated_combinations,256);assert.ok(report.checks>6900);assert.equal(report.checked_program_hashes.length,9);
});

test('blind arrays and replicated duration readouts exclude future and other component state',()=>{
  const bindings=require('../scripts/replay-behavior-asset-bindings.json'),round={index:0,start_ms:0,end_ms:100};
  const row=(time,members,actor=10,component=20)=>({kind:'blind_array_observed',time_ms:time,packet_id:time,round:0,subject:'a',actor_net_guid:actor,component_net_guid:component,status:'decoded',complete_membership:true,members});
  const member=duration=>({EffectID:1,SourceID:2,InitialDuration:duration});
  const native={effect_id:1,source_id:2,actor_net_guid:10,component_net_guid:20,last_members:member(3)};
  const frame=createFrameEvaluator({asset_state:{model:{mapping_sha256:bindings.mapping_sha256},
    vision_effects:[{id:'flash',subject:'a',round:0,start_ms:0,end_ms:100,native_blind:native}],
    observations:{blind_observations:[row(30,[member(3)]),row(10,[member(1)]),row(25,[member(9)],11,21),{...row(40,[]),status:'unresolved',complete_membership:false},
      {kind:'blind_duration_scalar_observed',subject:'a',round:0,time_ms:10,packet_id:10,duration_seconds:1.5},
      {kind:'blind_duration_scalar_observed',subject:'a',round:0,time_ms:35,packet_id:35,duration_seconds:0}]}}},math,bindings);
  assert.equal(frame('a',9,round).blind.asset_readout.known,false);
  const before=frame('a',20,round);assert.equal(before.vision[0].native_blind.current_member.InitialDuration,1);assert.equal(before.vision[0].native_blind.last_members,undefined);
  assert.equal(before.blind.asset_readout.reported_duration_seconds,1.5);
  assert.equal(frame('a',26,round).vision[0].native_blind.current_member.InitialDuration,1);
  assert.equal(frame('a',30,round).vision[0].native_blind.current_member.InitialDuration,3);
  assert.equal(frame('a',35,round).blind.asset_readout.reported_duration_seconds,0);
  assert.equal(frame('a',40,round).vision[0].native_blind.current_membership_known,false);
  assert.equal(native.last_members.InitialDuration,3);
});
test('untyped operands and unsupported bytecode remain explicit gaps',()=>{
  assert.equal(execute({code:[{expression_type:'EX_ObjectConst',Value:{reference:'x'}},{expression_type:'EX_EndOfScript'}]}).reason,'missing_object_binding:x');
  assert.equal(execute({code:[{expression_type:'EX_Return',ReturnExpression:['x']},{expression_type:'EX_EndOfScript'}]}).reason,'untyped_expression');
});
test('effect snapshots retain only updates observed at the requested clock',()=>{
  const effect={id:'a',subject:'a',round:0,start_ms:0,end_ms:1000,parameters:{value:0},updates:[
    {time_ms:200,packet_id:3,parameters:{value:3}},{time_ms:100,packet_id:1,parameters:{value:1}},
    {time_ms:200,packet_id:2,parameters:{value:2}}]};
  const frame=createFrameEvaluator({asset_state:{observations:{continuous_effects:[effect]}}},math),round={index:0,start_ms:0,end_ms:1000};
  assert.equal(frame('a',99,round).effects[0].last_observed_update,null);
  const at=frame('a',200,round).effects[0];assert.equal(at.updates_observed,3);assert.equal(at.last_observed_update.parameters.value,3);assert.equal(at.updates,undefined);
  assert.equal(frame('a',150,round).effects[0].last_observed_update.parameters.value,1);
  assert.equal(effect.updates[0].time_ms,200);assert.deepEqual(effect.parameters,{value:0});
});
