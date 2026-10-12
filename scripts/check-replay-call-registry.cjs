'use strict';
const fs=require('node:fs'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const runtime=require('./replay-behavior-runtime.js');
const bytes=fs.readFileSync(process.argv[2]),registry=JSON.parse(zlib.gunzipSync(bytes));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(registry.runtime_sha256,sha(fs.readFileSync(require.resolve('./replay-behavior-runtime.js'))));
let checks=1;
const ref=x=>(x?.reference||'').replace(/^[^']*'/,'').replace(/'$/,'');
function* walk(v){if(v&&typeof v==='object'){yield v;for(const child of Object.values(v))yield* walk(child);}}
for(const [path,program] of Object.entries(registry.programs)){
  assert.equal(program.object_path,path);assert.equal(program.code.at(-1).expression_type,'EX_EndOfScript');checks+=2;
  for(const node of walk(program.code)){
    if(!node.expression_type?.startsWith('EX_'))continue;
    assert.ok(runtime.capabilities.opcodes.includes(node.expression_type));checks++;
    if(['EX_FinalFunction','EX_LocalFinalFunction','EX_CallMath'].includes(node.expression_type)){
      const target=ref(node.StackNode);assert.ok(target.startsWith('/Game/')?Object.hasOwn(registry.programs,target):runtime.capabilities.native_bindings.includes(target),target);checks++;
    }
  }
}
const fixture=require('../tests/fixtures/replay-behavior-dispatch-13.06.json');
const smoke=Object.values(fixture.programs).find(p=>p.name==='GetSmokeDuration'),program=registry.programs[smoke.object_path];
assert.deepEqual(program.code,smoke.code);checks++;
const duration=runtime.execute(program,{}, {SmokeDuration:18},{programs:registry.programs});
assert.equal(duration.known,true);assert.ok(Object.values(duration.outputs).includes(18));checks+=2;
const entry=Object.values(registry.programs).find(p=>p.object_path.endsWith('BP_BlockingVolume_C:ReceiveBeginPlay'));
const callback=runtime.execute(entry,{}, {},{programs:registry.programs});
assert.equal(callback.known,true);assert.equal(callback.trace.length,1);assert.equal(callback.trace[0].function,ref(entry.code[0].StackNode));checks+=3;
const missing={...registry.programs};delete missing[ref(entry.code[0].StackNode)];
const failure=runtime.execute(entry,{}, {},{programs:missing});
assert.equal(failure.known,false);assert.deepEqual(failure.commands,[]);checks+=2;
process.stdout.write(JSON.stringify({schema_version:1,programs_checked:Object.keys(registry.programs).length,checks,
  registry_sha256:sha(bytes),runtime_sha256:registry.runtime_sha256,checker_sha256:sha(fs.readFileSync(__filename)),
  checked_execution_program_hashes:[program.program_sha256,entry.program_sha256],native_engine_fidelity_validated:false},null,2)+'\n');
