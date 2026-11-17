import {loadNameHistory,loadOlderNames,nameHistoryActRange} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {EmptyState,PageHeading} from '@/app/shared.jsx';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';

const dateFormat=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});

function DateCell({value}){
  const date=new Date(value);
  return <TableCell className="whitespace-nowrap tabular">{Number.isFinite(date.getTime())?<time dateTime={date.toISOString()}>{dateFormat.format(date)}</time>:'—'}</TableCell>;
}

function formatDate(value){
  const date=new Date(value);
  return Number.isFinite(date.getTime())?<time dateTime={date.toISOString()}>{dateFormat.format(date)}</time>:'—';
}

// Phones: one row per Riot ID, newest first, with its observed date range and
// act underneath, joined by a timeline rail.
function MobileNameList({rows}){
  return (
    <ol aria-label="Name history" className="relative flex flex-col" data-slot="mobile-name-list">
      {rows.map((h,i)=>{
        const act=nameHistoryActRange(h.first_seen,h.last_seen);
        const current=h.ended_at==null;
        return (
          <li key={`${h.name}#${h.tag}-${h.first_seen}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
            <span aria-hidden="true" className="relative flex w-3 shrink-0 justify-center">
              <span className={`mt-1.5 size-2.5 rounded-full ring-4 ring-background ${current?'bg-brand':'bg-muted-foreground/50'}`}/>
              {i<rows.length-1&&<span className="absolute top-4 bottom-[-6px] w-px bg-border"/>}
            </span>
            <span className="min-w-0 flex-1 rounded-xl border bg-card px-4 py-3">
              <span className="flex min-w-0 items-baseline gap-0.5 text-[15px]">
                <strong className="truncate font-bold text-[#f4f4f5]">{h.name}</strong><span className="shrink-0 font-medium text-muted-foreground">#{h.tag}</span>
                {current&&<span className="ml-auto shrink-0 pl-2 text-[11px] font-bold text-brand">Current</span>}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground tabular">{formatDate(h.first_seen)} – {formatDate(h.last_seen)}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={act.title}>{act.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function NamesPage(){
  const s=useEngine();
  const mobile=useIsMobile();
  const hasRows=s.nameHistoryState==='ready'&&s.nameHistoryRows.length>0;
  const backfill=s.nameHistoryBackfill;
  const full=Number(backfill?.next_start)||0,stored=Number(backfill?.stored_scanned)||0;
  const checked=`${full.toLocaleString()} full matches${backfill?.matchlist_complete?` + ${stored.toLocaleString()} stored records`:''}`;
  const phase=!backfill?.matchlist_complete?'scanning full matches':backfill?.stored_pending_count?'resolving archived match details':'scanning stored archive';
  const count=s.nameHistoryRows.length;
  const status=s.nameBackfillError?`Scan paused after ${checked}. Progress is saved; retry to continue.`
    :backfill?.limited?`Scan limit reached after ${checked}; available history may be incomplete.`
    :backfill?.complete?`Scan complete · ${checked} checked · ${count} name period${count===1?'':'s'} found.`
    :s.nameBackfillBusy?`${s.nameBackfillStopRequested?'Stopping after this request':'Live scan: '+phase} · ${checked} checked · ${s.nameBackfillPages} pages saved.`
    :s.nameBackfillStopped?`Scan paused · ${checked} checked. Progress is saved.`
    :backfill?.available?`${checked} checked. Start the scan to find older names; keep this tab open.`
    :'Ranked match history is unavailable for this account.';
  const buttonLabel=s.nameBackfillBusy?s.nameBackfillStopRequested?'Stopping…':'Stop scan'
    :s.nameBackfillStopped||s.nameBackfillError||backfill?.next_start||backfill?.matchlist_complete?'Resume scan':'Find older names';
  const rows=[...s.nameHistoryRows].sort((a,b)=>Date.parse(b.first_seen)-Date.parse(a.first_seen));
  const empty=s.nameHistoryState==='loading'?'Checking this player’s name history…':s.nameHistoryState==='error'?'Name history is temporarily unavailable.'
    :s.nameHistoryState==='ready'?'No name observations have been saved for this account yet.':'Search for a player above to see their name history.';
  return (
    <main aria-labelledby="names-title" className="space-y-6">
      <PageHeading id="names-title" title="Name History"/>
      {hasRows?(
        <>
          {mobile?<MobileNameList rows={rows}/>:<Card className="py-2">
            <Table aria-label="Name history table" className="rank-table text-left">
              <caption className="sr-only">Observed Riot IDs, first and last observation dates, and acts</caption>
              <TableHeader>
                <TableRow>
                  {['Riot ID','First observed','Last observed','Act'].map(label=><TableHead key={label} scope="col">{label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((h,i)=>{
                  const act=nameHistoryActRange(h.first_seen,h.last_seen);
                  return (
                    <TableRow key={`${h.name}#${h.tag}-${h.first_seen}-${i}`}>
                      <TableHead scope="row">
                        <span className="flex items-baseline text-[15px]">
                          <strong className="font-bold text-[#f4f4f5]">{h.name}</strong><span className="font-medium text-muted-foreground">#{h.tag}</span>
                          {h.ended_at==null&&<span className="ml-[9px] text-[11px] font-bold text-brand">Current</span>}
                        </span>
                      </TableHead>
                      <DateCell value={h.first_seen}/>
                      <DateCell value={h.last_seen}/>
                      <TableCell title={act.title} className="whitespace-nowrap">{act.label}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>}
          <div className="flex flex-wrap items-center gap-3">
            {!backfill?.complete&&backfill?.available&&(
              <Button variant="outline" disabled={!!backfill?.limited||s.nameBackfillStopRequested} onClick={loadOlderNames}>{buttonLabel}</Button>
            )}
            <span role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</span>
            {s.nameBackfillBusy&&<span className="h-1 w-32 overflow-hidden rounded-full bg-muted" aria-label="Scanning available name history"><span className="block h-full w-1/3 rounded-full bg-rank" style={{animation:'indeterminate 1.4s ease-in-out infinite'}}/></span>}
          </div>
        </>
      ):(
        <EmptyState>
          {empty}
          {s.nameHistoryState==='error'&&s.PUUID&&<div className="mt-3"><Button variant="outline" size="sm" onClick={()=>loadNameHistory(s.PUUID)}>Try again</Button></div>}
        </EmptyState>
      )}
      <p className="text-xs text-muted-foreground">Dates are the first and last observations in UTC. Episode/Act labels mark the acts containing those observations; a gap can contain unobserved rename activity.</p>
    </main>
  );
}
