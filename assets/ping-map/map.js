'use strict';
(()=>{
// Observations supplied by the user from the VALORANT selector.
// Unmeasured origins remain distance-adjusted estimates from Berlin.
const BERLIN_REFERENCE=[13.405,52.52];
const TBILISI_REFERENCE=[44.8271,41.7151];
const TBILISI_PINGS={frankfurt:52,paris:59,london:63,warsaw:68,stockholm:74,istanbul:40,madrid:85,riyadh:136};
const PING_SERVERS=[
  {id:'frankfurt',name:'Frankfurt',country:'Germany',coords:[8.6821,50.1109],berlinMs:13},
  {id:'paris',name:'Paris',country:'France',coords:[2.3522,48.8566],berlinMs:19},
  {id:'london',name:'London',country:'United Kingdom',coords:[-.1276,51.5072],berlinMs:24},
  {id:'warsaw',name:'Warsaw',country:'Poland',coords:[21.0122,52.2297],berlinMs:31},
  {id:'stockholm',name:'Stockholm',country:'Sweden',coords:[18.0686,59.3293],berlinMs:35},
  {id:'istanbul',name:'Istanbul',country:'Türkiye',coords:[28.9784,41.0082],berlinMs:44},
  {id:'madrid',name:'Madrid',country:'Spain',coords:[-3.7038,40.4168],berlinMs:46},
  {id:'riyadh',name:'Riyadh',country:'Saudi Arabia',coords:[46.6753,24.7136],berlinMs:97},
];
// Capital reference points, longitude then latitude. Country estimates never
// imply that one capital represents the network routing of the whole country.
const PING_COUNTRIES=[
  ['ALB','Albania','Tirana',19.8187,41.3275],['AND','Andorra','Andorra la Vella',1.5218,42.5063],
  ['AUT','Austria','Vienna',16.3738,48.2082],['BLR','Belarus','Minsk',27.5615,53.9045],
  ['BEL','Belgium','Brussels',4.3517,50.8503],['BIH','Bosnia and Herzegovina','Sarajevo',18.4131,43.8563],
  ['BGR','Bulgaria','Sofia',23.3219,42.6977],['HRV','Croatia','Zagreb',15.9819,45.815],
  ['CYP','Cyprus','Nicosia',33.3823,35.1856],['CZE','Czechia','Prague',14.4378,50.0755],
  ['DNK','Denmark','Copenhagen',12.5683,55.6761],['EST','Estonia','Tallinn',24.7536,59.437],
  ['FIN','Finland','Helsinki',24.9384,60.1699],['FRA','France','Paris',2.3522,48.8566],
  ['DEU','Germany','Berlin',13.405,52.52],['GRC','Greece','Athens',23.7275,37.9838],
  ['HUN','Hungary','Budapest',19.0402,47.4979],['ISL','Iceland','Reykjavík',-21.9426,64.1466],
  ['IRL','Ireland','Dublin',-6.2603,53.3498],['ITA','Italy','Rome',12.4964,41.9028],
  ['KOS','Kosovo','Pristina',21.1655,42.6629],['LVA','Latvia','Riga',24.1052,56.9496],
  ['LIE','Liechtenstein','Vaduz',9.5209,47.141],['LTU','Lithuania','Vilnius',25.2797,54.6872],
  ['LUX','Luxembourg','Luxembourg',6.1319,49.6116],['MLT','Malta','Valletta',14.5146,35.8992],
  ['MDA','Moldova','Chișinău',28.8638,47.0105],['MCO','Monaco','Monaco',7.4246,43.7384],
  ['MNE','Montenegro','Podgorica',19.2594,42.4304],['NLD','Netherlands','Amsterdam',4.9041,52.3676],
  ['MKD','North Macedonia','Skopje',21.4314,41.9981],['NOR','Norway','Oslo',10.7522,59.9139],
  ['POL','Poland','Warsaw',21.0122,52.2297],['PRT','Portugal','Lisbon',-9.1393,38.7223],
  ['ROU','Romania','Bucharest',26.1025,44.4268],['RUS','Russia','Moscow',37.6173,55.7558],
  ['SMR','San Marino','San Marino',12.4473,43.9367],['SRB','Serbia','Belgrade',20.4489,44.7866],
  ['SVK','Slovakia','Bratislava',17.1077,48.1486],['SVN','Slovenia','Ljubljana',14.5058,46.0569],
  ['ESP','Spain','Madrid',-3.7038,40.4168],['SWE','Sweden','Stockholm',18.0686,59.3293],
  ['CHE','Switzerland','Bern',7.4474,46.948],['TUR','Türkiye','Ankara',32.8597,39.9334],
  ['UKR','Ukraine','Kyiv',30.5234,50.4501],['GBR','United Kingdom','London',-.1276,51.5072],
  ['VAT','Vatican City','Vatican City',12.4534,41.9029],['GEO','Georgia','Tbilisi',44.8271,41.7151],
  ['ARM','Armenia','Yerevan',44.5152,40.1872],['AZE','Azerbaijan','Baku',49.8671,40.4093],
  ['KAZ','Kazakhstan','Astana',71.4304,51.1282],['MAR','Morocco','Rabat',-6.8498,34.0209],
  ['DZA','Algeria','Algiers',3.0588,36.7538],['TUN','Tunisia','Tunis',10.1815,36.8065],
  ['LBY','Libya','Tripoli',13.1913,32.8872],['EGY','Egypt','Cairo',31.2357,30.0444],
  ['SYR','Syria','Damascus',36.2765,33.5138],['LBN','Lebanon','Beirut',35.5018,33.8938],
  ['ISR','Israel','Jerusalem',35.2137,31.7683],['PSX','Palestine','Ramallah (reference)',35.2034,31.9038],
  ['JOR','Jordan','Amman',35.9304,31.9539],['IRQ','Iraq','Baghdad',44.3661,33.3152],
  ['IRN','Iran','Tehran',51.389,35.6892],['SAU','Saudi Arabia','Riyadh',46.6753,24.7136],
  ['BHR','Bahrain','Manama',50.586,26.2235],['QAT','Qatar','Doha',51.531,25.2854],
  ['ARE','United Arab Emirates','Abu Dhabi',54.3773,24.4539],['KWT','Kuwait','Kuwait City',47.9774,29.3759],
].map(([code,name,capital,lon,lat])=>({code,name,capital,coords:[lon,lat]})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
const PING_BANDS=[{ms:20,color:'#62dfb4'},{ms:35,color:'#9ad579'},{ms:50,color:'#e2c06c'},{ms:75,color:'#e99a68'},{ms:100,color:'#dc758d'}];
function serverBaseline(server){return server.berlinMs-d3.geoDistance(BERLIN_REFERENCE,server.coords)*6371*.016;}
function estimatePing(from,server){
  const km=d3.geoDistance(from,server.coords)*6371;
  const isBerlin=from[0]===BERLIN_REFERENCE[0]&&from[1]===BERLIN_REFERENCE[1];
  const isTbilisi=from[0]===TBILISI_REFERENCE[0]&&from[1]===TBILISI_REFERENCE[1];
  const observed=isBerlin||isTbilisi,reference=isBerlin?'Berlin':isTbilisi?'Tbilisi':null;
  const ms=isBerlin?server.berlinMs:isTbilisi?TBILISI_PINGS[server.id]:Math.round(Math.max(5,serverBaseline(server)+km*.016));
  const margin=Math.max(5,Math.round(ms*.25));
  return {km,ms,observed,reference,low:Math.max(1,ms-margin),high:ms+margin};
}
function pingColor(ms){return (PING_BANDS.find(b=>ms<b.ms)||PING_BANDS.at(-1)).color;}

let selectedServer=PING_SERVERS[0];
let selectedCountry=PING_COUNTRIES.find(c=>c.code==='DEU');
const countryByCode=new Map(PING_COUNTRIES.map(c=>[c.code,c]));
const projection=d3.geoMercator().center([21,51]).scale(500).translate([500,355]);
const path=d3.geoPath(projection);
const svg=d3.select('#map'),scene=d3.select('#map-scene');
const land=scene.append('g'),rings=scene.append('g').attr('aria-hidden','true'),labels=scene.append('g').attr('aria-hidden','true');
const origin=scene.append('g').attr('class','country-origin').attr('aria-hidden','true');
const pins=scene.append('g');
const countryPaths=land.selectAll('path').data(PING_GEOGRAPHY.features).join('path').attr('d',path).attr('class','country')
  .attr('tabindex',f=>countryByCode.has(f.properties.code)?0:null).attr('role',f=>countryByCode.has(f.properties.code)?'button':null)
  .on('click',(event,f)=>{const c=countryByCode.get(f.properties.code);if(c)selectCountry(c);})
  .on('keydown',(event,f)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();const c=countryByCode.get(f.properties.code);if(c)selectCountry(c);}})
  .on('pointermove',showTooltip).on('pointerleave',hideTooltip);
const largeLabels=new Set(['ISL','IRL','GBR','FRA','ESP','PRT','DEU','ITA','NOR','SWE','FIN','POL','ROU','UKR','RUS','TUR','GRC','DZA','MAR','EGY','SAU','IRN']);
const labelCoords={NOR:[9,64],SWE:[16,64],FIN:[27,64],RUS:[43,61],FRA:[2,46],ESP:[-4,39],ITA:[13,43],TUR:[34,39],DEU:[10.5,51.5],POL:[19,51],GBR:[-3,55],UKR:[32,49],SAU:[44,27],IRN:[55,33]};
labels.selectAll('text').data(PING_COUNTRIES.filter(c=>largeLabels.has(c.code))).join('text').attr('class','country-label').attr('text-anchor','middle')
  .attr('transform',c=>'translate('+projection(labelCoords[c.code]||c.coords)+')').text(c=>c.name.toUpperCase());
// Natural Earth's small-scale map omits some microstates; keep them selectable.
const mappedCodes=new Set(PING_GEOGRAPHY.features.map(f=>f.properties.code));
land.selectAll('circle').data(PING_COUNTRIES.filter(c=>!mappedCodes.has(c.code))).join('circle').attr('class','country')
  .attr('cx',c=>projection(c.coords)[0]).attr('cy',c=>projection(c.coords)[1]).attr('r',2).attr('fill','#63636b').attr('tabindex',0).attr('role','button').attr('aria-label',c=>c.name)
  .on('click',(event,c)=>selectCountry(c)).on('keydown',(event,c)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectCountry(c);}});
const serverPins=pins.selectAll('g').data(PING_SERVERS).join('g').attr('class','server-pin').attr('transform',s=>'translate('+projection(s.coords)+')')
  .attr('tabindex',0).attr('role','button').attr('aria-label',s=>'Select '+s.name+' server').on('click',(event,s)=>selectServer(s))
  .on('keydown',(event,s)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectServer(s);}});
serverPins.append('circle').attr('class','pin-hit').attr('r',22);
serverPins.append('circle').attr('class','halo').attr('r',10);
serverPins.append('circle').attr('class','pin-dot').attr('r',5);
serverPins.append('text').attr('x',s=>['london','paris','riyadh'].includes(s.id)?-12:12).attr('y',s=>s.id==='paris'?17:4)
  .attr('text-anchor',s=>['london','paris','riyadh'].includes(s.id)?'end':'start').text(s=>s.name);
serverPins.each(function(){const group=d3.select(this),box=group.select('text').node().getBBox();group.insert('rect',':first-child').attr('class','pin-hit').attr('x',box.x-6).attr('y',box.y-10).attr('width',box.width+12).attr('height',box.height+20);});
serverPins.append('title').text(s=>s.name+' · '+s.country);

const zoom=d3.zoom().scaleExtent([.7,5]).translateExtent([[-450,-350],[1450,1110]]).extent([[0,0],[1000,760]])
  .on('zoom',event=>{scene.attr('transform',event.transform);positionPins();hideTooltip();});
svg.call(zoom).on('dblclick.zoom',null);
document.getElementById('zoom-in').onclick=()=>svg.call(zoom.scaleBy,1.35);
document.getElementById('zoom-out').onclick=()=>svg.call(zoom.scaleBy,1/1.35);
document.getElementById('reset-map').onclick=()=>svg.call(zoom.transform,d3.zoomIdentity);

// Keep server names and tap targets readable at every map and zoom size.
function positionPins(){
  const screenScale=svg.node().getScreenCTM()?.a;
  if(!screenScale)return;
  const scale=1/(screenScale*d3.zoomTransform(svg.node()).k);
  serverPins.attr('transform',s=>'translate('+projection(s.coords)+') scale('+scale+')');
  rings.selectAll('.ring-label').style('font-size',11*scale+'px').style('stroke-width',3*scale+'px');
}
new ResizeObserver(positionPins).observe(svg.node());

function selectServer(server){selectedServer=server;hideTooltip();render();}
function selectCountry(country){selectedCountry=country;hideTooltip();render();}
function render(){
  document.getElementById('map-server-name').textContent=selectedServer.name;
  serverPins.attr('aria-pressed',s=>s===selectedServer?'true':'false').classed('selected',s=>s===selectedServer);
  serverPins.select('.pin-dot').attr('fill',s=>s===selectedServer?'#60a5fa':'#a1a1aa').attr('r',s=>s===selectedServer?5:4);
  serverPins.select('.halo').attr('visibility',s=>s===selectedServer?'visible':'hidden');
  countryPaths.attr('fill',f=>{const c=countryByCode.get(f.properties.code);return c?d3.color(pingColor(estimatePing(c.coords,selectedServer).ms)).darker(3).formatHex():'#1c1c20';})
    .classed('selected',f=>f.properties.code===selectedCountry.code)
    .attr('aria-label',f=>{const c=countryByCode.get(f.properties.code);return c?c.name+', '+estimatePing(c.coords,selectedServer).ms+' milliseconds from '+c.capital:null;});
  rings.selectAll('*').remove();
  [...PING_BANDS].reverse().forEach(b=>{
    const radiusKm=(b.ms-serverBaseline(selectedServer))/.016;
    if(radiusKm<=0)return;
    const circle=d3.geoCircle().center(selectedServer.coords).radius(radiusKm/6371*180/Math.PI).precision(2)();
    rings.append('path').datum(circle).attr('d',path).attr('class','ring').attr('fill',b.color).attr('fill-opacity',.045).attr('stroke',b.color).attr('stroke-opacity',.6);
    // A true great-circle boundary, not a constant screen-pixel radius.
    const labelPoint=destination(selectedServer.coords,radiusKm,105),p=projection(labelPoint);
    if(p[0]>25&&p[0]<940&&p[1]>95&&p[1]<650)rings.append('text').attr('class','ring-label').attr('x',p[0]+5).attr('y',p[1]-6).attr('fill',b.color).text(b.ms+' ms');
  });
  const p=projection(selectedCountry.coords);
  origin.selectAll('*').remove();
  origin.append('circle').attr('cx',p[0]).attr('cy',p[1]).attr('r',3).attr('fill','#b4b4bd').attr('stroke','#111113').attr('stroke-width',1.5);
  const ping=estimatePing(selectedCountry.coords,selectedServer),readout=document.getElementById('map-readout');
  readout.replaceChildren();
  const route=document.createElement('span');route.textContent=selectedCountry.capital+' → '+selectedServer.name;
  const value=document.createElement('strong');value.style.color=pingColor(ping.ms);value.textContent=(ping.observed?'':'~')+ping.ms+' ms';
  const note=document.createElement('small');note.textContent=ping.observed?'Observed '+ping.reference+' reference':'Capital-based estimate · '+ping.low+'–'+ping.high+' ms';
  readout.append(route,value,note);
  readout.title='Berlin and Tbilisi use observed pings. Other countries are estimated from the Berlin reference plus the distance difference × 0.016 ms/km (5 ms floor). Actual ISP routing may differ.';
  positionPins();
}
function destination([lon,lat],km,bearing){
  const r=Math.PI/180,d=km/6371,b=bearing*r,phi=lat*r,lambda=lon*r;
  const phi2=Math.asin(Math.sin(phi)*Math.cos(d)+Math.cos(phi)*Math.sin(d)*Math.cos(b));
  const lambda2=lambda+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(phi),Math.cos(d)-Math.sin(phi)*Math.sin(phi2));
  return [lambda2/r,phi2/r];
}
function showTooltip(event,feature){
  const c=countryByCode.get(feature.properties.code);if(!c){hideTooltip();return;}
  const t=document.getElementById('tooltip'),ping=estimatePing(c.coords,selectedServer);
  t.replaceChildren();const name=document.createElement('strong');name.textContent=c.name;
  const value=document.createElement('div');value.textContent=(ping.observed?'':'~')+ping.ms+' ms to '+selectedServer.name;value.style.color=pingColor(ping.ms);
  const note=document.createElement('span');note.textContent=ping.observed?'Observed '+ping.reference+' reference':c.capital+' reference · '+ping.low+'–'+ping.high+' ms';t.append(name,value,note);t.hidden=false;
  const panel=document.getElementById('server-ping-map').getBoundingClientRect();
  t.style.left=Math.max(8,Math.min(event.clientX-panel.left+14,panel.width-t.offsetWidth-12))+'px';
  t.style.top=Math.max(8,Math.min(event.clientY-panel.top+14,panel.height-t.offsetHeight-70))+'px';
}
function hideTooltip(){document.getElementById('tooltip').hidden=true;}
render();
})();
