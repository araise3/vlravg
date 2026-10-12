'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const runtime=require('./replay-animation-runtime.js'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(source){
  const index=fs.readFileSync(path.join(source,'index.jsonl')),entries=index.toString().trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  let assets=0,nodes=0,checks=0,eligible=0;const gaps=[];
  for(const row of entries){
    const bytes=fs.readFileSync(path.join(source,row.file));assert.equal(sha(bytes),row.sha256);checks++;
    const record=JSON.parse(zlib.gunzipSync(bytes));
    for(const asset of record.exports){
      assets++;assert.equal(asset.metadata_kind,'typed_blendspace_arrays');checks++;
      const divisions=asset.grid_divisions;if(!divisions){gaps.push({object_path:asset.object_path,reason:'unbound_blendspace_grid_shape'});continue;}
      let gap=null;
      for(let i=0;i<asset.grid.length;i++){
        const node=asset.grid[i];nodes++;assert.equal(node.Indices.length,3);assert.equal(node.Weights.length,3);checks+=2;
        const position=[i%(divisions[0]+1),Math.floor(i/(divisions[0]+1))];
        const input=divisions.map((n,j)=>asset.axes[j].Min+(asset.axes[j].Max-asset.axes[j].Min)*position[j]/n);
        const result=runtime.blendWeights(asset,input);if(!result.known){gap=result.reason;continue;}
        const expected=new Map();let total=0;
        for(let j=0;j<3;j++)if(node.Indices[j]>=0&&node.Weights[j]>0){expected.set(node.Indices[j],(expected.get(node.Indices[j])||0)+node.Weights[j]);total+=node.Weights[j];}
        const actual=new Map(result.samples.map(s=>[s.index,s.weight]));
        for(const id of new Set([...expected.keys(),...actual.keys()])){assert.ok(Math.abs((actual.get(id)||0)-(expected.get(id)||0)/total)<2e-6,asset.object_path+' grid '+i);checks++;}
      }
      if(gap)gaps.push({object_path:asset.object_path,reason:gap});else eligible++;
    }
  }
  return {schema_version:1,packages_verified:entries.length,blendspaces_checked:assets,grid_nodes_checked:nodes,checks,
    instantaneous_grid_weight_assets_checked:eligible,preview_gaps:gaps,reference:'complete_serialized_grid_node_weights',
    index_sha256:sha(index),runtime_sha256:sha(fs.readFileSync(path.join(__dirname,'replay-animation-runtime.js'))),checker_sha256:sha(fs.readFileSync(__filename)),
    native_pose_blending_and_weight_smoothing_validated:false};
}
module.exports={validate};if(require.main===module)process.stdout.write(JSON.stringify(validate(process.argv[2]),null,2)+'\n');
