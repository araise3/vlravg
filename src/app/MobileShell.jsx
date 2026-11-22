import {useEffect,useRef,useState} from 'react';
import {
  ArrowRight,ChevronRight,Crosshair,Ellipsis,ExternalLink,Film,Gauge,History,IdCard,LayoutGrid,Search,Server,TrendingUp,Users,X,
} from 'lucide-react';
import {analyzeProAccount,proSearchResults,rColor,rName,setSearchText,submitSearch} from '@/engine/core.mjs';
import {useEngine,useSignal} from '@/app/hooks.js';
import {PageLink,RankIcon,Sep} from '@/app/shared.jsx';
import {ActPicker,StatusBar} from '@/app/SearchHeader.jsx';
import {ProAccount,ProGroupHeading,ProRegionFilter,filterProRegion,proAccountLabel,proGroups,proRegionCounts} from '@/app/pro-library.jsx';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {InputGroup,InputGroupAddon,InputGroupButton,InputGroupInput} from '@/components/ui/input-group';
import {Sheet,SheetContent,SheetDescription,SheetHeader,SheetTitle} from '@/components/ui/sheet';
import {Item,ItemActions,ItemContent,ItemDescription,ItemMedia,ItemTitle} from '@/components/ui/item';
import {Progress} from '@/components/ui/progress';
import {Spinner} from '@/components/ui/spinner';

// The phone layout (below Tailwind's 640px `sm` breakpoint). Desktop keeps the
// search card and the tab strip; phones get an app shell instead:
//   - a sticky top bar with the loaded account, the act picker and Tracker.gg,
//   - a full-screen search sheet (one field: Riot ID, PUUID or pro name, with
//     pro matches listed live under it),
//   - a bottom tab bar for the four main pages plus a "More" sheet.
// Pages stay mounted in App.jsx either way; only this chrome is swapped.

export const MOBILE_TABS=[
  {page:'overview',label:'Overview',icon:LayoutGrid},
  {page:'matches',label:'Matches',icon:History},
  {page:'rr',label:'RR',icon:TrendingUp},
  {page:'duos',label:'Duos',icon:Users},
];
export const MOBILE_MORE=[
  {page:'clutches',label:'Clutches',icon:Crosshair,note:'Your 1vX situations by side, map and agent'},
  {page:'lobby-rank',label:'Lobby Rank',icon:Gauge,note:'Your stats by lobby rank, team vs enemy'},
  {page:'servers',label:'Servers',icon:Server,note:'Results per server and the EU ping map'},
  {page:'names',label:'Name History',icon:IdCard,note:'Riot IDs this account has used'},
  {page:'replays',label:'Replays',icon:Film,note:'Upload a .vrf replay for a loaded match'},
];

function rankSummary(info){
  const current=info?.current;
  const hasRank=current?.tier?.name||Number.isInteger(current?.tier?.id);
  if(!hasRank)return null;
  const tier=current.tier.id;
  const name=tier<=2?'Unranked':current.tier.name||rName(tier);
  return {tier,name,rr:tier>=3&&current.rr!=null?current.rr:null};
}

/* ── Search sheet ─────────────────────────────────────────── */
const PRO_LIMIT=50;

export function MobileSearchSheet({open,onOpenChange}){
  const s=useEngine();
  const inputRef=useRef(null);
  const submitted=useRef(false);
  const [shaking,setShaking]=useState(false);
  useSignal(s.searchShakeSignal,()=>{submitted.current=false;setShaking(false);requestAnimationFrame(()=>setShaking(true));});
  // A valid submit starts an analysis (state "loading"); close then. An
  // invalid one shakes the field and keeps the sheet open.
  useEffect(()=>{
    if(submitted.current&&s.analysisState==='loading'){submitted.current=false;onOpenChange(false);}
  },[s.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const query=s.searchText.trim();
  const [region,setRegion]=useState('all');
  const allPros=s.proLibraryState==='ready'?proSearchResults(query):[];
  const pros=filterProRegion(allPros,region);
  // Browsing lists every team; a search lists at most PRO_LIMIT matches.
  const groups=proGroups(query?pros.slice(0,PRO_LIMIT):pros,query);
  const flatHidden=query?pros.length-Math.min(pros.length,PRO_LIMIT):0;
  const looksLikeId=/#/.test(query)||/^[0-9a-f-]{30,}$/i.test(query);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="top" showCloseButton={false} aria-describedby={undefined}
        onOpenAutoFocus={event=>{event.preventDefault();inputRef.current?.focus();inputRef.current?.select();}}
        className="h-dvh gap-0 border-0 pt-[env(safe-area-inset-top)]">
        <SheetTitle className="sr-only">Search players</SheetTitle>
        <form role="search" className="flex items-center gap-2 px-4 pt-3 pb-3"
          onSubmit={event=>{event.preventDefault();submitted.current=true;submitSearch();}}>
          <InputGroup className={cn('h-11 min-w-0 flex-1',shaking&&'animate-[shake-bar_.4s_ease]')} onAnimationEnd={()=>setShaking(false)}>
            <InputGroupAddon><Search aria-hidden="true"/></InputGroupAddon>
            <InputGroupInput ref={inputRef} value={s.searchText} onChange={event=>setSearchText(event.target.value)}
              placeholder="name#tag, pro player or PUUID" aria-label="Player name and tag, pro player, or PUUID"
              autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" className="text-base"/>
            {s.searchText&&(
              <InputGroupAddon align="inline-end">
                <InputGroupButton type="button" size="icon-xs" variant="ghost" aria-label="Clear search" onClick={()=>{setSearchText('');inputRef.current?.focus();}}>
                  <X aria-hidden="true"/>
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <Button type="button" variant="ghost" className="h-11 px-2.5 text-muted-foreground" onClick={()=>onOpenChange(false)}>Cancel</Button>
        </form>
        <div className="flex items-center gap-2 border-b px-4 pb-3">
          <ActPicker className="h-9 min-w-0 flex-1 justify-between"/>
          <Button type="button" className="h-9 shrink-0" onClick={()=>{submitted.current=true;submitSearch();}}>
            Search<ArrowRight aria-hidden="true"/>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] scrollbar-thin">
          <div className="flex items-baseline justify-between px-2 pt-1 pb-2 text-xs text-muted-foreground">
            <span className="font-medium tracking-wide uppercase">Pro players</span>
            <span className="tabular-nums">
              {s.proLibraryState==='loading'?'Loading':s.proLibraryState==='error'?'Unavailable':`${pros.length} ${pros.length===1?'account':'accounts'}`}
            </span>
          </div>
          {s.proLibraryState==='ready'&&<ProRegionFilter value={region} onChange={setRegion} counts={proRegionCounts(allPros)} className="px-1 pb-2"/>}
          {s.proLibraryState==='loading'&&<div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Spinner/>Loading pro players…</div>}
          {s.proLibraryState==='error'&&<p className="px-2 py-8 text-center text-sm text-muted-foreground">The pro library could not be loaded.</p>}
          {s.proLibraryState==='ready'&&!pros.length&&(
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              {looksLikeId?<>No pro matches. Tap <span className="font-medium text-foreground">Search</span> to look up <span className="font-medium text-foreground break-all">{query}</span>.</>:`No pro players match that search${region!=='all'?` in ${region}`:''}.`}
            </p>
          )}
          {groups.map(group=>(
            <section key={group.key} aria-label={group.flat?'Search results':group.heading} className="border-border pb-1 not-first-of-type:border-t">
              <h3 className="px-[9px] pt-2.5 pb-1 text-xs"><ProGroupHeading group={group} size="lg"/></h3>
              <ul className="flex flex-col">
                {group.rows.map(row=>(
                  <li key={row.puuid}>
                    <Item asChild size="sm" className="w-full min-w-0 flex-nowrap gap-3 rounded-lg px-2 py-2.5 text-left text-base hover:bg-foreground/10 active:bg-foreground/15">
                      <button type="button" onClick={()=>{submitted.current=false;onOpenChange(false);analyzeProAccount(row);}} aria-label={proAccountLabel(row)}>
                        <ProAccount row={row} flat={group.flat} query={query} size="lg"/>
                        <ItemActions><ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true"/></ItemActions>
                      </button>
                    </Item>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {flatHidden>0&&<p className="px-2 py-3 text-center text-xs text-muted-foreground">Showing {PRO_LIMIT} of {pros.length}. Keep typing to narrow it down.</p>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── Top bar ──────────────────────────────────────────────── */
export function MobileTopBar(){
  const s=useEngine();
  const [open,setOpen]=useState(false);
  useSignal(s.searchFocusSignal,()=>setOpen(true));
  const info=s.headerInfo;
  const rank=rankSummary(info);
  const name=info?.riotId||(s.PLAYER&&s.TAG?`${s.PLAYER}#${s.TAG}`:'');
  const [player,tag]=name?[name.slice(0,name.lastIndexOf('#')),name.slice(name.lastIndexOf('#')+1)]:['',''];
  const loading=s.analysisState==='loading';
  return (
    <>
      <header data-slot="mobile-top-bar"
        className="sticky top-0 z-40 -mx-4 border-b bg-background/85 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
        <div className="flex h-14 items-center gap-3">
          <button type="button" onClick={()=>setOpen(true)} aria-label={name?`${name}. Search another player`:'Search players'}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {rank
              ?<RankIcon tier={rank.tier} size={32} className="drop-shadow-[0_2px_6px_rgb(0_0_0/.5)]"/>
              :<span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted">{loading?<Spinner className="size-4"/>:<Search className="size-4 text-muted-foreground"/>}</span>}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-0.5 leading-tight">
                {player?<><span className="truncate font-semibold">{player}</span><span className="shrink-0 text-sm text-muted-foreground">#{tag}</span></>
                  :<span className="truncate font-semibold text-muted-foreground">{loading?'Loading player…':'Search a player'}</span>}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight text-muted-foreground tabular-nums">
                {rank&&<span className="truncate font-medium" style={{color:rColor(rank.tier)}}>{rank.name}</span>}
                {rank?.rr!=null&&<span className="shrink-0">{rank.rr} RR</span>}
                {info?.region&&<><Sep/><span className="shrink-0">{info.region.toUpperCase()}</span></>}
                {!rank&&!info&&<span className="truncate">{loading?'Fetching account and matches':'Riot ID, PUUID or pro player'}</span>}
              </span>
            </span>
          </button>
          <Button type="button" variant="outline" size="icon" className="size-10 shrink-0" aria-label="Search players" onClick={()=>setOpen(true)}>
            <Search aria-hidden="true"/>
          </Button>
        </div>
        {s.hasAnalysis&&<div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ActPicker className="h-8 max-w-56 shrink-0 px-3 text-xs"/>
          {info?.showTracker&&info.trackerHref&&(
            <Button variant="outline" size="sm" asChild className="shrink-0 gap-1.5 bg-background/60 px-3 text-muted-foreground has-[>svg]:px-3 active:bg-accent">
              <a href={info.trackerHref} target="_blank" rel="noopener noreferrer" aria-label={`Open ${info.riotId} on Tracker.gg`}>
                <img src="/assets/tracker-gg.svg" alt="" className="h-3 w-[67px]"/>
                <ExternalLink className="size-3" aria-hidden="true"/>
              </a>
            </Button>
          )}
        </div>}
        {s.statusSpin&&(
          <Progress value={s.progressValue==null?null:Math.min(s.progressValue||0,100)} aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 rounded-none bg-transparent" indicatorClassName="bg-rank"/>
        )}
      </header>
      {s.statusText&&<div className="pt-3"><StatusBar bar={false}/></div>}
      <MobileSearchSheet open={open} onOpenChange={setOpen}/>
    </>
  );
}

/* ── Bottom tab bar ───────────────────────────────────────── */
function TabItem({page,label,icon:Icon,active,onClick,asButton,...props}){
  const content=(
    <>
      <span className={cn('absolute top-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-b-full bg-rank transition-opacity',active?'opacity-100':'opacity-0')} aria-hidden="true"/>
      <span className={cn('grid h-7 w-12 place-items-center rounded-md transition-colors',active&&'bg-rank/15')}>
        <Icon className={cn('size-[19px]',active&&'text-rank')} strokeWidth={active?2.25:1.9} aria-hidden="true"/>
      </span>
      <span className="max-w-full truncate px-1">{label}</span>
    </>
  );
  const className=cn('relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium tracking-tight transition-colors outline-none select-none focus-visible:bg-accent/50 [-webkit-tap-highlight-color:transparent]',
    active?'text-foreground':'text-muted-foreground active:text-foreground');
  if(asButton)return <button type="button" className={className} onClick={onClick} {...props}>{content}</button>;
  return <PageLink page={page} className={className} aria-current={active?'page':undefined} {...props}>{content}</PageLink>;
}

export function MobileTabBar(){
  const s=useEngine();
  const [moreOpen,setMoreOpen]=useState(false);
  const page=s.activePage;
  const inMore=MOBILE_MORE.find(item=>item.page===page);
  return (
    <>
      <nav aria-label="Main navigation" data-slot="mobile-tab-bar"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-16 max-w-lg items-stretch px-1">
          {MOBILE_TABS.map(tab=><TabItem key={tab.page} {...tab} active={page===tab.page}/>)}
          <TabItem asButton label={inMore?inMore.label:'More'} icon={inMore?inMore.icon:Ellipsis} active={!!inMore}
            aria-haspopup="dialog" aria-expanded={moreOpen} aria-label={inMore?`More pages, showing ${inMore.label}`:'More pages'}
            onClick={()=>setMoreOpen(true)}/>
        </div>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" aria-describedby={undefined} className="gap-3">
          <SheetHeader className="pt-1">
            <SheetTitle>More</SheetTitle>
            <SheetDescription className="sr-only">Other pages for this player</SheetDescription>
          </SheetHeader>
          <ul className="flex flex-col gap-1 px-2">
            {MOBILE_MORE.map(({page:target,label,icon:Icon,note})=>{
              const active=page===target;
              return (
                <li key={target}>
                  <Item asChild size="sm" className={cn('flex-nowrap gap-3 rounded-xl px-3 py-3 text-base focus-visible:bg-accent active:bg-accent',active&&'bg-accent')}>
                    <PageLink page={target} aria-current={active?'page':undefined} onClickCapture={()=>setMoreOpen(false)}>
                      <ItemMedia variant="icon" className={cn('size-10 rounded-xl bg-card',active&&'border-rank/50 text-rank')}><Icon className="size-[18px]" aria-hidden="true"/></ItemMedia>
                      <ItemContent className="min-w-0 gap-0">
                        <ItemTitle className="text-base">{label}</ItemTitle>
                        <ItemDescription className="line-clamp-1 text-xs">{note}</ItemDescription>
                      </ItemContent>
                      <ItemActions><ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true"/></ItemActions>
                    </PageLink>
                  </Item>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
