import {useEffect,useRef} from 'react';
import {Upload} from 'lucide-react';
import {replayRowView,toggleReplaySteps,uploadReplay,watchReplay} from '@/engine/core.mjs';
import {useEngine,useNow} from '@/app/hooks.js';
import {Hint,WipBadge} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';

// The replay import on the opened match card (26 Nov 2026, on request: the
// Replays tab was removed and its upload button and match ID moved here). Only
// an opened card mounts it, so statuses are fetched for opened matches only.
const TONES={parsed:'text-positive',busy:'text-sky-300',bad:'text-negative'};
const STEP_DOT={done:'bg-win',active:'bg-sky-400 animate-pulse',failed:'bg-loss',skipped:'bg-muted-foreground',pending:'bg-muted'};
const MATCH_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function replayDuration(ms){
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

const DEMOS_HINT='Replays are saved in %LOCALAPPDATA%\\VALORANT\\Saved\\Demos and named by match ID. A file is accepted only for the match it was recorded in, and the parsed replay must contain every player HenrikDev lists for that match. Uploads are parsed offline in a sandbox and kept apart from HenrikDev match data. Replay import is still being built: uploads can fail or be unavailable, and what a parsed replay shows may change.';

export function ReplaySection({m}){
  const s=useEngine();
  const id=String(m.matchId||'').toLowerCase();
  const valid=MATCH_ID.test(id);
  useEffect(()=>{if(valid)watchReplay(id);},[valid,id]);
  const inputRef=useRef(null),turnstileRef=useRef(null);
  if(!valid)return null;
  const view=replayRowView(id);
  const enabled=s.replayConfig?.enabled;
  return (
    <section className="space-y-2 border-t pt-3 text-sm" aria-label="Replay" data-slot="match-replay">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 font-medium">
          <Hint content={DEMOS_HINT}>Replay</Hint><WipBadge/>
        </span>
        <span className="min-w-0 font-mono text-xs break-all text-muted-foreground select-all" data-slot="match-id" title="Match ID">{id}</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span role="status" className={cn('font-medium',TONES[view.tone]||'text-muted-foreground')}>{view.label}</span>
          {enabled===false&&<span className="text-muted-foreground">Uploads are unavailable right now</span>}
          {view.foldable&&<Button variant="ghost" size="sm" aria-expanded={!view.folded} onClick={()=>toggleReplaySteps(id)}>{view.folded?'Details':'Hide details'}</Button>}
          {view.canUpload&&(
            <Button variant="outline" size="sm" aria-label={`Upload replay for ${m.mapName||'this match'}`} onClick={()=>inputRef.current?.click()}>
              <Upload aria-hidden="true"/>Upload .vrf
            </Button>
          )}
          <input ref={inputRef} type="file" accept=".vrf" hidden onChange={event=>{
            const file=event.target.files?.[0];event.target.value='';
            if(file)uploadReplay(id,file,turnstileRef.current);
          }}/>
        </span>
      </div>
      {view.detail&&<p className="text-negative">{view.detail}</p>}
      {view.steps.length>0&&!view.folded&&<ReplaySteps steps={view.steps}/>}
      <div ref={turnstileRef} className="empty:hidden"/>
    </section>
  );
}
