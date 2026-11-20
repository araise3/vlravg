import {avgLabel,avgLabelShort,lobbyTeamsChartRows,lobbyTeamsGapLabel,PARTY_LABELS,setLobbyRankPartySize,tierRR} from '@/engine/core.mjs';
import {RANK_ICONS} from '@/engine/rank-icons.mjs';
import {useRef,useState} from 'react';
import {useEngine} from '@/app/hooks.js';
import {ChartFrame,ChartTooltip,EmptyState,PageHeading,PartySizeFilter,PlacementToggle,TableSection} from '@/app/shared.jsx';
import {PerformanceTable} from '@/app/pages/Duos.jsx';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';

// Dot plot: one row per lobby-rank group on a shared rank axis, your team's and
// the enemy team's average rated rank joined by a line, gap labelled in RR.
// Wide: label column, track, gap label in one line per group. Compact (phones):
// label and gap on one line with a full-width track beneath, so no scrolling.
function LobbyTeamsSvg({data,compact}){
  const [active,setActive]=useState(null);
  const boxRef=useRef(null);
  const values=data.flatMap(r=>[r.team,r.enemy]).filter(v=>v!=null);
  const lo=Math.floor(Math.min(...values))-.5,hi=Math.ceil(Math.max(...values))+.5;
  const width=compact?360:900,left=compact?14:196,right=compact?14:112,top=10;
  const rowHeight=compact?58:44,axis=30,plotRight=width-right,plotBottom=top+data.length*rowHeight;
  const x=v=>left+(v-lo)/(hi-lo)*(plotRight-left);
  // Whole tiers centre each division. Label every tier that fits, else every division I.
  const every=[1,3,6,9].find(step=>(plotRight-left)/(hi-lo)*step>=(compact?46:56))||12;
  const ticks=[];
  for(let tier=Math.ceil(lo);tier<=hi;tier++)if(!(tier%every))ticks.push(tier);
  const rankText=v=>{const r=tierRR(v);return `${avgLabel(r.tier)} (${r.rr} RR)`;};
  const scale=()=>{const box=boxRef.current?.querySelector('svg')?.getBoundingClientRect();return box?box.width/width:1;};
  const tip=active!=null?data[active]:null;
  const tipMid=tip?(compact?top+active*rowHeight+40:top+active*rowHeight+rowHeight/2):0;
  const tipX=tip?x(Math.max(tip.team??-Infinity,tip.enemy??-Infinity))*scale():null;
  return (
    <div ref={boxRef} className="relative" onPointerLeave={()=>setActive(null)}>
    <svg className={`chart-svg lobby-teams-svg ${compact?'compact':'wide'}`} viewBox={`0 0 ${width} ${plotBottom+axis}`} role="group"
      aria-label="Average rank of rated players on your team and the enemy team, by lobby rank">
      {ticks.map(tier=>(
        <g key={tier}>
          <line x1={x(tier)} y1={top} x2={x(tier)} y2={plotBottom} className="grid"/>
          <text x={x(tier)} y={plotBottom+18} textAnchor="middle" className="tick">{avgLabelShort(tier)}</text>
        </g>
      ))}
      {data.map((r,i)=>{
        const rowTop=top+i*rowHeight,mid=compact?rowTop+40:rowTop+rowHeight/2,labelY=compact?rowTop+17:mid-2;
        const matches=`${r.total} ${r.total===1?'match':'matches'}`;
        const detail=`${avgLabel(r.tier)} lobbies, ${matches}. `+
          `Your team: ${r.team==null?'no rated data':rankText(r.team)}. Enemy team: ${r.enemy==null?'no rated data':rankText(r.enemy)}. `+
          (r.gap==null?'':r.gap===0?'Both teams even.':`${r.gap>0?'Enemy':'Your team'} ${Math.abs(r.gap)} RR higher.`);
        const icon=RANK_ICONS[r.tier<=2?0:r.tier],size=compact?18:24,iconX=compact?2:4,textX=iconX+size+8;
        return (
          <g key={r.tier} className="row" tabIndex={0} role="img" aria-label={detail}
            onPointerEnter={()=>setActive(i)} onFocus={()=>setActive(i)} onBlur={()=>setActive(null)}>
            <rect x={0} y={rowTop+2} width={width} height={rowHeight-4} rx={6} className="row-hit"/>
            {icon&&<image href={icon} x={iconX} y={labelY-(compact?13:10)} width={size} height={size}/>}
            <text x={textX} y={labelY} className="label">{avgLabel(r.tier)}{compact&&<tspan className="count" dx={6}>{matches}</tspan>}</text>
            {!compact&&<text x={textX} y={mid+13} className="count">{matches}</text>}
            {r.team!=null&&r.enemy!=null&&<line x1={x(r.team)} y1={mid} x2={x(r.enemy)} y2={mid} className="gap"/>}
            {r.team!=null&&<circle cx={x(r.team)} cy={mid} r={6} className="dot team"/>}
            {r.enemy!=null&&<circle cx={x(r.enemy)} cy={mid} r={6} className="dot enemy"/>}
            <text x={width-4} y={compact?labelY:mid+4} textAnchor="end" className="diff">{lobbyTeamsGapLabel(r.gap)}</text>
          </g>
        );
      })}
    </svg>
    {tip&&(
      <ChartTooltip x={tipX} y={Math.max(0,tipMid*scale()-28)} width={boxRef.current?.clientWidth}>
        <div className="tt-muted">{avgLabel(tip.tier)} lobbies ({tip.total} {tip.total===1?'match':'matches'})</div>
        <div className="tt-row"><span className="tt-key" style={{background:'var(--series-1)'}}/><span className="tt-value">{tip.team==null?'—':rankText(tip.team)}</span> your team</div>
        <div className="tt-row"><span className="tt-key" style={{background:'var(--chart-loss)'}}/><span className="tt-value">{tip.enemy==null?'—':rankText(tip.enemy)}</span> enemy</div>
        {tip.gap!=null&&<div className="tt-muted">{tip.gap===0?'Both teams even':`${tip.gap>0?'Enemy':'Your team'} ${Math.abs(tip.gap)} RR higher`}</div>}
      </ChartTooltip>
    )}
    </div>
  );
}

export function LobbyRankPage(){
  const s=useEngine();
  const ready=s.analysisState==='ready';
  const hasRanks=ready&&s.allMatches.length>0&&s.lobbyRankData.length>0;
  const showFilters=ready&&s.statMatches.some(m=>m.myStats&&m.avgRank!=null&&Math.round(m.avgRank)>=3);
  const chartRows=lobbyTeamsChartRows(s.lobbyRankData).filter(r=>r.team!=null||r.enemy!=null);
  const empty=s.analysisState==='loading'?'Loading this player’s matches…':ready
    ?(s.lobbyRankPartySize&&s.lobbyRankFilteredMatchCount===0
      ?`No ${PARTY_LABELS[s.lobbyRankPartySize]||s.lobbyRankPartySize+'-Stack'} matches found for these filters.`
      :s.allMatches.length?'No rank breakdown available for these filters. Try another act or include placements.':'No matches found for this season. Try another act.')
    :'Search for a player above to explore their rank breakdown.';
  return (
    <main aria-labelledby="lobby-rank-title" className="space-y-6">
      <PageHeading id="lobby-rank-title" title="Lobby Rank"/>
      {showFilters&&(
        <div className="flex flex-wrap items-center justify-between gap-4">
          <PartySizeFilter value={s.lobbyRankPartySize} available={s.partySizeAvailability['lobby-rank-party-size']} onChange={setLobbyRankPartySize}/>
          <PlacementToggle/>
        </div>
      )}
      {hasRanks&&<TableSection label="Performance by lobby rank"><PerformanceTable id="sg-rank-overview" rows={s.lobbyRankData}/></TableSection>}
      {hasRanks&&chartRows.length>0&&(
        <section aria-labelledby="lobby-teams-title">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle><h2 id="lobby-teams-title">Team and enemy ranks</h2></CardTitle>
              <div className="flex gap-4 text-sm text-muted-foreground" aria-hidden="true">
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{background:'var(--series-1)'}}/>Your team</span>
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{background:'var(--chart-loss)'}}/>Enemy team</span>
              </div>
            </CardHeader>
            <CardContent role="region" aria-label="Average team and enemy rank by lobby" tabIndex={0}>
              <ChartFrame>
                <div className="hidden sm:block"><LobbyTeamsSvg data={chartRows}/></div>
                <div className="sm:hidden"><LobbyTeamsSvg data={chartRows} compact/></div>
              </ChartFrame>
            </CardContent>
          </Card>
        </section>
      )}
      {!hasRanks&&s.analysisState!=='error'&&<EmptyState loading={s.analysisState==='loading'}>{empty}</EmptyState>}
    </main>
  );
}
