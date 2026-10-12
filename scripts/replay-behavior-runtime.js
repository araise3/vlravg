/* Shipped Blueprint expression subset and independent replay state layers.
 * No eval, game execution, or guessed native-call fallback. Results are atomic:
 * an unsupported operation returns a gap, never a partially applied program.
 */
(function(root){
  'use strict';
  const ops=['EX_Nothing','EX_EndOfScript','EX_Return','EX_IntConst','EX_IntZero','EX_IntOne',
    'EX_FloatConst','EX_DoubleConst','EX_True','EX_False','EX_ByteConst','EX_Self',
    'EX_LocalVariable','EX_LocalOutVariable','EX_InstanceVariable','EX_Let','EX_LetBool','EX_LetObj',
    'EX_Context','EX_CallMath','EX_FinalFunction','EX_LocalFinalFunction',
    'EX_VirtualFunction','EX_LocalVirtualFunction','EX_LetValueOnPersistentFrame',
    'EX_Jump','EX_JumpIfNot','EX_ComputedJump','EX_PushExecutionFlow','EX_PopExecutionFlow','EX_PopExecutionFlowIfNot',
    'EX_NoObject','EX_ObjectConst','EX_NameConst','EX_StringConst','EX_UnicodeStringConst',
    'EX_VectorConst','EX_RotationConst','EX_SwitchValue','EX_StructMemberContext','EX_Cast'];
  const mathPrefix='/Script/Engine.KismetMathLibrary:';
  const mathBindings={
    Conv_DoubleToVector:x=>({X:x,Y:x,Z:x}),
    Add_DoubleDouble:(a,b)=>a+b,Subtract_DoubleDouble:(a,b)=>a-b,
    Multiply_DoubleDouble:(a,b)=>a*b,Divide_DoubleDouble:(a,b)=>{if(b===0)throw Error('division_by_zero');return a/b;},
    BooleanAND:(a,b)=>a&&b,BooleanOR:(a,b)=>a||b,Not_PreBool:a=>!a,
    Less_DoubleDouble:(a,b)=>a<b,LessEqual_DoubleDouble:(a,b)=>a<=b,
    Greater_DoubleDouble:(a,b)=>a>b,GreaterEqual_DoubleDouble:(a,b)=>a>=b,
    EqualEqual_DoubleDouble:(a,b)=>a===b,NotEqual_DoubleDoubleDouble:(a,b)=>a!==b
  };
  const integerBindings={
    Add_IntInt:(a,b)=>(a+b)|0,Subtract_IntInt:(a,b)=>(a-b)|0,Multiply_IntInt:(a,b)=>Math.imul(a,b),
    Divide_IntInt:(a,b)=>{if(!b)throw Error('division_by_zero');return Math.trunc(a/b)|0;},
    Less_IntInt:(a,b)=>a<b,LessEqual_IntInt:(a,b)=>a<=b,Greater_IntInt:(a,b)=>a>b,GreaterEqual_IntInt:(a,b)=>a>=b,
    EqualEqual_IntInt:(a,b)=>a===b,NotEqual_IntInt:(a,b)=>a!==b,Conv_IntToDouble:a=>a
  };
  Object.assign(mathBindings,integerBindings,{
    EqualEqual_BoolBool:(a,b)=>a===b,NotEqual_BoolBool:(a,b)=>a!==b,
    MakeVector:(x,y,z)=>({X:x,Y:y,Z:z})
  });
  const componentBindings=['/Script/Engine.SceneComponent:SetWorldScale3D',
    '/Script/Engine.SphereComponent:GetUnscaledSphereRadius',
    '/Script/ShooterGame.ShooterCharacter:GetBlindManagerComponent',
    '/Script/ShooterGame.BlindManagerComponent:GetLongestActiveBlindDuration'];
  let boundAssetPrograms=null;
  const capabilities={schema_version:2,opcodes:ops,
    native_bindings:[...Object.keys(mathBindings).map(n=>mathPrefix+n),...componentBindings],
    blueprint_dispatch:true,persistent_frames:true,deterministic_event_sessions:true,
    cast_tokens:[1,3,4,71],
    observed_native_accessors:['/Script/ShooterGame.ShooterCharacter:GetBlindManagerComponent','/Script/ShooterGame.BlindManagerComponent:GetLongestActiveBlindDuration'],
    semantics:'modeled_expression_subset',native_engine_fidelity_validated:false};
  const own=(o,k)=>o!=null&&Object.prototype.hasOwnProperty.call(o,k);
  function reference(x){return (x?.reference||'').replace(/^[^']*'/,'').replace(/'$/,'');}
  function pointerPath(pointer){
    const path=pointer?.New?.Path;
    if(!Array.isArray(path)||path.length!==1||typeof path[0]!=='string'||['__proto__','prototype','constructor'].includes(path[0]))throw Error('unsupported_property_path');
    return path[0];
  }
  function finite(value){
    const seen=new WeakSet();
    function visit(value){
    if(typeof value==='number'&&!Number.isFinite(value))throw Error('nonfinite_value');
    if(value&&typeof value==='object'){
      if(seen.has(value))return;seen.add(value);
      if(own(value,'unexpanded')||own(value,'unresolved_numeric'))throw Error('unresolved_value');
      for(const x of Object.values(value))visit(x);
    }
    }visit(value);
    return value;
  }
  function execute(program,inputs={},instance={},options={}){
    let site=null,steps=0,activeFunction=null;
    // One clone preserves object aliases across arguments, components and the
    // explicit runtime object table. The entire call tree commits together.
    const transaction=structuredClone({inputs,instance,persistent:options.persistent||{},objects:options.objects||{}});
    const self=transaction.instance,commands=[],trace=[],budget=options.stepBudget??2000;
    const programs=options.programs||{},classes=options.classes||{};
    const fail=reason=>({known:false,reason,statement:site,function:activeFunction,commands:[],outputs:null,instance:null,persistent:null,objects:null,trace});
    const path=p=>p?.object_path||p?.path||null;
    const fields=p=>p?.ChildProperties||p?.fields||[];
    const flags=f=>{
      const value=f.PropertyFlags?.decimal??f.PropertyFlags?.value__??f.flags??0;
      if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('unsafe_property_flags');
      return BigInt(value);
    };
    const flag=(f,n)=>(flags(f)&BigInt(n))!==0n;
    const declarations=p=>Object.fromEntries(fields(p).map(f=>[f.Name,f]));
    const objectKey=o=>o===self?'$root':typeof o?.__id==='string'&&!['__proto__','prototype','constructor','$root'].includes(o.__id)?o.__id:(()=>{throw Error('missing_persistent_object_id');})();
    function persistentFor(object,functionPath){
      if(!functionPath)throw Error('missing_persistent_function_path');
      const key=objectKey(object);
      if(!own(transaction.persistent,key))transaction.persistent[key]={};
      if(!own(transaction.persistent[key],functionPath))transaction.persistent[key][functionPath]={};
      return transaction.persistent[key][functionPath];
    }
    function defaultLocal(field){
      if(!field)throw Error('missing_local_declaration');
      const type=field.property_type;
      if(['FIntProperty','FByteProperty','FFloatProperty','FDoubleProperty'].includes(type))return 0;
      if(type==='FBoolProperty')return false;
      if(type==='FNameProperty')return 'None';
      if(type==='FStrProperty')return '';
      if(['FObjectProperty','FObjectPtrProperty','FClassProperty','FInterfaceProperty','FDelegateProperty'].includes(type))return null;
      if(type==='FArrayProperty')return [];
      if(type==='FStructProperty'){
        const ref=reference(field.Struct);
        if(ref==='/Script/CoreUObject.Vector')return {X:0,Y:0,Z:0};
        if(ref==='/Script/CoreUObject.Rotator')return {Pitch:0,Yaw:0,Roll:0};
      }
      throw Error('unsupported_local_default:'+type);
    }
    function classField(object,key){
      let cls=object?.__class;const seen=new Set();
      while(cls&&own(classes,cls)&&!seen.has(cls)){
        seen.add(cls);const row=classes[cls],f=(row.ChildProperties||row.fields||[]).find(f=>f.Name===key);
        if(f)return f;cls=row.parent;
      }
      return null;
    }
    function lookupVirtual(object,name){
      if(typeof name!=='string')throw Error('invalid_function_name');
      let cls=object?.__class;const seen=new Set();
      if(!cls)throw Error('missing_dispatch_class');
      while(cls){
        if(seen.has(cls))throw Error('inheritance_cycle');seen.add(cls);
        if(!own(classes,cls))throw Error('missing_dispatch_class:'+cls);
        const row=classes[cls],key=Object.keys(row.functions||{}).find(k=>k.toLowerCase()===name.toLowerCase());
        if(key)return row.functions[key];cls=row.parent;
      }
      throw Error('missing_virtual_function:'+name);
    }
    function address(e,frame,context,depth=0){
      if(depth>64)throw Error('expression_depth');
      if(!e||typeof e!=='object'||Array.isArray(e))throw Error('untyped_expression');
      if(e.expression_type==='EX_StructMemberContext'){
        const base=address(e.StructExpression,frame,context,depth+1),object=base.get(),key=pointerPath(e.Property);
        if(!object||typeof object!=='object'||!own(object,key))throw Error('missing_struct_member:'+key);
        return {get:()=>object[key],set:v=>{object[key]=v;},field:null};
      }
      if(e.expression_type==='EX_Context'){
        const object=value(e.ObjectExpression,frame,context,depth+1);
        if(!object||typeof object!=='object')throw Error('missing_context');
        return address(e.ContextExpression,frame,object,depth+1);
      }
      const kind=e.expression_type,key=pointerPath(e.Variable);
      if(!['EX_LocalVariable','EX_LocalOutVariable','EX_InstanceVariable'].includes(kind))throw Error('unsupported_assignment');
      if(kind!=='EX_InstanceVariable'&&own(frame.aliases,key))return frame.aliases[key];
      const source=kind==='EX_InstanceVariable'?context:frame.local,field=kind==='EX_InstanceVariable'?classField(context,key):frame.declarations[key];
      return {field,get:()=>{
        if(!own(source,key)){
          if(kind==='EX_InstanceVariable')throw Error('missing_property:'+key);
          if(!field)throw Error('missing_property:'+key);
          // Parameters must arrive through a call binding. Only local storage
          // and pure output parameters use serialized zero construction.
          if(flag(field,128)&&(!flag(field,256)||flag(field,134217728)))throw Error('missing_property:'+key);
          source[key]=defaultLocal(field);
        }
        return finite(source[key]);
      },set:v=>{source[key]=v;}};
    }
    function assign(target,value,forceReference=false){
      const kind=target.field?.property_type;
      validateType(target.field,value);
      target.set(!forceReference&&['FStructProperty','FArrayProperty'].includes(kind)?structuredClone(value):value);
      return value;
    }
    function validateType(field,v){
      if(!field)return;
      const type=field.property_type;
      if(['FIntProperty','FByteProperty'].includes(type)&&(!Number.isInteger(v)||v<(type==='FByteProperty'?0:-2147483648)||v>(type==='FByteProperty'?255:2147483647)))throw Error('property_type:'+field.Name);
      if(['FFloatProperty','FDoubleProperty'].includes(type)&&typeof v!=='number')throw Error('property_type:'+field.Name);
      if(type==='FBoolProperty'&&typeof v!=='boolean')throw Error('property_type:'+field.Name);
      if(['FNameProperty','FStrProperty'].includes(type)&&typeof v!=='string')throw Error('property_type:'+field.Name);
      if(type==='FArrayProperty'&&!Array.isArray(v))throw Error('property_type:'+field.Name);
      if(['FObjectProperty','FObjectPtrProperty','FClassProperty','FInterfaceProperty'].includes(type)&&v!==null&&typeof v!=='object')throw Error('property_type:'+field.Name);
      if(type==='FStructProperty'&&(!v||typeof v!=='object'||Array.isArray(v)))throw Error('property_type:'+field.Name);
    }
    function callBlueprint(ref,terms,frame,context,depth){
      if(!own(programs,ref))throw Error('unsupported_call:'+ref);
      const child=programs[ref];
      if(!Array.isArray(child.ChildProperties||child.fields))throw Error('missing_function_signature:'+ref);
      const parameters=fields(child).filter(f=>flag(f,128)&&!flag(f,1024));
      if(parameters.length!==terms.length)throw Error('call_arity:'+ref);
      const local={},aliases={};
      parameters.forEach((field,i)=>{
        if(flag(field,256)&&!flag(field,2)){
          const target=address(terms[i],frame,context,depth+1);aliases[field.Name]={...target,field};
          if(flag(field,134217728))target.get();
        }else{
          const v=value(terms[i],frame,context,depth+1);
          validateType(field,v);
          local[field.Name]=field.property_type==='FStructProperty'||field.property_type==='FArrayProperty'?structuredClone(v):v;
        }
      });
      const result=run(child,local,context,aliases,frame.callDepth+1);
      trace.push({function:ref,statement:site,result:result.result});
      return result.result;
    }
    function value(e,frame,context,depth=0){
      if(++steps>budget)throw Error('step_budget');
      if(depth>64)throw Error('expression_depth');
      if(!e||typeof e!=='object'||Array.isArray(e))throw Error('untyped_expression');
      site=e.StatementIndex??site;
      const kind=e.expression_type;
      if(!ops.includes(kind))throw Error('unsupported_opcode:'+kind);
      const child=x=>value(x,frame,context,depth+1);
      if(['EX_Nothing','EX_EndOfScript'].includes(kind))return null;
      if(kind==='EX_IntZero')return 0;if(kind==='EX_IntOne')return 1;
      if(kind==='EX_True')return true;if(kind==='EX_False')return false;
      if(['EX_IntConst','EX_ByteConst','EX_DoubleConst','EX_FloatConst'].includes(kind)){
        if(typeof e.Value!=='number')throw Error('invalid_numeric_constant');
        return finite(kind==='EX_FloatConst'?Math.fround(e.Value):e.Value);
      }
      if(kind==='EX_Self')return context;
      if(kind==='EX_Cast'){
        const token=e.ConversionType?.value__,v=child(e.Target);
        if(token===1||token===71){if(v!==null&&typeof v!=='object')throw Error('cast_object_type');return v!==null;}
        if(token===3||token===4){if(typeof v!=='number')throw Error('cast_numeric_type');return finite(token===3?Math.fround(v):v);}
        throw Error('unsupported_cast:'+token);
      }
      if(kind==='EX_NoObject')return null;
      if(['EX_NameConst','EX_StringConst','EX_UnicodeStringConst'].includes(kind)){
        if(typeof e.Value!=='string')throw Error('invalid_string_constant');return e.Value;
      }
      if(kind==='EX_ObjectConst'){
        const ref=reference(e.Value);
        if(ref==='0')return null;
        if(!own(transaction.objects,ref))throw Error('missing_object_binding:'+ref);
        return transaction.objects[ref];
      }
      if(kind==='EX_VectorConst'||kind==='EX_RotationConst'){
        const keys=kind==='EX_VectorConst'?['X','Y','Z']:['Pitch','Yaw','Roll'];
        if(!e.Value||keys.some(k=>typeof e.Value[k]!=='number'))throw Error('invalid_struct_constant');
        return finite(structuredClone(e.Value));
      }
      if(['EX_LocalVariable','EX_LocalOutVariable','EX_InstanceVariable'].includes(kind)){
        return address(e,frame,context).get();
      }
      if(['EX_Let','EX_LetBool','EX_LetObj'].includes(kind)){
        const target=address(e.Variable,frame,context),v=child(e.Assignment);
        if(kind==='EX_LetBool'&&typeof v!=='boolean')throw Error('assignment_bool_type');
        return assign(target,v,kind==='EX_LetObj');
      }
      if(kind==='EX_LetValueOnPersistentFrame'){
        const pointer=e.DestinationProperty,key=pointerPath(pointer),owner=reference(pointer.New.ResolvedOwner);
        if(!own(programs,owner)||!programs[owner].persistent)throw Error('unbound_persistent_frame:'+owner);
        const store=persistentFor(frame.self,owner),field=declarations(programs[owner])[key];
        if(!field)throw Error('missing_persistent_declaration:'+key);
        return assign({field,set:v=>{store[key]=v;}},child(e.AssignmentExpression));
      }
      if(kind==='EX_StructMemberContext')return address(e,frame,context).get();
      if(kind==='EX_SwitchValue'){
        const index=child(e.IndexTerm);
        for(const item of e.Cases||[])if(child(item.CaseIndexValueTerm)===index)return child(item.CaseTerm);
        return child(e.DefaultTerm);
      }
      if(kind==='EX_Context'){
        const object=child(e.ObjectExpression);
        if(!object||typeof object!=='object')throw Error('missing_context');
        return value(e.ContextExpression,frame,object,depth+1);
      }
      if(['EX_CallMath','EX_FinalFunction','EX_LocalFinalFunction','EX_VirtualFunction','EX_LocalVirtualFunction'].includes(kind)){
        const ref=kind.includes('Virtual')?lookupVirtual(context,e.VirtualFunctionName):reference(e.StackNode);
        if(!capabilities.native_bindings.includes(ref))return callBlueprint(ref,e.Parameters||[],frame,context,depth);
        const args=(e.Parameters||[]).map(child);
        if(ref.startsWith(mathPrefix)){
          const name=ref.slice(mathPrefix.length),fn=mathBindings[name];
          if(args.length!==fn.length)throw Error('binding_arity:'+name);
          const boolean=['BooleanAND','BooleanOR','Not_PreBool','EqualEqual_BoolBool','NotEqual_BoolBool'].includes(name);
          if(args.some(x=>typeof x!==(boolean?'boolean':'number')))throw Error('binding_type:'+name);
          if(own(integerBindings,name)&&args.some(x=>!Number.isInteger(x)||x< -2147483648||x>2147483647))throw Error('binding_int32:'+name);
          return finite(fn(...args));
        }
        if(ref==='/Script/Engine.SceneComponent:SetWorldScale3D'){
          if(args.length!==1||!args[0]||['X','Y','Z'].some(k=>typeof args[0][k]!=='number'))throw Error('binding_type:SetWorldScale3D');
          if(context.__component!=='SceneComponent')throw Error('missing_scene_component_binding');
          commands.push({operation:'set_world_scale',component:context.id||null,value:structuredClone(args[0])});
          context.WorldScale3D=structuredClone(args[0]);return null;
        }
        if(ref==='/Script/Engine.SphereComponent:GetUnscaledSphereRadius'){
          if(context.__component!=='SphereComponent'||args.length||typeof context.SphereRadius!=='number')throw Error('missing_sphere_component_binding');
          return context.SphereRadius;
        }
        if(ref==='/Script/ShooterGame.ShooterCharacter:GetBlindManagerComponent'){
          if(context.__component!=='ShooterCharacter'||args.length||!context.BlindManagerComponent)throw Error('missing_observed_blind_manager');
          return context.BlindManagerComponent;
        }
        if(context.__component!=='BlindManagerComponent'||args.length||typeof context.LongestActiveBlindDuration!=='number'||context.LongestActiveBlindDuration<0)throw Error('missing_observed_blind_duration');
        return Math.fround(context.LongestActiveBlindDuration);
      }
      if(kind==='EX_Return'){frame.result=child(e.ReturnExpression);frame.returned=true;return frame.result;}
      throw Error('control_flow_inside_expression:'+kind);
    }
    function run(program,inputs,object,aliases={},depth=0){
      if(depth>(options.callDepth??64))throw Error('call_depth');
      const code=program?.ScriptBytecode||program?.code||[];
      if(!code.length||code.at(-1)?.expression_type!=='EX_EndOfScript')throw Error('incomplete_script');
      if((BigInt(program.FunctionFlags?.value__||0)&1024n)!==0n)throw Error('native_function');
      const previous=activeFunction;activeFunction=path(program);
      const local=program.persistent?persistentFor(object,path(program)):inputs;
      if(program.persistent)Object.assign(local,inputs);
      const frame={self:object,local,aliases,declarations:declarations(program),returned:false,result:null,callDepth:depth};
      const indices=new Map(code.map((e,i)=>[e.StatementIndex,i])),flow=[];
      let pc=0;
      const jump=offset=>{if(!indices.has(offset))throw Error('invalid_jump:'+offset);return indices.get(offset);};
      while(pc<code.length&&!frame.returned){
        const e=code[pc];site=e.StatementIndex??site;
        if(++steps>budget)throw Error('step_budget');
        if(e.expression_type==='EX_Jump'){pc=jump(e.CodeOffset);continue;}
        if(e.expression_type==='EX_PushExecutionFlow'){flow.push(jump(e.PushingAddress));pc++;continue;}
        if(['EX_PopExecutionFlow','EX_PopExecutionFlowIfNot'].includes(e.expression_type)){
          let shouldPop=true;
          if(e.expression_type==='EX_PopExecutionFlowIfNot'){
            const condition=value(e.BooleanExpression,frame,object);if(typeof condition!=='boolean')throw Error('condition_type');shouldPop=!condition;
          }
          pc=shouldPop?(flow.length?flow.pop():code.length):pc+1;continue;
        }
        if(e.expression_type==='EX_JumpIfNot'){
          const condition=value(e.BooleanExpression,frame,object);if(typeof condition!=='boolean')throw Error('condition_type');
          pc=condition?pc+1:jump(e.CodeOffset);continue;
        }
        if(e.expression_type==='EX_ComputedJump'){pc=jump(value(e.CodeOffsetExpression,frame,object));continue;}
        value(e,frame,object);pc++;
      }
      activeFunction=previous;
      const output={...local};for(const [key,target] of Object.entries(aliases))output[key]=target.get();
      return {result:frame.result,outputs:output};
    }
    try{
      finite(transaction);
      const result=run(program,transaction.inputs,self);
      return {known:true,...result,instance:self,persistent:transaction.persistent,objects:transaction.objects,commands,steps,trace,evidence:'decoded_blueprint_with_modeled_bindings'};
    }catch(error){return fail(String(error.message));}
  }

  function createSession(config){
    // Explicit invocation clocks only: no guessed tick, effect callbacks or
    // universal death cleanup. Every seek replays the same immutable log.
    const source=structuredClone(config),events=(source.events||[]).map((e,i)=>({...e,sequence:e.sequence??i}));
    if(events.some(e=>!Number.isFinite(e.time_ms)||!Number.isSafeInteger(e.sequence)))throw Error('invalid_event_clock');
    events.sort((a,b)=>a.time_ms-b.time_ms||a.sequence-b.sequence);
    if(events.some((e,i)=>i&&e.time_ms===events[i-1].time_ms&&e.sequence===events[i-1].sequence))throw Error('ambiguous_event_order');
    return {at(time){
      if(!Number.isFinite(time))return {known:false,reason:'invalid_clock'};
      const initial=structuredClone({state:source.initial||{},objects:source.objects||{}});
      let state=initial.state,persistent={},objects=initial.objects;
      const commands=[],results=[];
      for(const event of events){
        if(event.time_ms>time)break;
        if(event.kind==='observe'){
          if(!event.patch||typeof event.patch!=='object'||Array.isArray(event.patch))return {known:false,reason:'invalid_observation',event,commands:[],state:null};
          if(Object.keys(event.patch).some(k=>['__proto__','constructor','prototype'].includes(k)))return {known:false,reason:'invalid_observation_key',event,commands:[],state:null};
          Object.assign(state,structuredClone(event.patch));continue;
        }
        const program=source.programs?.[event.function];
        if(!program)return {known:false,reason:'missing_event_program',event,commands:[],state:null};
        const r=execute(program,event.inputs||{},state,{programs:source.programs,classes:source.classes,persistent,objects,stepBudget:source.stepBudget});
        if(!r.known)return {known:false,reason:r.reason,event,statement:r.statement,function:r.function,commands:[],state:null,last_successful_event:results.at(-1)?.event||null};
        state=r.instance;persistent=r.persistent;objects=r.objects;
        commands.push(...r.commands.map(c=>({...c,time_ms:event.time_ms,sequence:event.sequence})));
        results.push({event: {time_ms:event.time_ms,sequence:event.sequence,function:event.function},result:r.result,outputs:r.outputs});
      }
      return {known:true,time_ms:time,state,persistent,objects,commands,results,clock:'explicit_event_times',native_engine_fidelity_validated:false};
    }};
  }

  function createFrameEvaluator(data,math,assetPrograms=boundAssetPrograms){
    // Index once, sample all layers at the same replay clock. No forward-only
    // state is carried between frames; backward seeking therefore cannot leak.
    const state=data.asset_state||{},obs=state.observations||{},groups=new Map(),updates=new WeakMap();
    function index(name,rows){for(const r of rows||[]){const key=JSON.stringify([name,r.round,r.subject]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}}
    index('effects',obs.continuous_effects);index('vision',state.vision_effects);
    index('blindDuration',(obs.blind_observations||[]).filter(r=>r.kind==='blind_duration_scalar_observed'));
    index('blindArrays',(obs.blind_observations||[]).filter(r=>r.kind==='blind_array_observed'));
    for(const [key,rows] of groups)if(key.includes('blindDuration')||key.includes('blindArrays'))rows.sort((a,b)=>a.time_ms-b.time_ms||a.packet_id-b.packet_id);
    for(const e of obs.continuous_effects||[])updates.set(e,(e.updates||[]).slice().sort((a,b)=>a.time_ms-b.time_ms||(a.packet_id||0)-(b.packet_id||0)));
    const active=(name,subject,round,t)=>(groups.get(JSON.stringify([name,round,subject]))||[]).filter(e=>e.start_ms<=t&&t<e.end_ms);
    function last(name,subject,round,t){
      const rows=groups.get(JSON.stringify([name,round,subject]))||[];let lo=0,hi=rows.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time_ms<=t)lo=mid+1;else hi=mid;}
      return rows[lo-1]||null;
    }
    function matchingArray(subject,round,t,actor,component){
      const rows=groups.get(JSON.stringify(['blindArrays',round,subject]))||[];
      for(let i=rows.length-1;i>=0;i--)if(rows[i].time_ms<=t&&rows[i].actor_net_guid===actor&&rows[i].component_net_guid===component)return rows[i];
      return null;
    }
    function effectAt(e,t){
      const rows=updates.get(e)||[];let lo=0,hi=rows.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time_ms<=t)lo=mid+1;else hi=mid;}
      const {updates:fullHistory,...record}=e;
      // Native update fields may be deltas with unknown tag semantics. Keep the
      // last observation separate from start parameters rather than guessing a
      // merge or exposing future updates as current state.
      return {...record,updates_observed:lo,last_observed_update:rows[lo-1]||null};
    }
    return function frame(subject,t,round){
      if(!round||!Number.isFinite(t)||t<round.start_ms||t>=round.end_ms)return {known:false,reason:'outside_round'};
      const effects=active('effects',subject,round.index,t).map(e=>effectAt(e,t));
      const array=last('blindArrays',subject,round.index,t),duration=last('blindDuration',subject,round.index,t);
      const blind={duration_observation:duration,array_observation:array,membership_known:array?.status==='decoded'&&array.complete_membership===true};
      const vision=active('vision',subject,round.index,t).map(e=>{
        if(!e.native_blind)return e;
        const {last_members,members,...record}=e.native_blind;
        const observed=matchingArray(subject,round.index,t,record.actor_net_guid,record.component_net_guid);
        const known=observed?.status==='decoded'&&observed.complete_membership===true;
        const member=known?(observed.members||[]).find(m=>m.EffectID===record.effect_id&&m.SourceID===record.source_id)||null:null;
        return {...e,native_blind:{...record,current_member:member,current_membership_known:known}};
      });
      if(assetPrograms?.programs?.blind_duration_readout&&assetPrograms.mapping_sha256&&assetPrograms.mapping_sha256===state.model?.mapping_sha256&&duration&&typeof duration.duration_seconds==='number'){
        const r=execute(assetPrograms.programs.blind_duration_readout,{}, {BlindedShooterCharacter:{__component:'ShooterCharacter',
          BlindManagerComponent:{__component:'BlindManagerComponent',LongestActiveBlindDuration:duration.duration_seconds}}});
        blind.asset_readout={known:r.known,reported_duration_seconds:r.known?r.outputs.L_LongestBlind1:null,reason:r.reason||null,
          program_sha256:assetPrograms.programs.blind_duration_readout.program_sha256,observation_time_ms:duration.time_ms,
          actor_net_guid:duration.actor_net_guid,component_net_guid:duration.component_net_guid,
          semantics:'asset_getter_with_replicated_scalar_binding',native_accessor_implementation_verified:false};
      }else blind.asset_readout={known:false,reason:duration?'missing_or_mismatched_asset_program':'no_blind_duration_observation'};
      const camera=math.weaponFov(state.camera,subject,t,round.start_ms);
      const rows=(state.camera?.stance_transitions?.[subject]||[]).filter(r=>r[0]>=round.start_ms);
      const stance=state.model?.camera&&state.model?.capsule?math.stanceGeometry(state.model,rows,t):null;
      const alive=math.lifeAt(obs.life_states?.[subject]||[],t,round.start_ms,
        (data.kills||[]).filter(k=>k.round===round.index&&k.victim===subject).map(k=>k.time_ms));
      return {known:true,time_ms:t,subject,round:round.index,alive,camera,stance,effects,vision,blind,
        gaps:[...effects.map(e=>({layer:'effect_appearance',id:e.id,class:e.effect_class,reason:'native_effect_program_not_executed'})),
          {layer:'animation_pose',reason:'native_animation_graph_not_executed'},
          ...(camera.kind==='fallback'?[{layer:'camera',reason:'no_active_weapon_fov_observation'}]:[]),
          ...(stance?[{layer:'stance',reason:'input_model_not_achieved_skeletal_pose'}]:[{layer:'stance',reason:'no_asset_model'}])],
        semantics:'independent_observed_layers_with_explicit_model_gaps'};
    };
  }
  const api={capabilities,execute,createSession,createFrameEvaluator,bindAssetPrograms:programs=>{boundAssetPrograms=structuredClone(programs);}};
  if(typeof module!=='undefined')module.exports=api;
  if(root)root.ReplayBehavior=api;
  if(typeof process!=='undefined'&&process.argv.includes('--capabilities'))process.stdout.write(JSON.stringify(capabilities));
})(typeof window==='undefined'?null:window);
