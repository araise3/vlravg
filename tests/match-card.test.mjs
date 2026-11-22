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

test('the closed desktop card is one short row of labelled cells: agent, map over your place, result over score, K/D/A, ACS and PS as one group, server, average lobby and RR, with your rank as a badge on the agent tile',async()=>{
  const html=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(html,/class="match-card win"/);
  assert.match(html,/data-agent="Jett"[^>]*style="[^"]*width:44px[^"]*background:#25607a/);
  assert.match(html,/<img src="https:\/\/media\.valorant-api\.com\/jett\.png" alt=""/);
  assert.equal(text(html),'Abyss Win 13 : 7 K / D / A 18 / 12 / 8 ACS 240 PS 230 Server Frankfurt Lobby Diamond 2 RR +24');
  // The average lobby is the full rank name in the rank colour, without an icon, between server and RR.
  assert.match(html,/<span class="mc-cell mc-lobby">[^]*?<span class="text-fuchsia-300" data-slot="lobby-rank"[^>]*>Diamond 2<\/span>/);
  assert.doesNotMatch(html.slice(html.indexOf('mc-lobby'),html.indexOf('mc-rr')),/<img/);
  assert.match(html,/mc-server[^]*mc-lobby[^]*mc-rr/);
  // Agent and map share one lead cell; K/D/A, ACS and PS share the performance group.
  assert.match(html,/<span class="mc-lead">[^]*data-agent="Jett"[^]*class="match-map">Abyss</);
  assert.match(html,/<span class="mc-perf">[^]*K \/ D \/ A[^]*ACS[^]*>PS</);
  // Rank is the icon alone, on the tile; its name and RR are in the hint.
  assert.match(html,/<span class="relative flex shrink-0"><span[^>]*data-agent="Jett"[^]*?<\/span><span class="mc-tile-rank"[^>]*><img src="data:image\//);
  assert.match(html,/aria-label="Win on Abyss, 13–7\. Played Jett\. 18 \/ 12 \/ 8 KDA, 240 ACS, 230 Performance Score\. Average lobby Diamond 2 \(0 RR\)\. Show match details and roster"/);
  assert.match(html,/<span class="mc-backdrop" aria-hidden="true"><\/span>/);
  // In the opened card only: time and length.
  assert.doesNotMatch(text(html),/35 min|Avg lobby/);
});

test('a closed card without a lobby average shows a dash, with the rated count in the hint for low-rated lobbies',async()=>{
  const lowRated=await renderHtml(PAGE,'MatchCard',{m:{...match,avgRank:null,lowRated:true,ratedCount:5},s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(text(lowRated),/Server Frankfurt Lobby — RR \+24$/);
  assert.doesNotMatch(lowRated,/data-slot="lobby-rank"|Average lobby/);
  const mobile=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,avgRank:null},s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(text(mobile),/^Win 13 : 7 — \+24 Abyss/);
});

test('the opened card is a strip of tiles: K/D, ACS, ADR, damage delta, HS%, KAST, clutches and length, then the roster',async()=>{
  const stats={...match.myStats,adr:162,dmg:3726,dmgTaken:2944,ddDelta:34,hsPct:28,kast:74,kastRounds:17,kastTotalRounds:23,kd:1.5};
  const clutches=[{type:2,outcome:'win'},{type:1,outcome:'loss'},{type:3,outcome:'save'}];
  const html=await renderHtml(PAGE,'MatchCard',{m:{...match,myStats:stats,myClutches:clutches,durationMs:35*60000+7000,myPostRR:1674,myPostTierId:18,avgTeamRank:18.4,avgEnemyRank:18.6},s,maps:null,agents,open:true,onOpenChange(){}});
  const info=html.slice(html.indexOf('data-slot="match-info"'),html.indexOf('Your team'));
  // No agent (the closed row's tile has it), no RR change, and no rank tile (removed on request).
  assert.doesNotMatch(info,/data-agent=|match-agent|Jett|\+24|rank-change|rank-bar|Diamond/);
  assert.match(text(info),/> K\/D 1\.50 18 K, 12 D ACS 240 per round ADR 162 3,726 damage DDΔ \+34 2,944 taken HS% 28% of hits KAST 74% 17 of 23 rounds Clutches 33% 1 of 3 won Length 35:07 10 Oct, \d\d:\d\d Server Frankfurt$/);
  assert.match(info,/<dl class="mc-stats" data-slot="match-stats"><div class="mc-stat-tile"><dt class="mc-stat-label">/);
  // A positive delta is green, a negative one red.
  assert.match(info,/<dd class="mc-stat-value text-positive">\+34<\/dd>/);
  const behind=await renderHtml(PAGE,'MatchCard',{m:{...match,myStats:{...stats,ddDelta:-21}},s,maps:null,agents,open:true,onOpenChange(){}});
  assert.match(behind,/<dd class="mc-stat-value text-negative">−21<\/dd>/);
  // RR notes are quiet text lines under the strip, not pills.
  const noted=await renderHtml(PAGE,'MatchCard',{m:{...match,myRRDetails:{bonus:5,shieldReplenished:true}},s,maps:null,agents,open:true,onOpenChange(){}});
  const notedInfo=noted.slice(noted.indexOf('data-slot="match-info"'),noted.indexOf('Your team'));
  assert.match(notedInfo,/<\/dl><ul class="mc-rr-notes" aria-label="RR notes" data-slot="rr-notes">/);
  assert.match(text(notedInfo),/\+5 RR performance bonus Rank Shield replenished/);
  // Each note is block-level flex: an inline-flex note that starts with an icon sits on
  // the icon's baseline and rode 1.75px higher than a text-only note beside it.
  const {readFileSync}=await import('node:fs');
  const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
  assert.match(css,/\n\.mc-rr-note \{ display: flex; align-items: center;/);
  // The server tile is in the markup but shown only where the closed row hides it (.mc-info-server).
  assert.match(info,/<div class="mc-stat-tile mc-info-server"><dt class="mc-stat-label">Server<\/dt>/);
  // Without per-match data the tiles say so rather than guess.
  const bare=text(await renderHtml(PAGE,'MatchCard',{m:{...match,myClutches:null},s,maps:null,agents,open:true,onOpenChange(){}}));
  assert.match(bare,/ADR — DDΔ — HS% — of hits KAST — Clutches — No round data Length 35:00/);
  // No debug grid: no queue, no "Recorded payout", no reported-fields footnote.
  assert.doesNotMatch(html,/Your RR details|Recorded payout|Queue|not added again/);
  // Each team header carries its average rank as a short name in its colour, not its rounds (the closed row has the score).
  const desktopRoster=html.slice(html.indexOf('Your team'));
  assert.match(text(html),/Your team ACS PS KD Dia 1 Player #EU /);
  assert.match(text(html),/Enemy team ACS PS KD Dia 2 /);
  // Long names: the tag shrinks before the name, and the link carries the full Riot ID.
  assert.match(html,/<span class="min-w-0 shrink-\[20\] truncate text-xs text-muted-foreground" data-slot="player-tag">#EU<\/span>/);
  assert.match(html,/title="Mate#EU" class="flex min-w-0 items-baseline gap-0\.5 hover:underline"/);
  // Ranks are short names in the rank colour (icons were tried and reverted), full name in the tooltip.
  assert.equal((desktopRoster.match(/title="Diamond 1" data-slot="player-rank">Dia 1<\/span>/g)||[]).length,3);
  assert.doesNotMatch(desktopRoster,/player-rank-icon|data-slot="team-rank"[^>]*><img /);
  // Phones: the same short names.
  const phone=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,avgTeamRank:18.4,avgEnemyRank:18.6},s,maps:null,agents,open:true,onOpenChange(){}});
  const phoneRoster=phone.slice(phone.indexOf('Your team'));
  assert.equal((phoneRoster.match(/title="Diamond 1" data-slot="player-rank">Dia 1<\/span>/g)||[]).length,3);
  assert.match(text(phoneRoster),/Your team ACS PS KD Dia 1 /);
  assert.doesNotMatch(phoneRoster,/player-rank-icon|data-slot="team-rank"[^>]*><img /);
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

test('match length always shows minutes and seconds',async()=>{
  const {matchLengthText}=await import('./helpers/react-render.mjs').then(r=>r.load(PAGE));
  assert.equal(matchLengthText(1616400),'26:56');
  assert.equal(matchLengthText(35*60000),'35:00');
  assert.equal(matchLengthText(42000),'0:42');
  assert.equal(matchLengthText(1616700),'26:57');
  for(const ms of [0,null,undefined,-5,NaN])assert.equal(matchLengthText(ms),null);
});
