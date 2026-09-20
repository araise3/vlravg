import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function isRREligible(');
const end=html.indexOf('\nfunction renderRRMovement(',start);
assert.ok(start>0&&end>start);
const {smoothedRRMovementAt:movement,rrMovementXAxis:axis,rrMovementRows}=runInNewContext(
  html.slice(start,end)+'\n({smoothedRRMovementAt,rrMovementXAxis,rrMovementRows})',{avgLabelShort:()=>''});
const row=(net,rr=100)=>({net,axisRR:rr,m:{myPreRR:rr}});

test('RR trend is the nearby match-weighted payout average',()=>{
  const base=[row(25),row(-10)];
  const manyLosses=[row(25),...Array.from({length:20},()=>row(-10))];
  const manyWins=[...Array.from({length:20},()=>row(25)),row(-10)];
  assert.equal(movement(base,100,30),7.5);
  assert.ok(movement(manyLosses,100,30)<movement(base,100,30));
  assert.ok(movement(manyWins,100,30)>movement(base,100,30));
  assert.equal(movement([row(25),row(-20)],100,30),2.5);
});

test('RR trend stays local to starting RR and handles one-sided data',()=>{
  const rows=[row(30,100),row(-10,100),row(10,140),row(-20,140)];
  assert.ok(movement(rows,100,20)>movement(rows,140,20));
  assert.equal(movement([row(23),row(0)],100,30),11.5);
  assert.equal(movement([row(-17),row(0)],100,30),-8.5);
});

test('chart excludes five-stacks and does not add refunds to match payouts',()=>{
  const match=(myRR,partySize,myRefundedRR=0)=>({myRR,partySize,myRefundedRR,myPreRR:2200,myTierId:24,won:myRR>0});
  const rows=rrMovementRows([match(17,1,8),match(-19,5,0),match(-20,1,0)]);
  assert.deepEqual(Array.from(rows,row=>row.net),[17,-20]);
});

test('zoom uses displayed RR from zero, with 100 visible and higher Immortal RR retained',()=>{
  const sample=[21,70].map(rr=>({m:{myPreRR:2100+rr,myPreTierId:24,myTierId:24}}));
  const zoom=axis(sample,24);
  assert.deepEqual(Array.from(zoom.positions),[21,70]);
  assert.equal(zoom.min,0);
  assert.equal(zoom.max,100);
  assert.equal((zoom.positions[0]-zoom.min)/(zoom.max-zoom.min),.21);
  assert.equal(axis(sample,null).positions[0],2121);
  assert.equal(axis([{m:{myPreRR:2250,myPreTierId:24,myTierId:24}}],24).max,150);
});
