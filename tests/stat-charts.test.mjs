import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext,Script} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const teammate=html.slice(html.indexOf('function addTeammateChartStats('),html.indexOf('\nfunction renderTeammates('));
const margins=html.slice(html.indexOf('function scoreMarginDistribution('),html.indexOf('\nfunction renderMatches('));
const {addTeammateChartStats:add,scoreMarginDistribution:distribution}=runInNewContext(teammate+'\n'+margins+'\n({addTeammateChartStats,scoreMarginDistribution})');

test('RR means use recorded payouts, keeping shields and party penalties and excluding missing data and draws',()=>{
  const target={};
  [{won:true,myRR:20},{won:true,myRR:10,partySize:5},{won:false,myRR:-18,was_derank_protected:true},
    {won:false,myRR:null},{won:true},{won:undefined,myRR:0}].forEach(m=>add(target,m));
  const s=target.chartStats;
  assert.equal(s.rrWins,2);assert.equal(s.rrWinTotal/s.rrWins,15);
  assert.equal(s.rrLosses,1);assert.equal(s.rrLossTotal,-18);
});


test('score margins use actual scores without requiring ranks or RR, with explicit draws and outer buckets',()=>{
  const matches=[{myR:13,opR:11},{myR:11,opR:13},{myR:15,opR:15},{myR:13,opR:0},{myR:0,opR:14},
    {myR:13,opR:11},{myR:'13',opR:10},{myR:0,opR:0},{myR:-1,opR:13},{myR:13},{myR:1.5,opR:13}];
  const result=distribution(matches);
  assert.equal(result.total,6);
  assert.equal(result.bins.find(b=>b.margin===2).count,2);
  for(const margin of [-13,-2,0,13])assert.equal(result.bins.find(b=>b.margin===margin).count,1);
  assert.equal(result.bins.reduce((n,b)=>n+b.count,0),6);
  assert.equal(distribution([]).total,0);
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
  const helpers=teammate.slice(0,teammate.indexOf("\nlet teammateChartsExpanded="));
  const rows=runInNewContext(helpers+'\n'+html.slice(start,end)+'\nbuildTeammates();allTeammates',context);
  assert.equal(rows.length,1);assert.equal(rows[0].key,'friend');
  assert.equal(rows[0].kills,99);
  assert.equal(rows[0].chartStats.kills,undefined);
  assert.equal(rows[0].chartStats.rrWinTotal,21);
});
