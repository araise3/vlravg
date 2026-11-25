// Opening a match card re-renders only that card (24 Nov 2026,
// docs/match-card-expand-speed.md): the log's cards, day recaps and the RR
// by session chart are memoized, and the toggle callback they get is stable.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const PAGE='/src/app/pages/Matches.jsx';
const MEMO=Symbol.for('react.memo');
const player=(puuid,name,team,agent)=>({puuid,name,tag:'EU',team_id:team,agent,agentId:null,_tier:18,_label:'Diamond 1',_acs:200,_kd:1,_performanceScore:200});
const match={matchId:'m1',mapName:'Abyss',won:true,myR:13,opR:7,myRR:24,startedAtMs:Date.UTC(2026,9,10,18,30),durationMs:35*60000,serverName:'Frankfurt',
  myAgent:'Jett',myAgentId:null,myStats:{kills:18,deaths:12,assists:8,acs:240.4,performanceScore:230.2},avgRank:18.5,
  players:[player('p1','Player','red','Jett'),player('p2','Mate','red','Omen'),player('p3','Foe','blue','Sova')]};
const s={PUUID:'p1',PLAYER:'Player',TAG:'EU',mhIncludeReset:false};

test('a match log card renders exactly the match card, closed and opened',async()=>{
  for(const open of [false,true]){
    const card=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents:null,open,onOpenChange(){}});
    const logCard=await renderHtml(PAGE,'MatchLogCard',{m:match,s,maps:null,agents:null,open,onToggle(){}});
    assert.equal(logCard,card);
  }
});

test('the match log, its day recaps and the session chart skip re-rendering when their props are unchanged',async()=>{
  const page=await load(PAGE);
  const rr=await load('/src/app/pages/RR.jsx');
  for(const component of [page.MatchLogCard,rr.RRSessionCard]){
    assert.equal(component.$$typeof,MEMO);
    assert.equal(component.compare,null,'shallow prop comparison');
  }
  const source=readFileSync(new URL('../src/app/pages/Matches.jsx',import.meta.url),'utf8');
  assert.match(source,/const DayHeader=memo\(function DayHeader\(/);
  // The page hands every card the same callback, never a new closure per render.
  const body=source.slice(source.indexOf('export function MatchesPage('));
  assert.match(body,/const toggle=useCallback\(\(matchId,next\)=>setExpanded\(previous=>toggleExpanded\(previous,matchId,next\)\),\[\]\);/);
  // Cards get the few engine fields they read (useMatchCardState), not the
  // snapshot, which is new on every engine change (25 Nov 2026,
  // docs/match-log-load-speed.md); postReset is re-tagged in place, so it is
  // a prop of its own.
  assert.match(body,/const cardState=useMatchCardState\(s\);/);
  assert.match(body,/<MatchLogCard m=\{m\} postReset=\{m\.postReset\} s=\{cardState\} maps=\{maps\} agents=\{agents\} open=\{expanded\.has\(m\.matchId\)\} onToggle=\{toggle\}\/>/);
  assert.doesNotMatch(body,/<MatchCard |onOpenChange=\{next=>|s=\{s\}/);
});

test('a card reads only the player identity and the placements switch from the engine',async()=>{
  const {useMatchCardState}=await load(PAGE);
  const source=useMatchCardState.toString();
  for(const field of ['PUUID','PLAYER','TAG','mhIncludeReset'])assert.match(source,new RegExp(field));
  // Every field a card reads from `s` is in the card state.
  const cards=readFileSync(new URL('../src/app/pages/Matches.jsx',import.meta.url),'utf8');
  const read=new Set([...cards.slice(0,cards.indexOf('export function useMatchCardState(')).matchAll(/\bs\.([A-Za-z_]+)/g)].map(match=>match[1]));
  assert.deepEqual([...read].sort(),['PLAYER','PUUID','TAG','mhIncludeReset']);
});

test('a closed card mounts no details; an opened one does',async()=>{
  const closed=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents:null,open:false,onOpenChange(){}});
  const opened=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents:null,open:true,onOpenChange(){}});
  assert.doesNotMatch(closed,/match-card-details/);
  assert.match(opened,/match-card-details/);
  for(const name of ['Mate','Foe'])assert.match(opened,new RegExp(name));
});

test('toggling adds or removes one match id and keeps the set when nothing changes',async()=>{
  const {toggleExpanded}=await load(PAGE);
  const none=new Set();
  const one=toggleExpanded(none,'a',true);
  assert.deepEqual([...one],['a']);
  assert.deepEqual([...none],[],'the previous set is not mutated');
  const two=toggleExpanded(one,'b',true);
  assert.deepEqual([...two],['a','b']);
  assert.deepEqual([...toggleExpanded(two,'a',false)],['b']);
  // No change, same set: React bails out of the page render.
  assert.equal(toggleExpanded(two,'a',true),two);
  assert.equal(toggleExpanded(two,'c',false),two);
});
