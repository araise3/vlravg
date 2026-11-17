import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

test('party-size filter renders as shadcn tabs with only the available sizes',async()=>{
  const markup=await renderHtml('/src/app/shared.jsx','PartySizeFilter',{value:2,available:new Set([2,5]),onChange(){}});
  assert.match(markup,/role="tablist"[^>]*aria-label="Party size"|aria-label="Party size"[^>]*role="tablist"/);
  const tabs=[...markup.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)];
  assert.deepEqual(tabs.map(m=>m[1]),['All','Duo','5-Stack']);
  const selected=tabs.filter(m=>/aria-selected="true"/.test(m[0])).map(m=>m[1]);
  assert.deepEqual(selected,['Duo']);
  assert.doesNotMatch(markup,/toggle-group/);
});

test('tabs list carries one decorative sliding indicator',async()=>{
  const markup=await renderHtml('/src/app/shared.jsx','PartySizeFilter',{value:0,available:new Set([1]),onChange(){}});
  const indicators=[...markup.matchAll(/<span[^>]*data-slot="tabs-indicator"[^>]*>/g)];
  assert.equal(indicators.length,1);
  assert.match(indicators[0][0],/aria-hidden="true"/);
  // Not measured yet during SSR, so it starts hidden instead of at 0,0.
  assert.match(indicators[0][0],/opacity-0/);
  // The active background lives on the indicator, not the trigger.
  assert.doesNotMatch(markup,/data-\[state=active\]:bg-background/);
});

// Pages stay mounted behind `hidden`, so their tab lists measure as not
// rendered; showing the page again must not slide the indicator in.
test('indicator snaps instead of animating on first show and after being hidden',async()=>{
  const {nextIndicatorBox}=await load('/src/components/ui/tabs.jsx');
  const a={left:3,top:3,width:40,height:30},b={left:46,top:3,width:52,height:30};
  const first=nextIndicatorBox(null,a);
  assert.equal(first.snap,true);
  const moved=nextIndicatorBox(first,b);
  assert.equal(moved.snap,false);
  assert.equal(nextIndicatorBox(moved,{...b}),moved);
  const hidden=nextIndicatorBox(moved,'hidden');
  assert.deepEqual({left:hidden.left,width:hidden.width,hidden:hidden.hidden},{left:46,width:52,hidden:true});
  assert.equal(nextIndicatorBox(hidden,'hidden'),hidden);
  const shownSame=nextIndicatorBox(hidden,b);
  assert.equal(shownSame.snap,true);
  assert.equal(shownSame.hidden,undefined);
  assert.equal(nextIndicatorBox(hidden,a).snap,true);
  assert.equal(nextIndicatorBox(null,'hidden'),null);
  assert.equal(nextIndicatorBox(moved,null),null);
});
