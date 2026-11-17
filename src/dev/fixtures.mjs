// Dev-only synthetic data, ported from scripts/ui-stress-fixtures.js. Fixtures
// enter processMatch as v4 API-shaped matches; no API request is made.
// Open http://localhost:5173/?fixture=demo (or worst, draws, malformed, one,
// empty, loading, error, or a match count such as 120).
import {loadFixtureAnalysis} from '@/engine/core.mjs';

export function loadFixture(stressCase='demo'){
  const stressWorst=stressCase!=='demo';
  const stressNames=stressWorst?['WWWWWWWWWWWWWWWW','#unused','Đặng Ngọc Hân','王秀英','نور الهدى','Priya','Jax','Joy','Seán','Mia']:['Player','Duo','Alex','Sam','Joy','Enemy','Sky','Lee','Mia','Kai'];
  stressNames[1]=stressWorst?'KonstantinWWWWW':'Duo';
  if(stressCase==='malformed'){stressNames[5]='👩🏽‍💻 Priya';stressNames[6]='J';stressNames[7]='Jo';stressNames[9]='A&B <3';}
  const stressPuuid='00000000-0000-4000-8000-000000000001';
  const tag=stressWorst?'WWWWW':'EUW';
  const rr={change:{},pre:{},post:{},preTier:{},postTier:{},protected:{},details:{}};
  function stressRawMatch(i){
    const overtime=stressWorst&&stressCase!=='draws'&&i%5===0,draw=stressCase==='draws'||stressWorst&&i%5===2;
    const myRounds=overtime?26:draw?14:i%2?8:13,enemyRounds=overtime?24:draw?14:i%2?13:7;
    const rounds=myRounds+enemyRounds;
    const players=stressNames.map((name,j)=>({
      name:stressWorst&&i%5===3&&j===9?undefined:name,
      tag:stressWorst&&i%5===3&&j===9?undefined:tag,
      puuid:j===0?stressPuuid:'00000000-0000-4000-8000-'+String(j+1).padStart(12,'0'),
      team_id:j<5?'Red':'Blue',party_id:j<(stressWorst?(i%5===4?5:i%5===0?3:i%5===2?1:2):2)?'fixture-party':'solo-'+j,
      tier:{id:stressWorst&&i%5===3?0:stressWorst?(j===0?27:26):18,patched:stressWorst&&i%5===3?'Unranked':stressWorst?(j===0?'Radiant':'Immortal 3'):'Diamond 1'},
      stats:stressWorst&&i%5===3&&j===0?{}:{kills:j===0&&overtime?72:j===0&&stressWorst&&i%5===1?0:18-j,deaths:j===0&&stressWorst&&i%5===1?0:12+j,assists:8,score:(j===0&&overtime?450:stressWorst&&i%5===2&&j===5?480:stressWorst&&i%5===4&&j===1?480:240-j*12)*rounds,rounds_played:rounds,damage:{dealt:(j===0&&overtime?300:160)*rounds},shots:{head:30,body:60,leg:10}},
      performance:{score:stressWorst&&i%5===3?null:230-j*10},
    }));
    const matchId='fixture-'+i;
    if(!(stressWorst&&i%5===3)){
      rr.change[matchId]=draw?0:myRounds>enemyRounds?35:-30;
      rr.pre[matchId]=stressWorst?2100+1100+i*5:1550+i*5;
      rr.protected[matchId]=stressWorst&&i%5===1&&rr.change[matchId]<0;
      rr.post[matchId]=rr.pre[matchId]+(rr.protected[matchId]?0:rr.change[matchId]);
      rr.preTier[matchId]=stressWorst?27:18;rr.postTier[matchId]=stressWorst?27:18;
      if(i%5!==4){
        rr.details[matchId]={
          rr_performance_bonus:i%2?0:5,afk_penalty:i%5===1?3:0,rr_penalty:i%5===1?.25:0,
          new_map_incentive_rr_forgiven:i%5===1?5:0,is_placement_match:i===2,
          was_derank_protection_replenished:i===0,queue_id:'competitive',
          tier_before_update:{id:stressWorst?27:3+Math.floor(rr.pre[matchId]/100)},
          rr_before_update:stressWorst?rr.pre[matchId]-2100:rr.pre[matchId]%100,
          tier:{id:stressWorst?27:3+Math.floor(rr.post[matchId]/100)},
          rr:stressWorst?rr.post[matchId]-2100:rr.post[matchId]%100,
        };
      }
    }
    return{metadata:{match_id:matchId,map:{name:['Abyss','Ascent','Sunset','Lotus','Breeze'][i%5]},cluster:stressWorst?'Singapore':'Frankfurt',started_at:new Date(Date.UTC(2026,9,9,22,30)-i*7200000).toISOString(),game_length_in_ms:(overtime?105:35)*60000,season:{short:'e10a6',id:'fixture-act'}},players,teams:[{team_id:'Red',rounds:{won:myRounds}},{team_id:'Blue',rounds:{won:enemyRounds}}]};
  }
  const count=['empty','loading','error'].includes(stressCase)?0:stressCase==='one'?1:/^\d+$/.test(stressCase)?Number(stressCase):stressWorst?30:12;
  const raw=Array.from({length:count},(_,i)=>stressRawMatch(i));
  const names=stressCase==='empty'?[]:stressNames.map((name,i)=>({name,tag,first_seen:stressCase==='malformed'&&i===3?null:new Date(Date.UTC(2026,8,1+i)).toISOString(),last_seen:new Date(Date.UTC(2026,9,1+i)).toISOString(),ended_at:i?new Date(Date.UTC(2026,9,1+i)).toISOString():null}));
  loadFixtureAnalysis({
    player:stressNames[0],tag,puuid:stressPuuid,season:'fixture-act',
    current:{tier:{id:stressWorst?27:18,name:stressWorst?'Radiant':'Diamond 1'},rr:stressWorst?1284:50},
    rr,raw,names,mode:stressCase,
  });
}
