import {Fragment,useEffect,useState} from 'react';
import {ChevronDown,Shield,Trophy} from 'lucide-react';
import {
  avgLabel,avgLabelShort,dayHeaderLabel,decidedWinRate,hexToRgb,loadMatchMapMetadata,loadMoreMatches,matchAward,
  lobbyRankText,lobbyRR,matchCardPlayerRank,playerRouteUrl,rClass,rColor,rrSigned,tierRR,winRateLabel,
} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {EmptyState,Hint,PageHeading,PlacementToggle,RankIcon,Sep} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from '@/components/ui/collapsible';

// Rank text colours per tier band (the legacy r-* classes).
const RANK_TEXT={'r-unr':'text-zinc-500','r-iron':'text-zinc-400','r-bronze':'text-amber-700','r-silver':'text-zinc-300','r-gold':'text-amber-400',
  'r-plat':'text-cyan-400','r-diamond':'text-fuchsia-300','r-asc':'text-emerald-400','r-imm':'text-rose-500','r-rad':'text-amber-100'};

// Map artwork is optional: match data renders immediately, even offline.
export function useMapArt(){
  const [maps,setMaps]=useState(null);
  useEffect(()=>{let live=true;loadMatchMapMetadata().then(result=>{if(live)setMaps(result);});return()=>{live=false;};},[]);
  return maps;
}

export function RRDetails({m}){
  const d=m.myRRDetails;
  const rows=[];
  const add=(label,value)=>rows.push([label,value]);
  if(m.myRR!=null)add('Recorded payout',rrSigned(m.myRR,0)+' RR');
  if(d){
    if(d.beforeTier!=null&&d.beforeRR!=null)add('Starting rank',avgLabelShort(d.beforeTier)+', '+d.beforeRR+' RR');
    if(d.afterTier!=null&&d.afterRR!=null)add('Ending rank',avgLabelShort(d.afterTier)+', '+d.afterRR+' RR');
    if(d.bonus!=null)add('Performance bonus',rrSigned(d.bonus,0)+' RR');
    // Penalty units/sign conventions are not defined by the schema. Display
    // the reported values verbatim; do not turn a fractional factor into RR.
    if(d.afkPenalty!=null)add('AFK penalty (reported)',String(d.afkPenalty));
    if(d.penalty!=null)add('RR penalty (reported)',String(d.penalty));
    if(d.mapForgiveness!=null)add('New-map forgiveness',rrSigned(d.mapForgiveness,0)+' RR');
    if(d.placement!=null)add('Placement match',d.placement?'Yes':'No');
    if(d.shieldReplenished!=null)add('Rank Shield replenished',d.shieldReplenished?'Yes':'No');
    if(d.queue)add('Queue',d.queue);
    if(d.movement)add('Competitive movement',d.movement);
  }
  if(m.myRefundedRR)add('Refund',rrSigned(m.myRefundedRR,0)+' RR');
  if(m.myDerankProtected)add('Rank Shield','Protected displayed rank');
  if(!rows.length)return null;
  const hasBreakdown=d&&[d.bonus,d.afkPenalty,d.penalty,d.mapForgiveness].some(v=>v!=null);
  return (
    <section aria-label="Your RR details" className="rounded-lg bg-muted/40 p-4">
      <h4 className="mb-3 text-sm font-medium">Your RR details</h4>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
        {rows.map(([label,value])=><div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-medium tabular">{value}</dd></div>)}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{hasBreakdown?'Reported bonus and penalty fields describe this update; they are not added again to the recorded payout.':'Bonus and penalty details are unavailable for this match.'}</p>
    </section>
  );
}

// `compact` (phones): narrower stat columns and the short rank label.
function PlayersGrid({m,me,compact}){
  const cols=compact?'grid-cols-[minmax(0,1fr)_2.25rem_2.25rem_2.5rem_3.25rem] gap-1.5':'grid-cols-[minmax(0,1fr)_3rem_3rem_3rem_5.5rem] gap-2';
  const myTeamId=me?.team_id,myPartyId=m.myPartyId;
  // Sort by ACS desc (nulls last), fall back to tier
  const byAcs=(a,b)=>{
    if(a._acs!=null&&b._acs!=null)return b._acs-a._acs;
    if(a._acs!=null)return -1;
    if(b._acs!=null)return 1;
    return (b._tier??0)-(a._tier??0);
  };
  const teams=[['Your team',m.players.filter(p=>p.team_id===myTeamId).sort(byAcs)],['Enemy team',m.players.filter(p=>p.team_id!==myTeamId).sort(byAcs)]];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {teams.map(([label,players])=>(
        <div key={label} className="text-sm">
          <div className={cn('grid border-b',cols,'px-2 pb-2 text-xs text-muted-foreground uppercase')}>
            <span>{label}</span><span className="text-right">ACS</span><span className="text-right"><Hint content="Performance Score">PS</Hint></span><span className="text-right">KD</span><span className="text-right">Rank</span>
          </div>
          {players.map((p,i)=>{
            const isMe=p===me,isParty=myPartyId&&p.party_id===myPartyId;
            const content=<><span className={cn('truncate',isParty&&'text-sky-300',isMe&&'font-semibold text-foreground')}>{p.name||'Unknown player'}</span>{p.tag&&<span className="shrink-0 text-xs text-muted-foreground">#{p.tag}</span>}</>;
            return (
              <div key={p.puuid||i} className={cn('grid items-center rounded-md',cols,'px-2 py-1.5 tabular',isMe&&'bg-rank/10')}>
                {p.name&&p.tag
                  ?<a href={playerRouteUrl(p.name,p.tag)} title={`Search ${p.name}#${p.tag}`} className="flex min-w-0 items-baseline gap-0.5 hover:underline">{content}</a>
                  :<span className="flex min-w-0 items-baseline gap-0.5">{content}</span>}
                <span className={cn('text-right',p._acs==null&&'text-muted-foreground')}>{p._acs!=null?Math.round(p._acs):'—'}</span>
                <span className={cn('text-right',p._performanceScore==null&&'text-muted-foreground')}>{Number.isFinite(p._performanceScore)?Math.round(p._performanceScore):'—'}</span>
                <span className={cn('text-right',p._kd==null&&'text-muted-foreground')}>{p._kd!=null?p._kd.toFixed(2):'—'}</span>
                <span className={cn('truncate text-right text-xs font-medium',RANK_TEXT[rClass(p._tier)])} title={p._label}>{compact&&Number.isInteger(p._tier)&&p._tier>=3?avgLabelShort(p._tier):p._label}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Inside the card's toggle button, so hints open on hover only (asChild on a
// plain span adds no focus stop); the button's aria-label carries the figures.
function Stat({label,children,title,className,valueClassName}){
  return (
    <Hint asChild content={title}>
      <span className={cn('mc-performance-stat',className)}>
        <span className="mc-performance-lbl">{label}</span>
        <span className={cn('mc-performance-val',valueClassName)}>{children}</span>
      </span>
    </Hint>
  );
}

// Phones: a compact row instead of the two-panel card. Map thumbnail with the
// result stripe and your starting rank, then result, score and RR on one line,
// map/time/server on the next, and your line of stats under that. Tapping it
// opens the same RR details and roster as on desktop.
export function MobileMatchCard({m,s,maps,open,onOpenChange}){
  const {mapName,serverName,startedAt,startedAtMs,won,myR,opR,avgRank,myStats,myRR,myDerankProtected}=m;
  const rt=won===true?'Win':won===false?'Loss':'Draw';
  const result=won===true?'win':won===false?'loss':'draw';
  const award=matchAward(m);
  const awardLabel=award==='match'?'Match MVP':award==='team'?'Team MVP':'';
  const shielded=!!myDerankProtected&&myRR<0;
  const rank=avgRank!=null?tierRR(avgRank):null;
  const time=startedAtMs!=null?new Date(startedAtMs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):startedAt;
  const duration=m.durationMs>0?Math.round(m.durationMs/60000)+' min':null;
  const preMatchRank=matchCardPlayerRank(m);
  const art=maps?.get(String(m.mapId||'').toLowerCase())||maps?.get(String(mapName).toLowerCase());
  const me=m.players.find(p=>s.PUUID?p.puuid===s.PUUID:p.name?.toLowerCase()===s.PLAYER.toLowerCase()&&p.tag?.toLowerCase()===s.TAG.toLowerCase());
  const kda=myStats?[myStats.kills,myStats.deaths,myStats.assists].join(' / '):'—';
  const acs=myStats?.acs!=null?Math.round(myStats.acs):'—';
  const performanceScore=Number.isFinite(myStats?.performanceScore)?Math.round(myStats.performanceScore):'—';
  const score=myR!=null&&opR!=null?myR+'–'+opR:'—';
  const label=rt+' on '+mapName+', '+score+'. '+(awardLabel?awardLabel+'. ':'')+kda+' KDA, '+acs+' ACS, '+performanceScore+' Performance Score.';
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <div className={cn('match-card mobile',result,m.postReset&&!s.mhIncludeReset&&'opacity-55')} data-match-id={m.matchId}>
        <CollapsibleTrigger className="flex w-full items-stretch gap-3 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset [-webkit-tap-highlight-color:transparent]"
          aria-label={label+(open?' Hide RR details and roster':' Show RR details and roster')}>
          <span className="relative size-[72px] shrink-0 overflow-hidden rounded-lg bg-[radial-gradient(ellipse_at_top_right,#344657,#1d242d_60%,#141416)]">
            {art&&<img src={art} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover opacity-90" onError={event=>event.currentTarget.remove()}/>}
            <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" aria-hidden="true"/>
            <span className="absolute inset-y-0 left-0 w-1 bg-[var(--result-color)]" aria-hidden="true"/>
            {preMatchRank&&<Hint asChild content="Your rank at the start of this match"><span className="absolute right-1 bottom-1 drop-shadow-[0_2px_4px_rgb(0_0_0/.7)]"><RankIcon tier={preMatchRank.tier} size={22}/></span></Hint>}
          </span>
          <span className="flex min-w-0 flex-1 flex-col justify-between gap-1">
            <span className="flex items-center gap-2">
              <span className="m-result-tag">{rt}</span>
              <span className="text-lg leading-none font-bold tracking-tight tabular-nums">
                {myR!=null&&opR!=null?<>{myR}<span className="mx-0.5 text-sm font-normal text-zinc-500">:</span><span className="text-zinc-400">{opR}</span></>:'—'}
              </span>
              {award&&<Trophy className={cn('size-3.5 shrink-0',award==='match'?'text-[#f2cf80]':'text-slate-300')} aria-label={awardLabel}/>}
              {m.postReset&&<Hint asChild content="Placement-week game after a total rank reset"><Badge variant="outline" className="px-1 py-0 text-[9px] uppercase">Plac.</Badge></Hint>}
              <Hint asChild content={myRR==null?'No RR data for this match':shielded?'Rank Shield protected your displayed rank; this recorded RR loss still applied':'Recorded RR change for this match'}>
                <span className={cn('match-rr-change ml-auto text-[15px]',myRR!=null&&(myRR>=0?'gain':'loss'),shielded&&'shielded')}>
                  {shielded&&<Shield aria-hidden="true"/>}{myRR!=null?(myRR>=0?'+':'')+myRR:'—'}
                </span>
              </Hint>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0 font-semibold text-foreground">{mapName}</span>
              {[time,duration].filter(Boolean).map(v=><Fragment key={v}><Sep/><span className="shrink-0">{v}</span></Fragment>)}
              {serverName&&<><Sep/><span className="truncate">{serverName}</span></>}
            </span>
            <span className="flex min-w-0 items-center gap-x-3 text-xs tabular-nums text-muted-foreground">
              <span className="shrink-0"><span className="font-semibold text-foreground">{myStats?<>{myStats.kills}<span className="text-zinc-500">/</span><span className="text-zinc-400">{myStats.deaths}</span><span className="text-zinc-500">/</span>{myStats.assists}</>:'—'}</span></span>
              <span className="shrink-0"><span className="font-semibold text-foreground">{acs}</span> ACS</span>
              <span className="shrink-0"><span className="font-semibold text-foreground">{performanceScore}</span> PS</span>
              <Hint asChild content={rank?'Average lobby: '+lobbyRankText(avgRank):'Lobby rank unavailable'}>
                <span className={cn('min-w-0 truncate font-medium',rank&&RANK_TEXT[rClass(rank.tier)])}>
                  {rank?avgLabelShort(rank.tier):m.lowRated?'Unrated':'—'}
                </span>
              </Hint>
            </span>
          </span>
          <ChevronDown className={cn('size-4 shrink-0 self-center text-muted-foreground transition-transform duration-200',open&&'rotate-180')} aria-hidden="true"/>
        </CollapsibleTrigger>
        <CollapsibleContent className="match-card-details space-y-4">
          <RRDetails m={m}/>
          <PlayersGrid m={m} me={me} compact/>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function MatchCard({m,s,maps,open,onOpenChange}){
  const mobile=useIsMobile();
  if(mobile)return <MobileMatchCard m={m} s={s} maps={maps} open={open} onOpenChange={onOpenChange}/>;
  return <DesktopMatchCard m={m} s={s} maps={maps} open={open} onOpenChange={onOpenChange}/>;
}

function DesktopMatchCard({m,s,maps,open,onOpenChange}){
  const {mapName,serverName,startedAt,startedAtMs,won,myR,opR,avgRank,myStats,myRR,myDerankProtected}=m;
  const rt=won===true?'Win':won===false?'Loss':'Draw';
  const score=myR!=null&&opR!=null?myR+'–'+opR:'—';
  const award=matchAward(m);
  const awardLabel=award==='match'?'Match MVP':award==='team'?'Team MVP':'';
  const shielded=!!myDerankProtected&&myRR<0;
  const rank=avgRank!=null?tierRR(avgRank):null;
  const rankLabel=rank?avgLabelShort(rank.tier):m.lowRated?'Unrated':'—';
  const rankTitle=m.lowRated?'Only '+m.ratedCount+' players were rated; excluded from stats':rank?'Average lobby: '+lobbyRankText(avgRank):'Lobby rank unavailable';
  const kda=myStats?[myStats.kills,myStats.deaths,myStats.assists].join(' / '):'—';
  const acs=myStats?.acs!=null?Math.round(myStats.acs):'—';
  const performanceScore=Number.isFinite(myStats?.performanceScore)?Math.round(myStats.performanceScore):'—';
  const time=startedAtMs!=null?new Date(startedAtMs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):startedAt;
  const duration=m.durationMs>0?Math.round(m.durationMs/60000)+' min':null;
  const preMatchRank=matchCardPlayerRank(m);
  const preMatchRankText=preMatchRank?preMatchRank.tier<3?'Unranked':avgLabelShort(preMatchRank.tier)+' ('+preMatchRank.rr+' RR)':null;
  const art=maps?.get(String(m.mapId||'').toLowerCase())||maps?.get(String(mapName).toLowerCase());
  const me=m.players.find(p=>s.PUUID?p.puuid===s.PUUID:p.name?.toLowerCase()===s.PLAYER.toLowerCase()&&p.tag?.toLowerCase()===s.TAG.toLowerCase());
  const label=rt+' on '+mapName+', '+score+'. '+(awardLabel?awardLabel+'. ':'')+kda+' KDA, '+acs+' ACS, '+performanceScore+' Performance Score.';
  const result=won===true?'win':won===false?'loss':'draw';
  // The pre-React match card (legacy .match-card): map art panel, large
  // scoreline, uppercase result tag, bold stats with grey deaths.
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <div className={cn('match-card',result,m.postReset&&!s.mhIncludeReset&&'opacity-55')} data-match-id={m.matchId}>
        <CollapsibleTrigger className="match-row" aria-label={label+(open?' Hide RR details and roster':' Show RR details and roster')}>
          <span className={cn('mc-map-panel',preMatchRank&&'has-player-rank')}>
            {art&&<img src={art} alt="" loading="lazy" decoding="async" className="mc-map-image" onError={event=>event.currentTarget.remove()}/>}
            <span className="match-map">{mapName}</span>
            <span className="mc-map-meta">
              <span className="mc-map-meta-row">
                {[time,duration].filter(Boolean).map(v=><span key={v}>{v}</span>)}
                {serverName&&<span className="truncate" title={serverName}>{serverName}</span>}
              </span>
              {preMatchRankText&&<span className="mc-map-meta-row"><Hint asChild content="Your rank at the start of this match"><span className="text-white">{preMatchRankText}</span></Hint></span>}
            </span>
            {preMatchRank&&(
              <Hint asChild content="Your rank at the start of this match">
              <span className="mc-player-rank-icon"
                style={{filter:`drop-shadow(0 0 7px rgb(${hexToRgb(rColor(preMatchRank.tier))} / .42)) drop-shadow(0 4px 10px rgb(0 0 0 / .55))`}}>
                <RankIcon tier={preMatchRank.tier} size={64}/>
              </span>
              </Hint>
            )}
          </span>
          <span className="mc-body">
            <span className="mc-topline">
              <span className="mc-result">
                <span className="m-result-tag">{rt}</span>
                <span className="match-score">{myR!=null&&opR!=null?<>{myR}<span className="mc-score-divider">:</span><span className="mc-score-opponent">{opR}</span></>:'—'}</span>
              </span>
              {award&&<Hint asChild content={'Highest ACS '+(award==='match'?'in the match':'on your team')}><span className={cn('mc-accolade',award==='match'?'mvp-match':'mvp-team')}><Trophy aria-hidden="true"/>{awardLabel}</span></Hint>}
              {m.postReset&&<Hint asChild content="Placement-week game after a total rank reset"><Badge variant="outline" className="text-[10px] uppercase">Placements</Badge></Hint>}
              <span className="mc-expand-icon"><span className="mc-expand-label">Details</span><ChevronDown aria-hidden="true"/></span>
            </span>
            <span className="mc-performance">
              <Stat label="K / D / A">{myStats?<>{myStats.kills}<span className="mc-kda-separator">/</span><span className="mc-deaths">{myStats.deaths}</span><span className="mc-kda-separator">/</span>{myStats.assists}</>:'—'}</Stat>
              <Stat label="ACS">{acs}</Stat>
              <Stat label="PS" title={myStats?.performanceScore==null?'Performance Score is not provided in this match’s API data':'Performance Score'}>{performanceScore}</Stat>
              <Stat label="Avg lobby" title={rankTitle}>{rankLabel}{lobbyRR(rank)!=null?` (${rank.rr} RR)`:''}</Stat>
              <Stat label="RR change" className="mc-rr-stat">
                <Hint asChild content={myRR==null?'No RR data for this match':shielded?'Rank Shield protected your displayed rank; this recorded RR loss still applied':'Recorded RR change for this match'}>
                  <span className={cn('match-rr-change',myRR!=null&&(myRR>=0?'gain':'loss'),shielded&&'shielded')}>
                    {shielded&&<Shield aria-hidden="true"/>}{myRR!=null?(myRR>=0?'+':'')+myRR:'—'}
                  </span>
                </Hint>
              </Stat>
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="match-card-details space-y-4">
          <RRDetails m={m}/>
          <PlayersGrid m={m} me={me}/>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function DayHeader({ms,stat,first}){
  let avgValue='—',avgClass='',rrValue='—',rrClass='';
  if(stat&&stat.count>0){
    const {tier}=tierRR(stat.sum/stat.count);
    avgValue=lobbyRankText(stat.sum/stat.count,true);avgClass=RANK_TEXT[rClass(tier)];
  }
  if(stat&&stat.rrCount>0){rrValue=`${stat.rrTotal>=0?'+':''}${stat.rrTotal} RR`;rrClass=stat.rrTotal>=0?'text-positive':'text-negative';}
  const matchCount=stat?.matches??0;
  const record=[stat?.wins?[`${stat.wins}W`,'text-positive']:null,stat?.losses?[`${stat.losses}L`,'text-negative']:null,stat?.draws?[`${stat.draws}D`,'text-draw']:null].filter(Boolean);
  return (
    <div className={cn('match-day-header',first&&'first')}>
      <div className="match-day-heading">
        <span className="match-day-title">{dayHeaderLabel(ms)}</span>
        <span className="match-day-count">{matchCount} {matchCount===1?'match':'matches'}</span>
      </div>
      <div className="match-day-stats" aria-label="Daily recap">
        <span className="match-day-stat"><span className="match-day-stat-label">Record</span>
          <span className="match-day-stat-value">{record.length?record.map(([text,tone],i)=><span key={text}>{i>0&&<span className="text-muted-foreground" aria-hidden="true"> – </span>}<span className={tone}>{text}</span></span>):'—'}</span></span>
        <span className="match-day-stat"><span className="match-day-stat-label">Avg lobby</span><span className={cn('match-day-stat-value',avgClass)}>{avgValue}</span></span>
        <span className="match-day-stat">
          <span className="match-day-stat-label"><Hint content={stat?.rrCount?`Net RR from ${stat.rrCount} of ${matchCount} matches with RR data. Rank Shield losses include their recorded loss.`:'No RR data is available for this day.'}>Net RR</Hint></span>
          <span className={cn('match-day-stat-value',rrClass)}>{rrValue}</span>
          {stat?.rrCount<stat?.matches&&stat?.rrCount>0&&<span className="match-day-coverage">{stat.rrCount}/{stat.matches} covered</span>}
        </span>
      </div>
    </div>
  );
}

export function MatchesPage(){
  const s=useEngine();
  const maps=useMapArt();
  const [expanded,setExpanded]=useState(()=>new Set());
  const ready=s.analysisState==='ready';
  const hasMatches=ready&&s.allMatches.length>0;
  const data=s.mhData;
  const n=data.length,wins=data.filter(m=>m.won===true).length;
  const decided=data.filter(m=>m.won===true||m.won===false).length;
  let matchMvps=0,teamMvps=0;
  for(const m of data){const award=matchAward(m);if(award==='match')matchMvps++;else if(award==='team')teamMvps++;}
  const slice=data.slice(0,s.mhVisible);
  const remaining=Math.max(0,data.length-s.mhVisible);
  let lastDay=null;
  return (
    <main aria-labelledby="matches-title" className="space-y-6">
      <PageHeading id="matches-title" title="Match History"/>
      {hasMatches&&(
        <>
          <PlacementToggle/>
          <div className="mh-summary" aria-label="Match history summary">
            {[[n.toLocaleString(),'Matches',''],[winRateLabel(decidedWinRate(wins,decided)),'Win rate',''],[matchMvps,'Match MVP','mvp-match'],[teamMvps,'Team MVP','mvp-team']].map(([value,label,tone])=>(
              <div key={label} className={cn('mh-summary-item',tone)}>
                <span className="mh-summary-value">{value}</span>
                <span className="mh-summary-label">{label}</span>
              </div>
            ))}
          </div>
          <div className="mh-list-heading">
            <span>Match log</span>
            <span>Newest first. Select a match for RR details and roster.</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {slice.map((m,index)=>{
              const dayKey=m.startedAtMs!=null?new Date(m.startedAtMs).toDateString():'unknown';
              const header=dayKey!==lastDay?<DayHeader ms={m.startedAtMs} stat={s.mhDayStats[dayKey]} first={index===0}/>:null;
              lastDay=dayKey;
              return (
                <Fragment key={m.matchId}>
                  {header}
                  <MatchCard m={m} s={s} maps={maps} open={expanded.has(m.matchId)} onOpenChange={next=>setExpanded(previous=>{
                    const copy=new Set(previous);
                    if(next)copy.add(m.matchId);else copy.delete(m.matchId);
                    return copy;
                  })}/>
                </Fragment>
              );
            })}
          </div>
          {remaining>0&&<Button variant="outline" className="w-full" onClick={loadMoreMatches}>Load More ({remaining} remaining)</Button>}
        </>
      )}
      {!hasMatches&&s.analysisState!=='error'&&(
        <EmptyState loading={s.analysisState==='loading'}>{s.analysisState==='loading'?'Loading this player’s matches…':ready?'No matches found for this season. Try another act.':'Search for a player above to explore their match history.'}</EmptyState>
      )}
    </main>
  );
}
