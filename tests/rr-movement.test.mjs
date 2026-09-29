import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function isRREligible(');
const end=html.indexOf('\nfunction renderRRMovement(',start);
assert.ok(start>0&&end>start);
const {rrPayoutEstimates:estimates,rrPayoutSegments:segments,rrMovementXAxis:axis,rrMovementRows}=runInNewContext(
  html.slice(start,end)+'\n({rrPayoutEstimates,rrPayoutSegments,rrMovementXAxis,rrMovementRows})',{avgLabelShort:()=>''});
const row=(net,rr=100,won=net>0,axisRR=rr)=>({net,axisRR,m:{myPreRR:rr,won}});

test('separate win and loss estimates use nearby matches and the act mean',()=>{
  const rows=[row(10,100),row(20,100),row(30,100),row(40,200),row(-12,100),row(-18,110),row(-24,120)];
  const gains=estimates(rows,rows,true);
  const losses=estimates(rows,rows,false);
  assert.equal(gains[0].n,3);
  assert.equal(gains[0].actMean,25);
  assert.equal(gains[0].payout,(10+20+30+8*25)/11);
  assert.equal(gains[1].payout,null);
  assert.equal(losses[0].n,3);
  assert.equal(losses[0].payout,18);
});

test('local samples never span more than 30 RR and sparse points leave gaps',()=>{
  const rows=[row(10,100),row(20,110),row(30,120),row(40,131),row(50,200)];
  const gains=estimates(rows,rows,true);
  const at100=gains.find(point=>point.position===100);
  assert.equal(at100.n,3);
  assert.equal(at100.max-at100.min,20);
  assert.equal(gains.find(point=>point.position===200).payout,null);
  assert.deepEqual(Array.from(segments(gains),part=>Array.from(part,point=>point.position)),[[100,110,120,131]]);
  const distant=[{position:100,payout:10},{position:140,payout:12}];
  assert.deepEqual(Array.from(segments(distant),part=>Array.from(part,point=>point.position)),[[100],[140]]);
});

test('zoomed estimates keep their full-rank neighbors but plot at displayed RR',()=>{
  const all=[row(12,2110,true,10),row(18,2120,true,20),row(24,2130,true,30),row(30,2140,true,40)];
  const [point]=estimates([all[1]],all,true);
  assert.equal(point.position,2120);
  assert.equal(point.axisPosition,20);
  assert.equal(point.n,4);
});

test('chart excludes five-stacks and does not add refunds to match payouts',()=>{
  const match=(myRR,partySize,myRefundedRR=0)=>({myRR,partySize,myRefundedRR,myPreRR:2200,myTierId:24,won:myRR>0});
  const rows=rrMovementRows([match(17,1,8),match(-19,5,0),match(-20,1,0)]);
  assert.deepEqual(Array.from(rows,row=>row.net),[17,-20]);
});

test('zoom uses displayed RR from zero and keeps higher Immortal RR',()=>{
  const sample=[21,70].map(rr=>({m:{myPreRR:2100+rr,myPreTierId:24,myTierId:24}}));
  const zoom=axis(sample,24);
  assert.deepEqual(Array.from(zoom.positions),[21,70]);
  assert.equal(zoom.min,0);
  assert.equal(zoom.max,100);
  assert.equal((zoom.positions[0]-zoom.min)/(zoom.max-zoom.min),.21);
  assert.equal(axis(sample,null).positions[0],2121);
  assert.equal(axis([{m:{myPreRR:2250,myPreTierId:24,myTierId:24}}],24).max,200);
});
