import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {pickMvps,placeText} from '../src/engine/core.mjs';
import {closeRenderer,load,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const p=(puuid,team_id,_acs,_performanceScore)=>({puuid,team_id,_acs,_performanceScore});

test('since Patch 13.06 the MVP is the highest Performance Score, not the highest ACS',()=>{
  const players=[p('a','red',310,200),p('b','red',240,260),p('c','blue',280,250),p('d','blue',150,180)];
  const {mvpBasis,matchMvpPuuid,teamMvpPuuids}=pickMvps(players);
  assert.equal(mvpBasis,'ps');
  assert.equal(matchMvpPuuid,'b');
  assert.deepEqual([...teamMvpPuuids].sort(),['b','c']);
  assert.deepEqual([...pickMvps(players).scorePlaces],[['b',1],['c',2],['a',3],['d',4]]);
});

test('places follow the deciding score, with ties in list order like the MVP pick',()=>{
  const {matchMvpPuuid,scorePlaces}=pickMvps([p('a','red',200,250),p('b','blue',300,250),p('c','red',100,240)]);
  assert.equal(matchMvpPuuid,'a');
  assert.deepEqual([...scorePlaces],[['a',1],['b',2],['c',3]]);
  // ACS fallback ranks by ACS and leaves out players without one.
  assert.deepEqual([...pickMvps([p('a','red',150,null),p('b','blue',null,null),p('c','red',220,null)]).scorePlaces],[['c',1],['a',2]]);
});

test('first place reads MVP, the rest as ordinals',()=>{
  assert.deepEqual([1,2,3,4,10,11,12,13,21,22,23].map(placeText),['MVP','2nd','3rd','4th','10th','11th','12th','13th','21st','22nd','23rd']);
});

test('older matches without Performance Score, or with it only for some players, fall back to ACS',()=>{
  for(const players of [
    [p('a','red',310,null),p('b','red',240,null),p('c','blue',280,null)],
    [p('a','red',310,null),p('b','red',240,260),p('c','blue',280,250)],
  ]){
    const {mvpBasis,matchMvpPuuid,teamMvpPuuids}=pickMvps(players);
    assert.equal(mvpBasis,'acs');
    assert.equal(matchMvpPuuid,'a');
    assert.deepEqual([...teamMvpPuuids].sort(),['a','c']);
  }
  // A genuine zero is a reported score.
  assert.equal(pickMvps([p('a','red',100,0),p('b','blue',90,0)]).mvpBasis,'ps');
  assert.deepEqual(pickMvps([]),{mvpBasis:null,matchMvpPuuid:null,teamMvpPuuids:new Set(),scorePlaces:new Map()});
});

const PAGE='/src/app/pages/Matches.jsx';
const s={PUUID:'p1',PLAYER:'Player',TAG:'EU',mhIncludeReset:false};
const match={matchId:'m1',mapName:'Abyss',won:false,myR:8,opR:13,myRR:-20,serverName:'Frankfurt',myAgent:'Jett',
  myStats:{kills:18,deaths:12,assists:8,acs:240.4,performanceScore:230.2},avgRank:18.5,
  matchMvpPuuid:'p1',teamMvpPuuids:new Set(['p1']),mvpBasis:'ps',
  players:[{puuid:'p1',name:'Player',tag:'EU',team_id:'red'}]};
// One labelled cell of the desktop row, up to the next cell.
const cell=(html,cls)=>{const from=html.indexOf(`mc-cell ${cls}`);return html.slice(from,html.indexOf('mc-cell ',from+8));};

test('the desktop card shows your place where the agent name was: MVP in gold for first, else 3rd',async()=>{
  const card=m=>renderHtml(PAGE,'MatchCard',{m,s,maps:null,agents:null,open:false,onOpenChange(){}});
  const sub=html=>html.slice(html.indexOf('class="mc-sub"'),html.indexOf('mc-cell mc-outcome'));
  const first=await card({...match,scorePlaces:new Map([['p1',1]])});
  assert.match(sub(first),/<span class="mc-place mvp-match" data-slot="match-place"[^>]*>MVP<\/span>/);
  // The agent name is gone from the row (it stays in the label and the opened card).
  assert.doesNotMatch(sub(first),/Jett/);
  assert.match(first,/aria-label="Loss on Abyss, 8–13\. Played Jett\. Match MVP\./);
  const places=new Map([['x',1],['p1',3]]);
  const third=await card({...match,matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places});
  assert.match(sub(third),/<span class="mc-place" data-slot="match-place"[^>]*>3rd<\/span>/);
  // No scores, no place.
  const none=await card({...match,mvpBasis:null,scorePlaces:new Map()});
  assert.doesNotMatch(none,/match-place/);
});

test('PS and ACS are plain numbers: no gold or silver MVP colour and no place after them',async()=>{
  const card=m=>renderHtml(PAGE,'MatchCard',{m,s,maps:null,agents:null,open:false,onOpenChange(){}});
  for(const m of [{...match,scorePlaces:new Map([['p1',1]])},{...match,matchMvpPuuid:'x',scorePlaces:new Map([['x',1],['p1',2]])},{...match,mvpBasis:'acs',scorePlaces:new Map([['p1',1]])}]){
    const html=await card(m);
    assert.match(cell(html,'mc-ps'),/<span class="mc-performance-val">230<\/span>/);
    assert.match(cell(html,'mc-acs'),/<span class="mc-performance-val">240<\/span>/);
    assert.doesNotMatch(cell(html,'mc-ps')+cell(html,'mc-acs'),/mc-mvp|mvp-match|mvp-team|mc-place|\(/);
  }
});

test('the place hint names the deciding score and a Team MVP',async()=>{
  const {matchView}=await load(PAGE);
  assert.equal(matchView({...match,scorePlaces:new Map([['p1',1]])},s).placeHint,'Match MVP: highest Performance Score in the match');
  assert.equal(matchView({...match,matchMvpPuuid:'x',scorePlaces:new Map([['p1',2]])},s).placeHint,
    '2nd by Performance Score in the match; Team MVP: highest Performance Score on your team');
  assert.equal(matchView({...match,mvpBasis:'acs',matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:new Map([['p1',4]])},s).placeHint,'4th by ACS in the match');
});

test('the phone card shows the place after the map and a plain PS (ACS on older matches)',async()=>{
  const phoneCard=m=>renderHtml(PAGE,'MobileMatchCard',{m,s,maps:null,agents:null,open:false,onOpenChange(){}});
  const places=new Map([['x',1],['p1',3]]);
  const phone=await phoneCard({...match,matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places});
  assert.match(phone,/>Abyss<\/span><span class="mc-place shrink-0" data-slot="match-place"[^>]*>3rd<\/span>/);
  assert.match(phone,/<span class="font-semibold text-foreground">230<\/span> PS/);
  const visible=html=>html.replace(/aria-label="[^"]*"/g,'');
  assert.doesNotMatch(visible(phone),/ ACS|mc-mvp/);
  const mvp=await phoneCard({...match,scorePlaces:new Map([['p1',1]])});
  assert.match(mvp,/class="mc-place mvp-match shrink-0" data-slot="match-place"[^>]*>MVP</);
  const olderPhone=await phoneCard({...match,mvpBasis:'acs',matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places});
  assert.match(olderPhone,/<span class="font-semibold text-foreground">240<\/span> ACS/);
  assert.doesNotMatch(visible(olderPhone),/ PS/);
});

test('the MVP mark has no trophy icon',async()=>{
  for(const name of ['MatchCard','MobileMatchCard']){
    const html=await renderHtml(PAGE,name,{m:match,s,maps:null,agents:null,open:false,onOpenChange(){}});
    assert.doesNotMatch(html,/lucide-trophy/);
  }
});
