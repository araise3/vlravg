/* Cross-language ray regressions using full exported immutable map layers. */
'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const math=require('./replay-transcription-viewer.js');
const {sceneRayHit}=require('./replay-visibility-runtime.js');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const [reportPath]=process.argv.slice(2);
if(!reportPath)throw Error('Expected static overlay audit JSON with bvh_proof');
const report=JSON.parse(fs.readFileSync(reportPath));
assert.equal(report.passed,true);
const layers={};
for(const label of ['base','overlay']){
  const proof=report.bvh_proof?.[label];
  assert.ok(proof,'Missing full exported BVH proof: '+label);
  assert.equal(sha(proof.file),proof.sha256,'BVH proof bytes changed');
  assert.equal(proof.source_geometry_sha256,report[label+'_geometry_sha256']);
  const bytes=fs.readFileSync(proof.file);
  const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  layers[label]=math.decodeBVH(buffer);
  assert.equal(layers[label].triangles,proof.triangles);
  assert.equal(layers[label].nodes,proof.nodes);
}
let checks=0,maxError=0;
const equal=(a,b)=>{
  assert.ok(a&&b,'Expected an actual segment obstruction');
  const error=Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
  maxError=Math.max(maxError,error);assert.ok(error<=1e-4,'Python/browser ray result differs: '+error);checks++;
};
for(const ray of report.missing_geometry_examples){
  const {start_cm:start,end_cm:end}=ray;
  const base=math.rayHit(layers.base,start,end),overlay=math.rayHit(layers.overlay,start,end);
  assert.equal(base,null,'Original full base now blocks the supposedly missing wall');checks++;
  equal(overlay,ray.overlay_hit_cm);
  equal(math.rayHit(layers.overlay,end,start),ray.reverse_overlay_hit_cm);
  equal(sceneRayHit([layers.base,layers.overlay],math,start,end),ray.combined_hit_cm);
}
assert.equal(report.native_visual_fidelity_verified,false);
process.stdout.write(JSON.stringify({passed:true,checks,examples:report.missing_geometry_examples.length,
  base_triangles:layers.base.triangles,overlay_triangles:layers.overlay.triangles,
  max_python_js_hit_error_cm:maxError,math_sha256:sha(__dirname+'/replay-transcription-viewer.js'),
  visibility_sha256:sha(__dirname+'/replay-visibility-runtime.js'),
  checker_sha256:sha(__filename),native_visual_fidelity_verified:false})+'\n');
