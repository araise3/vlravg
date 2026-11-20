import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RR_PAYOUT_WINDOW,rrPayoutTimeline} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const PAGE='/src/app/pages/RR.jsx';
const at=i=>Date.UTC(2026,9,1,12)+i*3600000;
const m=(i,rr,won,extra={})=>({matchId:'m'+i,startedAtMs:at(i),myRR:rr,won,myTierId:15,partySize:1,mapName:'Ascent',myR:13,opR:9,...extra});

test('the payout timeline keeps eligible matches in play order with trailing win and loss averages',()=>{
  assert.equal(RR_PAYOUT_WINDOW,5);
  const matches=[
    m(3,-20,false),m(1,24,true),m(2,22,true),m(4,0,undefined),
    m(5,30,true,{partySize:5}),            // full 5-stack: not eligible
    m(6,40,true,{actPlacement:true}),       // placement: not eligible
    m(7,null,true),                         // no recorded change
    m(8,20,true),m(9,18,true),m(10,16,true),m(11,14,true),
  ];
  const rows=rrPayoutTimeline(matches);
  assert.deepEqual(rows.map(r=>r.match.matchId),['m1','m2','m3','m4','m8','m9','m10','m11']);
  assert.deepEqual(rows.map(r=>r.result),['win','win','loss','draw','win','win','win','win']);
  assert.deepEqual(rows.map(r=>r.i),[0,1,2,3,4,5,6,7]);
  // No loss yet: null until the first one, then carried forward.
  assert.deepEqual(rows.map(r=>r.lossAvg),[null,null,-20,-20,-20,-20,-20,-20]);
  // Wins average their own last five: 24,22,20,18,16 then 22,20,18,16,14.
  assert.deepEqual(rows.map(r=>r.winAvg),[24,23,23,23,22,21,20,18]);
  assert.deepEqual(rrPayoutTimeline([]),[]);
});

test('payout x ticks: match 1, then round match numbers far enough apart',async()=>{
  const {rrPayoutXTicks}=await load(PAGE);
  assert.deepEqual(rrPayoutXTicks(40,800,80).map(t=>t.label),['1','5','10','15','20','25','30','35','40']);
  assert.deepEqual(rrPayoutXTicks(40,800,40).map(t=>t.label).slice(0,4),['1','2','4','6']);
  assert.deepEqual(rrPayoutXTicks(1,800,40),[{k:0,label:'1'}]);
});

test('the payout chart draws dots, both average lines and a legend with the latest averages',async()=>{
  const matches=[m(1,24,true),m(2,-18,false),m(3,0,undefined),m(4,20,true),m(5,-22,false)];
  const html=await renderHtml(PAGE,'RRPayoutChart',{matches});
  assert.equal([...html.matchAll(/class="payout-point (win|loss|draw)"/g)].length,5);
  assert.match(html,/class="avg-line win" d="M/);
  assert.match(html,/class="avg-line loss" d="M/);
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.match(text,/Avg win, last 5 \+22\.0 Avg loss, last 5 −20\.0 Each match/);
  assert.match(html,/aria-label="Match 3 of 5, [^"]+, Ascent, 13–9, Draw: \+0 RR; average of last 5 wins \+24\.0, losses −18\.0"/);
  assert.match(text,/Eligible matches only: placements, unrated ranks and full 5-stacks are left out\./);
  const empty=await renderHtml(PAGE,'RRPayoutChart',{matches:[m(1,30,true,{partySize:5})]});
  assert.match(empty,/No RR payouts to chart in this range\./);
});

test('the payout card follows the RR trend card, in match order only',async()=>{
  const card=await renderHtml(PAGE,'RRPayoutCard',{matches:[m(1,24,true)]});
  assert.match(card,/<h2 id="rr-payout-time-title">RR payout over time<\/h2>/);
  // The Date axis was removed on request: no axis switch.
  assert.doesNotMatch(card,/Payout chart x-axis|>Date</);
  const page=readFileSync(new URL('../src/app/pages/RR.jsx',import.meta.url),'utf8');
  const body=page.slice(page.indexOf('export function RRPage('));
  assert.ok(body.indexOf('id="rr-trend-title"')<body.indexOf('<RRPayoutCard matches={scoped}/>'));
  assert.ok(body.indexOf('<RRPayoutCard matches={scoped}/>')<body.indexOf('<RRMovementChart'));
});
