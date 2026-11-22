// Dev-only synthetic data, ported from scripts/ui-stress-fixtures.js. Fixtures
// enter processMatch as v4 API-shaped matches; no API request is made.
// Open http://localhost:5173/?fixture=demo (or worst, draws, malformed, one,
// empty, loading, error, climb (Immortal 1 to Radiant over 106 games), or a
// match count such as 120).
import {loadFixtureAnalysis} from '@/engine/core.mjs';

export function loadFixture(stressCase='demo'){
  const climb=stressCase==='climb';
  const demo=stressCase==='demo';
  const stressWorst=!demo&&!climb;
  // demo: lobbies spread from Platinum 3 to Ascendant 1 around the player's Diamond 1.
  const demoLobbyTier=(i,j)=>Math.max(3,18+[0,-1,1,0,2,-2,1,0,-1,3,0,1][i%12]+[0,1,-1,0,1,-1,0,2,-2,0][j]);
  const stressNames=stressWorst?['WWWWWWWWWWWWWWWW','#unused','Đặng Ngọc Hân','王秀英','نور الهدى','Priya','Jax','Joy','Seán','Mia']:['Player','Duo','Alex','Sam','Joy','Enemy','Sky','Lee','Mia','Kai'];
  stressNames[1]=stressWorst?'KonstantinWWWWW':'Duo';
  if(stressCase==='malformed'){stressNames[5]='👩🏽‍💻 Priya';stressNames[6]='J';stressNames[7]='Jo';stressNames[9]='A&B <3';}
  const stressPuuid='00000000-0000-4000-8000-000000000001';
  const tag=stressWorst?'WWWWW':'EUW';
  const rr={change:{},pre:{},post:{},preTier:{},postTier:{},protected:{},details:{}};
  // climb: index 0 is the newest match; the oldest starts at Immortal 1, 0 RR.
  const climbCount=106,climbWon=i=>(i*7)%3!==0||i%11===0;
  // Payouts drift like a real climb: gains shrink from about +26 to +16 and
  // losses grow from about −12 to −20 (oldest to newest), with a little jitter.
  const climbDelta=i=>{
    const p=(climbCount-1-i)/(climbCount-1),jitter=(i*37)%7-3;
    return climbWon(i)?Math.round(26-10*p+jitter):-Math.round(12+8*p+jitter);
  };
  const climbPre=[];
  for(let i=climbCount-1,elo=2100;i>=0;i--){climbPre[i]=elo;elo+=climbDelta(i);}
  const climbTier=elo=>elo<2190?24:elo<2310?25:elo<2560?26:27;
  // demo and climb: round-by-round kills and plants with a few clutch rounds
  // per match, for the Clutches page and the Overview clutch card. Red (the
  // searched player's team) attacks rounds 1–12. Agents avoid Sage and Clove
  // so no revive logic applies.
  const clutchAgents=['Jett','Omen','Sova','Killjoy','Raze','Breach','Cypher','Reyna','Skye','Viper'];
  function clutchRounds(i,players,myRounds,enemyRounds){
    const total=myRounds+enemyRounds,red=players.slice(0,5),blue=players.slice(5);
    const order=Array.from({length:total},(_,r)=>r).sort((a,b)=>(a*7919+i*31)%total-(b*7919+i*31)%total);
    const winners=[];order.forEach((r,n)=>{winners[r]=n<myRounds?'Red':'Blue';});
    const ref=(p,team)=>({puuid:p.puuid,name:p.name,tag:p.tag,team});
    const rounds=[],kills=[];
    for(let r=0;r<total;r++){
      const attack=r<12||r>=24&&r%2===0?'Red':'Blue';
      const round={winning_team:winners[r],result:'Elimination',plant:null,defuse:null,
        stats:players.map((p,j)=>({player:ref(p,j<5?'Red':'Blue'),received_penalty:false,was_afk:false}))};
      const kill=(t,killer,killerTeam,victim,victimTeam)=>kills.push({round:r,time_in_round_in_ms:t,killer:ref(killer,killerTeam),victim:ref(victim,victimTeam)});
      if((r+i)%3===0){
        const type=(r+i)%13===0?5:1+(r*7+i)%4;
        const alive=blue.slice(5-type);
        blue.slice(0,5-type).forEach((enemy,n)=>kill(10000+n*1000,red[1+n%4],'Red',enemy,'Blue'));
        red.slice(1).forEach((mate,n)=>kill(30000+n*1000,alive[0],'Blue',mate,'Red'));
        // Spike down before the clutch began (25s) or after it (40s).
        if(r%4===0)round.plant={round_time_in_ms:attack==='Red'?40000:25000,player:ref(attack==='Red'?red[0]:alive[0],attack)};
        if(r%4===2)round.plant={round_time_in_ms:25000,player:ref(attack==='Red'?red[1]:alive[0],attack)};
        if(winners[r]==='Red')alive.forEach((enemy,n)=>kill(45000+n*1500,red[0],'Red',enemy,'Blue'));
        else if(r%2){if(type>1)kill(45000,red[0],'Red',alive[1],'Blue');kill(50000,alive[0],'Blue',red[0],'Red');}
      }else{
        const losers=winners[r]==='Red'?blue:red,team=winners[r]==='Red'?'Blue':'Red',side=winners[r]==='Red'?red:blue;
        losers.forEach((victim,n)=>kill(12000+n*2000,side[n%5],winners[r],victim,team));
      }
      rounds.push(round);
    }
    return{rounds,kills};
  }
  function stressRawMatch(i){
    const overtime=stressWorst&&stressCase!=='draws'&&i%5===0,draw=stressCase==='draws'||stressWorst&&i%5===2;
    const lost=climb?!climbWon(i):i%2;
    const myRounds=overtime?26:draw?14:lost?8:13,enemyRounds=overtime?24:draw?14:lost?13:7;
    const rounds=myRounds+enemyRounds;
    const players=stressNames.map((name,j)=>({
      name:stressWorst&&i%5===3&&j===9?undefined:name,
      tag:stressWorst&&i%5===3&&j===9?undefined:tag,
      puuid:j===0?stressPuuid:'00000000-0000-4000-8000-'+String(j+1).padStart(12,'0'),
      team_id:j<5?'Red':'Blue',party_id:j<(stressWorst?(i%5===4?5:i%5===0?3:i%5===2?1:2):demo?[2,1,2,3][i%4]:2)?'fixture-party':'solo-'+j,
      tier:stressWorst&&i%5===3?{id:0,patched:'Unranked'}:stressWorst?{id:j===0?27:26,patched:j===0?'Radiant':'Immortal 3'}
        :{id:demo&&j?demoLobbyTier(i,j):18,patched:demo&&j?undefined:'Diamond 1'},
      stats:stressWorst&&i%5===3&&j===0?{}:{kills:j===0&&overtime?72:j===0&&stressWorst&&i%5===1?0:18-j,deaths:j===0&&stressWorst&&i%5===1?0:12+j,assists:8,score:(j===0&&overtime?450:stressWorst&&i%5===2&&j===5?480:stressWorst&&i%5===4&&j===1?480:240-j*12)*rounds,rounds_played:rounds,damage:{dealt:(j===0&&overtime?300:160)*rounds},shots:{head:30,body:60,leg:10}},
      performance:{score:stressWorst&&i%5===3?null:230-j*10},
      agent:{name:clutchAgents[(j+i%4)%clutchAgents.length]},
    }));
    const matchId='fixture-'+i;
    if(!(stressWorst&&i%5===3)){
      rr.change[matchId]=climb?climbDelta(i):draw?0:myRounds>enemyRounds?35:-30;
      rr.pre[matchId]=climb?climbPre[i]:stressWorst?2100+1100+i*5:1550+i*5;
      rr.protected[matchId]=stressWorst&&i%5===1&&rr.change[matchId]<0;
      rr.post[matchId]=rr.pre[matchId]+(rr.protected[matchId]?0:rr.change[matchId]);
      rr.preTier[matchId]=climb?climbTier(rr.pre[matchId]):stressWorst?27:18;
      rr.postTier[matchId]=climb?climbTier(rr.post[matchId]):stressWorst?27:18;
      if(i%5!==4){
        rr.details[matchId]={
          rr_performance_bonus:i%2?0:5,afk_penalty:i%5===1?3:0,rr_penalty:i%5===1?.25:0,
          new_map_incentive_rr_forgiven:i%5===1?5:0,is_placement_match:i===2,
          was_derank_protection_replenished:i===0,queue_id:'competitive',
          tier_before_update:{id:climb?rr.preTier[matchId]:stressWorst?27:3+Math.floor(rr.pre[matchId]/100)},
          rr_before_update:climb||stressWorst?rr.pre[matchId]-2100:rr.pre[matchId]%100,
          tier:{id:climb?rr.postTier[matchId]:stressWorst?27:3+Math.floor(rr.post[matchId]/100)},
          rr:climb||stressWorst?rr.post[matchId]-2100:rr.post[matchId]%100,
        };
      }
    }
    const roundData=demo||climb?clutchRounds(i,players,myRounds,enemyRounds):{};
    return{...roundData,metadata:{match_id:matchId,map:{name:['Abyss','Ascent','Sunset','Lotus','Breeze'][i%5]},cluster:stressWorst?'Singapore':'Frankfurt',started_at:new Date(Date.UTC(2026,10,15,22,30)-i*(climb?27000000:7200000)).toISOString(),game_length_in_ms:(overtime?105:35)*60000,season:{short:'e10a6',id:'fixture-act'}},players,teams:[{team_id:'Red',rounds:{won:myRounds}},{team_id:'Blue',rounds:{won:enemyRounds}}]};
  }
  const count=['empty','loading','error'].includes(stressCase)?0:stressCase==='one'?1:climb?climbCount:/^\d+$/.test(stressCase)?Number(stressCase):stressWorst?30:12;
  const raw=Array.from({length:count},(_,i)=>stressRawMatch(i));
  const names=stressCase==='empty'?[]:stressNames.map((name,i)=>({name,tag,first_seen:stressCase==='malformed'&&i===3?null:new Date(Date.UTC(2026,8,1+i)).toISOString(),last_seen:new Date(Date.UTC(2026,9,1+i)).toISOString(),ended_at:i?new Date(Date.UTC(2026,9,1+i)).toISOString():null}));
  loadFixtureAnalysis({
    player:stressNames[0],tag,puuid:stressPuuid,season:'fixture-act',
    current:climb?{tier:{id:27,name:'Radiant'},rr:climbPre[0]+climbDelta(0)-2100}:{tier:{id:stressWorst?27:18,name:stressWorst?'Radiant':'Diamond 1'},rr:stressWorst?1284:50},
    rr,raw,names,mode:stressCase,
  });
}
