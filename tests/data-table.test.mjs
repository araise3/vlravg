import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const MODULE='/src/app/data-table.jsx';
const columns=[{label:'Player'},{label:'Games'},{label:'K/D'}];
const raw=[['Bea#EU',3,1.2],['Al#EU',5,null],['Cy#EU',5,0.8],['Dee#EU',1,2.1]];
const rows=raw.map(([name,games,kd])=>({key:name,cells:[name,games,kd==null?'—':kd.toFixed(2)]}));
const headers=html=>[...html.matchAll(/<th[^>]*scope="row"[^>]*>(.*?)<\/th>/g)].map(match=>match[1]);

test('the data table runs on TanStack Table',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../src/app/data-table.jsx',import.meta.url),'utf8');
  assert.match(source,/from '@tanstack\/react-table'/);
  assert.match(source,/useTable\(/);
  const shared=readFileSync(new URL('../src/app/shared.jsx',import.meta.url),'utf8');
  assert.match(shared,/export \{MobileRowList,SortableTable,TablePager\} from '@\/app\/data-table\.jsx'/);
});

test('unsorted tables keep the given row order',async()=>{
  const html=await renderHtml(MODULE,'SortableTable',{id:'dt-order',caption:'t',columns,rows,values:raw});
  assert.deepEqual(headers(html),['Bea#EU','Al#EU','Cy#EU','Dee#EU']);
  assert.match(html,/aria-sort="none"/);
  // Data columns sort high-to-low first; the row header A-to-Z.
  assert.match(html,/aria-label="Games: sort descending"/);
  assert.match(html,/aria-label="Player: sort ascending"/);
});

test('missing values sort last in both directions and ties keep the given order',async()=>{
  const {setTableView}=await load(MODULE);
  setTableView('dt-desc',{sorting:[{id:'2',desc:true}]});
  const desc=await renderHtml(MODULE,'SortableTable',{id:'dt-desc',caption:'t',columns,rows,values:raw});
  assert.deepEqual(headers(desc),['Dee#EU','Bea#EU','Cy#EU','Al#EU']);
  assert.match(desc,/aria-sort="descending"[^>]*><div class="flex justify-end"><button[^>]*aria-label="K\/D: sort ascending"/);
  setTableView('dt-asc',{sorting:[{id:'2',desc:false}]});
  const asc=await renderHtml(MODULE,'SortableTable',{id:'dt-asc',caption:'t',columns,rows,values:raw});
  assert.deepEqual(headers(asc),['Cy#EU','Bea#EU','Dee#EU','Al#EU']);
  setTableView('dt-ties',{sorting:[{id:'1',desc:true}]});
  const ties=await renderHtml(MODULE,'SortableTable',{id:'dt-ties',caption:'t',columns,rows,values:raw});
  assert.deepEqual(headers(ties),['Al#EU','Cy#EU','Bea#EU','Dee#EU']);
  setTableView('dt-text',{sorting:[{id:'0',desc:false}]});
  assert.deepEqual(headers(await renderHtml(MODULE,'SortableTable',{id:'dt-text',caption:'t',columns,rows,values:raw})),['Al#EU','Bea#EU','Cy#EU','Dee#EU']);
});

test('desktop uses the shadcn data-table defaults: bordered frame, ghost sort buttons, no column menu',async()=>{
  const wide=[{label:'Player'},...['A','B','C','D','E'].map(label=>({label}))];
  const html=await renderHtml(MODULE,'SortableTable',{id:'dt-wide',caption:'t',columns:wide,rows:[{key:'p',cells:['P',1,2,3,4,5]}],values:[['P',1,2,3,4,5]]});
  assert.match(html,/data-slot="data-table"><div class="overflow-hidden border bg-card rounded-lg">/);
  // On its own the frame is the card.
  assert.match(await renderHtml(MODULE,'SortableTable',{id:'dt-alone',caption:'t',columns:wide,rows:[{key:'p',cells:['P',1,2,3,4,5]}],values:[['P',1,2,3,4,5]],standalone:true}),/<div class="overflow-hidden border bg-card rounded-\[12px\]">/);
  // Muted header row; the sort arrow is hidden until hover or sort.
  assert.match(html,/<tr[^>]*class="[^"]*bg-muted\/40/);
  assert.match(html,/opacity-0 group-hover\/sort:opacity-60/);
  assert.doesNotMatch(html,/rank-table|table-sort-btn|>Columns</);
  assert.equal((html.match(/<th[^>]*scope="col"[^>]*>(?:<div class="flex justify-end">)?<button data-slot="button"[^>]*data-variant="ghost"/g)||[]).length,6);
  // The arrow sits inside its button (before a right-aligned label, after a
  // left-aligned one), and a right-aligned header overflows leftward.
  assert.match(html,/<th[^>]*text-right[^>]*><div class="flex justify-end"><button[^>]*><svg[^>]*>.*?<\/svg>A<\/button><\/div><\/th>/);
  assert.match(html,/aria-label="Player: sort[^"]*">Player<svg[^>]*>.*?<\/svg><\/button><\/th>/);
  assert.doesNotMatch(html,/absolute right-full|has-\[&gt;svg\]:px-2\.5/);
  // Number columns are right-aligned, the row header left.
  assert.match(html,/<th(?=[^>]*scope="col")(?=[^>]*class="[^"]*text-right)/);
  assert.match(html,/<td[^>]*class="[^"]*text-right tabular-nums/);
  assert.doesNotMatch(html,/table-toolbar/);
});

test('the best value is semibold only where rows differ',async()=>{
  const cols=[{label:'Player'},{label:'Games'},{label:'K/D'}];
  const html=await renderHtml(MODULE,'SortableTable',{id:'dt-best',caption:'t',columns:cols,
    rows:[{key:'a',cells:['A',5,'1.20']},{key:'b',cells:['B',5,'0.90']}],values:[['A',5,1.2],['B',5,0.9]],
    maxima:[{column:1,label:'games'},{column:2,label:'K/D'}]});
  const bold=[...html.matchAll(/<td[^>]*class="[^"]*font-semibold[^"]*"[^>]*>([^<]*)</g)].map(m=>m[1]);
  assert.deepEqual(bold,['1.20']);
  assert.match(html,/title="Highest K\/D in this table"/);
  assert.doesNotMatch(html,/Highest games/);
});

test('only tables long enough to page get the search box',async()=>{
  const many=Array.from({length:12},(_,i)=>({key:'p'+i,cells:['P'+i,i]}));
  const values=many.map((_,i)=>['P'+i,i]);
  const paged=await renderHtml(MODULE,'SortableTable',{id:'dt-search',caption:'t',columns:columns.slice(0,2),rows:many,values,pageSize:10,noun:'players'});
  assert.match(paged,/type="search"[^>]*placeholder="Search players…"/);
  const short=await renderHtml(MODULE,'SortableTable',{id:'dt-nosearch',caption:'t',columns:columns.slice(0,2),rows:many.slice(0,4),values:values.slice(0,4),pageSize:10,noun:'players'});
  assert.doesNotMatch(short,/type="search"/);
});

test('opening a Radix menu or dialog keeps the scrollbar gutter, so the page does not shift sideways',async()=>{
  const {readFileSync}=await import('node:fs');
  const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
  // html reserves the gutter; scroll lock moves overflow to body, so body must reserve it too
  // and Radix's compensating margin must go.
  assert.match(css,/html \{[^}]*scrollbar-gutter: stable;/);
  assert.match(css,/body \{ scrollbar-gutter: stable; \}/);
  assert.match(css,/html body\[data-scroll-locked\] \{ margin-right: 0 !important; \}/);
});

test('numbered pages show every page up to seven, then the ends and the current page with ellipses',async()=>{
  const {pageNumbers}=await load(MODULE);
  const show=(page,pages)=>pageNumbers(page,pages).map(i=>i==null?'…':i+1).join(' ');
  assert.equal(show(0,1),'1');
  assert.equal(show(3,7),'1 2 3 4 5 6 7');
  assert.equal(show(0,20),'1 2 3 4 5 … 20');
  assert.equal(show(9,20),'1 … 9 10 11 … 20');
  assert.equal(show(19,20),'1 … 16 17 18 19 20');
  // Near either end the first or last five stay, so the row keeps seven slots.
  assert.equal(show(3,10),'1 2 3 4 5 … 10');
  assert.equal(show(4,10),'1 … 4 5 6 … 10');
  assert.equal(show(6,10),'1 … 6 7 8 9 10');
});
