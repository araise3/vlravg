import {
  computeWintradeSignals,decidedWinRate,playerRouteUrl,rName,rrSigned,setDuoStatsView,winRateLabel,winRateTone,
} from '@/engine/core.mjs';
import {useEngine} from '@/app/hooks.js';
import {EmptyState,LobbyValue,PageHeading,PartyIcon,PlacementToggle,PlayerLink,RankIcon,SortableTable,pageEmptyText,toneClass} from '@/app/shared.jsx';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';

const toneOf=tone=>tone==='rank-positive'?'text-positive':tone==='rank-negative'?'text-negative':'';
const rrTone=(count,total)=>!count||total===0?'':total>0?'text-positive':'text-negative';

// Your performance grouped by lobby rank (party=false) or by party size.
export function PerformanceTable({id,rows,party}){
  if(!rows.length)return null;
  const columns=[
    {label:party?'Party size':'Lobby rank'},{label:'Matches'},
    ...(party?[{label:'Avg Lobby',wide:true}]:[]),
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
    <SortableTable id={id} rows={tableRows} values={values} columns={columns} maxima={maxima}
      caption={`Your performance grouped by ${party?'party size, including your total recorded RR change':'average lobby rank'}`}/>
  );
}

export function TeammatesTable({s}){
  const you=s.duoStatsView==='you';
  const whose=you?'Your':'Teammate';
  const rows=s.allTeammates.map(t=>({
    ...t,
    kd:t.deaths>0?t.kills/t.deaths:t.kills,
    acs:t.acsCount?t.acsSum/t.acsCount:null,
    performanceScore:t.performanceCount?t.performanceSum/t.performanceCount:null,
    myKd:t.myDeaths>0?t.myKills/t.myDeaths:t.myKills,
    myAcs:t.myAcsCount?t.myAcsSum/t.myAcsCount:null,
    myPerformanceScore:t.myPerformanceCount?t.myPerformanceSum/t.myPerformanceCount:null,
    lobby:t.rankCount?t.rankSum/t.rankCount:null,
    wr:decidedWinRate(t.wins,t.decided),
  }));
  // The other side's figure stays in each tooltip for a quick comparison.
  const shown=t=>you?{kd:t.myKd,acs:t.myAcs,ps:t.myPerformanceScore}:{kd:t.kd,acs:t.acs,ps:t.performanceScore};
  const round=value=>value==null?'—':Math.round(value);
  const columns=[
    {label:'Teammate'},{label:'Matches'},{label:'Avg Lobby',wide:true},
    {label:'K/D',title:`${whose} K/D in matches with this teammate`},
    {label:'ACS',title:`${whose} average ACS in matches with this teammate`},
    {label:'PS',title:`${whose} Avg PS across matches with this teammate that have data`},
    {label:'Win rate'},{label:'Total RR',title:'Your net RR change in matches with this teammate'},
  ];
  const tableRows=rows.map(t=>{
    const v=shown(t);
    return{key:t.key,cells:[
      <PlayerLink href={playerRouteUrl(t.name,t.tag)} name={t.name} tag={t.tag}/>,
      t.games,<LobbyValue sum={t.rankSum} count={t.rankCount}/>,
      v.kd.toFixed(2),round(v.acs),round(v.ps),winRateLabel(t.wr),t.rrCount?rrSigned(t.rrTotal,0):'—',
    ],cellProps:[null,null,null,
      {className:toneClass(v.kd),title:`Teammate: ${t.kd.toFixed(2)} (${t.kills} kills / ${t.deaths} deaths) · You: ${t.myKd.toFixed(2)} (${t.myKills} kills / ${t.myDeaths} deaths)`},
      {title:`Teammate: ${round(t.acs)} · You: ${round(t.myAcs)}`},
      {title:`Teammate: ${round(t.performanceScore)} · You: ${round(t.myPerformanceScore)} · ${t.performanceCount} of ${t.games} shared matches have teammate Performance Score data, ${t.myPerformanceCount} have yours`},
      {className:toneOf(winRateTone(t.wr)),title:'Wins divided by wins plus losses; draws excluded'},
      {className:rrTone(t.rrCount,t.rrTotal),title:`${t.rrCount} of ${t.games} shared matches have recorded RR change`},
    ]};
  });
  const values=rows.map(t=>{const v=shown(t);return [t.name+'#'+t.tag,t.games,t.lobby,v.kd,v.acs,v.ps,t.wr,t.rrCount?t.rrTotal:null];});
  return (
    <SortableTable id="teammate-list" rows={tableRows} values={values} columns={columns}
      caption={`Party teammates, with ${you?'your':'their'} K/D, average ACS and Avg PS in the matches you shared, and your total recorded RR change together`}
      maxima={[{column:2,label:'average lobby rank'},{column:3,label:'K/D'},{column:4,label:'average ACS'},{column:5,label:'Avg PS'},{column:6,label:'win rate'}]}/>
  );
}

function EncountersTable({s}){
  if(!s.allEncounters.length)return <p className="px-6 py-4 text-sm text-muted-foreground">No players met at least twice outside your party in these matches.</p>;
  const tableRows=s.allEncounters.map(e=>({key:e.key,cells:[
    <PlayerLink href={playerRouteUrl(e.name,e.tag,'overview',s.TARGET_SEASON)} name={e.name} tag={e.tag}/>,
    e.games,e.sameTeam,e.opponents,
    e.lastSeen?new Date(e.lastSeen).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'—',
  ]}));
  const values=s.allEncounters.map(row=>[`${row.name}#${row.tag}`,row.games,row.sameTeam,row.opponents,row.lastSeen||null]);
  return (
    <SortableTable id="encounters-list" rows={tableRows} values={values}
      columns={[{label:'Player'},{label:'Encounters'},{label:'Same team'},{label:'Opposing team'},{label:'Last seen'}]}
      caption="Players encountered in at least two matches who were never in your party this act"/>
  );
}

function WintradeTable({s}){
  const rows=computeWintradeSignals(s.statMatches,s.allMatches,s.PUUID,s.PLAYER,s.TAG);
  if(!rows.length)return <p className="px-6 py-4 text-sm text-muted-foreground">No repeated opponents with unusually low combat stats in these matches.</p>;
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
      caption="Heuristic wintrading signals; percentages are not calibrated probabilities"/>
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
        <Card className="py-2" aria-label="Party size breakdown"><PerformanceTable id="party-size-list" rows={s.partySizeData} party/></Card>
      )}
      {ready&&s.allTeammates.length>0&&(
        <Card className="gap-2 pb-2">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle>Teammates</CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground" id="duo-stats-view-label">K/D, ACS and PS</span>
              <Tabs value={s.duoStatsView} onValueChange={setDuoStatsView}>
                <TabsList aria-labelledby="duo-stats-view-label">
                  <TabsTrigger value="teammate">Teammate</TabsTrigger>
                  <TabsTrigger value="you">You</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <TeammatesTable s={s}/>
        </Card>
      )}
      {hasMatches&&(
        <section aria-labelledby="encounters-title">
          <Card className="gap-2 pb-2">
            <CardHeader>
              <CardTitle><h2 id="encounters-title">Encounters</h2></CardTitle>
              <CardDescription>Players you met in at least two counted matches this act, on either team. Anyone who queued in your party is excluded.</CardDescription>
            </CardHeader>
            <EncountersTable s={s}/>
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
            <WintradeTable s={s}/>
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
