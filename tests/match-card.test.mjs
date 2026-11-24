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
  const html=await renderHtml(PAGE,'MatchCard',{m:{...match,myStats:{...match.myStats,adr:162}},s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(html,/class="match-card win"/);
  assert.match(html,/data-agent="Jett"[^>]*style="[^"]*width:44px[^"]*background:#25607a/);
  assert.match(html,/<img src="https:\/\/media\.valorant-api\.com\/jett\.png" alt=""/);
  assert.match(text(html),/^10 Oct, \d\d:\d\d Abyss Win 13 : 7 K \/ D \/ A 18 \/ 12 \/ 8 ACS 240 PS 230 Server Frankfurt Lobby Diamond 2 RR \+24$/);
  // The start sits in small text over the map, and your place right after the map name
  // (23 Nov 2026, on request).
  assert.match(html,/<span class="mc-cell mc-identity"><span class="mc-started" title="10 Oct, \d\d:\d\d" data-slot="match-started"><span class="mc-started-date">10 Oct, <\/span>\d\d:\d\d<\/span><span class="mc-title"><span class="match-map">Abyss<\/span>/);
  // Narrow cards shift their cells closer instead of cutting or hiding them (on request):
  // a flex row whose group gaps shrink, with nothing in the closed row hidden but the server.
  const {readFileSync}=await import('node:fs');
  const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
  const narrow=css.slice(css.indexOf('@container (max-width: 880px)'),css.indexOf('/* The opened card repeats nothing'));
  assert.match(narrow,/\.mc-row \{ display: flex; align-items: center; \}/);
  assert.match(narrow,/\.mc-perf \{[^}]*margin-left: auto; padding-left: 14px; \}/);
  assert.match(narrow,/@container \(max-width: 660px\)/);
  // Three performance columns at both widths: ADR was a fourth from 23 to 24 Nov 2026 (removed on request).
  assert.match(css,/\.mc-perf \{ display: grid; grid-template-columns: (minmax\([^)]+\) ?){3};/);
  assert.match(narrow,/\.mc-perf \{ flex: 0 1 auto; grid-template-columns: (minmax\([^)]+\) ?){3};/);
  assert.match(css,/minmax\(calc\(228px \+ var\(--mc-gap\)\), 1\.75fr\)/);
  assert.deepEqual([...narrow.matchAll(/([.\w -]+) \{ display: none; \}/g)].map(m=>m[1].trim()),['.mc-server']);
  // The average lobby is the full rank name in the rank colour, without an icon, between server and RR.
  assert.match(html,/<span class="mc-cell mc-lobby">[^]*?<span class="text-fuchsia-300" data-slot="lobby-rank"[^>]*>Diamond 2<\/span>/);
  assert.doesNotMatch(html.slice(html.indexOf('mc-lobby'),html.indexOf('mc-rr')),/<img/);
  assert.match(html,/mc-server[^]*mc-lobby[^]*mc-rr/);
  // Agent and map share one lead cell; K/D/A, ACS and PS share the performance group.
  assert.match(html,/<span class="mc-lead">[^]*data-agent="Jett"[^]*class="match-map">Abyss</);
  assert.match(html,/<span class="mc-perf">[^]*K \/ D \/ A[^]*ACS[^]*>PS</);
  assert.doesNotMatch(html,/ADR|mc-adr/);
  // Rank is the icon alone, on the tile; its name and RR are in the hint.
  assert.match(html,/<span class="relative flex shrink-0"><span[^>]*data-agent="Jett"[^]*?<\/span><span class="mc-tile-rank"[^>]*><img src="data:image\//);
  assert.match(html,/aria-label="Win on Abyss, 13–7\. Played Jett\. 18 \/ 12 \/ 8 KDA, 240 ACS, 230 Performance Score\. Average lobby Diamond 2 \(0 RR\)\. Show match details and roster"/);
  assert.match(html,/<span class="mc-backdrop" aria-hidden="true"><\/span>/);
  // In the opened card only: the length.
  assert.doesNotMatch(text(html),/35:00|Avg lobby/);
});

test('a closed card without a lobby average shows a dash, with the rated count in the hint for low-rated lobbies',async()=>{
  const lowRated=await renderHtml(PAGE,'MatchCard',{m:{...match,avgRank:null,lowRated:true,ratedCount:5},s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(text(lowRated),/Server Frankfurt Lobby — RR \+24$/);
  assert.doesNotMatch(lowRated,/data-slot="lobby-rank"|Average lobby/);
  const mobile=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,avgRank:null},s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(text(mobile),/^Win 13 : 7 — \+24 Abyss/);
});

test('the opened card is a strip of tiles: K/D, ACS, damage delta, HS%, KAST, clutches and length, then the roster',async()=>{
  const stats={...match.myStats,adr:162,dmg:3726,dmgTaken:2944,ddDelta:34,hsPct:28,kast:74,kastRounds:17,kastTotalRounds:23,kd:1.5};
  const clutches=[{type:2,outcome:'win'},{type:1,outcome:'loss'},{type:3,outcome:'save'}];
  const html=await renderHtml(PAGE,'MatchCard',{m:{...match,myStats:stats,myClutches:clutches,durationMs:35*60000+7000,myPostRR:1674,myPostTierId:18,avgTeamRank:18.4,avgEnemyRank:18.6},s,maps:null,agents,open:true,onOpenChange(){}});
  const info=html.slice(html.indexOf('data-slot="match-info"'),html.indexOf('Your team'));
  // No agent (the closed row's tile has it), no RR change, and no rank tile (removed on request).
  assert.doesNotMatch(info,/data-agent=|match-agent|Jett|\+24|rank-change|rank-bar|Diamond/);
  // No notes under the values (23 Nov 2026, on request): their counts are in the label hints.
  // No ADR tile (24 Nov 2026, on request).
  assert.match(text(info),/> K\/D 1\.50 ACS 240 DDΔ \+34 HS% 28% KAST 74% Clutches 33% Length 35:07 Server Frankfurt Start \d\d:\d\d$/);
  assert.doesNotMatch(info,/ADR|mc-info-adr/);
  // Phones add the start time, which their closed row does not show: CSS shows
  // .mc-info-started only inside .match-card.mobile.
  assert.match(info,/<div class="mc-stat-tile mc-info-started"><dt class="mc-stat-label">Start<\/dt>/);
  const {readFileSync}=await import('node:fs');
  const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
  assert.match(css,/\.mc-stat-tile\.mc-info-started \{ display: none; \}/);
  // Seven tiles in a row; eight with the server below 880px; four columns
  // below 760px (a server name needs the room), three on phones.
  assert.match(css,/\.mc-stats \{ display: grid; grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);/);
  assert.match(css,/@container \(max-width: 880px\) \{\n  \.mc-stats \{ grid-template-columns: repeat\(8, minmax\(0, 1fr\)\); \}/);
  assert.match(css,/@container \(max-width: 760px\) \{\n  \.mc-stats \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}\n  \.match-card\.mobile \.mc-stats \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css,/\.match-card\.mobile \.mc-stat-tile\.mc-info-started \{ display: flex; \}/);
  assert.doesNotMatch(info,/mc-stat-foot/);
  const {matchInfoTiles}=await import('./helpers/react-render.mjs').then(r=>r.load(PAGE));
  const hints=Object.fromEntries(matchInfoTiles({...match,myStats:stats,myClutches:clutches},{duration:'35:07'}).map(t=>[t.label,t.hint]));
  assert.equal(hints['K/D'],'Kills divided by deaths (18 kills, 12 deaths)');
  assert.equal(hints['DDΔ'],'Damage delta: damage dealt minus damage taken, per round (2,944 taken)');
  assert.equal(hints.KAST,'Rounds with a kill, assist, survival or trade (17 of 23 rounds)');
  assert.equal(hints.Clutches,'1 of 3 won: 1v2 won, 1v1 lost, 1v3 saved');
  assert.equal(matchInfoTiles({...match,myClutches:null},{}).find(t=>t.label==='Clutches').hint,'No round data for this match');
  assert.match(info,/<dl class="mc-stats" data-slot="match-stats"><div class="mc-stat-tile"><dt class="mc-stat-label">/);
  // A positive delta is green, a negative one red.
  assert.match(info,/<dd class="mc-stat-value text-positive">\+34<\/dd>/);
  const behind=await renderHtml(PAGE,'MatchCard',{m:{...match,myStats:{...stats,ddDelta:-21}},s,maps:null,agents,open:true,onOpenChange(){}});
  assert.match(behind,/<dd class="mc-stat-value text-negative">−21<\/dd>/);
  // RR notes are gone from under the strip (23 Nov 2026, on request). Only the
  // performance bonus and a refund show, as figures right after the RR change:
  // "+24+5+12". Other details (replenished shield here) are not shown.
  const notedMatch={...match,myRRDetails:{bonus:5,shieldReplenished:true},myRefundedRR:12};
  const noted=await renderHtml(PAGE,'MatchCard',{m:notedMatch,s,maps:null,agents,open:true,onOpenChange(){}});
  assert.doesNotMatch(noted,/rr-notes|rr-marks|replenished/i);
  const rrCell=noted.slice(noted.indexOf('mc-cell mc-rr'),noted.indexOf('mc-chevron'));
  assert.match(text(rrCell),/> RR \+24 \+5 \+12 </);
  assert.match(rrCell,/<span class="mc-rr-value" data-slot="rr-value"><span class="match-rr-change gain"[^>]*>\+24<\/span><span class="mc-rr-extra gain" data-extra="bonus"[^>]*>\+5<\/span><span class="mc-rr-extra gain" data-extra="refund"[^>]*>\+12<\/span><\/span>/);
  assert.match(noted,/aria-label="[^"]* \+5 RR performance bonus\. \+12 RR refunded\. Hide match details and roster"/);
  // A negative bonus is red; zeros are left out.
  const negative=await renderHtml(PAGE,'MatchCard',{m:{...match,myRR:-18,myRRDetails:{bonus:-2},myRefundedRR:0},s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(negative,/<span class="mc-rr-extra loss" data-extra="bonus"[^>]*>-2<\/span><\/span>/);
  assert.doesNotMatch(negative,/data-extra="refund"/);
  // Phones: the same figures after the RR change on the first line.
  const notedPhone=await renderHtml(PAGE,'MobileMatchCard',{m:notedMatch,s,maps:null,agents,open:false,onOpenChange(){}});
  assert.match(notedPhone,/<span class="mc-rr-value shrink-0 text-\[15px\]" data-slot="rr-value">/);
  // Without either, the RR change is unchanged.
  assert.doesNotMatch(await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents,open:false,onOpenChange(){}}),/rr-value|mc-rr-extra/);
  // The server tile is in the markup but shown only where the closed row hides it (.mc-info-server).
  assert.match(info,/<div class="mc-stat-tile mc-info-server"><dt class="mc-stat-label">Server<\/dt>/);
  // Without per-match data the tiles say so rather than guess.
  const bare=text(await renderHtml(PAGE,'MatchCard',{m:{...match,myClutches:null},s,maps:null,agents,open:true,onOpenChange(){}}));
  assert.match(bare,/ACS 240 DDΔ — HS% — KAST — Clutches — Length 35:00/);
  // No debug grid: no queue, no "Recorded payout", no reported-fields footnote.
  assert.doesNotMatch(html,/Your RR details|Recorded payout|Queue|not added again/);
  // Each team header carries its average rank as a short name in its colour, not its rounds (the closed row has the score).
  const desktopRoster=html.slice(html.indexOf('Your team'));
  // A gap under each team header's rule, so your highlighted row cannot sit on it and hide it.
  assert.equal((html.match(/<div class="mb-1 grid items-end border-b [^"]*" data-slot="team-header">/g)||[]).length,2);
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

test('roster parties share a colour on either team, yours first, solos stay plain; agent icons sit in a block-level wrapper so names line up',async()=>{
  const players=[
    player('p1','Player','red','Jett',{party_id:'a'}),player('p2','Mate','red','Omen',{party_id:'a'}),player('p3','Solo','red','Sova',{party_id:'s3'}),
    player('p4','Foe','blue','Sova',{party_id:'b'}),player('p5','Foe2','blue','Jett',{party_id:'b'}),player('p6','Foe3','blue','Omen',{party_id:'b'}),
  ];
  const html=await renderHtml(PAGE,'MatchCard',{m:{...match,players,myPartyId:'a'},s,maps:null,agents,open:true,onOpenChange(){}});
  const roster=html.slice(html.indexOf('Your team'));
  const colour=name=>roster.match(new RegExp(`<span class="([^"]*)"(?: data-party="(\\d)")?>${name}</span>`)).slice(1);
  assert.deepEqual(colour('Player'),['min-w-0 truncate font-semibold text-sky-300','1']);
  assert.deepEqual(colour('Mate'),['min-w-0 truncate text-sky-300','1']);
  assert.deepEqual(colour('Solo'),['min-w-0 truncate',undefined]);
  for(const foe of ['Foe','Foe2','Foe3'])assert.deepEqual(colour(foe),['min-w-0 truncate text-lime-300','2']);
  assert.match(roster,/title="Mate#EU, in a party with Player"/);
  assert.match(roster,/title="Foe#EU, in a party with Foe2, Foe3"/);
  assert.match(roster,/title="Solo#EU"/);
  assert.match(roster,/<span class="flex shrink-0"[^>]*><span aria-hidden="true" data-slot="agent-icon"/);
});

test('the phone card is two lines next to a 40px agent tile and names the agent in its label',async()=>{
  const html=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,myStats:{...match.myStats,adr:162}},s,maps:null,agents,open:false,onOpenChange(){}});
  // Decluttered 23 Nov 2026: no start time and no PS/ACS figure on the closed card; no ADR since 24 Nov 2026.
  const visible=text(html.replace(/aria-label="[^"]*"/g,''));
  assert.match(visible,/^Win 13 : 7 Diamond 2 \+24 Abyss 18 \/ 12 \/ 8$/);
  assert.doesNotMatch(html,/data-slot="match-started"/);
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

test('a day\'s K/D, ACS, ADR, KAST and PS are weighted like the act stats and count their coverage',async()=>{
  const {dayPerformance}=await import('../src/engine/core.mjs');
  const day=[
    {myStats:{kills:20,deaths:10,score:6000,rounds_played:20,adr:150,dmg:3000,kastRounds:15,kastTotalRounds:20,performanceScore:240}},
    {myStats:{kills:10,deaths:20,score:3000,rounds_played:30,adr:100,dmg:3000,kastRounds:null,kastTotalRounds:null,performanceScore:null}},
    {myStats:null},
  ];
  const p=dayPerformance(day);
  // K/D from summed kills and deaths; ACS and ADR per round played, not a mean of match averages.
  assert.equal(p.kd,1);
  assert.equal(p.acs,9000/50);
  assert.equal(p.adr,6000/50);
  assert.equal(p.kast,75);
  assert.equal(p.ps,240);
  assert.deepEqual([p.matches,p.kdCount,p.acsCount,p.adrCount,p.kastCount,p.psCount],[3,2,2,2,1,1]);
  const none=dayPerformance([{myStats:null}]);
  assert.deepEqual([none.kd,none.acs,none.adr,none.kast,none.ps],[null,null,null,null,null]);
});

test('the day recap is one quiet line: record and net RR, then lobby, K/D, ACS, ADR, KAST and PS as value-and-unit pairs',async()=>{
  const {dayRecapItems}=await import('./helpers/react-render.mjs').then(r=>r.load(PAGE));
  const stat={matches:4,wins:2,losses:1,draws:1,sum:18.5*3,count:3,rrTotal:28,rrCount:3,
    perf:{matches:4,kd:1.234,kdCount:4,acs:241.6,acsCount:4,adr:158.4,adrCount:4,kast:72.5,kastCount:3,ps:229.5,psCount:4}};
  const {result,performance}=dayRecapItems(stat);
  assert.deepEqual(result.map(i=>i.key),['record','rr']);
  assert.deepEqual(performance.map(i=>[i.key,i.value,i.unit]),[['lobby','Diamond 2','lobby'],['kd','1.23','K/D'],['acs',242,'ACS'],['adr',158,'ADR'],['kast','73%','KAST'],['ps',230,'PS']]);
  assert.equal(result[1].value,'+28');
  assert.equal(result[1].tone,'text-positive');
  // Win rate is wins over decided matches; partial coverage is named in the hint.
  assert.match(result[0].hint,/^67% win rate/);
  assert.equal(result[1].hint,'Net RR: every recorded RR change this day, Rank Shield losses included; 3 of 4 matches have data');
  assert.match(performance.find(i=>i.key==='kast').hint,/; 3 of 4 matches have data$/);
  assert.doesNotMatch(performance.find(i=>i.key==='acs').hint,/matches have data/);
  // Without data: dashes, not zeros.
  const empty=dayRecapItems({matches:1,wins:0,losses:0,draws:1,sum:0,count:0,rrTotal:0,rrCount:0,perf:{}});
  assert.deepEqual([...empty.result,...empty.performance].slice(1).map(i=>i.value),[null,null,null,null,null,null,null]);
  // The rendered page: no boxed tiles, only plain pairs, under a day heading.
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../src/app/pages/Matches.jsx',import.meta.url),'utf8');
  const header=source.slice(source.indexOf('function DayHeader('),source.indexOf('export function MatchesPage('));
  assert.doesNotMatch(header,/<dl|rounded-lg|bg-card|grid-cols/);
  assert.match(header,/data-slot="day-recap-result"[^]*data-slot="day-recap-performance"/);
});
