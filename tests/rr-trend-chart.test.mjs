import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const point=(value,tier,i=0,won=true)=>({value,match:{myPostRR:value,myPostTierId:tier,myRR:won?20:-15,won,startedAtMs:Date.UTC(2026,10,1+i),mapName:'Ascent'}});
const asMatches=points=>points.map(p=>p.match);

test('Immortal+ rank floors come from the recorded tiers, not a fixed Radiant line',async()=>{
  const {rrTrendRankBands}=await load('/src/app/pages/RR.jsx');
  const points=[point(2150,24),point(2250,25),point(2400,26),point(2480,26),point(2520,27),point(2700,27)];
  assert.deepEqual(rrTrendRankBands(points,2100,2750),[
    {start:2100,end:2200,tier:24},{start:2200,end:2325,tier:25},
    {start:2325,end:2500,tier:26},{start:2500,end:2750,tier:27},
  ]);
  // Immortal 3 well above 2400 without a recorded Radiant game stays Immortal 3.
  const noRadiant=rrTrendRankBands([point(2150,24),point(2500,26),point(2700,26)],2100,2750);
  assert.equal(noRadiant.at(-1).tier,26);
  assert.ok(noRadiant.every(band=>band.tier!==27));
});

test('ranks below Immortal keep 100 RR divisions',async()=>{
  const {rrTrendRankBands}=await load('/src/app/pages/RR.jsx');
  assert.deepEqual(rrTrendRankBands([point(1550,18),point(1650,19)],1500,1700),[
    {start:1500,end:1600,tier:18},{start:1600,end:1700,tier:19},
  ]);
});

test('date ticks keep one label per day and pin the ends',async()=>{
  const {rrTrendDateTicks}=await load('/src/app/pages/RR.jsx');
  const label=m=>new Date(m.startedAtMs).toISOString().slice(0,10);
  const sameDay=Array.from({length:12},()=>point(1500,18,0));
  assert.equal(rrTrendDateTicks(sameDay,800,100,label).length,1);
  const spread=Array.from({length:40},(_,i)=>point(1500,18,i));
  const ticks=rrTrendDateTicks(spread,800,100,label);
  assert.equal(ticks.length,9);
  assert.equal(ticks[0].i,0);assert.equal(ticks[0].anchor,'start');
  assert.equal(ticks.at(-1).i,39);assert.equal(ticks.at(-1).anchor,'end');
  assert.equal(new Set(ticks.map(t=>t.label)).size,ticks.length);
});

test('the trend shows an Immortal+ RR scale, a peak label and the end label',async()=>{
  const values=[2120,2180,2260,2350,2440,2560,2700,2810,2900,2860,2820,2790,2760,2740,2720,2700,2690,2680,2670,2660];
  const matches=asMatches(values.map((v,i)=>point(v,v<2200?24:v<2330?25:v<2500?26:27,i,i<8)));
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRTrendChart',{matches,range:'all'});
  assert.match(svg,/class="rr-tick unit"[^>]*>RR</);
  assert.match(svg,/class="rr-tick"[^>]*>0</);assert.match(svg,/class="rr-tick"[^>]*>200</);
  assert.match(svg,/class="peak-label">Peak Rad, 800 RR</);
  assert.match(svg,/class="ink-strong"[^>]*>Rad, 560 RR</);
  // Immortal+ charts: unlabelled dashed thresholds, no rank column, no
  // threshold labels and no rank-up icons (removed on request 22 Nov 2026).
  assert.doesNotMatch(svg,/class="rank-tick"/);
  assert.match(svg,/class="grid rank-line threshold"/);
  assert.doesNotMatch(svg,/threshold-label|rank-up|<image/);
  assert.match(svg,/aria-label="Match 20 of 20, [^"]*Radiant, 560 RR after −15 RR change"/);
});

test('the end label moves clear of a nearby peak and its dots instead of sitting on them',async()=>{
  const {placeEndLabel}=await load('/src/app/pages/RR.jsx');
  // The reported shape: the line peaks ~45px left of the end, 20px higher, with a dip just before the end.
  const ys=[160,150,140,130,120,110,103,98,92,87,95,100,112,118,107];
  const x=i=>700+i*10,textWidth='Rad, 370 RR'.length*6.6,dotRadius=4;
  const spot=placeEndLabel({ys,x,left:12,top:22,bottom:264,textWidth,dotRadius});
  assert.equal(spot.x,x(ys.length-1));
  // No dot (centre ± radius) touches the label's box (13px above the baseline to 4px below, plus the halo).
  ys.forEach((py,i)=>{
    const inX=x(i)+dotRadius>=spot.x-textWidth&&x(i)-dotRadius<=spot.x;
    assert.ok(!(inX&&py+dotRadius>=spot.y-15&&py-dotRadius<=spot.y+6),`dot ${i} at y ${py} overlaps a label at y ${spot.y}`);
  });
  // The old pick (12px above the end) sat on the peak; the nearest clear spot is just under the dip.
  assert.notEqual(spot.y,95);
  assert.equal(spot.y,139);
  // An open end keeps the first spot, 12px above the end point.
  assert.deepEqual(placeEndLabel({ys:[200,190,180,170,160],x,left:12,top:22,bottom:264,textWidth,dotRadius}),{x:x(4),y:148});
});

test('charts below Immortal keep the rank column and add no thresholds',async()=>{
  const matches=asMatches([point(1550,18,0),point(1580,18,1),point(1620,19,2)]);
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRTrendChart',{matches,range:'all'});
  assert.match(svg,/class="rank-tick"/);
  assert.doesNotMatch(svg,/rank-line threshold/);
});

test('ranks below Immortal get no RR scale',async()=>{
  const matches=asMatches([point(1550,18,0),point(1580,18,1),point(1620,19,2)]);
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRTrendChart',{matches,range:'all'});
  assert.doesNotMatch(svg,/rr-tick/);
  assert.match(svg,/class="rank-tick">Dia 1</);
});

test('the RR trend tooltip trails the pointer and falls back to the side that fits',async()=>{
  const {chartTooltipPlacement}=await load('/src/app/shared.jsx');
  const at=(x,side)=>chartTooltipPlacement({x,width:800,tipWidth:120,side});
  // Moving right puts it on the left of the point; moving left, on the right.
  assert.deepEqual(at(400,'left'),{right:414});
  assert.deepEqual(at(400,'right'),{left:414});
  // Too close to an edge for the chosen side: the other side.
  assert.deepEqual(at(60,'left'),{left:74});
  assert.deepEqual(at(740,'right'),{right:74});
  // Without a side (keyboard focus, other charts): right, flipping left near the right edge as before.
  assert.deepEqual(chartTooltipPlacement({x:400,width:800}),{left:414});
  assert.deepEqual(chartTooltipPlacement({x:600,width:800}),{right:214});
});

test('the RR trend tooltip is two short lines: change with map and score, then the rank after',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../src/app/pages/RR.jsx',import.meta.url),'utf8');
  const tooltip=source.slice(source.indexOf('<ChartTooltip x={tip.xx}'),source.indexOf('</ChartTooltip>',source.indexOf('<ChartTooltip x={tip.xx}')));
  assert.match(tooltip,/side=\{heading==='right'\?'left':heading==='left'\?'right':undefined\} className="tt-compact"/);
  assert.equal((tooltip.match(/className="tt-row"/g)||[]).length,2);
  assert.match(tooltip,/\{avgLabelShort\(tip\.rank\.tier\)\} \{tip\.rank\.rr\} RR<\/div>/);
  for(const gone of [/RR after/,/Match \{active\+1\}/,/tip\.duo/,/tt-key/])assert.doesNotMatch(tooltip,gone);
});
