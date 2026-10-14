const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const d3=require('../assets/ping-map/d3.min.js');
const root=path.join(__dirname,'..');
const regions=vm.runInNewContext(fs.readFileSync(path.join(root,'assets/ping-map/regions.js'),'utf8')+'\nPING_REGIONS');
const source=fs.readFileSync(path.join(root,'assets/ping-map/map.js'),'utf8');
const model=vm.runInNewContext(source.slice(source.indexOf('const BERLIN_REFERENCE='),source.indexOf('let selectedServer='))+
  '\n({estimatePing,serverBaseline,PING_SERVERS,PING_RING_THRESHOLDS,TBILISI_PINGS})',{d3});

test('geodesic ping rings use consecutive 10 ms thresholds',()=>{
  const bands=Array.from(model.PING_RING_THRESHOLDS);
  assert.equal(bands[0],10);assert.equal(bands.at(-1),150);
  for(let i=1;i<bands.length;i++)assert.equal(bands[i]-bands[i-1],10);
  const server=model.PING_SERVERS[0],radius=ms=>(ms-model.serverBaseline(server))/.016;
  assert.ok(Math.abs(radius(40)-radius(30)-625)<1e-8);
});

test('regional geometry stays local and each reference point belongs to its own region',()=>{
  assert.equal(new Set(regions.features.map(f=>f.properties.id)).size,regions.features.length);
  for(const f of regions.features){
    assert.ok(d3.geoArea(f)>0&&d3.geoArea(f)<2*Math.PI,f.properties.name+' must not fill the globe');
    assert.ok(d3.geoContains(f,f.properties.coords),f.properties.name+' reference lies within its boundary');
  }
});

test('all 81 Turkish provinces are available and use distinct regional ping references',()=>{
  const turkey=regions.features.filter(f=>f.properties.countryCode==='TUR');
  assert.equal(turkey.length,81);
  const west=turkey.find(f=>f.properties.name==='Istanbul'),east=turkey.find(f=>f.properties.name==='Van');
  const a=model.estimatePing(west.properties.coords,model.PING_SERVERS[0]);
  const b=model.estimatePing(east.properties.coords,model.PING_SERVERS[0]);
  assert.ok(b.ms-a.ms>=10);assert.equal(a.observed,false);assert.equal(b.observed,false);
});

test('regional selection preserves exact Berlin and Tbilisi observations for every server',()=>{
  for(const [city,country] of [['Berlin','DEU'],['Tbilisi','GEO']]){
    const region=regions.features.find(f=>f.properties.name===city&&f.properties.countryCode===country);
    for(const server of model.PING_SERVERS){
      const ping=model.estimatePing(region.properties.coords,server);
      assert.equal(ping.observed,true);assert.equal(ping.reference,city);
      assert.equal(ping.ms,city==='Berlin'?server.berlinMs:model.TBILISI_PINGS[server.id]);
    }
  }
});
