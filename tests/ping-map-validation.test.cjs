const test=require('node:test'),assert=require('node:assert/strict');
const {loadModel,validate,summarize}=require('../scripts/validate-ping-map.cjs');

test('validation holds out each complete origin and scores every server',()=>{
  const result=validate();
  assert.equal(result.origins,5);assert.equal(result.comparisons,40);
  assert.equal(result.rows.length,160);
  for(const method of result.methods){
    const rows=result.rows.filter(r=>r.method===method.name);
    assert.equal(new Set(rows.map(r=>r.city+'/'+r.server)).size,40);
    for(const row of rows){
      assert.equal(row.trainingCities.length,4);
      assert.ok(!row.trainingCities.includes(row.city));
      assert.ok(Number.isFinite(row.predicted));
    }
  }
});

test('hidden readings cannot affect their own predictions or fitted baseline',()=>{
  const model=loadModel(),before=validate(model);
  for(const city of ['Berlin','Tbilisi','Helsinki','Luton','Jerez']){
    const changed=loadModel();
    for(const routing of changed.routingModels.values()){
      routing.samples.find(s=>s.name===city).ms+=1000;
      // Poison the full-data baseline too: evaluation must refit from training.
      routing.baseline=10000;
    }
    const after=validate(changed);
    for(let i=0;i<before.rows.length;i++)if(before.rows[i].city===city){
      assert.equal(after.rows[i].predicted,before.rows[i].predicted);
      assert.equal(after.rows[i].observed,before.rows[i].observed+1000);
    }
  }
});

test('summary metrics measure absolute, squared and signed errors correctly',()=>{
  const result=summarize([{predicted:13,observed:10},{predicted:6,observed:10}]);
  assert.equal(result.n,2);assert.equal(result.mae,3.5);
  assert.equal(result.rmse,Math.sqrt(12.5));assert.equal(result.bias,-.5);assert.equal(result.maxError,4);
});
