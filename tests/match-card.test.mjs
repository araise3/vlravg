import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeRenderer,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const PAGE='/src/app/pages/Matches.jsx';
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const agents=new Map([
  ['jett',{name:'Jett',icon:'https://media.valorant-api.com/jett.png',color:'#25607a'}],
  ['omen',{name:'Omen',icon:'https://media.valorant-api.com/omen.png',color:'#433178'}],
]);
const player=(puuid,name,team,agent,extra={})=>({puuid,name,tag:'EU',team_id:team,agent,agentId:null,_tier:18,_label:'Diamond 1',_acs:200,_kd:1,_performanceScore:200,...extra});
const match={matchId:'m1',mapName:'Abyss',won:true,myR:13,opR:7,myRR:24,startedAtMs:Date.UTC(2026,9,10,18,30),durationMs:35*60000,serverName:'Frankfurt',
  myAgent:'Jett',myAgentId:null,myPreRR:1650,myPreTierId:18,
  myStats:{kills:18,deaths:12,assists:8,acs:240.4,performanceScore:230.2},avgRank:18.5,
  players:[player('p1','Player','red','Jett'),player('p2','Mate','red','Omen'),player('p3','Foe','blue','Sova')]};
const s={PUUID:'p1',PLAYER:'Player',TAG:'EU',mhIncludeReset:false};

test('the closed desktop card is one short row of labelled cells: agent, map over agent name, result over score, K/D/A, ACS and PS as one group, server and RR, with your rank as a badge on the agent tile',async()=>{
  const html=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(html,/class="match-card win"/);
  assert.match(html,/data-agent="Jett"[^>]*style="[^"]*width:44px[^"]*background:#25607a/);
  assert.match(html,/<img src="https:\/\/media\.valorant-api\.com\/jett\.png" alt=""/);
  assert.equal(text(html),'Abyss Jett Win 13 : 7 K / D / A 18 / 12 / 8 ACS 240 PS 230 Server Frankfurt RR +24');
  // Agent and map share one lead cell; K/D/A, ACS and PS share the performance group.
  assert.match(html,/<span class="mc-lead">[^]*data-agent="Jett"[^]*class="match-map">Abyss</);
  assert.match(html,/<span class="mc-perf">[^]*K \/ D \/ A[^]*ACS[^]*>PS</);
  // Rank is the icon alone, on the tile; its name and RR are in the hint.
  assert.match(html,/<span class="relative flex shrink-0"><span[^>]*data-agent="Jett"[^]*?<\/span><span class="mc-tile-rank"[^>]*><img src="data:image\//);
  assert.match(html,/aria-label="Win on Abyss, 13–7\. Played Jett\. 18 \/ 12 \/ 8 KDA, 240 ACS, 230 Performance Score\. Show match details and roster"/);
  assert.match(html,/<span class="mc-backdrop" aria-hidden="true"><\/span>/);
  // In the opened card only: time, length and lobby.
  assert.doesNotMatch(text(html),/35 min|Avg lobby/);
});

test('the opened card starts with the match info the closed row leaves out, then RR details and the roster with agent icons',async()=>{
  const html=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents,open:true,onOpenChange(){}});
  const info=html.slice(html.indexOf('data-slot="match-info"'),html.indexOf('Your team'));
  // The agent leads the opened card, larger and named.
  assert.match(info,/data-slot="match-agent"><span[^>]*data-agent="Jett"[^>]*width:48px/);
  assert.match(text(info),/> Agent Jett Started 10 Oct, \d\d:\d\d Length 35 min Server Frankfurt Avg lobby \S+ \d/);
  const roster=html.slice(html.indexOf('Your team'));
  assert.deepEqual([...roster.matchAll(/data-agent="([^"]+)"/g)].map(x=>x[1]),['Jett','Omen','Sova']);
  // Sova has no art here: the tile falls back to the initial.
  assert.match(roster,/data-agent="Sova"[^>]*>S<\/span>/);
});

test('the phone card is two lines next to a 40px agent tile and names the agent in its label',async()=>{
  const html=await renderHtml(PAGE,'MobileMatchCard',{m:match,s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(html,/data-agent="Jett"[^>]*width:40px/);
  assert.match(html,/class="mc-backdrop" aria-hidden="true"/);
  assert.match(html,/aria-label="Win on Abyss, 13–7\. Played Jett\. 18 \/ 12 \/ 8 KDA/);
  // Without agent data the tile stays empty rather than guessing.
  const none=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,myAgent:null},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(none,/data-slot="agent-icon"[^>]*><\/span>/);
});

test('match length keeps its seconds',async()=>{
  const {matchLengthText}=await import('./helpers/react-render.mjs').then(r=>r.load(PAGE));
  assert.equal(matchLengthText(1616400),'26 min 56 s');
  assert.equal(matchLengthText(35*60000),'35 min');
  assert.equal(matchLengthText(42000),'42 s');
  assert.equal(matchLengthText(1616700),'26 min 57 s');
  for(const ms of [0,null,undefined,-5,NaN])assert.equal(matchLengthText(ms),null);
});
