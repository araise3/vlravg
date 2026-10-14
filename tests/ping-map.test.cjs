const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const d3=require('../assets/ping-map/d3.min.js');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'assets/ping-map/map.js'),'utf8');
const model=vm.runInNewContext(source.slice(source.indexOf('const BERLIN_REFERENCE='),source.indexOf('let selectedServer='))+
  '\n({estimatePing,serverBaseline,PING_SERVERS,PING_RING_THRESHOLDS,TBILISI_PINGS,PING_COUNTRIES})',{d3});

test('geodesic ping rings use consecutive 10 ms thresholds',()=>{
  const bands=Array.from(model.PING_RING_THRESHOLDS);
  assert.equal(bands[0],10);assert.equal(bands.at(-1),150);
  for(let i=1;i<bands.length;i++)assert.equal(bands[i]-bands[i-1],10);
  const server=model.PING_SERVERS[0],radius=ms=>(ms-model.serverBaseline(server))/.016;
  assert.ok(Math.abs(radius(40)-radius(30)-625)<1e-8);
});

test('country selection preserves exact Berlin and Tbilisi observations for every server',()=>{
  for(const [city,country] of [['Berlin','DEU'],['Tbilisi','GEO']]){
    const reference=model.PING_COUNTRIES.find(c=>c.code===country);
    for(const server of model.PING_SERVERS){
      const ping=model.estimatePing(reference.coords,server);
      assert.equal(ping.observed,true);assert.equal(ping.reference,city);
      assert.equal(ping.ms,city==='Berlin'?server.berlinMs:model.TBILISI_PINGS[server.id]);
    }
  }
});
