import {useState} from 'react';
import {
  computeWintradeSignals,decidedWinRate,playerRouteUrl,rName,rrSigned,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {useEngine} from '@/app/hooks.js';
import {EmptyState,InlineEmpty,LobbyValue,PageHeading,PartyIcon,PlacementToggle,PlayerLink,LobbyRankText,RankIcon,SortableTable,STAT_TABLE_WIDTHS,TableSection,pageEmptyText,toneClass} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';

const toneOf=tone=>tone==='rank-positive'?'text-positive':tone==='rank-negative'?'text-negative':'';
const rrTone=(count,total)=>!count||total===0?'':total>0?'text-positive':'text-negative';
// Encounters and wintrade signals show this many rows per page.
export const TABLE_PAGE_SIZE=10;

// The site's table column order (22 Nov 2026, on request): the row's name,
// Matches, Avg Lobby, K/D, ACS, PS, Win rate, then RR. The party-size and
// teammates tables stack on the Duos page, so they also share fixed column
// widths (STAT_TABLE_WIDTHS, also used by Servers) and line up column for column.

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
      party
        ?<span className="flex items-center gap-2"><PartyIcon size={b.tier}/><span>{b.label||rName(b.tier)}</span></span>
        :<span className="flex items-center gap-2"><RankIcon tier={b.tier} size={24}/><LobbyRankText tier={b.tier}>{b.label||rName(b.tier)}</LobbyRankText></span>,
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
    <SortableTable id={id} rows={tableRows} values={values} columns={columns} maxima={maxima} standalone widths={party?STAT_TABLE_WIDTHS:undefined}
      caption={`Your performance grouped by ${party?'party size, including your total recorded RR change':'average lobby rank'}`}/>
  );
}

/* ── Teammates ─────────────────────────────────────────────── */
// One plain sortable table (22 Nov 2026, on request, replacing the 20 Nov
// highlight tiles and expandable comparison rows): what you did together and
// how each teammate played (their K/D, ACS and PS in your shared matches).
// Your own stats with each teammate are not shown. Colour stays on RR only,
// where the sign is the point.
export const TEAMMATE_PAGE_SIZES=[10,25,50];

export function duoRows(teammates){
  return teammates.map(t=>({
    ...t,
    kd:t.deaths>0?t.kills/t.deaths:t.kills,
    acs:t.acsCount?t.acsSum/t.acsCount:null,
    performanceScore:t.performanceCount?t.performanceSum/t.performanceCount:null,
    lobby:t.rankCount?t.rankSum/t.rankCount:null,
    wr:decidedWinRate(t.wins,t.decided),
  }));
}

// Most matches together first; ties keep the engine's order.
const byMatches=rows=>rows.map((t,index)=>({t,index})).sort((a,b)=>b.t.games-a.t.games||a.index-b.index).map(({t})=>t);

export function DuoRoster({teammates}){
  const rows=byMatches(duoRows(teammates));
  const tableRows=rows.map(t=>{
    const losses=t.decided-t.wins,draws=t.games-t.decided;
    return {key:t.key,cells:[
      <PlayerLink href={playerRouteUrl(t.name,t.tag)} name={t.name} tag={t.tag} className="max-w-40"/>,
      t.games,
      <LobbyValue sum={t.rankSum} count={t.rankCount}/>,
      t.kd.toFixed(2),
      t.acs==null?'—':Math.round(t.acs),
      t.performanceScore==null?'—':Math.round(t.performanceScore),
      winRateLabel(t.wr),
      t.rrCount?rrSigned(t.rrTotal,0):'—',
    ],cellProps:[null,null,null,
      {title:`${t.name}’s ${t.kills} kills / ${t.deaths} deaths in your shared matches`},
      {title:`${t.acsCount} of ${t.games} shared matches have ACS`},
      {title:`${t.performanceCount} of ${t.games} shared matches have Performance Score data`},
      {title:`${t.wins}W ${losses}L${draws?` ${draws}D`:''}; wins divided by wins plus losses, draws excluded`},
      {className:rrTone(t.rrCount,t.rrTotal),title:`Your net RR change together; ${t.rrCount} of ${t.games} shared matches have a recorded change`},
    ]};
  });
  const values=rows.map(t=>[`${t.name}#${t.tag}`,t.games,t.lobby,t.kd,t.acs,t.performanceScore,t.wr,t.rrCount?t.rrTotal:null]);
  return (
    // Just the table, like the party-size table above it: no card around it.
    <TableSection label="Teammates">
      <SortableTable id="teammates-list" rows={tableRows} values={values} noun="teammates" standalone widths={STAT_TABLE_WIDTHS}
        pageSize={TEAMMATE_PAGE_SIZES[0]} pageSizes={TEAMMATE_PAGE_SIZES}
        columns={[{label:'Teammate'},{label:'Matches'},{label:'Avg Lobby',wide:true,align:'left'},{label:'K/D',title:'Their K/D in your shared matches'},
          {label:'ACS',title:'Their average ACS in your shared matches'},{label:'PS',title:'Their average Performance Score in your shared matches'},
          {label:'Win rate'},{label:'Total RR',title:'Your net RR change in matches together'}]}
        maxima={[{column:1,label:'matches together'},{column:6,label:'win rate'}]}
        caption="Party teammates this act, by matches together, with their stats in the matches you shared"/>
    </TableSection>
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
    r.score+'%',r.encounters,`${r.lowGames}/${r.measuredGames}`,r.kd==null?'—':r.kd.toFixed(2),r.avgAcs==null?'—':Math.round(r.avgAcs),
    r.performanceScore==null?'—':Math.round(r.performanceScore),`${r.wins}/${r.decided}`,r.partyGames,
  ],cellProps:[null,
    {className:r.score>=70?'font-semibold text-negative':r.score>=40?'font-semibold text-amber-400':'',title:'Heuristic signal strength, not a measured chance of cheating'},
    null,null,null,null,{title:`${r.performanceCount} of ${r.encounters} enemy matches have Performance Score data`},
  ]}));
  // K/D, ACS, PS in the site's usual order.
  const values=rows.map(r=>[`${r.name}#${r.tag}`,r.score,r.encounters,r.lowGames,r.kd,r.avgAcs,r.performanceScore,r.wins,r.partyGames]);
  return (
    <SortableTable id="wintrade-list" rows={tableRows} values={values}
      columns={[{label:'Opponent'},{label:'Likelihood signal'},{label:'Enemy games'},{label:'Low games'},{label:'K/D'},{label:'ACS'},{label:'PS',title:'Avg PS across matches with available data'},{label:'Your wins'},{label:'Party games'}]}
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
      {ready&&s.allTeammates.length>0&&<DuoRoster teammates={s.allTeammates}/>}
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
