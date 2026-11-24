import {Fragment,useEffect,useState} from 'react';
import {ChevronDown,Shield} from 'lucide-react';
import {
  avgLabel,avgLabelShort,dayHeaderLabel,loadMatchMapMetadata,loadMoreMatches,matchAward,placeText,
  lobbyRankText,matchCardPlayerRank,playerRouteUrl,rClass,rrSigned,tierRR,
} from '@/engine/core.mjs';
import {useEngine,useIsMobile} from '@/app/hooks.js';
import {EmptyState,Hint,PageHeading,PlacementToggle,RankIcon} from '@/app/shared.jsx';
import {RRSessionCard} from '@/app/pages/RR.jsx';
import {AgentIcon,agentTint,useAgentArt} from '@/app/agent-icon.jsx';
import {cn} from '@/lib/utils';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from '@/components/ui/collapsible';

// Rank text colours per tier band (the legacy r-* classes).
const RANK_TEXT={'r-unr':'text-zinc-500','r-iron':'text-zinc-400','r-bronze':'text-amber-700','r-silver':'text-zinc-300','r-gold':'text-amber-400',
  'r-plat':'text-cyan-400','r-diamond':'text-fuchsia-300','r-asc':'text-emerald-400','r-imm':'text-rose-500','r-rad':'text-amber-100'};

// Map artwork is optional: match data renders immediately, even offline.
export function useMapArt(){
  const [maps,setMaps]=useState(null);
  useEffect(()=>{let live=true;loadMatchMapMetadata().then(result=>{if(live)setMaps(result);});return()=>{live=false;};},[]);
  return maps;
}

// The performance bonus and refunded RR after the RR change, "+16+4" (23 Nov
// 2026, on request: only these two; the other RR notes were text lines under
// the opened card's stats, then icons at the RR change, and both were too
// much). A reported bonus is already part of the RR change, so it is shown
// beside it and never added to it; a refund is applied on top. Zeros are left out.
export function rrExtras(m){
  const bonus=m.myRRDetails?.bonus,refund=m.myRefundedRR;
  const extras=[];
  if(bonus)extras.push({key:'bonus',value:bonus,text:rrSigned(bonus,0)+' RR performance bonus',hint:'Performance bonus: reported for this update and already part of its RR change'});
  if(refund)extras.push({key:'refund',value:refund,text:rrSigned(refund,0)+' RR refunded',hint:'Refunded RR: applied on top of this match’s RR change'});
  return extras;
}

// Long Riot IDs (22 Nov 2026, on request): the name column takes all the room
// the stat columns leave. Ranks are the short name in the rank colour ("Dia 1",
// full name in the tooltip) on every width; icons were tried the same day and
// reverted on request. The stat columns are only as wide as their numbers.
// When a name still does not fit, its tag gives way before the name does (it
// shrinks first), and the full Riot ID is in the link's tooltip. `compact`
// (phones): tighter columns and no tag.
// Parties (22 Nov 2026, on request): every party of two or more, on either
// team, colours its members' names alike; yours takes the first colour (sky, as
// before), then the rest in roster order. The colours stay clear of the rank
// colours in the column on the right. The link's tooltip names the partners.
const PARTY_TEXT=['text-sky-300','text-lime-300','text-orange-300','text-indigo-300'];
function rosterParties(players,myPartyId){
  const members=new Map();
  for(const p of players){
    if(p.party_id==null||p.party_id==='')continue;
    if(!members.has(p.party_id))members.set(p.party_id,[]);
    members.get(p.party_id).push(p);
  }
  const ids=[...members.keys()].filter(id=>members.get(id).length>1);
  ids.sort((a,b)=>(b===myPartyId)-(a===myPartyId));
  return new Map(ids.map((id,i)=>[id,{index:i+1,className:PARTY_TEXT[i%PARTY_TEXT.length],members:members.get(id)}]));
}
function PlayersGrid({m,me,compact,agents}){
  const cols=compact?'grid-cols-[minmax(0,1fr)_2.25rem_2.25rem_2.5rem_3.25rem] gap-1.5':'grid-cols-[minmax(0,1fr)_2.5rem_2.5rem_2.75rem_3.5rem] gap-2';
  const myTeamId=me?.team_id;
  // Sort by ACS desc (nulls last), fall back to tier
  const byAcs=(a,b)=>{
    if(a._acs!=null&&b._acs!=null)return b._acs-a._acs;
    if(a._acs!=null)return -1;
    if(b._acs!=null)return 1;
    return (b._tier??0)-(a._tier??0);
  };
  // Each team's header carries its average rank (rated players only) over the
  // Rank column. Rounds are not repeated here: the closed row has the score.
  const teams=[
    ['Your team',m.players.filter(p=>p.team_id===myTeamId).sort(byAcs),m.avgTeamRank],
    ['Enemy team',m.players.filter(p=>p.team_id!==myTeamId).sort(byAcs),m.avgEnemyRank],
  ];
  const parties=rosterParties(teams.flatMap(([,players])=>players),me?.party_id??m.myPartyId);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {teams.map(([label,players,avg])=>(
        <div key={label} className="text-sm">
          {/* mb-1: your highlighted row, when it tops the list, sat flush on
              this 1px rule and swallowed it (24 Nov 2026). */}
          <div className={cn('mb-1 grid items-end border-b',cols,'px-2 pb-2 text-xs text-muted-foreground uppercase')} data-slot="team-header">
            <span className="truncate">{label}</span>
            <span className="text-right">ACS</span><span className="text-right"><Hint content="Performance Score">PS</Hint></span><span className="text-right">KD</span>
            {Number.isFinite(avg)
              ?<Hint asChild content={label+' average rank (rated players): '+lobbyRankText(avg)}><span className={cn('truncate text-right normal-case font-semibold',RANK_TEXT[rClass(tierRR(avg).tier)])} data-slot="team-rank">{avgLabelShort(tierRR(avg).tier)}</span></Hint>
              :<span className="text-right">Rank</span>}
          </div>
          {players.map((p,i)=>{
            const isMe=p===me,party=parties.get(p.party_id);
            const partners=party?.members.filter(o=>o!==p).map(o=>o.name||'Unknown player');
            const title=(p.name&&p.tag?`${p.name}#${p.tag}`:p.name||'')+(partners?`, in a party with ${partners.join(', ')}`:'');
            // The tag shrinks first (shrink-[20]); only then is the name cut.
            const content=<><span className={cn('min-w-0 truncate',isMe&&'font-semibold text-foreground',party?.className)} data-party={party?.index}>{p.name||'Unknown player'}</span>{p.tag&&!compact&&<span className="min-w-0 shrink-[20] truncate text-xs text-muted-foreground" data-slot="player-tag">#{p.tag}</span>}</>;
            // A block-level flex wrapper: an inline one sat the icon on a text
            // baseline in a 27px line box, 2.5px above the name's centre.
            const agent=p.agent&&<Hint asChild content={p.agent}><span className="flex shrink-0"><AgentIcon agents={agents} name={p.agent} id={p.agentId} size={compact?20:22}/></span></Hint>;
            return (
              <div key={p.puuid||i} className={cn('grid items-center rounded-md',cols,'px-2 py-1.5 tabular',isMe&&'bg-rank/10')}>
                <span className="flex min-w-0 items-center gap-2">
                  {agent}
                  {p.name&&p.tag
                    ?<a href={playerRouteUrl(p.name,p.tag)} title={title} className="flex min-w-0 items-baseline gap-0.5 hover:underline">{content}</a>
                    :<span className="flex min-w-0 items-baseline gap-0.5" title={title||undefined}>{content}</span>}
                </span>
                <span className={cn('text-right',p._acs==null&&'text-muted-foreground')}>{p._acs!=null?Math.round(p._acs):'—'}</span>
                <span className={cn('text-right',p._performanceScore==null&&'text-muted-foreground')}>{Number.isFinite(p._performanceScore)?Math.round(p._performanceScore):'—'}</span>
                <span className={cn('text-right',p._kd==null&&'text-muted-foreground')}>{p._kd!=null?p._kd.toFixed(2):'—'}</span>
                <span className={cn('truncate text-right text-xs font-medium',RANK_TEXT[rClass(p._tier)])} title={p._label} data-slot="player-rank">{Number.isInteger(p._tier)&&p._tier>=3?avgLabelShort(p._tier):p._label}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Inside the card's toggle button, so hints open on hover only (asChild on a
// plain span adds no focus stop); the button's aria-label carries the figures.
function Stat({label,children,title,className,valueClassName}){
  return (
    <Hint asChild content={title}>
      <span className={cn('mc-performance-stat',className)}>
        <span className="mc-performance-lbl">{label}</span>
        <span className={cn('mc-performance-val',valueClassName)}>{children}</span>
      </span>
    </Hint>
  );
}

// Shared by both cards (slimmed 22 Nov 2026, on request: the redesigned card
// was too tall). The closed card keeps what a list is scanned for: agent,
// map, result and score, K/D/A, ACS, RR change and the MVP mark. Start
// time, length, server, Performance Score and the average lobby move to
// this strip at the top of the opened card; the starting rank is already in
// the RR details under it. The average lobby came back to the closed card
// (22 Nov 2026, on request) as a short rank.
export function matchView(m,s){
  const {mapName,startedAt,startedAtMs,won,myR,opR,avgRank,myStats,myRR,myDerankProtected}=m;
  const award=matchAward(m,s.PUUID);
  const rank=avgRank!=null?tierRR(avgRank):null;
  // Your rank going into the match (requested back on the closed card).
  const myRank=matchCardPlayerRank(m);
  const myAcs=myStats?.acs!=null?Math.round(myStats.acs):'—';
  const performanceScore=Number.isFinite(myStats?.performanceScore)?Math.round(myStats.performanceScore):'—';
  const rt=won===true?'Win':won===false?'Loss':'Draw';
  const awardLabel=award==='match'?'Match MVP':award==='team'?'Team MVP':'';
  // Your place in the match by the score that decides the MVP (Performance
  // Score since Patch 13.06, ACS for older matches; see pickMvps), shown where
  // the agent name was: "MVP" for first, else "3rd" (22 Nov 2026, on request).
  const me=m.players.find(p=>s.PUUID?p.puuid===s.PUUID:p.name?.toLowerCase()===s.PLAYER.toLowerCase()&&p.tag?.toLowerCase()===s.TAG.toLowerCase());
  const place=m.mvpBasis?m.scorePlaces?.get(me?.puuid)??null:null;
  const basis=m.mvpBasis==='acs'?'ACS':'Performance Score';
  const placeHint=place==null?null:place===1
    ?`Match MVP: highest ${basis} in the match`
    :`${placeText(place)} by ${basis} in the match`+(award==='team'?`; Team MVP: highest ${basis} on your team`:'');
  const kda=myStats?[myStats.kills,myStats.deaths,myStats.assists].join(' / '):'—';
  const score=myR!=null&&opR!=null?myR+'–'+opR:'—';
  const time=startedAtMs!=null?new Date(startedAtMs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):startedAt||null;
  // "22 Nov, 21:12" on the closed card (23 Nov 2026, on request; it was the
  // Length tile's note in the opened card). Narrow cards show the time alone.
  const date=startedAtMs!=null?new Date(startedAtMs).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):null;
  return {
    rt,result:won===true?'win':won===false?'loss':'draw',award,awardLabel,place,placeHint,rank,myRank,performanceScore,acs:myAcs,
    shielded:!!myDerankProtected&&myRR<0,
    time,date,started:date&&time?`${date}, ${time}`:time,
    duration:matchLengthText(m.durationMs),
    me,
    label:rt+' on '+mapName+', '+score+'. '+(m.myAgent?'Played '+m.myAgent+'. ':'')+(awardLabel?awardLabel+'. ':'')+kda+' KDA, '+myAcs+' ACS, '+performanceScore+' Performance Score.'+(rank?' Average lobby '+lobbyRankText(avgRank)+'.':'')
      +rrExtras(m).map(n=>' '+n.text+'.').join(''),
  };
}

// "27 min 43 s" from the match length in ms (v4's game_length_in_ms);
// whole minutes drop the seconds. Null when the length is unknown.
export function matchLengthText(ms){
  if(!(ms>0))return null;
  // Always minutes and seconds, "35:07" (22 Nov 2026, on request).
  const total=Math.round(ms/1000),minutes=Math.floor(total/60),seconds=total%60;
  return `${minutes}:${String(seconds).padStart(2,'0')}`;
}

// Your rank at the start of the match as a badge on the agent tile (icon
// only, on request); the rank name and RR are in its hint.
function TileRank({rank}){
  if(!rank)return null;
  return (
    <Hint asChild content={'Your rank at the start of this match: '+(rank.tier<3?'Unranked':avgLabelShort(rank.tier)+', '+rank.rr+' RR')}>
      <span className="mc-tile-rank"><RankIcon tier={rank.tier} size={20}/></span>
    </Hint>
  );
}

// The average lobby on the closed card: the full rank name in its colour, no
// icon (removed on request, 22 Nov 2026).
// The RR part (shown only below Immortal 1) and the unrated reason are in
// the hint, so the cell stays narrow.
function LobbyRank({m,rank,className}){
  if(!rank){
    return m.lowRated
      ?<Hint asChild content={'Only '+m.ratedCount+' players were rated, so this lobby has no average'}><span className={cn('text-muted-foreground',className)}>—</span></Hint>
      :<span className={cn('text-muted-foreground',className)}>—</span>;
  }
  return (
    <Hint asChild content={'Average lobby: '+lobbyRankText(m.avgRank)}>
      <span className={cn(RANK_TEXT[rClass(rank.tier)],className)} data-slot="lobby-rank">{avgLabel(rank.tier)}</span>
    </Hint>
  );
}

// Your place in the match by the deciding score: "MVP" in gold for first,
// otherwise "2nd" … "10th" in muted text; the hint says what it ranks by and
// names a Team MVP. The scores themselves stay plain (22 Nov 2026, on
// request: no gold or silver number, no place in brackets after PS).
function PlaceTag({v,className}){
  if(v.place==null)return null;
  return (
    <Hint asChild content={v.placeHint}>
      <span className={cn('mc-place',v.place===1&&'mvp-match',className)} data-slot="match-place">{placeText(v.place)}</span>
    </Hint>
  );
}

function KdaValue({stats}){
  if(!stats)return '—';
  return <>{stats.kills}<span className="mc-kda-separator">/</span><span className="mc-deaths">{stats.deaths}</span><span className="mc-kda-separator">/</span>{stats.assists}</>;
}

// The RR change, then the performance bonus and refund as smaller figures
// right after it ("+16+4", `rrExtras`), each with its own hint.
function RRChange({m,v,className}){
  const {myRR}=m;
  const extras=rrExtras(m);
  const change=(
    <Hint asChild content={myRR==null?'No RR data for this match':v.shielded?'Rank Shield protected your displayed rank; this recorded RR loss still applied':'Recorded RR change for this match'}>
      <span className={cn('match-rr-change',myRR!=null&&(myRR>=0?'gain':'loss'),v.shielded&&'shielded',!extras.length&&className)}>
        {v.shielded&&<Shield aria-hidden="true"/>}{myRR!=null?(myRR>=0?'+':'')+myRR:'—'}
      </span>
    </Hint>
  );
  if(!extras.length)return change;
  return (
    <span className={cn('mc-rr-value',className)} data-slot="rr-value">
      {change}
      {extras.map(n=>(
        <Hint key={n.key} asChild content={n.hint}>
          <span className={cn('mc-rr-extra',n.value>0?'gain':'loss')} data-extra={n.key}>{rrSigned(n.value,0).replace('−','-')}</span>
        </Hint>
      ))}
    </span>
  );
}

// Your clutches this match as a tile value and hint: won of situations.
export function clutchSummaryText(clutches){
  if(!Array.isArray(clutches))return null;
  const won=clutches.filter(c=>c.outcome==='win').length;
  const detail=clutches.map(c=>`1v${c.type} ${c.outcome==='win'?'won':c.outcome==='save'?'saved':'lost'}`).join(', ');
  return {won,total:clutches.length,detail};
}

// The opened card's head (redesigned 22 Nov 2026, on request: the first
// version looked empty). One strip of hairline tiles: K/D, ACS, damage
// delta per round, headshot %, KAST, clutch win rate and the game length.
// ADR left the whole match card on 24 Nov 2026 (on request); the day recap
// keeps it.
// K/D and ACS were asked for here although the closed row has K/D/A and ACS.
// The Rank tile (rank before and after) was removed the same day on request.
// The notes under the values went on 23 Nov 2026 (on request); their counts
// moved into the label hints, and the start time moved to the closed row.
// The server joins only where the closed row hides it (`.mc-info-server`).
// Phones (23 Nov 2026) add the start time, which their closed row no longer
// shows (`.mc-info-started`); the time alone, as the day header above gives
// the date.
export function matchInfoTiles(m,v){
  const st=m.myStats||{};
  const clutch=clutchSummaryText(m.myClutches);
  const count=n=>Math.round(n).toLocaleString('en-GB');
  const hint=(text,detail)=>detail?`${text} (${detail})`:text;
  return [
    {label:'K/D',value:Number.isFinite(st.kd)?st.kd.toFixed(2):null,hint:hint('Kills divided by deaths',st.kills!=null&&st.deaths!=null&&`${st.kills} kills, ${st.deaths} deaths`)},
    {label:'ACS',value:Number.isFinite(st.acs)?Math.round(st.acs):null,hint:'Average combat score per round'},
    {label:'DDΔ',value:Number.isFinite(st.ddDelta)?rrSigned(st.ddDelta,0):null,tone:Number.isFinite(st.ddDelta)&&st.ddDelta!==0?(st.ddDelta>0?'text-positive':'text-negative'):null,
      hint:hint('Damage delta: damage dealt minus damage taken, per round',Number.isFinite(st.dmgTaken)&&`${count(st.dmgTaken)} taken`)},
    {label:'HS%',value:st.hsPct!=null?st.hsPct+'%':null,hint:'Headshots as a share of your hits'},
    {label:'KAST',value:st.kast!=null?st.kast+'%':null,hint:hint('Rounds with a kill, assist, survival or trade',st.kastRounds!=null&&`${st.kastRounds} of ${st.kastTotalRounds} rounds`)},
    {label:'Clutches',value:clutch?.total?Math.round(clutch.won/clutch.total*100)+'%':null,
      hint:!clutch?'No round data for this match':clutch.total?`${clutch.won} of ${clutch.total} won: ${clutch.detail}`:'No clutch situations'},
    {label:'Length',value:v.duration},
    {label:'Server',value:m.serverName,className:'mc-info-server'},
    {label:'Start',value:v.time,className:'mc-info-started'},
  ];
}

function MatchInfo({m,v}){
  const tiles=matchInfoTiles(m,v);
  return (
    <section className="space-y-3" aria-label="Match info" data-slot="match-info">
      <dl className="mc-stats" data-slot="match-stats">
        {tiles.map(t=>(
          <div key={t.label} className={cn('mc-stat-tile',t.className)}>
            <dt className="mc-stat-label">{t.hint?<Hint content={t.hint}>{t.label}</Hint>:t.label}</dt>
            <dd className={cn('mc-stat-value',t.value==null?'text-muted-foreground':t.tone)}>{t.value??'—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// Phones: two lines next to the agent tile. Result, score, the average lobby
// and RR change; then map, your place and K/D/A. Decluttered 23 Nov 2026
// (on request, our pick): the start time left the first line (the day header
// gives the date; the opened card has the time) and the PS/ACS figure left the
// second (your place already ranks you by it; both stay in the opened card's
// tiles and roster), which made room for ADR; ADR left again on 24 Nov 2026
// (on request). Everything else is in the opened card.
export function MobileMatchCard({m,s,maps,agents,open,onOpenChange}){
  const v=matchView(m,s);
  const art=maps?.get(String(m.mapId||'').toLowerCase())||maps?.get(String(m.mapName).toLowerCase());
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <div className={cn('match-card mobile',v.result,m.postReset&&!s.mhIncludeReset&&'opacity-55')} data-match-id={m.matchId}>
        <CollapsibleTrigger className="relative isolate flex w-full items-center gap-3 px-3 py-2.5 pl-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset [-webkit-tap-highlight-color:transparent]"
          aria-label={v.label+(open?' Hide match details and roster':' Show match details and roster')}>
          <MapBackdrop art={art}/>
          <span className="relative flex shrink-0">
            <AgentIcon agents={agents} name={m.myAgent} id={m.myAgentId} size={40} className="rounded-lg"/>
            <TileRank rank={v.myRank}/>
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2">
              <span className="m-result-tag">{v.rt}</span>
              <span className="text-base leading-none font-bold tracking-tight tabular-nums">
                {m.myR!=null&&m.opR!=null?<>{m.myR}<span className="mx-0.5 text-sm font-normal text-zinc-500">:</span><span className="text-zinc-400">{m.opR}</span></>:'—'}
              </span>
              {m.postReset&&<Hint asChild content="Placement-week game after a total rank reset"><Badge variant="outline" className="px-1 py-0 text-[9px] uppercase">Plac.</Badge></Hint>}
              <LobbyRank m={m} rank={v.rank} className="ml-auto shrink-0 text-xs font-semibold"/>
              <RRChange m={m} v={v} className="shrink-0 text-[15px]"/>
            </span>
            <span className="flex min-w-0 items-center gap-x-2 text-xs tabular-nums text-muted-foreground">
              <span className="min-w-0 truncate font-semibold text-foreground">{m.mapName}</span>
              <PlaceTag v={v} className="shrink-0"/>
              <span className="ml-auto shrink-0 font-semibold text-foreground"><KdaValue stats={m.myStats}/></span>
            </span>
          </span>
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-200',open&&'rotate-180')} aria-hidden="true"/>
        </CollapsibleTrigger>
        <CollapsibleContent className="match-card-details space-y-4">
          <MatchInfo m={m} v={v}/>
          <PlayersGrid m={m} me={v.me} agents={agents} compact/>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function MatchCard({m,s,maps,agents,open,onOpenChange}){
  const mobile=useIsMobile();
  if(mobile)return <MobileMatchCard m={m} s={s} maps={maps} agents={agents} open={open} onOpenChange={onOpenChange}/>;
  return <DesktopMatchCard m={m} s={s} maps={maps} agents={agents} open={open} onOpenChange={onOpenChange}/>;
}

// The map's splash as a faded backdrop on the card's right side, so the map
// reads at a glance without its own panel. Decorative.
function MapBackdrop({art}){
  return (
    <span className="mc-backdrop" aria-hidden="true">
      {art&&<img src={art} alt="" loading="lazy" decoding="async" onError={event=>event.currentTarget.remove()}/>}
    </span>
  );
}

// Redesigned 22 Nov 2026 (on request, with agent icons) and slimmed the same
// day to one short row, grouped by what belongs together: agent and map,
// result, your performance (K/D/A, ACS, PS; ADR was added 23 Nov 2026 and
// removed 24 Nov 2026, both on request), server, RR change. The map splash is a faded backdrop on
// the right and the result colours the left edge.
function DesktopMatchCard({m,s,maps,agents,open,onOpenChange}){
  const v=matchView(m,s);
  const art=maps?.get(String(m.mapId||'').toLowerCase())||maps?.get(String(m.mapName).toLowerCase());
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <div className={cn('match-card',v.result,m.postReset&&!s.mhIncludeReset&&'opacity-55')} data-match-id={m.matchId}>
        <CollapsibleTrigger className="mc-row" aria-label={v.label+(open?' Hide match details and roster':' Show match details and roster')}>
          <MapBackdrop art={art}/>
          <span className="mc-lead">
          <span className="relative flex shrink-0">
            <AgentIcon agents={agents} name={m.myAgent} id={m.myAgentId} size={44} className="rounded-lg"/>
            <TileRank rank={v.myRank}/>
          </span>
          {/* The start in small muted text over the map, with your place right
              after the map name (23 Nov 2026, on request). */}
          <span className="mc-cell mc-identity">
            {v.started&&<span className="mc-started" title={v.started} data-slot="match-started">{v.date&&<span className="mc-started-date">{v.date}, </span>}{v.time}</span>}
            <span className="mc-title">
              <span className="match-map">{m.mapName}</span>
              <PlaceTag v={v}/>
              {m.postReset&&<Hint asChild content="Placement-week game after a total rank reset"><Badge variant="outline" className="px-1 py-0 text-[9px] uppercase">Placements</Badge></Hint>}
            </span>
          </span>
          </span>
          <span className="mc-cell mc-outcome">
            <span className="mc-outcome-tag"><span className="m-result-tag">{v.rt}</span></span>
            <span className="match-score">{m.myR!=null&&m.opR!=null?<>{m.myR}<span className="mc-score-divider">:</span><span className="mc-score-opponent">{m.opR}</span></>:'—'}</span>
          </span>
          <span className="mc-perf">
            <Stat label="K / D / A" className="mc-cell mc-kda"><KdaValue stats={m.myStats}/></Stat>
            <Stat label="ACS" className="mc-cell mc-acs">{v.acs}</Stat>
            <Stat label="PS" className="mc-cell mc-ps" title={m.myStats?.performanceScore==null?'Performance Score is not provided in this match’s API data':'Performance Score'}>{v.performanceScore}</Stat>
          </span>
          <span className="mc-cell mc-server">
            <span className="mc-performance-lbl">Server</span>
            <span className="mc-performance-val mc-server-val" title={m.serverName||undefined}>{m.serverName||'—'}</span>
          </span>
          <span className="mc-cell mc-lobby">
            <span className="mc-performance-lbl">Lobby</span>
            <span className="mc-performance-val mc-lobby-val"><LobbyRank m={m} rank={v.rank}/></span>
          </span>
          <span className="mc-cell mc-rr">
            <span className="mc-performance-lbl">RR</span>
            <RRChange m={m} v={v}/>
          </span>
          <ChevronDown className="mc-chevron" aria-hidden="true"/>
        </CollapsibleTrigger>
        <CollapsibleContent className="match-card-details space-y-4">
          <MatchInfo m={m} v={v}/>
          <PlayersGrid m={m} me={v.me} agents={agents}/>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// The day recap above each day's matches (redesigned 23 Nov 2026, on
// request, then made minimal the same day: a boxed tile strip looked too
// heavy). One quiet line under the day: the record and net RR, then the
// average lobby, K/D, ACS, ADR, KAST and PS as plain value-and-unit pairs
// like the phone card's "160 ADR", with no boxes or dividers. The
// performance figures are weighted like the act's (dayPerformance); each
// hint says when a figure covers only some of the day's matches. Narrow
// lists (phones) put the record and RR beside the day and the rest on a
// second line, with the lobby as its short name.
export function dayRecapItems(stat){
  const matches=stat?.matches??0;
  const perf=stat?.perf||{};
  const covered=(count,text)=>count>0&&count<matches?`${text}; ${count} of ${matches} matches have data`:text;
  const decided=(stat?.wins??0)+(stat?.losses??0);
  const lobby=stat?.count>0?stat.sum/stat.count:null;
  const lobbyTier=lobby==null?null:tierRR(lobby).tier;
  const net=stat?.rrCount>0?stat.rrTotal:null;
  const whole=v=>v==null?null:Math.round(v);
  return {
    result:[
      {key:'record',value:matches?true:null,
        hint:decided?`${Math.round(stat.wins/decided*100)}% win rate: wins divided by wins plus losses; draws excluded`:'No decided matches this day'},
      {key:'rr',unit:'RR',value:net==null?null:rrSigned(net,0),tone:net==null||net===0?null:net>0?'text-positive':'text-negative',
        hint:net==null?'No RR data is available for this day':covered(stat.rrCount,'Net RR: every recorded RR change this day, Rank Shield losses included')},
    ],
    performance:[
      {key:'lobby',unit:'lobby',value:lobby==null?null:avgLabel(lobbyTier),short:lobby==null?null:avgLabelShort(lobbyTier),tone:lobby==null?null:RANK_TEXT[rClass(lobbyTier)],
        hint:lobby==null?'No lobby this day had enough rated players for an average':covered(stat.count,'Average lobby: '+lobbyRankText(lobby))},
      {key:'kd',unit:'K/D',value:perf.kd==null?null:perf.kd.toFixed(2),hint:covered(perf.kdCount,'Kills divided by deaths, summed over the day')},
      {key:'acs',unit:'ACS',value:whole(perf.acs),hint:covered(perf.acsCount,'Combat score per round, over every round played this day')},
      {key:'adr',unit:'ADR',value:whole(perf.adr),hint:covered(perf.adrCount,'Damage to enemies per round, over every round played this day')},
      {key:'kast',unit:'KAST',value:perf.kast==null?null:Math.round(perf.kast)+'%',hint:covered(perf.kastCount,'Rounds with a kill, assist, survival or trade')},
      {key:'ps',unit:'PS',value:whole(perf.ps),hint:covered(perf.psCount,'Average Performance Score')},
    ],
  };
}

function DayRecapItem({item,stat}){
  let value;
  if(item.value==null)value=<span className="text-muted-foreground">—</span>;
  else if(item.key==='record'){
    const parts=[['W',stat.wins,'text-positive'],['L',stat.losses,'text-negative'],['D',stat.draws,'text-draw']].filter(([,n],i)=>n||i<2);
    value=<span className="flex gap-1">{parts.map(([unit,n,tone])=><span key={unit} className={n?tone:'text-muted-foreground'}>{n}{unit}</span>)}</span>;
  }else if(item.short)value=<span className={item.tone}><span className="@max-xl:hidden">{item.value}</span><span className="@xl:hidden">{item.short}</span></span>;
  else value=<span className={item.tone}>{item.value}</span>;
  return (
    <Hint asChild content={item.hint}>
      <span className="flex items-baseline gap-1 whitespace-nowrap" data-stat={item.key}>
        <span className="font-semibold text-foreground">{value}</span>
        {item.unit&&<span className={cn('text-muted-foreground',item.key==='lobby'&&'@max-xl:hidden')}>{item.unit}</span>}
      </span>
    </Hint>
  );
}

function DayHeader({ms,stat,first}){
  const matchCount=stat?.matches??0;
  const {result,performance}=dayRecapItems(stat);
  return (
    <section className={cn('@container border-b pb-2.5',first?'':'mt-5')} aria-label={`${dayHeaderLabel(ms)} recap`} data-slot="day-recap">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-xs tabular-nums">
        <div className="mr-auto flex items-baseline gap-2">
          <h3 className="text-sm font-semibold whitespace-nowrap">{dayHeaderLabel(ms)}</h3>
          <span className="whitespace-nowrap text-muted-foreground">{matchCount} {matchCount===1?'match':'matches'}</span>
        </div>
        <div className="flex items-baseline gap-x-3" data-slot="day-recap-result">
          {result.map(item=><DayRecapItem key={item.key} item={item} stat={stat}/>)}
        </div>
        {/* Narrow lists: the full width, spread out; the narrowest phones (320px)
            wrap the last figures to a second line rather than overflow. */}
        <div className="flex items-baseline gap-x-3 @max-xl:w-full @max-xl:flex-wrap @max-xl:justify-between @max-xl:gap-x-2.5 @max-xl:gap-y-1" data-slot="day-recap-performance">
          {performance.map(item=><DayRecapItem key={item.key} item={item} stat={stat}/>)}
        </div>
      </div>
    </section>
  );
}

export function MatchesPage(){
  const s=useEngine();
  const maps=useMapArt();
  const agents=useAgentArt();
  const [expanded,setExpanded]=useState(()=>new Set());
  const ready=s.analysisState==='ready';
  const hasMatches=ready&&s.allMatches.length>0;
  const data=s.mhData;
  const slice=data.slice(0,s.mhVisible);
  const remaining=Math.max(0,data.length-s.mhVisible);
  let lastDay=null;
  return (
    <main aria-labelledby="matches-title" className="space-y-6">
      <PageHeading id="matches-title" title="Match History"/>
      {hasMatches&&(
        <>
          <PlacementToggle/>
          {/* RR by session moved here from the RR Breakdown (22 Nov 2026, on
              request), replacing the matches / win rate / MVP summary strip. */}
          <RRSessionCard matches={s.allMatches} range={s.rrRanges.sessions}/>
          <div className="mh-list-heading">
            <span>Match log</span>
            <span>Newest first. Select a match for your rank change and the roster.</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {slice.map((m,index)=>{
              const dayKey=m.startedAtMs!=null?new Date(m.startedAtMs).toDateString():'unknown';
              const header=dayKey!==lastDay?<DayHeader ms={m.startedAtMs} stat={s.mhDayStats[dayKey]} first={index===0}/>:null;
              lastDay=dayKey;
              return (
                <Fragment key={m.matchId}>
                  {header}
                  <MatchCard m={m} s={s} maps={maps} agents={agents} open={expanded.has(m.matchId)} onOpenChange={next=>setExpanded(previous=>{
                    const copy=new Set(previous);
                    if(next)copy.add(m.matchId);else copy.delete(m.matchId);
                    return copy;
                  })}/>
                </Fragment>
              );
            })}
          </div>
          {remaining>0&&<Button variant="outline" className="w-full" onClick={loadMoreMatches}>Load More ({remaining} remaining)</Button>}
        </>
      )}
      {!hasMatches&&s.analysisState!=='error'&&(
        <EmptyState loading={s.analysisState==='loading'}>{s.analysisState==='loading'?'Loading this player’s matches…':ready?'No matches found for this season. Try another act.':'Search for a player above to explore their match history.'}</EmptyState>
      )}
    </main>
  );
}
