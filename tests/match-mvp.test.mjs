import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {pickMvps,placeText} from '../src/engine/core.mjs';
import {closeRenderer,renderHtml} from './helpers/react-render.mjs';

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

test('the desktop card marks the MVP on the score that decided it, not beside the result',async()=>{
  const html=await renderHtml(PAGE,'MatchCard',{m:match,s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(cell(html,'mc-ps'),/<span class="mc-mvp mvp-match">230<\/span>/);
  assert.doesNotMatch(cell(html,'mc-acs'),/mc-mvp/);
  assert.doesNotMatch(html.slice(html.indexOf('mc-outcome'),html.indexOf('mc-perf')),/trophy|MVP/i);
  assert.match(html,/aria-label="Loss on Abyss, 8–13\. Played Jett\. Match MVP\./);
  const team=await renderHtml(PAGE,'MatchCard',{m:{...match,matchMvpPuuid:'x'},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(cell(team,'mc-ps'),/<span class="mc-mvp mvp-team">230</);
  const older=await renderHtml(PAGE,'MatchCard',{m:{...match,mvpBasis:'acs'},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(cell(older,'mc-acs'),/<span class="mc-mvp mvp-match">240<\/span>/);
  assert.doesNotMatch(cell(older,'mc-ps'),/mc-mvp/);
  const none=await renderHtml(PAGE,'MatchCard',{m:{...match,matchMvpPuuid:'x',teamMvpPuuids:new Set()},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.doesNotMatch(none,/mc-mvp|lucide-trophy/);
});

test('your place by the deciding score follows it in brackets, MVP for first',async()=>{
  const places=new Map([['x',1],['p1',3]]);
  const third=await renderHtml(PAGE,'MatchCard',{m:{...match,matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(cell(third,'mc-ps'),/<span class="mc-performance-val"><span>230<\/span><span class="mc-place">\(3rd\)<\/span><\/span>/);
  assert.doesNotMatch(cell(third,'mc-acs'),/mc-place/);
  const first=await renderHtml(PAGE,'MatchCard',{m:{...match,scorePlaces:new Map([['p1',1]])},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(cell(first,'mc-ps'),/<span class="mc-mvp mvp-match">230<\/span><span class="mc-place mvp-match">\(MVP\)<\/span>/);
  // Older matches rank by ACS, so the place follows ACS.
  const older=await renderHtml(PAGE,'MatchCard',{m:{...match,mvpBasis:'acs',matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(cell(older,'mc-acs'),/240<\/span><span class="mc-place">\(3rd\)/);
  assert.doesNotMatch(cell(older,'mc-ps'),/mc-place/);
  // No scores, no place.
  const none=await renderHtml(PAGE,'MatchCard',{m:{...match,mvpBasis:null,scorePlaces:new Map()},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.doesNotMatch(none,/mc-place/);
  const phone=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(phone,/>230<\/span><span class="mc-place">\(3rd\)<\/span> PS/);
  // Phones show one score: PS, or ACS on older matches ranked by ACS.
  const visible=html=>html.replace(/aria-label="[^"]*"/g,'');
  assert.doesNotMatch(visible(phone),/ ACS/);
  const olderPhone=await renderHtml(PAGE,'MobileMatchCard',{m:{...match,mvpBasis:'acs',matchMvpPuuid:'x',teamMvpPuuids:new Set(),scorePlaces:places},s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(olderPhone,/>240<\/span><span class="mc-place">\(3rd\)<\/span> ACS/);
  assert.doesNotMatch(visible(olderPhone),/ PS/);
});

test('the phone card marks the MVP on its PS figure instead of after the score',async()=>{
  const html=await renderHtml(PAGE,'MobileMatchCard',{m:match,s,maps:null,agents:null,open:false,onOpenChange(){}});
  assert.match(html,/<span class="mc-mvp mvp-match font-semibold">230<\/span> PS/);
});

test('the MVP mark is the coloured number alone, with no trophy icon',async()=>{
  for(const name of ['MatchCard','MobileMatchCard']){
    const html=await renderHtml(PAGE,name,{m:match,s,maps:null,agents:null,open:false,onOpenChange(){}});
    assert.doesNotMatch(html,/lucide-trophy/);
  }
});
