// The shadcn swaps of 20 Nov 2026: hand-built controls replaced by the
// matching shadcn components (docs/shadcn-components.md).
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const source=file=>readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
const render=async(path,name,props,...children)=>renderToStaticMarkup(createElement((await load(path))[name],props,...children));

test('hints replace native titles: focusable dotted text, or hover-only on an existing element',async()=>{
  const plain=await render('/src/app/hint.jsx','Hint',{content:'Wins divided by wins plus losses'},'Win rate');
  assert.match(plain,/^<span tabindex="0" data-slot="hint" class="[^"]*decoration-dotted[^"]*" data-state="closed">Win rate<\/span>$/);
  assert.doesNotMatch(plain,/title=/);
  // asChild: the child is the trigger itself; a plain span gets no focus stop.
  const child=await render('/src/app/hint.jsx','Hint',{asChild:true,content:'Highest ACS'},createElement('span',{className:'mc-accolade'},'Match MVP'));
  assert.match(child,/^<span class="mc-accolade" data-state="closed" data-slot="tooltip-trigger">Match MVP<\/span>$/);
  // No explanation, no tooltip.
  assert.equal(await render('/src/app/hint.jsx','Hint',{content:null},'K/D'),'K/D');
});

test('table headers and match cards carry their explanations as hints, not titles',()=>{
  const table=source('app/data-table.jsx');
  assert.match(table,/<Hint asChild content=\{col\.title\}>\s*<Button variant="ghost"/);
  assert.doesNotMatch(table,/title=\{col\.title\}/);
  const matches=source('app/pages/Matches.jsx');
  assert.doesNotMatch(matches,/title=\{myRR==null/);
  // Both cards share one RRChange component.
  assert.equal((matches.match(/<Hint asChild content=\{myRR==null\?'No RR data/g)||[]).length,1);
});

test('progress bars: a null value is the indeterminate sliding segment, a number sets aria-valuenow',async()=>{
  const busy=await renderHtml('/src/components/ui/progress.jsx','Progress',{value:null,'aria-label':'Loading matches'});
  assert.match(busy,/role="progressbar"[^>]*data-state="indeterminate"/);
  assert.match(busy,/w-\[35%\] animate-\[progress-indeterminate_1\.5s_ease-in-out_infinite\]/);
  const half=await renderHtml('/src/components/ui/progress.jsx','Progress',{value:40});
  assert.match(half,/aria-valuenow="40"/);
  assert.match(half,/translateX\(-60%\)/);
  // One keyframe for every bar; the hand-built bars are gone.
  const css=source('index.css');
  assert.match(css,/@keyframes progress-indeterminate/);
  assert.doesNotMatch(css,/@keyframes (search-progress|indeterminate) /);
  for(const file of ['app/SearchHeader.jsx','app/MobileShell.jsx','app/pages/Names.jsx']){
    assert.doesNotMatch(source(file),/animation:'/,file);
    assert.match(source(file),/<Progress /,file);
  }
});

test('empty states are shadcn Empty; loading pages show skeletons with the loading line for screen readers',async()=>{
  const idle=await render('/src/app/shared.jsx','EmptyState',{},'Search for a player above.');
  assert.match(idle,/^<div data-slot="empty" class="[^"]*border-dashed[^"]*rounded-xl border[^"]*" role="status">/);
  const loading=await render('/src/app/shared.jsx','EmptyState',{loading:true},'Loading this player’s matches…');
  assert.match(loading,/data-slot="page-skeleton"/);
  assert.match(loading,/role="status"[^>]*><span class="sr-only">Loading this player’s matches…<\/span>/);
  assert.equal((loading.match(/data-slot="skeleton"/g)||[]).length,3);
  // Every detail page passes its loading state.
  for(const page of ['Duos','LobbyRank','Servers','RR','Matches'])
    assert.match(source(`app/pages/${page}.jsx`),/<EmptyState loading=\{s\.analysisState==='loading'\}>/,page);
  // The overview shows its own skeleton on every width now.
  assert.match(source('app/pages/Overview.jsx'),/if\(s\.hasAnalysis&&s\.analysisState==='loading'\)return <OverviewSkeleton mobile=\{mobile\}\/>/);
});

test('show-all, sort direction and Tracker.gg links are shadcn Buttons; the sort picker is a native select',async()=>{
  const more=await renderHtml('/src/app/shared.jsx','ShowAllButton',{expanded:false,total:12,noun:'teammates',onToggle(){}});
  assert.match(more,/<button[^>]*data-slot="button"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(more,/focus-visible:ring-\[3px\] focus-visible:ring-ring\/50">/);
  const table=source('app/data-table.jsx');
  assert.match(table,/<NativeSelect id=\{`\$\{id\}-sort`\} size="sm"/);
  assert.match(table,/<Button type="button" variant="outline" size="icon-sm" disabled=\{column==null\}/);
  assert.match(source('app/SearchHeader.jsx'),/<Button data-slot="account-pill" variant="outline" size="sm" asChild/);
  assert.match(source('app/MobileShell.jsx'),/<Button variant="outline" size="sm" asChild className="[^"]*">\s*<a href=\{info\.trackerHref\}/);
});

test('rank zoom chips are a single-choice ToggleGroup; tapping the chosen rank again shows all ranks',()=>{
  const rr=source('app/pages/RR.jsx');
  assert.match(rr,/<ToggleGroup type="single" variant="outline" size="sm"[^>]*value=\{zoomTier==null\?'all':String\(zoomTier\)\}/);
  assert.match(rr,/onValueChange=\{value=>setRRMovementZoomTier\(value&&value!=='all'\?Number\(value\):null\)\}/);
  assert.doesNotMatch(rr,/aria-pressed=\{on\}/);
});

test('list rows are shadcn Items: pro players with an avatar initial, the More sheet, replay rows',async()=>{
  const shell=source('app/MobileShell.jsx');
  assert.match(shell,/<Item asChild size="sm"[^>]*>\s*<button type="button"/);
  // The pro row content (avatar initial, handle, team and country) is shared with the desktop list.
  assert.match(shell,/<Item asChild size="sm"[^>]*>\s*<button type="button"[^\n]*\n\s*<ProAccount /);
  assert.match(source('app/pro-library.jsx'),/<AvatarFallback[^>]*>\{row\.handle\.slice\(0,1\)\}<\/AvatarFallback>/);
  assert.match(shell,/<Item asChild size="sm"[^>]*>\s*<PageLink page=\{target\}/);
  // Vertical rules between inline items are shadcn Separators.
  // A span, since it sits inside inline text and the match card's button.
  assert.match(await renderHtml('/src/app/shared.jsx','Sep',{}),/^<span data-orientation="vertical" role="none" data-slot="separator" class="[^"]*inline-block/);
});
