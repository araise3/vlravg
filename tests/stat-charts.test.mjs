import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext,Script} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const margins=html.slice(html.indexOf('function scoreMarginDistribution('),html.indexOf('\nfunction renderMatches('));
const distribution=runInNewContext(margins+'\nscoreMarginDistribution');
const stats=html.slice(html.indexOf('function rrBucketStats('),html.indexOf('// ── Column renderer'));
const table=html.slice(html.indexOf('function buildRRScoreRows('),html.indexOf('/* ── CLUTCHES'));
const scoreRows=runInNewContext(stats+'\n'+table+'\nbuildRRScoreRows');
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

test('result table keeps regulation and overtime separate with eligible actual payouts',()=>{
  const win={myR:13,opR:11,myTierId:10,won:true,myRR:20};
  const matches=[win,{...win,myR:14,opR:12,myRR:10},
    {...win,myRR:100,actPlacement:true},{...win,myRR:100,partySize:5},
    {...win,myRR:100,myTierId:0},{...win,myRR:null},{...win,myRR:Infinity},
    {...win,myRR:100,won:false},
    {...win,myR:11,opR:13,myRR:-24,won:false,was_derank_protected:true},
    {...win,myR:13,opR:13,myRR:0,won:null},
    {...win,opR:10,myRR:0}];
  const rows=scoreRows(matches);
  assert.equal(rows.length,3);
  assert.deepEqual(Array.from(rows,r=>[r.high,r.low]),[[13,11],[14,12],[13,10]]);
  assert.equal(rows[0].stats.avgGain,20);assert.equal(rows[0].stats.avgLoss,24);
  assert.equal(rows[0].stats.wins,1);assert.equal(rows[0].stats.losses,1);
  assert.equal(rows[1].stats.avgGain,10);assert.equal(rows[1].stats.losses,0);
  assert.equal(rows[2].stats.avgGain,0);
  assert.equal(distribution(matches).total,11,'distribution still includes all scored games');
  assert.equal(scoreRows([]).length,0);
});

test('player-rank table includes every game and performance while preserving eligible RR averages',()=>{
  const base={myTierId:24,won:true,myRR:18,myStats:{kills:10,deaths:5,acs:200,performanceScore:0}};
  const matches=[base,{...base,won:false,myRR:-22},
    {...base,myRR:null,myStats:{kills:20,deaths:10,acs:300}},
    {...base,won:false,myRR:-90,actPlacement:true},
    {...base,myRR:90,partySize:5},
    {...base,won:null,myRR:null,myStats:null},
    {...base,myTierId:25,won:false,myRR:null},
    {...base,myTierId:0,won:null,myRR:null,myStats:null}];
  const container={innerHTML:'',querySelector:()=>({})};
  let values;
  const render=runInNewContext(stats+'\n'+html.slice(html.indexOf('function renderRRBreakdown('),html.indexOf('function buildRRScoreRows('))+'\nrenderRRBreakdown',{
    allMatches:matches,document:{getElementById:()=>container},
    renderPerformanceDna:()=>{},renderScoreMarginChart:()=>{},renderRRByScore:()=>{},renderRRTrend:()=>{},
    renderRRSummary:()=>{},rrTrendScopedMatches:m=>m,renderRRMovement:()=>{},
    rankIcon:()=>'',avgLabel:tier=>String(tier),rrSigned:(n,d)=>`${n<0?'−':'+'}${Math.abs(n).toFixed(d)}`,
    highlightTableMaxima:()=>{},initTableSorting:(_,rows)=>{values=rows;},
  });
  render(matches);
  assert.equal(values.reduce((n,row)=>n+row[1],0),matches.length);
  const immortal=values.find(row=>row[0]===24);
  assert.equal(immortal[1],6);
  assert.equal(immortal[2],2);assert.equal(immortal[3],220);
  assert.equal(immortal[4],0);
  assert.equal(immortal[5],60,'all wins and losses count, with draws excluded');
  assert.equal(immortal[6],18);assert.equal(immortal[7],-22);
  const noRR=values.find(row=>row[0]===25);
  assert.equal(noRR[1],1);assert.equal(noRR[5],0);
  assert.equal(noRR[6],null);assert.equal(noRR[7],null);
  assert.equal(values.find(row=>row[0]===0)[1],1,'unrated game remains visible');
  render(matches.filter(m=>m.myRR==null));
  assert.equal(values.reduce((n,row)=>n+row[1],0),4);
  assert.ok(values.every(row=>row[6]===null&&row[7]===null));
});

test('RR breakdown remains visible for a loaded act containing only games without RR',()=>{
  const elements=new Map();
  const document={querySelector:()=>({}),getElementById:id=>{
    if(!elements.has(id))elements.set(id,{});return elements.get(id);
  }};
  const start=html.indexOf('function updateDetailPages(');
  const end=html.indexOf("  document.getElementById('party-size-section')",start);
  runInNewContext(html.slice(start,end)+'}\nupdateDetailPages();',{
    document,analysisState:'ready',allMatches:[{myRR:null}],nameHistoryState:'idle',
    scoreMarginDistribution:()=>({total:0}),
  });
  assert.equal(elements.get('rr-tables').hidden,false);
  assert.equal(elements.get('rr-empty').hidden,true);
});

test('distribution renders counts with accessible exact scores independently of RR',()=>{
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
  const render=runInNewContext(helpers+'\n'+margins+'\nrenderScoreMarginChart',{document});
  render([{myR:13,opR:11},{myR:14,opR:12},{myR:11,opR:13},{myR:13,opR:13}]);
  const svg=elements.get('score-margin-chart').children[0];
  assert.ok(svg.children.some(n=>n.textContent==='Matches'));
  assert.equal(svg.children.some(n=>n.textContent==='RR payout'),false);
  const bars=svg.children.filter(n=>n.attrs.class?.startsWith('bar '));
  assert.equal(bars.length,3);
  const win=bars.find(n=>n.attrs.class==='bar win');
  assert.equal(win.attrs.tabindex,'0');
  assert.match(win.attrs['aria-label'],/13–11: 1 matches/);
  assert.match(win.attrs['aria-label'],/14–12: 1 matches/);
  assert.equal(elements.get('score-margin-chart-count').textContent,'4 scored matches');
  render([]);
  assert.equal(elements.get('score-margin-chart-section').hidden,true);
  assert.equal(elements.get('score-margin-chart').children.length,0);
});

test('inline application scripts remain syntactically valid',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new Script(match[1]);
});

test('party aggregation attaches your stats only to your same-team party teammates',()=>{
  const me={puuid:'me',name:'Me',team_id:'Blue',party_id:'party'};
  const friend={puuid:'friend',name:'Friend',tag:'EU',team_id:'Blue',party_id:'party',_kills:99,_deaths:1,_performanceScore:312.5};
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
  assert.equal(rows[0].performanceSum,312.5);assert.equal(rows[0].performanceCount,1);
  assert.equal(rows[0].chartStats,undefined);
  assert.equal(rows[0].rrTotal,21);
});
