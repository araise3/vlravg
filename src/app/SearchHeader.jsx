import {useEffect,useRef,useState} from 'react';
import {ArrowRight,CalendarDays,Check,ChevronDown,ExternalLink,Search,Users} from 'lucide-react';
import {
  analyzeProAccount,proSearchResults,requestSeasonDropdown,rColor,rName,
  seasonOptionCountText,selectSeasonOption,setSearchText,submitSearch,
} from '@/engine/core.mjs';
import {useEngine,useIsMobile,useSignal} from '@/app/hooks.js';
import {RankIcon} from '@/app/shared.jsx';
import {ProAccount,ProGroupHeading,ProRegionFilter,filterProRegion,proAccountLabel,proGroups,proRegionCounts} from '@/app/pro-library.jsx';
import {MobileSearchSheet,MobileTopBar} from '@/app/MobileShell.jsx';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {ButtonGroup} from '@/components/ui/button-group';
import {Card,CardContent} from '@/components/ui/card';
import {Command,CommandEmpty,CommandGroup,CommandInput,CommandItem,CommandList} from '@/components/ui/command';
import {InputGroup,InputGroupAddon,InputGroupButton,InputGroupInput} from '@/components/ui/input-group';
import {Kbd,KbdGroup} from '@/components/ui/kbd';
import {Popover,PopoverAnchor,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {Progress} from '@/components/ui/progress';
import {Spinner} from '@/components/ui/spinner';

// Search built from shadcn parts: an InputGroup (icon, input, shortcut hint,
// submit button) beside a ButtonGroup holding the pro library and act picker.
// On the landing page it sits under the intro; once a player loads it moves
// into a Card with the account's rank and region badges and the status line.

function Intro(){
  return (
    <header className="mx-auto mb-4 max-w-[660px] text-center">
      <div className="mb-[22px] inline-flex items-center gap-1.5 text-[15px] font-[650] tracking-[-.035em] text-foreground" aria-label="vlravg">
        <span className="mr-[3px] inline-grid size-[25px] place-items-center rounded-md border bg-card shadow-xs" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" className="size-3.5 text-brand"><path d="M3 4.5 7.6 15h4.8L17 4.5h-3.6L10 12.2 6.6 4.5H3Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round"/></svg>
        </span>
        <span>vlr</span><span className="font-normal text-muted-foreground">/</span><span>avg</span>
      </div>
      <h1 className="text-[clamp(2rem,5vw,3.5rem)] leading-[1.02] font-semibold tracking-[-.052em] text-balance">Read the lobby,<br/>not just the rank.</h1>
      <p className="mx-auto mt-4 max-w-[590px] text-[15px] leading-[1.65] text-balance text-muted-foreground">Search any Valorant account—or pick a pro—to uncover lobby strength, RR movement, teammates, clutch performance, and match history.</p>
    </header>
  );
}

// The pro library (redesigned 22 Nov 2026, see pro-library.jsx): a header
// with the count, the search box, a region filter, then players grouped by
// team in two columns where the popover is wide enough. Arrow keys move
// through the list in reading order; Enter opens the profile.
function ProLibraryPanel({onPick}){
  const s=useEngine();
  const [query,setQuery]=useState('');
  const [region,setRegion]=useState('all');
  const ready=s.proLibraryState==='ready';
  const all=ready?proSearchResults(query):[];
  const results=filterProRegion(all,region);
  const groups=proGroups(results,query);
  const count=s.proLibraryState==='loading'?'Loading':s.proLibraryState==='error'?'Unavailable'
    :`${results.length} ${results.length===1?'account':'accounts'}`;
  return (
    <Command shouldFilter={false} label="Pro player library" className="min-h-0 flex-1 bg-transparent">
      <div className="flex items-baseline justify-between gap-3 px-2.5 pt-2 pb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Pro players</div>
          <div className="text-xs text-muted-foreground">Partnered teams from Rostermania’s rosters. Opens the player’s current account.</div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-live="polite">{count}</span>
      </div>
      <CommandInput placeholder="Search player, team or PUUID" value={query} onValueChange={setQuery} autoFocus className="max-sm:text-base"/>
      {ready&&<ProRegionFilter value={region} onChange={setRegion} counts={proRegionCounts(all)} className="px-1.5 pt-2"/>}
      <CommandList className="max-h-[min(56vh,520px)] min-h-0 flex-1 scrollbar-thin">
        {s.proLibraryState==='loading'&&<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"><Spinner/>Loading pro players…</div>}
        {s.proLibraryState==='error'&&<div className="py-6 text-center text-sm text-muted-foreground">The pro library could not be loaded.</div>}
        {ready&&<CommandEmpty>No pro players match that search{region!=='all'?` in ${region}`:''}.</CommandEmpty>}
        {groups.map(group=>(
          <CommandGroup key={group.key} heading={<ProGroupHeading group={group}/>}
            className="border-border not-first:border-t [&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:gap-0.5 @min-[520px]/pro:[&_[cmdk-group-items]]:grid-cols-2">
            {group.rows.map(row=>(
              <CommandItem key={row.puuid} value={row.puuid} onSelect={()=>onPick(row)} aria-label={proAccountLabel(row)}
                className="min-w-0 gap-2.5 py-2 data-[selected=true]:bg-foreground/10">
                <ProAccount row={row} flat={group.flat} query={query}/>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center justify-end gap-3 border-t px-2.5 pt-2 pb-1 text-[11px] text-muted-foreground max-sm:hidden" aria-hidden="true">
        <span className="flex items-center gap-1"><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>Move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd>Open</span>
        <span className="flex items-center gap-1"><Kbd>Esc</Kbd>Close</span>
      </div>
    </Command>
  );
}

// Act picker: an outline Button (inside the ButtonGroup) opening a Command
// list of played acts with their match counts.
export function ActPicker({className}){
  const s=useEngine();
  const [open,setOpen]=useState(false);
  useSignal(s.seasonOpenSignal,()=>setOpen(true));
  const loading=s.seasonUi.mode==='loading';
  useEffect(()=>{if(loading)setOpen(false);},[loading]);
  const options=[{value:'',label:'Most recent act',countKind:null},...s.seasonOptions];
  const shown=open&&!loading&&s.seasonOptions.length>0;
  return (
    <Popover open={shown} onOpenChange={next=>{
      if(!next){setOpen(false);return;}
      if(s.seasonOptions.length)setOpen(true);
      else requestSeasonDropdown();
    }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" disabled={loading} aria-label={`Act: ${s.seasonTriggerLabel}`}
          className={cn('min-w-0 justify-between disabled:cursor-wait',shown&&'bg-accent dark:bg-input/50',className)}>
          {loading?<Spinner/>:<CalendarDays aria-hidden="true"/>}
          <span className="truncate" title={s.seasonTriggerLabel}>{s.seasonTriggerLabel}</span>
          <ChevronDown className={cn('opacity-60 transition-transform',shown&&'rotate-180')} aria-hidden="true"/>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[min(220px,calc(100vw-24px))] p-1">
        <Command label="Played acts" value={s.seasonValue||'recent'} className="bg-transparent">
          <CommandList className="max-h-[min(320px,calc(100dvh-24px))] scrollbar-thin">
            <CommandGroup className="p-0">
              {options.map(option=>{
                const countText=seasonOptionCountText(option);
                const selected=option.value===s.seasonValue;
                return (
                  <CommandItem key={option.value||'recent'} value={option.value||'recent'} onSelect={()=>{setOpen(false);selectSeasonOption(option.value);}}
                    aria-label={countText?`${option.label}, ${countText}`:option.label}
                    className="relative flex-col items-start gap-0.5 py-2 pr-8">
                    <span className={cn('max-w-full truncate',selected&&'font-medium')}>{option.label}</span>
                    {countText&&<span className="text-xs text-muted-foreground tabular-nums">{countText}</span>}
                    {selected&&<Check className="absolute top-1/2 right-2 -translate-y-1/2" aria-hidden="true"/>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// The loaded account slides into the right end of the search input as three
// separate pills (current rank, region, Tracker.gg), one after another. Phones
// lack the width, so there the same pills slide in on their own row below.
const SLIDE='animate-in fade-in-0 slide-in-from-right-4 duration-300 ease-out fill-mode-backwards motion-reduce:animate-none';
const PILL='inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border bg-background/60 px-2.5 text-xs font-medium whitespace-nowrap shadow-xs dark:bg-input/40';

export function AccountBadges({info}){
  const current=info.current;
  const hasRank=current?.tier?.name||Number.isInteger(current?.tier?.id);
  const rankName=hasRank?(current.tier.id<=2?'Unranked':current.tier.name||rName(current.tier.id)):'';
  const showRR=hasRank&&current.tier.id>=3&&current.rr!=null;
  return (
    <>
      {hasRank&&(
        <span data-slot="account-pill" className={cn(SLIDE,PILL,'pl-1.5 text-foreground')} aria-label={`Current rank: ${rankName}${showRR?`, ${current.rr} RR`:''}`}>
          <RankIcon tier={current.tier.id} size={14}/>
          <span style={{color:rColor(current.tier.id)}}>{rankName}</span>
          {showRR&&<span className="font-normal text-muted-foreground tabular-nums">{current.rr} RR</span>}
        </span>
      )}
      {info.region&&<span data-slot="account-pill" className={cn(SLIDE,PILL,'text-foreground [animation-delay:90ms]')} aria-label={`Region: ${info.region.toUpperCase()}`}>{info.region.toUpperCase()}</span>}
      {info.showTracker&&info.trackerHref&&(
        // A Button (outline) rendered as the link, sized down to the shared pill.
        <Button data-slot="account-pill" variant="outline" size="sm" asChild
          className={cn(SLIDE,PILL,'text-muted-foreground [animation-delay:180ms] has-[>svg]:px-2.5 hover:text-foreground max-sm:ml-auto')}>
          <a href={info.trackerHref} target="_blank" rel="noopener noreferrer" aria-label={`Open ${info.riotId} on Tracker.gg`}>
            <img src="/assets/tracker-gg.svg" alt="" className="h-3 w-[67px]"/>
            <ExternalLink className="size-3" aria-hidden="true"/>
          </a>
        </Button>
      )}
    </>
  );
}

// `bar={false}`: text only (the phone top bar draws its own progress line).
export function StatusBar({bar=true}){
  const s=useEngine();
  if(!s.statusText)return null;
  return (
    <div className="flex flex-col gap-2">
      <div role="status" aria-live="polite" className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {s.statusSpin&&<Spinner className="size-3.5"/>}
        <span>{s.statusText}</span>
      </div>
      {bar&&s.statusSpin&&<Progress value={s.progressValue==null?null:Math.min(s.progressValue||0,100)} className="h-1" indicatorClassName="rounded-full" aria-label="Loading matches"/>}
    </div>
  );
}

const IS_MAC=typeof navigator!=='undefined'&&/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent||'');

export function SearchHeader(){
  const s=useEngine();
  const inputRef=useRef(null);
  const [shaking,setShaking]=useState(false);
  const [proOpen,setProOpen]=useState(false);
  const [sheetOpen,setSheetOpen]=useState(false);
  const landing=!s.hasAnalysis&&s.activePage==='overview';
  const info=s.headerInfo;
  useSignal(s.searchShakeSignal,()=>{setShaking(false);requestAnimationFrame(()=>setShaking(true));});
  useSignal(s.searchFocusSignal,()=>inputRef.current?.focus());
  useEffect(()=>{
    const onKey=event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown',onKey);
    return()=>document.removeEventListener('keydown',onKey);
  },[]);
  // Phones swap the search card for a sticky app bar once a player is loaded
  // (the landing page keeps the full search form).
  const mobile=useIsMobile();
  if(mobile&&!landing)return <MobileTopBar/>;
  const height=landing?'h-11':'h-10';
  const search=(
    <Popover open={proOpen} onOpenChange={setProOpen}>
      <PopoverAnchor asChild>
        <form role="search" className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap"
          onSubmit={event=>{event.preventDefault();submitSearch();}}>
          <InputGroup className={cn(height,'min-w-0 flex-1 max-sm:basis-full',shaking&&'animate-[shake-bar_.4s_ease]')}
            onAnimationEnd={()=>setShaking(false)}>
            <InputGroupAddon><Search aria-hidden="true"/></InputGroupAddon>
            <InputGroupInput ref={inputRef} value={s.searchText} onChange={event=>setSearchText(event.target.value)}
              placeholder="name#tag, pro player or PUUID" aria-label="Player name and tag, pro player, or PUUID"
              autoComplete="off" spellCheck={false} className="max-sm:text-base"/>
            <InputGroupAddon align="inline-end">
              {info
                ?<span key={info.riotId} className="flex items-center gap-1.5 max-sm:hidden" data-slot="account-badges"><AccountBadges info={info}/></span>
                :<KbdGroup className="max-sm:hidden" aria-hidden="true"><Kbd>{IS_MAC?'⌘':'Ctrl'}</Kbd><Kbd>K</Kbd></KbdGroup>}
              <InputGroupButton type="submit" variant="default" size="sm" aria-label="Search">
                <span className="max-sm:hidden">Search</span><ArrowRight className="sm:hidden" aria-hidden="true"/>
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <ButtonGroup className="max-sm:w-full" aria-label="Search options">
            {mobile
              // Phones open the full-screen search sheet (pro list included)
              // instead of a popover that would cover the landing page.
              ?<Button type="button" variant="outline" aria-haspopup="dialog" className={cn(height,'flex-1')} onClick={()=>setSheetOpen(true)}>
                <Users aria-hidden="true"/>Pro players<ChevronDown className="opacity-60" aria-hidden="true"/>
              </Button>
              :<PopoverTrigger asChild>
                <Button type="button" variant="outline" aria-haspopup="dialog" className={cn(height,'max-sm:flex-1',proOpen&&'bg-accent dark:bg-input/50')}>
                  <Users aria-hidden="true"/>Pro players
                  <ChevronDown className={cn('opacity-60 transition-transform',proOpen&&'rotate-180')} aria-hidden="true"/>
                </Button>
              </PopoverTrigger>}
            <ActPicker className={cn(height,'max-w-48 max-sm:max-w-none max-sm:flex-1')}/>
          </ButtonGroup>
        </form>
      </PopoverAnchor>
      {/* The list shrinks to the space Radix measures on the side it opens
          (12px from the window edge), so it never runs off screen. */}
      <PopoverContent align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={event=>event.preventDefault()}
        className="@container/pro flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] flex-col p-1.5">
        <ProLibraryPanel onPick={row=>{setProOpen(false);analyzeProAccount(row);}}/>
      </PopoverContent>
    </Popover>
  );
  if(landing){
    return (
      <div className="mx-auto flex w-full max-w-[760px] -translate-y-[4vh] flex-col gap-3.5 max-[700px]:translate-y-0">
        <Intro/>
        {search}
        <StatusBar/>
        {mobile&&<MobileSearchSheet open={sheetOpen} onOpenChange={setSheetOpen}/>}
      </div>
    );
  }
  return (
    <Card className="mb-8 gap-3 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        {search}
        {info&&<div key={info.riotId} className="flex flex-wrap items-center gap-1.5 sm:hidden"><AccountBadges info={info}/></div>}
        <StatusBar/>
      </CardContent>
    </Card>
  );
}
