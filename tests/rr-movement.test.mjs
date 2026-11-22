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
const {rrPayoutEstimates:estimates,rrPayoutSegments:segments,rrMovementXAxis:axis,rrMovementRows,rrMarginAdjusted:adjusted,RR_MARGIN_REFERENCE}=runInNewContext(
  html.slice(start,end)+'\n({rrPayoutEstimates,rrPayoutSegments,rrMovementXAxis,rrMovementRows,rrMarginAdjusted,RR_MARGIN_REFERENCE})',{avgLabelShort:()=>''});
const row=(net,rr=100,won=net>0,axisRR=rr)=>({net,axisRR,m:{myPreRR:rr,won}});

test('separate win and loss estimates use nearby matches and the act mean',()=>{
  const rows=[row(10,100),row(20,100),row(30,100),row(40,200),row(-12,100),row(-18,110),row(-24,120)];
  const gains=estimates(rows,rows,true);
  const losses=estimates(rows,rows,false);
  assert.equal(gains[0].n,3);
  assert.equal(gains[0].actMean,25);
  // Blended with the act mean at weight 2 (8 until 2026-11-21).
  assert.equal(gains[0].payout,(10+20+30+2*25)/5);
  assert.equal(gains[1].payout,null);
  assert.equal(losses[0].n,3);
  assert.equal(losses[0].payout,18);
});

test('payouts are evened out to a 4-round margin by outcome and rank group before averaging',()=>{
  assert.equal(RR_MARGIN_REFERENCE,4);
  const scored=(net,myR,opR,tier,rr=100)=>({net,axisRR:rr,m:{myPreRR:rr,won:net>0,myR,opR,myPreTierId:tier}});
  const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} vs ${expected}`);
  // Immortal win 13-3 (margin 10): 6 rounds over the reference at 0.36 RR each.
  near(adjusted(scored(24,13,3,25)),24-.36*6);
  // Ascendant loss 11-13 (margin 2): 2 rounds under, so the cost is raised by 2 x 0.36.
  near(adjusted(scored(-17,11,13,22)),17+.36*2);
  // Iron-Gold loss 3-13 costs 0.45 per round; Radiant win 13-9 is at the reference.
  near(adjusted(scored(-25,3,13,12)),25-.45*6);
  near(adjusted(scored(20,13,9,27)),20);
  // No known score: the raw payout.
  near(adjusted(row(18)),18);
  // The curve averages adjusted payouts: three blowout wins and two close wins at one spot.
  const rows=[scored(24,13,3,25),scored(24,13,3,25),scored(24,13,3,25),scored(16,13,11,25),scored(16,13,11,25)];
  const [point]=estimates(rows,rows,true);
  const values=rows.map(adjusted),mean=values.reduce((a,b)=>a+b,0)/values.length;
  near(point.payout,(values.reduce((a,b)=>a+b,0)+2*mean)/(values.length+2));
  near(point.actMean,mean);
});

test('local samples never span more than 30 RR and sparse points leave gaps',()=>{
  const rows=[row(10,100),row(20,110),row(30,120),row(40,131),row(50,200)];
  const gains=estimates(rows,rows,true);
  const at100=gains.find(point=>point.position===100);
  assert.equal(at100.n,3);
  assert.equal(at100.max-at100.min,20);
  assert.equal(gains.find(point=>point.position===200).payout,null);
  assert.deepEqual(Array.from(segments(gains),part=>Array.from(part,point=>point.position)),[[100,110,120,131]]);
  const distant=[{position:100,payout:10},{position:140,payout:12}];
  assert.deepEqual(Array.from(segments(distant),part=>Array.from(part,point=>point.position)),[[100],[140]]);
});

test('where 30 RR holds fewer than 3 games the window widens to 60 RR and lines reach that far',()=>{
  // A fast climber: wins start about 25 RR apart, so 30 RR never holds three.
  const rows=[row(30,100),row(29,125),row(28,150),row(27,175),row(26,200)];
  const gains=estimates(rows,rows,true);
  assert.ok(gains.every(point=>point.payout!=null));
  assert.ok(gains.every(point=>point.span===60&&point.max-point.min<=60));
  assert.deepEqual(Array.from(gains,point=>point.n),[3,3,3,3,3]);
  assert.deepEqual(Array.from(segments(gains),part=>part.length),[5]);
  // Dense spots keep the 30 RR window and its sample.
  const dense=[row(10,100),row(20,110),row(30,120),row(40,300),row(50,325),row(60,350)];
  const mixed=estimates(dense,dense,true);
  assert.deepEqual(Array.from(mixed,point=>point.span),[30,30,30,60,60,60]);
  // Still a gap beyond 60 RR, and lines do not bridge it.
  assert.deepEqual(Array.from(segments(mixed),part=>Array.from(part,point=>point.position)),[[100,110,120],[300,325,350]]);
  const lone=estimates([row(10,100),row(20,110),row(30,500)],[row(10,100),row(20,110),row(30,500)],true);
  assert.ok(lone.every(point=>point.payout==null));
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
const apart=JSON.parse(readFileSync(new URL('./fixtures/rr-even-point-apart.json',import.meta.url),'utf8'));
const apartRows=apart.games.map(([pre,net,tier,myR,opR,penalty,minutes])=>({net,penalty,m:{myPreRR:pre,myPreTierId:tier,myR,opR,won:net>0,startedAtMs:minutes*60000}}));
// Games in play order: `gap` RR between wins and losses, alternating win/loss.
const stretch=(n,gap,{penalty=0,from=2300}={})=>Array.from({length:n},(_,i)=>({net:i%2?-(18+(i%4===1?.5:-.5)):18+gap,penalty,m:{myPreRR:from+i*2,won:!(i%2),startedAtMs:i*3600000}}));

test('even point: a real act where wins and losses paid the same for a stretch of games',()=>{
  const even=evenPoint(fixtureRows);
  assert.ok(even);
  // The stretch: 34 games from 588 to 774 RR, wins +18.9 and losses −18.7 on average; the line sits at its middle.
  assert.equal(even.games,34);
  assert.equal(even.position-2100,670);
  assert.deepEqual([even.minRR-2100,even.maxRR-2100],[588,774]);
  assert.ok(Math.abs(even.winPayout-even.lossPayout)<=1.5);
});

test('even point: none where wins and losses close in but stay apart, as the old line fit claimed',()=>{
  // The old fit drew "Even at 380 RR" for this player; in play order the gap never got under 2.2 RR.
  assert.equal(evenPoint(apartRows),null);
});

test('even point: needs a sustained stretch, not a few even games',()=>{
  assert.ok(evenPoint(stretch(24,0)),'24 even games in a row');
  assert.equal(evenPoint(stretch(24,3)),null,'3 RR apart throughout');
  assert.equal(evenPoint(stretch(19,0)),null,'19 games is too short a stretch');
  // A short even patch between apart games is not enough. (Windows overlapping its edges can
  // stretch a patch by a few games, so this one is well short of 20.)
  const patch=[...stretch(12,6),...stretch(10,0,{from:2330}).map(r=>({...r,m:{...r.m,startedAtMs:r.m.startedAtMs+12*3600000}})),...stretch(12,6,{from:2370}).map(r=>({...r,m:{...r.m,startedAtMs:r.m.startedAtMs+30*3600000}}))];
  assert.equal(evenPoint(patch),null);
  // Order is play order, not rank order.
  assert.equal(evenPoint([...stretch(24,0)].reverse()).games,24);
});

test('even point leaves party-penalized games out',()=>{
  assert.equal(evenPoint(stretch(24,0,{penalty:.25})),null);
  const clean=evenPoint(stretch(24,0));
  const mixed=evenPoint([...stretch(24,0),{net:2,penalty:.5,m:{myPreRR:2310,won:true,startedAtMs:5}}]);
  assert.equal(mixed.position,clean.position);
});

test('chart draws the even line with its explanation, and hides it when zoomed to another rank',async()=>{
  const matches=fixture.games.map(([pre,net,tier])=>({myPreRR:pre,myPreTierId:tier,myTierId:tier,myRR:net,partySize:1,won:net>0?true:net<0?false:null}));
  const svg=await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:null});
  assert.match(svg,/class="even-line"/);
  // Tooltips and the footnote say the line is at a typical 4-round margin; the dots stay actual payouts.
  assert.match(svg,/aria-label="Estimated RR \/ (win|loss) at a 4-round margin: /);
  assert.match(svg,/evened out to a 4-round margin\. Faint dots are your actual payouts; gaps mean too few games\. The even point marks a stretch of games where wins and losses paid the same/);
  assert.match(svg,/Estimated even point/);
  assert.match(svg,/>Even at 670 RR</);
  // The explanation is the even line's accessible label; no paragraph above the chart (removed on request).
  assert.match(svg,/aria-label="Wins and losses paid about the same over 34 games in a row \(20 wins at \+18\.9 RR, 14 losses at −18\.7 RR, evened out to a 4-round margin\), starting between [^"]*588 RR and [^"]*774 RR\. The line is at the stretch&#x27;s middle starting rank, [^"]*670 RR\./);
  assert.doesNotMatch(svg,/data-even-point/);
  const evenTier=fixture.games.reduce((a,b)=>Math.abs(b[0]-2770)<Math.abs(a[0]-2770)?b:a)[2];
  assert.match(await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:evenTier}),/class="even-line"/);
  assert.doesNotMatch(await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches,zoomTier:25}),/class="even-line"/);
  const apartMatches=apartRows.map(row=>({...row.m,myTierId:row.m.myPreTierId,myRR:row.net,partySize:1}));
  assert.doesNotMatch(await renderHtml('/src/app/pages/RR.jsx','RRMovementChart',{matches:apartMatches,zoomTier:null}),/even-line|Estimated even point/);
});
