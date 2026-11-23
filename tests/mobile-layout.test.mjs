import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {avgLabel,avgLabelShort,tierRR} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('phones switch layout below the 640px sm breakpoint; server renders stay desktop',async()=>{
  const hooks=await load('/src/app/hooks.js');
  assert.equal(hooks.MOBILE_QUERY,'(max-width: 639px)');
  // The phone CSS uses the same breakpoint as the hook.
  assert.match(source('src/index.css'),/@media \(max-width: 639px\) \{\n  \[data-slot="card-header"\]:not\(\.px-0\)/);
  // useMediaQuery's server snapshot is false, so component tests render desktop.
  const html=await renderHtml('/src/app/App.jsx','default');
  assert.match(html,/data-layout="desktop"/);
  assert.doesNotMatch(html,/data-slot="mobile-tab-bar"/);
  // Safe areas need viewport-fit=cover.
  assert.match(source('index.html'),/<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">/);
});

test('the bottom tab bar and the More sheet reach every page exactly once',async()=>{
  const shell=await load('/src/app/MobileShell.jsx');
  const pages=[...shell.MOBILE_TABS,...shell.MOBILE_MORE].map(item=>item.page);
  assert.deepEqual(shell.MOBILE_TABS.map(t=>t.page),['overview','matches','rr','duos']);
  const desktop=[...source('src/app/App.jsx').matchAll(/\['([a-z-]+)','[^']+'\]/g)].map(m=>m[1]);
  assert.deepEqual([...pages].sort(),[...desktop].sort());
  assert.equal(new Set(pages).size,pages.length);
  const html=await renderHtml('/src/app/MobileShell.jsx','MobileTabBar');
  assert.match(html,/<nav aria-label="Main navigation" data-slot="mobile-tab-bar"/);
  assert.equal((html.match(/<a /g)||[]).length,4);
  assert.match(html,/<button type="button"[^>]*aria-haspopup="dialog"[^>]*aria-label="More pages(, showing [^"]+)?"/);
  // Fixed to the bottom with the home-indicator inset.
  assert.match(html,/fixed inset-x-0 bottom-0[^"]*pb-\[env\(safe-area-inset-bottom\)\]/);
});

test('the phone top bar opens search and carries the act picker',async()=>{
  const html=await renderHtml('/src/app/MobileShell.jsx','MobileTopBar');
  assert.match(html,/<header data-slot="mobile-top-bar"[^>]*sticky top-0/);
  assert.match(html,/aria-label="Search players"/);
  const src=source('src/app/MobileShell.jsx');
  // Search focus requests (an invalid search, for example) open the sheet.
  assert.match(src,/useSignal\(s\.searchFocusSignal,\(\)=>setOpen\(true\)\)/);
  // The sheet closes only once a submitted search actually starts loading.
  assert.match(src,/if\(submitted\.current&&s\.analysisState==='loading'\)\{submitted\.current=false;onOpenChange\(false\);\}/);
  // Controls keep the site's rounding (rounded-md), like the desktop pills.
  assert.doesNotMatch(src,/ActPicker className="[^"]*rounded-full/);
});

const columns=[{label:'Server'},{label:'Matches'},{label:'Avg Lobby',wide:true},{label:'K/D'},{label:'Win rate'}];
const row=(key,cells,cellProps)=>({key,cells,cellProps});
const rows=[
  row('fra',['Frankfurt',10,'Dia 1','1.20','55%'],[null,null,null,{className:'text-positive'}]),
  row('par',['Paris',4,'Dia 2','0.90','40%']),
  row('lon',['London',2,'Plat 3','1.40','60%']),
];
const values=[['Frankfurt',10,18,1.2,.55],['Paris',4,19,.9,.4],['London',2,17,1.4,.6]];

test('tables become card lists on phones: title, headline figure, label grid and a sort select',async()=>{
  const best=new Map([[3,{max:1.4,label:'K/D'}]]);
  const html=await renderHtml('/src/app/shared.jsx','MobileRowList',{id:'t',caption:'Servers',columns,rows,values,order:[2,0,1],best,sort:{column:3,direction:'descending'},choose(){}});
  const items=[...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m=>text(m[1]));
  assert.deepEqual(items,[
    'London 2 Matches Avg Lobby Plat 3 K/D 1.40 Win rate 60%',
    'Frankfurt 10 Matches Avg Lobby Dia 1 K/D 1.20 Win rate 55%',
    'Paris 4 Matches Avg Lobby Dia 2 K/D 0.90 Win rate 40%',
  ]);
  // Every column is a sort option; the current one is selected.
  assert.deepEqual([...html.matchAll(/<option[^>]*value="(\d*)"/g)].map(m=>m[1]),['','0','1','2','3','4']);
  assert.match(html,/<select[^>]*data-slot="native-select"[^>]*id="t-sort"/);
  // Wide (lobby) cells span two grid columns; tones and the best value carry over.
  assert.match(html,/col-span-2/);
  assert.match(html,/text-positive/);
  assert.equal((html.match(/bg-brand\/15/g)||[]).length,1);
});

test('one-row lists mark no "best" value and hide the sort controls',async()=>{
  const best=new Map([[3,{max:1.2,label:'K/D'}]]);
  const html=await renderHtml('/src/app/shared.jsx','MobileRowList',{id:'one',caption:'Servers',columns,rows:rows.slice(0,1),values:values.slice(0,1),order:[0],best,sort:null,choose(){}});
  assert.doesNotMatch(html,/bg-brand\/15/);
  assert.match(html,/<div class="items-center gap-2 border-b px-4 pt-2 pb-3 hidden"><label for="one-sort"/);
});

test('the phone match card keeps result, score, RR change, stats and the roster toggle',async()=>{
  const m={matchId:'m1',mapName:'Abyss',won:true,myR:13,opR:7,myRR:24,startedAtMs:Date.UTC(2026,9,10,18,30),durationMs:35*60000,serverName:'Frankfurt',
    myStats:{kills:18,deaths:12,assists:8,acs:240.4,performanceScore:230.2},avgRank:18.5,players:[]};
  const s={PUUID:'p1',PLAYER:'Player',TAG:'EUW',mhIncludeReset:false};
  const html=await renderHtml('/src/app/pages/Matches.jsx','MobileMatchCard',{m,s,maps:null,open:false,onOpenChange(){}});
  assert.match(html,/class="match-card mobile win"/);
  const t=text(html);
  // Two lines since 22 Nov 2026: length and server are in the opened card;
  // the start time (23 Nov 2026) takes the first line's spare width; the
  // average lobby (full rank name, no icon) sits before the RR change.
  // ACS left the phone line (22 Nov 2026); it is in the roster.
  assert.match(t,new RegExp(String.raw`^Win 13 : 7 \d\d:\d\d ${avgLabel(tierRR(18.5).tier)} \+24 Abyss 18 / 12 / 8 230 PS$`));
  // The time hides when the line's spare width is narrower than it.
  assert.match(html,/<span class="@container min-w-0 flex-1"><span class="[^"]*@max-\[34px\]:hidden" title="10 Oct, \d\d:\d\d" data-slot="match-started">\d\d:\d\d<\/span><\/span>/);
  assert.match(html,/data-slot="lobby-rank"[^>]*>Diamond 2<\/span>/);
  assert.match(html,/aria-label="Win on Abyss, 13–7\. 18 \/ 12 \/ 8 KDA, 240 ACS, 230 Performance Score\. Average lobby [^"]+\. Show match details and roster"/);
  const opened=text(await renderHtml('/src/app/pages/Matches.jsx','MobileMatchCard',{m,s,maps:null,open:true,onOpenChange(){}}));
  // The opened card's tiles give the length (with seconds) and the server,
  // which the phone's closed card does not show; the lobby is on the closed card.
  assert.match(opened,/Length 35:00 Server Frankfurt/);
});

test('a narrow party-size table drops the Lobbies column and long rank label, putting the count under the party label',async()=>{
  const s={overviewStats:{overallRR:{tier:18,rr:50},overall:18.5},allMatches:[],statMatches:Array.from({length:12},()=>({partySize:2,avgRank:18.5}))};
  const html=await renderHtml('/src/app/pages/Overview.jsx','KpiCards',{s});
  const r=tierRR(18.5);
  const table=html.slice(html.indexOf('data-slot="lobby-party-table"'),html.indexOf('overview-duos-title'));
  // A container query on the table frame: phones fit all three columns, the narrow two-column card on tablets does not.
  assert.match(html,/class="[^"]*@container[^"]*" data-slot="lobby-party-table"/);
  assert.match(table,/<th [^>]*class="[^"]*@max-\[19rem\]:hidden[^"]*"[^>]*>Lobbies<\/th>/);
  assert.match(table,/<span class="block text-xs @min-\[19rem\]:hidden">12 lobbies<\/span>/);
  assert.ok(table.includes(`<span class="truncate @max-[19rem]:hidden">${avgLabel(r.tier)}</span><span class="truncate @min-[19rem]:hidden">${avgLabelShort(r.tier)}</span>`));
  assert.match(table,new RegExp(`title="Duo: ${avgLabel(r.tier)} across 12 lobbies"`));
});

test('hidden pages stay mounted in a hidden Activity, so they render only when idle',async()=>{
  const app=source('src/app/App.jsx');
  const desktop=[...app.matchAll(/\['([a-z-]+)','[^']+'\]/g)].map(m=>m[1]);
  const slots=[...app.matchAll(/<PageSlot id="([a-z-]+)" page=\{page\}>/g)].map(m=>m[1]);
  assert.deepEqual(slots,desktop,'every page sits in a PageSlot');
  assert.match(app,/<div hidden=\{!shown\}><Activity mode=\{shown\?'visible':'hidden'\}>\{children\}<\/Activity><\/div>/);
  // Server renders show the active page only: the eight hidden slots are empty.
  const html=await renderHtml('/src/app/App.jsx','default');
  const hidden=[...html.matchAll(/<div hidden="">(.*?)<\/div>/g)];
  assert.equal(hidden.length,8);
  assert.ok(hidden.every(m=>m[1]===''),'hidden Activity content is not server-rendered');
});
