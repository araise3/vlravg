import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { closeRenderer,load,renderHtml,settle } from './helpers/react-render.mjs';

after(closeRenderer);
const html=readFileSync(new URL('../src/engine/core.mjs',import.meta.url),'utf8');
const start=html.indexOf('function nameHistoryActAt(');
const end=html.indexOf('/* ── REPLAY IMPORT',start);
assert.ok(start>0&&end>start);

test('act labels map observation dates onto the act timeline, spanning several acts',()=>{
  const {nameHistoryActRange}=runInNewContext(html.slice(start,end)+'\n({nameHistoryActRange})',{
    HARDCODED_ACT_META:{a:{start:Date.parse('2021-01-01')},b:{start:Date.parse('2021-03-01')},c:{start:Date.parse('2021-05-01')},d:{start:Date.parse('2021-07-01')}},
  });
  assert.equal(nameHistoryActRange('2021-07-10','2021-07-10').label,'E2A1');
  assert.equal(nameHistoryActRange('2021-01-10','2021-03-10').label,'E1A1 — A2');
  assert.equal(nameHistoryActRange('2020-01-01','2021-03-10').label,'—');
  assert.equal(nameHistoryActRange(null,'2021-03-10').title,'Episode and act unavailable');
});

test('name history table shows dates and acts, marks the current identity, and sorts newest first',async()=>{
  const engine=await load('/src/engine/core.mjs');
  const names=[
    {name:'Old',tag:'EU',first_seen:'2021-01-10',last_seen:'2021-03-10',ended_at:'2021-03-11'},
    {name:'Current',tag:'NOW',first_seen:'2021-07-10',last_seen:'2021-07-10',ended_at:null},
  ];
  engine.loadFixtureAnalysis({player:'Current',tag:'NOW',puuid:'me',season:'act',current:null,raw:[],names,
    rr:{change:{},pre:{},post:{},preTier:{},postTier:{},protected:{},details:{}}});
  await settle();
  const page=await renderHtml('/src/app/pages/Names.jsx','NamesPage');
  const body=page.slice(page.indexOf('<tbody'),page.indexOf('</tbody>'));
  const rows=body.split('<tr').slice(1);
  assert.equal(rows.length,2);
  for(const row of rows){
    assert.equal((row.match(/<t[hd][\s>]/g)||[]).length,4,'each row has Riot ID, first date, last date, and act');
    assert.equal((row.match(/<time /g)||[]).length,2,'first and last observations each have a date');
  }
  assert.match(rows[0],/Current<\/strong><span[^>]*>#NOW/);
  assert.match(rows[0],/>Current<\/span>/,'the current identity is marked');
  assert.doesNotMatch(rows[1],/>Current<\/span>/);
  assert.equal((rows[0].match(/10 Jul 2021/g)||[]).length,2);
  assert.match(rows[1],/10 Jan 2021.*10 Mar 2021/);
  const act=engine.nameHistoryActRange(names[1].first_seen,names[1].last_seen);
  assert.ok(rows[1].includes(`>${engine.nameHistoryActRange(names[0].first_seen,names[0].last_seen).label}</td>`));
  assert.ok(rows[0].includes(`>${act.label}</td>`));
  assert.equal(names[0].name,'Old','rendering must not reorder stored history');
});
