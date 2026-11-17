// Held-out check of the RR payout even point (docs/rr-even-point.md).
// Usage: node scripts/rr-even-point-holdout.mjs <dir>, where <dir> holds cr0.json … cr9.json:
// `wrangler d1 execute vlravg-calib --remote --json` results of
//   SELECT puuid, json_extract(data,'$.season.short') AS s, json_extract(data,'$.elo') AS elo,
//     json_extract(data,'$.rr') AS rr, json_extract(data,'$.tier.id') AS tier,
//     json_extract(data,'$.last_change') AS ch, json_extract(data,'$.is_placement_match') AS pl, date
//   FROM rr_history WHERE puuid IN (<40 players>) AND date>='2026-10-01' ORDER BY puuid,date
// for players with 50+ rr_history rows since 2026-10-15. Fits the even point on every other
// game of a player's act and measures the win−loss payout gap on the remaining games.
import {readFileSync} from 'node:fs';
const S=process.argv[2];if(!S){console.error("usage: node scripts/rr-even-point-holdout.mjs <dir>");process.exit(1);}
const rows=[];for(let i=0;i<10;i++){try{const j=JSON.parse(readFileSync(`${S}/cr${i}.json`));rows.push(...j[0].results);}catch(e){console.log('bad',i);}}
const by=new Map();for(const r of rows){(by.get(r.puuid)??by.set(r.puuid,[]).get(r.puuid)).push(r);}
const total=r=>r.tier>=24&&Number.isFinite(r.rr)?2100+r.rr:r.elo;
const fit=pts=>{const n=pts.length;if(n<3)return null;const mx=pts.reduce((s,p)=>s+p[0],0)/n,my=pts.reduce((s,p)=>s+p[1],0)/n;
  const sxx=pts.reduce((s,p)=>s+(p[0]-mx)**2,0);if(!sxx)return null;const sxy=pts.reduce((s,p)=>s+(p[0]-mx)*(p[1]-my),0);
  const m=sxy/sxx,b=my-m*mx,res=pts.reduce((s,p)=>s+(p[1]-(m*p[0]+b))**2,0);return{n,m,b,se:Math.sqrt(res/Math.max(1,n-2)/sxx)};};
const detect=(pts,T)=>{const W=fit(pts.filter(p=>p[1]>0)),L=fit(pts.filter(p=>p[1]<0).map(p=>[p[0],-p[1]]));
  if(!W||!L||W.n<8||L.n<8)return null;const dm=W.m-L.m,t=dm/Math.hypot(W.se,L.se);if(!(t<=-T))return null;
  const x=(L.b-W.b)/dm,xs=pts.map(p=>p[0]);if(x<Math.min(...xs)||x>Math.max(...xs))return null;return{x,t,W,L};};
const av=a=>a.reduce((s,v)=>s+v,0)/a.length;
for(const T of [2,3,4]){
  let players=0,fired=0,near=[],far=[],nearN=0;
  for(const [p,rs] of by){
    const e=rs.filter(r=>r.s==='e11a6'&&!r.pl&&Number.isFinite(r.ch)&&r.ch!==0&&r.tier>=3);
    if(e.length<30)continue;players++;
    const pts=e.map(r=>[total(r)-r.ch,r.ch]);
    if(detect(pts,T))fired++;
    // held-out: fit on even indexes, test odd
    const d=detect(pts.filter((_,i)=>i%2===0),T);if(!d)continue;
    const test=pts.filter((_,i)=>i%2===1);
    const gapAt=(lo,hi)=>{const s=test.filter(q=>q[0]>=lo&&q[0]<hi);const w=s.filter(q=>q[1]>0).map(q=>q[1]),l=s.filter(q=>q[1]<0).map(q=>-q[1]);return w.length>=2&&l.length>=2?av(w)-av(l):null;};
    const g=gapAt(d.x-40,d.x+40);if(g!=null){near.push(g);nearN++;}
    const gLow=gapAt(-1e9,d.x-80),gHigh=gapAt(d.x+80,1e9);if(gLow!=null)far.push(['below',gLow]);if(gHigh!=null)far.push(['above',gHigh]);
  }
  const below=far.filter(f=>f[0]==='below').map(f=>f[1]),above=far.filter(f=>f[0]==='above').map(f=>f[1]);
  const med=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[s.length>>1]:NaN;};
  console.log(`t<=-${T}: players ${players}, even point shown for ${fired} (${(fired/players*100).toFixed(0)}%). Held-out (fit on half, test other half): near ±40 n=${near.length} median win-loss gap ${med(near).toFixed(1)}, mean |gap| ${av(near.map(Math.abs)).toFixed(1)}; >80 below: n=${below.length} median ${med(below).toFixed(1)}; >80 above: n=${above.length} median ${med(above).toFixed(1)}`);
}
