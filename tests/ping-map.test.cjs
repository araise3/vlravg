const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const d3=require('../assets/ping-map/d3.min.js');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'assets/ping-map/map.js'),'utf8');
const model=vm.runInNewContext(source.slice(source.indexOf('const BERLIN_REFERENCE='),source.indexOf('let selectedServer='))+
  '\n({estimatePing,pingSurface,buildPingContours,routingModels,serverBaseline,PING_SERVERS,PING_RING_THRESHOLDS,TBILISI_PINGS,PING_COUNTRIES})',{d3});

test('ping contours use consecutive 10 ms thresholds',()=>{
  const bands=Array.from(model.PING_RING_THRESHOLDS);
  assert.equal(bands[0],10);assert.equal(bands.at(-1),150);
  for(let i=1;i<bands.length;i++)assert.equal(bands[i]-bands[i-1],10);
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

test('the continuous field approaches every screenshot without a jump',()=>{
  for(const server of model.PING_SERVERS){
    for(const sample of model.routingModels.get(server.id).samples){
      for(const delta of [-.00001,.00001]){
        const nearby=model.pingSurface([sample.coords[0]+delta,sample.coords[1]],server);
        assert.ok(Math.abs(nearby-sample.ms)<.001,`${sample.name} to ${server.name}: ${nearby}`);
      }
    }
  }
});

test('each observation influences estimates outside the exact measured coordinate',()=>{
  for(const server of model.PING_SERVERS){
    const routing=model.routingModels.get(server.id);
    for(const sample of routing.samples){
      const nearby=[sample.coords[0]+.1,sample.coords[1]+.1];
      const before=model.pingSurface(nearby,server);
      const original=sample.offset;
      try{
        sample.offset+=10;
        assert.ok(model.pingSurface(nearby,server)-before>9,`${sample.name} to ${server.name}`);
      }finally{sample.offset=original;}
    }
  }
});

test('equal server distances can have different pings due to routing samples',()=>{
  const server=model.PING_SERVERS.find(s=>s.id==='stockholm');
  const circle=d3.geoCircle().center(server.coords).radius(10).precision(5)().coordinates[0];
  const values=circle.map(coords=>model.pingSurface(coords,server));
  assert.ok(Math.max(...values)-Math.min(...values)>5);
});

test('the surface stays finite and positive across the map for every server',()=>{
  for(const server of model.PING_SERVERS)for(let lat=15;lat<=75;lat+=5)for(let lon=-30;lon<=80;lon+=5){
    const value=model.pingSurface([lon,lat],server);
    assert.ok(Number.isFinite(value)&&value>=5,`${server.name} at ${lon},${lat}`);
  }
});

test('contours follow the ping field and retain interior hole boundaries',()=>{
  const projection=d3.geoMercator().center([21,51]).scale(500).translate([500,355]);
  let holeCount=0,checked=0;
  for(const server of model.PING_SERVERS){
    const contours=model.buildPingContours(server,projection);
    assert.equal(contours.length,15);
    for(const contour of contours)for(const points of contour.lines){
      // Grid-edge closures are deliberately excluded from rendered lines.
      const interior=points.filter(p=>p[2]);
      if(!interior.length)continue;
      if(interior.length===points.length&&d3.polygonArea(points)<0)holeCount++;
      for(let i=0;i<interior.length;i+=30){
        const point=interior[i],value=model.pingSurface(projection.invert(point),server);
        assert.ok(Math.abs(value-contour.ms)<1.5,`${server.name} ${contour.ms} contour: ${value}`);
        checked++;
      }
    }
  }
  assert.ok(checked>100);
  assert.ok(holeCount>0,'routing field produces holes that must remain in the contours');
});

test('Finland, UK and Spain use the Helsinki, Luton and Jerez screenshot readings',()=>{
  const screenshots=[
    {code:'FIN',city:'Helsinki',coords:[24.9384,60.1699],pings:[33,39,38,28,15,63,64,117]},
    {code:'GBR',city:'Luton',coords:[-.4175,51.8787],pings:[17,13,8,37,34,49,40,104]},
    {code:'ESP',city:'Jerez',coords:[-6.137,36.685],pings:[42,34,41,59,60,71,19,108]},
  ];
  for(const screenshot of screenshots){
    const country=model.PING_COUNTRIES.find(c=>c.code===screenshot.code);
    assert.equal(country.capital,screenshot.city);
    assert.deepEqual(Array.from(country.coords),screenshot.coords);
    model.PING_SERVERS.forEach((server,i)=>{
      const ping=model.estimatePing(country.coords,server);
      assert.equal(ping.observed,true);assert.equal(ping.reference,screenshot.city);
      assert.equal(ping.ms,screenshot.pings[i]);
    });
  }
});
