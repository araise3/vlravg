import {Avatar,AvatarFallback} from '@/components/ui/avatar';
import {Badge} from '@/components/ui/badge';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';
import {Sep} from '@/app/shared.jsx';
import {cn} from '@/lib/utils';

// Pro player library, redesigned with shadcn parts (22 Nov 2026, on request).
// Until then each row was the handle over its full PUUID, in one long
// alphabetical list. pro-players.json already carried each pro's team, VCT
// region and country, so the list now browses the way pros are known: a
// region filter (ToggleGroup), players under their team's heading, each row
// an Avatar with the handle, Main/Alt badge and country. A search lists
// matches flat with their team. The PUUID shows only when the search matched
// it; it stays in the row's accessible name.

export const PRO_REGIONS=['Americas','EMEA','Pacific','China'];
const NO_TEAM='No team listed';

let regionNames=null;
function countryName(code){
  if(!code)return null;
  try{
    regionNames??=new Intl.DisplayNames(['en'],{type:'region'});
    return regionNames.of(code)||code;
  }catch{return code;}
}

export function proRegionCounts(rows){
  const counts={all:rows.length};
  for(const region of PRO_REGIONS)counts[region]=rows.filter(row=>row.region===region).length;
  return counts;
}

export function filterProRegion(rows,region){
  return region&&region!=='all'?rows.filter(row=>row.region===region):rows;
}

// No search: one group per team, teams A–Z with "No team listed" last,
// players A–Z and each player's main account before their alts. A search:
// one flat group in match order (proSearchResults already ranks it).
export function proGroups(rows,query){
  if(query.trim())return rows.length?[{key:'results',heading:`${rows.length} ${rows.length===1?'result':'results'}`,rows,flat:true}]:[];
  const teams=new Map();
  for(const row of rows){
    const team=row.team||NO_TEAM;
    if(!teams.has(team))teams.set(team,[]);
    teams.get(team).push(row);
  }
  const byName=(a,b)=>a.localeCompare(b,'en',{sensitivity:'base'});
  return [...teams.entries()]
    .sort(([a],[b])=>(a===NO_TEAM)-(b===NO_TEAM)||byName(a,b))
    .map(([team,list])=>({key:team,heading:team,region:list.find(row=>row.region)?.region??null,flat:false,
      rows:list.slice().sort((a,b)=>byName(a.handle,b.handle)||a.accountIndex-b.accountIndex)}));
}

export function ProGroupHeading({group}){
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="truncate">{group.heading}</span>
      {group.region&&<span className="shrink-0 font-normal text-muted-foreground/70">{group.region}</span>}
    </span>
  );
}

export function ProRegionFilter({value,onChange,counts,className}){
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} aria-label="Filter pro players by region"
      onValueChange={next=>onChange(next||'all')} className={cn('w-full',className)}>
      {['all',...PRO_REGIONS].map(region=>(
        <ToggleGroupItem key={region} value={region} disabled={!counts[region]} className="flex-1 gap-1 px-2 text-xs"
          aria-label={`${region==='all'?'All regions':region}, ${counts[region]} accounts`}>
          {region==='all'?'All':region}
          <span className="text-[10px] text-muted-foreground tabular-nums max-[420px]:hidden">{counts[region]}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// The row's content: avatar initial, handle with a Main/Alt badge, and under
// it the country (by team) or team and country (search results), or the
// PUUID when the search matched it.
export function ProAccount({row,flat,query,size='default'}){
  const q=query.trim().toLowerCase();
  const puuidHit=q.length>=4&&row.puuid.includes(q)&&!row.handle.toLowerCase().includes(q);
  const parts=puuidHit?[row.puuid]:[flat?row.team:null,countryName(row.countryCode)].filter(Boolean);
  return (
    <>
      <Avatar className={size==='lg'?'size-9':'size-8'} aria-hidden="true">
        <AvatarFallback className={cn('font-semibold text-muted-foreground uppercase',size==='lg'?'text-sm':'text-xs')}>{row.handle.slice(0,1)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('truncate font-medium text-foreground',size==='lg'&&'text-base')}>{row.handle}</span>
          {row.accountCount>1&&<Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">{row.accountIndex===0?'Main':`Alt ${row.accountIndex}`}</Badge>}
        </span>
        {parts.length>0&&(
          <span className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground',puuidHit&&'font-mono text-[11px]')} data-slot="pro-detail">
            {parts.map((part,i)=><span key={i} className={cn('flex min-w-0 items-center gap-1.5',i===parts.length-1&&'shrink-0')}>{i>0&&<Sep/>}<span className="truncate">{part}</span></span>)}
          </span>
        )}
      </span>
    </>
  );
}

export function proAccountLabel(row){
  return [row.handle,row.accountCount>1?(row.accountIndex===0?'main account':`alt account ${row.accountIndex}`):null,row.team,countryName(row.countryCode),row.puuid].filter(Boolean).join(', ');
}
