'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const runtime=require('./replay-behavior-runtime.js');
const file=path.join(__dirname,'../tests/fixtures/replay-behavior-dispatch-13.06.json');
const fixture=JSON.parse(fs.readFileSync(file,'utf8'));
const find=name=>Object.values(fixture.programs).find(p=>p.name===name);
const cls=Object.keys(fixture.classes)[0],graph=find('ExecuteUbergraph_GameObject_NewSmokeZone_Parent');
const field=prefix=>fixture.classes[cls].ChildProperties.find(p=>p.Name.startsWith(prefix)).Name;
const scaleField=field('DefaultSmokeExpandTimeline_ScalePercentage'),contractField=field('DefaultSmokeContractTimeline_ScalePercentage');
const options={programs:fixture.programs,classes:fixture.classes};
const self=()=>({__class:cls,SmokeDuration:18,SmokeScene:{__component:'SceneComponent',id:'smoke-root'},[scaleField]:.25,[contractField]:.75});
const variable=(name,kind='EX_LocalVariable')=>({expression_type:kind,Variable:{New:{Path:[name]}}});
const end={expression_type:'EX_EndOfScript',StatementIndex:99999};
const local=(Name,flags=0)=>({Name,property_type:'FDoubleProperty',PropertyFlags:{value__:flags}});
function validate(){
  let checks=0;const checked=new Set(),check=fn=>{fn();checks++;};
  for(const zero of [false,true])check(()=>{
    const r=runtime.execute(find('ResetSmokeScale'),{ShouldZero:zero},self(),options);
    assert.equal(r.known,true);assert.deepEqual(r.commands[0].value,{X:zero?0:1,Y:zero?0:1,Z:zero?0:1});
  });checked.add(find('ResetSmokeScale').program_sha256);
  for(const [name,key] of [['DefaultSmokeExpandTimeline__UpdateFunc',scaleField],['DefaultSmokeContractTimeline__UpdateFunc',contractField]]){
    for(const scale of [0,.01,.5,1,2])check(()=>{
      const instance=self();instance[key]=scale;
      const r=runtime.execute(find(name),{},instance,options);
      assert.equal(r.known,true);assert.deepEqual(r.commands[0].value,{X:scale,Y:scale,Z:scale});
      assert.equal(r.trace.length,2);assert.equal(instance.SmokeScene.WorldScale3D,undefined);
      assert.ok(r.persistent.$root[graph.object_path]);
    });checked.add(find(name).program_sha256);
  }checked.add(graph.program_sha256);checked.add(find('SetSmokeScaleByPercentage').program_sha256);
  // The real Blueprint output parameter must alias caller storage, rather than
  // disappear into a separate cloned function frame.
  const caller={object_path:'/Game/Test.C:Caller',ChildProperties:[local('out')],code:[
    {expression_type:'EX_LocalFinalFunction',StackNode:{reference:find('GetSmokeDuration').object_path},Parameters:[variable('out')]},
    {expression_type:'EX_Return',ReturnExpression:variable('out')},end]};
  check(()=>{const r=runtime.execute(caller,{},self(),options);assert.equal(r.known,true);assert.equal(r.result,18);assert.equal(r.outputs.out,18)});
  checked.add(find('GetSmokeDuration').program_sha256);
  check(()=>{
    const bad=structuredClone(find('SetSmokeScaleByPercentage'));
    bad.code.splice(2,0,{expression_type:'EX_FinalFunction',StackNode:{reference:'/Script/ShooterGame.Unbound:Native'},Parameters:[]});
    const instance=self(),persistent={$root:{[graph.object_path]:{EntryPoint:7}}},before=structuredClone({instance,persistent});
    const r=runtime.execute(find('DefaultSmokeExpandTimeline__UpdateFunc'),{},instance,{...options,persistent,programs:{...fixture.programs,[bad.object_path]:bad}});
    assert.equal(r.known,false);assert.match(r.reason,/unsupported_call/);assert.deepEqual(r.commands,[]);assert.equal(r.persistent,null);
    assert.deepEqual({instance,persistent},before);
  });
  check(()=>{
    const instance=self(),r=runtime.execute(find('ReceiveTick'),{DeltaSeconds:.05},instance,options);
    assert.equal(r.known,false);assert.match(r.reason,/unsupported_call/);assert.equal(r.persistent,null);assert.deepEqual(r.commands,[]);
  });
  check(()=>{
    const r=runtime.execute(find('ResetSmokeScale'),{ShouldZero:'false'},self(),options);
    assert.equal(r.known,false);assert.match(r.reason,/assignment_bool_type|property_type/);
  });
  check(()=>{
    const child='/Game/Test.Child_C',override='/Game/Test.Child_C:GetSmokeDuration';
    const virtual={...caller,code:[{expression_type:'EX_LocalVirtualFunction',VirtualFunctionName:'GetSmokeDuration',Parameters:[variable('out')]},...caller.code.slice(1)]};
    const overridden={object_path:override,ChildProperties:find('GetSmokeDuration').ChildProperties,code:[
      {expression_type:'EX_Let',Variable:variable('Duration','EX_LocalOutVariable'),Assignment:{expression_type:'EX_DoubleConst',Value:30}},end]};
    const opt={...options,classes:{...fixture.classes,[child]:{parent:cls,functions:{GetSmokeDuration:override}}},programs:{...fixture.programs,[override]:overridden}};
    const instance={...self(),__class:child};
    assert.equal(runtime.execute(virtual,{},instance,opt).result,30);
    assert.equal(runtime.execute(caller,{},instance,opt).result,18);
    assert.equal(runtime.execute(virtual,{},instance,{...opt,programs:fixture.programs}).known,false);
  });
  check(()=>{
    const ref='/Game/Test.C:Loop',loop={object_path:ref,ChildProperties:[],code:[{expression_type:'EX_LocalFinalFunction',StackNode:{reference:ref},Parameters:[]},end]};
    assert.equal(runtime.execute(loop,{},self(),{programs:{[ref]:loop},callDepth:4}).reason,'call_depth');
  });
  const events=[
    {time_ms:100,sequence:0,kind:'observe',patch:{[scaleField]:.5}},
    {time_ms:100,sequence:1,function:find('DefaultSmokeExpandTimeline__UpdateFunc').object_path},
    {time_ms:200,sequence:0,kind:'observe',patch:{[contractField]:.25}},
    {time_ms:200,sequence:1,function:find('DefaultSmokeContractTimeline__UpdateFunc').object_path},
    {time_ms:300,sequence:0,function:find('ResetSmokeScale').object_path,inputs:{ShouldZero:true}}
  ];
  const session=runtime.createSession({...options,initial:self(),events});
  const snapshots=new Map();
  for(const time of [0,99,100,150,199,200,299,300,500])check(()=>{
    const r=session.at(time);assert.equal(r.known,true);assert.equal(r.commands.length,time<100?0:time<200?1:time<300?2:3);
    if(time>=100)assert.equal(r.state.SmokeScene.WorldScale3D.X,time<200?.5:time<300?.25:0);
    snapshots.set(time,JSON.stringify(r));
  });
  for(const time of [...snapshots.keys()].reverse())check(()=>assert.equal(JSON.stringify(session.at(time)),snapshots.get(time)));
  check(()=>{
    const failed=runtime.createSession({...options,initial:self(),events:[...events,{time_ms:400,function:find('ReceiveTick').object_path,inputs:{DeltaSeconds:.05}}]}).at(400);
    assert.equal(failed.known,false);assert.equal(failed.state,null);assert.deepEqual(failed.commands,[]);
  });
  check(()=>assert.throws(()=>runtime.createSession({events:[{time_ms:1,sequence:0},{time_ms:1,sequence:0}]}),/ambiguous_event_order/));
  return {checks,checked_program_hashes:[...checked],fixture_sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    checked_entry_points:{[graph.program_sha256]:[find('DefaultSmokeExpandTimeline__UpdateFunc').code[0].Parameters[0].Value,find('DefaultSmokeContractTimeline__UpdateFunc').code[0].Parameters[0].Value]},
    semantics:'asset_programs_with_explicit_input_and_clock_bindings',native_engine_visual_fidelity_validated:false};
}
module.exports={validate};
if(require.main===module)process.stdout.write(JSON.stringify(validate(),null,2)+'\n');
