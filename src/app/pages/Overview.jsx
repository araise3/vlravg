import {useLayoutEffect,useRef,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {
  avgLabel,avgLabelShort,clutchTotals,computeRRStats,decidedWinRate,hexToRgb,lobbyRR,MIN_RATED,overviewRecentMatches,PARTY_LABELS,
  playerRouteUrl,rColor,rrSigned,tierRR,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {useElementWidth,useEngine,useIsMobile} from '@/app/hooks.js';
import {TABLE_CELL,TABLE_FRAME,TABLE_HEAD,TABLE_HEAD_ROW} from '@/app/data-table.jsx';
import {ChartTooltip,Hint,InlineEmpty,LobbyRankText,PageHeading,PageLink,PartyIcon,PlacementToggle,RankIcon,toneClass} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card,CardAction,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {Separator} from '@/components/ui/separator';
import {Skeleton} from '@/components/ui/skeleton';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';

// Dashboard layout from shadcn's blocks: lobby rank beside top teammates, the
// act's 4×2 stat grid, clutch stats, then the last-20 RR card. Cards link to
// the page with the full detail.

const toneOf=tone=>tone==='rank-positive'?'text-positive':tone==='rank-negative'?'text-negative':'';

function ViewLink({page,children}){
  return (
    <Button variant="outline" size="sm" asChild>
      <PageLink page={page}>{children}<ArrowUpRight aria-hidden="true"/></PageLink>
    </Button>
  );
}

// Lobby rank per party size, over exactly the rated matches in the headline
// average under the current placement choice.
function partyLobbyRanks(rated){
  const groups=new Map();
  rated.forEach(m=>{
    const size=m.partySize||1;
    if(!groups.has(size))groups.set(size,{sum:0,count:0});
    const group=groups.get(size);group.sum+=m.avgRank;group.count++;
  });
  return [...groups].sort((a,b)=>a[0]-b[0]).map(([size,{sum,count}])=>({size,count,rank:tierRR(sum/count)}));
}

// How many rated lobbies landed in each division, over every division from the
// lowest to the highest seen (gaps included, so the bars share one rank axis).
export function lobbySpread(rated){
  const counts=new Map();
  rated.forEach(m=>{const tier=tierRR(m.avgRank).tier;counts.set(tier,(counts.get(tier)||0)+1);});
  if(!counts.size)return [];
  const tiers=[...counts.keys()];
  const out=[];
  for(let tier=Math.min(...tiers);tier<=Math.max(...tiers);tier++)out.push({tier,count:counts.get(tier)||0});
  return out;
}

const lobbiesText=n=>`${n} ${n===1?'lobby':'lobbies'}`;

// A small uppercase section label inside the lobby rank card.
function SectionLabel({children}){
  return <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</div>;
}

// One slim bar per division between the lowest and highest lobby, each in its
// own rank colour (Ascendant green, Immortal red, …): the average's division
// solid, the others faint. (One shared hue was tried and dropped: an Immortal
// average painted its Ascendant bars red.) Labels under
// every bar when they fit, else only the ends and the average.
function LobbySpread({spread,avgTier}){
  const max=Math.max(...spread.map(d=>d.count));
  const labelAll=spread.length<=8;
  return (
    <div className="flex flex-col gap-3" data-slot="lobby-spread">
      <SectionLabel>Lobby spread</SectionLabel>
      <div className="flex flex-col gap-1.5">
        <div className="flex h-14 items-end gap-1.5" role="img"
          aria-label={'Rated lobbies by rank: '+spread.filter(d=>d.count).map(d=>`${avgLabel(d.tier)} ${d.count}`).join(', ')}>
          {spread.map(({tier,count})=>(
            <div key={tier} className="flex h-full min-w-0 flex-1 items-end" title={`${avgLabel(tier)}: ${lobbiesText(count)}`}>
              <div className={cn('w-full rounded-sm',count?'':'bg-muted')}
                style={{height:count?`${Math.max(10,Math.round(count/max*1000)/10)}%`:3,...(count?{background:rColor(tier),opacity:tier===avgTier?1:.35}:{})}}/>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5 text-[10px] leading-none text-muted-foreground tabular-nums" aria-hidden="true">
          {spread.map(({tier},i)=>(
            <span key={tier} className={cn('min-w-0 flex-1 text-center whitespace-nowrap',tier===avgTier&&'font-semibold text-foreground')}>
              {labelAll||tier===avgTier||i===0||i===spread.length-1?avgLabelShort(tier):''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// The site's namesake: the average lobby rank as a rank-tinted hero (badge,
// division, RR into the division on a Progress bar), the spread of lobbies
// across divisions, then a table row per party size played. Beside the top
// party teammates.
export function LobbyRankCard({s}){
  const o=s.overviewStats;
  const rated=s.statMatches.filter(m=>m.avgRank!=null);
  const parties=partyLobbyRanks(rated);
  const rank=o.overallRR;
  // Immortal+ averages have no 100-RR division, so no RR figure or bar (see lobbyRR).
  const rr=lobbyRR(rank);
  const color=rank?rColor(rank.tier):null;
  const rgb=color&&hexToRgb(color).replaceAll(',',' ');
  const spread=lobbySpread(rated);
  const partyName=size=>PARTY_LABELS[size]||size+'-Stack';
  return (
    <Card className="relative gap-5 overflow-hidden py-5" aria-labelledby="overview-lobby-title" data-slot="lobby-rank-card"
      style={rgb?{'--lobby-rank':color,backgroundImage:`radial-gradient(120% 70% at 0% 0%, rgb(${rgb} / .14), transparent 60%)`}:undefined}>
      {rgb&&<div className="pointer-events-none absolute inset-x-0 top-0 h-px" aria-hidden="true"
        style={{background:`linear-gradient(90deg, rgb(${rgb} / .9), rgb(${rgb} / .15) 70%, transparent)`}}/>}
      <CardHeader className="px-5">
        <CardTitle><h2 id="overview-lobby-title">Avg lobby rank</h2></CardTitle>
        <CardAction><ViewLink page="lobby-rank">Lobby Rank</ViewLink></CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5 px-5">
        {rank
          ?<div className="flex items-center gap-4" data-slot="lobby-rank-hero">
            <div className="relative grid size-[72px] shrink-0 place-items-center" aria-hidden="true">
              <div className="absolute inset-1 rounded-full bg-(--lobby-rank) opacity-25 blur-xl"/>
              <RankIcon tier={rank.tier} size={64} className="relative drop-shadow-[0_6px_10px_rgb(0_0_0/.45)]"/>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="truncate text-3xl leading-none font-semibold tracking-tight" style={{color}}>{avgLabel(rank.tier)}</span>
                {rr!=null&&<span className="shrink-0 text-sm leading-none text-muted-foreground tabular-nums"><span className="text-lg font-semibold text-foreground">{rr}</span> RR</span>}
              </div>
              {rr!=null&&<Progress value={rr} className="h-1.5 bg-(--lobby-rank)/15" indicatorClassName="rounded-full bg-(--lobby-rank)"
                aria-label={`${rr} of 100 RR into ${avgLabel(rank.tier)}`}/>}
              <div className="text-xs text-muted-foreground tabular-nums">
                Across <Hint content={`Lobbies with at least ${MIN_RATED} rated players; the average counts rated players only`}>{rated.length} rated {rated.length===1?'lobby':'lobbies'}</Hint>
              </div>
            </div>
          </div>
          :<InlineEmpty>No rated lobbies yet</InlineEmpty>}
        {rank&&(spread.length>1||parties.length>0)&&<Separator/>}
        {spread.length>1&&<LobbySpread spread={spread} avgTier={rank?.tier}/>}
        {parties.length>0&&(
          <div className="flex flex-col gap-3">
            <SectionLabel>By party size</SectionLabel>
            <div className={cn(TABLE_FRAME,'@container rounded-lg')} data-slot="lobby-party-table">
              <Table className="tabular-nums">
                <TableHeader>
                  <TableRow className={TABLE_HEAD_ROW}>
                    <TableHead className={TABLE_HEAD}>Party</TableHead>
                    <TableHead className={TABLE_HEAD}>Lobby rank</TableHead>
                    <TableHead className={cn(TABLE_HEAD,'text-right @max-[19rem]:hidden')}>Lobbies</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parties.map(({size,count,rank:r})=>(
                    <TableRow key={size} title={`${partyName(size)}: ${avgLabel(r.tier)} across ${lobbiesText(count)}`}>
                      <TableCell className={cn(TABLE_CELL,'text-muted-foreground')}>
                        <span className="flex items-center gap-1.5 whitespace-nowrap"><PartyIcon size={size}/>{partyName(size)}</span>
                        {/* A narrow table (phones, the two-column card on tablets) drops the Lobbies
                            column and the long rank label: the count goes under the party label. */}
                        <span className="block text-xs @min-[19rem]:hidden">{lobbiesText(count)}</span>
                      </TableCell>
                                            <TableCell className={cn(TABLE_CELL,'w-full max-w-0 font-medium')}>
                        <span className="flex min-w-0 items-center gap-2">
                          <RankIcon tier={r.tier} size={18}/>
                          <LobbyRankText tier={r.tier} className="flex min-w-0">
                            <span className="truncate @max-[19rem]:hidden">{avgLabel(r.tier)}</span><span className="truncate @min-[19rem]:hidden">{avgLabelShort(r.tier)}</span>
                          </LobbyRankText>
                        </span>
                      </TableCell>
                      <TableCell className={cn(TABLE_CELL,'text-right text-muted-foreground @max-[19rem]:hidden')}>{count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The lobby rank card beside the top party teammates.
export function KpiCards({s}){
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" role="group" aria-label="Key figures this act" data-slot="kpi-cards">
      <LobbyRankCard s={s}/>
      <TeammatesCard teammates={s.allTeammates||[]}/>
    </div>
  );
}

// The act's eight headline numbers in one 4×2 grid (2×4 on phones).
export function ActStatsCard({s}){
  const o=s.overviewStats;
  const wins=s.allMatches.filter(m=>m.won===true).length,losses=s.allMatches.filter(m=>m.won===false).length;
  const draws=s.allMatches.length-wins-losses;
  const items=[
    ['K/D',o.kd],['Avg ACS',o.acs],['Avg PS',o.performance,o.performanceTitle],
    ['Avg ADR',o.adr,'Damage to enemies per round; friendly fire and self-damage excluded'],
    ['KAST',o.kast,o.kastTitle],['Playtime',o.playtime.value,o.playtime.title],
    ['Matches',s.allMatches.length,null,`${wins}W ${losses}L${draws?` ${draws}D`:''}`],
    ['Win rate',winRateLabel(decidedWinRate(wins,wins+losses)),'Wins divided by wins plus losses; draws excluded'],
  ];
  return (
    <Card className="gap-4" aria-labelledby="overview-stats-title">
      <CardHeader>
        <CardTitle><h2 id="overview-stats-title">Act stats</h2></CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4" aria-label="Basic statistics for all matches in this act">
          {items.map(([label,value,title,note])=>(
            <div key={label} className="min-w-0 bg-card px-4 py-3.5 max-sm:px-3.5 max-sm:py-3">
              <dt className="text-xs text-muted-foreground"><Hint content={title}>{label}</Hint></dt>
              <dd className="mt-1.5 flex items-baseline gap-2 text-2xl leading-none font-semibold whitespace-nowrap tabular-nums max-sm:text-xl">
                {value}{note&&<span className="text-xs font-normal text-muted-foreground">{note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// The recent window as a cumulative RR line, one dot per match coloured by
// result, then the per-win/per-loss averages and the RR gained and lost. The
// RR page keeps the full rank-axis chart and the longer ranges.
const RESULT_LABEL={win:'Win',loss:'Loss',draw:'Draw'};
const resultOf=m=>m.won===true?'win':m.won===false?'loss':'draw';

export function RecentRRCard({matches}){
  const [ref,measured]=useElementWidth();
  const [active,setActive]=useState(null);
  const ordered=matches.filter(m=>Number.isFinite(m.myRR)).sort((a,b)=>(a.startedAtMs||0)-(b.startedAtMs||0));
  const rr=computeRRStats(matches);
  const gained=ordered.reduce((sum,m)=>sum+Math.max(0,m.myRR),0);
  const lost=ordered.reduce((sum,m)=>sum+Math.min(0,m.myRR),0);
  const net=ordered.length?gained+lost:null;
  // The line starts at 0 before the oldest match and steps once per match.
  let running=0;
  const points=[{match:null,value:0},...ordered.map(m=>({match:m,value:running+=m.myRR}))];
  const width=Math.max(120,measured||640),height=112,left=6,right=6,top=10,bottom=height-10;
  const values=points.map(p=>p.value);
  const low=Math.min(...values),span=Math.max(1,Math.max(...values)-low);
  const spacing=(width-left-right)/Math.max(1,points.length-1);
  const x=i=>left+i*spacing;
  const y=value=>bottom-(value-low)/span*(bottom-top);
  const line=points.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const pointerMove=event=>{
    const bounds=event.currentTarget.getBoundingClientRect();
    const plotX=(event.clientX-bounds.left)*width/bounds.width;
    setActive(Math.max(1,Math.min(points.length-1,Math.round((plotX-left)/spacing))));
  };
  const tip=active!=null?points[active]?.match&&points[active]:null;
  const date=m=>Number.isFinite(m.startedAtMs)?new Date(m.startedAtMs).toLocaleDateString(undefined,{month:'short',day:'numeric'}):null;
  const figures=[
    ['Avg gain',rr.avgGain==null?'—':rrSigned(rr.avgGain,1),rr.avgGain!=null&&'text-positive',`${rr.wins} ${rr.wins===1?'win':'wins'}`],
    ['Avg loss',rr.avgLoss==null?'—':rrSigned(-rr.avgLoss,1),rr.avgLoss!=null&&'text-negative',`${rr.losses} ${rr.losses===1?'loss':'losses'}`],
    ['RR gained',rrSigned(gained,0),gained>0&&'text-positive'],
    ['RR lost',`−${Math.abs(lost).toFixed(0)}`,lost<0&&'text-negative'],
  ];
  return (
    <Card className="gap-4" aria-labelledby="overview-rr-title">
      <CardHeader>
        <CardTitle><h2 id="overview-rr-title">RR trend, last {matches.length} {matches.length===1?'match':'matches'}</h2></CardTitle>
        {net!=null&&(
          <CardAction className={cn('text-lg leading-none font-semibold tabular-nums',toneClass(net,0))}>
            <Hint content={`Net RR across the ${ordered.length} of ${matches.length} matches with a recorded change`}>{rrSigned(net,0)} RR</Hint>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {ordered.length
          ?<div ref={ref} className="relative" data-slot="recent-rr-line">
            <svg className="chart-svg rr-trend-svg block w-full" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
              role="img" aria-label={`Cumulative RR across ${ordered.length} matches, net ${rrSigned(net,0)} RR`}
              onPointerMove={pointerMove} onPointerDown={pointerMove} onPointerLeave={()=>setActive(null)} style={{touchAction:'pan-y'}}>
              <defs>
                <linearGradient id="recent-rr-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--series-1)" stopOpacity=".2"/>
                  <stop offset="1" stopColor="var(--series-1)" stopOpacity="0"/>
                </linearGradient>
              </defs>
              <path d={`${line} L${x(points.length-1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`} fill="url(#recent-rr-fill)"/>
              <path className="line" d={line}/>
              {tip&&<line className="hover-line" x1={x(active)} y1={top} x2={x(active)} y2={bottom}/>}
              {points.map(({match,value},i)=>match&&(
                <circle key={match.matchId??i} className={`result-point ${resultOf(match)}`} cx={x(i)} cy={y(value)} r={i===active?5:Math.max(3,Math.min(4,spacing/3))}/>
              ))}
            </svg>
            {tip&&(
              <ChartTooltip x={x(active)} y={Math.max(0,y(tip.value)-40)} width={width}>
                <div className="tt-value">{rrSigned(tip.match.myRR,0)} RR</div>
                <div className="tt-row"><span className="tt-key" style={{background:`var(--chart-${resultOf(tip.match)})`}}/>
                  {RESULT_LABEL[resultOf(tip.match)]}{tip.match.mapName?` on ${tip.match.mapName}`:''}{Number.isInteger(tip.match.myR)&&Number.isInteger(tip.match.opR)?`, ${tip.match.myR}–${tip.match.opR}`:''}</div>
                <div className="tt-muted">{rrSigned(tip.value,0)} RR so far, match {active} of {ordered.length}{date(tip.match)?`, ${date(tip.match)}`:''}</div>
              </ChartTooltip>
            )}
          </div>
          :<InlineEmpty>No recorded RR changes in these matches</InlineEmpty>}
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4" aria-label="RR over the recent matches">
          {figures.map(([label,value,className,note])=>(
            <div key={label} className="min-w-0 bg-card px-4 py-3 max-sm:px-3.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1.5 flex items-baseline gap-2 text-xl leading-none font-semibold whitespace-nowrap tabular-nums">
                <span className={className||undefined}>{value}</span>{note&&<span className="text-xs font-normal text-muted-foreground">{note}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{ordered.length<matches.length?`${ordered.length} of ${matches.length} matches have a recorded RR change. `:''}Averages skip placements and 5-stacks.</p>
      </CardContent>
    </Card>
  );
}

// How many whole table rows fit in a box: its height minus the header and the
// frame's borders, over one body row's height; at least `min`. Re-measured
// whenever the box resizes. Server render and phones keep `min`.
export const TEAMMATES_MIN_ROWS=4;
function useRowsThatFit(min){
  const ref=useRef(null);
  const [fit,setFit]=useState(min);
  useLayoutEffect(()=>{
    const box=ref.current;
    if(!box||typeof ResizeObserver==='undefined')return;
    const measure=()=>{
      const head=box.querySelector('thead')?.getBoundingClientRect().height||0;
      const row=box.querySelector('tbody tr')?.getBoundingClientRect().height;
      if(!row)return;
      setFit(Math.max(min,Math.floor((box.clientHeight-head-2)/row)));
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(box);
    return()=>observer.disconnect();
  },[min]);
  return [ref,fit];
}

// The top party teammates, one row each, beside the lobby rank card. From sm
// up the two cards share a row, so the list takes the height the lobby card
// sets and shows as many teammates as fit (at least four); its own content
// sits out of flow there, so it never makes the row taller. Phones stack the
// cards and show four.
export function TeammatesCard({teammates}){
  const [fitRef,fit]=useRowsThatFit(TEAMMATES_MIN_ROWS);
  const top=teammates.slice(0,fit);
  return (
    <Card className="gap-4 py-5" aria-labelledby="overview-duos-title">
      <CardHeader className="px-5">
        <CardTitle><h2 id="overview-duos-title">Top teammates</h2></CardTitle>
        <CardAction><ViewLink page="duos">Duos</ViewLink></CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-5">
        {top.length
          ?<div ref={fitRef} className="relative sm:min-h-52 sm:flex-1" data-slot="teammates-fit">
          <div className={cn(TABLE_FRAME,'rounded-lg sm:absolute sm:inset-x-0 sm:top-0')}>
            <Table className="tabular-nums">
              <TableHeader>
                <TableRow className={TABLE_HEAD_ROW}>
                  <TableHead className={TABLE_HEAD}>Teammate</TableHead>
                  <TableHead className={cn(TABLE_HEAD,'text-right')}>Matches</TableHead>
                  <TableHead className={cn(TABLE_HEAD,'text-right')}><Hint content="Wins divided by wins plus losses; draws excluded">Win rate</Hint></TableHead>
                  <TableHead className={cn(TABLE_HEAD,'text-right')}><Hint content="Your net RR change in matches with this teammate">RR</Hint></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {top.map(t=>{
                  const wr=decidedWinRate(t.wins,t.decided);
                  return (
                    <TableRow key={t.key}>
                      <TableCell className={cn(TABLE_CELL,'w-full max-w-0')}>
                        <a href={playerRouteUrl(t.name,t.tag)} title={t.name+'#'+t.tag} className="block truncate font-medium hover:underline">
                          {t.name}<span className="font-normal text-muted-foreground"> #{t.tag}</span>
                        </a>
                      </TableCell>
                      <TableCell className={cn(TABLE_CELL,'text-right text-muted-foreground')}>{t.games}</TableCell>
                      <TableCell className={cn(TABLE_CELL,'text-right',toneOf(winRateTone(wr)))}>{winRateLabel(wr)}</TableCell>
                      <TableCell className={cn(TABLE_CELL,'text-right font-medium',t.rrCount?toneClass(t.rrTotal,0):'text-muted-foreground')}
                        title={`${t.rrCount} of ${t.games} shared matches have a recorded RR change`}>{t.rrCount?rrSigned(t.rrTotal,0):'—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          </div>
          :<InlineEmpty>No party teammates this act</InlineEmpty>}
      </CardContent>
    </Card>
  );
}

function clutchSummary(matches){
  const totals=clutchTotals(matches);
  let win=0,loss=0,save=0;
  Object.values(totals).forEach(t=>{win+=t.win;loss+=t.loss;save+=t.save;});
  return {totals,win,loss,save,total:win+loss+save};
}

// The pre-React tile colours, restored on request (17 Nov 2026): vlr.gg's
// multi-kill progression applied to clutch difficulty, 1v1 green through 1v5
// purple. Tiles without situations stay neutral.
export const CLUTCH_COLORS={1:'#22c55e',2:'#14b8a6',3:'#3b82f6',4:'#6366f1',5:'#a855f7'};

// Shown on the Overview (linking to the Clutches page) and at the top of the
// Clutches page itself (no link). Both pages stay mounted, so each passes its
// own heading id.
export function ClutchCard({matches,link=true,titleId='overview-clutch-title',detail=null}){
  const {totals,win,loss,save,total}=clutchSummary(matches);
  if(!total)return null;
  const pct=c=>Math.round(c/total*100);
  const segments=[['Won',win,'var(--chart-win)','Won the round — killed everyone, defused, or both'],
    ['Lost',loss,'var(--chart-loss)','Lost the round and the gun with it — died contesting it, or died to the spike'],
    ['Saved',save,'var(--chart-save)','Lost the round but survived, keeping the weapon for the next one — exit frags along the way still count as a save']];
  return (
    <Card className="gap-5" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle><h2 id={titleId}>Clutch stats</h2></CardTitle>
        {/* Phones with the link: the attempted share moves into this line so the
            header keeps the title on one line beside the button. */}
        <CardDescription>{win} won of {total} opportunities{detail&&`, ${detail}`}{link&&<span className="sm:hidden">, {pct(win+loss)}% attempted</span>}</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Hint content="Won or lost while contesting, rather than saved" className={link?'max-sm:hidden':undefined}><Badge variant="outline" className="tabular-nums">{pct(win+loss)}% attempted</Badge></Hint>
          {link&&<ViewLink page="clutches">Clutches</ViewLink>}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Clutch win rate by situation" data-slot="clutch-tiles">
          {[1,2,3,4,5].map(t=>{
            const {win:w,loss:l,save:sv}=totals[t];
            const situations=w+l+sv,rate=situations?w/situations*100:null;
            return (
              <div key={t} className={cn('flex min-w-0 flex-col gap-2.5 rounded-lg px-2.5 py-3 sm:px-4 sm:py-3.5',situations?'text-white':'border bg-muted/40 text-muted-foreground')}
                style={situations?{background:CLUTCH_COLORS[t]}:undefined}
                title={situations?`1v${t}: won ${w} of ${situations} (${Math.round(rate)}%)`:`1v${t}: no situations`}>
                <dt className={cn('text-xs font-medium',situations&&'text-white/85')}>1v{t}</dt>
                <dd className="text-lg leading-none font-semibold tabular-nums [text-shadow:0_1px_2px_rgb(0_0_0/.25)] sm:text-2xl">{rate!=null?`${Math.round(rate)}%`:'—'}</dd>
                <dd><Progress value={rate??0} className={cn('h-1.5',situations?'bg-black/20 [&>[data-slot=progress-indicator]]:bg-white':'bg-muted')} aria-label={`1v${t} clutch win rate`}/></dd>
                <dd className={cn('text-xs tabular-nums',situations?'text-white/85':'opacity-70')}>{situations?<><span className="sm:hidden">{w}/{situations}</span><span className="max-sm:hidden">{w} of {situations} won</span></>:'None'}</dd>
              </div>
            );
          })}
        </dl>
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">Outcomes</div>
          <div className="flex h-2 gap-0.5" role="img" aria-label={segments.map(([key,c])=>`${key}: ${c} (${pct(c)}%)`).join(', ')}>
            {segments.filter(([,c])=>c>0).map(([key,c,color])=><div key={key} className="min-w-0.5 rounded-full" style={{flexGrow:c,flexBasis:0,background:color}}/>)}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            {segments.map(([key,c,color,title])=>(
              <span key={key} className="inline-flex items-center gap-1.5 tabular-nums">
                <span className="size-2 rounded-full" style={{background:color}} aria-hidden="true"/><Hint content={title}>{key}</Hint> <span className="font-medium text-foreground">{c}</span> ({pct(c)}%)
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Placeholder cards in the overview's shape while matches load, so the page
// under the search is not empty: the phone stack, or on desktop the lobby and
// teammates pair above the act stats and clutch cards.
function OverviewSkeleton({mobile}){
  if(mobile)return (
    <div className="flex flex-col gap-4" aria-hidden="true" data-slot="overview-skeleton">
      <Skeleton className="h-8 w-40"/>
      <Skeleton className="h-32 rounded-xl"/>
      <Skeleton className="h-60 rounded-xl"/>
      <Skeleton className="h-44 rounded-xl"/>
    </div>
  );
  return (
    <div className="flex flex-col gap-4" aria-hidden="true" data-slot="overview-skeleton">
      <Skeleton className="h-5 w-44"/>
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-64 rounded-xl"/>
        <Skeleton className="h-64 rounded-xl"/>
      </div>
      <Skeleton className="h-48 rounded-xl"/>
      <Skeleton className="h-60 rounded-xl"/>
    </div>
  );
}

export function OverviewPage(){
  const s=useEngine();
  const mobile=useIsMobile();
  if(s.hasAnalysis&&s.analysisState==='loading')return <OverviewSkeleton mobile={mobile}/>;
  if(!s.hasAnalysis||!s.overviewStats||!s.allMatches.length||s.analysisState!=='ready')return null;
  const recent=overviewRecentMatches(s.allMatches);
  return (
    <div className="flex flex-col gap-4">
      <PageHeading id="overview-title" title="Overview"/>
      <PlacementToggle/>
      <KpiCards s={s}/>
      <ActStatsCard s={s}/>
      <ClutchCard matches={s.allMatches}/>
      <RecentRRCard matches={recent}/>
    </div>
  );
}
