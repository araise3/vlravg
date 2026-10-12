import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const dir=new URL('./',import.meta.url);
const puuid='5ae2603f-6a31-5a1e-9ca0-67b51f9301d9';
const season='8102cd81-43a0-d0d7-bd59-47b8fe9bed1b';
let cursor=0;const matches=[];
while(cursor!=null){
  const file=new URL(`archive-${cursor}.json`,dir);
  let j;
  if(existsSync(file))j=JSON.parse(readFileSync(file));
  else{
    const r=await fetch(`https://vlravg.com/api/match-archive/${puuid}/${season}?start=${cursor}&size=50`);
    if(!r.ok)throw new Error(`Archive ${cursor}: ${r.status}`);
    j=await r.json();writeFileSync(file,JSON.stringify(j));
  }
  matches.push(...j.data);cursor=j.nextStart;
}
const history=JSON.parse(readFileSync(new URL('mmr-history.json',dir))).data.history.sort((a,b)=>new Date(a.date)-new Date(b.date));
const byId=new Map();let prev=null;
const total=h=>h.tier.id>=24?2100+h.rr:h.elo;
for(const h of history){
  byId.set(h.match_id,{myRR:h.last_change,myPreRR:prev&&prev.season.short===h.season.short?total(prev):total(h)-(h.was_derank_protected&&h.last_change<0?0:h.last_change)-(h.refunded_rr||0),myPreTierId:prev?.tier.id??h.tier.id});prev=h;
}
const parsed=matches.map(m=>{
  const me=m.players.find(p=>p.puuid===puuid);
  return{...byId.get(m.metadata.match_id),matchId:m.metadata.match_id,myTierId:me.tier.id,
    partySize:me.party_id?m.players.filter(p=>p.team_id===me.team_id&&p.party_id===me.party_id).length:1,
    won:m.teams.find(t=>t.team_id===me.team_id).won};
});
const html=readFileSync(new URL('../../index.html',dir),'utf8');
const source=html.slice(html.indexOf('function rrPositionFromElo('),html.indexOf('function renderRRMovement('));
const funcs=runInNewContext(source+'\n({rrMovementRows,rrPayoutEstimates,rrPayoutSegments})',{
  avgLabelShort:()=>'',isRREligible:m=>m.myRR!=null&&m.myTierId>=3&&!m.actPlacement&&(m.partySize||1)<5,
});
const rows=funcs.rrMovementRows(parsed).map(r=>({...r,axisRR:r.m.myPreRR}));
const report={archived:matches.length,rrHistory:history.length,covered:rows.length};
for(const won of [true,false]){
  const estimates=funcs.rrPayoutEstimates(rows,rows,won);
  report[won?'wins':'losses']={
    segments:funcs.rrPayoutSegments(estimates).map(s=>({from:s[0].position-2100,to:s.at(-1).position-2100})),
    sparse:estimates.filter(p=>p.payout==null&&p.position>=2400).map(p=>({rr:p.position-2100,n:p.n})),
    matches:rows.filter(r=>r.m.won===won&&r.m.myPreRR>=2400).map(r=>({rr:r.m.myPreRR-2100,payout:r.net})).sort((a,b)=>a.rr-b.rr),
  };
}
writeFileSync(new URL('report.json',dir),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
