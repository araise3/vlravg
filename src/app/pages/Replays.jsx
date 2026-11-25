import {useEffect,useRef,useState} from 'react';
import {Construction,Upload} from 'lucide-react';
import {loadMatchMapMetadata,replayMatchRows,replayRowView,syncReplayImport,toggleReplaySteps,uploadReplay} from '@/engine/core.mjs';
import {useEngine,useNow} from '@/app/hooks.js';
import {EmptyState,PageHeading} from '@/app/shared.jsx';
import {Alert,AlertDescription,AlertTitle} from '@/components/ui/alert';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Item,ItemActions,ItemContent,ItemDescription,ItemTitle} from '@/components/ui/item';

const TONES={parsed:'text-positive',busy:'text-sky-300',bad:'text-negative'};
const STEP_DOT={done:'bg-win',active:'bg-sky-400 animate-pulse',failed:'bg-loss',skipped:'bg-muted-foreground',pending:'bg-muted'};

function replayDuration(ms){
  if(!(ms>=0))return '';
  const sec=Math.round(ms/1000);
  return sec<60?`${sec} s`:sec<3600?`${Math.floor(sec/60)} min ${sec%60} s`:`${Math.floor(sec/3600)} h ${Math.floor(sec%3600/60)} min`;
}

function ReplaySteps({steps}){
  const running=steps.some(step=>step.since&&step.state==='active');
  const now=useNow(running);
  return (
    <ol className="space-y-1.5 text-sm" aria-label="Replay processing steps">
      {steps.map(step=>(
        <li key={step.key} className="flex gap-2.5">
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full',STEP_DOT[step.state])} aria-hidden="true"/>
          <span className="min-w-0">
            <span className={cn('font-medium',step.state==='pending'&&'text-muted-foreground',step.state==='failed'&&'text-negative')}>{step.label}</span>
            <span className="ml-2 text-muted-foreground">
              {step.detail}
              {step.since&&step.state==='active'&&<>{step.detail?'; ':''}{replayDuration(now-Date.parse(step.since))}</>}
              {step.link&&<>{(step.detail||step.since)?'; ':''}<a href={step.link.href} target="_blank" rel="noopener noreferrer" className="underline">{step.link.text}</a></>}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ReplayRow({row,art}){
  useEngine();
  const view=replayRowView(row.matchId);
  const inputRef=useRef(null),turnstileRef=useRef(null);
  return (
    <li>
      {/* An outline Item: the match on the left, status and actions on the
          right, then full-width rows for the error, the steps and Turnstile. */}
      <Item variant="outline" className="relative gap-x-3 gap-y-2 overflow-hidden rounded-xl bg-card px-4 py-2 text-base shadow-sm">
        {art&&<img src={art} alt="" loading="lazy" decoding="async" className="absolute inset-y-0 right-0 h-full w-1/2 object-cover opacity-20 [mask-image:linear-gradient(to_left,black,transparent)]" onError={event=>event.currentTarget.remove()}/>}
        {/* One line from sm up (the match ID sits after the date and
            truncates); two lines on phones. */}
        <ItemContent className="relative min-w-0 gap-0 sm:flex-row sm:items-baseline sm:gap-3">
          <ItemTitle className="shrink-0 flex-wrap items-baseline text-base font-normal">
            <strong>{row.map}</strong>
            <span className={cn('font-semibold tabular',row.result==='win'?'text-positive':row.result==='loss'?'text-negative':'text-draw')}>{row.score}</span>
            <span className="text-sm text-muted-foreground">{row.date}</span>
          </ItemTitle>
          <ItemDescription className="min-w-0 line-clamp-1 font-mono text-xs break-all">{row.matchId}</ItemDescription>
        </ItemContent>
        <ItemActions className="relative flex-wrap">
          <span role="status" className={cn('text-sm font-medium',TONES[view.tone]||'text-muted-foreground')}>{view.label}</span>
          {view.foldable&&<Button variant="ghost" size="sm" aria-expanded={!view.folded} onClick={()=>toggleReplaySteps(row.matchId)}>{view.folded?'Details':'Hide details'}</Button>}
          {view.canUpload&&(
            <Button variant="outline" size="sm" aria-label={`Upload replay for ${row.map} ${row.date}`} onClick={()=>inputRef.current?.click()}>
              <Upload aria-hidden="true"/>Upload .vrf
            </Button>
          )}
          <input ref={inputRef} type="file" accept=".vrf" hidden onChange={event=>{
            const file=event.target.files?.[0];event.target.value='';
            if(file)uploadReplay(row.matchId,file,turnstileRef.current);
          }}/>
        </ItemActions>
        {view.detail&&<p className="relative basis-full text-sm text-negative">{view.detail}</p>}
        {view.steps.length>0&&!view.folded&&<div className="relative basis-full"><ReplaySteps steps={view.steps}/></div>}
        <div ref={turnstileRef} className="basis-full empty:hidden"/>
      </Item>
    </li>
  );
}

export function ReplaysPage({active}){
  const s=useEngine();
  const [maps,setMaps]=useState(null);
  const ready=s.analysisState==='ready';
  const hasMatches=ready&&s.allMatches.length>0;
  const rows=hasMatches?replayMatchRows(s.allMatches):[];
  const ids=rows.map(row=>row.matchId).join(',');
  useEffect(()=>{if(active&&hasMatches)syncReplayImport();},[active,hasMatches,ids]);
  useEffect(()=>{if(active&&hasMatches&&!maps)loadMatchMapMetadata().then(setMaps);},[active,hasMatches,maps]);
  return (
    <main aria-labelledby="replays-title" className="space-y-6">
      <PageHeading id="replays-title" title="Replay import"/>
      {/* Marked work in progress on request (24 Nov 2026): the parser does
          not support every game build yet (docs/replay-import.md). */}
      <Alert data-slot="wip-notice">
        <Construction aria-hidden="true"/>
        <AlertTitle>Work in progress</AlertTitle>
        <AlertDescription>Replay import is still being built. Uploads can fail or be unavailable, and what a parsed replay shows may change.</AlertDescription>
      </Alert>
      {hasMatches?(
        <>
          {s.replayConfig&&!s.replayConfig.enabled&&<p role="status" aria-live="polite" className="text-sm text-muted-foreground">Replay uploads are not available right now.</p>}
          <ul className="space-y-2" aria-label="Loaded matches and their replays">
            {rows.map(row=><ReplayRow key={row.matchId} row={row} art={maps?.get(row.map.toLowerCase())}/>)}
          </ul>
          <p className="text-xs text-muted-foreground">Replays are saved in <code className="rounded bg-muted px-1 py-0.5">%LOCALAPPDATA%\VALORANT\Saved\Demos</code> and named by match ID. A file is accepted only for the match it was recorded in, and the parsed replay must contain every player HenrikDev lists for that match. Uploads are parsed offline in a sandbox and kept apart from HenrikDev match data.</p>
        </>
      ):s.analysisState!=='error'&&(
        <EmptyState loading={s.analysisState==='loading'}>{s.analysisState==='loading'?'Loading this player’s matches…':ready?'No matches found for this season. Try another act.':'Search for a player above to upload replays for their matches.'}</EmptyState>
      )}
    </main>
  );
}
