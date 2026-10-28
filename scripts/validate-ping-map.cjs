'use strict';
// No dependencies beyond the vendored D3. Run: node scripts/validate-ping-map.cjs
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const d3=require('../assets/ping-map/d3.min.js');
const root=path.join(__dirname,'..');
function loadModel(){
  const source=fs.readFileSync(path.join(root,'assets/ping-map/map.js'),'utf8');
  return vm.runInNewContext(source.slice(source.indexOf('const BERLIN_REFERENCE='),source.indexOf('let selectedServer='))+
    '\n({PING_SERVERS,PING_DISTANCE_SLOPE,routingModels,fitRoutingModel,pingSurface})',{d3});
}
function summarize(rows){
  const errors=rows.map(r=>r.predicted-r.observed);
  return {n:rows.length,mae:d3.mean(errors,e=>Math.abs(e)),rmse:Math.sqrt(d3.mean(errors,e=>e*e)),
    bias:d3.mean(errors),maxError:d3.max(errors,e=>Math.abs(e))};
}
function validate(model=loadModel()){
  const methods=['Current interpolation','Distance + median offset','Nearest measured city','Median measured ping'];
  const rows=[];
  for(const server of model.PING_SERVERS){
    const samples=model.routingModels.get(server.id).samples;
    for(const held of samples){
      // Refit offsets and their median from the remaining training origins. Never reuse
      // the full model baseline or the observed-coordinate shortcut in estimatePing.
      const training=samples.filter(s=>s.name!==held.name);
      const fitted=model.fitRoutingModel(server,training);
      const serverKm=d3.geoDistance(held.coords,server.coords)*6371;
      const nearest=d3.least(training,s=>d3.geoDistance(held.coords,s.coords));
      const predictions=[model.pingSurface(held.coords,server,fitted),
        Math.max(5,fitted.baseline+serverKm*model.PING_DISTANCE_SLOPE),nearest.ms,d3.median(training,s=>s.ms)];
      predictions.forEach((predicted,i)=>rows.push({method:methods[i],city:held.name,server:server.name,
        observed:held.ms,predicted,error:predicted-held.ms,trainingCities:training.map(s=>s.name)}));
    }
  }
  const current=rows.filter(r=>r.method===methods[0]);
  const grouped=key=>Array.from(d3.group(current,r=>r[key]),([name,group])=>({name,...summarize(group)}));
  return {origins:new Set(current.map(r=>r.city)).size,comparisons:current.length,
    methods:methods.map(name=>({name,...summarize(rows.filter(r=>r.method===name))})),
    byCity:grouped('city'),byServer:grouped('server'),rows};
}
function formatReport(result){
  const number=n=>n.toFixed(2);
  const table=(label,groups)=>`| ${label} | MAE | RMSE | Bias | Largest error |\n|---|---:|---:|---:|---:|\n`+
    groups.map(g=>`| ${g.name} | ${number(g.mae)} | ${number(g.rmse)} | ${number(g.bias)} | ${number(g.maxError)} |`).join('\n');
  const current=result.rows.filter(r=>r.method===result.methods[0].name);
  const worst=d3.greatest(current,r=>Math.abs(r.error));
  const gain=result.methods[1].mae-result.methods[0].mae;
  const details=result.byCity.map(({name})=>`### ${name} held out\n\n`+
    '| Server | Screenshot | Predicted | Error |\n|---|---:|---:|---:|\n'+
    current.filter(r=>r.city===name).map(r=>`| ${r.server} | ${r.observed} | ${number(r.predicted)} | ${number(r.error)} |`).join('\n')).join('\n\n');
  return `# Ping map: held-origin validation\n\n`+
    `Reproduce with \`node scripts/validate-ping-map.cjs\`. Use \`--json\` for full precision results or \`--write docs/ping-map-validation.md\` to regenerate this report.\n\n`+
    `Each of ${result.origins} origins is hidden in turn, including all eight of its server readings. Each server model is rebuilt using the other ${result.origins-1} origins only, including recalculating its median routing offset. The current model is evaluated through the actual production ping surface with that training model. Parameters stay fixed at 0.016 ms/km and 1000 km influence; no parameter search is performed.\n\n`+
    `There are ${result.comparisons} city/server predictions, but only ${result.origins} distinct geographic holdouts. The eight server readings from one connection are related, so these are not ${result.comparisons} independent geographic samples. Predictions are scored before display rounding. Errors are predicted minus observed; positive bias means overprediction. All metrics are milliseconds.\n\n`+
    `## Model comparison\n\n${table('Method',result.methods)}\n\n`+
    `Baselines use only training origins: distance plus median routing offset omits the local correction; nearest city copies the nearest origin's ping; median ping ignores geography. The old Berlin-only model is excluded because it cannot hold Berlin out without leaking its reading.\n\n`+
    `The current interpolation's mean absolute error is ${number(result.methods[0].mae)} ms versus ${number(result.methods[1].mae)} ms for the distance baseline, ${gain>=0?'an improvement':'a deterioration'} of ${number(Math.abs(gain))} ms on these holdouts. Its worst prediction is ${worst.city} → ${worst.server}: ${number(worst.predicted)} ms versus ${worst.observed} ms observed. This is evidence of a routing difference the remaining origins do not predict, not evidence that the held-out reading is wrong.\n\n`+
    `## Current model by hidden city\n\n${table('City',result.byCity)}\n\n`+
    `## Current model by server\n\n${table('Server',result.byServer)}\n\n`+
    `## Individual predictions\n\n${details}\n\n`+
    `## Interpretation limits\n\n`+
    `This evaluates prediction at unseen origins, rather than the exact fit at known samples. A fold outside the remaining origins' coverage also tests extrapolation. This small set of cities cannot establish Europe-wide accuracy, ISP-specific behavior, temporal variation, or calibrated prediction intervals. Passing software tests does not establish predictive accuracy.\n\n`+
    `Treat these results as a diagnostic baseline. Changing parameters to improve this report would turn these same origins into tuning data; a later accuracy claim needs new held-out origins or a separate nested validation design. The estimate layer and current parameters are unchanged by this evaluation.\n`;
}
if(require.main===module){
  const result=validate(),args=process.argv.slice(2);
  if(args.includes('--json'))process.stdout.write(JSON.stringify(result,null,2)+'\n');
  else{
    const report=formatReport(result),write=args.indexOf('--write');
    if(write!==-1){
      if(!args[write+1])throw new Error('--write requires a report path');
      fs.writeFileSync(path.resolve(args[write+1]),report);
    }
    process.stdout.write(report);
  }
}
module.exports={loadModel,validate,summarize,formatReport};
