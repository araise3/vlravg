import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('const disclosureMotionPreference='),end=html.indexOf('\nfunction buildMatchCard(',start);
assert.ok(start>=0&&end>start);
function harness(){
  let time=0,nextId=0,onPreferenceChange;
  const frames=new Map(),values=[],rests=[];
  const preference={matches:false,addEventListener:(_,callback)=>onPreferenceChange=callback};
  const create=runInNewContext(html.slice(start,end)+'\ncreateDisclosureSpring',{
    matchMedia:()=>preference,performance:{now:()=>time},Math,
    requestAnimationFrame:callback=>{frames.set(++nextId,callback);return nextId;},
    cancelAnimationFrame:id=>frames.delete(id),
  });
  const target=create(value=>values.push(value),value=>rests.push(value));
  const advance=milliseconds=>{
    time+=milliseconds;
    const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback(time));
  };
  return {target,advance,values,rests,frames,reduce(){preference.matches=true;onPreferenceChange();}};
}

test('disclosure settles without bounce and releases its frame',()=>{
  const h=harness();h.target(1);
  for(let i=0;i<60;i++)h.advance(16);
  assert.ok(h.values.every(value=>value>=0&&value<=1));
  assert.equal(h.values.at(-1),1);
  assert.deepEqual(h.rests,[1]);
  assert.equal(h.frames.size,0);
});

test('reversal and reopening preserve the on-screen value',()=>{
  const h=harness();h.target(1);h.advance(80);
  const opening=h.values.at(-1);h.target(0);
  assert.equal(h.values.at(-1),opening);
  h.advance(40);const closing=h.values.at(-1);h.target(1);
  assert.equal(h.values.at(-1),closing);
  for(let i=0;i<60;i++)h.advance(16);
  assert.deepEqual(h.rests,[1]);
});

test('reduced motion interrupts an active spring and keeps later changes instant',()=>{
  const h=harness();h.target(1);h.advance(50);h.reduce();
  assert.equal(h.values.at(-1),1);
  assert.equal(h.frames.size,0);
  h.target(0);
  assert.equal(h.values.at(-1),0);
  assert.deepEqual(h.rests,[1,0]);
  assert.equal(h.frames.size,0);
});

test('a background-frame delay remains finite and settles at the target',()=>{
  const h=harness();h.target(1);h.advance(10_000);
  assert.equal(h.values.at(-1),1);
  assert.equal(h.frames.size,0);
});
