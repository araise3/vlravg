import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clutchBreakdown,parseAgentMetadata,playerRouteUrl,roundAttackers} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml,settle} from './helpers/react-render.mjs';

after(closeRenderer);

const PAGE='/src/app/pages/Clutches.jsx';
const rounds=(n,plants={})=>Array.from({length:n},(_,i)=>({plant:plants[i]?{round_time_in_ms:30000,player:{team:plants[i]}}:null}));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

test('round sides follow the regulation and overtime pattern only when every plant agrees',()=>{
  // Red attacks first: plants by Red in round 1 and by Blue in round 13.
  const sides=roundAttackers(rounds(27,{0:'Red',12:'Blue'}));
  assert.deepEqual(sides.slice(0,12),Array(12).fill('red'));
  assert.deepEqual(sides.slice(12,24),Array(12).fill('blue'));
  assert.deepEqual(sides.slice(24),['red','blue','red']);
  // Blue first is found the same way; nothing assumes which team starts.
  assert.deepEqual(roundAttackers(rounds(14,{2:'Blue'})).slice(11,14),['blue','red','red']);
  // A plant against the pattern: only planting rounds keep a side.
  assert.deepEqual(roundAttackers(rounds(4,{0:'Red',1:'Blue'})),['red','blue',null,null]);
  // No plant at all: nothing is guessed.
  assert.deepEqual(roundAttackers(rounds(3)),[null,null,null]);
  assert.deepEqual(roundAttackers(undefined),[]);
});

test('processMatch records each clutch with round, side, spike state and kills',async()=>{
  const fixtures=await load('/src/dev/fixtures.mjs');
  const engine=await load('/src/engine/core.mjs');
  fixtures.loadFixture('demo');
  await settle();
  const [first]=engine.getSnapshot().allMatches;
  assert.equal(first.myAgent,'Jett');
  assert.deepEqual(first.myClutches.slice(0,3),[
    {round:1,type:5,outcome:'win',kills:5,side:'attack',spikeDown:false},
    {round:4,type:2,outcome:'loss',kills:1,side:'attack',spikeDown:false},
    {round:7,type:3,outcome:'save',kills:0,side:'attack',spikeDown:true},
  ]);
  // The per-clutch list and the Overview's per-situation totals agree.
  for(const type of [1,2,3,4,5]){
    const mine=first.myClutches.filter(c=>c.type===type);
    for(const outcome of ['win','loss','save'])assert.equal(mine.filter(c=>c.outcome===outcome).length,first.myClutchAll?.[type]?.[outcome]??0);
  }
});

test('the breakdown groups by situation, side and spike, map and agent, and ranks the hardest wins',()=>{
  const c=(type,outcome,kills,side,spikeDown)=>({round:1,type,outcome,kills,side,spikeDown});
  const matches=[
    {matchId:'a',mapName:'Ascent',myAgent:'Jett',startedAtMs:1,myR:13,opR:9,won:true,
      myClutches:[c(1,'win',1,'attack',true),c(3,'win',3,'defense',false),c(2,'loss',0,'attack',false)]},
    {matchId:'b',mapName:'Lotus',myAgent:'Omen',startedAtMs:2,myR:9,opR:13,won:false,
      myClutches:[c(3,'win',2,'attack',false),c(2,'save',0,null,null)]},
    {matchId:'c',mapName:'Lotus',myClutches:null},
  ];
  const d=clutchBreakdown(matches);
  assert.deepEqual([d.matches,d.covered,d.total,d.win,d.loss,d.save,d.kills],[3,2,5,3,1,1,6]);
  assert.equal(d.winRate,60);
  assert.deepEqual(d.byType.map(t=>t.total),[1,2,2,0,0]);
  assert.equal(d.byType[3].winRate,null);
  assert.deepEqual(d.bySpike.map(t=>[t.label,t.total,t.win]),[
    ['Attack, spike down',1,1],['Attack, before the plant',2,1],['Defense, spike down',0,0],['Defense, before the plant',1,1],
  ]);
  assert.equal(d.unknownSpike,1);
  assert.deepEqual(d.byMap.map(r=>[r.name,r.total]),[['Ascent',3],['Lotus',2]]);
  assert.deepEqual(d.byAgent.map(r=>r.name),['Jett','Omen']);
  // 1v2+ wins only: the 1v3 with more kills first.
  assert.deepEqual(d.highlights.map(h=>[h.matchId,h.type,h.kills]),[['a',3,3],['b',3,2]]);
  assert.equal(clutchBreakdown([]).total,0);
});

test('the Clutches page shows the summary, breakdowns, best clutches and tables',async()=>{
  const fixtures=await load('/src/dev/fixtures.mjs');
  fixtures.loadFixture('demo');
  await settle();
  const html=await renderHtml(PAGE,'ClutchesPage');
  const body=text(html);
  assert.match(html,/<h1 id="clutches-title"[^>]*>Clutches<\/h1>/);
  assert.match(body,/Situations 82 12 matches with round data/);
  assert.match(body,/Won 42 \(51%\) 21 lost, 19 saved/);
  // The agent tile renders its initial here: no agent art is loaded in tests.
  assert.match(body,/Hardest won 1v5 J Abyss, Jett/);
  assert.equal([...html.matchAll(/data-slot="clutch-situations"/g)].length,1);
  assert.match(html,/aria-label="Attack, spike down: 7 won, 0 lost, 5 saved"/);
  assert.equal([...html.slice(html.indexOf('data-slot="clutch-highlights"')).matchAll(/<li /g)].length,8);
  assert.match(html,/id="clutch-maps"/);assert.match(html,/id="clutch-agents"/);
});

test('without round data the page says why instead of showing empty cards',async()=>{
  const fixtures=await load('/src/dev/fixtures.mjs');
  fixtures.loadFixture('worst');
  await settle();
  const html=await renderHtml(PAGE,'ClutchesPage');
  assert.match(text(html),/These matches came without round-by-round data, so clutches cannot be found\./);
  assert.doesNotMatch(html,/clutch-summary/);
});

test('agent art keeps https valorant-api icons and hex colours, keyed by name and UUID',()=>{
  const agents=parseAgentMetadata({data:[
    {displayName:'Jett',uuid:'ADD6443A-41BD',isPlayableCharacter:true,displayIconSmall:'https://media.valorant-api.com/agents/add6443a/displayicon.png',backgroundGradientColors:['25607aff','0f1923ff']},
    {displayName:'KAY/O',uuid:'601d',displayIcon:'https://evil.example/kayo.png',backgroundGradientColors:['1C2A69FF']},
    {displayName:'Nobody',uuid:'x',displayIcon:'http://media.valorant-api.com/x.png',backgroundGradientColors:['red']},
    {displayName:'Sova',uuid:'320b',isPlayableCharacter:false,displayIcon:'https://media.valorant-api.com/sova.png'},
  ]});
  assert.deepEqual(agents.get('jett'),{name:'Jett',icon:'https://media.valorant-api.com/agents/add6443a/displayicon.png',color:'#25607a'});
  assert.equal(agents.get('add6443a-41bd'),agents.get('jett'));
  assert.deepEqual(agents.get('kay/o'),{name:'KAY/O',icon:null,color:'#1c2a69'});
  assert.equal(agents.has('nobody'),false);assert.equal(agents.has('sova'),false);
  assert.equal(parseAgentMetadata(null).size,0);
});

test('agent tiles use the agent colour and icon, and fall back to the initial',async()=>{
  const {AgentIcon}=await load('/src/app/agent-icon.jsx');
  const agents=new Map([['jett',{name:'Jett',icon:'https://media.valorant-api.com/j.png',color:'#25607a'}]]);
  const {renderToStaticMarkup}=await import('react-dom/server');
  const {createElement}=await import('react');
  const tile=renderToStaticMarkup(createElement(AgentIcon,{agents,name:'Jett',size:22}));
  assert.match(tile,/aria-hidden="true"/);assert.match(tile,/background:#25607a/);
  assert.match(tile,/<img src="https:\/\/media\.valorant-api\.com\/j\.png" alt=""/);
  const fallback=renderToStaticMarkup(createElement(AgentIcon,{agents:null,name:'Omen'}));
  assert.match(fallback,/bg-muted/);assert.match(fallback,/>O<\/span>$/);
});

test('Clutches is a routed page in the nav, the phone More sheet and the redirects',()=>{
  const app=readFileSync(new URL('../src/app/App.jsx',import.meta.url),'utf8');
  assert.match(app,/\['rr','RR Breakdown'\],\['clutches','Clutches'\]/);
  assert.match(app,/<div hidden=\{page!=='clutches'\}><ClutchesPage\/><\/div>/);
  assert.match(readFileSync(new URL('../src/app/MobileShell.jsx',import.meta.url),'utf8'),/page:'clutches',label:'Clutches'/);
  assert.match(readFileSync(new URL('../_redirects',import.meta.url),'utf8'),/^\/clutches \/index\.html 200$/m);
  assert.equal(playerRouteUrl('Me','EU','clutches'),'/player/Me/EU/clutches');
});
