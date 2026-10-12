/* Compare browser dynamic dependency policy against source-bound Python results. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const runtimePath=path.join(__dirname,'replay-visibility-runtime.js');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const [proofPath]=process.argv.slice(2);
if(!proofPath)throw Error('Expected Python dynamic dependency proof JSON');
const proof=JSON.parse(fs.readFileSync(proofPath));
assert.equal(proof.schema_version,1);
assert.equal(proof.native_visibility_verified,false);
for(const source of proof.sources)assert.equal(sha(source.file),source.sha256,'Source changed: '+source.file);
assert.equal(sha(runtimePath),proof.runtime_sha256,'Browser runtime changed');
assert.equal(sha(__filename),proof.node_checker_sha256,'Node checker changed');
const {dynamicDependencies,segmentIntersectsBounds}=require(runtimePath);
const sidecars=new Map();
for(const replay of proof.replays){
  const sidecar=JSON.parse(fs.readFileSync(replay.file));
  assert.equal(sidecar.match_id,replay.match_id);
  assert.equal(sidecar.schema_version,1);
  assert.equal(sidecar.native_visibility_verified,false);
  assert.equal(sidecar.coverage_complete,false);
  assert.equal(sidecar.instances.length,replay.instances);
  sidecars.set(replay.match_id,sidecar);
}
let dependencies=0,rejectedRounds=0,geometry=0,rejectedGeometry=0;
for(const test of proof.dependency_cases){
  let result,error;
  try{result=dynamicDependencies(sidecars.get(test.match_id),test.start_cm,test.end_cm,test.time_ms,test.round);}
  catch(caught){error=caught;}
  if(test.expected_error){assert.ok(error,'Accepted invalid round: '+test.id);rejectedRounds++;}
  else{if(error)throw error;assert.deepEqual(result,test.expected,'Python/browser dependency differs: '+test.id);dependencies++;}
}
for(const test of proof.geometry_cases){
  let result,error;
  try{result=segmentIntersectsBounds(test.start_cm,test.end_cm,test.bounds_cm);}
  catch(caught){error=caught;}
  if(test.expected_error){assert.ok(error,'Accepted malformed geometry: '+test.id);rejectedGeometry++;}
  else{if(error)throw error;assert.equal(result,test.expected,'Python/browser region differs: '+test.id);geometry++;}
}
for(const source of proof.sources)assert.equal(sha(source.file),source.sha256,'Source changed during check: '+source.file);
assert.equal(sha(runtimePath),proof.runtime_sha256);
process.stdout.write(JSON.stringify({passed:true,replays:proof.replays.length,
  instances:proof.replays.reduce((sum,replay)=>sum+replay.instances,0),
  dependency_checks:dependencies,invalid_round_checks:rejectedRounds,
  geometry_checks:geometry,invalid_geometry_checks:rejectedGeometry,
  native_scope_checks:proof.native_scope_checks,python_proof_sha256:sha(proofPath),
  python_checker_sha256:proof.python_checker_sha256,node_checker_sha256:sha(__filename),
  runtime_sha256:proof.runtime_sha256,assets_sha256:proof.assets_sha256,
  native_visibility_verified:false})+'\n');
