import {useRef,useState} from 'react';
import {
  avgLabel,avgLabelShort,buildRRScoreRows,computeRRStats,rrDuoInfo,rrMovementRows,rrMovementXAxis,
  rrPayoutEstimates,rrPayoutEvenPoint,rrPayoutSegments,rrPositionFromElo,rrRankRows,rrReportedStats,rrSigned,rrTrendScopedMatches,
  scoreMarginDistribution,setRRMovementZoomTier,setRRTrendRange,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {RANK_ICONS} from '@/engine/rank-icons.mjs';
import {useElementWidth,useEngine,useIsMobile} from '@/app/hooks.js';
import {ChartFrame,ChartTooltip,EmptyState,PageHeading,PlacementToggle,RankIcon,SortableTable,StatStrip,toneClass} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';

const toneOf=tone=>tone==='rank-positive'?'text-positive':tone==='rank-negative'?'text-negative':'';

/* ── RR trend ─────────────────────────────────────────────── */
export function RRTrendChart({matches,range,PUUID,PLAYER,TAG}){
  const [ref,measured]=useElementWidth();
  const [active,setActive]=useState(null);
  const compact=useIsMobile();
  const showDuos=range!=='all';
  const scoped=rrTrendScopedMatches(matches);
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
  // Rank labels on the left axis, dates along the bottom.
  const left=compact?58:70,right=compact?10:16,top=14,bottom=190,height=214;
  const width=Math.max(left+right+2,measured||872);
  const values=points.map(p=>p.value);
  const low=Math.min(...values),high=Math.max(...values);
  // The axis spans the ranks played, padded to the nearest 50 RR.
  const min=Math.max(0,Math.floor((low-15)/50)*50),max=Math.max(min+50,Math.ceil((high+15)/50)*50);
  const x=i=>points.length===1?left+(width-left-right)/2:left+i*(width-left-right)/(points.length-1);
  const y=value=>bottom-(value-min)/(max-min)*(bottom-top);
  const spacing=points.length>1?(width-left-right)/(points.length-1):width-left-right;
  const radiantChartFloor=2100+300; // Visual guide only; the tooltip uses each match's recorded tier.
  const immortalPoints=points.filter(p=>p.value>=2100&&p.value<radiantChartFloor&&p.match.myPostTierId>=24&&p.match.myPostTierId<27).sort((a,b)=>a.value-b.value);
  const tierAt=value=>{
    if(value<2100)return rrPositionFromElo(value).tier;
    if(value>=radiantChartFloor)return 27;
    if(!immortalPoints.length)return 24;
    return immortalPoints.reduce((best,p)=>Math.abs(p.value-value)<Math.abs(best.value-value)?p:best).match.myPostTierId;
  };
  const boundaries=new Set([min,max]);
  for(let value=Math.ceil(min/100)*100;value<max&&value<=2100;value+=100)boundaries.add(value);
  if(radiantChartFloor>min&&radiantChartFloor<max)boundaries.add(radiantChartFloor);
  immortalPoints.slice(1).forEach((p,index)=>{
    const previous=immortalPoints[index];
    if(p.match.myPostTierId!==previous.match.myPostTierId){
      const boundary=(p.value+previous.value)/2;
      if(boundary>min&&boundary<max)boundaries.add(boundary);
    }
  });
  const edges=[...boundaries].sort((a,b)=>a-b);
  const bands=[];
  for(let i=0;i<edges.length-1;i++){
    const start=edges[i],end=edges[i+1],tier=tierAt((start+end)/2),previous=bands.at(-1);
    if(previous?.tier===tier)previous.end=end;
    else bands.push({start,end,tier});
  }
  // Rank boundaries are the reference lines; each band is labelled on the axis.
  const rankLines=edges.filter(value=>value>min&&value<max);
  const line=points.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dateLabel=m=>Number.isFinite(m.startedAtMs)?new Date(m.startedAtMs).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'Date unavailable';
  const matchLabel=m=>[m.mapName??m.map,Number.isInteger(m.myR)&&Number.isInteger(m.opR)?`${m.myR}–${m.opR}`:null].filter(Boolean).join(', ');
  const dateTicks=(points.length>1?[0,...(width>=520&&points.length>2?[Math.round((points.length-1)/2)]:[]),points.length-1]:[0])
    .map(i=>({i,label:dateLabel(points[i].match),anchor:i===0?'start':i===points.length-1?'end':'middle'}));
  const last=points.length-1,end=points[last],endRank=rrPositionFromElo(end.value,end.match.myPostTierId);
  // The end label sits above the line's recent peak so it never covers it.
  const tail=points.slice(Math.max(0,Math.floor(points.length*.85)));
  const endLabelY=Math.max(top+10,Math.min(...tail.map(p=>y(p.value)))-10);
  const tip=active!=null?(()=>{
    const {match,value}=points[active],rank=rrPositionFromElo(value,match.myPostTierId);
    const duo=duoInfos[active],run=duoRunAt[active];
    return{match,rank,duo,run,xx:x(active),yy:y(value)};
  })():null;
  const pointerMove=event=>{
    const bounds=event.currentTarget.getBoundingClientRect();
    const plotX=(event.clientX-bounds.left)*width/bounds.width;
    if(plotX<left||plotX>width-right){setActive(null);return;}
    setActive(points.length===1?0:Math.max(0,Math.min(points.length-1,Math.round((plotX-left)/spacing))));
  };
  return (
    <div ref={ref} className="relative" role="region" aria-label="RR trend across matches" tabIndex={0}>
      <svg className="chart-svg rr-trend-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        aria-label={`Rank and RR trend across ${points.length} matches, net ${rrSigned(running,0)} RR${duoCount?`; ${duoCount} duo games net ${rrSigned(duoNet,0)} RR`:''}`}
        onPointerMove={pointerMove} onPointerDown={pointerMove} onPointerLeave={()=>setActive(null)} style={{touchAction:'pan-y'}}>
        {bands.map(({start,end,tier})=>{
          const bandTop=y(end),bandHeight=y(start)-bandTop;
          if(bandHeight<14)return null;
          const mid=bandTop+bandHeight/2;
          return (
            <g key={start} aria-hidden="true">
              {RANK_ICONS[tier]&&<image href={RANK_ICONS[tier]} x={4} y={mid-8} width={16} height={16}/>}
              <text x={24} y={mid+4} className="rank-tick">{avgLabelShort(tier)}</text>
            </g>
          );
        })}
        {rankLines.map(value=><line key={value} className="grid" x1={left} y1={y(value)} x2={width-right} y2={y(value)}/>)}
        <line className="baseline" x1={left} y1={bottom} x2={width-right} y2={bottom}/>
        {dateTicks.map(({i,label,anchor})=><text key={i} x={x(i)} y={bottom+17} textAnchor={anchor} aria-hidden="true">{label}</text>)}
        {duoRuns.map(run=>{
          const inset=Math.min(3,spacing/4);
          const start=Math.max(left,x(run.start)-spacing/2+inset),end=Math.min(width-right,x(run.end)+spacing/2-inset),bandWidth=end-start;
          if(run.count<3||bandWidth<35)return null;
          return <rect key={run.start} className="duo-band" x={start} y={top} width={bandWidth} height={bottom-top} aria-hidden="true"/>;
        })}
        {points.length>1&&<path className="area" d={`${line} L${x(points.length-1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`}/>}
        {points.length>1&&<path className="line" d={line}/>}
        {showDuos&&points.map(({match,value},i)=>(
          <circle key={i} className={`result-point ${match.won===true?'win':match.won===false?'loss':'draw'}`} cx={x(i)} cy={y(value)} r={Math.max(3,Math.min(4,spacing/3))} aria-hidden="true"/>
        ))}
        {!tip&&(
          <g aria-hidden="true">
            <circle className="end-point" cx={x(last)} cy={y(end.value)} r={4.5}/>
            <text x={x(last)} y={endLabelY} textAnchor="end" className="ink-strong">{avgLabelShort(endRank.tier)}, {endRank.rr} RR</text>
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
            <circle className="cursor-point" cx={tip.xx} cy={tip.yy} r={5}/>
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
          <div className="tt-value">{rrSigned(tip.match.myRR,0)} RR</div>
          <div className="tt-row"><span className="tt-key" style={{background:tip.match.won===true?'var(--chart-win)':tip.match.won===false?'var(--chart-loss)':'var(--chart-draw)'}}/>
            {tip.match.won===true?'Win':tip.match.won===false?'Loss':'Draw'}{matchLabel(tip.match)?` on ${matchLabel(tip.match)}`:''}</div>
          <div className="tt-row"><RankIcon tier={tip.rank.tier} size={14}/>{avgLabel(tip.rank.tier)}, {tip.rank.rr} RR after</div>
          {tip.duo&&<div className="tt-muted">{tip.duo.label}{tip.run?`, ${rrSigned(tip.run.net,0)} RR across ${tip.run.count} games`:''}</div>}
          <div className="tt-muted">Match {active+1} of {points.length}, {dateLabel(tip.match)}</div>
        </ChartTooltip>
      )}
    </div>
  );
}

function RRSummary({matches,net}){
  const summary=computeRRStats(matches);
  const record=(
    <span aria-label={`${summary.wins} wins, ${summary.losses} losses${summary.draws?`, ${summary.draws} draws`:''}`}>
      {summary.wins}<span className="text-muted-foreground">–</span>{summary.losses}{summary.draws>0&&<><span className="text-muted-foreground">–</span>{summary.draws}</>}
    </span>
  );
  return (
    <StatStrip label="RR summary for selected match range" items={[
      ['Net RR',net==null?'—':`${rrSigned(net,0)}`,net==null?'text-muted-foreground':toneClass(net,0)],
      ['RR / Win',summary.avgGain==null?'—':rrSigned(summary.avgGain,1),summary.avgGain==null?'':'text-positive'],
      ['RR / Loss',summary.avgLoss==null?'—':rrSigned(-summary.avgLoss,1),summary.avgLoss==null?'':'text-negative'],
      [summary.draws?'W–L–D':'W–L',record,'',`${summary.wins} wins, ${summary.losses} losses${summary.draws?`, ${summary.draws} draws`:''}`],
      ['Win rate',winRateLabel(summary.winRate),''],
    ]}/>
  );
}

function RRBonusNote({matches}){
  const reported=rrReportedStats(matches);
  return (
    <p className="-mt-3 text-xs text-muted-foreground" aria-live="polite">
      {reported.covered
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
  const evenText=even?`Wins and losses pay about the same from a starting rank of ${evenLabel} (about ${even.payout.toFixed(1)} RR each). Below it wins pay more than losses cost; above it losses cost more. Each 100 RR higher, wins pay ${Math.abs(even.winSlope*100).toFixed(1)} RR ${even.winSlope<0?'less':'more'} and losses cost ${Math.abs(even.lossSlope*100).toFixed(1)} RR ${even.lossSlope>0?'more':'less'}. Fitted on ${even.wins} wins and ${even.losses} losses.`:null;
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
          {evenText&&<p className="text-sm text-muted-foreground" data-even-point>{evenText}</p>}
          {compact&&tierGroups.length>1&&(
            <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]" role="group" aria-label="Zoom to a starting rank">
              {[null,...tierGroups.map(group=>group.tier)].map(tier=>{
                const on=(zoomTier??null)===tier;
                return (
                  <button key={tier??'all'} type="button" aria-pressed={on} onClick={()=>setRRMovementZoomTier(tier)}
                    className={cn('inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors',on?'border-foreground/30 bg-accent text-foreground':'text-muted-foreground active:bg-accent')}>
                    {tier!=null&&<RankIcon tier={tier} size={14}/>}{tier==null?'All ranks':avgLabelShort(tier)}
                  </button>
                );
              })}
            </div>
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
                    const detail=`Estimated RR / ${won?'win':'loss'}: ${won?'+':'−'}${estimate.payout.toFixed(1)} RR. ${estimate.n} nearby ${won?'wins':'losses'} from ${rangeStart} to ${rangeEnd}. Act average: ${estimate.actMean.toFixed(1)} RR.`;
                    return <circle key={estimate.position} cx={x(estimate.axisPosition)} cy={y(estimate.payout)} r={6} className="estimate-hit-area" tabIndex={0} role="img" aria-label={detail}/>;
                  })}
                </g>
              ))}
              {ends.map(end=><text key={end.kind} x={end.x} y={end.y} className="series-label" aria-hidden="true">{end.label}</text>)}
            </svg>
          </div>
          </ChartFrame>
          <p className="text-xs text-muted-foreground">Estimates use 3–5 nearby wins or losses within 30 RR, blended with the act average. Gaps mean sparse data; faint dots are individual matches.{even?' The even point comes from straight-line fits of every win and loss in range (party-penalized games left out); it usually marks where your rank met your hidden MMR this act, which Riot does not show.':''}</p>
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
    <SortableTable id="rr-rank-table" rows={tableRows} values={values} caption={`Matches grouped by your rank in each match. ${RR_SCOPE}`}
      columns={[{label:'Player rank'},{label:'Games',title:'All matches in this act, including games without RR payouts'},{label:'K/D'},{label:'ACS',title:'Average combat score'},
        {label:'PS',title:'Avg PS across matches with available data'},{label:'WR%',title:'Wins divided by wins plus losses across all games; draws excluded'},
        {label:'RR / Win',title:'Average recorded RR from eligible wins; excludes placements, unrated ranks and full 5-stacks'},
        {label:'RR / Loss',title:'Average recorded RR from eligible losses; excludes placements, unrated ranks and full 5-stacks'}]}
      maxima={[{column:2,label:'K/D'},{column:3,label:'ACS'},{column:4,label:'Avg PS'},{column:5,label:'win rate'},{column:6,label:'RR per win'}]}/>
  );
}

function RRScoreTable({matches}){
  const rows=buildRRScoreRows(matches);
  if(!rows.length)return <p className="px-6 py-4 text-sm text-muted-foreground">No wins or losses with both a recorded score and eligible RR yet.</p>;
  const tableRows=rows.map(({high,low,margin,stats:s})=>({key:`${high}-${low}`,cells:[
    `${high}–${low}`,margin,s.wins,s.avgGain==null?'—':rrSigned(s.avgGain,1),s.losses,s.avgLoss==null?'—':rrSigned(-s.avgLoss,1),
  ],cellProps:[null,null,null,{className:'text-positive'},null,{className:'text-negative'}]}));
  const values=rows.map(({high,low,margin,stats:s})=>[high*1000+low,margin,s.wins,s.avgGain,s.losses,s.avgLoss==null?null:-s.avgLoss]);
  return (
    <SortableTable id="rr-score-table" rows={tableRows} values={values}
      caption="Average recorded RR by exact scoreline, grouped from closest to widest round margin. Scorelines show the winning team's rounds first."
      columns={[{label:'Scoreline'},{label:'Round margin'},{label:'Wins'},{label:'RR / Win'},{label:'Losses'},{label:'RR / Loss'}]}
      maxima={[{column:2,label:'wins'},{column:3,label:'RR per win'},{column:4,label:'losses'},{column:5,label:'RR retained on a loss'}]}/>
  );
}

export function ScoreMarginChart({matches}){
  const [active,setActive]=useState(null);
  const scrollRef=useRef(null);
  const compact=useIsMobile();
  const {bins,total}=scoreMarginDistribution(matches);
  if(!total)return null;
  const width=compact?360:900,height=compact?260:300,left=compact?34:48,right=compact?8:22,top=compact?28:30,bottom=compact?50:58;
  const plotWidth=width-left-right,plotBottom=height-bottom,plotHeight=plotBottom-top;
  const maxCount=Math.max(...bins.map(b=>b.count)),step=Math.max(1,Math.ceil(maxCount/4));
  const ceiling=Math.ceil(maxCount/step)*step,slot=plotWidth/bins.length;
  const y=count=>plotBottom-count/ceiling*plotHeight;
  const ticks=[];
  for(let count=0;count<=ceiling;count+=step)ticks.push(count);
  // Bars stay thin (<=24px) with air between them; only the tallest win and
  // loss bars carry a number, the rest are in the tooltip and aria-label.
  const barWidth=Math.min(24,slot*.72);
  // Phones: label every 1st, 2nd or 4th margin so labels stay ~30px apart.
  const labelStep=[1,2,4,8].find(step=>slot*step>=30)||8;
  const peak=sign=>bins.filter(b=>Math.sign(b.margin)===sign&&b.count>0).reduce((best,b)=>best==null||b.count>best.count?b:best,null)?.margin;
  const labelled=new Set([peak(1),peak(-1)].filter(v=>v!=null));
  const center=index=>left+(index+.5)*slot;
  const svgBox=scrollRef.current?.querySelector('svg')?.getBoundingClientRect();
  const activeBin=active!=null?bins[active]:null;
  const tipLeft=activeBin?center(active)*(svgBox?svgBox.width/width:1)-(scrollRef.current?.scrollLeft||0):null;
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
          <div ref={scrollRef} className={compact?undefined:'overflow-x-auto'} role="region" aria-label="Match counts by round margin" tabIndex={0} onScroll={()=>setActive(null)}>
            <svg className={cn('chart-svg',compact?'compact':'min-w-[600px]',active!=null&&'has-active')} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Match counts by round margin"
              onPointerLeave={()=>setActive(null)}>
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
                const detail=describe(bin),barTop=y(bin.count),barHeight=plotBottom-barTop,on=active===index;
                return (
                  <g key={bin.margin}>
                    <rect x={cx-slot/2} y={top} width={slot} height={plotHeight} className="hit" onPointerEnter={()=>setActive(bin.count>0?index:null)} aria-hidden="true"/>
                    {bin.count>0&&(
                      <>
                        <rect x={cx-barWidth/2} y={barTop} width={barWidth} height={barHeight} rx={Math.min(4,barHeight/2)}
                          className={cn('bar',kind,on&&'active')} tabIndex={0} role="img" aria-label={detail}
                          onPointerEnter={()=>setActive(index)} onFocus={()=>setActive(index)} onBlur={()=>setActive(null)}/>
                        {barHeight>4&&<rect x={cx-barWidth/2} y={plotBottom-4} width={barWidth} height={4} className={cn('bar-foot',kind,on&&'active')} aria-hidden="true"/>}
                        {labelled.has(bin.margin)&&<text x={cx} y={barTop-7} textAnchor="middle" className="value">{bin.count}</text>}
                      </>
                    )}
                    {(!compact||on||bin.margin%labelStep===0)&&<text x={cx} y={plotBottom+22} textAnchor="middle" className={on?'ink-strong':undefined}>{label}</text>}
                  </g>
                );
              })}
              <text x={left+plotWidth/2} y={height-8} textAnchor="middle">{compact?'Round margin (yours − enemy)':'Round margin (your rounds minus enemy rounds)'}</text>
            </svg>
          </div>
          {activeBin&&(
            <ChartTooltip x={tipLeft} y={8} width={scrollRef.current?.clientWidth}>
              <div className="tt-value">{activeBin.count} {activeBin.count===1?'match':'matches'} <span className="tt-muted">({(100*activeBin.count/total).toFixed(1)}%)</span></div>
              <div className="tt-row"><span className="tt-key" style={{background:activeBin.margin<0?'var(--chart-loss)':activeBin.margin>0?'var(--chart-win)':'var(--chart-draw)'}}/>
                {activeBin.margin===0?'Draws':`${activeBin.margin>0?'Won':'Lost'} by ${Math.abs(activeBin.margin)} ${Math.abs(activeBin.margin)===1?'round':'rounds'}`}</div>
              {activeBin.scorelines.map(score=><div key={score.scoreline} className="tt-muted">{score.scoreline}: {score.count} {score.count===1?'match':'matches'}</div>)}
            </ChartTooltip>
          )}
          </ChartFrame>
          <p className="text-xs text-muted-foreground">Your rounds minus enemy rounds, for all scored matches this act, including placements. Regulation 13–11 and overtime share ±2; draws sit at 0. Hover or focus for exact scorelines.</p>
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
  const range=s.rrTrendRange;
  const scoped=rrTrendScopedMatches(matches);
  const running=scoped.filter(m=>Number.isFinite(m.myRR)&&Number.isFinite(m.myPostRR)).reduce((sum,m)=>sum+m.myRR,0);
  const anyTrend=scoped.some(m=>Number.isFinite(m.myRR)&&Number.isFinite(m.myPostRR));
  return (
    <main aria-labelledby="rr-title" className="space-y-6">
      <PageHeading id="rr-title" title="RR Breakdown"/>
      {hasRR&&(
        <>
          <PlacementToggle/>
          <section aria-labelledby="rr-trend-title">
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <div className="space-y-1.5">
                  <CardTitle><h2 id="rr-trend-title">RR trend</h2></CardTitle>
                  <CardDescription>Your total RR after each match{range==='all'?' this act':`, last ${range} matches`}.</CardDescription>
                </div>
                  <Tabs value={range} onValueChange={setRRTrendRange}>
                    <TabsList aria-label="RR trend match range">
                      <TabsTrigger value="all">All time ({matches.length})</TabsTrigger>
                      {matches.length>50&&<TabsTrigger value="50" aria-label="50 most recent matches">50</TabsTrigger>}
                      <TabsTrigger value="30" aria-label="30 most recent matches">30</TabsTrigger>
                      <TabsTrigger value="20" aria-label="20 most recent matches">20</TabsTrigger>
                    </TabsList>
                  </Tabs>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <RRSummary matches={scoped} net={anyTrend?running:null}/>
                <ChartFrame><RRTrendChart matches={matches} range={range}/></ChartFrame>
                <RRBonusNote matches={scoped}/>
              </CardContent>
            </Card>
          </section>
          <RRMovementChart matches={matches} zoomTier={s.rrMovementZoomTier}/>
          <Card className="py-2"><RRRankTable matches={matches}/></Card>
          <section aria-labelledby="rr-score-title">
            <Card className="gap-2 pb-2">
              <CardHeader>
                <CardTitle><h2 id="rr-score-title">RR by result</h2></CardTitle>
                <CardDescription>Average recorded RR by exact scoreline. Regulation and overtime results stay separate. Excludes placements, unrated ranks and full 5-stacks.</CardDescription>
              </CardHeader>
              <RRScoreTable matches={matches}/>
            </Card>
          </section>
        </>
      )}
      {hasScores&&<ScoreMarginChart matches={matches}/>}
      {!hasRR&&!hasScores&&s.analysisState!=='error'&&(
        <EmptyState>{s.analysisState==='loading'?'Loading this player’s matches…':ready?'No matches found for this season. Try another act.':'Search for a player above to explore their RR breakdown.'}</EmptyState>
      )}
    </main>
  );
}
