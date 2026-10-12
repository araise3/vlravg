/* Self-contained canvas reviewer. Replay math also runs in Node for checks. */
(function () {
  'use strict';
  const RAD = Math.PI / 180;
  const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub = (a, b) => a.map((v, i) => v-b[i]);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const length = a => Math.hypot(...a);
  const forward = (yaw, pitch) => [Math.cos(pitch*RAD)*Math.cos(yaw*RAD), Math.cos(pitch*RAD)*Math.sin(yaw*RAD), Math.sin(pitch*RAD)];
  const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a,b)/(length(a)*length(b)))))/RAD;
  function latest(track, time, maxGap = 100) {
    let low = 0, high = track.length;
    while (low < high) { const mid = (low+high)>>1; if (track[mid][0] <= time) low=mid+1; else high=mid; }
    const row = track[low-1];
    return row && time-row[0] <= maxGap ? row : null;
  }
  function project(observer, point, width, height, fov = 103, eyeHeight = 77, aspect = 16/9) {
    const yaw = observer[4]*RAD, pitch = observer[5]*RAD;
    const eye = [observer[1], observer[2], observer[3]+eyeHeight];
    const delta = sub(point, eye), fwd = forward(observer[4], observer[5]);
    const right = [-Math.sin(yaw), Math.cos(yaw), 0];
    const up = [-Math.sin(pitch)*Math.cos(yaw), -Math.sin(pitch)*Math.sin(yaw), Math.cos(pitch)];
    const depth = dot(delta, fwd), tanH = Math.tan(fov*RAD/2), tanV = tanH/aspect;
    const nx = depth > 0 ? dot(delta,right)/depth/tanH : Math.sign(dot(delta,right)||1)*3;
    const ny = depth > 0 ? -dot(delta,up)/depth/tanV : 0;
    return {x: (nx+1)*width/2, y: (ny+1)*height/2, depth, nx, ny, inside: depth>0 && Math.abs(nx)<=1 && Math.abs(ny)<=1};
  }
  function decodeBVH(buffer) {
    const h = new DataView(buffer);
    if (h.getUint32(0, true) !== 0x56425256 || h.getUint32(12, true) !== 1) throw Error('Invalid geometry bundle');
    const nodes=h.getUint32(4,true), triangles=h.getUint32(8,true);
    if (16+nodes*40+triangles*36 !== buffer.byteLength) throw Error('Geometry size mismatch');
    return {nodes, triangles, bounds:new Float32Array(buffer,16,nodes*6), links:new Int32Array(buffer,16+nodes*24,nodes*4), vertices:new Float32Array(buffer,16+nodes*40,triangles*9)};
  }
  function rayHit(mesh, start, end, firstOnly=false) {
    const d=sub(end,start), {bounds,links,vertices} = mesh;
    let best=1.000001, hit=null;
    const pending=mesh.nodes ? [0] : [];
    while (pending.length) {
      const node=pending.pop(), b=node*6, link=node*4;
      let enter=0, leave=best;
      for (let axis=0; axis<3; axis++) {
        if (Math.abs(d[axis])<1e-12) {
          if (start[axis]<bounds[b+axis] || start[axis]>bounds[b+3+axis]) { enter=1;leave=0;break; }
        } else {
          const a=(bounds[b+axis]-start[axis])/d[axis], z=(bounds[b+3+axis]-start[axis])/d[axis];
          enter=Math.max(enter,Math.min(a,z)); leave=Math.min(leave,Math.max(a,z));
          if (enter>leave) break;
        }
      }
      if (enter>leave) continue;
      if (links[link]>=0) {pending.push(links[link],links[link+1]);continue;}
      const offset=links[link+2], count=links[link+3];
      for (let i=offset; i<offset+count; i++) {
        const o=i*9;
        const a=[vertices[o],vertices[o+1],vertices[o+2]];
        const e1=[vertices[o+3]-a[0],vertices[o+4]-a[1],vertices[o+5]-a[2]];
        const e2=[vertices[o+6]-a[0],vertices[o+7]-a[1],vertices[o+8]-a[2]];
        const p=cross(d,e2), det=dot(e1,p);
        if (Math.abs(det)<=1e-8) continue;
        const s=sub(start,a), u=dot(s,p)/det;
        if(u < -1e-7 || u>1.0000001) continue;
        const q=cross(s,e1), v=dot(d,q)/det;
        if(v < -1e-7 || u+v>1.0000001) continue;
        const t=dot(e2,q)/det;
        if(t>1e-5 && t<best && t<.99999) {best=t;hit=start.map((x,j)=>x+t*d[j]);if(firstOnly)return hit;}
      }
    }
    return hit;
  }
  function curveValue(keys,x){
    const i=keys.findIndex(k=>k[0]>x)-1;
    if(x<keys[0][0])return keys[0][1];
    if(i<0)return keys[keys.length-1][1];
    const a=keys[i],b=keys[i+1],delta=b[0]-a[0],u=(x-a[0])/delta;
    if(a[2]===1)return a[1];
    if(a[2]===0)return a[1]+u*(b[1]-a[1]);
    return (2*u**3-3*u*u+1)*a[1]+(u**3-2*u*u+u)*delta*a[4]+(-2*u**3+3*u*u)*b[1]+(u**3-u*u)*delta*b[3];
  }
  function smokeRadius(profile,ageMs){
    const age=ageMs-profile.delay_ms;
    if(age<0||age>=profile.duration_ms+profile.contract_ms)return 0;
    const scale=age<profile.expand_ms?curveValue(profile.expand_curve.keys,age/profile.expand_ms):age<profile.duration_ms?1:curveValue(profile.contract_curve.keys,(age-profile.duration_ms)/profile.contract_ms);
    return profile.radius_cm*Math.max(0,Math.min(1,scale));
  }
  function sphereSegment(start,end,center,radius){
    const d=sub(end,start),q=sub(start,center),r=sub(end,center),a=dot(d,d),b=2*dot(q,d),c=dot(q,q)-radius*radius,disc=b*b-4*a*c;
    const roots=a<1e-12||disc<=0?[]:[(-b-Math.sqrt(disc))/(2*a),(-b+Math.sqrt(disc))/(2*a)];
    return {boundary:roots.some(t=>t>=0&&t<=1),insideObserver:dot(q,q)<radius*radius,insideTarget:dot(r,r)<radius*radius};
  }
  function shellMesh(source,scale){
    const vertices=new Float32Array(source.indices.length*3),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<source.indices.length;i++)for(let j=0;j<3;j++){const v=source.vertices[source.indices[i]][j]*scale[j];vertices[i*3+j]=v;low[j]=Math.min(low[j],v);high[j]=Math.max(high[j],v);}
    return {nodes:1,triangles:source.indices.length/3,bounds:new Float32Array([...low,...high]),links:new Int32Array([-1,-1,0,source.indices.length/3]),vertices};
  }
  function smokeIntersection(profile,start,end,center,radius,mesh){
    const hit=sphereSegment(start,end,center,radius);
    if(!mesh)return hit;
    const factor=radius/profile.radius_cm,broad=sphereSegment(start,end,center,profile.boundary_shell.bounding_radius_cm*factor);
    hit.boundary=false;
    if(Object.values(broad).some(Boolean))hit.boundary=Boolean(rayHit(mesh,sub(start,center).map(x=>x/factor),sub(end,center).map(x=>x/factor)));
    return hit;
  }
  function weaponFov(camera,subject,t,roundStart){
    const active=latest(camera?.active_weapon?.[subject]||[],t,Infinity);
    const setting=active&&active[0]>=roundStart?latest(camera.weapon_fov[String(active[1])]||[],t,Infinity):null;
    if(!setting)return {fov:camera?.fallback_fov_deg||103,kind:'fallback'};
    const [start,source,target,duration]=setting,u=duration>0?Math.max(0,Math.min(1,(t-start)/duration)):1;
    return {fov:u>=1?target:source+(target-source)*u,kind:u<1?'transition estimate':'recorded target',weapon:active[1],weaponFovTarget:setting[5]??null};
  }
  function stanceFraction(rows,t){
    const row=latest(rows,t,Infinity);if(!row)return 0;
    const [start,from,to,duration]=row,u=duration>0?Math.max(0,Math.min(1,(t-start)/duration)):1;
    return from+(to-from)*u;
  }
  function stanceGeometry(model,rows,t){
    const fraction=stanceFraction(rows,t),c=model.camera,half=model.capsule.half_height_cm-model.capsule.radius_cm;
    const low=-half+c.crouch_compression_cm*fraction,high=half+(c.crouched_eye_cm-c.standing_eye_cm)*fraction;
    return {fraction,eyeHeight:c.standing_eye_cm+(c.crouched_eye_cm-c.standing_eye_cm)*fraction,offsets:[low,(low+high)/2,high]};
  }
  function visionAt(effects,subject,t,roundIndex){return effects.filter(s=>s.subject===subject&&s.round===roundIndex&&s.start_ms<=t&&t<s.end_ms);}
  function lifeAt(rows,t,roundStart,deaths=[]){const row=latest(rows,t,Infinity);return row&&row[0]>=roundStart?row[1]:!deaths.some(x=>x>=roundStart&&x<=t);}
  const math = {forward, angleBetween, latest, project, decodeBVH, rayHit,curveValue,smokeRadius,sphereSegment,weaponFov,shellMesh,smokeIntersection,stanceFraction,stanceGeometry,visionAt,lifeAt};
  if (typeof module !== 'undefined') module.exports = math;
  if (typeof document === 'undefined') return;
  window.ReplayMath = math;
  const $ = id => document.getElementById(id);
  const colors={blue:'#2785bd',red:'#d32f2f',green:'#3aa34d',amber:'#f39c12',muted:'#c6c6c6',text:'#222222'};
  const stateColors=[colors.muted,colors.red,colors.amber,colors.green];
  let data, mesh, mapImage, mapSketch, bundle, originalLabels, namesKey;
  let round, observer, target, selectedKill=null,selectedVision=null, time=0, playing=false, speed=.5, scope='clip', filter='turns';
  let range=[0,1], lastFrame=0, timeline=[], timelineToken=0, timelineBusy=false, mapFocused=true,smokeEnabled=true,stanceEnabled=true,visionEnabled=true;
  const timelineCache=new Map(), players=new Map(), deathCache=new Map(),smokeMeshes=new Map();
  let statePage=0,stateRecordRows=[],evaluateFrame,evaluatePair;
  let nativeReport=null,nativeTimeline=[],nativeAvailable=false,nativeBusy=false,nativeGeneration=0,nativeController=null,nativeMessage='',visibilityInputs={},analysisData=null;
  const nativeCache=new Map();
  const label=p => p ? `${p.name||p.slot} (${p.agent})` : 'Environment / unresolved';
  const seconds = ms => (ms/1000).toFixed(2)+' s';
  const clock = ms => `${Math.floor(ms/60000)}:${(ms/1000%60).toFixed(2).padStart(5,'0')}`;
  const roundAt = t => data.rounds.find(r=>t>=r.start_ms&&t<r.end_ms)||data.rounds[data.rounds.length-1];
  const shortName = p => p?.name||p?.slot||'Environment';
  // The reference colors are relative to the selected observer's team.
  const teamColor = p => p.team===players.get(observer)?.team?colors.blue:colors.red;
  const font = size => `${size}px ReplayReference, "DejaVu Sans", sans-serif`;
  function figureScale(){const s=$('stage').getBoundingClientRect().width/1200;$('stage').style.setProperty('--ui-scale',s);return s;}
  function makeMapSketch(){
    const canvas=document.createElement('canvas');canvas.width=mapImage.width;canvas.height=mapImage.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(mapImage,0,0);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),p=image.data;
    for(let i=0;i<p.length;i+=4){
      const a=p[i+3]/255,luma=.2126*p[i]+.7152*p[i+1]+.0722*p[i+2];
      const grey=luma>240?250:Math.round(luma*.6+57);
      p[i]=Math.round(grey*a+250*(1-a));p[i+1]=p[i];p[i+2]=Math.round(grey*a+247*(1-a));p[i+3]=255;
    }
    ctx.putImageData(image,0,0);return canvas;
  }
  function resize(canvas) {
    const box=canvas.getBoundingClientRect(), ratio=Math.min(window.devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(box.width)), h=Math.max(1,Math.round(box.height));
    if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);return {ctx,w,h};
  }
  function deathTime(subject) {
    const life=latest(data.asset_state?.observations?.life_states?.[subject]||[],time,Infinity);
    if(life&&life[0]>=round.start_ms)return life[1]?Infinity:life[0];
    return data.kills.find(k=>k.round===round.index&&k.victim===subject)?.time_ms??Infinity;
  }
  function alive(subject,t) {return lifeAt(data.asset_state?.observations?.life_states?.[subject]||[],t,round.start_ms,data.kills.filter(k=>k.round===round.index&&k.victim===subject).map(k=>k.time_ms));}
  function playerPose(subject,t,showDead=false) {
    if(!subject) return null;
    const live=alive(subject,t),life=latest(data.asset_state?.observations?.life_states?.[subject]||[],t,Infinity);
    const stop=live?Infinity:life&&life[0]>=round.start_ms?life[0]:data.kills.find(k=>k.round===round.index&&k.victim===subject)?.time_ms??Infinity;
    if(!live&&!showDead) return null;
    const row=latest(viewTrack(subject,t),Math.min(t,stop-1));
    return row&&row[0]>=round.start_ms?row:null;
  }
  function viewTrack(subject,t){return nativeReport&&t>=nativeReport.window_ms[0]&&t<=nativeReport.window_ms[1]&&nativeReport.movement_tracks?.[subject]||data.tracks[subject]||[];}
  function inBounds(row) {
    const [lo,hi]=data.geometry.bounds_cm;
    return row.slice(1,4).every((v,i)=>v>=lo[i]&&v<=hi[i]);
  }
  function frameState(subject=observer,t=time){return evaluateFrame?evaluateFrame(subject,t,round):null;}
  function lens(t=time){return frameState(observer,t)?.camera||weaponFov(data.asset_state?.camera,observer,t,round.start_ms);}
  function stance(subject,t=time){return stanceEnabled&&data.asset_state?.model?(frameState(subject,t)?.stance||stanceGeometry(data.asset_state.model,[],t)):{fraction:0,eyeHeight:data.projection.eye_height_cm,offsets:data.projection.body_offsets_cm};}
  function vision(subject=observer,t=time){return frameState(subject,t)?.vision||[];}
  function projectView(a,point,w,h,t=time){return project(a,point,w,h,lens(t).fov,stance(observer,t).eyeHeight,data.projection.aspect);}
  function activeSmokes(t){
    const state=analysisData?.asset_state||data.asset_state;
    if(!smokeEnabled||!state?.model)return [];
    return state.smokes.filter(s=>s.round===round.index&&t>=s.start_ms&&t<s.end_ms).map(s=>{
      const profile=state.model.smoke_profiles[s.profile],radius=smokeRadius(profile,t-s.start_ms),position=latest(s.positions,t,Infinity);
      return {...s,profile,radius,center:position?.slice(1,4)};
    }).filter(s=>s.radius>0&&s.center);
  }
  function sightline(t) {
    return evaluatePair(observer,target,t,round,{smoke:smokeEnabled,crouch:stanceEnabled,tracks:nativeReport?.movement_tracks||data.tracks});
  }
  function viewSize(){const b=$('view-canvas').getBoundingClientRect();return {w:Math.max(1,b.width),h:Math.max(1,b.height)};}
  function viewSpeed(subject,t) {
    const track=viewTrack(subject,t), a=playerPose(subject,t), b=latest(track,t-100);
    if(!a||!b||a[0]<=b[0]||a[0]-b[0]>160) return null;
    return angleBetween(forward(a[4],a[5]),forward(b[4],b[5]))*1000/(a[0]-b[0]);
  }
  function mapWindow() {
    if(!mapFocused)return {u:0,v:0,span:1};
    const t=selectedKill?.time_ms??selectedVision?.start_ms??time;
    const a=playerPose(observer,t-1,true),b=playerPose(target,t-1,true);
    if(!a||!b)return {u:0,v:0,span:1};
    const m=data.map, distance=Math.hypot(a[1]-b[1],a[2]-b[2]);
    const span=Math.min(.95,Math.max(3000,distance*1.6+1400)*Math.abs(m.x_multiplier));
    const u=(a[2]+b[2])*.5*m.x_multiplier+m.x_scalar;
    const v=(a[1]+b[1])*.5*m.y_multiplier+m.y_scalar;
    return {u:Math.max(0,Math.min(1-span,u-span/2)),v:Math.max(0,Math.min(1-span,v-span/2)),span};
  }
  function mapPoint(row,w,h) {
    const m=data.map;
    const view=mapWindow();
    return [(row[2]*m.x_multiplier+m.x_scalar-view.u)/view.span*w,(row[1]*m.y_multiplier+m.y_scalar-view.v)/view.span*h];
  }
  function person(ctx,x,y,size,crouch=0){
    if(crouch>.05){
      const lower=size*crouch*.35;ctx.beginPath();ctx.arc(x,y-size*.7+lower,size*.18,0,Math.PI*2);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x,y-size*.5+lower);ctx.lineTo(x-size*.1,y+size*.2);
      ctx.lineTo(x+size*.45,y+size*.4);ctx.lineTo(x+size*.35,y+size*.75);ctx.moveTo(x-size*.1,y+size*.2);
      ctx.lineTo(x-size*.45,y+size*.45);ctx.lineTo(x-size*.5,y+size*.75);ctx.moveTo(x-size*.4,y+lower-size*.15);ctx.lineTo(x+size*.4,y+lower-size*.15);ctx.stroke();return;
    }
    ctx.beginPath();ctx.arc(x,y-size*.7,size*.18,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x,y-size*.5);ctx.lineTo(x,y+size*.25);
    ctx.moveTo(x-size*.45,y-size*.15);ctx.lineTo(x+size*.45,y-size*.15);
    ctx.moveTo(x,y+size*.25);ctx.lineTo(x-size*.4,y+size*.75);
    ctx.moveTo(x,y+size*.25);ctx.lineTo(x+size*.4,y+size*.75);ctx.stroke();
  }
  function drawMap(result) {
    const {ctx,w,h}=resize($('map-canvas')), s=figureScale(),view=mapWindow();
    ctx.clearRect(0,0,w,h);ctx.drawImage(mapSketch,view.u*mapSketch.width,view.v*mapSketch.height,view.span*mapSketch.width,view.span*mapSketch.height,0,0,w,h);
    for(const smoke of activeSmokes(time)){
      const [x,y]=mapPoint([0,...smoke.center],w,h),r=smoke.radius*Math.abs(data.map.x_multiplier)*w/view.span;
      ctx.fillStyle='rgba(132,100,174,.18)';ctx.strokeStyle='#8160a7';ctx.lineWidth=s;ctx.setLineDash([4*s,3*s]);ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.setLineDash([]);ctx.font=font(10*s);ctx.fillStyle='#73528d';ctx.textAlign='center';ctx.fillText(smoke.profile.agent+' smoke',x,y-r-4*s);
    }
    // Long thin heading rays and two-line player labels match the video figure.
    for(const p of data.players){
      const row=playerPose(p.subject,time);if(!row)continue;
      const [x,y]=mapPoint(row,w,h),color=teamColor(p),yaw=row[4]*RAD;
      const rayLength=p.subject===observer?w*.72:65*s;
      ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.sin(yaw)*rayLength,y-Math.cos(yaw)*rayLength);
      ctx.strokeStyle=color;ctx.globalAlpha=p.subject===observer ? .85 : .5;ctx.lineWidth=(p.subject===observer?1:.6)*s;ctx.stroke();ctx.globalAlpha=1;
    }
    if(result.a&&result.b) {
      const a=mapPoint(result.a,w,h), b=mapPoint(result.b,w,h);
      ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineWidth=2.5*s;ctx.setLineDash(result.blocked?[7*s,6*s]:[]);ctx.strokeStyle=result.known?(result.blocked===3?colors.red:result.blocked?colors.amber:colors.green):colors.muted;ctx.stroke();ctx.setLineDash([]);
      if(result.hit){const hit=mapPoint([0,...result.hit],w,h);ctx.strokeStyle='#623d36';ctx.lineWidth=5*s;ctx.beginPath();ctx.moveTo(hit[0]-6*s,hit[1]-5*s);ctx.lineTo(hit[0]+6*s,hit[1]+5*s);ctx.stroke();ctx.font=font(12*s);ctx.textAlign='left';ctx.fillStyle='#623d36';ctx.fillText('sight blocked here',hit[0]+7*s,hit[1]+17*s);}
    }
    for(const p of data.players) {
      const row=playerPose(p.subject,time,true);if(!row)continue;
      const [x,y]=mapPoint(row,w,h), live=alive(p.subject,time), color=teamColor(p);
      ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=(p.subject===observer?2:1.4)*s;ctx.textAlign='left';
      if(live){
        person(ctx,x,y,(p.subject===observer?16:12)*s,stance(p.subject).fraction);
        ctx.font=font((p.subject===observer?12:10)*s);ctx.fillText(shortName(p),x+8*s,y+2*s);ctx.fillText(p.agent,x+8*s,y+18*s);
      }else{
        ctx.lineWidth=2*s;ctx.beginPath();ctx.moveTo(x-6*s,y-6*s);ctx.lineTo(x+6*s,y+6*s);ctx.moveTo(x+6*s,y-6*s);ctx.lineTo(x-6*s,y+6*s);ctx.stroke();
        const death=data.kills.find(k=>k.round===round.index&&k.victim===p.subject);
        ctx.font=font(10*s);ctx.fillText(death?.death_type==='self_or_environment'?'self/environment':`killed by ${shortName(players.get(death?.killer))}`,x+8*s,y+3*s);
      }
      if(p.subject===target&&live){ctx.beginPath();ctx.arc(x,y,16*s,0,Math.PI*2);ctx.strokeStyle='#111';ctx.lineWidth=1.5*s;ctx.stroke();}
    }
    const scale=1000*Math.abs(data.map.x_multiplier)*w/view.span;
    ctx.strokeStyle='#555';ctx.lineWidth=3*s;ctx.beginPath();ctx.moveTo(11*s,h-11*s);ctx.lineTo(11*s+scale,h-11*s);ctx.stroke();ctx.font=font(12*s);ctx.fillStyle='#555';ctx.fillText('10 m',14*s+scale,h-7*s);
  }
  function drawView(result) {
    const {ctx,w,h}=resize($('view-canvas')),s=figureScale();
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#cadceb';ctx.fillRect(0,0,w,h);
    const a=playerPose(observer,time);
    if(a)for(const smoke of activeSmokes(time)){
      const eye=[a[1],a[2],a[3]+stance(observer).eyeHeight],inside=length(sub(eye,smoke.center))<smoke.radius;
      ctx.fillStyle='rgba(132,100,174,.15)';
      if(inside){ctx.fillRect(0,0,w,h);continue;}
      const mid=projectView(a,smoke.center,w,h);if(mid.depth<=0)continue;
      const radius=Math.min(w*3,smoke.radius/mid.depth/(Math.tan(lens().fov*RAD/2))*w/2);
      // Projected circle is illustrative; the actual intersection uses XYZ spheres.
      ctx.beginPath();ctx.ellipse(mid.x,mid.y,radius,radius*h*data.projection.aspect/w,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(115,82,141,.5)';ctx.lineWidth=s;ctx.stroke();
    }
    if(a) for(const p of data.players){
      if(p.subject===observer||p.team===players.get(observer).team)continue;
      const b=playerPose(p.subject,time);if(!b)continue;
      const shape=stance(p.subject),offsets=shape.offsets;
      const mid=projectView(a,[b[1],b[2],b[3]+offsets[1]],w,h), head=projectView(a,[b[1],b[2],b[3]+offsets[2]],w,h), foot=projectView(a,[b[1],b[2],b[3]+offsets[0]],w,h);
      if(mid.depth<=0||Math.abs(mid.nx)>1.3||Math.abs(mid.ny)>1.4)continue;
      const selected=p.subject===target, ghost=selected&&result.blocked===3;
      const size=Math.max(4,Math.min(22,Math.abs(foot.y-head.y)*.17));
      ctx.globalAlpha=selected?1:.45;ctx.strokeStyle=selected?(ghost?colors.red:result.smokeBoundary||result.smokeInside?'#8160a7':result.blocked?colors.amber:colors.green):colors.red;ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=(selected?1.5:1)*s;ctx.setLineDash(ghost||selected&&result.smokeBoundary?[4*s,4*s]:[]);
      ctx.beginPath();ctx.arc(head.x,head.y,size*.4,0,Math.PI*2);ctx.stroke();
      ctx.beginPath();ctx.moveTo(head.x,head.y+size*.4);ctx.lineTo(mid.x,mid.y);
      if(shape.fraction>.05){const bend=size*(1+shape.fraction),kneeY=(mid.y+foot.y)*.5;ctx.lineTo(mid.x+bend,kneeY);ctx.lineTo(foot.x+size*.5,foot.y);ctx.moveTo(mid.x,mid.y);ctx.lineTo(mid.x-bend,kneeY);ctx.lineTo(foot.x-size*.5,foot.y);}
      else{ctx.lineTo(foot.x-size*.5,foot.y);ctx.moveTo(mid.x,mid.y);ctx.lineTo(foot.x+size*.5,foot.y);}
      ctx.moveTo(mid.x-size,mid.y-size);ctx.lineTo(mid.x+size,mid.y-size);ctx.stroke();ctx.setLineDash([]);
      ctx.font=font(12*s);ctx.textAlign='center';ctx.fillText(shortName(p)+(shape.fraction>.5?' · crouch model':''),head.x,head.y-size-8*s);ctx.globalAlpha=1;
    }
    ctx.strokeStyle='#00d889';ctx.lineWidth=1.4*s;ctx.beginPath();ctx.moveTo(w/2-10*s,h/2);ctx.lineTo(w/2+10*s,h/2);ctx.moveTo(w/2,h/2-10*s);ctx.lineTo(w/2,h/2+10*s);ctx.stroke();
    if(result.a&&result.b&&!result.inside){
      const p=projectView(result.a,result.b.slice(1,4),w,h),d=sub(result.b.slice(1,4),[a[1],a[2],a[3]+stance(observer).eyeHeight]);
      const yaw=a[4]*RAD, fwd=forward(a[4],a[5]),right=[-Math.sin(yaw),Math.cos(yaw),0],up=cross(fwd,right);
      const horizontal=Math.atan2(dot(d,right),dot(d,fwd))/RAD,vertical=Math.atan2(dot(d,up),Math.hypot(dot(d,right),dot(d,fwd)))/RAD;
      ctx.font=font(20*s);ctx.fillStyle='#e74c3c';
      if(Math.abs(p.nx)>=Math.abs(p.ny)){ctx.textAlign=p.nx>0?'right':'left';ctx.fillText((p.nx>0?'→ ':'← ')+Math.round(Math.abs(horizontal))+'°',p.nx>0?w-12*s:6*s,h/2+9*s);}
      else{ctx.textAlign='center';ctx.fillText((p.ny>0?'↓ ':'↑ ')+Math.round(Math.abs(vertical))+'°',Math.max(40*s,Math.min(w-40*s,p.x)),p.ny>0?h-66*s:100*s);}
    }
    if(!a||!alive(target,time)){ctx.font=font(16*s);ctx.fillStyle='#e74c3c';ctx.textAlign='center';ctx.fillText(!alive(target,time)?shortName(players.get(target))+' dead':result.reason,w/2,h/2-40*s);}
    if(visionEnabled&&a)for(const effect of vision()){
      // This cue represents a recorded effect interval. It is not Riot's shader,
      // blind intensity, distance cutoff or a claim about actual player perception.
      if(effect.kind==='flash'){ctx.fillStyle='rgba(255,249,222,.65)';ctx.fillRect(0,0,w,h);}
      else{const profile=data.asset_state.model.vision_profiles[effect.profile],c=profile.asset_defaults.OccluderBaseColor||{R:.03,G:.01,B:.08};
        const channel=v=>Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055));const rgb=[c.R,c.G,c.B].map(channel).join(',');
        const fade=ctx.createRadialGradient(w/2,h/2,Math.min(w,h)*.12,w/2,h/2,Math.max(w,h)*.65);fade.addColorStop(0,`rgba(${rgb},.08)`);fade.addColorStop(1,`rgba(${rgb},.8)`);ctx.fillStyle=fade;ctx.fillRect(0,0,w,h);}
    }
    if(a){
      const cx=w-58*s,cy=98*s,r=41*s;ctx.fillStyle='#fafaf7';ctx.strokeStyle='#333';ctx.lineWidth=s;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.font=font(12*s);ctx.textAlign='center';ctx.fillStyle='#555';ctx.fillText('N',cx,cy-r-5*s);
      for(let t=time-1000;t<=time;t+=50){const p=playerPose(observer,t);if(!p)continue;ctx.beginPath();ctx.arc(cx+Math.sin(p[4]*RAD)*r*.9,cy-Math.cos(p[4]*RAD)*r*.9,2*s,0,Math.PI*2);ctx.fillStyle='#8771e7';ctx.globalAlpha=.25+.75*(t-(time-1000))/1000;ctx.fill();ctx.globalAlpha=1;}
      const rate=viewSpeed(observer,time);ctx.strokeStyle=rate>1000?colors.red:colors.amber;ctx.lineWidth=2.5*s;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.sin(a[4]*RAD)*r*.9,cy-Math.cos(a[4]*RAD)*r*.9);ctx.stroke();ctx.font=font(10*s);ctx.fillStyle='#555';ctx.fillText('heading, last 1 s',cx,cy+r+15*s);
    }
  }
  function drawMetrics(result) {
    const a=result.a,b=result.b;
    $('distance').textContent=a&&b?(length(sub(a.slice(1,4),b.slice(1,4)))/100).toFixed(1)+' m':'—';
    $('angle').textContent=a&&b?angleBetween(forward(a[4],a[5]),sub(b.slice(1,4),[a[1],a[2],a[3]+stance(observer).eyeHeight])).toFixed(1)+'°':'—';
    const rate=viewSpeed(observer,time);$('speed').textContent=rate===null?'—':Math.round(rate)+'°/s';
    $('heading').textContent=a?Math.round(a[4])+'°':'—';
    const candidate=result.contact.state,status=!result.known?'n/a':candidate==='direct'?'CLEAR BODY RAY · MODEL':candidate==='unknown'?'VISIBILITY UNRESOLVED':result.state===1?'WALL BLOCKED · MODEL':result.inside?'SMOKE BLOCKED · MODEL':'OUTSIDE VIEW · MODEL';
    const color=!result.known||candidate==='unknown'?colors.muted:candidate==='direct'?colors.green:colors.red;
    $('sightline-status').textContent=status;$('sightline-status').style.background=color;
    $('status-dot').style.background=color;
    const mapCode=data.map.path.split('/').pop();
    $('geometry-status').textContent=result.known?`map geometry ${mapCode}: ${result.blocked===3?'occluded':result.blocked?'mixed':'clear'}`:'';
    const camera=lens();$('view-title').textContent=shortName(players.get(observer))+`'s view (approx., ${camera.fov.toFixed(1)}° FOV)`;
    const crouch=latest(data.asset_state?.camera?.crouch_inputs?.[observer]||[],time,Infinity);
    const shape=stance(observer),effects=vision();
    const impairment=result.effect_assessment,visionNote=effects.length?'Observed '+effects.map(e=>e.name).join(' + ')+'.':impairment?.tails.length?'Asset fade window; final vision clearance unverified.':impairment?.candidate_reasons.length?'Vision impairment evidence unresolved.':'No positive vision impairment observed.';
    const occluders=(result.ability_dependencies?.length||0)+(result.dynamic_dependencies?.length||0),conditionalSmokes=activeSmokes(time).filter(s=>s.activation_clock_verified===false).length;
    $('asset-readout').textContent=`World FOV: ${camera.kind}. ${activeSmokes(time).length} smoke volumes${conditionalSmokes?' ('+conditionalSmokes+' with unverified activation timing)':''}. ${crouch?'Crouch input '+(crouch[1]?'held':'released')+'. ':''}${stanceEnabled?'Stance model '+Math.round(shape.fraction*100)+'% crouched; eye +'+shape.eyeHeight.toFixed(1)+' cm.':'Standing projection.'} ${visionNote}${occluders?' '+occluders+' unresolved wall or moving-object dependencies.':''}`;
    $('vision-status').textContent=effects.length?effects.map(e=>e.name.toUpperCase()).join(' + ')+' · RPC OBSERVED':impairment?.candidate_reasons.length?'VISION IMPAIRMENT UNRESOLVED':'';
    $('vision-status').hidden=!$('vision-status').textContent;
    $('stance-status').textContent=stanceEnabled?'stance model: '+(shape.fraction>.99?'crouched':shape.fraction<.01?'standing':Math.round(shape.fraction*100)+'% crouch'):'';
    if($('state-history').open){const state=frameState(),active=state?.effects||[],names=new Map();for(const e of active)names.set(e.name,(names.get(e.name)||0)+1);$('state-live').textContent='Observed active effects: '+([...names].map(([name,count])=>name+(count>1?' ×'+count:'')).join(' · ')||'none')+(camera.weaponFovTarget!==null&&camera.weaponFovTarget!==undefined?` · weapon mesh FOV target ${camera.weaponFovTarget.toFixed(1)}°`:'')+` · ${state?.gaps?.length||0} unresolved rendering dependencies`;
      if($('behavior-state')?.open)$('behavior-detail').textContent=JSON.stringify(state,null,2);}
    $('turn-readout').textContent=rate===null?'view turning n/a':`view turning  ${Math.round(rate)}°/s`;
    $('turn-revolutions').textContent=rate!==null&&rate>=1000?`= ${(rate/360).toFixed(1)} full turns/s`:'';
    $('turn-readout').style.color=$('turn-revolutions').style.color=rate>1000?colors.red:colors.amber;
    $('view-caption').textContent=a&&b?`${shortName(players.get(target))} is ${(length(sub(a.slice(1,4),b.slice(1,4)))/100).toFixed(1)} m away, crosshair ${$('angle').textContent} from target center`:'';
    $('time').textContent=`replay t = ${(time/1000).toFixed(2)} s | ${speed}x speed | ${label(players.get(observer))} → ${label(players.get(target))}`;
    $('seek').value=Math.round(time);
    $('visibility-now').textContent=`Visibility evidence: ${result.visibility.state}. Model: ${candidate}.`;
    if($('visibility-detail').open)$('visibility-evidence').textContent=JSON.stringify({time_ms:time,observer,target,source_pose_times_ms:result.source_pose_times_ms,
      evidence:result.visibility,model:result.contact,observed_effects:result.observed_effects,effect_assessment:result.effect_assessment,camera_dependencies:result.camera_dependencies,
      pose_assessment:result.pose_assessment||null,smoke_dependencies:result.smoke_dependencies||[],
      ability_dependencies:result.ability_dependencies,dynamic_dependencies:result.dynamic_dependencies,geometry_overlays:visibilityInputs.geometry_overlays,
      smoke_inputs_sha256:visibilityInputs.smoke_inputs_sha256,ability_inputs_sha256:visibilityInputs.ability_inputs_sha256,dynamic_inputs_sha256:visibilityInputs.dynamic_inputs_sha256,display_models:{smoke:smokeEnabled,crouch:stanceEnabled},
      model_limits:['Three centerline capsule points; animated body silhouette unresolved','Camera height and FOV transitions are estimates','Static geometry and effect coverage incomplete','Smoke interiors and flash fade unresolved']},null,2);
  }
  function drawTimeline() {
    const {ctx,w,h}=resize($('timeline')),s=figureScale(),left=140*s,right=w,plot=right-left,span=Math.max(1,range[1]-range[0]);
    const x=t=>left+(t-range[0])/span*plot;
    ctx.clearRect(0,0,w,h);ctx.font=font(12*s);ctx.fillStyle='#222';ctx.textAlign='left';
    const mapCode=data.map.path.split('/').pop();
    [[mapCode+' (used)',14],['flagged window',29],['turn speed',45],[shortName(players.get(observer))+' shots/deaths',61],['smoke (model)',77],['vision evidence',93],['crouch (model)',109]].forEach(([text,y])=>ctx.fillText(text,10*s,y*s));
    ctx.fillStyle=colors.muted;ctx.fillRect(left,2*s,plot,13*s);
    const plotted=nativeReport?nativeTimeline:timeline;
    for(let i=0;i<plotted.length;i++){
      const row=plotted[i],end=i+1<plotted.length?plotted[i+1].t:range[1];
      ctx.fillStyle=stateColors[row.state];ctx.fillRect(x(row.t),2*s,Math.max(1,Math.ceil(x(end)-x(row.t))+1),13*s);
      if(smokeEnabled&&row.smoke){ctx.fillStyle='#8160a7';ctx.fillRect(x(row.t),66*s,Math.max(1,Math.ceil(x(end)-x(row.t))+1),12*s);}
      if(row.visionUncertain){ctx.fillStyle=row.visualTail?'#b5a0cc':'#766683';ctx.fillRect(x(row.t),82*s,Math.max(1,Math.ceil(x(end)-x(row.t))+1),12*s);}
      if(stanceEnabled&&row.crouch>0){ctx.fillStyle=`rgba(39,133,189,${.25+.75*row.crouch})`;ctx.fillRect(x(row.t),98*s,Math.max(1,Math.ceil(x(end)-x(row.t))+1),12*s);}
      if(row.speed!==null){ctx.fillStyle=row.speed>1000?colors.red:colors.amber;const bar=Math.max(1.2*s,Math.min(14*s,row.speed/3000*14*s));ctx.fillRect(x(row.t),47*s-bar,Math.max(.6,x(end)-x(row.t)),bar);}
    }
    // Exact observed interval boundaries, including effects shorter than 50 ms.
    for(const effect of data.asset_state.vision_effects||[])if(effect.subject===observer&&effect.round===round.index&&effect.start_ms<range[1]&&effect.end_ms>range[0]){ctx.fillStyle=effect.kind==='flash'?'#dcaa3d':'#624098';ctx.fillRect(x(Math.max(range[0],effect.start_ms)),82*s,Math.max(s,x(Math.min(range[1],effect.end_ms))-x(Math.max(range[0],effect.start_ms))),12*s);}
    // The long black band denotes the candidate's review context, rather than
    // stretching the measured 94 ms turn into a misleading long turn.
    if(selectedKill?.rapid_turn){const start=Math.max(range[0],selectedKill.time_ms-1800),end=Math.min(range[1],selectedKill.time_ms+1600);ctx.fillStyle='#3d3d3d';ctx.fillRect(x(start),20*s,Math.max(s,x(end)-x(start)),10*s);}
    ctx.lineWidth=s;
    const deathLabels=[];
    for(const e of data.events){
      if(e.time_ms<range[0]||e.time_ms>range[1])continue;
      const px=x(e.time_ms);
      if(e.kind==='shot'&&e.subject===observer){ctx.strokeStyle='#111';ctx.beginPath();ctx.moveTo(px,51*s);ctx.lineTo(px,63*s);ctx.stroke();}
      if(e.kind==='characterDeath'){const p=players.get(e.victim);deathLabels.push({px,text:shortName(p)+' dies',color:p?teamColor(p):'#777'});}
      if(e.kind.startsWith('spike')){ctx.fillStyle=colors.amber;ctx.beginPath();ctx.moveTo(px,51*s);ctx.lineTo(px+4*s,57*s);ctx.lineTo(px,63*s);ctx.lineTo(px-4*s,57*s);ctx.closePath();ctx.fill();}
    }
    ctx.font=font(10*s);ctx.textAlign='left';
    let previousEnd=-Infinity;
    for(const d of deathLabels){const width=ctx.measureText(d.text).width+12*s,px=Math.max(left+3*s,Math.min(w-width,d.px));const lane=px<previousEnd?1:0;const y=(125+lane*12)*s;ctx.fillStyle=d.color;ctx.fillText('×',px-6*s,y);ctx.fillText(d.text,px+3*s,y);previousEnd=px+width;}
    ctx.strokeStyle='#111';ctx.lineWidth=1.5*s;ctx.beginPath();ctx.moveTo(x(time),0);ctx.lineTo(x(time),h-3*s);ctx.stroke();
    const legendY=h-17*s,entries=[['in view',colors.green],['behind wall',colors.red],['partly',colors.amber]];let legendX=w-340*s;
    ctx.font=font(11*s);ctx.textAlign='left';
    for(const [text,color] of entries){ctx.fillStyle=color;ctx.fillRect(legendX,legendY,13*s,13*s);ctx.fillStyle='#222';ctx.fillText(text,legendX+17*s,legendY+11*s);legendX+=110*s;}
    if(timelineBusy){ctx.textAlign='right';ctx.font=font(10*s);ctx.fillStyle='#666';ctx.fillText('Calculating static sightline…',right-10*s,46*s);}
  }
  function draw() {if(!data||!mapImage.complete)return;const result=sightline(time);drawMap(result);drawView(result);drawMetrics(result);drawTimeline();}
  async function prepareTimeline() {
    resetNative();
    const token=++timelineToken,key=[...range,round.index,observer,target,smokeEnabled,stanceEnabled,...Object.values(viewSize()).map(Math.round)].join(':');
    if(timelineCache.has(key)){timeline=timelineCache.get(key);timelineBusy=false;renderVisibilityContacts();draw();maybeNative();return;}
    timeline=[];timelineBusy=true;$('download-visibility').disabled=true;renderVisibilityContacts();draw();const rows=[];
    const times=new Set();for(let t=range[0];t<=range[1];t+=50)times.add(t);times.add(range[1]);
    const boundary=t=>{if(t>=range[0]&&t<=range[1])times.add(t)};
    for(const e of [...(data.asset_state?.vision_effects||[]),...(analysisData.asset_state?.smokes||[])])if(e.round===round.index){
      boundary(e.start_ms);boundary(e.end_ms);boundary(e.channel_open_ms??e.positions?.[0]?.[0]);boundary(e.channel_close_ms);
    }
    for(const row of data.asset_state?.observations?.blind_observations||[])if(row.subject===observer&&row.round===round.index)boundary(row.time_ms);
    for(const e of [...(data.asset_state?.vision_effects||[]),...(data.asset_state?.observations?.continuous_effects||[])])if(e.round===round.index){
      boundary(e.start_ms);boundary(e.end_ms);const rule=visibilityInputs.tail_rules?.classes?.[e.profile||e.effect_class];
      if(e.end_reason==='observed_stop_rpc'&&rule)boundary(Math.min(e.end_ms+rule.duration_seconds*1000,round.end_ms));
    }
    for(const interval of visibilityInputs.camera_body?.remote_viewpoint_intervals||[])if(interval.subject===observer&&interval.round===round.index){boundary(interval.start_ms);boundary(interval.end_ms);}
    for(const t of window.ReplayVisibility.dependencyTimes(visibilityInputs))boundary(t);
    for(const subject of [observer,target])for(const row of data.asset_state?.observations?.life_states?.[subject]||[])boundary(row[0]);
    const ordered=[...times].sort((a,b)=>a-b);
    for(let i=0;i<ordered.length;i++){
      if(token!==timelineToken)return;
      const t=ordered[i];
      const sight=sightline(t);rows.push({t,state:sight.state,smoke:sight.smokeBoundary||sight.smokeInside,speed:viewSpeed(observer,t),crouch:alive(observer,t)?stance(observer,t).fraction:0,
        candidate:sight.contact.state,visibility:sight.visibility.state,reasons:sight.visibility.reasons,model_reasons:sight.contact.reasons,
        pose_times_ms:sight.source_pose_times_ms,ability_dependencies:sight.ability_dependencies,dynamic_dependencies:sight.dynamic_dependencies,visionUncertain:sight.effect_assessment?.candidate_reasons.some(r=>r!=='observer_frame_unresolved'),visualTail:Boolean(sight.effect_assessment?.tails.length),life:[frameState(observer,t)?.alive,frameState(target,t)?.alive].join(':')});
      if(i%80===79){timeline=rows;drawTimeline();await new Promise(resolve=>requestAnimationFrame(resolve));}
    }
    if(token!==timelineToken)return;
    timeline=rows;timelineBusy=false;timelineCache.set(key,rows);if(timelineCache.size>30)timelineCache.delete(timelineCache.keys().next().value);renderVisibilityContacts();draw();maybeNative();
  }
  function contactReport(){
    if(nativeReport)return nativeReport;
    const samples=field=>timeline.map(r=>({time_ms:r.t,observer,target,round:round.index,life:r.life,state:r[field],reasons:field==='candidate'?r.model_reasons:r.reasons}));
    return {schema_version:1,producer:'replay-visibility-runtime-v1',match_id:data.match_id,replay_build:data.replay_build,clock:data.clock,observer,target,round:round.index,window_ms:range.slice(),
      validated_player_visibility:false,source_provenance:data.source_provenance,visibility_inputs_sha256:bundle.visibility_inputs_sha256,geometry:data.geometry.kind,geometry_complete:data.geometry.complete,geometry_overlays:visibilityInputs.geometry_overlays,
      display_models:{smoke:smokeEnabled,crouch:stanceEnabled},sample_period_ms:50,pose_sampling_ms:data.playback_sample_ms,
      timing_bounds_scope:'Evaluator sample brackets only; native render timing and pose sampling error unvalidated',
      visibility:window.ReplayVisibility.intervals(samples('visibility')),model:window.ReplayVisibility.intervals(samples('candidate')),
      samples:timeline.map(r=>({time_ms:r.t,visibility:r.visibility,model:r.candidate,reasons:r.reasons,model_reasons:r.model_reasons,pose_times_ms:r.pose_times_ms,ability_dependencies:r.ability_dependencies,dynamic_dependencies:r.dynamic_dependencies}))};
  }
  function renderVisibilityContacts(){
    const body=$('visibility-contacts');body.replaceChildren();$('download-visibility').disabled=timelineBusy;
    if(timelineBusy){$('visibility-coverage').textContent='Calculating selected pair…';$('visibility-json').textContent='Calculating selected pair…';return;}
    const report=contactReport(),unknown=report.visibility.unknown_samples;
    if($('visibility-export').open)$('visibility-json').textContent=visibilityPreview(report);
    $('visibility-coverage').textContent=`${report.model.contacts.length} model contact intervals; ${unknown}/${report.samples.length} samples have unresolved visibility evidence. ${nativeReport?'Original movement timestamps and observed effect boundaries.':'Overview samples at most 50 ms apart.'} These contacts are review candidates.`;
    for(const contact of report.model.contacts){
      const row=document.createElement('tr'),seek=document.createElement('button');seek.textContent=clock(contact.first_visible_sample_ms);
      seek.onclick=()=>{setPlaying(false);time=contact.first_visible_sample_ms;draw();};
      const start=document.createElement('td');start.append(seek);const acquisition=document.createElement('td');acquisition.textContent=contact.acquisition_bounds_ms?contact.acquisition_bounds_ms.join('–')+' ms':contact.start_reason.replaceAll('_',' ');
      const end=document.createElement('td');end.textContent=contact.loss_bounds_ms?contact.loss_bounds_ms.join('–')+' ms':contact.end_reason.replaceAll('_',' ');
      row.append(start,acquisition,end);body.append(row);
    }
  }
  function visibilityPreview(report){
    const reasons={};for(const sample of report.samples)for(const reason of sample.reasons||[])reasons[reason]=(reasons[reason]||0)+1;
    return JSON.stringify({preview_only:true,producer:report.producer,match_id:report.match_id,observer:report.observer,target:report.target,
      window_ms:report.window_ms,sample_count:report.samples.length,unresolved_sample_count:report.visibility.unknown_samples,
      validated_player_visibility:report.validated_player_visibility,provenance:report.provenance||report.source_provenance,
      display_models:report.display_models,model_contacts:report.model.contacts.slice(0,100),visibility_contacts:report.visibility.contacts.slice(0,100),
      evidence_reason_counts:reasons,note:'Download visibility evidence for all movement samples, body rays, observations and interval segments.'},null,2);
  }
  function resetNative(){
    nativeGeneration++;nativeController?.abort();nativeController=null;nativeReport=null;nativeTimeline=[];nativeBusy=false;nativeMessage='';renderNativeStatus();
  }
  function renderNativeStatus(){
    $('analyze-native').disabled=!nativeAvailable||nativeBusy||timelineBusy;
    $('native-status').textContent=nativeMessage||(!nativeAvailable?'Original movement analysis requires the local replay service.':scope==='clip'?'Moment clips are analyzed automatically.':'Analyze this round using the original movement samples.');
  }
  function nativeRequest(){return {match_id:data.match_id,observer,target,start_ms:Math.round(range[0]),end_ms:Math.round(range[1]),smoke:smokeEnabled,crouch:stanceEnabled};}
  function installNative(report,request){
    if(report.match_id!==request.match_id||report.observer!==request.observer||report.target!==request.target||report.window_ms[0]!==request.start_ms||report.window_ms[1]!==request.end_ms||
        report.display_models?.smoke!==request.smoke||report.display_models?.crouch!==request.crouch)throw Error('Analysis result differs from the selected encounter');
    if(bundle.visibility_runtime_sha256&&report.provenance.evaluator_sha256!==bundle.visibility_runtime_sha256)throw Error('Visibility code changed; reload the viewer');
    if(bundle.visibility_effects_sha256&&report.provenance.effects_sha256!==bundle.visibility_effects_sha256)throw Error('Vision effect code changed; reload the viewer');
    if(bundle.visibility_inputs_sha256&&report.provenance.visibility_inputs_sha256!==bundle.visibility_inputs_sha256)throw Error('Visibility evidence changed; reload the viewer');
    nativeReport=report;
    nativeTimeline=report.samples.map(s=>({t:s.time_ms,state:s.wall_state,smoke:s.smoke_intersects,visionUncertain:s.effect_assessment?.candidate_reasons.some(r=>r!=='observer_frame_unresolved'),visualTail:Boolean(s.effect_assessment?.tails.length),speed:viewSpeed(observer,s.time_ms),crouch:alive(observer,s.time_ms)?stance(observer,s.time_ms).fraction:0}));
    nativeMessage=`Original movement: ${report.samples.length} samples analyzed.`;nativeBusy=false;
    renderVisibilityContacts();renderNativeStatus();draw();
  }
  function maybeNative(){renderNativeStatus();if(nativeAvailable&&scope==='clip'&&!timelineBusy&&!nativeBusy&&!nativeReport)requestNative();}
  async function loadNativeService(){
    if(!/^https?:$/.test(location.protocol))return;
    try{const response=await fetch('/visibility/status');if(response.ok&&(await response.json()).available){nativeAvailable=true;maybeNative();}}catch{}renderNativeStatus();
  }
  async function requestNative(){
    if(!nativeAvailable||nativeBusy||timelineBusy)return;
    const request=nativeRequest(),key=JSON.stringify(request),generation=nativeGeneration;
    if(nativeCache.has(key)){installNative(nativeCache.get(key),request);return;}
    nativeController=new AbortController();const signal=nativeController.signal;nativeBusy=true;nativeMessage='Analyzing original movement…';renderNativeStatus();
    try{
      let response=await fetch('/visibility/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal});
      let job=await response.json();if(!response.ok)throw Error(job.error||'Unable to start analysis');
      while(job.status==='queued'||job.status==='running'){
        nativeMessage=job.status==='queued'?'Original movement analysis queued…':'Analyzing original movement…';renderNativeStatus();
        await new Promise(resolve=>setTimeout(resolve,700));if(signal.aborted||generation!==nativeGeneration)return;
        response=await fetch('/visibility/jobs/'+job.id,{signal});job=await response.json();if(!response.ok)throw Error(job.error||'Unable to read analysis status');
      }
      if(job.status!=='complete')throw Error(job.error||'Analysis failed');
      response=await fetch(job.report_url,{signal});if(!response.ok)throw Error('Analysis output unavailable');const report=await response.json();
      if(generation!==nativeGeneration)return;installNative(report,request);nativeCache.set(key,report);if(nativeCache.size>8)nativeCache.delete(nativeCache.keys().next().value);
    }catch(error){if(signal.aborted||generation!==nativeGeneration)return;nativeBusy=false;nativeMessage=error.message;renderNativeStatus();}
  }
  function updateRange() {
    range=scope==='clip'&&selectedKill?[Math.max(round.start_ms,selectedKill.time_ms-2500),Math.min(round.end_ms-1,selectedKill.time_ms+2000)]:scope==='clip'&&selectedVision?[Math.max(round.start_ms,selectedVision.start_ms-1000),Math.min(round.end_ms-1,selectedVision.end_ms+1000)]:[round.start_ms,round.end_ms-1];
    time=Math.max(range[0],Math.min(range[1],time));$('seek').min=range[0];$('seek').max=range[1];
    $('scope-clip').classList.toggle('active',scope==='clip');$('scope-round').classList.toggle('active',scope==='round');$('scope-clip').disabled=!selectedKill&&!selectedVision;$('jump-kill').disabled=!selectedKill&&!selectedVision;$('jump-kill').textContent=selectedVision?'Jump to effect':'Jump to death';
    $('timeline-note').textContent=`${seconds(range[1]-range[0])} window · 50 ms samples`;prepareTimeline();
  }
  function option(select,value,text) {const o=document.createElement('option');o.value=value;o.textContent=text;select.append(o);}
  function targetOptions() {
    const select=$('target');select.replaceChildren();const op=players.get(observer);
    for(const p of data.players)if(p.team!==op.team)option(select,p.subject,label(p));
    if(![...select.options].some(o=>o.value===target))target=select.options[0].value;select.value=target;
  }
  function updateMoment() {
    $('round').value=round.index;$('observer').value=observer;targetOptions();$('map-focus').textContent=mapFocused?'Full map':'Focus fight';
    $('view-title').textContent=shortName(players.get(observer))+"'s view (approx., 103° FOV)";
    if(selectedKill){
      const k=selectedKill,turn=k.rapid_turn;
      $('moment-title').textContent=turn?`Round ${round.number}: ${shortName(players.get(k.killer))} snaps onto ${label(players.get(k.victim))}, view jumps ${Math.round(turn.angle_deg)}° in ${(turn.duration_ms/1000).toFixed(1)} s; kills them`:k.death_type==='self_or_environment'?`Round ${round.number}: ${label(players.get(k.victim))} dies (self/environment)`:`Round ${round.number}: ${label(players.get(k.killer))} kills ${label(players.get(k.victim))}`;
      const lines=[k.death_type==='self_or_environment'?`t=${k.time_ms} ms  ${label(players.get(k.victim))} dies in a self/environment event.`:`t=${k.time_ms} ms  ${label(players.get(k.killer))} kills ${label(players.get(k.victim))}.`];
      if(k.distance_m!==undefined)lines.push(`At death: ${k.distance_m} m apart; approximate center aim angle ${k.aim_error_deg}°; static body rays ${k.static_sightline.status}.`);
      const smoke=k.smoke_sightline;if(smoke&&(smoke.boundary_crossings.length||smoke.observer_inside.length||smoke.target_inside.length))lines.push(`Smoke asset model at death: ${smoke.boundary_crossings.length} center-ray shell crossing(s); observer inside ${smoke.observer_inside.length}, target inside ${smoke.target_inside.length}. Interior vision and activation remain unverified.`);
      if(k.vision_effect_ids?.length)lines.push('Killer has an observed vision effect at death: '+data.asset_state.vision_effects.filter(e=>k.vision_effect_ids.includes(e.id)).map(e=>e.name).join(' + ')+'.');
      if(k.stance_model?.killer)lines.push(`Input-driven stance model at death: killer ${Math.round(k.stance_model.killer.fraction*100)}%, victim ${Math.round(k.stance_model.victim.fraction*100)}% crouched. Achieved stance unverified.`);
      if(turn)lines.push(`Observed turn: ${turn.angle_deg}° in ${turn.duration_ms} ms (${turn.speed_deg_s}°/s). Ends ${turn.ms_to_kill} ms before death; aim angle after ${turn.aim_error_after_deg}°.`);
      $('moment-text').textContent=lines.join('\n');
    }else if(selectedVision){
      const e=selectedVision,profile=data.asset_state.model.vision_profiles[e.profile];
      $('moment-title').textContent=`Round ${round.number}: ${label(players.get(e.subject))} · ${e.name}`;
      $('moment-text').textContent=`Observed effect interval: ${e.start_ms}–${e.end_ms} ms (${e.end_reason}).\nAffected-player effect ID ${e.effect_id}; component ${e.component_net_guid}; source ${e.source_id}.\nStart packet ${e.start_packet_id}, stop packet ${e.stop_packet_id??'not observed'}.\nOverlay is illustrative. Native intensity, visibility radius and shader fade are unverified.\nAsset defaults: ${JSON.stringify(profile.asset_defaults)}.`;
      if(e.native_blind)$('moment-text').textContent+=`\nNative blind record: initial duration ${e.native_blind.reported_initial_duration_seconds??'unknown'} s; ${e.native_blind.start_ms}–${e.native_blind.end_ms} ms (${e.native_blind.end_reason}); config ${e.native_blind.config_path??'unresolved'}.`;
    }else{
      $('moment-title').textContent=`Round ${round.number} · ${round.winner||'Unknown'} win · ${round.result||'unknown outcome'}`;
      $('moment-text').textContent='Select a death from the review queue to inspect its replay evidence, or seek through this round.';
    }
    updateRange();renderQueue();statePage=0;renderStateHistory();draw();
  }
  function setPlaying(value){playing=value;$('play').textContent=value?'❚❚ Pause':'▶ Play';$('play').setAttribute('aria-pressed',String(value));lastFrame=performance.now();if(value&&time>=range[1])time=range[0];}
  function selectKill(k) {
    setPlaying(false);selectedKill=k;selectedVision=null;round=roundAt(k.time_ms);observer=k.killer&&players.has(k.killer)?k.killer:observer;
    const victim=players.get(k.victim),op=players.get(observer);if(victim&&victim.team!==op.team)target=k.victim;
    scope='clip';mapFocused=true;time=Math.max(round.start_ms,k.time_ms-1800);updateMoment();
  }
  function selectVision(effect){
    setPlaying(false);selectedKill=null;selectedVision=effect;round=roundAt(effect.start_ms);observer=effect.subject;
    const a=playerPose(observer,effect.start_ms);const opponents=data.players.filter(p=>p.team!==players.get(observer).team).map(p=>({p,b:playerPose(p.subject,effect.start_ms)})).filter(x=>x.b);
    opponents.sort((x,y)=>a?length(sub(x.b.slice(1,4),a.slice(1,4)))-length(sub(y.b.slice(1,4),a.slice(1,4))):0);
    if(opponents.length)target=opponents[0].p.subject;
    scope='clip';mapFocused=true;time=effect.start_ms+Math.min(150,(effect.end_ms-effect.start_ms)/2);updateMoment();
  }
  function renderQueue(){
    const queue=$('queue');queue.replaceChildren();const rows=filter==='vision'?data.asset_state.vision_effects:filter==='turns'?data.kills.filter(k=>k.rapid_turn):data.kills;
    $('queue-count').textContent=`${rows.length} ${filter==='vision'?'observed vision intervals':filter==='turns'?'measured turn candidates':'death events'} · ${data.rounds.length} rounds`;
    $('filter-turns').classList.toggle('active',filter==='turns');$('filter-all').classList.toggle('active',filter==='all');$('filter-vision').classList.toggle('active',filter==='vision');
    if(filter==='vision'){
      if(!rows.length){const p=document.createElement('p');p.textContent='No supported recipient vision-effect RPCs were found in this replay.';queue.append(p);}
      for(const e of rows){const b=document.createElement('button');b.className='kill-item'+(e.id===selectedVision?.id?' selected':'');b.setAttribute('aria-pressed',String(e.id===selectedVision?.id));
        const meta=document.createElement('div');meta.className='meta';meta.textContent='ROUND '+(e.round+1)+' · '+clock(e.start_ms);
        const name=document.createElement('div');name.className='names';name.textContent=shortName(players.get(e.subject))+' · '+e.name;
        const detail=document.createElement('div');detail.className='turn';detail.textContent=((e.end_ms-e.start_ms)/1000).toFixed(3)+' s · '+(e.end_reason==='observed_stop_rpc'?'start + stop observed':'end unverified');b.append(meta,name,detail);b.onclick=()=>selectVision(e);queue.append(b);}
      return;
    }
    if(!rows.length){const p=document.createElement('p');p.textContent='No turns meet the review threshold. All death events remain available.';p.style.cssText='font-size:12px;color:#9ca9b8;padding:10px';queue.append(p);}
    for(const k of rows){
      const b=document.createElement('button');b.className='kill-item'+(k.id===selectedKill?.id?' selected':'');b.setAttribute('aria-pressed',String(k.id===selectedKill?.id));
      const meta=document.createElement('div');meta.className='meta';const r=document.createElement('span');r.textContent='ROUND '+(k.round+1);const t=document.createElement('span');t.textContent=clock(k.time_ms);meta.append(r,t);
      const names=document.createElement('div');names.className='names';names.textContent=k.death_type==='self_or_environment'?(players.get(k.victim)?.name||players.get(k.victim)?.slot||'?')+' · self/environment':(players.get(k.killer)?.name||players.get(k.killer)?.slot||'Environment')+' → '+(players.get(k.victim)?.name||players.get(k.victim)?.slot||'?');
      b.append(meta,names);if(k.rapid_turn){const detail=document.createElement('div');detail.className='turn';detail.textContent=`${k.rapid_turn.angle_deg.toFixed(1)}° / ${k.rapid_turn.duration_ms} ms`;b.append(detail);}
      b.onclick=()=>selectKill(k);queue.append(b);
    }
  }
  function renderStateHistory(){
    const obs=data.asset_state.observations||{},category=$('state-category').value,query=$('state-search').value.trim().toLowerCase(),all=$('state-all-actors').checked;
    const life=Object.entries(obs.life_states||{}).flatMap(([subject,rows])=>rows.map(([time_ms,alive,packet_id,field])=>({kind:'life_state_observed',time_ms,round:roundAt(time_ms).index,subject,packet_id,field,alive})));
    const blind=[...(obs.native_blind_intervals||[]).map(e=>({...e,field:'Native blind membership',asset_path:e.config_path})),...(obs.blind_observations||[])].sort((a,b)=>a.time_ms-b.time_ms);
    const source=category==='effect'?obs.effect_events||[]:category==='animation'?obs.animation_observations||[]:category==='camera'?obs.camera_observations||[]:category==='blind'?blind:[...life,...(obs.resurrections||[])].sort((a,b)=>a.time_ms-b.time_ms);
    stateRecordRows=source.filter(e=>e.round===round.index&&(all||e.subject===observer)&&(!query||[e.effect_class,e.field,e.asset_path,e.method,e.kind].join(' ').toLowerCase().includes(query)));
    const limit=100,total=stateRecordRows.length;statePage=Math.max(0,Math.min(statePage,Math.max(0,Math.ceil(total/limit)-1)));
    $('state-count').textContent=`${total} records · page ${statePage+1}/${Math.max(1,Math.ceil(total/limit))}`;
    $('state-prev').disabled=statePage===0;$('state-next').disabled=(statePage+1)*limit>=total;
    const body=$('state-rows');body.replaceChildren();
    for(const e of stateRecordRows.slice(statePage*limit,(statePage+1)*limit)){
      const row=document.createElement('tr'),t=document.createElement('td'),actor=document.createElement('td'),name=document.createElement('td'),details=document.createElement('td'),seek=document.createElement('button');
      seek.textContent=clock(e.time_ms);seek.onclick=()=>{setPlaying(false);scope='round';updateRange();time=e.time_ms;draw();};t.append(seek);
      actor.textContent=e.subject?label(players.get(e.subject)):'Actor '+(e.actor_net_guid??'unresolved');
      const key=e.effect_class||e.asset_path;name.textContent=[e.method||e.field||e.kind,key].filter(Boolean).join('\n');
      const inspect=document.createElement('button');inspect.textContent='Inspect';inspect.onclick=()=>{$('state-detail').textContent=JSON.stringify({observation:e,asset_metadata:key?data.asset_state.model?.asset_catalog?.[key]??'not available':undefined},null,2)};details.append(inspect);
      if(category==='animation'&&e.asset_path){const preview=document.createElement('a');preview.textContent='Preview asset';preview.href=new URL('animation-assets/index.html?asset='+encodeURIComponent(e.asset_path),new URL(bundle.library_url||'library.json',location.href)).href;details.append(document.createTextNode(' '),preview);}
      row.append(t,actor,name,details);body.append(row);
    }
  }
  async function loadLibrary(){
    try{const response=await fetch(bundle.library_url||'library.json');if(!response.ok)return;const library=await response.json(),select=$('replay-library');
      for(const match of library.replays.filter(m=>m.viewer)){option(select,new URL(match.viewer,response.url).href,`${match.map_name} · ${match.rounds} rounds · ${match.match_id.slice(0,8)}`);if(match.match_id===data.match_id)select.value=new URL(match.viewer,response.url).href;}
      select.onchange=()=>location.assign(select.value);$('library-count').textContent=library.replays.length+' replays';$('library-link').href=new URL('library.html',response.url).href;$('library-control').hidden=false;
    }catch{/* The standalone viewer remains usable without its optional library. */}
  }
  function download(name,content,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function decodeBase64(s){const b=atob(s);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
  async function gunzip(s){const stream=new Blob([decodeBase64(s)]).stream().pipeThrough(new DecompressionStream('gzip'));return new Response(stream).arrayBuffer();}
  function annotateNames(){
    let saved={};try{saved=JSON.parse(localStorage.getItem(namesKey)||'{}')}catch{}
    for(const p of data.players){
      if(typeof saved[p.subject]==='string')p.name=saved[p.subject];
      const labelEl=document.createElement('label');const slot=document.createElement('span');slot.textContent=p.slot;const input=document.createElement('input');input.type='text';input.maxLength=60;input.value=p.name||'';input.placeholder=p.agent;input.setAttribute('aria-label','Display name for '+p.slot+' '+p.agent);
      input.onchange=()=>{p.name=input.value.trim().replace(/[\r\n]/g,' ');const names=Object.fromEntries(data.players.filter(p=>p.name).map(p=>[p.subject,p.name]));try{localStorage.setItem(namesKey,JSON.stringify(names))}catch{};refreshPlayerSelectors();updateMoment();};labelEl.append(slot,input);$('name-grid').append(labelEl);
    }
  }
  function refreshPlayerSelectors(){const s=$('observer');s.replaceChildren();for(const p of data.players)option(s,p.subject,p.team+' · '+label(p));s.value=observer;targetOptions();}
  function bind(){
    $('analyze-native').onclick=requestNative;
    $('visibility-export').ontoggle=()=>{if($('visibility-export').open&&!timelineBusy)$('visibility-json').textContent=visibilityPreview(contactReport())};
    $('visibility-detail').ontoggle=()=>{if($('visibility-detail').open)draw()};
    $('download-visibility').onclick=()=>download(data.match_id+'-'+observer+'-'+target+'-visibility.json',JSON.stringify(contactReport(),null,2),'application/json');
    $('state-category').onchange=$('state-search').oninput=$('state-all-actors').onchange=()=>{statePage=0;renderStateHistory()};$('state-prev').onclick=()=>{statePage--;renderStateHistory()};$('state-next').onclick=()=>{statePage++;renderStateHistory()};$('state-history').ontoggle=()=>{if($('state-history').open){renderStateHistory();draw()}};
    $('smoke-model').onclick=()=>{smokeEnabled=!smokeEnabled;$('smoke-model').textContent='Smoke model: '+(smokeEnabled?'on':'off');$('smoke-model').setAttribute('aria-pressed',String(smokeEnabled));prepareTimeline();draw()};
    $('stance-model').onclick=()=>{stanceEnabled=!stanceEnabled;$('stance-model').textContent='Crouch model: '+(stanceEnabled?'on':'off');$('stance-model').setAttribute('aria-pressed',String(stanceEnabled));prepareTimeline();draw()};
    $('vision-overlay').onclick=()=>{visionEnabled=!visionEnabled;$('vision-overlay').textContent='Vision overlay: '+(visionEnabled?'on':'off');$('vision-overlay').setAttribute('aria-pressed',String(visionEnabled));draw()};
    $('map-focus').onclick=()=>{mapFocused=!mapFocused;$('map-focus').textContent=mapFocused?'Full map':'Focus fight';draw()};
    $('filter-turns').onclick=()=>{filter='turns';renderQueue()};$('filter-all').onclick=()=>{filter='all';renderQueue()};$('filter-vision').onclick=()=>{filter='vision';renderQueue()};
    $('round').onchange=()=>{setPlaying(false);round=data.rounds.find(r=>r.index===Number($('round').value));selectedKill=selectedVision=null;scope='round';time=round.combat_start_ms||round.start_ms;updateMoment()};
    $('observer').onchange=()=>{setPlaying(false);observer=$('observer').value;selectedKill=selectedVision=null;scope='round';updateMoment()};
    $('target').onchange=()=>{setPlaying(false);target=$('target').value;selectedKill=selectedVision=null;scope='round';updateMoment()};
    $('scope-clip').onclick=()=>{scope='clip';updateRange()};$('scope-round').onclick=()=>{scope='round';updateRange()};
    $('play').onclick=()=>setPlaying(!playing);$('playback-speed').onchange=()=>{speed=Number($('playback-speed').value);draw()};
    const seek=t=>{time=Math.max(range[0],Math.min(range[1],t));draw()};
    $('back').onclick=()=>{setPlaying(false);seek(time-50)};$('forward').onclick=()=>{setPlaying(false);seek(time+50)};
    $('seek').oninput=()=>{setPlaying(false);seek(Number($('seek').value))};$('jump-kill').onclick=()=>{setPlaying(false);if(selectedKill)seek(selectedKill.time_ms-1);else if(selectedVision)seek(selectedVision.start_ms)};
    const timeline=$('timeline');let dragging=false;
    const timelineSeek=e=>{const box=timeline.getBoundingClientRect(),left=140*figureScale();const fraction=Math.max(0,Math.min(1,(e.clientX-box.left-left)/(box.width-left)));seek(range[0]+fraction*(range[1]-range[0]))};
    timeline.onpointerdown=e=>{setPlaying(false);dragging=true;timeline.setPointerCapture(e.pointerId);timelineSeek(e)};timeline.onpointermove=e=>{if(dragging)timelineSeek(e)};timeline.onpointerup=()=>dragging=false;timeline.onpointercancel=()=>dragging=false;
    document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA','BUTTON','SUMMARY'].includes(e.target.tagName)||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key===' '){e.preventDefault();setPlaying(!playing)}else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setPlaying(false);seek(time+(e.key==='ArrowRight'?50:-50))}});
    $('map-canvas').onclick=e=>{const box=$('map-canvas').getBoundingClientRect(),x=e.clientX-box.left,y=e.clientY-box.top;let chosen=null,distance=22;for(const p of data.players){const row=playerPose(p.subject,time);if(!row)continue;const [px,py]=mapPoint(row,box.width,box.height),d=Math.hypot(px-x,py-y);if(d<distance){distance=d;chosen=p}}if(chosen){setPlaying(false);if(e.shiftKey&&chosen.team!==players.get(observer).team)target=chosen.subject;else if(!e.shiftKey)observer=chosen.subject;else return;selectedKill=selectedVision=null;scope='round';updateMoment()}};
    $('download-json').onclick=()=>download(data.match_id+'-replay.json',JSON.stringify(data),'application/json');
    $('download-jsonl').onclick=()=>{const metadata={kind:'metadata',schema_version:1,producer:data.producer,match_id:data.match_id,replay_build:data.replay_build,clock:data.clock,map:data.map,players:data.players,rounds:data.rounds,score:data.score,projection:data.projection,asset_state:data.asset_state,rapid_turn_policy:data.rapid_turn_policy,diagnostics:data.diagnostics,source_provenance:data.source_provenance,geometry:{kind:data.geometry.kind,triangles_used:data.geometry.triangles_used,complete:data.geometry.complete,asset_build_verified_against_replay:data.geometry.asset_provenance.asset_build_verified_against_replay},limitations:data.limitations};download(data.match_id+'-events.jsonl',[metadata,...data.events].map(r=>JSON.stringify(r)).join('\n')+'\n','application/x-ndjson')};
    $('download-text').onclick=()=>{let text=new TextDecoder().decode(decodeBase64(bundle.text));for(const p of data.players)if(label(p)!==originalLabels.get(p.subject))text=text.split(originalLabels.get(p.subject)).join(label(p));download(data.match_id+'-transcript.txt',text,'text/plain;charset=utf-8')};
    let resizeTimer;window.addEventListener('resize',()=>{draw();clearTimeout(resizeTimer);resizeTimer=setTimeout(prepareTimeline,150)});
  }
  function animate(now){if(playing){const delta=Math.min(100,now-lastFrame);time=Math.min(range[1],time+delta*speed);draw();if(time>=range[1])setPlaying(false)}lastFrame=now;requestAnimationFrame(animate)}
  async function init(){
    try{
      bundle=JSON.parse($('replay-bundle').textContent);
      const [raw,geometry,extra,overlays]=await Promise.all([gunzip(bundle.data),gunzip(bundle.geometry),bundle.visibility_inputs?gunzip(bundle.visibility_inputs):null,
        Promise.all((bundle.visibility_overlays||[]).map(gunzip))]);
      data=JSON.parse(new TextDecoder().decode(raw));mesh=decodeBVH(geometry);
      visibilityInputs=extra?JSON.parse(new TextDecoder().decode(extra)):{};
      if(visibilityInputs.match_id&&visibilityInputs.match_id!==data.match_id)throw Error('Visibility inputs belong to another replay');
      analysisData=window.ReplayVisibility.dataWithInputs(data,visibilityInputs);
      evaluateFrame=window.ReplayBehavior.createFrameEvaluator(analysisData,math);
      evaluatePair=window.ReplayVisibility.createPairEvaluator(analysisData,mesh,math,evaluateFrame,{...visibilityInputs,overlay_meshes:overlays.map(decodeBVH)});
      const behavior=document.createElement('details');behavior.id='behavior-state';
      const summary=document.createElement('summary');summary.textContent='Current behavior layers and unresolved dependencies';
      const detail=document.createElement('pre');detail.id='behavior-detail';detail.className='state-details';
      const coverage=document.createElement('a');coverage.textContent='Installed behavior coverage';coverage.href=new URL('behavior-coverage/index.html',new URL(bundle.library_url||'library.json',location.href)).href;
      const animation=document.createElement('a');animation.textContent='Installed animation assets';animation.href=new URL('animation-assets/index.html',new URL(bundle.library_url||'library.json',location.href)).href;
      behavior.append(summary,coverage,document.createTextNode(' · '),animation,detail);behavior.ontoggle=()=>{if(behavior.open)detail.textContent=JSON.stringify(frameState(),null,2)};$('state-history').append(behavior);
      const observation=data.asset_state?.observations?.diagnostics||{};$('state-coverage').textContent=`${observation.effect_rpc_observations||0} effect RPCs; ${observation.named_continuous_effects||0} continuous effects; ${observation.animation_observations||0} animation records; ${observation.native_blind_intervals||0} native blind memberships; ${observation.camera_field_observations||0} camera fields; ${observation.resurrections||0} resurrection broadcasts. ${observation.unresolved_rpc_payloads||0} RPC payloads remain unresolved and preserved in the source export. Animation assets provide timing and references; their skeletal poses and native blends are not reconstructed.`;
      loadLibrary();
      if(data.asset_state?.model){const model=data.asset_state.model;for(const profile of Object.values(model.smoke_profiles))if(profile.boundary_shell)smokeMeshes.set(profile,shellMesh(model.shell_meshes[profile.boundary_shell.mesh],profile.boundary_shell.scale));}
      for(const p of data.players)players.set(p.subject,p);originalLabels=new Map(data.players.map(p=>[p.subject,label(p)]));namesKey='vlravg-transcription-names:'+data.match_id;
      mapImage=new Image();mapImage.src=bundle.minimap;await mapImage.decode();mapSketch=makeMapSketch();await document.fonts.ready;figureScale();
      $('match-meta').textContent=`${data.map.name} · Blue ${data.score.Blue||0}–${data.score.Red||0} Red · ${data.replay_build.split('release-').pop()} · ${data.match_id}`;
      $('map-title').textContent=data.map.name+' · game minimap';
      for(const r of data.rounds)option($('round'),r.index,`R${r.number} · ${r.winner||'?'} · ${r.result||'?'}`);
      observer=data.players[0].subject;round=data.rounds[0];target=data.players.find(p=>p.team!==players.get(observer).team).subject;
      annotateNames();refreshPlayerSelectors();
      const d=data.diagnostics.shot_extraction;const content=$('evidence-content');
      const p=document.createElement('p');p.textContent=`${data.diagnostics.native_movement_rows.toLocaleString()} native movement rows; ${data.kills.length} death events; ${d.observed_discharges||0} observed gun discharges. ${data.geometry.triangles_used.toLocaleString()} opaque static triangles used. ${d.unresolved_firing_effects||0} firing effects unresolved; ${d.ambiguous_rpc_groups||0} ambiguous groups excluded. ${data.diagnostics.parser_quality.net.unresolved_rpc_payloads_preserved||0} other RPC payloads preserved but unresolved.`;content.append(p);
      const ul=document.createElement('ul');for(const s of data.limitations){const li=document.createElement('li');li.textContent=s;ul.append(li)}content.append(ul);
      const model=data.asset_state?.model;
      smokeEnabled=Boolean(model);$('smoke-model').disabled=!model;$('smoke-model').setAttribute('aria-pressed',String(smokeEnabled));$('smoke-model').textContent='Smoke model: '+(smokeEnabled?'on':'unavailable');
      stanceEnabled=Boolean(model?.camera.crouch_compression_cm);$('stance-model').disabled=!stanceEnabled;$('stance-model').setAttribute('aria-pressed',String(stanceEnabled));$('stance-model').textContent='Crouch model: '+(stanceEnabled?'on':'unavailable');
      visionEnabled=Boolean(model?.vision_profiles);$('vision-overlay').disabled=!visionEnabled;$('vision-overlay').setAttribute('aria-pressed',String(visionEnabled));$('vision-overlay').textContent='Vision overlay: '+(visionEnabled?'on':'unavailable');
      if(model){const status=document.createElement('p'),diag=data.asset_state.diagnostics,cross=data.asset_state.camera.crouch_corroboration;status.textContent=`${diag.vision_intervals||0} recipient vision intervals (${diag.nearsight_intervals||0} nearsights, ${diag.flash_intervals||0} flashes); ${diag.vision_observed_stops||0} matching stop RPCs. ${cross?.matched_transitions||0} stationary crouch transitions match the asset compression in native XYZ. Crouch posture is input-driven; overlay colors illustrate effects without reconstructing shaders.`;content.append(status);}
      if(model){const detail=document.createElement('p');const merged=analysisData.asset_state;detail.textContent=`Asset defaults: standing eye ${model.camera.standing_eye_cm} cm; crouched eye ${model.camera.crouched_eye_cm} cm; capsule radius ${model.capsule.radius_cm} cm / half-height ${model.capsule.half_height_cm} cm. ${merged.smokes.length} observed smoke actors: ${Object.values(merged.model.smoke_profiles).map(p=>p.agent+' '+(p.radius_cm/100).toFixed(2)+' m').join(', ')}. ${data.asset_state.diagnostics.fov_events_with_active_weapon_join} active-weapon FOV observations. Smoke curves use extracted linear, constant and cubic keys. Added Brimstone/Clove activation clocks and native opacity remain unverified. ${visibilityInputs.ability_occluders?.instances.length||0} potential ability-wall windows; ${visibilityInputs.dynamic_occluders?.instances.length||0} source-bound moving map objects. Intersected unresolved geometry interrupts modeled contacts.`;content.append(detail);}
      const provenance=document.createElement('p');provenance.textContent=`Map and gameplay model mappings: ${data.geometry.asset_provenance.mapping_build}; asset/replay build parity remains unverified. Wall visibility uses static geometry; smoke uses a separate asset model.`;content.append(provenance);
      bind();for(const id of ['download-text','download-json','download-jsonl'])$(id).disabled=false;
      $('loading').hidden=true;
      const first=data.kills.find(k=>k.rapid_turn)||data.kills.find(k=>k.killer&&k.victim);if(!data.kills.some(k=>k.rapid_turn))filter='all';
      if(first)selectKill(first);else{scope='round';time=round.combat_start_ms||round.start_ms;updateMoment()}
      loadNativeService();requestAnimationFrame(animate);
    }catch(error){$('loading-text').textContent='Unable to open the local viewer: '+error.message;$('loading-text').className='error';$('loading').querySelector('progress').hidden=true;console.error(error)}
  }
  init();
})();
