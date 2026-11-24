import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const row=(handle,team,region,extra={})=>({handle,team,region,countryCode:'US',puuid:`${handle}-0000-0000-0000-000000000000`,accountIndex:0,accountCount:1,...extra});

test('each VCT region has its league logo on disk and its colour',async()=>{
  const {PRO_REGIONS,PRO_REGION_STYLE}=await load('/src/app/pro-library.jsx');
  assert.deepEqual(Object.keys(PRO_REGION_STYLE),PRO_REGIONS);
  for(const region of PRO_REGIONS){
    const {color,logo}=PRO_REGION_STYLE[region];
    assert.match(color,/^#[0-9a-f]{6}$/);
    assert.ok(existsSync(new URL('..'+logo,import.meta.url)),`${logo} exists`);
  }
});

test('team headings carry the region logo in its colour; avatars take the player region colour',async()=>{
  const {proGroups}=await load('/src/app/pro-library.jsx');
  const [group]=proGroups([row('b','Fnatic','EMEA',{teamCode:'FNC'}),row('a','Fnatic','EMEA',{teamCode:'FNC'})],'');
  assert.deepEqual(group.rows.map(r=>r.handle),['a','b']);
  const heading=await renderHtml('/src/app/pro-library.jsx','ProGroupHeading',{group});
  assert.match(heading,/<img src="\/assets\/teams\/fnc\.png"[^>]*>.*Fnatic/);
  assert.match(heading,/style="--region:#d3ff1e"[^>]*><img src="\/assets\/regions\/emea\.png"/);
  const account=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('a','Fnatic','EMEA'),flat:false,query:''});
  assert.match(account,/data-slot="avatar"[^>]*style="--region:#d3ff1e"/);
  // A pro without a region keeps the plain grey avatar.
  const none=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('x',null,null),flat:false,query:''});
  assert.doesNotMatch(none,/--region/);
  assert.match(none,/bg-zinc-700\/70/);
});

test('desktop rows are one line with the country on the right; the phone sheet and PUUID matches stack',async()=>{
  const desktop=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('asuna','100 Thieves','Americas'),flat:false,query:''});
  assert.match(desktop,/data-slot="avatar"[^>]*class="[^"]*size-6/);
  assert.match(desktop,/data-layout="inline"/);
  assert.match(desktop,/class="[^"]*ml-auto[^"]*" data-slot="pro-detail"/);
  const phone=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('asuna','100 Thieves','Americas'),flat:false,query:'',size:'lg'});
  assert.match(phone,/data-slot="avatar"[^>]*class="[^"]*size-9/);
  assert.match(phone,/data-layout="stacked"/);
  // A PUUID match needs the room of a second line.
  const byName=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('asuna','100 Thieves','Americas'),flat:true,query:'asu'});
  assert.match(byName,/data-layout="inline"/);
  const hit=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('asuna','100 Thieves','Americas'),flat:true,query:'0000-0000'});
  assert.match(hit,/data-layout="stacked"/);
  // Team lists use up to three columns; search results, which also name the team, two.
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../src/app/SearchHeader.jsx',import.meta.url),'utf8');
  assert.match(source,/@min-\[420px\]\/pro:\[&_\[cmdk-group-items\]\]:grid-cols-2/);
  assert.match(source,/!group\.flat&&'@min-\[640px\]\/pro:\[&_\[cmdk-group-items\]\]:grid-cols-3'/);
});

test('the region filter is the site Tabs with each league logo, the chosen label in its colour',async()=>{
  const html=await renderHtml('/src/app/pro-library.jsx','ProRegionFilter',{value:'Pacific',onChange(){},counts:{all:4,Americas:1,EMEA:1,Pacific:1,China:1}});
  assert.match(html,/data-slot="tabs-list"[^>]*aria-label="Filter pro players by region"|aria-label="Filter pro players by region"[^>]*data-slot="tabs-list"/);
  assert.match(html,/data-slot="tabs-indicator"/);
  assert.doesNotMatch(html,/data-slot="toggle-group"/);
  assert.equal((html.match(/<img src="\/assets\/regions\//g)||[]).length,4);
  const tab=html.match(/<button[^>]*aria-label="Pacific, 1 accounts"[^>]*>/)[0];
  assert.match(tab,/data-state="active"/);
  assert.match(tab,/style="--region:#01d2d7"/);
  assert.match(tab,/data-\[state=active\]:text-\(--region\)/);
});

test('rumored moves count like announced ones, with no marker',async()=>{
  // zekken's move to NRG is rumored on Rostermania (22 Nov 2026); he is listed under NRG.
  const {readFileSync}=await import('node:fs');
  const data=JSON.parse(readFileSync(new URL('../pro-players.json',import.meta.url),'utf8'));
  assert.equal(data.players.find(p=>p.handle.toLowerCase()==='zekken')?.teamCode,'NRG');
  assert.ok(data.players.every(p=>!('rumored' in p)));
  const html=await renderHtml('/src/app/pro-library.jsx','ProAccount',{row:row('zekken','NRG','Americas',{teamCode:'NRG'}),flat:false,query:''});
  assert.doesNotMatch(html,/[Rr]umou?red/);
});

test('only partnered teams get a heading; everyone else is under Other players, last',async()=>{
  const {proGroups}=await load('/src/app/pro-library.jsx');
  const groups=proGroups([
    row('zed','Sentinels','Americas',{teamCode:'SEN'}),
    row('solo',null,'EMEA'),
    row('amy','Fnatic','EMEA',{teamCode:'FNC'}),
    row('bob',null,null),
  ],'');
  assert.deepEqual(groups.map(g=>g.heading),['Fnatic','Sentinels','Other players']);
  const other=groups.at(-1);
  assert.deepEqual(other.rows.map(r=>r.handle),['bob','solo']);
  // Other players mixes regions, so its heading shows none.
  assert.equal(other.region,null);
  assert.equal(other.teamCode,null);
});

test('pro-players.json takes teams from rostermania partnered rosters only',async()=>{
  const {readFileSync,existsSync}=await import('node:fs');
  const data=JSON.parse(readFileSync(new URL('../pro-players.json',import.meta.url),'utf8'));
  assert.equal(data.rosterSource,'rostermania/data/rostermania.json');
  const withTeam=data.players.filter(p=>p.team);
  assert.ok(withTeam.length>0);
  for(const p of withTeam){
    assert.match(p.teamCode,/^[A-Z0-9]+$/,p.handle);
    assert.ok(existsSync(new URL(`../assets/teams/${p.teamCode.toLowerCase()}.png`,import.meta.url)),`${p.teamCode} logo`);
  }
  // Pros off partnered rosters keep no team, so the library lists them as Other players.
  assert.ok(data.players.some(p=>!p.team&&!p.teamCode));
});

test('opening the list draws only its first rows; the rest follow in a deferred render',async()=>{
  const {PRO_FIRST_ROWS,limitProGroups,proGroups}=await load('/src/app/pro-library.jsx');
  const rows=Array.from({length:30},(_,i)=>row(`p${String(i).padStart(2,'0')}`,i<20?'Fnatic':'Sentinels',i<20?'EMEA':'Americas',{teamCode:i<20?'FNC':'SEN'}));
  const groups=proGroups(rows,'');
  assert.equal(limitProGroups(groups,Infinity),groups);
  const cut=limitProGroups(groups,25);
  assert.deepEqual(cut.map(g=>[g.heading,g.rows.length]),[['Fnatic',20],['Sentinels',5]]);
  assert.deepEqual(cut[1].rows.map(r=>r.handle),groups[1].rows.slice(0,5).map(r=>r.handle));
  assert.deepEqual(limitProGroups(groups,20).map(g=>g.heading),['Fnatic']);
  assert.ok(PRO_FIRST_ROWS>=24&&PRO_FIRST_ROWS<100);
  // Both lists apply the limit in a component that mounts when they open.
  const {readFileSync}=await import('node:fs');
  const desktop=readFileSync(new URL('../src/app/SearchHeader.jsx',import.meta.url),'utf8');
  assert.match(desktop.slice(desktop.indexOf('function ProLibraryPanel('),desktop.indexOf('<Command shouldFilter')),/limitProGroups\(proGroups\(results,query\),useProRowLimit\(\)\)/);
  const mobile=readFileSync(new URL('../src/app/MobileShell.jsx',import.meta.url),'utf8');
  assert.match(mobile,/function SheetProGroups\(\{groups,query,onPick\}\)\{\n  return limitProGroups\(groups,useProRowLimit\(\)\)/);
  assert.match(mobile.slice(mobile.indexOf('<SheetContent side="top"'),mobile.indexOf('</SheetContent>')),/<SheetProGroups groups=\{groups\}/);
});
