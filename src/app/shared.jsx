import {ChevronDown} from 'lucide-react';
import {RANK_ICONS} from '@/engine/rank-icons.mjs';
import {avgLabel,navigateToPage,pageHref,PARTY_LABELS,tierRR,toggleIncludeReset} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {Card,CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {Hint} from '@/app/hint.jsx';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {Switch} from '@/components/ui/switch';
import {Label} from '@/components/ui/label';
import {Button} from '@/components/ui/button';
import {Empty,EmptyDescription} from '@/components/ui/empty';
import {Separator} from '@/components/ui/separator';
import {Skeleton} from '@/components/ui/skeleton';

// Headline icons (64px+) use the 256px largeIcon PNGs; small badges stay embedded.
export function RankIcon({tier,size=16,className}){
  const id=typeof tier==='number'?tier:typeof tier==='string'&&/^\d+$/.test(tier)?Number(tier):null;
  const iconTier=id!=null&&id>=0&&id<=2?0:tier;
  // The embedded icons are small and not all square (Immortal 3 is 40×37), so
  // larger sizes use the 256px PNG and every size keeps its aspect ratio.
  const src=size>=32&&RANK_ICONS[iconTier]?`/assets/ranks/${iconTier}.png`:RANK_ICONS[iconTier];
  if(!src)return null;
  return <img src={src} width={size} height={size} alt="" className={cn('inline-block shrink-0 object-contain align-middle',className)} style={{width:size,height:size}}/>;
}

export function PartyIcon({size}){
  return (
    <span className="inline-flex shrink-0 text-muted-foreground" aria-hidden="true">
      {Array.from({length:Math.min(size,5)},(_,i)=>(
        <svg key={i} width="9" height="11" viewBox="0 0 9 11" fill="currentColor" style={{marginLeft:i?-3:0}}>
          <circle cx="4.5" cy="3" r="2.5"/><path d="M0 11c0-2.485 2.015-4.5 4.5-4.5S9 8.515 9 11H0z"/>
        </svg>
      ))}
    </span>
  );
}

// In-app link to another page; keeps the loaded player in the URL.
export function PageLink({page,className,children,...props}){
  return (
    <a href={pageHref(page)} className={className} {...props} onClick={event=>{
      if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      event.preventDefault();
      navigateToPage(page);
    }}>{children}</a>
  );
}

// A thin vertical rule between inline items (the site uses no dot separators):
// a shadcn Separator rendered as a span, since it sits inside text and buttons.
export function Sep({className}){
  return <Separator asChild orientation="vertical" className={cn('inline-block bg-muted-foreground/40 data-[orientation=vertical]:h-3',className)}><span/></Separator>;
}

export function toneClass(value,neutral=1){
  if(value==null||value===neutral)return '';
  return value>neutral?'text-positive':'text-negative';
}

export function LobbyValue({sum,count}){
  if(!count)return '—';
  const lobby=tierRR(sum/count);
  return (
    <span className="flex items-center gap-2 whitespace-nowrap" title={`${avgLabel(lobby.tier)}, ${lobby.rr} RR`}>
      <RankIcon tier={lobby.tier} size={22}/>{avgLabel(lobby.tier)} <span className="text-muted-foreground">({lobby.rr} RR)</span>
    </span>
  );
}

export function PlayerLink({href,name,tag,className}){
  return (
    <a href={href} className={cn('inline-flex max-w-56 items-baseline gap-0.5 font-medium hover:underline',className)} title={`${name}#${tag}`}>
      <span className="truncate">{name}</span><span className="shrink-0 text-xs text-muted-foreground">#{tag}</span>
    </a>
  );
}

// Data tables live in data-table.jsx (TanStack Table); re-exported here so
// pages keep importing them from shared.
export {MobileRowList,SortableTable,TablePager} from '@/app/data-table.jsx';
// Hover/tap explanations live in hint.jsx, which the tables use too.
export {Hint};

// A table that is a section's only content: on desktop the table's own frame
// is the card (no frame inside a frame); phones wrap the row list in a card.
export function TableSection({label,children}){
  const mobile=useIsMobile();
  return mobile
    ?<Card className="py-2" aria-label={label}><CardContent className="px-0">{children}</CardContent></Card>
    :<section aria-label={label}>{children}</section>;
}

// "Show all N" / "Show fewer" under a list cut to its first rows.
export function ShowAllButton({expanded,total,noun,onToggle,controls}){
  return (
    <div className="flex justify-center border-t px-4 py-2" data-slot="show-all">
      <Button type="button" variant="ghost" size="sm" onClick={onToggle} aria-expanded={expanded} aria-controls={controls}
        className="gap-1.5 px-3 text-muted-foreground hover:text-foreground">
        {expanded?'Show fewer':`Show all ${total} ${noun}`}
        <ChevronDown className={cn('transition-transform',expanded&&'rotate-180')} aria-hidden="true"/>
      </Button>
    </div>
  );
}

// Party-size filter; sizes absent from the current matches are hidden.
export function PartySizeFilter({label='Party size',value,available,onChange}){
  const sizes=[1,2,3,5].filter(size=>available?.has(size));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Tabs value={String(value)} onValueChange={onChange}>
        <TabsList aria-label={label}>
          <TabsTrigger value="0">All</TabsTrigger>
          {sizes.map(size=><TabsTrigger key={size} value={String(size)}>{PARTY_LABELS[size]}</TabsTrigger>)}
        </TabsList>
      </Tabs>
    </div>
  );
}

// Include placement-week games in the lobby and teammate breakdowns.
export function PlacementToggle(){
  const s=useEngine();
  const count=s.overviewStats?.resetCount||0;
  if(!count)return null;
  return (
    <Hint passive content="Include placement-week games in the lobby and teammate breakdowns.">
      <span className="flex w-fit items-center gap-2">
        <Switch id="placements-toggle" checked={s.mhIncludeReset} onCheckedChange={toggleIncludeReset}/>
        <Label htmlFor="placements-toggle" className="text-sm font-normal text-muted-foreground">Count placements ({count})</Label>
      </span>
    </Hint>
  );
}

// Inset panel that frames a chart's plot inside its card.
export function ChartFrame({className,children,...props}){
  return <div className={cn('chart-frame',className)} {...props}>{children}</div>;
}

// Key figures in one hairline-divided row: items are [label, value, className?, title?].
export function StatStrip({items,label}){
  return (
    <dl className="stat-strip" aria-label={label}>
      {items.map(([name,value,className,title])=>(
        <div key={name}>
          <dt><Hint content={title}>{name}</Hint></dt>
          <dd className={className}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Hover/focus readout for the hand-built charts. `x`/`y` are CSS pixels inside
// the chart's `relative` container; it flips to the left near the right edge.
// Decorative: every value it shows is also in the mark's aria-label or a table.
export function ChartTooltip({x,y,width,children}){
  if(x==null||y==null)return null;
  const flip=width!=null&&x+14+260>width;
  return (
    <div className="chart-tooltip" aria-hidden="true"
      style={{top:Math.max(0,y),...(flip?{right:Math.max(0,width-x+14)}:{left:x+14})}}>
      {children}
    </div>
  );
}

// A page's empty or idle state (shadcn Empty), text only. `loading`: the
// page's matches are still loading, so show placeholder blocks instead.
export function EmptyState({children,loading}){
  if(loading)return <PageSkeleton label={children}/>;
  return (
    <Empty role="status" className="rounded-xl border px-6 py-12 md:px-6 md:py-12">
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

// Placeholder blocks in a detail page's usual shape (a filter row, a summary
// card, a table) while matches load; the loading line stays for screen readers.
export function PageSkeleton({label}){
  return (
    <div role="status" className="flex flex-col gap-4" data-slot="page-skeleton">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-9 w-72 max-w-full" aria-hidden="true"/>
      <Skeleton className="h-36 rounded-xl" aria-hidden="true"/>
      <Skeleton className="h-80 rounded-xl" aria-hidden="true"/>
    </div>
  );
}

// The same, as a one-line placeholder inside a card.
export function InlineEmpty({children}){
  return (
    <Empty className="items-start gap-0 rounded-lg border px-3 py-2 text-left md:px-3 md:py-2">
      <EmptyDescription className="text-sm">{children}</EmptyDescription>
    </Empty>
  );
}

// The page title, for screen readers only: the navigation already names the
// page, so content starts right under it. It stays the page's accessible
// name (`aria-labelledby`) and the focus target after a page switch.
export function PageHeading({id,title,titleRef}){
  return <h1 id={id} ref={titleRef} tabIndex={-1} className="sr-only">{title}</h1>;
}

// The empty/loading line shared by detail pages.
export function pageEmptyText(s,{ready,idle,noMatches='No matches found for this season. Try another act.'}){
  if(s.analysisState==='loading')return 'Loading this player’s matches…';
  if(s.analysisState==='ready')return ready??noMatches;
  return idle;
}
