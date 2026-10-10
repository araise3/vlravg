// Injected only by the localhost preview server, before frontend initialization.
// Fixtures enter processMatch as v4 API-shaped data; production markup/CSS is intact.
const stressCase=new URLSearchParams(location.search).get('data')||'demo';
const stressWorst=stressCase!=='demo';
const stressNames=stressWorst?['WWWWWWWWWWWWWWWW','#unused','Đặng Ngọc Hân','王秀英','نور الهدى','Priya','Jax','Joy','Seán','Mia']:['Player','Duo','Alex','Sam','Joy','Enemy','Sky','Lee','Mia','Kai'];
stressNames[1]=stressWorst?'KonstantinWWWWW':'Duo';
if(stressCase==='malformed'){stressNames[5]='👩🏽‍💻 Priya';stressNames[6]='J';stressNames[7]='Jo';stressNames[9]='A&B <3';}
const stressPuuid='00000000-0000-4000-8000-000000000001';
function stressRawMatch(i){
  const overtime=stressWorst&&stressCase!=='draws'&&i%5===0,draw=stressCase==='draws'||stressWorst&&i%5===2;
  const myRounds=overtime?26:draw?14:i%2?8:13,enemyRounds=overtime?24:draw?14:i%2?13:7;
  const rounds=myRounds+enemyRounds;
  const players=stressNames.map((name,j)=>({
    name:stressWorst&&i%5===3&&j===9?undefined:name,
    tag:stressWorst&&i%5===3&&j===9?undefined:stressWorst?'WWWWW':'EUW',
    puuid:j===0?stressPuuid:'00000000-0000-4000-8000-'+String(j+1).padStart(12,'0'),
    team_id:j<5?'Red':'Blue',party_id:j<(stressWorst?(i%5===4?5:i%5===0?3:i%5===2?1:2):2)?'fixture-party':'solo-'+j,
    tier:{id:stressWorst&&i%5===3?0:stressWorst?(j===0?27:26):18,patched:stressWorst&&i%5===3?'Unranked':stressWorst?(j===0?'Radiant':'Immortal 3'):'Diamond 1'},
    stats:stressWorst&&i%5===3&&j===0?{}:{kills:j===0&&overtime?72:j===0&&stressWorst&&i%5===1?0:18-j,deaths:j===0&&stressWorst&&i%5===1?0:12+j,assists:8,score:(j===0&&overtime?450:stressWorst&&i%5===2&&j===5?480:stressWorst&&i%5===4&&j===1?480:240-j*12)*rounds,rounds_played:rounds,damage:{dealt:(j===0&&overtime?300:160)*rounds},shots:{head:30,body:60,leg:10}},
    performance:{score:stressWorst&&i%5===3?null:230-j*10}
  }));
  const matchId='fixture-'+i;
  if(!(stressWorst&&i%5===3)){
    _rrChangeByMatchId[matchId]=draw?0:myRounds>enemyRounds?35:-30;
    _preRRByMatchId[matchId]=stressWorst?2100+1100+i*5:1550+i*5;
    _postRRByMatchId[matchId]=_preRRByMatchId[matchId]+_rrChangeByMatchId[matchId];
    _preTierByMatchId[matchId]=stressWorst?27:18;_postTierByMatchId[matchId]=stressWorst?27:18;
    _derankProtectedByMatchId[matchId]=stressWorst&&i%5===1;
    if(i%5!==4){
      _rrDetailsByMatchId[matchId]=parseRRDetails({
        rr_performance_bonus:i%2?0:5,afk_penalty:i%5===1?3:0,rr_penalty:i%5===1?.25:0,
        new_map_incentive_rr_forgiven:i%5===1?5:0,is_placement_match:i===2,
        was_derank_protection_replenished:i===0,queue_id:'competitive',
        tier_before_update:{id:stressWorst?27:3+Math.floor(_preRRByMatchId[matchId]/100)},
        rr_before_update:stressWorst?_preRRByMatchId[matchId]-2100:_preRRByMatchId[matchId]%100,
        tier:{id:stressWorst?27:3+Math.floor(_postRRByMatchId[matchId]/100)},
        rr:stressWorst?_postRRByMatchId[matchId]-2100:_postRRByMatchId[matchId]%100,
      });
    }
  }
  return{metadata:{match_id:matchId,map:{name:['Abyss','Ascent','Sunset','Lotus','Breeze'][i%5]},cluster:stressWorst?'Singapore':'Frankfurt',started_at:new Date(Date.UTC(2026,9,9,22,30)-i*7200000).toISOString(),game_length_in_ms:(overtime?105:35)*60000,season:{short:'e10a6',id:'fixture-act'}},players,teams:[{team_id:'Red',rounds:{won:myRounds}},{team_id:'Blue',rounds:{won:enemyRounds}}]};
}
// Avoid production account requests and URL rewrites; all navigation stays local.
apiGet=async()=>{throw new Error('Live API disabled in fixture preview');};
writePlayerRoute=()=>{};
loadMatchMapMetadata=()=>Promise.resolve(new Map());
function stressPreserveLinks(){
  document.querySelectorAll('a[href^="/"]').forEach(link=>{
    const url=new URL(link.getAttribute('href'),location.origin);url.searchParams.set('data',stressCase);
    link.setAttribute('href',url.pathname+url.search+url.hash);
  });
}
const stressApplyPage=applyPage;
applyPage=function(...args){stressApplyPage(...args);stressPreserveLinks();};
loadPlayerFromRoute=function(){
  PLAYER=stressNames[0];TAG=stressWorst?'WWWWW':'EUW';PUUID=stressPuuid;TARGET_SEASON='fixture-act';
  document.getElementById('m-nametag').value=PLAYER+'#'+TAG;
  document.body.classList.add('has-analysis');
  document.getElementById('results-section').style.display='block';
  finalizeHeader({tier:{id:stressWorst?27:18,name:stressWorst?'Radiant':'Diamond 1'},rr:stressWorst?1284:50});
  let count=['empty','loading','error'].includes(stressCase)?0:stressCase==='one'?1:/^\d+$/.test(stressCase)?Number(stressCase):stressWorst?30:12;
  const started=performance.now();
  allMatches=Array.from({length:count},(_,i)=>processMatch(stressRawMatch(i)));
  setSeasonMatchCount(TARGET_SEASON,count,'found');showSeasonSelect();
  nameHistoryState='ready';nameHistoryRows=stressCase==='empty'?[]:stressNames.map((name,i)=>({name,tag:TAG,first_seen:stressCase==='malformed'&&i===3?null:new Date(Date.UTC(2026,8,1+i)).toISOString(),last_seen:new Date(Date.UTC(2026,9,1+i)).toISOString(),ended_at:i?new Date(Date.UTC(2026,9,1+i)).toISOString():null}));
  renderNameHistory();renderAll();updateDetailPages();stressPreserveLinks();
  if(stressCase==='loading'){allMatches=[];analysisState='loading';setStatus('Loading rank and acts…',true);updateDetailPages();}
  if(stressCase==='error'){allMatches=[];analysisState='error';setStatus('');document.getElementById('error-container').innerHTML='<div class="error-box">Error: Fixture API unavailable</div>';updateDetailPages();}
  const duration=performance.now()-started;
  document.documentElement.dataset.stressRenderMs=String(Math.round(duration));
  // Inspection is explicit and reports geometry only; no product CSS is changed.
  window.stressAudit=()=>({data:stressCase,page:activePage,width:innerWidth,renderMs:Math.round(duration),matches:allMatches.length,renderedCards:document.querySelectorAll('.match-card').length,scrollWidth:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,overflow:[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&(r.right>innerWidth+1||r.left< -1)&&getComputedStyle(el).position!=='fixed';}).slice(0,30).map(el=>({tag:el.tagName,id:el.id,cls:el.className,text:el.textContent.slice(0,60)}))});
};
