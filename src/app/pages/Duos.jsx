import {useState} from 'react';
import {
  avgLabel,computeWintradeSignals,decidedWinRate,playerRouteUrl,rName,rrSigned,tierRR,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {EmptyState,LobbyValue,PageHeading,PartyIcon,PlacementToggle,PlayerLink,RankIcon,ShowAllButton,SortableTable,TableSection,pageEmptyText,toneClass} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

const toneOf=tone=>tone==='rank-positive'?'text-positive':tone==='rank-negative'?'text-negative':'';
const rrTone=(count,total)=>!count||total===0?'':total>0?'text-positive':'text-negative';
// Encounters and wintrade signals show this many rows per page.
export const TABLE_PAGE_SIZE=10;

// Your performance grouped by lobby rank (party=false) or by party size.
export function PerformanceTable({id,rows,party}){
  if(!rows.length)return null;
  const columns=[
    {label:party?'Party size':'Lobby rank'},{label:'Matches'},
    ...(party?[{label:'Avg Lobby',wide:true,align:'left'}]:[]),
    {label:'K/D'},{label:'ACS'},{label:'PS',title:'Avg PS across matches with available data'},{label:'Win rate'},
    ...(party?[{label:'Total RR',title:'Your net RR change for this party size'}]:[]),
  ];
  const tableRows=rows.map(b=>{
    const kd=b.totalDeaths>0?b.totalKills/b.totalDeaths:b.totalKills>0?b.totalKills:null;
    const rate=decidedWinRate(b.wins,b.decided);
    const cells=[
      <span className="flex items-center gap-2">{party?<PartyIcon size={b.tier}/>:<RankIcon tier={b.tier} size={24}/>}<span>{b.label||rName(b.tier)}</span></span>,
      b.total,
      ...(party?[<LobbyValue sum={b.lobbySum} count={b.lobbyCount}/>]:[]),
      kd==null?'—':kd.toFixed(2),
      b.acsCount?Math.round(b.acsSum/b.acsCount):'—',
      b.performanceCount?Math.round(b.performanceSum/b.performanceCount):'—',
      winRateLabel(rate),
      ...(party?[b.rrCount?rrSigned(b.rrTotal,0):'—']:[]),
    ];
    const offset=party?1:0;
    const cellProps=[];
    cellProps[2+offset]={className:toneClass(kd),title:`${b.totalKills} kills / ${b.totalDeaths} deaths`};
    cellProps[4+offset]={title:`${b.performanceCount} of ${b.total} matches have Performance Score data`};
    cellProps[5+offset]={className:toneOf(winRateTone(rate)),title:'Wins divided by wins plus losses; draws excluded'};
    if(party)cellProps[7]={className:rrTone(b.rrCount,b.rrTotal),title:`${b.rrCount} of ${b.total} matches have recorded RR change`};
    return{key:b.tier,cells,cellProps};
  });
  const values=rows.map(b=>[
    b.tier,b.total,...(party?[b.lobbyCount?b.lobbySum/b.lobbyCount:null]:[]),
    b.totalDeaths>0?b.totalKills/b.totalDeaths:b.totalKills>0?b.totalKills:null,
    b.acsCount?b.acsSum/b.acsCount:null,
    b.performanceCount?b.performanceSum/b.performanceCount:null,
    decidedWinRate(b.wins,b.decided),
    ...(party?[b.rrCount?b.rrTotal:null]:[]),
  ]);
  const maxima=party
    ?[{column:2,label:'average lobby rank'},{column:3,label:'K/D'},{column:4,label:'average ACS'},{column:5,label:'Avg PS'},{column:6,label:'win rate'}]
    :[{column:2,label:'K/D'},{column:3,label:'average ACS'},{column:4,label:'Avg PS'},{column:5,label:'win rate'}];
  return (
    <SortableTable id={id} rows={tableRows} values={values} columns={columns} maxima={maxima} standalone
      caption={`Your performance grouped by ${party?'party size, including your total recorded RR change':'average lobby rank'}`}/>
  );
}

/* ── Duo chemistry ─────────────────────────────────────────── */
// Teammates as a pick-a-partner matchup (17 Nov 2026), replacing the
// Teammate/You switch and the duo cards. Partners by matches together on the
// left, each with your K/D in the matches you shared; the list scrolls inside
// the matchup's height on desktop. The selected partner's matchup sits on the
// right: shared results, then mirrored bars (you left, them right) for K/D,
// ACS and PS on one scale across every partner, with your figures compared
// with your act average. Colour is kept for RR only, where the sign is the
// point. Phones open the matchup under the tapped partner instead.
export const DUO_PREVIEW=8;

// Your act averages, computed the way the per-teammate figures are: K/D from
// summed kills and deaths, ACS and PS as the mean of per-match values, over
// the same stat matches the teammate rows walk.
export function duoBaseline(matches){
  let kills=0,deaths=0,acs=0,acsCount=0,ps=0,psCount=0;
  (matches||[]).forEach(m=>{
    if(!m.myStats)return;
    kills+=m.myStats.kills||0;deaths+=m.myStats.deaths||0;
    if(Number.isFinite(m.myStats.acs)){acs+=m.myStats.acs;acsCount++;}
    if(Number.isFinite(m.myStats.performanceScore)){ps+=m.myStats.performanceScore;psCount++;}
  });
  return {kd:deaths>0?kills/deaths:kills||null,acs:acsCount?acs/acsCount:null,ps:psCount?ps/psCount:null};
}

export function duoRows(teammates,base={}){
  return teammates.map(t=>{
    const myAcs=t.myAcsCount?t.myAcsSum/t.myAcsCount:null;
    return {
      ...t,
      kd:t.deaths>0?t.kills/t.deaths:t.kills,
      acs:t.acsCount?t.acsSum/t.acsCount:null,
      performanceScore:t.performanceCount?t.performanceSum/t.performanceCount:null,
      myKd:t.myDeaths>0?t.myKills/t.myDeaths:t.myKills,
      myAcs,
      myPerformanceScore:t.myPerformanceCount?t.myPerformanceSum/t.myPerformanceCount:null,
      lobby:t.rankCount?t.rankSum/t.rankCount:null,
      wr:decidedWinRate(t.wins,t.decided),
    };
  });
}

const DUO_STATS=[
  {key:'kd',label:'K/D',you:'myKd',them:'kd',base:'kd',format:v=>v.toFixed(2),delta:v=>rrSigned(v,2)},
  {key:'acs',label:'ACS',you:'myAcs',them:'acs',base:'acs',format:v=>String(Math.round(v)),delta:v=>rrSigned(v,0)},
  {key:'ps',label:'PS',you:'myPerformanceScore',them:'performanceScore',base:'ps',format:v=>String(Math.round(v)),delta:v=>rrSigned(v,0)},
];


const TAPE_COLS='grid-cols-[4.75rem_minmax(0,1fr)_2.75rem_minmax(0,1fr)_4.75rem] max-sm:grid-cols-[3.25rem_minmax(0,1fr)_2.25rem_minmax(0,1fr)_3.25rem] max-sm:gap-x-2';

// One mirrored stat row: your value and bar on the left, theirs on the right.
function TapeRow({stat,t,base,scale}){
  const you=t[stat.you],them=t[stat.them],avg=base[stat.base];
  const lead=you!=null&&them!=null&&you!==them?(you>them?'you':'them'):null;
  const width=v=>v==null||!scale?0:Math.max(2,Math.min(100,v/scale*100));
  const delta=you!=null&&avg!=null?you-avg:null;
  return (
    <div className={cn('grid items-center gap-x-2.5',TAPE_COLS)} role="row" data-slot="tape-row">
      <div className="text-right tabular-nums" role="cell" title={avg!=null?`Your act average: ${stat.format(avg)}`:undefined}>
        <div className={cn('text-lg leading-none',lead==='you'?'font-semibold text-foreground':'text-muted-foreground')}>{you==null?'—':stat.format(you)}</div>
        {delta!=null&&<div className="mt-1 text-[11px] leading-none whitespace-nowrap text-muted-foreground">{stat.delta(delta)}<span className="max-sm:hidden"> vs avg</span></div>}
      </div>
      <div className="flex h-2.5 justify-end overflow-hidden rounded-full bg-muted/40" aria-hidden="true">
        <div className={cn('h-full rounded-full',lead==='them'&&'opacity-45')} style={{width:`${width(you)}%`,background:'var(--series-1)'}}/>
      </div>
      <div className="text-center text-xs font-medium text-muted-foreground" role="rowheader">{stat.label}</div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted/40" aria-hidden="true">
        <div className={cn('h-full rounded-full bg-foreground/70',lead==='you'&&'opacity-45')} style={{width:`${width(them)}%`}}/>
      </div>
      <div className={cn('text-lg leading-none tabular-nums',lead==='them'?'font-semibold text-foreground':'text-muted-foreground')} role="cell">{them==null?'—':stat.format(them)}</div>
    </div>
  );
}

export function DuoMatchup({t,base,scales}){
  const lobby=t.rankCount?tierRR(t.lobby):null;
  const losses=t.decided-t.wins,draws=t.games-t.decided;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-slot="duo-matchup">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <PlayerLink href={playerRouteUrl(t.name,t.tag)} name={t.name} tag={t.tag} className="min-w-0 text-lg"/>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{t.games} {t.games===1?'match':'matches'} together</span>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border text-sm tabular-nums sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 bg-card px-3 py-2.5 max-sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Avg lobby</dt>
          <dd className="mt-1 flex min-w-0 items-center gap-1.5 font-medium">
            {lobby?<><RankIcon tier={lobby.tier} size={18}/><span className="truncate">{avgLabel(lobby.tier)} ({lobby.rr} RR)</span></>:'—'}
          </dd>
        </div>
        <div className="min-w-0 bg-card px-3 py-2.5" title="Wins divided by wins plus losses; draws excluded">
          <dt className="text-xs text-muted-foreground">Win rate</dt>
          <dd className="mt-1 flex items-baseline gap-1.5 font-medium">
            <span>{winRateLabel(t.wr)}</span>
            <span className="text-xs font-normal text-muted-foreground">{t.wins}W {losses}L{draws?` ${draws}D`:''}</span>
          </dd>
        </div>
        <div className="min-w-0 bg-card px-3 py-2.5" title={`Your net RR change together; ${t.rrCount} of ${t.games} shared matches have a recorded change`}>
          <dt className="text-xs text-muted-foreground">Total RR</dt>
          <dd className={cn('mt-1 font-medium',rrTone(t.rrCount,t.rrTotal))}>{t.rrCount?rrSigned(t.rrTotal,0):'—'}</dd>
        </div>
      </dl>
      <div className="flex flex-col gap-4" role="table" aria-label={`Your and ${t.name}’s K/D, ACS and PS in the ${t.games} matches you shared`}>
        <div className={cn('grid gap-x-2.5 text-xs text-muted-foreground',TAPE_COLS)} role="row">
          <span className="col-span-2 flex items-center justify-end gap-1.5" role="columnheader"><span className="size-2 rounded-full" style={{background:'var(--series-1)'}} aria-hidden="true"/>You</span>
          <span role="columnheader"><span className="sr-only">Stat</span></span>
          <span className="col-span-2 flex min-w-0 items-center gap-1.5" role="columnheader"><span className="size-2 shrink-0 rounded-full bg-foreground/70" aria-hidden="true"/><span className="truncate">{t.name}</span></span>
        </div>
        {DUO_STATS.map(stat=><TapeRow key={stat.key} stat={stat} t={t} base={base} scale={scales[stat.key]}/>)}
      </div>
      <p className="text-xs text-muted-foreground">Bars share one scale across all your teammates. The leader of each stat is solid. The small number under each of yours compares it with your act average.</p>
    </div>
  );
}

// Header and rows share these columns. The header sits above the scroll box,
// so the scrollbar starts under it; both reserve the same scrollbar gutter,
// so the columns stay aligned whether or not the list overflows.
const PARTNER_COLS='grid grid-cols-[minmax(0,1fr)_3.5rem_3rem_2.75rem] gap-x-2 px-3';
const PARTNER_GUTTER='sm:pr-1 sm:[scrollbar-gutter:stable] sm:[scrollbar-color:rgb(255_255_255/.14)_transparent] sm:[scrollbar-width:thin]';

function PartnerButton({t,selected,onSelect,controls}){
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} aria-controls={controls}
      className={cn(PARTNER_COLS,'w-full items-center rounded-md py-2 text-left text-sm tabular-nums transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected?'bg-accent text-foreground':'hover:bg-accent/50')}
      aria-label={`${t.name}#${t.tag}: ${t.games} matches, ${winRateLabel(t.wr)} win rate, ${t.rrCount?rrSigned(t.rrTotal,0):'no'} RR, your K/D ${t.myKd.toFixed(2)}`}>
      <span className="min-w-0">
        <span className="block truncate font-medium">{t.name}<span className="font-normal text-muted-foreground"> #{t.tag}</span></span>
        <span className="block text-xs text-muted-foreground">{t.games} {t.games===1?'match':'matches'}</span>
      </span>
      <span className="text-right">{winRateLabel(t.wr)}</span>
      <span className={cn('text-right',rrTone(t.rrCount,t.rrTotal))}>{t.rrCount?rrSigned(t.rrTotal,0):'—'}</span>
      <span className="text-right">{t.myKd.toFixed(2)}</span>
    </button>
  );
}

export function DuoChemistry({teammates,matches}){
  const mobile=useIsMobile();
  const [expanded,setExpanded]=useState(false);
  const [picked,setPicked]=useState(null);
  const base=duoBaseline(matches);
  const all=duoRows(teammates,base);
  // Most matches together first; ties keep the engine's order.
  const rows=all.map((t,index)=>({t,index})).sort((a,b)=>b.t.games-a.t.games||a.index-b.index).map(({t})=>t);
  // Desktop scrolls the whole list beside the matchup; phones cut it and offer "Show all".
  const cut=mobile&&!expanded&&rows.length>DUO_PREVIEW;
  const shown=cut?rows.slice(0,DUO_PREVIEW):rows;
  const selected=rows.find(t=>t.key===picked)||(mobile?null:rows[0]);
  // One scale per stat across every partner, both sides, so bar lengths compare between partners.
  const scales=Object.fromEntries(DUO_STATS.map(stat=>[stat.key,Math.max(0,...all.flatMap(t=>[t[stat.you],t[stat.them]]).filter(Number.isFinite))]));
  const select=t=>setPicked(mobile&&selected?.key===t.key?'':t.key);
  return (
    <Card className="gap-4 pb-0" aria-labelledby="teammates-title" data-slot="duo-chemistry">
      <CardHeader>
        <CardTitle><h2 id="teammates-title">Teammates</h2></CardTitle>
      </CardHeader>
      <CardContent className={cn('grid gap-6 sm:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]',!(mobile&&rows.length>DUO_PREVIEW)&&'pb-6')}>
        {/* contain:size keeps the list from setting the row height, so it
            matches the matchup beside it and scrolls inside that height. */}
        <div className="flex min-w-0 flex-col sm:[contain:size]" data-slot="duo-partner-list">
          <div className={cn(PARTNER_GUTTER,'sm:overflow-y-hidden')} aria-hidden="true">
            <div className={cn(PARTNER_COLS,'pb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase')}>
              <span>Teammate</span><span className="text-right">Win rate</span><span className="text-right">RR</span>
              <span className="text-right" title="Your K/D in the matches you shared with this teammate">K/D</span>
            </div>
          </div>
          <div className={cn(PARTNER_GUTTER,'sm:min-h-0 sm:flex-1 sm:overflow-y-auto')} data-slot="duo-partner-scroll">
            <ul id="duo-partners" className="flex flex-col gap-0.5" aria-label="Party teammates">
              {shown.map(t=>(
                <li key={t.key}>
                  <PartnerButton t={t} selected={selected?.key===t.key} onSelect={()=>select(t)} controls="duo-matchup"/>
                  {mobile&&selected?.key===t.key&&<div id="duo-matchup" className="px-1 pt-3 pb-4"><DuoMatchup t={t} base={base} scales={scales}/></div>}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {!mobile&&selected&&(
          <section id="duo-matchup" aria-live="polite" aria-label={`You and ${selected.name}`} className="min-w-0 border-l pl-6">
            <DuoMatchup t={selected} base={base} scales={scales}/>
          </section>
        )}
      </CardContent>
      {mobile&&rows.length>DUO_PREVIEW&&<ShowAllButton expanded={expanded} total={rows.length} noun="teammates" controls="duo-partners" onToggle={()=>setExpanded(open=>!open)}/>}
    </Card>
  );
}

function EncountersTable({s}){
  if(!s.allEncounters.length)return <p className="py-2 text-sm text-muted-foreground max-sm:px-4">No players met at least twice outside your party in these matches.</p>;
  const tableRows=s.allEncounters.map(e=>({key:e.key,cells:[
    <PlayerLink href={playerRouteUrl(e.name,e.tag,'overview',s.TARGET_SEASON)} name={e.name} tag={e.tag}/>,
    e.games,e.sameTeam,e.opponents,
    e.lastSeen?new Date(e.lastSeen).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'—',
  ]}));
  const values=s.allEncounters.map(row=>[`${row.name}#${row.tag}`,row.games,row.sameTeam,row.opponents,row.lastSeen||null]);
  return (
    <SortableTable id="encounters-list" rows={tableRows} values={values}
      columns={[{label:'Player'},{label:'Encounters'},{label:'Same team'},{label:'Opposing team'},{label:'Last seen'}]}
      caption="Players encountered in at least two matches who were never in your party this act" pageSize={TABLE_PAGE_SIZE} noun="players"/>
  );
}

function WintradeTable({s}){
  const rows=computeWintradeSignals(s.statMatches,s.allMatches,s.PUUID,s.PLAYER,s.TAG);
  if(!rows.length)return <p className="py-2 text-sm text-muted-foreground max-sm:px-4">No repeated opponents with unusually low combat stats in these matches.</p>;
  const tableRows=rows.map(r=>({key:r.key,cells:[
    <PlayerLink href={playerRouteUrl(r.name,r.tag,'overview',s.TARGET_SEASON)} name={r.name} tag={r.tag}/>,
    r.score+'%',r.encounters,`${r.lowGames}/${r.measuredGames}`,r.avgAcs==null?'—':Math.round(r.avgAcs),
    r.performanceScore==null?'—':Math.round(r.performanceScore),r.kd==null?'—':r.kd.toFixed(2),`${r.wins}/${r.decided}`,r.partyGames,
  ],cellProps:[null,
    {className:r.score>=70?'font-semibold text-negative':r.score>=40?'font-semibold text-amber-400':'',title:'Heuristic signal strength, not a measured chance of cheating'},
    null,null,null,{title:`${r.performanceCount} of ${r.encounters} enemy matches have Performance Score data`},
  ]}));
  const values=rows.map(r=>[`${r.name}#${r.tag}`,r.score,r.encounters,r.lowGames,r.avgAcs,r.performanceScore,r.kd,r.wins,r.partyGames]);
  return (
    <SortableTable id="wintrade-list" rows={tableRows} values={values}
      columns={[{label:'Opponent'},{label:'Likelihood signal'},{label:'Enemy games'},{label:'Low games'},{label:'ACS'},{label:'PS',title:'Avg PS across matches with available data'},{label:'K/D'},{label:'Your wins'},{label:'Party games'}]}
      caption="Heuristic wintrading signals; percentages are not calibrated probabilities" pageSize={TABLE_PAGE_SIZE} noun="opponents"/>
  );
}

export function DuosPage(){
  const s=useEngine();
  const ready=s.analysisState==='ready';
  const hasMatches=ready&&s.allMatches.length>0;
  return (
    <main aria-labelledby="duos-title" className="space-y-6">
      <PageHeading id="duos-title" title="Duos"/>
      {ready&&<PlacementToggle/>}
      {hasMatches&&s.partySizeData.length>0&&(
        <TableSection label="Party size breakdown"><PerformanceTable id="party-size-list" rows={s.partySizeData} party/></TableSection>
      )}
      {ready&&s.allTeammates.length>0&&<DuoChemistry teammates={s.allTeammates} matches={s.statMatches}/>}
      {hasMatches&&(
        <section aria-labelledby="encounters-title">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle><h2 id="encounters-title">Encounters</h2></CardTitle>
              <CardDescription>Players you met in at least two counted matches this act, on either team. Anyone who queued in your party is excluded.</CardDescription>
            </CardHeader>
            <CardContent className="max-sm:px-0"><EncountersTable s={s}/></CardContent>
          </Card>
        </section>
      )}
      {hasMatches&&(
        <section aria-labelledby="wintrade-title">
          <Card className="gap-2">
            <CardHeader>
              <CardTitle><h2 id="wintrade-title">Wintrading signals</h2></CardTitle>
              <CardDescription>Repeated opponents with unusually low combat stats in your matches. The likelihood score is a heuristic ranking, not a measured probability or proof of intent. A verified prior party game raises the score; one bad game alone does not flag anyone.</CardDescription>
            </CardHeader>
            <CardContent className="max-sm:px-0"><WintradeTable s={s}/></CardContent>
            <CardContent>
              <p className="text-xs text-muted-foreground">Low game: under 65% of the other enemy players’ median ACS and below 0.65 K/D. Only opponents met at least twice with at least one low game appear. Scores use repeat meetings, low games, your wins against them, and verified party history.</p>
            </CardContent>
          </Card>
        </section>
      )}
      {!hasMatches&&s.analysisState!=='error'&&(
        <EmptyState>{pageEmptyText(s,{ready:s.allMatches.length?'No party teammates found for these filters.':undefined,idle:'Search for a player above to see who they queue with.'})}</EmptyState>
      )}
    </main>
  );
}
