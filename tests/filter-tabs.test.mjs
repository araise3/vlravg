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

test('pages have no visible title or description; the title stays for screen readers and focus',async()=>{
  const {readFileSync,readdirSync}=await import('node:fs');
  const shared=readFileSync(new URL('../src/app/shared.jsx',import.meta.url),'utf8');
  assert.match(shared,/export function PageHeading\(\{id,title,titleRef\}\)\{\n  return <h1 id=\{id\} ref=\{titleRef\} tabIndex=\{-1\} className="sr-only">\{title\}<\/h1>;/);
  const dir=new URL('../src/app/pages/',import.meta.url);
  const ids=[];
  for(const file of readdirSync(dir)){
    const source=readFileSync(new URL(file,dir),'utf8');
    for(const m of source.matchAll(/<PageHeading id="([a-z-]+)" title="[^"]+"(\/?)>/g)){
      assert.equal(m[2],'/',`${file}: ${m[1]} still passes a description`);
      ids.push(m[1]);
    }
  }
  // App.jsx focuses `${page}-title` after navigation; every page keeps one.
  assert.deepEqual(ids.sort(),['duos-title','lobby-rank-title','matches-title','names-title','overview-title','replays-title','rr-title','servers-title']);
});

test('the site uses no dot separators in visible text, labels or status lines',async()=>{
  const {readFileSync,readdirSync,statSync}=await import('node:fs');
  const files=[];
  const walk=url=>{for(const name of readdirSync(url)){const child=new URL(name+(statSync(new URL(name,url)).isDirectory()?'/':''),url);statSync(child).isDirectory()?walk(child):/\.(jsx|mjs|js|css)$/.test(name)&&files.push(child);}};
  walk(new URL('../src/',import.meta.url));
  files.push(new URL('../assets/ping-map/map.js',import.meta.url));
  for(const file of files){
    readFileSync(file,'utf8').split('\n').forEach((line,i)=>{
      const code=line.replace(/\/\/.*$/,'').replace(/\/\*.*?\*\//g,'');
      if(/^\s*\*/.test(line))return;
      assert.ok(!code.includes('·'),`${file.pathname.split('/').slice(-2).join('/')}:${i+1} uses a dot separator`);
    });
  }
});

test('tab triggers fill the list height so the highlight sits evenly, 3px from top and bottom',async()=>{
  const {readFileSync}=await import('node:fs');
  const tabs=readFileSync(new URL('../src/components/ui/tabs.jsx',import.meta.url),'utf8');
  // A 1px-shorter trigger centred on a half pixel; the indicator's integer
  // offsetTop then rounded it down, leaving 4px above and 3px below.
  assert.doesNotMatch(tabs,/h-\[calc\(100%-1px\)\]/);
  assert.match(tabs,/"inline-flex h-full flex-1 items-center justify-center/);
});
