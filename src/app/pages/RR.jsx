import {Fragment,useId,useState} from 'react';
import {
  avgLabel,avgLabelShort,buildRRScoreRows,computeRRStats,rrDuoInfo,rrMovementRows,rrMovementXAxis,
  RR_MARGIN_REFERENCE,rrPayoutEstimates,rrPayoutEvenPoint,rrPayoutSegments,rrPositionFromElo,rrRankRows,rrReportedStats,rrAdjustmentStats,rrDodgesInRange,rrSessionRows,RR_SESSION_BREAK_MS,rrScopedMatches,rrSigned,
  scoreMarginDistribution,setRRMovementZoomTier,setRRRange,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {RANK_ICONS} from '@/engine/rank-icons.mjs';
import {useElementWidth,useEngine,useIsMobile} from '@/app/hooks.js';
import {ChartFrame,ChartTooltip,EmptyState,Hint,PageHeading,PlacementToggle,RankIcon,SortableTable,TableSection,toneClass} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Card,CardAction,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';

const toneOf=tone=>tone==='rank-positive'?'text-positive':tone==='rank-negative'?'text-negative':'';

/* ── RR trend ─────────────────────────────────────────────── */
// Rank bands from the recorded tiers. Below Immortal every division spans 100
// RR. Immortal+ RR is one continuous leaderboard number, so the Immortal 2/3 and
// Radiant floors sit between the highest game recorded below that tier and the
// lowest game recorded at or above it (a visual guide; tooltips use each
// match's own recorded tier). A tier never recorded gets no band.
export function rrTrendRankBands(points,min,max){
  const high=points.filter(p=>p.value>=2100&&p.match.myPostTierId>=24&&p.match.myPostTierId<=27);
  const baseTier=high.length?Math.min(...high.map(p=>p.match.myPostTierId)):24;
  const floors=[];
  for(let tier=baseTier+1;tier<=27;tier++){
    if(!high.some(p=>p.match.myPostTierId===tier))continue;
    const above=high.filter(p=>p.match.myPostTierId>=tier).map(p=>p.value);
    const lowest=Math.min(...above);
    const below=high.filter(p=>p.match.myPostTierId<tier&&p.value<lowest).map(p=>p.value);
    const floor=below.length?(Math.max(...below)+lowest)/2:lowest;
    if(floor>(floors.at(-1)?.value??2100))floors.push({tier,value:floor});
  }
  const tierAt=value=>{
    if(value<2100)return rrPositionFromElo(value).tier;
    return floors.reduce((tier,floor)=>value>=floor.value?floor.tier:tier,baseTier);
  };
  const edges=new Set([min,max]);
  for(let value=Math.ceil(min/100)*100;value<max&&value<=2100;value+=100)edges.add(value);
  floors.forEach(floor=>{if(floor.value>min&&floor.value<max)edges.add(floor.value);});
  const sorted=[...edges].sort((a,b)=>a-b),bands=[];
  for(let i=0;i<sorted.length-1;i++){
    const start=sorted[i],end=sorted[i+1],tier=tierAt((start+end)/2),previous=bands.at(-1);
    if(previous?.tier===tier)previous.end=end;
    else bands.push({start,end,tier});
  }
  return bands;
}

// Evenly spaced match indices for the date axis, one label per day at most.
export function rrTrendDateTicks(points,plotWidth,minGap,dateLabel){
  if(points.length<2)return[{i:0,label:dateLabel(points[0].match),anchor:'middle'}];
  const count=Math.max(2,Math.min(points.length,Math.floor(plotWidth/minGap)+1));
  const ticks=[];
  for(let k=0;k<count;k++){
    const i=Math.round(k*(points.length-1)/(count-1)),label=dateLabel(points[i].match);
    if(ticks.at(-1)?.label===label)continue;
    ticks.push({i,label});
  }
  return ticks.map((tick,k)=>({...tick,anchor:k===0?'start':tick.i===points.length-1?'end':'middle'}));
}

// One dot per match while they stay apart; dense ranges show the line alone.
function showDotsFor(spacing){return spacing>=8;}

// The end label (right-aligned to the last point) takes the nearest spot whose
// box the line and its dots stay clear of: above, left of, then below the end
// point, then further up or down in 4px steps. The old check tested the bare
// line only and fell back to "above" when that was blocked, so a label could
// sit on a nearby peak's dots (22 Nov 2026, on request). `ys` are the points'
// plotted y values; `x(i)` places point i. Text boxes run from 13px above the
// baseline to 4px below it; the line, the dots and the label's halo add `pad`.
export function placeEndLabel({ys,x,left,top,bottom,textWidth,dotRadius=0}){
  const last=ys.length-1,ex=x(last),ey=ys[last];
  const clampY=value=>Math.max(top+2,Math.min(bottom-4,value));
  if(last<1)return{x:ex,y:clampY(ey-12)};
  const spacing=(x(last)-x(0))/last,pad=Math.max(3,dotRadius+3);
  const lineYAt=px=>{
    if(px<=x(0))return ys[0];
    if(px>=ex)return ey;
    const at=(px-x(0))/spacing,i=Math.floor(at);
    return ys[i]+(ys[i+1]-ys[i])*(at-i);
  };
  const hits=spot=>{
    const boxTop=spot.y-13-pad,boxBottom=spot.y+4+pad;
    let count=0;
    for(let px=Math.max(left,spot.x-textWidth-pad);px<=spot.x+pad;px+=2){const ly=lineYAt(px);if(ly>=boxTop&&ly<=boxBottom)count++;}
    return count;
  };
  // Further spots go by how far the box's middle (4.5px above the baseline)
  // moves from the end point, so the label stays as close as it can.
  const further=[];
  for(let d=4;ey-12-d>=top+2||ey+20+d<=bottom-4;d+=4){
    if(ey-12-d>=top+2)further.push({x:ex,y:ey-12-d});
    if(ey+20+d<=bottom-4)further.push({x:ex,y:ey+20+d});
  }
  further.sort((a,b)=>Math.abs(a.y-4.5-ey)-Math.abs(b.y-4.5-ey));
  const placed=[{x:ex,y:ey-12},{x:ex-10,y:ey+4},{x:ex,y:ey+20},...further].map(spot=>({...spot,y:clampY(spot.y)}));
  let best=null,bestHits=Infinity;
  for(const spot of placed){
    const count=hits(spot);
    if(count===0)return spot;
    if(count<bestHits){best=spot;bestHits=count;}
  }
  return best;
}

export function RRTrendChart({matches,range}){
  const [ref,measured]=useElementWidth();
  const [active,setActive]=useState(null);
  const fillId=`rr-trend-fill-${useId().replace(/[^\w-]/g,'')}`;
  const compact=useIsMobile();
  const showDuos=range!=='all';
  const scoped=rrScopedMatches(matches,range);
  const ordered=scoped.filter(m=>Number.isFinite(m.myRR)&&Number.isFinite(m.myPostRR)).sort((a,b)=>(a.startedAtMs||0)-(b.startedAtMs||0));
  if(!ordered.length)return <div ref={ref} className="py-10 text-center text-sm text-muted-foreground">No recorded rank and RR changes for matches in this act.</div>;
  const duoInfos=ordered.map(m=>showDuos?rrDuoInfo(m):null);
  const duoRuns=[],duoRunAt=[];
  for(let i=0;i<ordered.length;){
    const info=duoInfos[i];
    if(!info){i++;continue;}
    let end=i,net=ordered[i].myRR;
    while(end+1<ordered.length&&duoInfos[end+1]?.key===info.key){end++;net+=ordered[end].myRR;}
    if(end>i){
      const run={start:i,end,count:end-i+1,net,name:info.name};
      duoRuns.push(run);
      for(let j=i;j<=end;j++)duoRunAt[j]=run;
    }
    i=end+1;
  }
  const duoCount=duoInfos.filter(Boolean).length;
  const duoNet=ordered.reduce((sum,m,i)=>sum+(duoInfos[i]?m.myRR:0),0);
  const running=ordered.reduce((sum,m)=>sum+m.myRR,0);
  const points=ordered.map(m=>({match:m,value:m.myPostRR}));
  const values=points.map(p=>p.value);
  const low=Math.min(...values),high=Math.max(...values);
  // The axis spans the ranks played, padded to the nearest 50 RR.
  const min=Math.max(0,Math.floor((low-15)/50)*50),max=Math.max(min+50,Math.ceil((high+15)/50)*50);
  // Rank bands on the left, an Immortal+ RR scale on the right, dates below.
  const height=compact?240:290,top=22,bottom=height-26;
  const y=value=>bottom-(value-min)/(max-min)*(bottom-top);
  const rrStep=max>2100?[25,50,100,200,250,500,1000].find(step=>step*(bottom-top)/(max-min)>=(compact?30:36))??1000:null;
  const rrTicks=[];
  if(rrStep)for(let value=2100+Math.max(0,Math.ceil((min-2100)/rrStep))*rrStep;value<=max;value+=rrStep)if(value>=min)rrTicks.push(value);
  // Charts that reach Immortal+ drop the left rank column (21 Nov 2026, on
  // request): Immortal 1–3 are thin leaderboard bands and Radiant has no top,
  // so a big climb squeezed three labels at the bottom under one huge empty
  // Radiant band. Each rank threshold becomes an unlabelled dashed line; the
  // threshold labels and rank-up icons added with it were removed on request
  // (22 Nov 2026). Charts below Immortal keep their 100-RR bands.
  const thresholdMode=max>2100;
  const left=thresholdMode?(compact?8:12):(compact?58:72),right=rrTicks.length?(compact?32:44):(compact?10:16);
  const width=Math.max(left+right+2,measured||872),plotWidth=width-left-right;
  const x=i=>points.length===1?left+plotWidth/2:left+i*plotWidth/(points.length-1);
  const spacing=points.length>1?plotWidth/(points.length-1):plotWidth;
  const bands=rrTrendRankBands(points,min,max);
  const rankLines=bands.slice(1).map(band=>band.start);
  const line=points.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dateLabel=m=>Number.isFinite(m.startedAtMs)?new Date(m.startedAtMs).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'Date unavailable';
  const matchLabel=m=>[m.mapName??m.map,Number.isInteger(m.myR)&&Number.isInteger(m.opR)?`${m.myR}–${m.opR}`:null].filter(Boolean).join(', ');
  const dateTicks=rrTrendDateTicks(points,plotWidth,compact?76:104,dateLabel);
  const resultClass=m=>m.won===true?'win':m.won===false?'loss':'draw';
  const last=points.length-1,end=points[last],endRank=rrPositionFromElo(end.value,end.match.myPostTierId);
  const endText=`${avgLabelShort(endRank.tier)}, ${endRank.rr} RR`;
  const endLabel=placeEndLabel({ys:points.map(p=>y(p.value)),x,left,top,bottom,textWidth:endText.length*6.6,dotRadius:showDotsFor(spacing)?Math.max(3,Math.min(4,spacing/3)):0});
  // The range's peak gets its own label when it is clearly above the end and
  // far enough left of the end label not to collide with it.
  const peakIndex=values.lastIndexOf(high);
  const peak=peakIndex!==last&&high-end.value>=20&&x(last)-x(peakIndex)>(compact?130:160)
    ?{i:peakIndex,rank:rrPositionFromElo(high,points[peakIndex].match.myPostTierId)}:null;
  const showDots=showDotsFor(spacing);
  const tip=active!=null?(()=>{
    const {match,value}=points[active],rank=rrPositionFromElo(value,match.myPostTierId);
    const duo=duoInfos[active],run=duoRunAt[active];
    return{match,rank,duo,run,xx:x(active),yy:y(value)};
  })():null;
  const pointerMove=event=>{
    const bounds=event.currentTarget.getBoundingClientRect();
    const plotX=(event.clientX-bounds.left)*width/bounds.width;
    if(plotX<left-spacing/2||plotX>width-right+spacing/2){setActive(null);return;}
    setActive(points.length===1?0:Math.max(0,Math.min(points.length-1,Math.round((plotX-left)/spacing))));
  };
  return (
    <div ref={ref} className="relative" role="region" aria-label="RR trend across matches" tabIndex={0}>
      <svg className="chart-svg rr-trend-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        aria-label={`Rank and RR trend across ${points.length} matches, net ${rrSigned(running,0)} RR${duoCount?`; ${duoCount} duo games net ${rrSigned(duoNet,0)} RR`:''}`}
        onPointerMove={pointerMove} onPointerDown={pointerMove} onPointerLeave={()=>setActive(null)} style={{touchAction:'pan-y'}}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--series-1)" stopOpacity=".22"/>
            <stop offset="1" stopColor="var(--series-1)" stopOpacity="0"/>
          </linearGradient>
        </defs>
        {/* Every other rank band carries a faint wash so each rank reads as a range. */}
        {!thresholdMode&&bands.map(({start,end},index)=>(bands.length-1-index)%2===1&&(
          <rect key={`wash-${start}`} className="rank-band" x={left} y={y(end)} width={plotWidth} height={y(start)-y(end)} aria-hidden="true"/>
        ))}
        {!thresholdMode&&bands.map(({start,end,tier})=>{
          const bandTop=y(end),bandHeight=y(start)-bandTop;
          if(bandHeight<15)return null;
          const mid=bandTop+bandHeight/2;
          return (
            <g key={start} aria-hidden="true">
              {RANK_ICONS[tier]&&<image href={RANK_ICONS[tier]} x={4} y={mid-8} width={16} height={16}/>}
              <text x={24} y={mid+4} className="rank-tick">{avgLabelShort(tier)}</text>
            </g>
          );
        })}
        {rrTicks.map(value=>(
          <g key={`rr-${value}`} aria-hidden="true">
            <line className="grid minor" x1={left} y1={y(value)} x2={width-right} y2={y(value)}/>
            <text x={width-right+6} y={y(value)+4} className="rr-tick">{value-2100}</text>
          </g>
        ))}
        {rrTicks.length>0&&<text x={width-right+6} y={top-9} className="rr-tick unit" aria-hidden="true">RR</text>}
        {rankLines.map(value=><line key={value} className={cn('grid rank-line',thresholdMode&&'threshold')} x1={left} y1={y(value)} x2={width-right} y2={y(value)}/>)}
        <line className="baseline" x1={left} y1={bottom} x2={width-right} y2={bottom}/>
        {dateTicks.map(({i,label,anchor})=><text key={i} x={x(i)} y={bottom+17} textAnchor={anchor} aria-hidden="true">{label}</text>)}
        {duoRuns.map(run=>{
          const inset=Math.min(3,spacing/4);
          const start=Math.max(left,x(run.start)-spacing/2+inset),end=Math.min(width-right,x(run.end)+spacing/2-inset),bandWidth=end-start;
          if(run.count<3||bandWidth<35)return null;
          return <rect key={run.start} className="duo-band" x={start} y={top} width={bandWidth} height={bottom-top} aria-hidden="true"/>;
        })}
        {points.length>1&&<path d={`${line} L${x(points.length-1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`} fill={`url(#${fillId})`} aria-hidden="true"/>}
        {points.length>1&&<path className="line" d={line}/>}
        {showDots&&points.map(({match,value},i)=>(
          <circle key={i} className={`result-point ${resultClass(match)}`} cx={x(i)} cy={y(value)} r={Math.max(3,Math.min(4,spacing/3))} aria-hidden="true"/>
        ))}
        {peak&&!tip&&(
          <g aria-hidden="true">
            <circle className="peak-point" cx={x(peak.i)} cy={y(high)} r={3.5}/>
            <text x={x(peak.i)} y={Math.max(top+2,y(high)-10)} textAnchor="middle" className="peak-label">Peak {avgLabelShort(peak.rank.tier)}, {peak.rank.rr} RR</text>
          </g>
        )}
        {!tip&&(
          <g aria-hidden="true">
            <text x={points.length===1?x(last):endLabel.x} y={endLabel.y} textAnchor={points.length===1?'middle':'end'} className="ink-strong">{endText}</text>
          </g>
        )}
        {duoRuns.map(run=>{
          const inset=Math.min(3,spacing/4);
          const start=Math.max(left,x(run.start)-spacing/2+inset),end=Math.min(width-right,x(run.end)+spacing/2-inset),bandWidth=end-start;
          if(run.count<3||bandWidth<50)return null;
          const maxName=Math.max(3,Math.floor((bandWidth-10)/5));
          const name=run.name.length>maxName?run.name.slice(0,maxName-1)+'…':run.name;
          return (
            <g key={run.start} aria-hidden="true">
              <text className="duo-band-label" x={(start+end)/2} y={bottom-23}>{name}</text>
              <text className="duo-band-label" x={(start+end)/2} y={bottom-9}>{rrSigned(run.net,0)} RR</text>
            </g>
          );
        })}
        {tip&&(
          <g aria-hidden="true">
            <line className="hover-line" x1={tip.xx} y1={top} x2={tip.xx} y2={bottom}/>
            <circle className={`cursor-point ${resultClass(tip.match)}`} cx={tip.xx} cy={tip.yy} r={5}/>
          </g>
        )}
        {points.map(({match,value},i)=>{
          const rank=rrPositionFromElo(value,match.myPostTierId),duo=duoInfos[i],run=duoRunAt[i];
          const result=match.won===true?'Win':match.won===false?'Loss':'Draw';
          const label=`Match ${i+1} of ${points.length}, ${dateLabel(match)}, ${matchLabel(match)}, ${result}: ${avgLabel(rank.tier)}, ${rank.rr} RR after ${rrSigned(match.myRR,0)} RR change${duo?`; ${duo.label}${run?`, ${rrSigned(run.net,0)} RR across ${run.count} games`:''}`:''}`;
          return (
            <g key={i} tabIndex={0} aria-label={label} onFocus={()=>setActive(i)} onBlur={()=>setActive(null)}>
              <circle cx={x(i)} cy={y(value)} r={Math.min(11,Math.max(3,spacing/2))} fill="transparent"/>
            </g>
          );
        })}
      </svg>
      {tip&&(
        <ChartTooltip x={tip.xx} y={Math.max(0,tip.yy-40)} width={width}>
          <div className={cn('tt-value',toneClass(tip.match.myRR,0))}>{rrSigned(tip.match.myRR,0)} RR</div>
          <div className="tt-row"><span className="tt-key" style={{background:`var(--chart-${resultClass(tip.match)})`}}/>
            {tip.match.won===true?'Win':tip.match.won===false?'Loss':'Draw'}{matchLabel(tip.match)?` on ${matchLabel(tip.match)}`:''}</div>
          <div className="tt-row"><RankIcon tier={tip.rank.tier} size={14}/>{avgLabel(tip.rank.tier)}, {tip.rank.rr} RR after</div>
          {tip.duo&&<div className="tt-muted">{tip.duo.label}{tip.run?`, ${rrSigned(tip.run.net,0)} RR across ${tip.run.count} games`:''}</div>}
          <div className="tt-muted">Match {active+1} of {points.length}, {dateLabel(tip.match)}</div>
        </ChartTooltip>
      )}
    </div>
  );
}

/* ── RR by session ────────────────────────────────────── */
// Date labels every `step` sessions so neighbouring labels stay `minGap` px apart.
export function rrSessionLabelStep(count,slot,minGap){
  return [1,2,3,4,5,10,20,50].find(step=>slot*step>=minGap)||50;
}

// One bar per play session (rrSessionRows: a new session after a break of more
// than 3 hours), growing up in green for a net gain and down in red for a net
// loss from a zero line. Replaced "RR payout over time" on 21 Nov 2026: payout
// size barely moves within an act, so that chart showed flat lines; how many
// games are won in a sitting is what moves RR (docs/rr-sessions.md).
export function RRSessionChart({matches}){
  const [ref,measured]=useElementWidth();
  const [active,setActive]=useState(null);
  const compact=useIsMobile();
  const rows=rrSessionRows(matches);
  if(!rows.length)return <div ref={ref} className="py-10 text-center text-sm text-muted-foreground">No recorded RR changes in this range.</div>;
  const height=compact?220:260,top=18,bottom=height-28;
  const left=compact?36:44,right=compact?8:14;
  const width=Math.max(left+right+2,measured||872),plotWidth=width-left-right;
  const slot=plotWidth/rows.length,barWidth=Math.min(28,Math.max(2,slot*.66));
  const showValues=slot>=(compact?24:28);
  const nets=rows.map(r=>r.net);
  const lo=Math.min(0,...nets),hi=Math.max(0,...nets);
  const step=[5,10,20,25,50,100,200,250,500].find(s=>(hi-lo)/s<=(compact?4:5))||500;
  // Headroom for the value labels at the bar ends.
  const pad=showValues?(hi-lo||step)*.14:0;
  const yMin=lo<0?Math.floor((lo-pad)/step)*step:0,yMax=Math.max(step,Math.ceil((hi+pad)/step)*step);
  const y=value=>bottom-(value-yMin)/(yMax-yMin)*(bottom-top);
  const yTicks=[];
  for(let value=yMin;value<=yMax;value+=step)yTicks.push(value);
  const cx=i=>left+(i+.5)*slot;
  const dateLabel=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const timeLabel=t=>new Date(t).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  const labelStep=rrSessionLabelStep(rows.length,slot,compact?52:64);
  const kind=net=>net>0?'win':net<0?'loss':'draw';
  const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
  const record=r=>`${r.wins}–${r.losses}${r.draws?`–${r.draws}`:''}`;
  const rankAfter=r=>r.postRR==null?null:rrPositionFromElo(r.postRR,r.postTierId);
  const describe=r=>{
    const rank=rankAfter(r);
    return `Session ${r.i+1} of ${rows.length}, ${dateLabel(r.startMs)} ${timeLabel(r.startMs)}–${timeLabel(r.endMs)}: ${rrSigned(r.net,0)} RR over ${plural(r.games,'game','games')}, ${plural(r.wins,'win','wins')}, ${plural(r.losses,'loss','losses')}${r.draws?`, ${plural(r.draws,'draw','draws')}`:''}${rank?`; ${rank.label} after`:''}`;
  };
  const total=nets.reduce((a,b)=>a+b,0),average=total/rows.length;
  const best=rows.reduce((a,b)=>b.net>a.net?b:a),worst=rows.reduce((a,b)=>b.net<a.net?b:a);
  const winning=rows.filter(r=>r.net>0).length;
  const pointerMove=event=>{
    const bounds=event.currentTarget.getBoundingClientRect();
    const plotX=(event.clientX-bounds.left)*width/bounds.width;
    if(plotX<left||plotX>width-right){setActive(null);return;}
    setActive(Math.max(0,Math.min(rows.length-1,Math.floor((plotX-left)/slot))));
  };
  const tip=active!=null&&rows[active]?rows[active]:null;
  const tipRank=tip&&rankAfter(tip);
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground max-sm:text-xs" aria-label="Session summary">
        {[
          ['Sessions',String(rows.length),''],
          ['Avg per session',rrSigned(average,1),toneClass(average,0)],
          ['Net gain in',`${winning} of ${rows.length}`,''],
          ['Best',`${rrSigned(best.net,0)} (${dateLabel(best.startMs)})`,toneClass(best.net,0)],
          ['Worst',`${rrSigned(worst.net,0)} (${dateLabel(worst.startMs)})`,toneClass(worst.net,0)],
        ].map(([label,value,tone])=>(
          <div key={label} className="flex gap-1.5"><dt>{label}</dt><dd className={cn('font-medium text-foreground tabular-nums',tone)}>{value}</dd></div>
        ))}
      </dl>
      <ChartFrame>
        <div ref={ref} className="relative" role="region" aria-label="Net RR by session" tabIndex={0}>
          <svg className={cn('chart-svg rr-session-svg',tip&&'has-active')} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
            aria-label={`Net RR for ${plural(rows.length,'play session','play sessions')}: ${winning} with a net gain, average ${rrSigned(average,1)} RR per session`}
            onPointerMove={pointerMove} onPointerDown={pointerMove} onPointerLeave={()=>setActive(null)} style={{touchAction:'pan-y'}}>
            {yTicks.map(value=>(
              <g key={value} aria-hidden="true">
                <line className={value===0?'zero':'grid'} x1={left} y1={y(value)} x2={width-right} y2={y(value)}/>
                <text x={left-8} y={y(value)+4} textAnchor="end">{value>0?`+${value}`:value<0?`−${-value}`:'0'}</text>
              </g>
            ))}
            {rows.map((r,i)=>{
              const y0=y(0),y1=y(r.net),barTop=Math.min(y0,y1),barHeight=Math.max(2,Math.abs(y1-y0));
              const labelY=r.net>=0?barTop-6:barTop+barHeight+13;
              return (
                <g key={r.startMs} tabIndex={0} role="img" aria-label={describe(r)} onFocus={()=>setActive(i)} onBlur={()=>setActive(null)}>
                  <rect x={cx(i)-slot/2} y={top} width={slot} height={bottom-top} fill="transparent"/>
                  <rect className={cn('bar',kind(r.net),i===active&&'active')} x={cx(i)-barWidth/2} y={r.net===0?y0-1:barTop} width={barWidth} height={barHeight}
                    rx={Math.min(3,barWidth/3)}/>
                  {showValues&&<text x={cx(i)} y={labelY} textAnchor="middle" className="value" aria-hidden="true">{rrSigned(r.net,0)}</text>}
                </g>
              );
            })}
            {rows.map((r,i)=>(i%labelStep===0)&&(
              <text key={r.startMs} x={cx(i)} y={bottom+18} aria-hidden="true"
                textAnchor={rows.length>1&&i===0&&slot<40?'start':'middle'}>{dateLabel(r.startMs)}</text>
            ))}
          </svg>
          {tip&&(
            <ChartTooltip x={cx(active)} y={Math.max(0,Math.min(y(0),y(tip.net))-40)} width={width}>
              <div className={cn('tt-value',toneClass(tip.net,0))}>{rrSigned(tip.net,0)} RR</div>
              <div className="tt-row">{plural(tip.games,'game','games')}, {record(tip)}</div>
              {tipRank&&<div className="tt-row"><RankIcon tier={tipRank.tier} size={14}/>{avgLabel(tipRank.tier)}, {tipRank.rr} RR after</div>}
              <div className="tt-muted">{dateLabel(tip.startMs)}, {timeLabel(tip.startMs)}–{timeLabel(tip.endMs)}</div>
            </ChartTooltip>
          )}
        </div>
      </ChartFrame>
      <p className="text-xs text-muted-foreground">A new session starts after a break of more than {RR_SESSION_BREAK_MS/3600000} hours. Net RR counts every recorded change, placements and 5-stacks included.</p>
    </div>
  );
}

// The session chart's card, with its own match range.
export function RRSessionCard({matches,range='all'}){
  return (
    <section aria-labelledby="rr-session-title">
      <Card>
        <CardHeader>
          <CardTitle><h2 id="rr-session-title">RR by session</h2></CardTitle>
          <CardAction><RRRangeSelect card="sessions" value={range} total={matches.length} label="RR by session"/></CardAction>
        </CardHeader>
        <CardContent><RRSessionChart matches={rrScopedMatches(matches,range)}/></CardContent>
      </Card>
    </section>
  );
}

// A card's own match range: all time or the 50/30/20 most recent matches, as
// a small menu in the card header. Each card keeps its own (setRRRange), so
// changing one never rescopes another. 50 is offered only above 50 matches.
export function rrRangeOptions(total){
  return [['all',`All time (${total})`],...(total>50?[['50','Last 50']]:[]),['30','Last 30'],['20','Last 20']];
}
export function RRRangeSelect({card,value,total,label}){
  const options=rrRangeOptions(total);
  const current=options.find(([key])=>key===value)??options[0];
  return (
    <Select value={current[0]} onValueChange={next=>setRRRange(card,next)}>
      <SelectTrigger size="sm" className="h-8 text-xs" aria-label={`Match range for ${label}`} data-rr-range={card}>
        <SelectValue>{current[1]}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {options.map(([key,text])=><SelectItem key={key} value={key} className="text-xs">{text}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// The RR penalties tooltip: each kind with its RR and count. Party penalties
// are a share of the payout, not RR, so only their games are counted.
export function RRPenaltyBreakdown({adjust}){
  const rrText=x=>x?`${rrSigned(x,0)} RR`:'0 RR';
  const rows=[
    ['Dodges',`${rrText(adjust.dodgeRR)} (${adjust.dodges})`],
    ['AFK penalties',adjust.afkCovered?`${rrText(-adjust.afkRR)} (${adjust.afkMatches})`:'No data'],
    ['Party penalties',`${adjust.partyMatches} ${adjust.partyMatches===1?'game':'games'}`],
  ];
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums" data-slot="rr-penalty-breakdown">
      {rows.map(([label,value])=><Fragment key={label}><dt>{label}</dt><dd className="text-right">{value}</dd></Fragment>)}
    </dl>
  );
}

// The range's seven headline figures as tiles in the Act stats grid look:
// value first, then a quiet line or mini bar that says what it is built from.
// Net RR spans two columns: three rows of two below it on phones, two rows of
// four from tablets up (the card is capped near 860px, too narrow for seven).
export function RRSummary({matches,net,netCount,dodges=[]}){
  const summary=computeRRStats(matches);
  const adjust=rrAdjustmentStats(matches,dodges);
  const {wins,losses,draws}=summary;
  const games=wins+losses+draws;
  const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
  const penaltyCount=adjust.dodges+adjust.afkMatches;
  const penaltyBreakdown=<RRPenaltyBreakdown adjust={adjust}/>;
  const recordTitle=`${plural(wins,'win','wins')}, ${plural(losses,'loss','losses')}, ${plural(draws,'draw','draws')}`;
  const dash=<span className="text-muted-foreground/60">–</span>;
  const tiles=[
    {label:'Net RR',value:net==null?'—':rrSigned(net,0),tone:net==null?'text-muted-foreground':toneClass(net,0),wide:true,
      title:'Sum of every recorded RR change in this range, placements and 5-stacks included',
      foot:net==null?'No recorded changes':`across ${plural(netCount,'match','matches')}`},
    {label:'RR / Win',value:summary.avgGain==null?'—':rrSigned(summary.avgGain,1),tone:summary.avgGain==null?'text-muted-foreground':'text-positive',
      title:'Average RR from eligible wins; excludes placements, unrated ranks and full 5-stacks',foot:plural(wins,'win','wins')},
    {label:'RR / Loss',value:summary.avgLoss==null?'—':rrSigned(-summary.avgLoss,1),tone:summary.avgLoss==null?'text-muted-foreground':'text-negative',
      title:'Average RR from eligible losses; excludes placements, unrated ranks and full 5-stacks',foot:plural(losses,'loss','losses')},
    // Draws always show, in the site's draw yellow, even at zero.
    {label:'W–L–D',title:`Eligible matches: ${recordTitle}`,
      value:<span aria-label={recordTitle}>{wins}{dash}{losses}{dash}<span className="text-draw">{draws}</span></span>,
      foot:games?(
        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={recordTitle}>
          {[[wins,'var(--chart-win)'],[losses,'var(--chart-loss)'],[draws,'var(--chart-draw)']].filter(([n])=>n>0).map(([n,color],i)=>(
            <div key={i} className="h-full first:rounded-l-full last:rounded-r-full" style={{flexGrow:n,flexBasis:0,background:color}}/>
          ))}
        </div>
      ):'No eligible matches'},
    {label:'Win rate',value:winRateLabel(summary.winRate),tone:toneOf(winRateTone(summary.winRate)),
      title:'Wins divided by wins plus losses; draws excluded',
      foot:summary.winRate==null?'No decided matches':<Progress value={summary.winRate} className="h-1.5 bg-muted" indicatorClassName="rounded-full bg-foreground/70" aria-label={`${winRateLabel(summary.winRate)} win rate`}/>},
    // Dodges plus reported AFK penalties; the value's tooltip breaks them down
    // and counts party penalties, a fraction rather than RR (rrAdjustmentStats).
    {label:'RR penalties',
      value:<Hint content={penaltyBreakdown}>{adjust.penaltyRR?rrSigned(adjust.penaltyRR,0):'0'}</Hint>,
      tone:adjust.penaltyRR?'text-negative':'text-muted-foreground',
      title:'RR lost to queue dodges and reported AFK penalties in this range. Dodges are not part of Net RR. AFK penalties are shown as reported and may already be inside the match payout. Remakes leave no separate record and are not shown. Hover or tap the number for the breakdown.',
      foot:penaltyCount?plural(penaltyCount,'penalty','penalties'):'None in this range'},
    {label:'Refunds',
      value:adjust.refundRR?rrSigned(adjust.refundRR,0):'0',
      tone:adjust.refundRR?toneClass(adjust.refundRR,0):'text-muted-foreground',
      title:'RR that Riot gave back in this range, for example when a player in that match was later banned. Refunds are added on top of the match payout, so they are not part of Net RR.',
      foot:adjust.refunds?plural(adjust.refunds,'refunded match','refunded matches'):'No refunds'},
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4" aria-label="RR summary for selected match range" data-slot="rr-summary">
      {tiles.map(({label,value,tone,title,foot,wide})=>(
        <div key={label} className={cn('flex min-w-0 flex-col gap-2 bg-card px-4 py-3.5 max-sm:px-3.5 max-sm:py-3',wide&&'col-span-2')}>
          <dt className="text-xs text-muted-foreground"><Hint content={title}>{label}</Hint></dt>
          <dd className={cn('text-2xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums max-sm:text-xl',tone)}>{value}</dd>
          <dd className="mt-auto flex min-h-1.5 flex-col justify-end text-xs text-muted-foreground tabular-nums">{foot}</dd>
        </div>
      ))}
    </dl>
  );
}

function RRBonusNote({matches}){
  const reported=rrReportedStats(matches);
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite">
      {reported.covered&&!reported.bonusMatches
        ?<>No performance bonus in this range. Bonus data for {reported.covered} of {reported.total} eligible games.</>
        :reported.covered
        ?<>Performance bonus <strong className="font-medium text-foreground">{rrSigned(reported.bonusTotal,0)} RR</strong> across <strong className="font-medium text-foreground">{reported.bonusMatches}</strong> games. Bonus data for {reported.covered} of {reported.total} eligible games.</>
        :'Performance bonus data unavailable for this range.'}
    </p>
  );
}

/* ── Estimated RR payout by starting rank ──────────────── */
export function RRMovementChart({matches,zoomTier}){
  // Phones draw a narrower viewBox (no sideways scrolling) with larger type,
  // thinned axis ticks and rank chips for zooming instead of double-click.
  const compact=useIsMobile();
  const allRows=rrMovementRows(matches);
  if(!allRows.length)return null;
  const rowTier=row=>rrPositionFromElo(row.m.myPreRR,row.m.myPreTierId??row.m.myTierId).tier;
  let rows=zoomTier==null?allRows:allRows.filter(row=>rowTier(row)===zoomTier);
  if(zoomTier!=null&&!rows.length){zoomTier=null;rows=allRows;}
  const axis=rrMovementXAxis(rows,zoomTier);
  rows=rows.map((row,index)=>({...row,axisRR:axis.positions[index]}));
  const width=compact?360:900,height=compact?300:340,left=compact?40:68,right=compact?34:56,top=compact?30:34,bottom=compact?50:58;
  const plotRight=width-right,plotBottom=height-bottom,plotWidth=plotRight-left,plotHeight=plotBottom-top;
  const xInset=zoomTier!=null?12:0;
  const sortedRows=rows.slice().sort((a,b)=>a.axisRR-b.axisRR||(a.m.startedAtMs||0)-(b.m.startedAtMs||0));
  const overlapTotals=new Map(),overlapIndexes=new Map();
  sortedRows.forEach(row=>overlapTotals.set(row.axisRR,(overlapTotals.get(row.axisRR)||0)+1));
  rows=sortedRows.map(row=>{
    const total=overlapTotals.get(row.axisRR),index=overlapIndexes.get(row.axisRR)||0;
    overlapIndexes.set(row.axisRR,index+1);
    const spacing=total>1?Math.min(3,18/(total-1)):0;
    const offsetPx=(index-(total-1)/2)*spacing;
    return{...row,plotRR:row.axisRR+offsetPx*(axis.max-axis.min)/(plotWidth-2*xInset)};
  });
  const gainTrend=rrPayoutEstimates(rows,allRows,true),lossTrend=rrPayoutEstimates(rows,allRows,false);
  const even=rrPayoutEvenPoint(allRows);
  const evenLabel=even?rrPositionFromElo(even.position,even.tier).label:null;
  const evenDate=m=>new Date(m).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const evenText=even?`Wins and losses paid about the same over ${even.games} games in a row (${even.wins} wins at +${even.winPayout.toFixed(1)} RR, ${even.losses} losses at −${even.lossPayout.toFixed(1)} RR, evened out to a ${RR_MARGIN_REFERENCE}-round margin)${Number.isFinite(even.startMs)&&Number.isFinite(even.endMs)?`, ${evenDate(even.startMs)} to ${evenDate(even.endMs)}`:''}, starting between ${rrPositionFromElo(even.minRR,even.minTier).label} and ${rrPositionFromElo(even.maxRR,even.maxTier).label}. The line is at the stretch's middle starting rank, ${evenLabel}. Wins and losses paying the same for that long usually means your rank had met your hidden MMR.`:null;
  const penalties=rows.filter(row=>row.penalty>0).length;
  const count=[zoomTier!=null?`${avgLabel(zoomTier)} only`:null,`${rows.length} covered ${rows.length===1?'match':'matches'}`,
    penalties?`${penalties} penalized`:null,zoomTier!=null?'double-click to reset':null].filter(Boolean).join(', ');
  const xMin=axis.min,xMax=axis.max;
  const payouts=rows.map(row=>Math.abs(row.net)).concat(gainTrend,lossTrend).filter(v=>typeof v==='number'||v.payout!=null).map(v=>typeof v==='number'?v:v.payout);
  const payoutMin=Math.min(...payouts),payoutMax=Math.max(...payouts);
  const yPad=Math.max(.75,(payoutMax-payoutMin)*.08);
  const yMin=Math.max(0,Math.floor((payoutMin-yPad)*2)/2);
  const yMax=Math.max(yMin+2,Math.ceil((payoutMax+yPad)*2)/2);
  const x=value=>left+xInset+(value-xMin)/(xMax-xMin)*(plotWidth-2*xInset);
  const y=value=>top+(yMax-value)/(yMax-yMin)*plotHeight;
  const evenAxis=even==null?null:zoomTier==null?even.position:even.position-(zoomTier>=24?2100:(zoomTier-3)*100);
  const evenX=evenAxis!=null&&evenAxis>=xMin&&evenAxis<=xMax?x(evenAxis):null;
  const availableTiers=new Set(allRows.map(rowTier));
  const toggleRankZoom=tier=>{if(availableTiers.has(tier))setRRMovementZoomTier(zoomTier===tier?null:tier);};
  // Rank bands come from the rank attached to each match; at Immortal+ the
  // regional thresholds are not fixed 100-RR divisions.
  const tierGroups=[...availableTiers].sort((a,b)=>a-b).map(tier=>{
    const values=allRows.filter(row=>rowTier(row)===tier).map(row=>row.m.myPreRR);
    return{tier,min:Math.min(...values),max:Math.max(...values)};
  });
  const visibleGroups=zoomTier==null?tierGroups:tierGroups.filter(group=>group.tier===zoomTier);
  const rankBoundary=(previous,next)=>{
    const midpoint=(previous.max+next.min)/2,snapped=Math.round(midpoint/100)*100;
    return snapped>=previous.max&&snapped<=next.min?snapped:midpoint;
  };
  const rankBands=visibleGroups.map((group,index)=>{
    const previous=visibleGroups[index-1],next=visibleGroups[index+1];
    return{tier:group.tier,start:previous?rankBoundary(previous,group):xMin,end:next?rankBoundary(group,next):xMax};
  });
  if(zoomTier==null){
    // Display Immortal 3 as the 200–300 RR band (band and label only).
    const immo3=rankBands.findIndex(band=>band.tier===26);
    if(immo3!==-1){
      rankBands[immo3].start=2300;rankBands[immo3].end=2400;
      if(immo3>0)rankBands[immo3-1].end=2300;
      if(immo3<rankBands.length-1)rankBands[immo3+1].start=2400;
    }
  }
  const yStep=[1,2,2.5,5,10,20,50].find(step=>step>=(yMax-yMin)/5)||50;
  const yTicks=[];
  for(let tick=Math.ceil(yMin/yStep)*yStep;tick<=yMax+1e-9;tick+=yStep)yTicks.push(tick);
  const xTicks=[];
  if(zoomTier!=null){
    const range=xMax-xMin,tickStep=range<=150?25:range<=400?50:100;
    for(let rr=Math.ceil(xMin/tickStep)*tickStep;rr<=xMax;rr+=tickStep)xTicks.push({at:rr,label:String(rr)});
  }else{
    const tickStep=xMax-xMin<=500?50:100;
    for(let value=Math.ceil(xMin/tickStep)*tickStep;value<=xMax;value+=tickStep)xTicks.push({at:value,label:String(rrPositionFromElo(value).rr)});
  }
  let lastTickX=-Infinity;
  const shownXTicks=xTicks.filter(tick=>{
    const px=x(tick.at);
    if(px-lastTickX<(compact?44:0))return false;
    lastTickX=px;return true;
  });
  // Direct labels at each curve's right end; two close ends split evenly.
  const ends=[[gainTrend,'positive','Win'],[lossTrend,'negative','Loss']].map(([trend,kind,label])=>{
    const last=trend.filter(e=>e.payout!=null).at(-1);
    return last?{kind,label,x:x(last.axisPosition)+8,y:y(last.payout)+4}:null;
  }).filter(Boolean);
  if(ends.length===2&&Math.abs(ends[0].y-ends[1].y)<13){
    const [upper,lower]=ends[0].y<=ends[1].y?ends:[ends[1],ends[0]],mid=(upper.y+lower.y)/2;
    upper.y=mid-6.5;lower.y=mid+6.5;
  }
  const onDoubleClick=event=>{
    const svg=event.currentTarget,matrix=svg.getScreenCTM();
    if(!matrix)return;
    const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    const local=point.matrixTransform(matrix.inverse());
    if(local.x<left||local.x>plotRight||local.y<top||local.y>plotBottom)return;
    if(zoomTier!=null){setRRMovementZoomTier(null);return;}
    const value=xMin+(local.x-left)/plotWidth*(xMax-xMin);
    const target=rankBands.find(band=>value>=band.start&&value<=band.end);
    if(target)toggleRankZoom(target.tier);
  };
  return (
    <section aria-labelledby="rr-movement-title">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2">
          <CardTitle><h2 id="rr-movement-title">Estimated RR payout by starting rank</h2></CardTitle>
          <span className="text-sm text-muted-foreground">{count}</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground max-sm:gap-x-3 max-sm:gap-y-1 max-sm:text-xs" aria-label="Chart legend">
            <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{background:'var(--chart-win)'}}/>Estimated RR / win</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{background:'var(--chart-loss)'}}/>Estimated RR / loss</span>
            <span className="inline-flex items-center gap-1.5"><span className="flex gap-0.5 opacity-45"><span className="size-1.5 rounded-full" style={{background:'var(--chart-win)'}}/><span className="size-1.5 rounded-full" style={{background:'var(--chart-loss)'}}/></span>Individual win or loss</span>
            {even&&<span className="inline-flex items-center gap-1.5"><span className="h-3 w-0 border-l border-dashed border-foreground/60"/>Estimated even point</span>}
          </div>
          {/* The even-point sentence above the chart was removed on request (20 Nov 2026); it stays as the even line's label. */}
          {compact&&tierGroups.length>1&&(
            // Single-choice chips: tapping the chosen rank again (an empty
            // value) goes back to all ranks.
            <ToggleGroup type="single" variant="outline" size="sm" spacing={1.5} value={zoomTier==null?'all':String(zoomTier)}
              onValueChange={value=>setRRMovementZoomTier(value&&value!=='all'?Number(value):null)}
              className="-mx-4 w-auto overflow-x-auto px-4 [scrollbar-width:none]" aria-label="Zoom to a starting rank">
              {[null,...tierGroups.map(group=>group.tier)].map(tier=>(
                <ToggleGroupItem key={tier??'all'} value={tier==null?'all':String(tier)}
                  className="h-7 gap-1 px-2.5 text-xs text-muted-foreground data-[state=on]:border-foreground/30 data-[state=on]:text-foreground">
                  {tier!=null&&<RankIcon tier={tier} size={14}/>}{tier==null?'All ranks':avgLabelShort(tier)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <ChartFrame className="mt-2">
          <div className={compact?undefined:'overflow-x-auto'} role="region" aria-label="RR movement chart" tabIndex={0}>
            <svg className={cn('chart-svg rr-movement-svg',compact?'compact':'min-w-[640px]',zoomTier!=null&&'zoomed')} viewBox={`0 0 ${width} ${height}`} role="group"
              aria-label="Estimated RR payout by starting rank" onDoubleClick={onDoubleClick}>
              <desc>Green and red curves estimate RR payout for wins and losses. Faint dots show individual matches. Each curve point carries its estimate, match count and starting-rank span.</desc>
              {rankBands.map(({tier,start,end},index)=>{
                const bandLeft=Math.max(left,x(start)),bandRight=Math.min(plotRight,x(end));
                if(bandRight<=bandLeft)return null;
                const interactive=availableTiers.has(tier);
                return (
                  <g key={tier}>
                    <rect x={bandLeft} y={top} width={bandRight-bandLeft} height={plotHeight} fill={index%2?'rgba(255,255,255,.018)':'rgba(255,255,255,.035)'}
                      className={interactive?'rank-band':''} aria-hidden={interactive?'false':'true'}
                      {...(interactive?{tabIndex:0,role:'button','aria-label':zoomTier===tier?`${avgLabel(tier)} is zoomed. Press Enter to reset`:`Zoom chart to ${avgLabel(tier)}`,
                        onKeyDown:event=>{if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();toggleRankZoom(tier);}}:{})}/>
                    {bandRight-bandLeft>(compact?30:54)&&<text x={(bandLeft+bandRight)/2} y={top-10} textAnchor="middle" className="rank-band-label">{avgLabelShort(tier)}</text>}
                  </g>
                );
              })}
              {yTicks.map(value=>(
                <g key={value}>
                  <line x1={left} y1={y(value)} x2={plotRight} y2={y(value)} className="grid"/>
                  <text x={left-10} y={y(value)+4} textAnchor="end" className="tick-label">{Number.isInteger(value)?String(value):value.toFixed(1)}</text>
                </g>
              ))}
              <text x={compact?11:15} y={(top+plotBottom)/2} textAnchor="middle" className="axis-label" transform={`rotate(-90 ${compact?11:15} ${(top+plotBottom)/2})`}>RR per game</text>
              <line x1={left} y1={plotBottom} x2={plotRight} y2={plotBottom} className="baseline" aria-hidden="true"/>
              {shownXTicks.map(tick=>(
                <g key={tick.at} aria-hidden="true">
                  <text x={x(tick.at)} y={plotBottom+20} textAnchor="middle" className="tick-label">{tick.label}</text>
                </g>
              ))}
              <text x={(left+plotRight)/2} y={height-9} textAnchor="middle" className="axis-label">{zoomTier==null?'Starting rank + RR':'Starting RR'}</text>
              {evenX!=null&&(
                <g className="even-point">
                  <line x1={evenX} y1={top} x2={evenX} y2={plotBottom} className="even-line" aria-hidden="true"/>
                  <text x={evenX+6} y={top+13} textAnchor={evenX>plotRight-(compact?80:110)?'end':'start'} dx={evenX>plotRight-(compact?80:110)?-12:0} className="even-label" aria-hidden="true">Even at {zoomTier==null?rrPositionFromElo(even.position,even.tier).rr:Math.round(evenAxis)} RR</text>
                  <rect x={evenX-5} y={top} width={10} height={plotHeight} className="even-hit-area" tabIndex={0} role="img" aria-label={evenText}/>
                </g>
              )}
              {rows.map((row,i)=><circle key={i} cx={x(row.plotRR)} cy={y(Math.abs(row.net))} r={3} className={`trend-point ${row.m.won?'positive':'negative'}`} aria-hidden="true"/>)}
              <rect x={left} y={top} width={plotWidth} height={plotHeight} className="hit" style={{cursor:zoomTier==null?'zoom-in':'zoom-out'}} aria-hidden="true"/>
              {[[gainTrend,'positive',true],[lossTrend,'negative',false]].map(([trend,kind,won])=>(
                <g key={kind}>
                  {rrPayoutSegments(trend).map((segment,si)=>{
                    if(segment.length>1){
                      const path=segment.map(({axisPosition,payout},index)=>`${index?'L':'M'}${x(axisPosition).toFixed(1)},${y(payout).toFixed(1)}`).join(' ');
                      return <path key={si} d={path} className={`payout-trend ${kind}`} aria-hidden="true"/>;
                    }
                    const estimate=segment[0],px=x(estimate.axisPosition),py=y(estimate.payout);
                    return <path key={si} d={`M${(px-3).toFixed(1)},${py.toFixed(1)} L${(px+3).toFixed(1)},${py.toFixed(1)}`} className={`payout-trend ${kind}`} aria-hidden="true"/>;
                  })}
                  {trend.filter(e=>e.payout!=null).map(estimate=>{
                    const rangeStart=rrPositionFromElo(estimate.min,estimate.minTier).label,rangeEnd=rrPositionFromElo(estimate.max,estimate.maxTier).label;
                    const detail=`Estimated RR / ${won?'win':'loss'} at a ${RR_MARGIN_REFERENCE}-round margin: ${won?'+':'−'}${estimate.payout.toFixed(1)} RR. ${estimate.n} nearby ${won?'wins':'losses'} from ${rangeStart} to ${rangeEnd}. Act average: ${estimate.actMean.toFixed(1)} RR.`;
                    return <circle key={estimate.position} cx={x(estimate.axisPosition)} cy={y(estimate.payout)} r={6} className="estimate-hit-area" tabIndex={0} role="img" aria-label={detail}/>;
                  })}
                </g>
              ))}
              {ends.map(end=><text key={end.kind} x={end.x} y={end.y} className="series-label" aria-hidden="true">{end.label}</text>)}
            </svg>
          </div>
          </ChartFrame>
          <p className="text-xs text-muted-foreground">Estimates average your nearby wins and losses, evened out to a {RR_MARGIN_REFERENCE}-round margin. Faint dots are your actual payouts; gaps mean too few games.{even?' The even point marks a stretch of games where wins and losses paid the same, which usually means your rank met your hidden MMR.':''}</p>
        </CardContent>
      </Card>
    </section>
  );
}

/* ── Tables ───────────────────────────────────────────────── */
const RR_SCOPE='Games, K/D, ACS and win rate include all matches in this act. Performance Score averages only matches with reported scores. RR averages use eligible recorded payouts, excluding placements, unrated ranks and full 5-stacks.';
export function RRRankTable({matches}){
  const rows=rrRankRows(matches);
  const tableRows=rows.map(({tier,stats:s})=>({key:String(tier),cells:[
    <span className="flex items-center gap-2"><RankIcon tier={tier} size={24}/>{avgLabel(tier)}</span>,
    s.n,s.kd==null?'—':s.kd.toFixed(2),s.acs==null?'—':Math.round(s.acs),s.performanceScore==null?'—':Math.round(s.performanceScore),
    winRateLabel(s.winRate),s.avgGain==null?'—':rrSigned(s.avgGain,1),s.avgLoss==null?'—':rrSigned(-s.avgLoss,1),
  ],cellProps:[null,null,{className:toneClass(s.kd)},null,null,{className:toneOf(winRateTone(s.winRate))},{className:'text-positive'},{className:'text-negative'}]}));
  const values=rows.map(({tier,stats:s})=>[tier,s.n,s.kd,s.acs,s.performanceScore,s.winRate,s.avgGain,s.avgLoss==null?null:-s.avgLoss]);
  return (
    <SortableTable id="rr-rank-table" standalone rows={tableRows} values={values} caption={`Matches grouped by your rank in each match. ${RR_SCOPE}`}
      columns={[{label:'Player rank'},{label:'Matches',title:'All matches in this act, including games without RR payouts'},{label:'K/D'},{label:'ACS',title:'Average combat score'},
        {label:'PS',title:'Avg PS across matches with available data'},{label:'Win rate',title:'Wins divided by wins plus losses across all games; draws excluded'},
        {label:'RR / Win',title:'Average recorded RR from eligible wins; excludes placements, unrated ranks and full 5-stacks'},
        {label:'RR / Loss',title:'Average recorded RR from eligible losses; excludes placements, unrated ranks and full 5-stacks'}]}
      maxima={[{column:2,label:'K/D'},{column:3,label:'ACS'},{column:4,label:'Avg PS'},{column:5,label:'win rate'},{column:6,label:'RR per win'}]}/>
  );
}

// RR by result: one row per exact scoreline (closest margin first). The
// average RR lost per loss grows left in red, the average RR gained per win
// grows right in green, on one shared scale; each bar end carries its value
// and game count. Rows are HTML so they stay sharp and fit any width.
export function RRResultChart({matches}){
  const rows=buildRRScoreRows(matches);
  if(!rows.length)return <p className="text-sm text-muted-foreground">No wins or losses with both a recorded score and eligible RR yet.</p>;
  const scale=Math.max(1,...rows.flatMap(({stats:s})=>[s.avgGain??0,s.avgLoss??0]));
  const games=(n,one,many)=>`${n} ${n===1?one:many}`;
  // Each side keeps 4.75rem beside the bar for its value label.
  const barWidth=value=>`calc((100% - 4.75rem) * ${(Math.abs(value)/scale).toFixed(4)})`;
  const side=(value,count,kind)=>{
    if(value==null)return <span className={cn('absolute top-1/2 -translate-y-1/2 text-xs text-muted-foreground',kind==='win'?'left-1.5':'right-1.5')}>—</span>;
    const width=barWidth(value);
    return (
      <>
        <span className={cn('absolute top-1/2 h-3.5 -translate-y-1/2',kind==='win'?'left-0 rounded-r-[4px]':'right-0 rounded-l-[4px]')}
          style={{width,background:kind==='win'?'var(--chart-win)':'var(--chart-loss)'}}/>
        <span className={cn('absolute top-1/2 -translate-y-1/2 text-xs whitespace-nowrap tabular-nums',kind==='win'?'text-positive':'text-negative')}
          style={kind==='win'?{left:`calc(${width} + 6px)`}:{right:`calc(${width} + 6px)`}}>
          <span className="font-semibold">{rrSigned(kind==='win'?value:-value,1)}</span> <span className="text-muted-foreground">({count})</span>
        </span>
      </>
    );
  };
  return (
    <div data-slot="rr-result-chart" className="flex flex-col">
      <div className="grid grid-cols-[4.25rem_1fr_1fr] gap-x-0 pb-2 text-xs text-muted-foreground" aria-hidden="true">
        <span>Score</span>
        <span className="pr-2 text-right">RR per loss</span>
        <span className="pl-2">RR per win</span>
      </div>
      <ul className="flex flex-col" aria-label="Average recorded RR per win and per loss for each exact scoreline">
        {rows.map(({high,low,margin,stats:s},index)=>{
          const newMargin=index>0&&rows[index-1].margin!==margin;
          const label=`${high}–${low}${high>13?' (overtime)':''}: `+
            [s.wins?`${games(s.wins,'win','wins')} averaging ${rrSigned(s.avgGain,1)} RR`:'no wins',
              s.losses?`${games(s.losses,'loss','losses')} averaging ${rrSigned(-s.avgLoss,1)} RR`:'no losses'].join(', ');
          return (
            <li key={`${high}-${low}`} aria-label={label} className={cn('grid h-8 grid-cols-[4.25rem_1fr_1fr] items-center',newMargin&&'mt-1.5 border-t border-dashed pt-1.5 h-[2.375rem]')}>
              <span className="text-sm font-medium whitespace-nowrap tabular-nums" aria-hidden="true">{high}–{low}{high>13&&<span className="ml-1 text-[10px] font-normal text-muted-foreground">OT</span>}</span>
              <span className="relative h-full border-r border-[var(--chart-axis)]" aria-hidden="true">{side(s.avgLoss,s.losses,'loss')}</span>
              <span className="relative h-full" aria-hidden="true">{side(s.avgGain,s.wins,'win')}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ScoreMarginChart({matches}){
  const compact=useIsMobile();
  const {bins,total}=scoreMarginDistribution(matches);
  if(!total)return null;
  const width=compact?360:900,height=compact?260:300,left=compact?34:48,right=compact?8:22,top=compact?30:34,bottom=compact?50:58;
  const plotWidth=width-left-right,plotBottom=height-bottom,plotHeight=plotBottom-top;
  const maxCount=Math.max(...bins.map(b=>b.count)),step=Math.max(1,Math.ceil(maxCount/4));
  const ceiling=Math.ceil(maxCount/step)*step,slot=plotWidth/bins.length;
  const y=count=>plotBottom-count/ceiling*plotHeight;
  const ticks=[];
  for(let count=0;count<=ceiling;count+=step)ticks.push(count);
  // Bars stay thin (<=24px) with air between them. Every bar carries its
  // count on top (no hover tooltip); exact scorelines are in its aria-label.
  const barWidth=Math.min(24,slot*.72);
  // Phones: label every 1st, 2nd or 4th margin so axis labels stay ~30px apart.
  const labelStep=[1,2,4,8].find(step=>slot*step>=30)||8;
  const center=index=>left+(index+.5)*slot;
  const describe=bin=>{
    const margin=Math.abs(bin.margin);
    const outcome=bin.margin===0?'Draws':`${bin.margin>0?'Wins':'Losses'} by ${margin} ${margin===1?'round':'rounds'}`;
    const scores=bin.scorelines.map(score=>`${score.scoreline}: ${score.count} matches`).join('. ');
    return `${outcome}: ${bin.count} matches (${(100*bin.count/total).toFixed(1)}%). Scorelines (your rounds–enemy rounds): ${scores}.`;
  };
  return (
    <section aria-labelledby="score-margin-chart-title">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2">
          <CardTitle><h2 id="score-margin-chart-title">Score-margin distribution</h2></CardTitle>
          <span className="text-sm text-muted-foreground">{total} scored matches</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-4 text-sm text-muted-foreground">
            {[['Losses','var(--chart-loss)'],['Draws','var(--chart-draw)'],['Wins','var(--chart-win)']].map(([label,color])=><span key={label} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{background:color}}/>{label}</span>)}
          </div>
          <ChartFrame className="mt-2">
          <div className={compact?undefined:'overflow-x-auto'} role="region" aria-label="Match counts by round margin" tabIndex={0}>
            <svg className={cn('chart-svg',compact?'compact':'min-w-[600px]')} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Match counts by round margin">
              <text x={left} y={16}>Matches</text>
              {ticks.map(count=>(
                <g key={count}>
                  <line x1={left} y1={y(count)} x2={width-right} y2={y(count)} className={count===0?'baseline':'grid'}/>
                  <text x={left-10} y={y(count)+4} textAnchor="end">{count}</text>
                </g>
              ))}
              {bins.map((bin,index)=>{
                const cx=center(index),kind=bin.margin<0?'loss':bin.margin>0?'win':'draw';
                const label=bin.margin===0?'0':`${bin.margin>0?'+':'−'}${Math.abs(bin.margin)}`;
                const barTop=y(bin.count),barHeight=plotBottom-barTop;
                return (
                  <g key={bin.margin}>
                    {bin.count>0&&(
                      <>
                        <rect x={cx-barWidth/2} y={barTop} width={barWidth} height={barHeight} rx={Math.min(4,barHeight/2)}
                          className={`bar ${kind}`} tabIndex={0} role="img" aria-label={describe(bin)}/>
                        {barHeight>4&&<rect x={cx-barWidth/2} y={plotBottom-4} width={barWidth} height={4} className={`bar-foot ${kind}`} aria-hidden="true"/>}
                        <text x={cx} y={barTop-7} textAnchor="middle" className="value" aria-hidden="true">{bin.count}</text>
                      </>
                    )}
                    {(!compact||bin.margin%labelStep===0)&&<text x={cx} y={plotBottom+22} textAnchor="middle" aria-hidden="true">{label}</text>}
                  </g>
                );
              })}
              <text x={left+plotWidth/2} y={height-8} textAnchor="middle">{compact?'Round margin (yours − enemy)':'Round margin (your rounds minus enemy rounds)'}</text>
            </svg>
          </div>
          </ChartFrame>
          <p className="text-xs text-muted-foreground">Your rounds minus enemy rounds, for all scored matches this act, including placements. Regulation 13–11 and overtime share ±2; draws sit at 0.</p>
        </CardContent>
      </Card>
    </section>
  );
}

export function RRPage(){
  const s=useEngine();
  const ready=s.analysisState==='ready';
  const matches=s.allMatches;
  const hasRR=ready&&matches.length>0;
  const hasScores=ready&&scoreMarginDistribution(matches).total>0;
  const ranges=s.rrRanges;
  const scoped=rrScopedMatches(matches,ranges.summary);
  const running=scoped.filter(m=>Number.isFinite(m.myRR)&&Number.isFinite(m.myPostRR)).reduce((sum,m)=>sum+m.myRR,0);
  const trendCount=scoped.filter(m=>Number.isFinite(m.myRR)&&Number.isFinite(m.myPostRR)).length;
  const anyTrend=trendCount>0;
  return (
    <main aria-labelledby="rr-title" className="space-y-6">
      <PageHeading id="rr-title" title="RR Breakdown"/>
      {hasRR&&(
        <>
          <PlacementToggle/>
          {/* The range's headline figures in their own card at the top. Its range
              menu scopes this card only; the trend card has its own. */}
          <section aria-labelledby="rr-summary-title">
            <Card className="gap-5">
              <CardHeader>
                <CardTitle><h2 id="rr-summary-title">RR summary</h2></CardTitle>
                <CardAction><RRRangeSelect card="summary" value={ranges.summary} total={matches.length} label="RR summary"/></CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <RRSummary matches={scoped} net={anyTrend?running:null} netCount={trendCount} dodges={rrDodgesInRange(s.rrDodges,scoped,ranges.summary)}/>
                <RRBonusNote matches={scoped}/>
              </CardContent>
            </Card>
          </section>
          <section aria-labelledby="rr-trend-title">
            <Card>
              <CardHeader>
                <CardTitle><h2 id="rr-trend-title">RR trend</h2></CardTitle>
                <CardAction><RRRangeSelect card="trend" value={ranges.trend} total={matches.length} label="RR trend"/></CardAction>
              </CardHeader>
              <CardContent><ChartFrame><RRTrendChart matches={matches} range={ranges.trend}/></ChartFrame></CardContent>
            </Card>
          </section>
          <RRMovementChart matches={matches} zoomTier={s.rrMovementZoomTier}/>
          <TableSection label="RR by your rank"><RRRankTable matches={matches}/></TableSection>
          <section aria-labelledby="rr-score-title">
            <Card>
              <CardHeader>
                <CardTitle><h2 id="rr-score-title">RR by result</h2></CardTitle>
              </CardHeader>
              <CardContent><ChartFrame><RRResultChart matches={matches}/></ChartFrame></CardContent>
            </Card>
          </section>
        </>
      )}
      {hasScores&&<ScoreMarginChart matches={matches}/>}
      {!hasRR&&!hasScores&&s.analysisState!=='error'&&(
        <EmptyState loading={s.analysisState==='loading'}>{s.analysisState==='loading'?'Loading this player’s matches…':ready?'No matches found for this season. Try another act.':'Search for a player above to explore their RR breakdown.'}</EmptyState>
      )}
    </main>
  );
}
