import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RR_RANGES,getSnapshot,rrScopedMatches,setRRRange} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const PAGE='/src/app/pages/RR.jsx';
const m=i=>({matchId:'m'+i,startedAtMs:Date.UTC(2026,9,1)+i*3600000,myRR:10,won:true});

test('a range keeps the most recent matches, newest first; all time keeps every match',()=>{
  assert.deepEqual(RR_RANGES,['all','50','30','20']);
  const matches=Array.from({length:25},(_,i)=>m(i));
  assert.equal(rrScopedMatches(matches,'all'),matches);
  assert.equal(rrScopedMatches(matches,undefined),matches);
  const last20=rrScopedMatches(matches,'20');
  assert.equal(last20.length,20);
  assert.equal(last20[0].matchId,'m24');
  assert.equal(last20.at(-1).matchId,'m5');
});

test('each RR card keeps its own range',async()=>{
  // emit() publishes a new snapshot on the next microtask.
  const ranges=async()=>{await Promise.resolve();await Promise.resolve();return getSnapshot().rrRanges;};
  assert.deepEqual(await ranges(),{summary:'all',trend:'all',sessions:'all'});
  setRRRange('trend','30');
  assert.deepEqual(await ranges(),{summary:'all',trend:'30',sessions:'all'});
  setRRRange('sessions','20');
  assert.deepEqual(await ranges(),{summary:'all',trend:'30',sessions:'20'});
  // Unknown cards and ranges are ignored; 50 needs more than 50 matches.
  setRRRange('movement','20');setRRRange('summary','10');setRRRange('summary','50');
  assert.deepEqual(await ranges(),{summary:'all',trend:'30',sessions:'20'});
  setRRRange('trend','all');setRRRange('sessions','all');
  assert.deepEqual(await ranges(),{summary:'all',trend:'all',sessions:'all'});
});

test('range menus list all time with the match count, and 50 only above 50 matches',async()=>{
  const {rrRangeOptions}=await load(PAGE);
  assert.deepEqual(rrRangeOptions(40).map(([k])=>k),['all','30','20']);
  assert.deepEqual(rrRangeOptions(51),[['all','All time (51)'],['50','Last 50'],['30','Last 30'],['20','Last 20']]);
  const html=await renderHtml(PAGE,'RRRangeSelect',{card:'trend',value:'30',total:80,label:'RR trend'});
  assert.match(html,/aria-label="Match range for RR trend"/);
  assert.match(html,/Last 30/);
});

test('the summary, trend and session cards each carry their own range menu',async()=>{
  const page=readFileSync(new URL('../src/app/pages/RR.jsx',import.meta.url),'utf8');
  const body=page.slice(page.indexOf('export function RRPage('));
  assert.doesNotMatch(page,/<Tabs|setRRTrendRange|rrTrendScopedMatches/);
  assert.match(body,/<RRRangeSelect card="summary" value=\{ranges\.summary\}/);
  assert.match(body,/<RRRangeSelect card="trend" value=\{ranges\.trend\}/);
  assert.match(body,/<RRTrendChart matches=\{matches\} range=\{ranges\.trend\}\/>/);
  assert.match(body,/<RRSessionCard matches=\{matches\} range=\{ranges\.sessions\}\/>/);
  const card=await renderHtml(PAGE,'RRSessionCard',{matches:[m(1),m(30)],range:'20'});
  assert.match(card,/aria-label="Match range for RR by session"/);
});
