// Data tables on TanStack Table v9 (moved from the hand-built SortableTable,
// 20 Nov 2026). TanStack owns sorting, search and paging; this module owns
// the markup: the shadcn table on desktop, cards on phones.
import {useMemo,useState} from 'react';
import {ArrowDown,ArrowUp,ArrowUpDown,ChevronLeft,ChevronRight} from 'lucide-react';
import {
  columnFilteringFeature,createFilteredRowModel,createPaginatedRowModel,createSortedRowModel,
  globalFilteringFeature,rowPaginationFeature,rowSortingFeature,tableFeatures,useTable,
} from '@tanstack/react-table';
import {useIsMobile} from '@/app/hooks.js';
import {Hint} from '@/app/hint.jsx';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {NativeSelect,NativeSelectOption} from '@/components/ui/native-select';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';

// Registered once: prerequisites come before the row-model slots they feed.
const features=tableFeatures({
  rowSortingFeature,sortedRowModel:createSortedRowModel(),
  columnFilteringFeature,globalFilteringFeature,filteredRowModel:createFilteredRowModel(),
  rowPaginationFeature,paginatedRowModel:createPaginatedRowModel(),
});

// Shared look for every table on the site (also used by plain, unsorted
// tables such as the Overview's recent matches).
export const TABLE_FRAME='overflow-hidden border bg-card';
export const TABLE_HEAD_ROW='bg-muted/40 hover:bg-muted/40';
export const TABLE_HEAD='h-10 px-3 text-xs font-medium text-muted-foreground';
export const TABLE_CELL='px-3 py-2.5';

const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
// Ascending comparison only; TanStack reverses it for descending sorts. Missing
// values are `undefined` and `sortUndefined: 'last'` keeps them last both ways.
const compareValues=(rowA,rowB,id)=>{
  const a=rowA.getValue(id),b=rowB.getValue(id);
  return typeof a==='number'&&typeof b==='number'?a-b:collator.compare(String(a),String(b));
};
// The search matches the row header's raw value (a player's name#tag).
const matchesSearch=(row,id,filter)=>String(row.getValue(id)??'').toLowerCase().includes(String(filter).trim().toLowerCase());

// Each table keeps its sort through incremental loads,
// filter changes and page switches.
const tableViewState=new Map();
const viewOf=id=>tableViewState.get(id)||{sorting:[]};
const saveView=(id,patch)=>tableViewState.set(id,{...viewOf(id),...patch});
// Seeds a table's remembered view (tests, or a page that wants a default sort).
export const setTableView=(id,view)=>saveView(id,view);

const toSort=sorting=>sorting[0]?{column:Number(sorting[0].id),direction:sorting[0].desc?'descending':'ascending'}:null;

// Phones: the same rows as a list of cards. The row header is the card title,
// the first visible data column its headline figure, the rest a label/value
// grid. Sorting moves to a native select (the OS picker) plus a direction
// button. Columns flagged `wide` (lobby ranks with icon and RR) span two cells.
export function MobileRowList({id,caption,columns,rows,values,order,best,sort,choose,className}){
  const column=sort?.column??null;
  const direction=sort?.direction||'descending';
  const DirIcon=direction==='ascending'?ArrowUp:ArrowDown;
  const dataColumns=columns.map((col,index)=>({...col,index})).filter(col=>col.index>0&&!col.hidden);
  const [headline,...rest]=dataColumns;
  const cellAt=(index,columnIndex)=>{
    const props=rows[index].cellProps?.[columnIndex]||{};
    // With one row every value is the "highest"; only mark real comparisons.
    const top=rows.length>1?best.get(columnIndex):null;
    return {cell:rows[index].cells[columnIndex],props,isBest:top&&values[index][columnIndex]===top.max,top};
  };
  return (
    <div id={id} className={cn('mobile-row-list',className)} data-slot="mobile-row-list" data-table-id={id}>
      <p className="sr-only">{caption}</p>
      <div className={cn('flex items-center gap-2 border-b px-4 pt-2 pb-3',rows.length<3&&'hidden')}>
        <label htmlFor={`${id}-sort`} className="text-xs text-muted-foreground">Sort</label>
        <NativeSelect id={`${id}-sort`} size="sm" value={column==null?'':String(column)}
          onChange={event=>{
            if(event.target.value===''){choose(null);return;}
            const next=Number(event.target.value);
            choose({column:next,direction:next===0?'ascending':'descending'});
          }}
          className="text-foreground" wrapperClassName="min-w-0 flex-1">
          <NativeSelectOption value="">Default order</NativeSelectOption>
          {columns.map((col,i)=>!col.hidden&&<NativeSelectOption key={i} value={i}>{col.label}</NativeSelectOption>)}
        </NativeSelect>
        <Button type="button" variant="outline" size="icon-sm" disabled={column==null} onClick={()=>choose({column,direction:direction==='ascending'?'descending':'ascending'})}
          aria-label={`Sort ${direction==='ascending'?'descending':'ascending'}`} className="text-muted-foreground">
          <DirIcon aria-hidden="true"/>
        </Button>
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

// Previous/next under a long table, as in shadcn's data-table example; the
// range on the left says where you are.
export function TablePager({page,pageSize,total,noun,onPrevious,onNext,canPrevious,canNext,controls}){
  const pages=Math.max(1,Math.ceil(total/pageSize)),start=page*pageSize;
  return (
    <nav className="flex items-center justify-between gap-3 pt-3 max-sm:px-4 max-sm:pb-1" aria-label={`${noun} pages`} data-slot="table-pager">
      <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">{total?`${start+1}–${Math.min(total,start+pageSize)} of ${total} ${noun}`:`0 ${noun}`}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground tabular-nums">Page {page+1} of {pages}</span>
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={!canPrevious} aria-label="Previous page" aria-controls={controls}><ChevronLeft aria-hidden="true"/>Previous</Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!canNext} aria-label="Next page" aria-controls={controls}>Next<ChevronRight aria-hidden="true"/></Button>
      </div>
    </nav>
  );
}

// A sortable data table in shadcn's data-table look (20 Nov 2026), refined:
// a muted header row with small muted labels whose sort arrow shows on hover
// and stays on the sorted column, 44px rows, the best value per column in
// semibold, and the empty search result as a row inside the frame. On its own
// (`standalone`) the frame is the card; inside a card it is an inset panel.
// Outline Previous/Next below. `rows[i].cells[0]` is the row header; `values[i]` holds the
// raw sort value per column (null always sorts last). `maxima` names the
// highest value in a column in that cell's tooltip. `pageSize` splits long
// tables into pages (sorting and search cover every row, then the page is
// cut); a table long enough to page also gets a search over the row header.
// Number columns are right-aligned; `align: 'left'` keeps a column left.
export function SortableTable({id,caption,columns,rows,values,maxima=[],className,pageSize,noun='rows',searchable=!!pageSize&&rows.length>pageSize,standalone=false}){
  const mobile=useIsMobile();
  const [sorting,setSorting]=useState(()=>viewOf(id).sorting);
  const [globalFilter,setGlobalFilter]=useState('');
  const [pagination,setPagination]=useState({pageIndex:0,pageSize:pageSize||Math.max(1,rows.length)});
  // Column definitions depend only on the column list, so they stay stable
  // across renders; each row carries its own raw values.
  const columnKey=columns.map(col=>col.label).join('\u0000');
  const columnDefs=useMemo(()=>columns.map((col,index)=>({
    id:String(index),
    accessorFn:row=>row.values[index]??undefined,
    sortFn:compareValues,sortUndefined:'last',sortDescFirst:index>0,
  })),[columnKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const data=useMemo(()=>rows.map((row,index)=>({index,values:values[index]||[]})),[rows,values]);
  const resetPage=()=>setPagination(state=>({...state,pageIndex:0}));
  const table=useTable({
    features,columns:columnDefs,data,
    getRowId:row=>String(rows[row.index]?.key??row.index),
    state:{sorting,globalFilter,pagination:pageSize?pagination:{pageIndex:0,pageSize:Math.max(1,rows.length)}},
    onSortingChange:updater=>{
      setSorting(previous=>{
        const next=typeof updater==='function'?updater(previous):updater;
        saveView(id,{sorting:next});
        return next;
      });
      resetPage();
    },
    onGlobalFilterChange:updater=>{setGlobalFilter(previous=>typeof updater==='function'?updater(previous):updater);resetPage();},
    onPaginationChange:setPagination,
    globalFilterFn:matchesSearch,
    getColumnCanGlobalFilter:column=>column.id==='0',
    enableMultiSort:false,enableSortingRemoval:false,autoResetPageIndex:false,
  });
  const best=new Map();
  for(const {column,label} of maxima){
    const numeric=values.map(row=>row[column]).filter(v=>typeof v==='number'&&Number.isFinite(v));
    // A column where every row ties has no best value to point out.
    if(numeric.length&&Math.min(...numeric)<Math.max(...numeric))best.set(column,{max:Math.max(...numeric),label});
  }
  const filteredCount=table.getFilteredRowModel().rows.length;
  const shown=table.getRowModel().rows.map(row=>row.original.index);
  const sort=toSort(sorting);
  const paged=pageSize&&filteredCount>pageSize;
  const {pageIndex}=table.state.pagination;
  const right=index=>index>0&&columns[index]?.align!=='left';
  const toolbar=searchable&&(
    <div className="flex items-center pb-3" data-slot="table-toolbar">
      <Input type="search" value={globalFilter} onChange={event=>table.setGlobalFilter(event.target.value)}
        placeholder={`Search ${noun}…`} aria-label={`Search ${noun}`} aria-controls={id} className="max-w-sm"/>
    </div>
  );
  const noMatch=globalFilter&&!filteredCount?`No ${noun} match “${globalFilter.trim()}”.`:null;
  const empty=noMatch&&mobile?<p className="px-4 py-6 text-center text-sm text-muted-foreground" role="status">{noMatch}</p>:null;
  const more=paged
    ?<TablePager page={pageIndex} pageSize={pageSize} total={filteredCount} noun={noun} controls={id}
      onPrevious={()=>table.previousPage()} onNext={()=>table.nextPage()} canPrevious={table.getCanPreviousPage()} canNext={table.getCanNextPage()}/>
    :null;
  const choose=next=>table.setSorting(next?[{id:String(next.column),desc:next.direction==='descending'}]:[]);
  if(mobile)return <>{toolbar}{empty||<MobileRowList {...{id,caption,columns,rows,values,order:shown,best,sort,choose,className}}/>}{more}</>;
  return (
    <div className={className} data-slot="data-table">
      {toolbar}
      {(
        <div className={cn(TABLE_FRAME,standalone?'rounded-[12px]':'rounded-lg')}>
          <Table id={id}>
            <caption className="sr-only">{caption}</caption>
            <TableHeader>
              <TableRow className={TABLE_HEAD_ROW}>
                {table.getAllLeafColumns().map(column=>{
                  const index=Number(column.id),col=columns[index];
                  const state=column.getIsSorted();
                  const Icon=state==='asc'?ArrowUp:state==='desc'?ArrowDown:ArrowUpDown;
                  return (
                    <TableHead key={column.id} scope="col" aria-sort={state==='asc'?'ascending':state==='desc'?'descending':'none'}
                      className={cn('h-10 px-3',right(index)&&'text-right')}>
                      <Hint asChild content={col.title}>
                      <Button variant="ghost" size="sm" onClick={column.getToggleSortingHandler()}
                        className={cn('group/sort h-7 gap-1 px-1.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground',
                          right(index)?'-mr-1.5':'-ml-1.5',state&&'text-foreground')}
                        aria-label={`${col.label}: sort ${column.getNextSortingOrder()==='asc'?'ascending':'descending'}`}>
                        {right(index)&&<Icon className={cn('size-3.5 transition-opacity',!state&&'opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60')} aria-hidden="true"/>}
                        {col.label}
                        {!right(index)&&<Icon className={cn('size-3.5 transition-opacity',!state&&'opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60')} aria-hidden="true"/>}
                      </Button>
                      </Hint>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {noMatch&&<TableRow className="hover:bg-transparent"><TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground" role="status">{noMatch}</TableCell></TableRow>}
              {shown.map(index=>{
                const row=rows[index];
                return (
                  <TableRow key={row.key}>
                    {row.cells.map((cell,column)=>{
                      const props=row.cellProps?.[column]||{};
                      const top=best.get(column);
                      const isBest=top&&values[index][column]===top.max;
                      const title=isBest?[props.title,`Highest ${top.label} in this table`].filter(Boolean).join('. '):props.title;
                      if(column===0)return <TableHead key={0} scope="row" className={cn('h-11 px-3 font-medium',props.className)} title={title}>{cell}</TableHead>;
                      return <TableCell key={column} title={title} className={cn(TABLE_CELL,right(column)&&'text-right tabular-nums',props.className,isBest&&'font-semibold')}>{cell}</TableCell>;
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {more}
    </div>
  );
}
