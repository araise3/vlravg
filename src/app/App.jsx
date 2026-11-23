import {Activity,useEffect,useRef} from 'react';
import {AlertCircle} from 'lucide-react';
import {hexToRgb,navigateToPage} from '@/engine/core.mjs';
import {useEngine,useIsMobile,useSignal} from '@/app/hooks.js';
import {PageLink} from '@/app/shared.jsx';
import {SearchHeader} from '@/app/SearchHeader.jsx';
import {MobileTabBar} from '@/app/MobileShell.jsx';
import {OverviewPage} from '@/app/pages/Overview.jsx';
import {DuosPage} from '@/app/pages/Duos.jsx';
import {LobbyRankPage} from '@/app/pages/LobbyRank.jsx';
import {ServersPage} from '@/app/pages/Servers.jsx';
import {RRPage} from '@/app/pages/RR.jsx';
import {MatchesPage} from '@/app/pages/Matches.jsx';
import {ClutchesPage} from '@/app/pages/Clutches.jsx';
import {NamesPage} from '@/app/pages/Names.jsx';
import {ReplaysPage} from '@/app/pages/Replays.jsx';
import {Alert,AlertDescription,AlertTitle} from '@/components/ui/alert';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {TooltipProvider} from '@/components/ui/tooltip';
import {cn} from '@/lib/utils';

const NAV=[
  ['overview','Overview'],['duos','Duos'],['lobby-rank','Lobby Rank'],['servers','Servers'],
  ['rr','RR Breakdown'],['clutches','Clutches'],['matches','Match History'],['names','Name History'],['replays','Replays'],
];

// shadcn Tabs as page navigation. Each trigger is a real link (new-tab and
// copy-link keep working); the list wraps onto more rows on phones so every
// page stays reachable without sideways scrolling.
function PageNav({navRef,mobile}){
  const s=useEngine();
  const visible=s.analysisState==='ready'||s.nameHistoryState==='ready';
  // Phones get a fixed bottom tab bar, shown as soon as a search starts so the
  // pages' own loading states are reachable.
  if(mobile)return s.hasAnalysis||visible?<MobileTabBar/>:null;
  if(!visible)return null;
  return (
    <nav aria-label="Main navigation" ref={navRef}>
      <Tabs value={s.activePage} onValueChange={navigateToPage} activationMode="manual">
        <TabsList className="h-auto max-w-full flex-wrap justify-start max-sm:w-full">
          {NAV.map(([page,label])=>(
            <TabsTrigger key={page} value={page} asChild className="h-8 flex-none px-3 max-sm:flex-1">
              <PageLink page={page} aria-current={s.activePage===page?'page':undefined}>{label}</PageLink>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </nav>
  );
}

// One page of the shared dataset. Every page stays mounted, so navigation keeps
// open matches, sorting and scroll state, but a hidden page sits in a hidden
// <Activity> (23 Nov 2026): React keeps its state and DOM and renders its
// updates only when the main thread is idle, in small interruptible slices.
// During a search the engine publishes dozens of updates, and re-rendering
// all nine pages on each one blocked the main thread for seconds (Duos,
// Match History and RR Breakdown cost the most while hidden). Effects inside
// a hidden page pause and run again when it is shown.
function PageSlot({id,page,children}){
  const shown=id===page;
  return <div hidden={!shown}><Activity mode={shown?'visible':'hidden'}>{children}</Activity></div>;
}

export default function App(){
  const s=useEngine();
  const navRef=useRef(null);
  const resultsRef=useRef(null);
  useEffect(()=>{
    const root=document.documentElement.style;
    root.setProperty('--rank',s.accentColor);
    root.setProperty('--rank-rgb',hexToRgb(s.accentColor).replaceAll(',',' '));
  },[s.accentColor]);
  useSignal(s.pageFocusSignal,()=>{
    const target=s.activePage==='overview'
      ?navRef.current?.querySelector('[aria-current="page"]')
      :document.getElementById(`${s.activePage}-title`);
    target?.focus({preventScroll:true});
  });
  useSignal(s.scrollResultsSignal,()=>resultsRef.current?.scrollIntoView({behavior:'smooth',block:'start'}));
  const page=s.activePage;
  const mobile=useIsMobile();
  // Phones behave like app tabs: each page keeps its own scroll position and a
  // page opened for the first time starts at the top.
  const scrollByPage=useRef(new Map());
  const shownPage=useRef(page);
  useEffect(()=>{
    const previous=shownPage.current;
    shownPage.current=page;
    if(!mobile||previous===page)return;
    scrollByPage.current.set(previous,window.scrollY);
    window.scrollTo({top:scrollByPage.current.get(page)||0,behavior:'instant'});
  },[page,mobile]);
  useEffect(()=>{if(s.analysisState==='loading')scrollByPage.current.clear();},[s.analysisState]);
  // Before any search the overview is a centered landing console.
  const landing=!s.hasAnalysis&&page==='overview';
  // Phones: the sticky top bar is full-bleed and the fixed tab bar needs room
  // at the bottom (plus the home-indicator inset).
  const tabBar=mobile&&(s.hasAnalysis||s.analysisState==='ready'||s.nameHistoryState==='ready');
  return (
    <TooltipProvider delayDuration={200}>
      <div data-layout={mobile?'mobile':'desktop'} className={cn('mx-auto w-full px-6',landing
        ?'flex min-h-dvh max-w-[1040px] flex-col justify-center py-12 max-[700px]:justify-start max-[700px]:px-5 max-[700px]:pt-[clamp(72px,15vh,128px)]'
        :mobile?'space-y-5 px-4 pt-0':'max-w-[960px] space-y-6 pt-10 pb-20 max-[700px]:pt-6',
        tabBar?'pb-[calc(6rem+env(safe-area-inset-bottom))]':mobile&&!landing&&'pb-12')}>
        <SearchHeader/>
        <PageNav navRef={navRef} mobile={mobile}/>
        <div ref={resultsRef} className="scroll-mt-4">
          {s.errorMessage&&(
            <Alert variant="destructive" className="mb-6">
              <AlertCircle aria-hidden="true"/>
              <AlertTitle>Error: {s.errorMessage}</AlertTitle>
              <AlertDescription>{mobile?'Search again in a moment.':'Check the browser console (F12) for details.'}</AlertDescription>
            </Alert>
          )}
          {/* Pages stay mounted so navigation keeps open matches and scroll state;
              hidden pages render at idle priority (PageSlot). */}
          <PageSlot id="overview" page={page}><OverviewPage/></PageSlot>
          <PageSlot id="duos" page={page}><DuosPage/></PageSlot>
          <PageSlot id="lobby-rank" page={page}><LobbyRankPage/></PageSlot>
          <PageSlot id="servers" page={page}><ServersPage active={page==='servers'}/></PageSlot>
          <PageSlot id="rr" page={page}><RRPage/></PageSlot>
          <PageSlot id="clutches" page={page}><ClutchesPage/></PageSlot>
          <PageSlot id="matches" page={page}><MatchesPage/></PageSlot>
          <PageSlot id="names" page={page}><NamesPage/></PageSlot>
          <PageSlot id="replays" page={page}><ReplaysPage active={page==='replays'}/></PageSlot>
        </div>
      </div>
    </TooltipProvider>
  );
}
