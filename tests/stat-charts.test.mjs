import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {rrRankRows} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml,settle} from './helpers/react-render.mjs';

after(closeRenderer);

const html=readFileSync(new URL('../src/engine/core.mjs',import.meta.url),'utf8');
const margins=html.slice(html.indexOf('function scoreMarginDistribution('),html.indexOf('\nfunction renderMatches('));
const distribution=runInNewContext(margins+'\nscoreMarginDistribution');
const stats=html.slice(html.indexOf('function rrBucketStats('),html.indexOf('// ── Column renderer'));
const table=html.slice(html.indexOf('function buildRRScoreRows('),html.indexOf('/* ── CLUTCHES'));
const winRateHelpers=html.slice(html.indexOf('function winRateLabel('),html.indexOf('\n// Which side of each shared match'));
const {winRateLabel,winRateTone}=runInNewContext(winRateHelpers+'\n({winRateLabel,winRateTone})');
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

test('team/enemy rank chart rows convert the rank gap to RR and keep one-sided data',()=>{
  const source=html.slice(html.indexOf('function lobbyTeamsChartRows('),html.indexOf('/* ── STATUS'));
  const {lobbyTeamsChartRows,lobbyTeamsGapLabel}=runInNewContext(source+'\n({lobbyTeamsChartRows,lobbyTeamsGapLabel})');
  const rows=lobbyTeamsChartRows([
    {tier:13,total:4,teamRankSum:52.4,teamRankCount:4,enemyRankSum:53.48,enemyRankCount:4},
    {tier:20,total:2,teamRankSum:41,teamRankCount:2,enemyRankSum:0,enemyRankCount:0},
  ]);
  assert.equal(rows[0].gap,27);
  assert.equal(lobbyTeamsGapLabel(rows[0].gap),'Enemy +27 RR');
  assert.equal(lobbyTeamsGapLabel(-12),'Team +12 RR');
  assert.equal(lobbyTeamsGapLabel(0),'Even');
  assert.equal(rows[1].enemy,null);assert.equal(rows[1].gap,null);
  assert.equal(lobbyTeamsGapLabel(null),'—');
});

test('win rates show one decimal and colour by the shown value',()=>{
  assert.equal(winRateLabel(2/3*100),'66.7%');
  assert.equal(winRateLabel(50),'50.0%');
  assert.equal(winRateLabel(0),'0.0%');
  assert.equal(winRateLabel(null),'—');
  assert.equal(winRateTone(50.04),'');
  assert.equal(winRateTone(50.05),'rank-positive');
  assert.equal(winRateTone(49.96),'');
  assert.equal(winRateTone(49.9),'rank-negative');
  assert.equal(winRateTone(null),'');
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
  let values;
  const render=list=>{values=rrRankRows(list).map(({tier,stats:s})=>[tier,s.n,s.kd,s.acs,s.performanceScore,s.winRate,s.avgGain,s.avgLoss==null?null:-s.avgLoss]);};
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

test('RR breakdown remains visible for a loaded act containing only games without RR',async()=>{
  const engine=await load('/src/engine/core.mjs');
  const player=(name,team,puuid)=>({name,tag:'EU',puuid,team_id:team,party_id:puuid,tier:{id:12},
    stats:{kills:10,deaths:10,assists:2,score:4000,rounds_played:20}});
  engine.loadFixtureAnalysis({player:'Me',tag:'EU',puuid:'me',season:'act',current:null,
    rr:{change:{},pre:{},post:{},preTier:{},postTier:{},protected:{},details:{}},names:[],
    raw:[{metadata:{match_id:'m1',map:{name:'Ascent'},started_at:'2026-10-01T10:00:00Z',game_length_in_ms:1800000,season:{short:'e10a6',id:'act'}},
      players:[player('Me','Red','me'),player('Ally','Red','ally'),player('Foe','Blue','foe')],
      teams:[{team_id:'Red',rounds:{won:13}},{team_id:'Blue',rounds:{won:7}}]}]});
  await settle();
  assert.equal(engine.getSnapshot().allMatches[0].myRR,null);
  const page=await renderHtml('/src/app/pages/RR.jsx','RRPage');
  assert.match(page,/id="rr-trend-title"/);
  assert.match(page,/No recorded rank and RR changes/);
  assert.doesNotMatch(page,/Search for a player above/);
});

test('distribution renders counts with accessible exact scores independently of RR',async()=>{
  const chart=matches=>renderHtml('/src/app/pages/RR.jsx','ScoreMarginChart',{matches});
  const svg=await chart([{myR:13,opR:11},{myR:14,opR:12},{myR:11,opR:13},{myR:13,opR:13}]);
  assert.match(svg,/>Matches<\/text>/);
  assert.doesNotMatch(svg,/RR payout/);
  const bars=[...svg.matchAll(/<rect[^>]*class="bar (win|loss|draw)"[^>]*>/g)];
  assert.equal(bars.length,3);
  const win=bars.find(bar=>bar[1]==='win')[0];
  assert.match(win,/tabindex="0"/);
  assert.match(win,/aria-label="[^"]*13–11: 1 matches/);
  assert.match(win,/aria-label="[^"]*14–12: 1 matches/);
  assert.match(svg,/4 scored matches/);
  assert.equal(await chart([]),'');
});

test('the app shell loads one module entry and no inline application script',()=>{
  const shell=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(shell,/<script type="module" src="\/src\/main\.jsx"><\/script>/);
  assert.equal([...shell.matchAll(/<script(?:\s[^>]*)?>/g)].length,1);
});

test('party aggregation attaches your stats only to your same-team party teammates',()=>{
  const me={puuid:'me',name:'Me',team_id:'Blue',party_id:'party'};
  const friend={puuid:'friend',name:'Friend',tag:'EU',team_id:'Blue',party_id:'party',_kills:99,_deaths:1,_performanceScore:312.5};
  const stranger={puuid:'stranger',name:'Stranger',team_id:'Blue',party_id:'other'};
  const opponent={puuid:'opponent',name:'Opponent',team_id:'Red',party_id:'party'};
  const context={PUUID:'me',PLAYER:'Me',TAG:'EU',allMatches:[],
    statMatches:[{players:[me,friend,stranger,opponent],myPartyId:'party',myRR:21,won:true,
      myStats:{kills:10,deaths:20,score:4000,rounds_played:20,acs:200,performanceScore:250}}],
    document:{getElementById:()=>({style:{}})},computeEncounters:()=>[],
    currentTeammateIdentity:p=>p,
    emit:()=>{}};
  const start=html.indexOf('function buildTeammates('),end=html.indexOf('\n// This is a transparent screening heuristic',start);
  const rows=runInNewContext(html.slice(start,end)+'\nbuildTeammates();allTeammates',context);
  assert.equal(rows.length,1);assert.equal(rows[0].key,'friend');
  assert.equal(rows[0].kills,99);
  assert.equal(rows[0].performanceSum,312.5);assert.equal(rows[0].performanceCount,1);
  assert.equal(rows[0].chartStats,undefined);
  assert.equal(rows[0].rrTotal,21);
  // The searched player's own line in the shared match, beside the teammate's.
  assert.equal(rows[0].myKills,10);assert.equal(rows[0].myDeaths,20);
  assert.equal(rows[0].myAcsSum,200);assert.equal(rows[0].myAcsCount,1);
  assert.equal(rows[0].myPerformanceSum,250);assert.equal(rows[0].myPerformanceCount,1);
});

test('duo table switches its K/D, ACS and PS columns between the teammate and you',async()=>{
  const allTeammates=[{key:'friend',name:'Friend',tag:'EU',games:3,wins:2,decided:3,kills:30,deaths:20,rankSum:0,rankCount:0,
    acsSum:600,acsCount:3,performanceSum:0,performanceCount:0,rrTotal:12,rrCount:3,
    myKills:24,myDeaths:30,myAcsSum:540,myAcsCount:3,myPerformanceSum:750,myPerformanceCount:3}];
  const cells=async view=>{
    const markup=await renderHtml('/src/app/pages/Duos.jsx','TeammatesTable',{s:{duoStatsView:view,allTeammates}});
    const body=markup.slice(markup.indexOf('<tbody'));
    return [...body.matchAll(/<td([^>]*)>(.*?)<\/td>/g)].map(([,attrs,text])=>({attrs,text}));
  };
  // Default view: the teammate's figures, one value per cell, yours in the tooltip.
  let row=await cells('teammate');
  assert.equal(row[2].text,'1.50');
  assert.match(row[2].attrs,/text-positive/);
  assert.match(row[2].attrs,/title="Teammate: 1\.50 \(30 kills \/ 20 deaths\), you: 0\.80 \(24 kills \/ 30 deaths\)/);
  assert.equal(row[3].text,'200');assert.match(row[3].attrs,/title="Teammate: 200, you: 180/);
  assert.equal(row[4].text,'—');assert.match(row[4].attrs,/title="Teammate: —, you: 250\. /);
  // You view: your figures from the same matches drive the cells.
  row=await cells('you');
  assert.equal(row[2].text,'0.80');assert.match(row[2].attrs,/text-negative/);
  assert.equal(row[3].text,'180');
  assert.equal(row[4].text,'250');
  // Win rate and Total RR are shared results and do not change.
  assert.equal(row[6].text,'+12');
});
