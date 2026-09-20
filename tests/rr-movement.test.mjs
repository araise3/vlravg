import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function balancedRRMovementAt(');
const end=html.indexOf('\nfunction renderRRMovement(',start);
assert.ok(start>0&&end>start);
const movement=runInNewContext(html.slice(start,end)+'\nbalancedRRMovementAt');
const row=(net,rr=100)=>({net,m:{myPreRR:rr}});

test('RR trend depends on typical gain and loss, not the win/loss count',()=>{
  const base=[row(25),row(-10)];
  const manyLosses=[row(25),...Array.from({length:20},()=>row(-10))];
  const manyWins=[...Array.from({length:20},()=>row(25)),row(-10)];
  assert.equal(movement(base,100,30),15);
  assert.equal(movement(manyLosses,100,30),15);
  assert.equal(movement(manyWins,100,30),15);
  assert.equal(movement([row(25),row(-20)],100,30),5);
});

test('RR trend stays local to starting RR and handles one-sided data',()=>{
  const rows=[row(30,100),row(-10,100),row(10,140),row(-20,140)];
  assert.ok(movement(rows,100,20)>movement(rows,140,20));
  assert.equal(movement([row(23),row(0)],100,30),23);
  assert.equal(movement([row(-17),row(0)],100,30),-17);
});
