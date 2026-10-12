/* Repeatable interaction generation, with explicit reference expectations. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const runtime=require('./replay-behavior-runtime.js'),math=require('./replay-transcription-viewer.js');
const fixturePath=path.join(__dirname,'../tests/fixtures/replay-behavior-13.06.json');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function validate(){
  let checks=0;const checkedFunctions=[];
  const check=fn=>{fn();checks++;};
  for(const duration of [0,1,4.5,18,30])check(()=>{
    const result=runtime.execute(fixture.functions.smoke_duration,{}, {SmokeDuration:duration});
    assert.equal(result.known,true);assert.equal(result.outputs.Duration,duration);assert.deepEqual(result.commands,[]);
  });checkedFunctions.push(fixture.functions.smoke_duration.program_sha256);
  for(const scale of [0,.01,.5,1,2])check(()=>{
    const scene={__component:'SceneComponent',id:'smoke-root'},result=runtime.execute(fixture.functions.smoke_scale,{ScalePercentage:scale},{SmokeScene:scene});
    assert.equal(result.known,true);assert.deepEqual(result.commands,[{operation:'set_world_scale',component:'smoke-root',value:{X:scale,Y:scale,Z:scale}}]);
    assert.equal(scene.WorldScale3D,undefined);
  });checkedFunctions.push(fixture.functions.smoke_scale.program_sha256);
  check(()=>{const r=runtime.execute(fixture.functions.alt_death);assert.equal(r.known,true);assert.equal(r.outputs.Result,false)});
  checkedFunctions.push(fixture.functions.alt_death.program_sha256);
  for(const first of [false,true])for(const muteFirst of [false,true])for(const muteThird of [false,true])check(()=>{
    const r=runtime.execute(fixture.functions.audio_perspective,{IsFirstPerson:first},{MuteFirstPerson:muteFirst,MuteThirdPerson:muteThird});
    assert.equal(r.known,true);assert.equal(r.result,!(first?muteFirst:muteThird));
  });checkedFunctions.push(fixture.functions.audio_perspective.program_sha256);
  // The actual extracted scene mutation runs before this added unsupported call.
  // Atomic failure must discard the command and leave caller inputs untouched.
  check(()=>{
    const bad=structuredClone(fixture.functions.smoke_scale);bad.code.splice(2,0,{expression_type:'EX_FinalFunction',StackNode:{reference:"Class'/Script/ShooterGame.Unknown:NativeOperation'"},Parameters:[],StatementIndex:77});
    const self={SmokeScene:{__component:'SceneComponent',id:'a'}},before=structuredClone(self);
    const r=runtime.execute(bad,{ScalePercentage:1},self);assert.equal(r.known,false);assert.match(r.reason,/unsupported_call/);assert.deepEqual(r.commands,[]);assert.deepEqual(self,before);
  });
  check(()=>{const r=runtime.execute(fixture.functions.smoke_duration);assert.equal(r.known,false);assert.equal(r.reason,'missing_property:SmokeDuration')});
  check(()=>{const r=runtime.execute(fixture.functions.smoke_scale,{ScalePercentage:NaN},{SmokeScene:{__component:'SceneComponent'}});assert.equal(r.known,false);assert.equal(r.reason,'nonfinite_value')});
  check(()=>{const r=runtime.execute({code:[{expression_type:'EX_Jump',CodeOffset:0,StatementIndex:0},{expression_type:'EX_EndOfScript',StatementIndex:1}]},{},{},{stepBudget:50});assert.equal(r.known,false);assert.equal(r.reason,'step_budget')});
  check(()=>{const r=runtime.execute({code:[{expression_type:'EX_Jump',CodeOffset:7,StatementIndex:0},{expression_type:'EX_EndOfScript',StatementIndex:1}]});assert.equal(r.known,false);assert.equal(r.reason,'invalid_jump:7')});
  const model={camera:{standing_eye_cm:77,crouched_eye_cm:30,crouch_compression_cm:20},capsule:{half_height_cm:98,radius_cm:42}};
  const round={index:0,start_ms:0,end_ms:1000};
  const effect=(id,start,end,subject='a',ri=0)=>({id,subject,round:ri,start_ms:start,end_ms:end,effect_class:'/Game/Test.Unknown_C',name:id});
  let seed=0x13_06;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  // Legal layer combinations: two flashes, nearsight, crouch reversal, zoom
  // interruption, weapon swap, death/revival, same-frame starts and exact stops.
  for(let scenario=0;scenario<256;scenario++){
    const start=100+Math.floor(random()*100),end=500+Math.floor(random()*100),reverse=start+100;
    const vision=[];if(scenario&1)vision.push({...effect('flash-1',start,end),kind:'flash'});
    if(scenario&2)vision.push({...effect('flash-2',start,end+100),kind:'flash'});
    if(scenario&4)vision.push({...effect('nearsight',start+50,end+50),kind:'nearsight'});
    vision.push({...effect('other-recipient',0,1000,'b'),kind:'flash'}, {...effect('other-round',0,1000,'a',1),kind:'flash'});
    const crouch=Boolean(scenario&8),zoom=Boolean(scenario&16),swap=Boolean(scenario&32),death=Boolean(scenario&64),revive=Boolean(scenario&128);
    const effects=[effect('source-1/same-id',start,end),effect('source-2/same-id',start,end+10),effect('other-recipient',0,1000,'b')];
    const data={asset_state:{model,camera:{stance_transitions:{a:crouch?[[start,0,1,200],[reverse,.5,0,100]]:[]},
      active_weapon:{a:[[0,1],...(swap?[[400,2]]:[])]},weapon_fov:{1:zoom?[[start,103,51.5,200,90,40],[reverse,77.25,103,100,40,90]]:[],2:[[0,103,20.6,100,90,30]]}},
      vision_effects:vision,observations:{continuous_effects:effects,life_states:{a:[[0,true],...(death?[[300,false]]:[]),...(death&&revive?[[450,true]]:[])]}}},kills:[]};
    const frame=runtime.createFrameEvaluator(data,math),times=[0,start-1,start,start+50,reverse,300,400,450,end-1,end,end+10,end+100,999];
    const snapshots=new Map();
    for(const t of times)check(()=>{
      const r=frame('a',t,round);assert.equal(r.known,true);
      const expectedVision=vision.filter(v=>v.subject==='a'&&v.round===0&&v.start_ms<=t&&t<v.end_ms).map(v=>v.id);
      assert.deepEqual(r.vision.map(v=>v.id),expectedVision);
      assert.equal(r.effects.length,t<start?0:t<end?2:t<end+10?1:0);
      assert.equal(r.alive,!death||t<300||revive&&t>=450);
      const fraction=!crouch||t<start?0:t<reverse?(t-start)/200:Math.max(0,.5-(t-reverse)/200);
      assert.ok(Math.abs(r.stance.fraction-fraction)<1e-10);assert.ok(Math.abs(r.stance.eyeHeight-(77-47*fraction))<1e-10);
      let fov=103;if(swap&&t>=400)fov=20.6;else if(zoom&&t>=start)fov=t<reverse?103-(t-start)*51.5/200:77.25+25.75*Math.min(1,(t-reverse)/100);
      assert.ok(Math.abs(r.camera.fov-fov)<1e-10);
      assert.ok(r.gaps.some(g=>g.layer==='animation_pose'));snapshots.set(t,JSON.stringify(r));
    });
    for(const t of [...times].reverse())check(()=>{assert.equal(JSON.stringify(frame('a',t,round)),snapshots.get(t))});
    check(()=>{assert.equal(frame('a',1000,round).known,false);const r=frame('a',1000,{index:1,start_ms:1000,end_ms:2000});assert.equal(r.stance.fraction,0);assert.equal(r.camera.kind,'fallback');assert.equal(r.alive,true);assert.deepEqual(r.effects,[]);assert.deepEqual(r.vision,[])});
  }
  const dispatch=require('./check-replay-dispatch.cjs').validate();checks+=dispatch.checks;
  const bindings=require('./replay-behavior-asset-bindings.json'),blind=bindings.programs.blind_duration_readout;
  for(const seconds of [0,.0377281904,1.5,3])check(()=>{
    const r=runtime.execute(blind,{}, {BlindedShooterCharacter:{__component:'ShooterCharacter',BlindManagerComponent:{__component:'BlindManagerComponent',LongestActiveBlindDuration:seconds}}});
    assert.equal(r.known,true);assert.equal(r.outputs.L_LongestBlind1,Math.fround(seconds));
  });checkedFunctions.push(blind.program_sha256);
  return {schema_version:2,checks,generated_combinations:256,checked_program_hashes:[...new Set([...checkedFunctions,...dispatch.checked_program_hashes])],dispatch_validation:dispatch,
    asset_binding_sha256:hash(path.join(__dirname,'replay-behavior-asset-bindings.json')),
    runtime_sha256:hash(path.join(__dirname,'replay-behavior-runtime.js')),fixture_sha256:hash(fixturePath),
    native_engine_visual_fidelity_validated:false};
}
module.exports={validate};
if(require.main===module)process.stdout.write(JSON.stringify(validate(),null,2)+'\n');
