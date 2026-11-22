import {clutchBreakdown,winRateLabel} from '@/engine/core.mjs';
import {useEngine} from '@/app/hooks.js';
import {EmptyState,Hint,PageHeading,SortableTable,pageEmptyText} from '@/app/shared.jsx';
import {CLUTCH_COLORS} from '@/app/pages/Overview.jsx';
import {AgentIcon,agentTint,useAgentArt} from '@/app/agent-icon.jsx';
import {cn} from '@/lib/utils';
import {Badge} from '@/components/ui/badge';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

// The Clutches page (22 Nov 2026, on request, contents left to us): the
// act's 1vX situations from the same detection as the Overview's clutch card
// (processMatch → myClutches), broken down by situation, by side and spike
// state, by map and by agent, plus the hardest clutches won. Every figure
// uses won ÷ situations, as the Overview card does.

const OUTCOMES=[
  ['win','Won','var(--chart-win)','Won the round: killed everyone, defused, or both'],
  ['loss','Lost','var(--chart-loss)','Lost the round and the gun with it'],
  ['save','Saved','var(--chart-save)','Lost the round but survived, keeping the weapon'],
];
const pct=value=>value==null?'—':`${Math.round(value)}%`;
const plural=(n,one,many=`${one}s`)=>`${n} ${n===1?one:many}`;
const outcomeText=t=>`${t.win} won, ${t.loss} lost, ${t.save} saved`;

// One row: a label, a won/lost/saved split bar sized by situations, and the
// win rate. Bars share one scale (the busiest row) so row sizes compare.
function OutcomeRow({label,chip,note,t,scale}){
  const width=scale?Math.max(4,t.total/scale*100):0;
  return (
    <li className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_3.25rem] items-center gap-3 max-sm:grid-cols-[minmax(0,1fr)_3.25rem] max-sm:gap-y-1.5"
      title={t.total?`${label}: ${outcomeText(t)} (${plural(t.total,'situation')})`:`${label}: no situations`}>
      <span className="flex min-w-0 items-center gap-2 text-sm">
        {chip}
        {note?<Hint content={note}><span className="truncate">{label}</span></Hint>:<span className="truncate">{label}</span>}
      </span>
      <span className="flex min-w-0 items-center gap-2 max-sm:order-last max-sm:col-span-2">
        <span className="flex h-2.5 min-w-0 gap-0.5" style={{width:`${width}%`}} role="img"
          aria-label={t.total?`${label}: ${outcomeText(t)}`:`${label}: no situations`}>
          {OUTCOMES.filter(([key])=>t[key]>0).map(([key,,color])=>(
            <span key={key} className="min-w-0.5 rounded-full" style={{flexGrow:t[key],flexBasis:0,background:color}}/>
          ))}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t.total||'None'}</span>
      </span>
      <span className={cn('text-right text-sm font-medium tabular-nums',!t.total&&'text-muted-foreground')}>{pct(t.winRate)}</span>
    </li>
  );
}

function OutcomeLegend(){
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {OUTCOMES.map(([key,label,color,note])=>(
        <span key={key} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{background:color}} aria-hidden="true"/><Hint content={note}>{label}</Hint></span>
      ))}
      <span>Number: situations. Right: won ÷ situations.</span>
    </div>
  );
}

function SituationChip({type}){
  return <span className="inline-flex h-5 w-9 shrink-0 items-center justify-center rounded text-xs font-semibold text-white" style={{background:CLUTCH_COLORS[type]}}>1v{type}</span>;
}

function SummaryTiles({d,agents}){
  const hardest=d.highlights[0];
  const tiles=[
    ['Situations',d.total,`${plural(d.covered,'match','matches')} with round data`],
    ['Won',`${d.win} (${pct(d.winRate)})`,`${d.loss} lost, ${d.save} saved`],
    ['Clutch kills',d.kills,d.total?`${(d.kills/d.total).toFixed(1)} per situation`:null],
    ['Hardest won',hardest?`1v${hardest.type}`:'—',hardest?[hardest.mapName,hardest.agent].filter(Boolean).join(', '):'No 1v2 or harder won yet',
      hardest?.agent?<AgentIcon agents={agents} name={hardest.agent} id={hardest.agentId} size={20}/>:null],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4 max-sm:gap-px max-sm:overflow-hidden max-sm:rounded-xl max-sm:border max-sm:bg-border" aria-label="Clutch summary" data-slot="clutch-summary">
      {tiles.map(([label,value,note,icon])=>(
        <Card key={label} className="gap-1 py-4 max-sm:rounded-none max-sm:border-0 max-sm:py-3">
          <dt className="px-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
          <dd className="truncate px-4 text-xl font-semibold tabular-nums">{value}</dd>
          {note&&<small className="flex min-w-0 items-center gap-1.5 px-4 text-xs text-muted-foreground" title={note}>{icon}<span className="truncate">{note}</span></small>}
        </Card>
      ))}
    </dl>
  );
}

function SituationCard({d}){
  const scale=Math.max(...d.byType.map(t=>t.total));
  return (
    <section aria-labelledby="clutch-situation-title">
      <Card className="gap-5">
        <CardHeader>
          <CardTitle><h2 id="clutch-situation-title">By situation</h2></CardTitle>
          <CardDescription>How many enemies were alive when your last teammate died</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3" data-slot="clutch-situations">
            {d.byType.map(t=>(
              <OutcomeRow key={t.type} label={t.total?`${(t.kills/t.total).toFixed(1)} kills per try`:'No situations'} chip={<SituationChip type={t.type}/>} t={t} scale={scale}/>
            ))}
          </ul>
          <OutcomeLegend/>
        </CardContent>
      </Card>
    </section>
  );
}

function SpikeCard({d}){
  const scale=Math.max(...d.bySpike.map(t=>t.total));
  return (
    <section aria-labelledby="clutch-spike-title">
      <Card className="gap-5">
        <CardHeader>
          <CardTitle><h2 id="clutch-spike-title">Side and spike</h2></CardTitle>
          <CardDescription>Your side, and whether the spike was down when the clutch began</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3" data-slot="clutch-spike">
            {d.bySpike.map(t=><OutcomeRow key={t.label} label={t.label} note={t.note} t={t} scale={scale}/>)}
          </ul>
          <OutcomeLegend/>
          {d.unknownSpike>0&&<p className="text-xs text-muted-foreground">{plural(d.unknownSpike,'situation')} left out: the side could not be told for that round (no plant to confirm which team attacked).</p>}
        </CardContent>
      </Card>
    </section>
  );
}

function GroupTable({id,title,label,rows,icon,tint}){
  const most=Math.max(1,...rows.map(row=>row.total));
  const tableRows=rows.map(row=>({key:row.name,cells:[
    <span className="flex min-w-0 max-w-44 items-center gap-2" title={row.name}>{icon?.(row.name)}<span className="truncate" style={tint?.(row.name)?{color:tint(row.name)}:undefined}>{row.name}</span></span>,
    tint?.(row.name)
      ?<span className="inline-flex items-center justify-end gap-2"><span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full" style={{width:`${row.total/most*100}%`,background:tint(row.name)}}/></span>{row.total}</span>
      :row.total,
    <span title={outcomeText(row)}>{row.win}</span>,
    pct(row.winRate),
    row.kills,
  ]}));
  const values=rows.map(row=>[row.name,row.total,row.win,row.winRate,row.kills]);
  return (
    <section aria-labelledby={`${id}-title`}>
      <Card className="gap-5">
        <CardHeader><CardTitle><h2 id={`${id}-title`}>{title}</h2></CardTitle></CardHeader>
        <CardContent className="max-sm:px-0">
          <SortableTable id={id} rows={tableRows} values={values} noun={label.toLowerCase()+'s'}
            caption={`Clutch situations by ${label.toLowerCase()}: situations, won, won ÷ situations and kills after the clutch began`}
            columns={[{label},{label:'Situations'},{label:'Won'},{label:'Win rate',title:'Won ÷ situations'},{label:'Kills',title:'Kills after the clutch began'}]}
            maxima={[{column:1,label:'situations'},{column:3,label:'win rate'}]}/>
        </CardContent>
      </Card>
    </section>
  );
}

const dateText=ms=>Number.isFinite(ms)?new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'}):null;

function HighlightsCard({d,agents}){
  const shown=d.highlights.slice(0,8);
  return (
    <section aria-labelledby="clutch-highlights-title">
      <Card className="gap-5">
        <CardHeader>
          <CardTitle><h2 id="clutch-highlights-title">Best clutches</h2></CardTitle>
          <CardDescription>{d.highlights.length?`The hardest of your ${plural(d.highlights.length,'1v2-or-harder win')}`:'Rounds won from 1v2 or harder show up here'}</CardDescription>
        </CardHeader>
        <CardContent>
          {shown.length?(
            <ol className="flex flex-col divide-y" data-slot="clutch-highlights">
              {shown.map(c=>(
                <li key={`${c.matchId}-${c.round}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 max-sm:gap-2">
                  <SituationChip type={c.type}/>
                  {c.agent&&<AgentIcon agents={agents} name={c.agent} id={c.agentId} size={32} className="max-sm:!size-7"/>}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{[c.mapName,`round ${c.round}`].filter(Boolean).join(', ')}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {c.agent&&<span style={agentTint(agents,c.agent,c.agentId)?{color:agentTint(agents,c.agent,c.agentId)}:undefined}>{c.agent}</span>}
                      {(()=>{const rest=[c.side==='attack'?'attack':c.side==='defense'?'defense':null,c.spikeDown?'spike down':null,dateText(c.startedAtMs)].filter(Boolean).join(', ');return c.agent&&rest?`, ${rest}`:rest;})()}
                    </span>
                  </span>
                  <Badge variant="outline" className="shrink-0 tabular-nums" title={plural(c.kills,'kill')}><span className="max-sm:hidden">{plural(c.kills,'kill')}</span><span className="sm:hidden">{c.kills}K</span></Badge>
                  {Number.isInteger(c.myR)&&Number.isInteger(c.opR)&&(
                    <span className={cn('w-12 shrink-0 text-right text-xs tabular-nums max-sm:w-10',c.matchWon===true?'text-positive':c.matchWon===false?'text-negative':'text-muted-foreground')}
                      title={c.matchWon===true?'Match won':c.matchWon===false?'Match lost':'Match drawn'}>{c.myR}–{c.opR}</span>
                  )}
                </li>
              ))}
            </ol>
          ):<p className="text-sm text-muted-foreground">None yet this act.</p>}
        </CardContent>
      </Card>
    </section>
  );
}

export function ClutchesPage(){
  const s=useEngine();
  const agents=useAgentArt();
  const ready=s.analysisState==='ready';
  const d=ready?clutchBreakdown(s.allMatches):null;
  const has=!!d&&d.total>0;
  const empty=ready&&s.allMatches.length
    ?(d.covered?'No clutch situations found this act.':'These matches came without round-by-round data, so clutches cannot be found.')
    :pageEmptyText(s,{idle:'Search for a player above to see their clutches.'});
  return (
    <main aria-labelledby="clutches-title" className="space-y-6">
      <PageHeading id="clutches-title" title="Clutches"/>
      {has&&(
        <>
          <SummaryTiles d={d} agents={agents}/>
          <div className="grid gap-6 lg:grid-cols-2">
            <SituationCard d={d}/>
            <SpikeCard d={d}/>
          </div>
          <HighlightsCard d={d} agents={agents}/>
          {/* Stacked, not two-up: the page is width-capped, so a half-width
              card (~390px) cannot hold these five columns without scrolling. */}
          <div className="grid gap-6">
            <GroupTable id="clutch-maps" title="By map" label="Map" rows={d.byMap}/>
            <GroupTable id="clutch-agents" title="By agent" label="Agent" rows={d.byAgent} icon={name=><AgentIcon agents={agents} name={name} size={22}/>} tint={name=>agentTint(agents,name)}/>
          </div>
          {d.covered<d.matches&&<p className="text-xs text-muted-foreground">{plural(d.matches-d.covered,'match','matches')} without round-by-round data are not counted.</p>}
        </>
      )}
      {!has&&s.analysisState!=='error'&&<EmptyState loading={s.analysisState==='loading'}>{empty}</EmptyState>}
    </main>
  );
}
