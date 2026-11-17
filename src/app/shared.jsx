import {useState} from 'react';
import {ArrowDown,ArrowUp,ArrowUpDown} from 'lucide-react';
import {RANK_ICONS} from '@/engine/rank-icons.mjs';
import {avgLabel,navigateToPage,pageHref,PARTY_LABELS,tierRR,toggleIncludeReset} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {cn} from '@/lib/utils';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {Switch} from '@/components/ui/switch';
import {Label} from '@/components/ui/label';

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

export function toneClass(value,neutral=1){
  if(value==null||value===neutral)return '';
  return value>neutral?'text-positive':'text-negative';
}

export function LobbyValue({sum,count}){
  if(!count)return '—';
  const lobby=tierRR(sum/count);
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" title={`${avgLabel(lobby.tier)} · ${lobby.rr} RR`}>
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

// Keep each table's chosen sort through incremental loads and filter changes.
const tableSortState=new Map();

// A sortable shadcn table. `rows[i].cells[0]` is the row header; `values[i]`
// holds the raw sort value per column (null always sorts last). `maxima`
// marks the highest numeric value in a column.
// Phones: the same rows as a list of cards. The row header is the card title,
// the first data column its headline figure, the rest a label/value grid.
// Sorting moves to a native select (the OS picker) plus a direction button.
// Columns flagged `wide` (lobby ranks with icon and RR) span two grid cells.
export function MobileRowList({id,caption,columns,rows,values,order,best,sort,choose,className}){
  const column=sort?.column??null;
  const direction=sort?.direction||'descending';
  const DirIcon=direction==='ascending'?ArrowUp:ArrowDown;
  const [headline,...rest]=columns.slice(1).map((col,i)=>({...col,index:i+1}));
  const cellAt=(index,columnIndex)=>{
    const props=rows[index].cellProps?.[columnIndex]||{};
    // With one row every value is the "highest"; only mark real comparisons.
    const top=rows.length>1?best.get(columnIndex):null;
    return {cell:rows[index].cells[columnIndex],props,isBest:top&&values[index][columnIndex]===top.max,top};
  };
  return (
    <div className={cn('mobile-row-list',className)} data-slot="mobile-row-list" data-table-id={id}>
      <p className="sr-only">{caption}</p>
      <div className={cn('flex items-center gap-2 border-b px-4 pt-2 pb-3',rows.length<3&&'hidden')}>
        <label htmlFor={`${id}-sort`} className="text-xs text-muted-foreground">Sort</label>
        <select id={`${id}-sort`} value={column==null?'':String(column)}
          onChange={event=>{
            if(event.target.value===''){choose(null);return;}
            const next=Number(event.target.value);
            choose({column:next,direction:next===0?'ascending':'descending'});
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30">
          <option value="">Default order</option>
          {columns.map((col,i)=><option key={i} value={i}>{col.label}</option>)}
        </select>
        <button type="button" disabled={column==null} onClick={()=>choose({column,direction:direction==='ascending'?'descending':'ascending'})}
          aria-label={`Sort ${direction==='ascending'?'descending':'ascending'}`}
          className="grid size-8 shrink-0 place-items-center rounded-md border border-input text-muted-foreground transition-colors outline-none active:bg-accent disabled:opacity-40 focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30">
          <DirIcon className="size-4" aria-hidden="true"/>
        </button>
      </div>
      <ul className="divide-y">
        {order.map(index=>{
          const row=rows[index];
          const head=headline&&cellAt(index,headline.index);
          return (
            <li key={row.key} className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className={cn('min-w-0 flex-1 text-[15px] font-semibold [&_a]:max-w-full',row.cellProps?.[0]?.className)}>{row.cells[0]}</div>
                {head&&(
                  <div className="shrink-0 text-right">
                    <div className={cn('text-base leading-tight font-semibold tabular-nums',head.props.className,head.isBest&&'text-brand')}>{head.cell}</div>
                    <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{headline.label}</div>
                  </div>
                )}
              </div>
              {rest.length>0&&(
                <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5">
                  {rest.map(col=>{
                    const {cell,props,isBest,top}=cellAt(index,col.index);
                    return (
                      <div key={col.index} className={cn('min-w-0',col.wide&&'col-span-2')} title={isBest?`Highest ${top.label} in this list`:undefined}>
                        <dt className="truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{col.label}</dt>
                        <dd className={cn('mt-0.5 flex min-w-0 items-center text-sm font-medium tabular-nums [&_img]:!size-4',props.className)}>
                          <span className={cn('min-w-0 truncate [&>span]:!gap-1.5',isBest&&'-mx-1.5 rounded-md bg-brand/15 px-1.5 font-semibold')}>{cell}</span>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SortableTable({id,caption,columns,rows,values,maxima=[],className}){
  const mobile=useIsMobile();
  const [sort,setSort]=useState(()=>tableSortState.get(id)||null);
  const best=new Map();
  for(const {column,label} of maxima){
    const numeric=values.map(row=>row[column]).filter(v=>typeof v==='number'&&Number.isFinite(v));
    if(numeric.length)best.set(column,{max:Math.max(...numeric),label});
  }
  const order=rows.map((row,index)=>index);
  if(sort&&sort.column<columns.length){
    const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
    order.sort((a,b)=>{
      const av=values[a][sort.column],bv=values[b][sort.column];
      if(av==null||bv==null)return av==null?(bv==null?a-b:1):-1;
      const comparison=typeof av==='number'&&typeof bv==='number'?av-bv:collator.compare(String(av),String(bv));
      return comparison*(sort.direction==='ascending'?1:-1)||a-b;
    });
  }
  const choose=next=>{
    tableSortState.set(id,next);
    setSort(next);
  };
  const toggle=column=>{
    const direction=sort?.column===column?(sort.direction==='ascending'?'descending':'ascending'):(column===0?'ascending':'descending');
    choose({column,direction});
  };
  if(mobile)return <MobileRowList {...{id,caption,columns,rows,values,order,best,sort,choose,className}}/>;
  return (
    <Table className={cn('rank-table',className)}>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          {columns.map((col,column)=>{
            const active=sort?.column===column;
            const Icon=active?(sort.direction==='ascending'?ArrowUp:ArrowDown):ArrowUpDown;
            return (
              <TableHead key={column} scope="col" aria-sort={active?sort.direction:'none'} title={col.title}>
                <button type="button" onClick={()=>toggle(column)} className="table-sort-btn"
                  aria-label={`${col.label}: sort ${active&&sort.direction==='ascending'?'descending':active?'ascending':column===0?'ascending':'descending'}`}>
                  {column>0&&<Icon className="sort-icon" aria-hidden="true"/>}{col.label}{column===0&&<Icon className="sort-icon" aria-hidden="true"/>}
                </button>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {order.map(index=>{
          const row=rows[index];
          return (
            <TableRow key={row.key}>
              {row.cells.map((cell,column)=>{
                const props=row.cellProps?.[column]||{};
                const top=best.get(column);
                const isBest=top&&values[index][column]===top.max;
                const title=isBest?[props.title,`Highest ${top.label} in this table`].filter(Boolean).join(' · '):props.title;
                if(column===0)return <TableHead key={0} scope="row" className={props.className} title={title}>{cell}</TableHead>;
                return (
                  <TableCell key={column} title={title} className={cn(props.className,isBest&&'table-best')}>
                    {cell}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
    <div className="flex items-center gap-2" title="Include placement-week games in the lobby and teammate breakdowns.">
      <Switch id="placements-toggle" checked={s.mhIncludeReset} onCheckedChange={toggleIncludeReset}/>
      <Label htmlFor="placements-toggle" className="text-sm font-normal text-muted-foreground">Count placements ({count})</Label>
    </div>
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
        <div key={name} title={title}>
          <dt>{name}</dt>
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

export function EmptyState({children}){
  return <div role="status" className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">{children}</div>;
}

export function PageHeading({id,title,children,titleRef}){
  return (
    <div className="mb-6 space-y-2 max-sm:mb-4 max-sm:space-y-1.5">
      <h1 id={id} ref={titleRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl">{title}</h1>
      {children&&<p className="max-w-3xl text-sm text-muted-foreground max-sm:text-[13px] max-sm:leading-snug">{children}</p>}
    </div>
  );
}

// The empty/loading line shared by detail pages.
export function pageEmptyText(s,{ready,idle,noMatches='No matches found for this season. Try another act.'}){
  if(s.analysisState==='loading')return 'Loading this player’s matches…';
  if(s.analysisState==='ready')return ready??noMatches;
  return idle;
}
