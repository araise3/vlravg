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
const winRateHelpers=html.slice(html.indexOf('function winRateLabel('),html.indexOf('\n/* ── PLAYTIME'));
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

test('the RR summary card sits above the trend chart as tiles with what each figure is built from',async()=>{
  const m=(rr,won,extra={})=>({myRR:rr,won,myTierId:15,partySize:1,...extra});
  const matches=[m(20,true),m(18,true),m(-15,false),m(-21,false),m(-17,false),m(0,undefined),m(30,true,{partySize:5})];
  const html=await renderHtml('/src/app/pages/RR.jsx','RRSummary',{matches,net:15,netCount:7});
  const tiles=[...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map(t=>t[1].replace(/<[^>]+>/g,''));
  assert.deepEqual(tiles,['Net RR','RR / Win','RR / Loss','W–L–D','Win rate']);
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  // The 5-stack win counts toward Net RR only; averages and the record use eligible matches.
  assert.match(text,/Net RR \+15 across 7 matches RR \/ Win \+19\.0 2 wins RR \/ Loss −17\.7 3 losses W–L–D 2 – 3 – 1 Win rate 40.0% /);
  assert.match(html,/max-sm:col-span-2/);
  // Draws always show, yellow, even at zero.
  assert.match(html,/<span class="text-draw">1<\/span>/);
  const noDraws=await renderHtml('/src/app/pages/RR.jsx','RRSummary',{matches:matches.filter(x=>x.won!==undefined),net:15,netCount:6});
  assert.match(noDraws.replace(/<[^>]+>/g,' ').replace(/\s+/g,' '),/W–L–D 2 – 3 – 0 /);
  assert.match(noDraws,/<span class="text-draw">0<\/span>/);
  assert.match(html,/aria-label="2 wins, 3 losses, 1 draw" style="[^"]*"|role="img" aria-label="2 wins, 3 losses, 1 draw"/);
  assert.match(html,/data-slot="progress"[^>]*aria-label="40\.0% win rate"|aria-label="40\.0% win rate"[^>]*data-slot="progress"/);
  // The range tabs head the summary card at the top of the page; the trend card follows.
  const page=readFileSync(new URL('../src/app/pages/RR.jsx',import.meta.url),'utf8');
  const body=page.slice(page.indexOf('export function RRPage('));
  assert.ok(body.indexOf('id="rr-summary-title"')<body.indexOf('<Tabs value={range}'));
  assert.ok(body.indexOf('<Tabs value={range}')<body.indexOf('id="rr-trend-title"'));
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

test('every score-margin bar shows its count on top and the chart has no hover tooltip',async()=>{
  const svg=await renderHtml('/src/app/pages/RR.jsx','ScoreMarginChart',{matches:[{myR:13,opR:11},{myR:13,opR:11},{myR:13,opR:5},{myR:11,opR:13},{myR:13,opR:13}]});
  const bars=[...svg.matchAll(/<rect[^>]*class="bar (win|loss|draw)"[^>]*>/g)].length;
  const values=[...svg.matchAll(/<text[^>]*class="value"[^>]*>(\d+)<\/text>/g)].map(m=>Number(m[1]));
  assert.equal(values.length,bars);
  assert.deepEqual(values.sort((a,b)=>a-b),[1,1,1,2]);
  assert.doesNotMatch(svg,/chart-tooltip|has-active|class="hit"/);
});

test('RR by result is a diverging bar chart: losses left, wins right, values and counts at the bar ends',async()=>{
  const m=(myR,opR,rr)=>({myR,opR,won:myR>opR,myRR:rr,myTierId:15,partySize:1,isPlacement:false});
  const matches=[m(13,11,20),m(13,11,22),m(11,13,-18),m(14,12,24),m(13,3,30)];
  const html=await renderHtml('/src/app/pages/RR.jsx','RRResultChart',{matches});
  assert.match(html,/data-slot="rr-result-chart"/);
  const rows=[...html.matchAll(/<li aria-label="([^"]+)"/g)].map(r=>r[1]);
  assert.deepEqual(rows,[
    '13–11: 2 wins averaging +21.0 RR, 1 loss averaging −18.0 RR',
    '14–12 (overtime): 1 win averaging +24.0 RR, no losses',
    '13–3: 1 win averaging +30.0 RR, no losses',
  ]);
  // One shared scale: the largest average (30) fills its side.
  assert.match(html,/width:calc\(\(100% - 4\.75rem\) \* 1\.0000\);background:var\(--chart-win\)/);
  assert.match(html,/width:calc\(\(100% - 4\.75rem\) \* 0\.6000\);background:var\(--chart-loss\)/);
  assert.match(html,/>\+21\.0<\/span> <span class="text-muted-foreground">\(2\)<\/span>/);
  assert.match(html,/OT<\/span>/);
  assert.doesNotMatch(html,/<table/);
  assert.match(await renderHtml('/src/app/pages/RR.jsx','RRResultChart',{matches:[]}),/No wins or losses with both a recorded score and eligible RR yet/);
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

const duoMate=(key,extra={})=>({key,name:key,tag:'EU',games:3,wins:2,decided:3,kills:30,deaths:20,rankSum:0,rankCount:0,
  acsSum:600,acsCount:3,performanceSum:0,performanceCount:0,rrTotal:12,rrCount:3,
  myKills:24,myDeaths:30,myAcsSum:540,myAcsCount:3,myPerformanceSum:750,myPerformanceCount:3,...extra});
const flat=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

test('duo chemistry: your act baseline is computed like the per-teammate figures',async()=>{
  const {duoBaseline,duoRows}=await load('/src/app/pages/Duos.jsx');
  const matches=[{myStats:{kills:20,deaths:10,acs:250,performanceScore:300}},{myStats:{kills:10,deaths:20,acs:150}},{}];
  assert.deepEqual(duoBaseline(matches),{kd:1,acs:200,ps:300});
  const [row]=duoRows([duoMate('Friend')],{acs:200});
  assert.equal(row.myAcs,180);assert.equal(row.myKd,0.8);
});

test('duo chemistry: the matchup mirrors your figures against the teammate\'s on one scale, with your act-average deltas',async()=>{
  const {duoRows}=await load('/src/app/pages/Duos.jsx');
  const base={kd:1,acs:200,ps:300};
  const [t]=duoRows([duoMate('Friend')],base);
  const html=await renderHtml('/src/app/pages/Duos.jsx','DuoMatchup',{t,base,scales:{kd:2,acs:250,ps:400}});
  const text=flat(html);
  assert.match(text,/Friend #EU 3 matches together Avg lobby — Win rate 66\.7% 2W 1L Total RR \+12 /);
  // Rows read: your value, your delta vs your act average, stat, their value.
  assert.match(text,/0\.80 −0\.20 vs avg K\/D 1\.50 180 −20 vs avg ACS 200 250 −50 vs avg PS — /);
  const rows=[...html.matchAll(/data-slot="tape-row">(.*?)(?=<div class="grid[^"]*" role="row" data-slot="tape-row"|<\/div><p)/g)].map(m=>m[1]);
  assert.equal(rows.length,3);
  // Bars share the passed scale: your K/D 0.80 of 2 is 40%, theirs 1.50 is 75%; the trailing side is faded.
  assert.match(rows[0],/opacity-45" style="width:40%/);
  assert.match(rows[0],/bg-foreground\/70" style="width:75%/);
  assert.match(rows[0],/font-semibold text-foreground" role="cell">1\.50/);
  const source=readFileSync(new URL('../src/app/pages/Duos.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(source,/duoStatsView|setDuoStatsView|TabsTrigger/);
});

test('duo chemistry: partners by matches together with your K/D, the first selected, all in a scroll box on desktop, no sort control',async()=>{
  const {DUO_PREVIEW}=await load('/src/app/pages/Duos.jsx');
  assert.equal(DUO_PREVIEW,8);
  const teammates=Array.from({length:10},(_,i)=>duoMate('m'+i,{games:20-i,rrCount:i===0?0:3}));
  const matches=[{myStats:{kills:1,deaths:1,acs:170,performanceScore:250}}];
  const html=await renderHtml('/src/app/pages/Duos.jsx','DuoChemistry',{teammates,matches});
  // Desktop lists every partner in a scroll box sized to the matchup; no "Show all".
  assert.equal((html.match(/aria-pressed=/g)||[]).length,10);
  assert.match(html,/sm:\[contain:size\][^"]*" data-slot="duo-partner-list"/);
  // The header sits above the scroll box (a shadcn ScrollArea, so the scrollbar
  // starts under it and overlays the padding); both share one column template.
  assert.match(html,/<div aria-hidden="true"><div class="grid grid-cols-\[minmax\(0,1fr\)_3\.5rem_3rem_2\.75rem\] gap-x-2 px-3[^"]*">.*?Teammate.*?<\/div><\/div><div[^>]*data-slot="duo-partner-scroll"[^>]*>(<style>[^<]*<\/style>)?<div[^>]*data-slot="scroll-area-viewport"/);
  assert.match(html,/data-slot="duo-partner-scroll"[^>]*class="[^"]*sm:min-h-0 sm:flex-1/);
  assert.doesNotMatch(html,/sm:sticky/);
  assert.match(html,/<button type="button" aria-pressed="true"[^>]*class="grid grid-cols-\[minmax\(0,1fr\)_3\.5rem_3rem_2\.75rem\] gap-x-2 px-3/);
  assert.match(html,/aria-pressed="true"[^>]*aria-label="m0#EU: 20 matches, 66\.7% win rate, no RR, your K\/D 0\.80"/);
  assert.equal((html.match(/data-slot="duo-matchup"/g)||[]).length,1);
  assert.match(flat(html.replace(/<style>[^<]*<\/style>/g,'')),/Teammate Win rate RR K\/D m0 #EU 20 matches 66\.7% — 0\.80 /);
  assert.doesNotMatch(html,/Show all/);
  // No sort control: partners are listed by matches together.
  assert.doesNotMatch(html,/<select|duo-sort/);
});

test('variable-width lobby cells are left-aligned flex rows so the rank sits level with the other cells',async()=>{
  const html=await renderHtml('/src/app/shared.jsx','LobbyValue',{sum:22,count:1});
  assert.match(html,/^<span class="flex items-center gap-2 whitespace-nowrap"/);
  for(const file of ['Duos.jsx','Servers.jsx']){
    const source=readFileSync(new URL('../src/app/pages/'+file,import.meta.url),'utf8');
    assert.match(source,/label:'Avg Lobby',wide:true,align:'left'/,file);
  }
  // The data table keeps `align: 'left'` columns left; other data columns are right-aligned.
  assert.match(readFileSync(new URL('../src/app/data-table.jsx',import.meta.url),'utf8'),/const right=index=>index>0&&columns\[index\]\?\.align!=='left';/);
});

test('long tables page ten rows at a time after sorting every row',async()=>{
  const columns=[{label:'Player'},{label:'Encounters'}];
  const rows=Array.from({length:23},(_,i)=>({key:'p'+i,cells:['P'+i,i]}));
  const values=rows.map((row,i)=>['P'+i,i]);
  const html=await renderHtml('/src/app/shared.jsx','SortableTable',{id:'paged-test',caption:'test',columns,rows,values,pageSize:10,noun:'players'});
  assert.equal((html.match(/<tr/g)||[]).length,11);
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.match(text,/1–10 of 23 players Page 1 of 3 Previous Next/);
  assert.match(html,/disabled="" aria-label="Previous page"/);
  assert.doesNotMatch(html,/disabled="" aria-label="Next page"/);
  const short=await renderHtml('/src/app/shared.jsx','SortableTable',{id:'short-test',caption:'test',columns,rows:rows.slice(0,5),values:values.slice(0,5),pageSize:10});
  assert.doesNotMatch(short,/table-pager/);
});
