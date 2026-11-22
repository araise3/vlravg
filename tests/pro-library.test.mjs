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

test('the region filter shows each league logo and lights the chosen region in its colour',async()=>{
  const html=await renderHtml('/src/app/pro-library.jsx','ProRegionFilter',{value:'Pacific',onChange(){},counts:{all:4,Americas:1,EMEA:1,Pacific:1,China:1}});
  assert.equal((html.match(/<img src="\/assets\/regions\//g)||[]).length,4);
  assert.match(html,/aria-checked="true"[^>]*style="--region:#01d2d7"|style="--region:#01d2d7"[^>]*aria-checked="true"/);
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
