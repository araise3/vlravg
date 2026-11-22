import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RR_SESSION_BREAK_MS,rrSessionRows} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const PAGE='/src/app/pages/RR.jsx';
const H=3600000,base=Date.UTC(2026,9,1,18);
// `at` is hours after the base time; matches last 40 minutes unless given.
const m=(id,at,rr,won,extra={})=>({matchId:id,startedAtMs:base+at*H,durationMs:40*60000,myRR:rr,won,myTierId:15,partySize:1,...extra});

test('sessions split after a break of more than three hours between one match end and the next start',()=>{
  assert.equal(RR_SESSION_BREAK_MS,3*H);
  const matches=[
    m('b',1,-18,false),m('a',0,20,true),          // same session
    m('c',1+40/60+3,22,true),                       // exactly 3 h after b ends: same session
    m('d',1+40/60+3+40/60+3.01,-17,false),          // just over 3 h after c ends: new session
    m('e',30,0,undefined,{durationMs:null}),        // a draw, unknown duration counts as 40 min
    m('f',30+40/60+2.9,25,true,{actPlacement:true,partySize:5}), // placements and 5-stacks count
    m('x',31,null,true),                            // no recorded change: left out
    m('y',NaN,20,true),                             // no start time: left out
  ];
  const rows=rrSessionRows(matches);
  assert.deepEqual(rows.map(r=>r.matches.map(x=>x.matchId)),[['a','b','c'],['d'],['e','f']]);
  assert.deepEqual(rows.map(r=>r.net),[24,-17,25]);
  assert.deepEqual(rows.map(r=>[r.wins,r.losses,r.draws,r.games]),[[2,1,0,3],[0,1,0,1],[1,0,1,2]]);
  assert.deepEqual(rows.map(r=>r.i),[0,1,2]);
  assert.equal(rows[0].startMs,base);
  assert.equal(rows[0].endMs,matches[2].startedAtMs+40*60000);
  assert.deepEqual(rrSessionRows([]),[]);
});

test('sessions carry the rank after their last match',()=>{
  const rows=rrSessionRows([m('a',0,20,true,{myPostRR:1550,myPostTierId:18}),m('b',1,-10,false,{myPostRR:1540,myPostTierId:18})]);
  assert.equal(rows[0].postRR,1540);
  assert.equal(rows[0].postTierId,18);
  assert.equal(rrSessionRows([m('a',0,20,true)])[0].postRR,null);
});

test('date labels thin out to keep a minimum gap',async()=>{
  const {rrSessionLabelStep}=await load(PAGE);
  assert.equal(rrSessionLabelStep(10,80,64),1);
  assert.equal(rrSessionLabelStep(40,20,64),4);
  assert.equal(rrSessionLabelStep(200,1,64),50);
});

test('the session chart draws one bar per session, a summary and accessible labels',async()=>{
  const matches=[m('a',0,20,true),m('b',1,22,true),m('c',10,-18,false),m('d',20,0,undefined)];
  const html=await renderHtml(PAGE,'RRSessionChart',{matches});
  assert.deepEqual([...html.matchAll(/class="bar (win|loss|draw)"/g)].map(x=>x[1]),['win','loss','draw']);
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.match(text,/Sessions 3 Avg per session \+8\.0 Net gain in 1 of 3 Best \+42 \([^)]+\) Worst −18 \([^)]+\)/);
  assert.match(html,/aria-label="Session 1 of 3, [^"]+: \+42 RR over 2 games, 2 wins, 0 losses"/);
  assert.match(html,/aria-label="Session 3 of 3, [^"]+: \+0 RR over 1 game, 0 wins, 0 losses, 1 draw"/);
  assert.match(text,/A new session starts after a break of more than 3 hours\./);
  const empty=await renderHtml(PAGE,'RRSessionChart',{matches:[m('a',0,null,true)]});
  assert.match(empty,/No recorded RR changes in this range\./);
});

test('the session card sits on Match History, not the RR Breakdown',async()=>{
  const card=await renderHtml(PAGE,'RRSessionCard',{matches:[m('a',0,24,true)]});
  assert.match(card,/<h2 id="rr-session-title">RR by session<\/h2>/);
  const page=readFileSync(new URL('../src/app/pages/RR.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(page,/RRPayoutCard|RRPayoutChart|rrPayoutTimeline|>RR payout over time</);
  const body=page.slice(page.indexOf('export function RRPage('));
  assert.doesNotMatch(body,/<RRSessionCard/);
  const history=readFileSync(new URL('../src/app/pages/Matches.jsx',import.meta.url),'utf8');
  const historyBody=history.slice(history.indexOf('export function MatchesPage('));
  assert.match(historyBody,/<RRSessionCard matches=\{s\.allMatches\} range=\{s\.rrRanges\.sessions\}\/>/);
  assert.ok(historyBody.indexOf('<RRSessionCard')<historyBody.indexOf('Match log'));
  // The matches / win rate / MVP summary strip is gone.
  assert.doesNotMatch(history,/mh-summary|Match history summary/);
});
