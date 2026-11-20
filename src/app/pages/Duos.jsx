import {useState} from 'react';
import {
  computeWintradeSignals,decidedWinRate,playerRouteUrl,rName,rrSigned,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {useEngine} from '@/app/hooks.js';
import {EmptyState,Hint,InlineEmpty,LobbyValue,PageHeading,PartyIcon,PlacementToggle,PlayerLink,RankIcon,SortableTable,TableSection,pageEmptyText,toneClass} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';

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

/* ── Teammates ─────────────────────────────────────────────── */
// Redesigned 20 Nov 2026 on request, replacing the pick-a-partner layout:
// three highlight tiles (most matches, best RR, best win rate), then every
// party teammate as a row of a sortable data table. Opening a row shows the
// you-vs-them comparison (K/D, ACS, PS as mirrored bars on one scale across
// every teammate, with your act-average deltas) under it. Colour stays on RR
// only, where the sign is the point.

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
      {/* Your bar grows leftward from the stat label: a shadcn Progress turned around. */}
      <Progress value={width(you)} aria-hidden="true" className="h-2.5 rotate-180 bg-muted/40"
        indicatorClassName={cn('rounded-full bg-(--series-1)',lead==='them'&&'opacity-45')}/>
      <div className="text-center text-xs font-medium text-muted-foreground" role="rowheader">{stat.label}</div>
      <Progress value={width(them)} aria-hidden="true" className="h-2.5 bg-muted/40"
        indicatorClassName={cn('rounded-full bg-foreground/70',lead==='you'&&'opacity-45')}/>
      <div className={cn('text-lg leading-none tabular-nums',lead==='them'?'font-semibold text-foreground':'text-muted-foreground')} role="cell">{them==null?'—':stat.format(them)}</div>
    </div>
  );
}

// The you-vs-them comparison shown when a teammate's row is opened.
export function DuoComparison({t,base,scales}){
  return (
    <div className="mx-auto flex max-w-2xl min-w-0 flex-col gap-4" data-slot="duo-comparison">
      <div className="flex flex-col gap-4" role="table" aria-label={`Your and ${t.name}’s K/D, ACS and PS in the ${t.games} matches you shared`}>
        <div className={cn('grid gap-x-2.5 text-xs text-muted-foreground',TAPE_COLS)} role="row">
          <span className="col-span-2 flex items-center justify-end gap-1.5" role="columnheader"><span className="size-2 rounded-full" style={{background:'var(--series-1)'}} aria-hidden="true"/>You</span>
          <span role="columnheader"><span className="sr-only">Stat</span></span>
          <span className="col-span-2 flex min-w-0 items-center gap-1.5" role="columnheader"><span className="size-2 shrink-0 rounded-full bg-foreground/70" aria-hidden="true"/><span className="truncate">{t.name}</span></span>
        </div>
        {DUO_STATS.map(stat=><TapeRow key={stat.key} stat={stat} t={t} base={base} scale={scales[stat.key]}/>)}
      </div>
      <p className="text-center text-xs text-muted-foreground">Bars share one scale across all your teammates; the leader of each stat is solid. The small number under yours compares it with your act average.</p>
    </div>
  );
}

// Three standouts: most matches together, best total RR together, and the
// best win rate over at least DUO_HIGHLIGHT_MIN_DECIDED decided matches.
export const DUO_HIGHLIGHT_MIN_DECIDED=3;
export function duoHighlights(rows){
  const most=rows.reduce((a,b)=>b.games>a.games?b:a,rows[0]);
  const withRR=rows.filter(t=>t.rrCount>0);
  const rr=withRR.length?withRR.reduce((a,b)=>b.rrTotal>a.rrTotal?b:a):null;
  const decided=rows.filter(t=>t.decided>=DUO_HIGHLIGHT_MIN_DECIDED&&t.wr!=null);
  const wr=decided.length?decided.reduce((a,b)=>b.wr>a.wr||b.wr===a.wr&&b.decided>a.decided?b:a):null;
  return [
    {key:'most',label:'Most matches together',t:most,value:String(most.games),note:most.games===1?'match':'matches'},
    rr&&{key:'rr',label:'Best RR together',t:rr,value:rrSigned(rr.rrTotal,0),note:'RR',tone:toneClass(rr.rrTotal,0)},
    wr&&{key:'wr',label:'Best win rate',t:wr,value:winRateLabel(wr.wr),note:`${wr.wins}W ${wr.decided-wr.wins}L`,title:`Over at least ${DUO_HIGHLIGHT_MIN_DECIDED} decided matches; wins divided by wins plus losses`},
  ].filter(Boolean);
}

function DuoHighlights({rows}){
  return (
    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3" aria-label="Teammate highlights" data-slot="duo-highlights">
      {duoHighlights(rows).map(({key,label,t,value,note,tone,title})=>(
        <div key={key} className="flex min-w-0 flex-col gap-2 bg-card px-4 py-3.5 max-sm:flex-row max-sm:items-center max-sm:justify-between">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground"><Hint content={title}>{label}</Hint></dt>
            <dd className="mt-1 min-w-0"><PlayerLink href={playerRouteUrl(t.name,t.tag)} name={t.name} tag={t.tag} className="max-w-full text-sm"/></dd>
          </div>
          <dd className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
            <span className={cn('text-2xl leading-none font-semibold tracking-tight max-sm:text-xl',tone)}>{value}</span>
            <span className="text-xs text-muted-foreground">{note}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const TEAMMATE_PAGE_SIZES=[10,25,50];

export function DuoRoster({teammates,matches}){
  const base=duoBaseline(matches);
  // Most matches together first; ties keep the engine's order.
  const rows=duoRows(teammates,base).map((t,index)=>({t,index})).sort((a,b)=>b.t.games-a.t.games||a.index-b.index).map(({t})=>t);
  // One scale per stat across every teammate, both sides, so bar lengths compare between teammates.
  const scales=Object.fromEntries(DUO_STATS.map(stat=>[stat.key,Math.max(0,...rows.flatMap(t=>[t[stat.you],t[stat.them]]).filter(Number.isFinite))]));
  const tableRows=rows.map(t=>{
    const losses=t.decided-t.wins,draws=t.games-t.decided;
    return {key:t.key,cells:[
      <PlayerLink href={playerRouteUrl(t.name,t.tag)} name={t.name} tag={t.tag} className="max-w-40"/>,
      t.games,
      <span className="flex items-center justify-end gap-2.5">
        <Progress value={t.wr??0} aria-hidden="true" className="h-1.5 w-12 bg-muted max-sm:hidden" indicatorClassName="rounded-full bg-foreground/60"/>
        <span className="w-12 text-right">{winRateLabel(t.wr)}</span>
      </span>,
      t.rrCount?rrSigned(t.rrTotal,0):'—',
      <LobbyValue sum={t.rankSum} count={t.rankCount}/>,
      t.myKd.toFixed(2),
      t.kd.toFixed(2),
    ],cellProps:[null,null,
      {title:`${t.wins}W ${losses}L${draws?` ${draws}D`:''}; wins divided by wins plus losses, draws excluded`},
      {className:rrTone(t.rrCount,t.rrTotal),title:`Your net RR change together; ${t.rrCount} of ${t.games} shared matches have a recorded change`},
      null,
      {title:`Your K/D in the ${t.games} matches you shared`},
      {title:`${t.name}’s K/D in those matches`},
    ]};
  });
  const values=rows.map(t=>[`${t.name}#${t.tag}`,t.games,t.wr,t.rrCount?t.rrTotal:null,t.lobby,t.myKd,t.kd]);
  return (
    <section aria-labelledby="teammates-title">
      <Card className="gap-5" data-slot="duo-roster">
        <CardHeader>
          <CardTitle><h2 id="teammates-title">Teammates</h2></CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 max-sm:px-0">
          {rows.length>1&&<div className="max-sm:px-4"><DuoHighlights rows={rows}/></div>}
          <SortableTable id="teammates-list" rows={tableRows} values={values} noun="teammates"
            pageSize={TEAMMATE_PAGE_SIZES[0]} pageSizes={TEAMMATE_PAGE_SIZES}
            columns={[{label:'Teammate'},{label:'Matches'},{label:'Win rate'},{label:'RR',title:'Your net RR change in matches together'},
              {label:'Avg lobby',wide:true,align:'left'},{label:'Your K/D'},{label:'Their K/D'}]}
            maxima={[{column:1,label:'matches together'},{column:2,label:'win rate'}]}
            detail={index=><DuoComparison t={rows[index]} base={base} scales={scales}/>} detailLabel="Compare stats"
            caption="Party teammates this act, by matches together; open a row to compare your stats with theirs"/>
        </CardContent>
      </Card>
    </section>
  );
}

/* ── Encounters ────────────────────────────────────────────── */
// A database-style table (20 Nov 2026): search, a same-team / opposing filter,
// sortable columns including each player's same-team share, and a
// rows-per-page picker. Players who ever queued in your party are excluded
// by the engine (computeEncounters).
export const ENCOUNTER_FILTERS=[['all','All'],['same','Same team'],['opposing','Opposing']];
export const ENCOUNTER_PAGE_SIZES=[10,25,50];
const encounterFilter={all:()=>true,same:e=>e.sameTeam>0,opposing:e=>e.opponents>0};

export function EncountersTable({s}){
  const [filter,setFilter]=useState('all');
  if(!s.allEncounters.length)return <div className="max-sm:px-4"><InlineEmpty>No players met at least twice outside your party in these matches.</InlineEmpty></div>;
  const list=s.allEncounters.filter(encounterFilter[filter]);
  const share=e=>e.games?e.sameTeam/e.games*100:0;
  const tableRows=list.map(e=>({key:e.key,cells:[
    <PlayerLink href={playerRouteUrl(e.name,e.tag,'overview',s.TARGET_SEASON)} name={e.name} tag={e.tag}/>,
    e.games,e.sameTeam,e.opponents,
    <span className="flex items-center justify-end gap-2.5">
      <Progress value={share(e)} aria-hidden="true" className="h-1.5 w-16 bg-muted max-sm:hidden" indicatorClassName="rounded-full bg-(--series-1)"/>
      <span className="w-10 text-right">{Math.round(share(e))}%</span>
    </span>,
    e.lastSeen?new Date(e.lastSeen).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'—',
  ],cellProps:[null,null,null,null,{title:`${e.sameTeam} of ${e.games} encounters on your team`}]}));
  const values=list.map(row=>[`${row.name}#${row.tag}`,row.games,row.sameTeam,row.opponents,share(row),row.lastSeen||null]);
  const tools=(
    <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={value=>value&&setFilter(value)} aria-label="Show encounters">
      {ENCOUNTER_FILTERS.map(([value,label])=>(
        <ToggleGroupItem key={value} value={value} className="h-8 px-3 text-xs data-[state=on]:text-foreground">{label}</ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
  return (
    <SortableTable key={filter} id="encounters-list" rows={tableRows} values={values} searchable tools={tools}
      emptyText={filter==='same'?'No encounters on your team in these matches.':'No encounters on the opposing team in these matches.'}
      columns={[{label:'Player'},{label:'Encounters'},{label:'Same team'},{label:'Opposing'},{label:'Same team %',title:'Share of your encounters with this player where they were on your team'},{label:'Last seen'}]}
      maxima={[{column:1,label:'encounters'}]}
      caption="Players encountered in at least two matches who were never in your party this act"
      pageSize={ENCOUNTER_PAGE_SIZES[0]} pageSizes={ENCOUNTER_PAGE_SIZES} noun="players"/>
  );
}

function WintradeTable({s}){
  const rows=computeWintradeSignals(s.statMatches,s.allMatches,s.PUUID,s.PLAYER,s.TAG);
  if(!rows.length)return <div className="max-sm:px-4"><InlineEmpty>No repeated opponents with unusually low combat stats in these matches.</InlineEmpty></div>;
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
      {ready&&s.allTeammates.length>0&&<DuoRoster teammates={s.allTeammates} matches={s.statMatches}/>}
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
        <EmptyState loading={s.analysisState==='loading'}>{pageEmptyText(s,{ready:s.allMatches.length?'No party teammates found for these filters.':undefined,idle:'Search for a player above to see who they queue with.'})}</EmptyState>
      )}
    </main>
  );
}
