import {ArrowUpRight,Minus,TrendingDown,TrendingUp} from 'lucide-react';
import {
  avgLabel,avgLabelShort,clutchTotals,computeRRStats,decidedWinRate,overviewRecentMatches,PARTY_LABELS,
  playerRouteUrl,rrSigned,setRRTrendRange,tierRR,winRateLabel,
} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {ChartFrame,PageHeading,PageLink,PlacementToggle,RankIcon,toneClass} from '@/app/shared.jsx';
import {RRTrendChart} from '@/app/pages/RR.jsx';
import {useMapArt} from '@/app/pages/Matches.jsx';
import {cn} from '@/lib/utils';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card,CardAction,CardContent,CardDescription,CardFooter,CardHeader,CardTitle} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {Skeleton} from '@/components/ui/skeleton';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';

// Dashboard layout from shadcn's blocks: two KPI cards (lobby rank, recent RR),
// the act's 4×2 stat grid, clutch stats, top teammates, the RR trend chart
// card, then recent matches. Cards link to the page with the full detail.

function ViewLink({page,children}){
  return (
    <Button variant="outline" size="sm" asChild>
      <PageLink page={page}>{children}<ArrowUpRight aria-hidden="true"/></PageLink>
    </Button>
  );
}

function KpiCard({label,value,valueClassName,badge,footer,note,icon}){
  return (
    <Card className="@container/card gap-4 py-5">
      <CardHeader className="px-5">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn('flex items-center gap-2.5 text-2xl font-semibold whitespace-nowrap tabular-nums @[300px]/card:text-3xl',valueClassName)}>{icon}{value}</CardTitle>
        {badge&&<CardAction><Badge variant="outline" className="tabular-nums">{badge}</Badge></CardAction>}
      </CardHeader>
      <CardFooter className="flex-col items-start gap-1 px-5 text-sm">
        <div className="line-clamp-1 font-medium">{footer}</div>
        <div className="line-clamp-1 text-muted-foreground">{note}</div>
      </CardFooter>
    </Card>
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

export function KpiCards({s,recent,mobile=false}){
  const o=s.overviewStats;
  const rated=s.statMatches.filter(m=>m.avgRank!=null);
  const parties=partyLobbyRanks(rated);
  const rank=o.overallRR;
  const partyName=size=>PARTY_LABELS[size]||size+'-Stack';
  const partyNote=parties.length>1
    ?parties.map(({size,rank:r})=>`${partyName(size)} ${avgLabelShort(r.tier)}`).join(' · ')
    :parties.length?`All ${partyName(parties[0].size).toLowerCase()} lobbies`:'No rated lobbies yet';
  const rr=computeRRStats(recent);
  const withRR=recent.filter(m=>Number.isFinite(m.myRR));
  const net=withRR.length?withRR.reduce((sum,m)=>sum+m.myRR,0):null;
  const Trend=net==null||net===0?Minus:net>0?TrendingUp:TrendingDown;
  const perGame=[rr.avgGain!=null?`${rrSigned(rr.avgGain,1)} per win`:null,rr.avgLoss!=null?`${rrSigned(-rr.avgLoss,1)} per loss`:null].filter(Boolean).join(' · ');
  if(mobile){
    // Phones: both headline figures side by side in one hero card, with
    // their notes underneath instead of corner badges that would not fit.
    const netTone=net>0?'text-positive':net<0?'text-negative':null;
    return (
      <Card className="gap-0 overflow-hidden py-0" role="group" aria-label="Key figures this act" data-slot="mobile-kpis">
        <dl className="grid grid-cols-2 divide-x">
          <div className="min-w-0 p-4">
            <dt className="text-xs text-muted-foreground">Avg lobby rank</dt>
            <dd className="mt-2 flex min-w-0 items-center gap-2">
              {rank&&<RankIcon tier={rank.tier} size={28}/>}
              <span className="truncate text-lg leading-tight font-semibold">{rank?avgLabel(rank.tier):avgLabel(o.overall)}</span>
            </dd>
            <dd className="mt-1.5 text-xs text-muted-foreground tabular-nums">{rank&&`${rank.rr} RR · `}{rated.length} rated</dd>
          </div>
          <div className="min-w-0 p-4">
            <dt className="text-xs text-muted-foreground">Net RR · last {recent.length}</dt>
            <dd className={cn('mt-2 flex items-center gap-1.5 text-[26px] leading-[28px] font-semibold tabular-nums',netTone)}>
              {net!=null?rrSigned(net,0):'—'}<Trend className="size-4 opacity-70" aria-hidden="true"/>
            </dd>
            <dd className="mt-1.5 text-xs text-muted-foreground tabular-nums">{rr.n} eligible</dd>
          </div>
        </dl>
        <div className="flex flex-col gap-0.5 border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
          <span className="truncate"><span className="font-medium text-foreground">{perGame||(rr.n?'No RR-eligible wins or losses':'No RR-eligible matches')}</span></span>
          <span className="truncate">{partyNote}</span>
        </div>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" role="group" aria-label="Key figures this act">
      <KpiCard label="Avg lobby rank" value={rank?avgLabel(rank.tier):avgLabel(o.overall)}
        icon={rank&&<RankIcon tier={rank.tier} size={34}/>} badge={rank&&`${rank.rr} RR`}
        footer={`${rated.length} rated ${rated.length===1?'lobby':'lobbies'}`} note={partyNote}/>
      <KpiCard label={`Net RR · last ${recent.length}`} value={net!=null?rrSigned(net,0):'—'}
        valueClassName={net>0?'text-positive':net<0?'text-negative':null}
        badge={<><Trend aria-hidden="true"/>{rr.n} eligible</>}
        footer={perGame||(rr.n?'No RR-eligible wins or losses':'No RR-eligible matches')} note="Averages skip placements and 5-stacks"/>
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
        <CardDescription>All {s.allMatches.length} {s.allMatches.length===1?'match':'matches'} this act</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4" aria-label="Basic statistics for all matches in this act">
          {items.map(([label,value,title,note])=>(
            <div key={label} className="min-w-0 bg-card px-4 py-3.5 max-sm:px-3.5 max-sm:py-3" title={title||undefined}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
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

export function RRTrendCard({s}){
  const range=s.rrTrendRange;
  return (
    <Card aria-labelledby="overview-rr-title">
      <CardHeader>
        <CardTitle><h2 id="overview-rr-title">RR trend</h2></CardTitle>
        <CardDescription>Total RR after each match{range==='all'?' this act':`, last ${range}`}</CardDescription>
        <CardAction>
          <Tabs value={range} onValueChange={setRRTrendRange}>
            <TabsList aria-label="Overview RR trend range">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="30" aria-label="30 most recent matches">30</TabsTrigger>
              <TabsTrigger value="20" aria-label="20 most recent matches">20</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartFrame><RRTrendChart matches={s.allMatches} range={range}/></ChartFrame>
      </CardContent>
    </Card>
  );
}

const RESULT={win:['Win','var(--chart-win)'],loss:['Loss','var(--chart-loss)'],draw:['Draw','var(--chart-draw)']};

export function RecentMatchesCard({matches,total,maps,className}){
  return (
    <Card className={cn('gap-4',className)} aria-labelledby="overview-matches-title">
      <CardHeader>
        <CardTitle><h2 id="overview-matches-title">Recent matches</h2></CardTitle>
        <CardDescription>Latest {matches.length} of {total}</CardDescription>
        <CardAction><ViewLink page="matches">All matches</ViewLink></CardAction>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6 max-sm:pl-4">Map</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead className="text-right max-sm:hidden">K / D / A</TableHead>
              <TableHead className="pr-6 text-right max-sm:pr-4">RR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.map(m=>{
              const [label,color]=RESULT[m.won===true?'win':m.won===false?'loss':'draw'];
              const art=maps?.get(String(m.mapId||'').toLowerCase())||maps?.get(String(m.mapName).toLowerCase());
              const date=m.startedAtMs!=null?new Date(m.startedAtMs).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'';
              return (
                <TableRow key={m.matchId}>
                  <TableCell className="pl-6 max-sm:pl-4">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
                        {art&&<img src={art} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={event=>event.currentTarget.remove()}/>}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{m.mapName}</div>
                        <div className="text-xs text-muted-foreground">{date}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline"><span className="size-1.5 rounded-full" style={{background:color}} aria-hidden="true"/>{label}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m.myR!=null&&m.opR!=null?`${m.myR}–${m.opR}`:'—'}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums max-sm:hidden">{m.myStats?`${m.myStats.kills} / ${m.myStats.deaths} / ${m.myStats.assists}`:'—'}</TableCell>
                  <TableCell className={cn('pr-6 text-right font-medium tabular-nums max-sm:pr-4',m.myRR==null?'text-muted-foreground':m.myRR>0?'text-positive':m.myRR<0?'text-negative':null)}>
                    {m.myRR==null?'—':rrSigned(m.myRR,0)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Up to three teammates side by side in the act-stats grid style, so the card
// is as full with one teammate row as the stats card is with eight figures.
const TEAMMATE_COLS={2:'sm:grid-cols-2',3:'sm:grid-cols-3'};

export function TeammatesCard({teammates}){
  if(!teammates.length)return null;
  const top=teammates.slice(0,3);
  return (
    <Card className="gap-4" aria-labelledby="overview-duos-title">
      <CardHeader>
        <CardTitle><h2 id="overview-duos-title">Top teammates</h2></CardTitle>
        <CardDescription>Most matches together this act</CardDescription>
        <CardAction><ViewLink page="duos">Duos</ViewLink></CardAction>
      </CardHeader>
      <CardContent>
        <ul className={cn('grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border',TEAMMATE_COLS[top.length])}>
          {top.map(t=>{
            const kd=t.deaths>0?t.kills/t.deaths:t.kills;
            return (
              <li key={t.key} className="min-w-0 bg-card px-4 py-3.5">
                <a href={playerRouteUrl(t.name,t.tag)} title={t.name+'#'+t.tag} className="block truncate text-sm font-medium hover:underline">
                  {t.name}<span className="font-normal text-muted-foreground"> #{t.tag}</span>
                </a>
                <div className="mt-2 flex items-baseline gap-1.5 tabular-nums" title={`Teammate K/D: ${t.kills} kills / ${t.deaths} deaths`}>
                  <span className={cn('text-2xl leading-none font-semibold',toneClass(kd))}>{kd.toFixed(2)}</span>
                  <span className="text-xs text-muted-foreground">K/D</span>
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground tabular-nums">{t.games} {t.games===1?'match':'matches'} together</div>
              </li>
            );
          })}
        </ul>
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

export function ClutchCard({matches}){
  const {totals,win,loss,save,total}=clutchSummary(matches);
  if(!total)return null;
  const pct=c=>Math.round(c/total*100);
  const segments=[['Won',win,'var(--chart-win)','Won the round — killed everyone, defused, or both'],
    ['Lost',loss,'var(--chart-loss)','Lost the round and the gun with it — died contesting it, or died to the spike'],
    ['Saved',save,'var(--chart-save)','Lost the round but survived, keeping the weapon for the next one — exit frags along the way still count as a save']];
  return (
    <Card className="gap-5" aria-labelledby="overview-clutch-title">
      <CardHeader>
        <CardTitle><h2 id="overview-clutch-title">Clutch stats</h2></CardTitle>
        <CardDescription>{win} won of {total} opportunities</CardDescription>
        <CardAction><Badge variant="outline" className="tabular-nums" title="Won or lost while contesting, rather than saved">{pct(win+loss)}% attempted</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid grid-cols-5 gap-px overflow-hidden rounded-lg border bg-border" aria-label="Clutch win rate by situation">
          {[1,2,3,4,5].map(t=>{
            const {win:w,loss:l,save:sv}=totals[t];
            const situations=w+l+sv,rate=situations?w/situations*100:null;
            return (
              <div key={t} className="flex min-w-0 flex-col gap-2.5 bg-card px-2.5 py-3 sm:px-4 sm:py-3.5"
                title={situations?`1v${t}: won ${w} of ${situations} (${Math.round(rate)}%)`:`1v${t}: no situations`}>
                <dt className="text-xs text-muted-foreground">1v{t}</dt>
                <dd className={cn('text-lg leading-none font-semibold tabular-nums sm:text-2xl',rate==null&&'text-muted-foreground')}>{rate!=null?`${Math.round(rate)}%`:'—'}</dd>
                <dd><Progress value={rate??0} className="h-1.5" aria-label={`1v${t} clutch win rate`}/></dd>
                <dd className="text-xs text-muted-foreground tabular-nums">{situations?<><span className="sm:hidden">{w}/{situations}</span><span className="max-sm:hidden">{w} of {situations} won</span></>:'None'}</dd>
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
              <span key={key} title={title} className="inline-flex items-center gap-1.5 tabular-nums">
                <span className="size-2 rounded-full" style={{background:color}} aria-hidden="true"/>{key} <span className="font-medium text-foreground">{c}</span> ({pct(c)}%)
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Phones: placeholder cards in the overview's shape while matches load, so
// the screen under the app bar is not empty.
function MobileOverviewSkeleton(){
  return (
    <div className="flex flex-col gap-4" aria-hidden="true" data-slot="overview-skeleton">
      <Skeleton className="h-8 w-40"/>
      <Skeleton className="h-32 rounded-xl"/>
      <Skeleton className="h-60 rounded-xl"/>
      <Skeleton className="h-44 rounded-xl"/>
    </div>
  );
}

export function OverviewPage(){
  const s=useEngine();
  const maps=useMapArt();
  const mobile=useIsMobile();
  if(mobile&&s.hasAnalysis&&s.analysisState==='loading')return <MobileOverviewSkeleton/>;
  if(!s.hasAnalysis||!s.overviewStats||!s.allMatches.length||s.analysisState!=='ready')return null;
  const recent=overviewRecentMatches(s.allMatches);
  const latest=[...s.allMatches].sort((a,b)=>(b.startedAtMs||0)-(a.startedAtMs||0)).slice(0,8);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6">
        <PageHeading id="overview-title" title="Overview">Your act at a glance. Each card links to the page with the full breakdown.</PageHeading>
        <div className="pt-2 max-sm:-mt-3 max-sm:mb-4 max-sm:pt-0"><PlacementToggle/></div>
      </div>
      <KpiCards s={s} recent={recent} mobile={mobile}/>
      <ActStatsCard s={s}/>
      <ClutchCard matches={s.allMatches}/>
      <TeammatesCard teammates={s.allTeammates}/>
      <RRTrendCard s={s}/>
      <RecentMatchesCard matches={latest} total={s.allMatches.length} maps={maps}/>
    </div>
  );
}
