// Regenerate from Natural Earth's public-domain Admin 1 GeoJSON.
// node scripts/build-ping-map-regions.cjs [source.geojson]
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const d3=require('../assets/ping-map/d3.min.js');
const root=path.resolve(__dirname,'..');
const sourcePath=path.resolve(process.argv[2]||path.join(root,'.local/ping-map/admin1-source.json'));
const bytes=fs.readFileSync(sourcePath),source=JSON.parse(bytes);
const map=fs.readFileSync(path.join(root,'assets/ping-map/map.js'),'utf8');
const countries=vm.runInNewContext(map.slice(map.indexOf('const PING_COUNTRIES='),map.indexOf('const PING_BANDS='))+'\nPING_COUNTRIES');
const geography=vm.runInNewContext(fs.readFileSync(path.join(root,'assets/ping-map/countries.js'),'utf8')+'\nPING_GEOGRAPHY');
// Split geographically broad countries; small countries retain their references.
const broad=new Set(geography.features.filter(f=>{
  const [a,b]=d3.geoBounds(f),lat=(a[1]+b[1])/2,lon=(a[0]+b[0])/2;
  const spanKm=Math.max(d3.geoDistance([a[0],lat],[b[0],lat]),d3.geoDistance([lon,a[1]],[lon,b[1]]))*6371;
  return spanKm>=600||f.properties.code==='GEO';
}).map(f=>f.properties.code));
const byCode=new Map(countries.map(c=>[c.code,c]));
const englishNames=new Map();
for(const f of source.features){const key=f.properties.adm0_a3+':'+f.properties.name_en;englishNames.set(key,(englishNames.get(key)||0)+1);}
function simplify(points,tolerance=.03){
  if(points.length<=4)return points.map(p=>p.map(n=>+n.toFixed(4)));
  const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]];
  while(stack.length){
    const [first,last]=stack.pop(),a=points[first],b=points[last];let distance=tolerance*tolerance,index=-1;
    const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
    for(let i=first+1;i<last;i++){
      const p=points[i],t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;
      const square=(p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2;
      if(square>distance){distance=square;index=i;}
    }
    if(index>=0){keep.add(index);stack.push([first,index],[index,last]);}
  }
  const result=[...keep].sort((a,b)=>a-b).map(i=>points[i].map(n=>+n.toFixed(4)));
  return result.length>=4?result:points.map(p=>p.map(n=>+n.toFixed(4)));
}
const features=source.features.filter(f=>broad.has(f.properties.adm0_a3)&&byCode.has(f.properties.adm0_a3)).map(f=>{
  const p=f.properties,country=byCode.get(p.adm0_a3);
  let coords=[Number(p.longitude),Number(p.latitude)];
  if(!coords.every(Number.isFinite))coords=d3.geoCentroid(f);
  // Keep the two measured city references exact within their own subdivisions.
  if((country.code==='DEU'&&p.name==='Berlin')||(country.code==='GEO'&&p.name==='Tbilisi'))coords=country.coords;
  const polygon=rings=>rings.map((ring,index)=>{
    const result=simplify(ring);
    // Keep D3's spherical exterior/hole winding even for tiny coastal islands.
    // Rounding a nearly degenerate ring can otherwise fill the whole globe.
    const complement=d3.geoArea({type:'Polygon',coordinates:[result]})>2*Math.PI;
    if((index===0&&complement)||(index>0&&!complement))result.reverse();
    return result;
  });
  const feature={type:'Feature',properties:{id:p.adm1_code,countryCode:country.code,
    name:(englishNames.get(p.adm0_a3+':'+p.name_en)>1?p.name:p.name_en)||p.name||p.woe_name,
    type:p.type_en||'Region',coords:coords.map(n=>+n.toFixed(4))},
    geometry:{type:f.geometry.type,coordinates:f.geometry.type==='Polygon'?polygon(f.geometry.coordinates):f.geometry.coordinates.map(polygon)}};
  if(!d3.geoContains(feature,feature.properties.coords)){
    let centroid=d3.geoCentroid(feature);
    if(!d3.geoContains(feature,centroid)&&feature.geometry.type==='MultiPolygon'){
      const largest=feature.geometry.coordinates.map(coordinates=>({type:'Polygon',coordinates}))
        .sort((a,b)=>d3.geoArea(b)-d3.geoArea(a))[0];
      centroid=d3.geoCentroid(largest);
    }
    feature.properties.coords=centroid.map(n=>+n.toFixed(4));
    if(!d3.geoContains(feature,feature.properties.coords))throw new Error('Regional reference lies outside '+p.name);
  }
  return feature;
}).filter(f=>f.properties.name);
const data={type:'FeatureCollection',source:'Natural Earth Admin 1 10m',
  sourceSha256:createHash('sha256').update(bytes).digest('hex'),features};
const output=path.join(root,'assets/ping-map/regions.js');
fs.writeFileSync(output,"'use strict';\nconst PING_REGIONS="+JSON.stringify(data)+';\n');
console.log(`${features.length} regions in ${new Set(features.map(f=>f.properties.countryCode)).size} countries; ${fs.statSync(output).size} bytes.`);
