import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {avgLabel,avgLabelShort,tierRR} from '../src/engine/core.mjs';
import {closeRenderer,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const PAGE='/src/app/pages/Overview.jsx';
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

const overviewStats={overallRR:{tier:18,rr:50},overall:18.5,kd:'1.14',acs:'237.6',performance:'294.2',adr:'156.5',kast:'69.9%',
  playtime:{value:'28h',title:'Playtime'}};
const state=(parties,matches=[])=>({
  overviewStats,allMatches:matches,
  statMatches:parties.flatMap(([size,avgRank,count])=>Array.from({length:count},()=>({partySize:size,avgRank}))),
});

test('KPI cards lead with the lobby rank and name each party size only when there is more than one',async()=>{
  const single=text(await renderHtml(PAGE,'KpiCards',{s:state([[2,18.5,12]]),recent:[]}));
  assert.match(single,/Avg lobby rank Diamond 1 50 RR 12 rated lobbies All duo lobbies/);
  const mixed=text(await renderHtml(PAGE,'KpiCards',{s:state([[1,14.5,3],[2,18.5,9]]),recent:[]}));
  const short=v=>avgLabelShort(tierRR(v).tier);
  assert.ok(mixed.includes(`Solo ${short(14.5)} · Duo ${short(18.5)}`),mixed);
  assert.equal(avgLabel(18),'Diamond 1');
});

test('net RR sums every recorded change while per-game averages use eligible matches only',async()=>{
  const at=i=>Date.UTC(2026,9,1,12)+i*3600000;
  const m=(i,rr,extra={})=>({matchId:'m'+i,startedAtMs:at(i),won:rr>0,myRR:rr,myPostRR:1500+i*5,myTierId:15,partySize:1,...extra});
  const recent=[m(1,20),m(2,-15),m(3,24),m(4,-10,{partySize:5})];
  const html=text(await renderHtml(PAGE,'KpiCards',{s:state([[1,15,4]]),recent}));
  assert.match(html,/Net RR · last 4 \+19 /);
  assert.match(html,/3 eligible/);
  assert.match(html,/\+22\.0 per win · −15\.0 per loss/);
});

test('act stats keep all eight figures in one grid',async()=>{
  const matches=[{won:true},{won:true},{won:false},{won:null}];
  const html=await renderHtml(PAGE,'ActStatsCard',{s:state([],matches)});
  const cells=[...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(m=>m[1]);
  assert.deepEqual(cells,['K/D','Avg ACS','Avg PS','Avg ADR','KAST','Playtime','Matches','Win rate']);
  assert.match(html,/sm:grid-cols-4/);
  const t=text(html);
  assert.match(t,/Matches 4 2W 1L 1D/);
  assert.match(t,/Win rate 66\.7%/);
  assert.match(t,/KAST 69\.9%/);
});

test('clutch stats show every situation, attempt share and the outcome split, and vanish without data',async()=>{
  const matches=[{myClutchAll:{1:{win:3,loss:1,save:0},2:{win:1,loss:2,save:1}}},{myClutchAll:{1:{win:1,loss:0,save:0}}}];
  const html=text(await renderHtml(PAGE,'ClutchCard',{matches}));
  assert.match(html,/Clutch stats 5 won of 9 opportunities/);
  assert.match(html,/89% attempted/);
  assert.match(html,/1v1 80% 4\/5 4 of 5 won/);
  assert.match(html,/1v2 25% 1\/4 1 of 4 won/);
  assert.match(html,/1v5 — None/);
  assert.match(html,/Won 5 \(56%\) Lost 3 \(33%\) Saved 1 \(11%\)/);
  assert.equal(await renderHtml(PAGE,'ClutchCard',{matches:[{}]}),'');
});

test('recent matches show result, score, K/D/A and RR per row',async()=>{
  const matches=[{matchId:'a',mapName:'Haven',startedAtMs:Date.UTC(2026,10,15,12),won:true,myR:13,opR:8,myRR:22,myStats:{kills:24,deaths:15,assists:11}},
    {matchId:'b',mapName:'Bind',startedAtMs:Date.UTC(2026,10,14,12),won:null,myR:12,opR:12,myRR:null,myStats:null}];
  const html=text(await renderHtml(PAGE,'RecentMatchesCard',{matches,total:54,maps:null}));
  assert.match(html,/Latest 2 of 54/);
  assert.match(html,/Haven 15 Nov Win 13–8 24 \/ 15 \/ 11 \+22/);
  assert.match(html,/Bind 14 Nov Draw 12–12 — —/);
});

test('overview is built from shadcn cards with no scrolling lists',()=>{
  const source=readFileSync(new URL('../src/app/pages/Overview.jsx',import.meta.url),'utf8');
  assert.match(source,/components\/ui\/card/);
  assert.doesNotMatch(source,/overflow-y-auto|Most-played lobbies/);
});

test('an all-draw window says there are no wins or losses to average, not no eligible matches',async()=>{
  const recent=[1,2].map(i=>({matchId:'d'+i,startedAtMs:i,won:null,myRR:0,myPostRR:1500,myTierId:15,partySize:1}));
  const html=text(await renderHtml(PAGE,'KpiCards',{s:state([[1,15,2]]),recent}));
  assert.match(html,/2 eligible/);
  assert.match(html,/No RR-eligible wins or losses/);
});

test('top teammates sit side by side without avatars, one column per teammate',async()=>{
  const mate=(name,games,kills,deaths)=>({key:name,name,tag:'EUW',games,kills,deaths});
  const html=await renderHtml(PAGE,'TeammatesCard',{teammates:[mate('Orange',18,40,35),mate('Unfair',14,30,30),mate('Sevire',8,20,25),mate('Extra',2,1,1)]});
  assert.doesNotMatch(html,/data-slot="avatar"/);
  assert.match(html,/sm:grid-cols-3/);
  const t=text(html);
  assert.match(t,/Orange #EUW 1\.14 K\/D 18 matches together/);
  assert.match(t,/Sevire #EUW 0\.80 K\/D 8 matches together/);
  assert.doesNotMatch(t,/Extra/);
  assert.match(await renderHtml(PAGE,'TeammatesCard',{teammates:[mate('Solo',3,3,3)]}),/grid-cols-1 gap-px/);
  assert.equal(await renderHtml(PAGE,'TeammatesCard',{teammates:[]}),'');
});

test('rank icons keep their aspect ratio and use the sharp PNG from 32px',async()=>{
  const small=await renderHtml('/src/app/shared.jsx','RankIcon',{tier:26,size:18});
  const large=await renderHtml('/src/app/shared.jsx','RankIcon',{tier:26,size:34});
  assert.match(small,/src="data:image/);
  assert.match(large,/src="\/assets\/ranks\/26\.png"/);
  for(const html of [small,large])assert.match(html,/object-contain/);
});
