import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function isRREligible(');
const end=html.indexOf('\nfunction renderRRMovement(',start);
assert.ok(start>0&&end>start);
const {rrPayoutEstimates:estimates,rrGaussianPayoutEstimates:gaussian,rrPayoutSegments:segments,rrMovementXAxis:axis,rrMovementRows}=runInNewContext(
  html.slice(start,end)+'\n({rrPayoutEstimates,rrGaussianPayoutEstimates,rrPayoutSegments,rrMovementXAxis,rrMovementRows})',{avgLabelShort:()=>''});
const row=(net,rr=100,won=net>0,axisRR=rr)=>({net,axisRR,m:{myPreRR:rr,won}});

test('separate win and loss estimates use nearby matches and the act mean',()=>{
  const rows=[row(10,100),row(20,100),row(30,100),row(40,200),row(-12,100),row(-18,110),row(-24,120)];
  const gains=estimates(rows,rows,true);
  const losses=estimates(rows,rows,false);
  assert.equal(gains[0].n,3);
  assert.equal(gains[0].actMean,25);
  assert.equal(gains[0].payout,(10+20+30+8*25)/11);
  assert.equal(gains[1].payout,null);
  assert.equal(losses[0].n,3);
  assert.equal(losses[0].payout,18);
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

test('full chart labels Immortal RR beyond the shaded 300-RR band',()=>{
  const element=()=>({
    children:[],attrs:{},textContent:'',
    setAttribute(name,value){this.attrs[name]=value;},
    appendChild(child){this.children.push(child);},
    replaceChildren(){this.children=[];},
    addEventListener(){},
  });
  const elements=new Map();
  const document={
    getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    createElementNS:element,
  };
  const renderEnd=html.indexOf('\nlet rrTrendMatches=',end);
  const render=runInNewContext(html.slice(start,renderEnd)+'\nrenderRRMovement',{
    document,rrMovementZoomTier:null,avgLabel:()=>'',avgLabelShort:()=>'',
  });
  render([120,180,220,280,350,420,460].map(rr=>({
    myPreRR:2100+rr,myPreTierId:rr<200?25:26,myTierId:26,
    myRR:18,partySize:1,won:true,
  })));
  const svg=elements.get('rr-movement-chart').children[0];
  const labels=svg.children.filter(node=>node.attrs.class==='tick-label'&&node.attrs.y==='302');
  assert.deepEqual(labels.map(node=>node.textContent),['100','150','200','250','300','350','400','450']);
});

test('Gaussian uses 80 RR distance weights without a prior or five-match cap',()=>{
  const rows=[...Array.from({length:8},()=>row(10,100)),row(30,180),row(99,345),row(-25,100)];
  const points=gaussian(rows,rows,true);
  const point=points.find(p=>p.position===100);
  const weight=Math.exp(-.5);
  assert.ok(Math.abs(point.payout-(80+30*weight)/(8+weight))<1e-12);
  assert.equal(point.n,9);
  assert.equal(point.limited,false);
  assert.equal(point.max,180);
  assert.ok(points.every(p=>p.payout==null||(p.payout>=10&&p.payout<=99)));
  assert.ok(points.every(p=>p.position>=100&&p.position<=345));
  assert.ok(points.some(p=>p.position===105));
  assert.equal(gaussian(rows,rows,false).length,0);
});

test('Gaussian low-data averages are dashed; large unsupported gaps stay empty',()=>{
  const low=[row(10,100),row(20,120),row(30,140)];
  const average=gaussian(low,low,true);
  assert.ok(average.every(p=>p.payout===20&&p.averageOnly&&p.limited));
  const rows=[...Array.from({length:8},()=>row(12,100)),...Array.from({length:8},()=>row(24,700))];
  const points=gaussian(rows,rows,true);
  assert.equal(points.find(p=>p.position===400).payout,null);
  const parts=segments(points,Infinity,true);
  assert.equal(parts.length,2);
  assert.ok(parts[0].at(-1).position<400&&parts[1][0].position>400);
  const limited=Array.from({length:6},()=>row(17,100));
  assert.equal(gaussian(limited,limited,true)[0].limited,true);
});

test('Gaussian zoom preserves estimates and continuous Immortal coordinates',()=>{
  const all=Array.from({length:12},(_,i)=>row(12+i,2200+i*5));
  const full=gaussian(all,all,true);
  const visible=all.slice(2,8).map(r=>({...r,axisRR:r.m.myPreRR-2100}));
  const zoom=gaussian(visible,all,true);
  for(const point of zoom){
    const original=full.find(p=>p.position===point.position);
    assert.equal(point.payout,original.payout);
    assert.equal(point.axisPosition,point.position-2100);
  }
});

test('Gaussian excludes party penalties and keeps dates and duplicate coordinates',()=>{
  const rows=Array.from({length:8},(_,i)=>({...row(10+i,100),m:{myPreRR:100,won:true,startedAtMs:1000+i}}));
  rows.push({...row(90,100),penalty:.25});
  const [point]=gaussian(rows,rows,true);
  assert.equal(point.n,8);
  assert.equal(point.payout,13.5);
  assert.equal(point.dateMin,1000);
  assert.equal(point.dateMax,1007);
  const invalid={myRR:NaN,myPreRR:Infinity,myTierId:24,won:true};
  assert.equal(rrMovementRows([invalid]).length,0);
});

test('chart methods switch both ways while retaining rank zoom and match dots',()=>{
  const element=()=>({children:[],attrs:{},textContent:'',checked:false,
    setAttribute(name,value){this.attrs[name]=value;},appendChild(child){this.children.push(child);},
    replaceChildren(){this.children=[];},addEventListener(){}});
  const elements=new Map();
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    querySelector:selector=>document.getElementById(selector),createElementNS:element};
  const renderEnd=html.indexOf('\nlet rrTrendMatches=',end);
  const context={document,rrMovementZoomTier:24,avgLabel:()=>'',avgLabelShort:()=>''};
  const api=runInNewContext(html.slice(start,renderEnd)+'\n({renderRRMovement,setRRMovementMethod})',context);
  const matches=Array.from({length:12},(_,i)=>({myPreRR:2110+i*5,myPreTierId:24,myTierId:24,myRR:12+i,partySize:1,won:true}));
  api.renderRRMovement(matches);
  const current=elements.get('rr-movement-chart').children[0];
  api.setRRMovementMethod('gaussian');
  const smoothed=elements.get('rr-movement-chart').children[0];
  assert.equal(context.rrMovementZoomTier,24);
  assert.equal(smoothed.children.filter(n=>n.attrs.class==='trend-point positive').length,12);
  assert.match(elements.get('rr-movement-trend-note').textContent,/Gaussian 80 RR/);
  api.setRRMovementMethod('current');
  assert.deepEqual(elements.get('rr-movement-chart').children[0].children.map(n=>n.attrs),current.children.map(n=>n.attrs));
  api.setRRMovementMethod('invalid');
  assert.match(elements.get('rr-movement-trend-note').textContent,/3–5 nearby/);
});
