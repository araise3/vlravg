import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { closeRenderer,renderHtml } from './helpers/react-render.mjs';

after(closeRenderer);

const html=readFileSync(new URL('../src/engine/core.mjs',import.meta.url),'utf8');
const start=html.indexOf('function isRREligible(');
const end=html.indexOf('\nfunction setRRMovementZoomTier(',start);
assert.ok(start>0&&end>start);
const {rrPayoutEstimates:estimates,rrPayoutSegments:segments,rrMovementXAxis:axis,rrMovementRows}=runInNewContext(
  html.slice(start,end)+'\n({rrPayoutEstimates,rrPayoutSegments,rrMovementXAxis,rrMovementRows})',{avgLabelShort:()=>''});
const row=(net,rr=100,won=net>0,axisRR=rr)=>({net,axisRR,m:{myPreRR:rr,won}});

// Gaussian weights by starting-RR distance, σ = 60 RR, no act-mean pull
// (docs/rr-payout-model-2026-11-20.md).
const weighted=(points,at)=>{
  const w=points.map(([x])=>Math.exp(-.5*((x-at)/60)**2));
  return points.reduce((sum,[,y],i)=>sum+w[i]*y,0)/w.reduce((a,b)=>a+b,0);
};

test('separate win and loss estimates weight every game by distance, without the act mean',()=>{
  const rows=[row(10,100),row(20,100),row(30,100),row(40,200),row(-12,100),row(-18,110),row(-24,120)];
  const gains=estimates(rows,rows,true);
  const losses=estimates(rows,rows,false);
  const winPoints=[[100,10],[100,20],[100,30],[200,40]];
  assert.equal(gains[0].position,100);
  assert.ok(Math.abs(gains[0].payout-weighted(winPoints,100))<1e-9);
  assert.ok(Math.abs(gains[0].payout-21.535)<1e-3);
  // The game 100 RR away still counts, at about a quarter weight.
  assert.ok(Math.abs(gains[1].payout-weighted(winPoints,200))<1e-9);
  assert.equal(gains[0].n,4);
  assert.equal(gains[0].actMean,25);
  assert.ok(Math.abs(losses[0].payout-weighted([[100,12],[110,18],[120,24]],100))<1e-9);
  assert.equal(losses[0].n,3);
});

test('an estimate needs 3 games within 120 RR, and the curve breaks only across wider gaps',()=>{
  const rows=[row(10,100),row(20,110),row(30,120),row(40,131),row(50,500)];
  const gains=estimates(rows,rows,true);
  const at100=gains.find(point=>point.position===100);
  assert.equal(at100.n,4);
  assert.equal(at100.max-at100.min,31);
  assert.equal(gains.find(point=>point.position===500).payout,null);
  assert.deepEqual(Array.from(segments(gains),part=>Array.from(part,point=>point.position)),[[100,110,120,131]]);
  const spaced=[{position:100,payout:10},{position:200,payout:12}];
  assert.deepEqual(Array.from(segments(spaced),part=>Array.from(part,point=>point.position)),[[100,200]]);
  const distant=[{position:100,payout:10},{position:260,payout:12}];
  assert.deepEqual(Array.from(segments(distant),part=>Array.from(part,point=>point.position)),[[100],[260]]);
});

test('zoomed estimates keep their full-rank neighbors but plot at displayed RR',()=>{
  const all=[row(12,2110,true,10),row(18,2120,true,20),row(24,2130,true,30),row(30,2140,true,40)];
  const [point]=estimates([all[1]],all,true);
  assert.equal(point.position,2120);
  assert.equal(point.axisPosition,20);
  assert.equal(point.n,4);
});

test('chart excludes five-stacks and does not add refunds to match payouts',()=>{
  const match=(myRR,partySize,myRefundedRR=0)=>({myRR,partySize,myRefundedRR,myPreRR:2200,myTierId:24,won:myRR>0});
  const rows=rrMovementRows([match(17,1,8),match(-19,5,0),match(-20,1,0)]);
  assert.deepEqual(Array.from(rows,row=>row.net),[17,-20]);
});

test('zoom uses displayed RR from zero and keeps higher Immortal RR',()=>{
  const sample=[21,70].map(rr=>({m:{myPreRR:2100+rr,myPreTierId:24,myTierId:24}}));
  const zoom=axis(sample,24);
  assert.deepEqual(Array.from(zoom.positions),[21,70]);
  assert.equal(zoom.min,0);
  assert.equal(zoom.max,100);
  assert.equal((zoom.positions[0]-zoom.min)/(zoom.max-zoom.min),.21);
  assert.equal(axis(sample,null).positions[0],2121);
  assert.equal(axis([{m:{myPreRR:2250,myPreTierId:24,myTierId:24}}],24).max,200);
});

test('full chart labels Immortal RR beyond the shaded 300-RR band',async()=>{
  const matches=[120,180,220,280,350,420,460].map(rr=>({
    myPreRR:2100+rr,myPreTierId:rr<200?25:26,myTierId:26,
    myRR:18,partySize:1,won:true,
  }));
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:null});
  const labels=[...svg.matchAll(/<text[^>]*y="302"[^>]*class="tick-label"[^>]*>([^<]*)<\/text>/g)].map(match=>match[1]);
  assert.deepEqual(labels,['100','150','200','250','300','350','400','450']);
});

test('zooming a rank keeps only that rank and labels its RR from zero',async()=>{
  const matches=[[24,30],[24,60],[24,80],[25,150]].map(([tier,rr])=>({
    myPreRR:2100+rr,myPreTierId:tier,myTierId:tier,myRR:18,partySize:1,won:true,
  }));
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:24});
  assert.match(svg,/class="chart-svg rr-movement-svg[^"]*zoomed/);
  assert.match(svg,/3 covered matches/);
  assert.match(svg,/Starting RR/);
});

const {rrPayoutEvenPoint:evenPoint}=runInNewContext(html.slice(start,end)+'\n({rrPayoutEvenPoint})',{avgLabelShort:()=>''});
const fixture=JSON.parse(readFileSync(new URL('./fixtures/rr-even-point-player.json',import.meta.url),'utf8'));
const fixtureRows=fixture.games.map(([pre,net,tier])=>({net,penalty:0,m:{myPreRR:pre,myPreTierId:tier,won:net>0?true:net<0?false:null}}));
const sloped=(n=12,{penalty=0}={})=>Array.from({length:n},(_,i)=>{const pre=2200+i*50;
  return [{net:30-i*2.5,penalty,m:{myPreRR:pre,won:true}},{net:-(8+i*2.5),penalty,m:{myPreRR:pre+5,won:false}}];}).flat();

test('even point: a real act where wins shrink and losses grow with rank crosses where both pay about 18 RR',()=>{
  const even=evenPoint(fixtureRows);
  assert.ok(even);
  assert.equal(Math.round(even.position),2776);
  assert.ok(Math.abs(even.payout-18)<1,'about 18 RR either way at the crossing');
  assert.ok(even.winSlope<0&&even.lossSlope>0);
  assert.ok(even.t<=-3);
  const near=fixtureRows.filter(r=>Math.abs(r.m.myPreRR-even.position)<=40&&r.net!==0);
  const avg=a=>a.reduce((s,v)=>s+v,0)/a.length;
  assert.ok(Math.abs(avg(near.filter(r=>r.net>0).map(r=>r.net))-avg(near.filter(r=>r.net<0).map(r=>-r.net)))<1,'games near the line pay evenly');
});

test('even point: none for flat payouts, a crossing outside the observed ranks, or too few games',()=>{
  const flat=Array.from({length:20},(_,i)=>({net:i%2?18+(i%3):-(18+(i%4)),penalty:0,m:{myPreRR:2200+i*10,won:!!(i%2)}}));
  assert.equal(evenPoint(flat),null);
  const outside=Array.from({length:12},(_,i)=>[{net:30-i*.5,penalty:0,m:{myPreRR:2200+i*20,won:true}},{net:-(8+i*.5),penalty:0,m:{myPreRR:2205+i*20,won:false}}]).flat();
  assert.equal(evenPoint(outside),null,'lines would only meet far above the highest starting rank');
  assert.equal(evenPoint(sloped(7)),null,'7 wins and 7 losses are not enough');
  assert.ok(evenPoint(sloped(8)));
});

test('even point leaves party-penalized games out',()=>{
  assert.equal(evenPoint(sloped(12,{penalty:.25})),null);
  const clean=evenPoint(sloped(12));
  const mixed=evenPoint([...sloped(12),{net:2,penalty:.5,m:{myPreRR:2300,won:true}}]);
  assert.equal(mixed.position,clean.position);
});

test('chart draws the even line with its explanation, and hides it when zoomed to another rank',async()=>{
  const matches=fixture.games.map(([pre,net,tier])=>({myPreRR:pre,myPreTierId:tier,myTierId:tier,myRR:net,partySize:1,won:net>0?true:net<0?false:null}));
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:null});
  assert.match(svg,/class="even-line"/);
  assert.match(svg,/Estimated even point/);
  // The explanation is the even line's accessible label; no paragraph above the chart (removed on request).
  assert.match(svg,/aria-label="Wins and losses pay about the same from a starting rank of [^"]*, 676 RR/);
  assert.doesNotMatch(svg,/data-even-point/);
  const evenTier=fixture.games.reduce((a,b)=>Math.abs(b[0]-2776)<Math.abs(a[0]-2776)?b:a)[2];
  assert.match(await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:evenTier}),/class="even-line"/);
  assert.doesNotMatch(await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:25}),/class="even-line"/);
  const flat=matches.map(m=>({...m,myRR:m.won?18:-18}));
  assert.doesNotMatch(await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches:flat,zoomTier:null}),/even-line|Estimated even point/);
});
