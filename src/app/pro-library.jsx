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

// The VCT league marks and their colours (22 Nov 2026, on request). Logos are
// Liquipedia's copies of Riot's league icons (VCT 2023 Americas League,
// VCT 2024 EMEA League dark mode, VCT 2023 Pacific League, VCT China),
// trimmed and shrunk to 64px in assets/regions/. Colours are each logo's own
// fill, read from the files.
export const PRO_REGION_STYLE={
  Americas:{color:'#ff570c',logo:'/assets/regions/americas.png'},
  EMEA:{color:'#d3ff1e',logo:'/assets/regions/emea.png'},
  Pacific:{color:'#01d2d7',logo:'/assets/regions/pacific.png'},
  China:{color:'#fd2659',logo:'/assets/regions/china.png'},
};
const regionVar=region=>PRO_REGION_STYLE[region]?{'--region':PRO_REGION_STYLE[region].color}:undefined;

export function RegionLogo({region,className}){
  const style=PRO_REGION_STYLE[region];
  if(!style)return null;
  return <img src={style.logo} alt="" aria-hidden="true" width={64} height={64} loading="lazy" decoding="async" className={cn('size-3.5 shrink-0 object-contain',className)}/>;
}

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

// Teams come from rostermania's partnered rosters (22 Nov 2026, on request,
// via scripts/build-pro-player-library.mjs): only partnered teams get a
// heading; pros on no partnered roster are "Other players", listed last.
export const OTHER_PLAYERS='Other players';

// No search: one group per partnered team, teams A–Z with "Other players"
// last, players A–Z and each player's main account before their alts. A
// search: one flat group in match order (proSearchResults already ranks it).
export function proGroups(rows,query){
  if(query.trim())return rows.length?[{key:'results',heading:`${rows.length} ${rows.length===1?'result':'results'}`,rows,flat:true}]:[];
  const teams=new Map();
  for(const row of rows){
    const key=row.teamCode&&row.team?row.teamCode:OTHER_PLAYERS;
    if(!teams.has(key))teams.set(key,[]);
    teams.get(key).push(row);
  }
  const byName=(a,b)=>a.localeCompare(b,'en',{sensitivity:'base'});
  return [...teams.entries()]
    .map(([key,list])=>key===OTHER_PLAYERS
      ?{key,heading:OTHER_PLAYERS,teamCode:null,region:null,flat:false,rows:list}
      :{key,heading:list[0].team,teamCode:key,region:list[0].region??null,flat:false,rows:list})
    .sort((a,b)=>(a.key===OTHER_PLAYERS)-(b.key===OTHER_PLAYERS)||byName(a.heading,b.heading))
    .map(group=>({...group,rows:group.rows.slice().sort((a,b)=>byName(a.handle,b.handle)||a.accountIndex-b.accountIndex)}));
}

export function TeamLogo({code,className}){
  if(!code)return null;
  return <img src={`/assets/teams/${code.toLowerCase()}.png`} alt="" aria-hidden="true" width={48} height={48} loading="lazy" decoding="async"
    onError={event=>event.currentTarget.remove()} className={cn('size-4 shrink-0 object-contain',className)}/>;
}

export function ProGroupHeading({group}){
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2 self-center">
        <TeamLogo code={group.teamCode}/>
        <span className="truncate font-semibold text-foreground">{group.heading}</span>
      </span>
      {group.region&&(
        <span className="flex shrink-0 items-center gap-1.5 self-center font-medium text-(--region)" style={regionVar(group.region)}>
          <RegionLogo region={group.region}/>{group.region}
        </span>
      )}
    </span>
  );
}

export function ProRegionFilter({value,onChange,counts,className}){
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} aria-label="Filter pro players by region"
      onValueChange={next=>onChange(next||'all')} className={cn('w-full',className)}>
      {['all',...PRO_REGIONS].map(region=>(
        <ToggleGroupItem key={region} value={region} disabled={!counts[region]} style={regionVar(region)}
          className={cn('flex-1 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground',region==='all'
            ?'data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground/90'
            // A region's chip lights up in its league colour: tinted fill, coloured border and text.
            :'data-[state=on]:z-10 data-[state=on]:border-(--region) data-[state=on]:bg-[color-mix(in_oklab,var(--region)_18%,transparent)] data-[state=on]:text-(--region) data-[state=on]:hover:bg-[color-mix(in_oklab,var(--region)_26%,transparent)]')}
          aria-label={`${region==='all'?'All regions':region}, ${counts[region]} accounts`}>
          {region!=='all'&&<RegionLogo region={region} className="max-[380px]:hidden"/>}
          {region==='all'?'All':region}
          <span className="text-[10px] tabular-nums opacity-70 max-[420px]:hidden">{counts[region]}</span>
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
      {/* Tinted in the player's league colour; pros without a region stay grey. */}
      <Avatar className={size==='lg'?'size-9':'size-8'} aria-hidden="true" style={regionVar(row.region)}>
        <AvatarFallback className={cn('font-semibold uppercase ring-1 ring-inset',PRO_REGION_STYLE[row.region]
          ?'bg-[color-mix(in_oklab,var(--region)_16%,var(--popover))] text-(--region) ring-[color-mix(in_oklab,var(--region)_45%,transparent)]'
          :'bg-zinc-700/70 text-zinc-100 ring-white/10',size==='lg'?'text-sm':'text-xs')}>{row.handle.slice(0,1)}</AvatarFallback>
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
