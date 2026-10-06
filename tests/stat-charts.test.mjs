import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext,Script} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const margins=html.slice(html.indexOf('function scoreMarginDistribution('),html.indexOf('\nfunction renderMatches('));
const eligibility=html.slice(html.indexOf('function isRREligible('),html.indexOf('\nfunction computeRRStats('));
const {scoreMarginDistribution:distribution,scoreMarginRREstimates:estimates}=runInNewContext(eligibility+'\n'+margins+'\n({scoreMarginDistribution,scoreMarginRREstimates})');
test('score margins use actual scores without requiring ranks or RR, with draws and exact unusual margins',()=>{
  const matches=[{myR:13,opR:11},{myR:11,opR:13},{myR:15,opR:15},{myR:13,opR:0},{myR:0,opR:14},
    {myR:13,opR:11},{myR:'13',opR:10},{myR:0,opR:0},{myR:-1,opR:13},{myR:13},{myR:1.5,opR:13}];
  const result=distribution(matches);
  assert.equal(result.total,6);
  assert.equal(result.bins.find(b=>b.margin===2).count,2);
  for(const margin of [-14,-2,0,13])assert.equal(result.bins.find(b=>b.margin===margin).count,1);
  assert.equal(result.bins.find(b=>b.margin===-13).count,0);
  assert.equal(result.bins.reduce((n,b)=>n+b.count,0),6);
  assert.equal(distribution([]).total,0);
});

test('competitive margin bins cover every regulation result and group overtime by its two-round lead',()=>{
  const matches=[];
  for(let loser=0;loser<=11;loser++)matches.push({myR:13,opR:loser},{myR:loser,opR:13});
  matches.push({myR:14,opR:12},{myR:28,opR:26},{myR:16,opR:18},{myR:13,opR:13},{myR:25,opR:25});
  const {bins,total}=distribution(matches);
  assert.equal(total,29);
  assert.equal(bins.length,25);
  assert.equal(bins.some(b=>Math.abs(b.margin)===1),false);
  assert.equal(bins.find(b=>b.margin===2).count,3);
  assert.equal(bins.find(b=>b.margin===-2).count,2);
  assert.equal(bins.find(b=>b.margin===0).count,2);
  for(const b of bins.filter(b=>Math.abs(b.margin)>=3))assert.equal(b.count,1);
});

test('one-round margins are added only if actually recorded',()=>{
  const {bins,total}=distribution([{myR:4,opR:3},{myR:5,opR:6}]);
  assert.equal(total,2);
  assert.equal(bins.find(b=>b.margin===1).count,1);
  assert.equal(bins.find(b=>b.margin===-1).count,1);
  assert.equal(distribution([]).bins.length,25);
});

test('combined chart averages only eligible recorded payouts and retains counts and exact overtime scores',()=>{
  const win={myR:13,opR:11,myTierId:10,won:true,myRR:20};
  const matches=[win,{...win,myR:14,opR:12,myRR:10},
    {...win,myRR:100,actPlacement:true},{...win,myRR:100,partySize:5},
    {...win,myRR:100,myTierId:0},{...win,myRR:null},{...win,myRR:Infinity},
    {...win,myRR:100,won:false},
    {...win,myR:11,opR:13,myRR:-24,won:false,was_derank_protected:true},
    {...win,myR:13,opR:13,myRR:0,won:null}];
  const {bins,total}=distribution(matches);
  const wins=bins.find(b=>b.margin===2),losses=bins.find(b=>b.margin===-2),draws=bins.find(b=>b.margin===0);
  assert.equal(total,10);
  assert.equal(wins.count,8);assert.equal(wins.rrCount,2);assert.equal(wins.avgRR,15);
  assert.equal(wins.scorelines.length,2);
  assert.equal(wins.scorelines.find(s=>s.scoreline==='13–11').avgRR,20);
  assert.equal(wins.scorelines.find(s=>s.scoreline==='14–12').avgRR,10);
  assert.equal(losses.avgRR,-24);assert.equal(losses.rrCount,1);
  assert.equal(draws.count,1);assert.equal(draws.avgRR,null);
  assert.equal(bins.find(b=>b.margin===3).avgRR,null);
});

test('zero payout remains a real RR sample instead of a missing value',()=>{
  const {bins}=distribution([{myR:13,opR:10,myRR:0,won:true,myTierId:10}]);
  assert.equal(bins.find(b=>b.margin===3).rrCount,1);
  assert.equal(bins.find(b=>b.margin===3).avgRR,0);
});

test('RR trend separates outcomes, uses all tied samples and leaves unsupported regions empty',()=>{
  const win=(margin,rr)=>({myR:13,opR:13-margin,myRR:rr,won:true,myTierId:10});
  const matches=[win(2,20),win(3,20),win(3,20),win(12,20),win(12,20),win(12,20),
    {myR:11,opR:13,myRR:-24,won:false,myTierId:10}];
  const trend=estimates(distribution(matches).bins,true);
  assert.equal(trend[0].position,2);assert.equal(trend.at(-1).position,12);
  assert.equal(trend[0].n,3);
  assert.ok(trend.some(point=>point.position===7&&point.payout===null));
  assert.ok(trend.filter(point=>point.payout!=null).every(point=>Math.abs(point.payout-20)<1e-10&&point.n>=3));
  assert.ok(estimates(distribution(matches).bins,false).every(point=>point.payout===null));
  assert.equal(JSON.stringify(estimates(distribution(matches.slice().reverse()).bins,true)),JSON.stringify(trend));
});

test('combined chart renders raw payouts and supported trend paths with separate count and RR axes',()=>{
  const element=()=>({attrs:{},children:[],textContent:'',hidden:false,
    setAttribute(key,value){this.attrs[key]=value;},
    appendChild(child){this.children.push(child);},
    replaceChildren(){this.children=[];},
  });
  const elements=new Map();
  const document={createElementNS:element,getElementById(id){
    if(!elements.has(id))elements.set(id,element());return elements.get(id);
  }};
  const helpers=html.slice(html.indexOf('function statChartNode('),html.indexOf('function renderTeammates('));
  const render=runInNewContext(helpers+'\n'+eligibility+'\n'+margins+'\nrenderScoreMarginChart',{
    document,rrSigned:(n,d)=>`${n<0?'−':'+'}${Math.abs(n).toFixed(d)}`,
  });
  const win={myR:13,opR:11,myRR:20,won:true,myTierId:10};
  render([win,{...win,opR:10,myRR:0},{...win,opR:9,myRR:null},{...win,opR:8,myRR:26},
    {...win,myR:11,opR:13,myRR:-24,won:false}]);
  const svg=elements.get('score-margin-chart').children[0];
  const points=svg.children.filter(n=>n.attrs.class?.startsWith('rr-payout-sample'));
  assert.equal(points.length,4);
  assert.equal(svg.children.filter(n=>n.attrs.class==='rr-payout-trend win').length,1);
  assert.equal(svg.children.filter(n=>n.attrs.class==='rr-payout-trend loss').length,0);
  assert.ok(points.some(point=>point.attrs.cy==='159'),'zero payout has a real dot at zero RR');
  assert.ok(svg.children.some(n=>n.textContent==='Matches'));
  assert.ok(svg.children.some(n=>n.textContent==='RR payout'));
  const focus=svg.children.find(n=>n.attrs.class==='rr-estimate-hit');
  assert.equal(focus.attrs.tabindex,'0');
  assert.match(focus.attrs['aria-label'],/Estimated RR \/ win/);
  assert.match(focus.attrs['aria-label'],/13–10/);
  assert.match(elements.get('score-margin-chart-count').textContent,/5 scored matches · 4 with eligible RR/);
  render([{myR:13,opR:11}]);
  assert.equal(elements.get('score-margin-chart-section').hidden,false);
  assert.equal(elements.get('score-margin-chart').children[0].children.some(n=>n.attrs.class?.startsWith('rr-payout-trend')),false);
  render([]);
  assert.equal(elements.get('score-margin-chart-section').hidden,true);
  assert.equal(elements.get('score-margin-chart').children.length,0);
});

test('inline application scripts remain syntactically valid',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new Script(match[1]);
});

test('party aggregation attaches your stats only to your same-team party teammates',()=>{
  const me={puuid:'me',name:'Me',team_id:'Blue',party_id:'party'};
  const friend={puuid:'friend',name:'Friend',tag:'EU',team_id:'Blue',party_id:'party',_kills:99,_deaths:1};
  const stranger={puuid:'stranger',name:'Stranger',team_id:'Blue',party_id:'other'};
  const opponent={puuid:'opponent',name:'Opponent',team_id:'Red',party_id:'party'};
  const context={PUUID:'me',PLAYER:'Me',TAG:'EU',allMatches:[],
    statMatches:[{players:[me,friend,stranger,opponent],myPartyId:'party',myRR:21,won:true,
      myStats:{kills:10,deaths:20,score:4000,rounds_played:20}}],
    document:{getElementById:()=>({style:{}})},computeEncounters:()=>[],
    renderTeammates:()=>{},renderEncounters:()=>{},renderWintradeSignals:()=>{},renderOverviewPreviews:()=>{},updateDetailPages:()=>{}};
  const start=html.indexOf('function buildTeammates('),end=html.indexOf('\nfunction renderEncounters(',start);
  const rows=runInNewContext(html.slice(start,end)+'\nbuildTeammates();allTeammates',context);
  assert.equal(rows.length,1);assert.equal(rows[0].key,'friend');
  assert.equal(rows[0].kills,99);
  assert.equal(rows[0].chartStats,undefined);
  assert.equal(rows[0].rrTotal,21);
});
