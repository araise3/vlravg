import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {avgLabel,avgLabelShort,tierRR} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const PAGE='/src/app/pages/Overview.jsx';
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

const overviewStats={overallRR:{tier:18,rr:50},overall:18.5,kd:'1.14',acs:'237.6',performance:'294.2',adr:'156.5',kast:'69.9%',
  playtime:{value:'28h',title:'Playtime'}};
const state=(parties,matches=[])=>({
  overviewStats,allMatches:matches,
  statMatches:parties.flatMap(([size,avgRank,count])=>Array.from({length:count},()=>({partySize:size,avgRank}))),
});

test('the lobby rank card leads with the rank-coloured average, then the spread and a table row per party size played',async()=>{
  const single=await renderHtml(PAGE,'KpiCards',{s:state([[2,18.5,12]])});
  const duo=tierRR(18.5);
  assert.ok(text(single).includes(`Avg lobby rank Lobby Rank Diamond 1 50 RR Across 12 rated lobbies By party size Party Lobby rank Lobbies Duo 12 lobbies ${avgLabel(duo.tier)} ${avgLabelShort(duo.tier)} 12 `),text(single));
  const lobbyCard=single.slice(0,single.indexOf('overview-duos-title'));
  assert.doesNotMatch(lobbyCard,/data-slot="badge"/);
  // Same header shape as Top teammates: an h2 title and a link to the full page.
  assert.match(lobbyCard,/<h2 id="overview-lobby-title">Avg lobby rank<\/h2>/);
  assert.match(lobbyCard,/data-slot="card-action"[\s\S]*Lobby Rank/);
  assert.match(lobbyCard,/data-slot="card-header" class="[^"]*has-data-\[slot=card-action\]:items-center/);
  // The hero: the 256px badge, the division in its rank colour (Diamond #c07de0) and the RR into it as a bar.
  assert.match(lobbyCard,/src="\/assets\/ranks\/18\.png"/);
  assert.match(lobbyCard,/style="color:#c07de0"[^>]*>Diamond 1</);
  assert.match(lobbyCard,/data-slot="progress"[^>]*aria-label="50 of 100 RR into Diamond 1"|aria-label="50 of 100 RR into Diamond 1"[^>]*data-slot="progress"/);
  assert.match(lobbyCard,/--lobby-rank:#c07de0/);
  assert.match(lobbyCard,/rgb\(192 125 224 \/ \.14\)/);
  // A shadcn Separator splits the hero from the breakdowns.
  assert.match(lobbyCard,/data-slot="separator"/);
  // One division seen: no spread chart.
  assert.doesNotMatch(lobbyCard,/data-slot="lobby-spread"/);
  const mixed=text(await renderHtml(PAGE,'KpiCards',{s:state([[1,14.5,3],[2,18.5,9]])}));
  const row=(label,v,n)=>{const r=tierRR(v);return `${label} ${n} lobbies ${avgLabel(r.tier)} ${avgLabelShort(r.tier)} ${n}`;};
  assert.ok(mixed.includes(row('Solo',14.5,3)+' '+row('Duo',18.5,9)),mixed);
  // No RR column: the RR into an averaged division is interpolated and told nothing per party size (removed on request).
  const table=single.slice(single.indexOf('data-slot="lobby-party-table"'),single.indexOf('overview-duos-title'));
  assert.doesNotMatch(table,/>RR</);
  assert.doesNotMatch(table,/title="[^"]* RR /);
  assert.equal(avgLabel(18),'Diamond 1');
});

test('the lobby spread has one bar per division from the lowest lobby to the highest, gaps included',async()=>{
  const {lobbySpread}=await load(PAGE);
  assert.deepEqual(lobbySpread([{avgRank:15.2},{avgRank:17.9},{avgRank:18.4},{avgRank:18}]),
    [{tier:15,count:1},{tier:16,count:0},{tier:17,count:0},{tier:18,count:3}]);
  assert.deepEqual(lobbySpread([]),[]);
  const avg=(15*2+17*6+18*4)/12;
  const html=await renderHtml(PAGE,'LobbyRankCard',{s:{...state([[1,15,2],[1,17,6],[2,18,4]]),overviewStats:{overall:avg,overallRR:tierRR(avg)}}});
  const spread=html.slice(html.indexOf('data-slot="lobby-spread"'));
  assert.match(spread,/aria-label="Rated lobbies by rank: Platinum 1 2, Platinum 3 6, Diamond 1 4"/);
  // No rank range beside the heading (removed on request, 22 Nov 2026).
  assert.match(text(spread),/> Lobby spread Plat 1 Plat 2/);
  // The average's division is lit, the others dimmed; the empty division is a muted stub.
  const bars=[...spread.matchAll(/title="([^"]+)"><div class="([^"]*)" style="([^"]*)"/g)].map(m=>({title:m[1],lit:/opacity:1(;|$)/.test(m[3]),empty:/bg-muted/.test(m[2])}));
  assert.deepEqual(bars.map(b=>b.title),['Platinum 1: 2 lobbies','Platinum 2: 0 lobbies','Platinum 3: 6 lobbies','Diamond 1: 4 lobbies']);
  assert.deepEqual(bars.map(b=>b.lit),bars.map(b=>b.title.startsWith(avgLabel(tierRR(avg).tier)+':')));
  assert.deepEqual(bars.map(b=>b.lit),[false,false,true,false]);
  assert.deepEqual(bars.map(b=>b.empty),[false,true,false,false]);
  // Each bar wears its own division's rank colour, not the average's (Platinum #36b5c0, Diamond #c07de0).
  const colours=[...spread.matchAll(/title="[^"]+"><div class="[^"]*" style="[^"]*?background:(#[0-9a-f]{6})/g)].map(m=>m[1]);
  assert.deepEqual(colours,['#36b5c0','#36b5c0','#c07de0']);
});

test('without rated lobbies the lobby rank card says so',async()=>{
  const html=text(await renderHtml(PAGE,'LobbyRankCard',{s:{overviewStats:{overallRR:null,overall:null},statMatches:[{partySize:1,avgRank:null}]}}));
  assert.match(html,/Avg lobby rank Lobby Rank No rated lobbies yet $/);
});

test('the recent RR card sums every recorded change while per-game averages use eligible matches only',async()=>{
  const at=i=>Date.UTC(2026,9,1,12)+i*3600000;
  const m=(i,rr,extra={})=>({matchId:'m'+i,startedAtMs:at(i),won:rr>0,myRR:rr,myPostRR:1500+i*5,myTierId:15,partySize:1,...extra});
  const matches=[m(1,20),m(2,-15),m(3,24),m(4,-10,{partySize:5}),{matchId:'m5',startedAtMs:at(5),won:true,myRR:null}];
  const html=await renderHtml(PAGE,'RecentRRCard',{matches});
  const t=text(html);
  assert.match(t,/RR trend, last 5 matches \+19 RR /);
  assert.match(t,/Avg gain \+22\.0 2 wins Avg loss −15\.0 1 loss RR gained \+44 RR lost −25 /);
  assert.match(t,/4 of 5 matches have a recorded RR change\. Averages skip placements and 5-stacks\./);
  // One result dot per recorded change, none for the starting point.
  assert.equal([...html.matchAll(/class="result-point (win|loss|draw)"/g)].length,4);
  assert.doesNotMatch(html,/role="tablist"/);
});

test('act stats keep all eight figures in one grid',async()=>{
  const matches=[{won:true},{won:true},{won:false},{won:null}];
  const html=await renderHtml(PAGE,'ActStatsCard',{s:state([],matches)});
  const cells=[...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map(m=>text(m[1]).trim());
  assert.deepEqual(cells,['K/D','Avg ACS','Avg PS','Avg ADR','KAST','Playtime','Matches','Win rate']);
  // Explained figures (ADR, playtime, win rate here) carry a tap/hover hint, not a native title.
  assert.equal((html.match(/data-slot="hint"/g)||[]).length,3);
  assert.doesNotMatch(html.slice(html.indexOf('<dl')),/ title="/);
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
  const html=text(await renderHtml(PAGE,'RecentMatchesCard',{matches,maps:null}));
  assert.match(html,/^ ?Recent matches All matches Map /);
  assert.match(html,/Haven 15 Nov Win 13–8 24 \/ 15 \/ 11 \+22/);
  assert.match(html,/Bind 14 Nov Draw 12–12 — —/);
});

test('recent matches use the shared table look',async()=>{
  const html=await renderHtml(PAGE,'RecentMatchesCard',{matches:[{matchId:'a',mapName:'Haven',won:true,myR:13,opR:8,myRR:22,myStats:{kills:1,deaths:1,assists:1}}],maps:null});
  assert.match(html,/<div class="overflow-hidden border bg-card rounded-lg max-sm:rounded-none max-sm:border-x-0">/);
  assert.match(html,/<tr[^>]*class="[^"]*bg-muted\/40 hover:bg-muted\/40/);
  assert.match(html,/<th[^>]*class="[^"]*h-10 px-3 text-xs font-medium text-muted-foreground/);
  assert.match(html,/<td[^>]*class="[^"]*px-3 py-2\.5/);
});

test('overview is built from shadcn cards with no scrolling lists',()=>{
  const source=readFileSync(new URL('../src/app/pages/Overview.jsx',import.meta.url),'utf8');
  assert.match(source,/components\/ui\/card/);
  assert.doesNotMatch(source,/overflow-y-auto|Most-played lobbies/);
});

test('an all-draw window shows no averages, and a window without RR says so',async()=>{
  const draws=[1,2].map(i=>({matchId:'d'+i,startedAtMs:i,won:null,myRR:0,myPostRR:1500,myTierId:15,partySize:1}));
  const t=text(await renderHtml(PAGE,'RecentRRCard',{matches:draws}));
  assert.match(t,/\+0 RR /);
  assert.match(t,/Avg gain — 0 wins Avg loss — 0 losses RR gained \+0 RR lost −0/);
  const none=text(await renderHtml(PAGE,'RecentRRCard',{matches:[{matchId:'x',won:true,myRR:null}]}));
  assert.match(none,/No recorded RR changes in these matches/);
  assert.doesNotMatch(none,/ RR trend, last 1 match [+−]/);
});

test('top teammates sit beside the lobby rank card as rows with matches, win rate and RR',async()=>{
  const mate=(name,games,wins,decided,rrTotal,rrCount)=>({key:name,name,tag:'EUW',games,wins,decided,rrTotal,rrCount,kills:1,deaths:1});
  const teammates=[mate('Orange',18,10,16,42,15),mate('Unfair',14,5,14,-30,14),mate('Sevire',8,4,8,0,0),mate('Fourth',4,2,4,8,4),mate('Extra',2,1,2,1,2)];
  const html=await renderHtml(PAGE,'TeammatesCard',{teammates});
  assert.doesNotMatch(html,/data-slot="avatar"/);
  const t=text(html);
  assert.match(t,/Top teammates Duos Teammate Matches Win rate RR Orange #EUW 18 62\.5% \+42 Unfair #EUW 14 35\.7% −30 Sevire #EUW 8 50\.0% — Fourth #EUW 4 50\.0% \+8 $/);
  assert.doesNotMatch(t,/Extra/);
  // From sm up the list fills the height the lobby card sets: an out-of-flow table in a flex-1 box
  // that is measured on the client; the server render (and phones) start from four rows.
  const {TEAMMATES_MIN_ROWS}=await load(PAGE);
  assert.equal(TEAMMATES_MIN_ROWS,4);
  assert.match(html,/data-slot="card-content" class="[^"]*flex-1[^"]*"/);
  assert.match(html,/class="relative sm:min-h-52 sm:flex-1" data-slot="teammates-fit"><div class="[^"]*sm:absolute sm:inset-x-0 sm:top-0/);
  assert.match(text(await renderHtml(PAGE,'TeammatesCard',{teammates:[]})),/No party teammates this act/);
  const kpis=await renderHtml(PAGE,'KpiCards',{s:{...state([[2,18.5,3]]),allTeammates:teammates}});
  assert.ok(kpis.indexOf('overview-lobby-title')<kpis.indexOf('overview-duos-title'));
  assert.doesNotMatch(text(kpis),/Net RR/);
});

test('the overview no longer carries the full RR trend chart',()=>{
  const source=readFileSync(new URL('../src/app/pages/Overview.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(source,/RRTrendChart|setRRTrendRange|<Tabs/);
  const order=['<KpiCards s={s}/>','<ActStatsCard s={s}/>','<ClutchCard matches={s.allMatches}/>','<RecentRRCard matches={recent}/>','<RecentMatchesCard'].map(tag=>source.indexOf(tag));
  assert.ok(order.every((at,i)=>at>0&&(!i||at>order[i-1])),String(order));
});

test('rank icons keep their aspect ratio and use the sharp PNG from 32px',async()=>{
  const small=await renderHtml('/src/app/shared.jsx','RankIcon',{tier:26,size:18});
  const large=await renderHtml('/src/app/shared.jsx','RankIcon',{tier:26,size:34});
  assert.match(small,/src="data:image/);
  assert.match(large,/src="\/assets\/ranks\/26\.png"/);
  for(const html of [small,large])assert.match(html,/object-contain/);
});

test('clutch tiles keep the old colours: 1v1 green through 1v5 purple, neutral without situations',async()=>{
  const {CLUTCH_COLORS}=await load(PAGE);
  const matches=[{myClutchAll:{1:{win:2,loss:1,save:0},3:{win:0,loss:1,save:1}}}];
  const html=await renderHtml(PAGE,'ClutchCard',{matches});
  const tiles=[...html.slice(html.indexOf('data-slot="clutch-tiles"')).matchAll(/<div class="([^"]*)"( style="background:([^"]+)")?[^>]*title="1v(\d)/g)]
    .map(m=>({t:Number(m[4]),bg:m[3]||null,white:/text-white/.test(m[1])}));
  assert.deepEqual(tiles,[
    {t:1,bg:'#22c55e',white:true},{t:2,bg:null,white:false},{t:3,bg:'#3b82f6',white:true},
    {t:4,bg:null,white:false},{t:5,bg:null,white:false},
  ]);
  assert.deepEqual(CLUTCH_COLORS,{1:'#22c55e',2:'#14b8a6',3:'#3b82f6',4:'#6366f1',5:'#a855f7'});
});

test('cards whose title says it all carry no description line',async()=>{
  const {readFileSync}=await import('node:fs');
  const read=file=>readFileSync(new URL('../src/app/pages/'+file,import.meta.url),'utf8');
  const overview=read('Overview.jsx'),rr=read('RR.jsx');
  for(const gone of [/this act<\/CardDescription>/,/Latest \{matches\.length\} of/,/Most matches together this act/,/Total RR after each match/])assert.doesNotMatch(overview,gone);
  assert.doesNotMatch(rr,/<CardDescription/);
  // Descriptions that add information the title does not stay.
  const duos=read('Duos.jsx');
  assert.match(duos,/<CardDescription>Players you met in at least two counted matches/);
  assert.match(duos,/<CardDescription>Repeated opponents with unusually low combat stats/);
  assert.match(overview,/<CardDescription>\{win\} won of \{total\} opportunities<\/CardDescription>/);
});
