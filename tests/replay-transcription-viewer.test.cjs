const test = require('node:test');
const assert = require('node:assert/strict');
const {forward,angleBetween,latest,project,decodeBVH,rayHit,curveValue,smokeRadius,sphereSegment,weaponFov,shellMesh,smokeIntersection,stanceFraction,stanceGeometry,visionAt,lifeAt} = require('../scripts/replay-transcription-viewer.js');

test('observed life flags allow multiple deaths and revivals within a round',()=>{
  const rows=[[10,true],[100,false],[200,true],[300,false],[1100,true]];
  assert.equal(lifeAt(rows,99,0,[100,300]),true);
  assert.equal(lifeAt(rows,100,0,[100,300]),false);
  assert.equal(lifeAt(rows,200,0,[100,300]),true);
  assert.equal(lifeAt(rows,300,0,[100,300]),false);
  assert.equal(lifeAt(rows,1050,1000,[100,300]),true);
});

test('weapon mesh FOV target is retained separately from world projection',()=>{
  const camera={active_weapon:{a:[[100,1]]},weapon_fov:{1:[[100,103,51.5,200,60,40]]}};
  const lens=weaponFov(camera,'a',200,0);
  assert.equal(lens.fov,77.25);assert.equal(lens.weaponFovTarget,40);
});

test('vision selection preserves overlaps, recipient, round and exact stop boundary',()=>{
  const effects=[{subject:'a',round:0,start_ms:100,end_ms:200,kind:'flash'},
    {subject:'a',round:0,start_ms:150,end_ms:300,kind:'nearsight'},
    {subject:'b',round:0,start_ms:100,end_ms:300},{subject:'a',round:1,start_ms:100,end_ms:300}];
  assert.deepEqual(visionAt(effects,'a',175,0),effects.slice(0,2));
  assert.deepEqual(visionAt(effects,'a',200,0),[effects[1]]);
  assert.deepEqual(visionAt(effects,'a',300,0),[]);
});
test('crouch reversal interpolates from the preceding partial pose',()=>{
  const rows=[[100,0,1,275],[237.5,.5,0,137.5]];
  assert.equal(stanceFraction(rows,99),0);assert.equal(stanceFraction(rows,237.5),.5);
  assert.equal(stanceFraction(rows,306.25),.25);assert.equal(stanceFraction(rows,375),0);
});
test('asset crouch camera uses recorded center unchanged and alters projected body samples',()=>{
  const model={camera:{standing_eye_cm:77,crouched_eye_cm:30,crouch_compression_cm:20},capsule:{half_height_cm:98,radius_cm:42}};
  const rows=[[100,0,1,275]],shape=stanceGeometry(model,rows,375);
  assert.deepEqual(shape.offsets,[-36,-13.5,9]);assert.equal(shape.eyeHeight,30);
  const nativeObserver=[375,0,0,680.15,0,0];
  const center=project(nativeObserver,[100,0,710.15],800,450,103,shape.eyeHeight);
  assert.equal(center.y,225);assert.equal(center.x,400);
  assert.ok(project(nativeObserver,[100,0,710.15],800,450,103,77).y>225);
});

test('yaw wrapping and near-vertical aiming use a three dimensional angle',()=>{
  assert.ok(Math.abs(angleBetween(forward(359,0),forward(1,0))-2)<1e-6);
  assert.ok(Math.abs(angleBetween(forward(0,89),forward(180,89))-2)<1e-6);
});
test('asset curves preserve constant, linear and cubic interpolation',()=>{
  assert.equal(curveValue([[0,0,0,0,0],[1,1,0,0,0]],.5),.5);
  assert.equal(curveValue([[0,1,1,0,0],[1,0,0,0,0]],.99),1);
  assert.equal(curveValue([[0,0,2,0,0],[1,1,2,3,0]],.5),.125);
});
test('hollow smoke interior and ray crossings remain separate',()=>{
  assert.deepEqual(sphereSegment([-1,0,0],[1,0,0],[0,0,0],2),{boundary:false,insideObserver:true,insideTarget:true});
  assert.equal(sphereSegment([-3,0,0],[3,0,0],[0,0,0],2).boundary,true);
  assert.equal(sphereSegment([-3,2,0],[3,2,0],[0,0,0],2).boundary,false);
});
test('smoke boundary uses mesh triangles rather than only a bounding sphere',()=>{
  const source={vertices:[[-1,0,0],[0,1,0],[1,0,0],[0,-1,0]],indices:[0,1,2,0,2,3]},mesh=shellMesh(source,[1,1,1]);
  const profile={radius_cm:1,boundary_shell:{bounding_radius_cm:1}};
  assert.equal(smokeIntersection(profile,[.8,.8,-2],[.8,.8,2],[0,0,0],1,mesh).boundary,false);
  assert.equal(smokeIntersection(profile,[.1,.1,-2],[.1,.1,2],[0,0,0],1,mesh).boundary,true);
});
test('world FOV follows selected weapon and transition, with a fallback before observation',()=>{
  const camera={active_weapon:{a:[[100,1],[400,2]]},weapon_fov:{1:[[100,103,51.5,200]],2:[[150,103,20.6,100]]}};
  assert.equal(weaponFov(camera,'a',99,0).kind,'fallback');
  assert.equal(weaponFov(camera,'a',200,0).fov,77.25);
  assert.equal(weaponFov(camera,'a',300,0).fov,51.5);
  assert.equal(weaponFov(camera,'a',400,0).fov,20.6);
  assert.equal(weaponFov(camera,'a',500,450).kind,'fallback');
});
test('asset smoke volume begins after delay and stops at expiration',()=>{
  const profile={radius_cm:100,delay_ms:100,expand_ms:100,duration_ms:500,contract_ms:100,expand_curve:{keys:[[0,0,0,0,0],[1,1,0,0,0]]},contract_curve:{keys:[[0,1,0,0,0],[1,0,0,0,0]]}};
  assert.equal(smokeRadius(profile,99),0);assert.equal(smokeRadius(profile,150),50);assert.equal(smokeRadius(profile,650),50);assert.equal(smokeRadius(profile,700),0);
});
test('camera projection respects Unreal yaw, pitch, FOV and rear hemisphere',()=>{
  const origin=[0,0,0,0,0,0];
  const center=project(origin,[100,0,77],800,450);
  assert.equal(center.x,400);assert.equal(center.y,225);assert.ok(center.inside);
  assert.ok(project(origin,[100,50,77],800,450).x>400);
  assert.ok(project(origin,[100,0,100],800,450).y<225);
  assert.equal(project(origin,[-100,0,77],800,450).inside,false);
  assert.equal(project(origin,[100,200,77],800,450).inside,false);
  assert.equal(project(origin,[100,0,200],800,450).inside,false);
});
test('missing movement stays missing instead of extrapolating',()=>{
  const rows=[[100,1],[200,2]];
  assert.equal(latest(rows,99),null);assert.equal(latest(rows,301),null);assert.deepEqual(latest(rows,150),rows[0]);
});
test('binary geometry validates size and nearest wall intersection',()=>{
  const buffer=new ArrayBuffer(16+40+72),v=new DataView(buffer);
  v.setUint32(0,0x56425256,true);v.setUint32(4,1,true);v.setUint32(8,2,true);v.setUint32(12,1,true);
  new Float32Array(buffer,16,6).set([20,-100,-100,80,100,150]);
  new Int32Array(buffer,40,4).set([-1,-1,0,2]);
  new Float32Array(buffer,56,18).set([80,-100,-100,80,100,-100,80,0,150,20,-100,-100,20,100,-100,20,0,150]);
  const mesh=decodeBVH(buffer);assert.deepEqual(rayHit(mesh,[0,0,0],[100,0,0]),[20,0,0]);
  assert.equal(rayHit(mesh,[0,400,0],[100,400,0]),null);
  assert.throws(()=>decodeBVH(buffer.slice(0,-1)),/size mismatch/);
});
