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

// Only what changed this match's RR beyond the plain payout, as short notes;
// zeros, "No" and the queue id are left out. Reported bonus, forgiveness and
// penalties are already inside the RR change, so they are never added again.
// Penalty units are not defined by the schema: AFK and party penalties show
// the reported value verbatim and are never turned into RR.
export function rrNotes(m){
  const d=m.myRRDetails||{};
  const notes=[];
  const inside='Reported for this update and already part of its RR change';
  if(m.myDerankProtected)notes.push({key:'shield',tone:'shield',text:'Rank Shield kept your rank',hint:'Rank Shield protected your displayed rank; the recorded RR loss still applied'});
  if(d.placement)notes.push({key:'placement',text:'Placement match',hint:'Riot reported this as a placement match; it is left out of RR stats'});
  if(d.bonus)notes.push({key:'bonus',tone:d.bonus>0?'gain':'loss',text:rrSigned(d.bonus,0)+' RR performance bonus',hint:inside});
  if(d.mapForgiveness)notes.push({key:'forgiveness',tone:'gain',text:rrSigned(d.mapForgiveness,0)+' RR new-map forgiveness',hint:inside});
  if(m.myRefundedRR)notes.push({key:'refund',tone:'gain',text:rrSigned(m.myRefundedRR,0)+' RR refunded',hint:'Refunded RR is applied on top of this match’s RR change'});
  if(d.afkPenalty)notes.push({key:'afk',tone:'loss',text:'AFK penalty '+d.afkPenalty+' (reported)',hint:'Reported AFK penalty, shown as given'});
  const party=d.penalty||m.myPartyPenalty;
  if(party)notes.push({key:'party',tone:'loss',text:'Party RR penalty '+party+' (reported)',hint:'Reported party penalty factor, shown as given; not converted to RR'});
  if(d.shieldReplenished)notes.push({key:'replenished',tone:'shield',text:'Rank Shield replenished'});
  return notes;
}

// Quiet text lines in their tone colour under the stat strip (22 Nov 2026, on
// request: pills were disliked; they sat in the Rank tile until that tile was
// removed the same day).
export function RRNotes({m}){
  const notes=rrNotes(m);
  if(!notes.length)return null;
  return (
    <ul className="mc-rr-notes" aria-label="RR notes" data-slot="rr-notes">
      {notes.map(n=>{
        const line=<span className={cn('mc-rr-note',n.tone)}>{n.tone==='shield'&&<Shield aria-hidden="true"/>}{n.text}</span>;
        return <li key={n.key}>{n.hint?<Hint asChild content={n.hint}>{line}</Hint>:line}</li>;
      })}
    </ul>
  );
}

// Long Riot IDs (22 Nov 2026, on request): the name column takes all the room
// the stat columns leave. Ranks are the short name in the rank colour ("Dia 1",
// full name in the tooltip) on every width; icons were tried the same day and
// reverted on request. The stat columns are only as wide as their numbers.
// When a name still does not fit, its tag gives way before the name does (it
// shrinks first), and the full Riot ID is in the link's tooltip. `compact`
// (phones): tighter columns and no tag.
function PlayersGrid({m,me,compact,agents}){
  const cols=compact?'grid-cols-[minmax(0,1fr)_2.25rem_2.25rem_2.5rem_3.25rem] gap-1.5':'grid-cols-[minmax(0,1fr)_2.5rem_2.5rem_2.75rem_3.5rem] gap-2';
  const myTeamId=me?.team_id,myPartyId=m.myPartyId;
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
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {teams.map(([label,players,avg])=>(
        <div key={label} className="text-sm">
          <div className={cn('grid items-end border-b',cols,'px-2 pb-2 text-xs text-muted-foreground uppercase')}>
            <span className="truncate">{label}</span>
            <span className="text-right">ACS</span><span className="text-right"><Hint content="Performance Score">PS</Hint></span><span className="text-right">KD</span>
            {Number.isFinite(avg)
              ?<Hint asChild content={label+' average rank (rated players): '+lobbyRankText(avg)}><span className={cn('truncate text-right normal-case font-semibold',RANK_TEXT[rClass(tierRR(avg).tier)])} data-slot="team-rank">{avgLabelShort(tierRR(avg).tier)}</span></Hint>
              :<span className="text-right">Rank</span>}
          </div>
          {players.map((p,i)=>{
            const isMe=p===me,isParty=myPartyId&&p.party_id===myPartyId;
            // The tag shrinks first (shrink-[20]); only then is the name cut.
            const content=<><span className={cn('min-w-0 truncate',isParty&&'text-sky-300',isMe&&'font-semibold text-foreground')}>{p.name||'Unknown player'}</span>{p.tag&&!compact&&<span className="min-w-0 shrink-[20] truncate text-xs text-muted-foreground" data-slot="player-tag">#{p.tag}</span>}</>;
            const agent=p.agent&&<Hint asChild content={p.agent}><span className="shrink-0"><AgentIcon agents={agents} name={p.agent} id={p.agentId} size={compact?20:22}/></span></Hint>;
            return (
              <div key={p.puuid||i} className={cn('grid items-center rounded-md',cols,'px-2 py-1.5 tabular',isMe&&'bg-rank/10')}>
                <span className="flex min-w-0 items-center gap-2">
                  {agent}
                  {p.name&&p.tag
                    ?<a href={playerRouteUrl(p.name,p.tag)} title={`${p.name}#${p.tag}`} className="flex min-w-0 items-baseline gap-0.5 hover:underline">{content}</a>
                    :<span className="flex min-w-0 items-baseline gap-0.5" title={p.name||undefined}>{content}</span>}
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
  return {
    rt,result:won===true?'win':won===false?'loss':'draw',award,awardLabel,place,placeHint,rank,myRank,performanceScore,acs:myAcs,
    shielded:!!myDerankProtected&&myRR<0,
    time:startedAtMs!=null?new Date(startedAtMs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):startedAt,
    duration:matchLengthText(m.durationMs),
    me,
    label:rt+' on '+mapName+', '+score+'. '+(m.myAgent?'Played '+m.myAgent+'. ':'')+(awardLabel?awardLabel+'. ':'')+kda+' KDA, '+myAcs+' ACS, '+performanceScore+' Performance Score.'+(rank?' Average lobby '+lobbyRankText(avgRank)+'.':''),
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

function RRChange({m,v,className}){
  const {myRR}=m;
  return (
    <Hint asChild content={myRR==null?'No RR data for this match':v.shielded?'Rank Shield protected your displayed rank; this recorded RR loss still applied':'Recorded RR change for this match'}>
      <span className={cn('match-rr-change',myRR!=null&&(myRR>=0?'gain':'loss'),v.shielded&&'shielded',className)}>
        {v.shielded&&<Shield aria-hidden="true"/>}{myRR!=null?(myRR>=0?'+':'')+myRR:'—'}
      </span>
    </Hint>
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
// version looked empty). One strip of hairline tiles: K/D, ACS, ADR, damage
// delta per round, headshot %, KAST, clutch win rate, and the game length with
// the start under it. K/D and ACS were asked for here although the closed row
// has K/D/A and ACS. The Rank tile (rank before and after) was removed the same
// day on request. The server joins only where the closed row hides it
// (`.mc-info-server`). The RR notes follow as quiet text lines.
function MatchInfo({m,v}){
  const st=m.myStats||{};
  const started=[m.startedAtMs!=null?new Date(m.startedAtMs).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):null,v.time].filter(Boolean).join(', ');
  const clutch=clutchSummaryText(m.myClutches);
  const tiles=[
    {label:'K/D',value:Number.isFinite(st.kd)?st.kd.toFixed(2):null,foot:st.kills!=null&&st.deaths!=null?`${st.kills} K, ${st.deaths} D`:null,hint:'Kills divided by deaths'},
    {label:'ACS',value:Number.isFinite(st.acs)?Math.round(st.acs):null,foot:'per round',hint:'Average combat score'},
    {label:'ADR',value:st.adr,foot:Number.isFinite(st.dmg)?`${Math.round(st.dmg).toLocaleString('en-GB')} damage`:null,hint:'Average damage per round'},
    {label:'DDΔ',value:Number.isFinite(st.ddDelta)?rrSigned(st.ddDelta,0):null,tone:Number.isFinite(st.ddDelta)&&st.ddDelta!==0?(st.ddDelta>0?'text-positive':'text-negative'):null,
      foot:Number.isFinite(st.dmgTaken)?`${Math.round(st.dmgTaken).toLocaleString('en-GB')} taken`:null,hint:'Damage delta: damage dealt minus damage taken, per round'},
    {label:'HS%',value:st.hsPct!=null?st.hsPct+'%':null,foot:'of hits',hint:'Headshots as a share of your hits'},
    {label:'KAST',value:st.kast!=null?st.kast+'%':null,foot:st.kastRounds!=null?`${st.kastRounds} of ${st.kastTotalRounds} rounds`:null,hint:'Rounds with a kill, assist, survival or trade'},
    {label:'Clutches',value:clutch?.total?Math.round(clutch.won/clutch.total*100)+'%':null,foot:clutch?(clutch.total?`${clutch.won} of ${clutch.total} won`:'No situations'):'No round data',hint:clutch?.detail||undefined},
    {label:'Length',value:v.duration,foot:started||null},
    {label:'Server',value:m.serverName,className:'mc-info-server'},
  ];
  return (
    <section className="space-y-3" aria-label="Match info" data-slot="match-info">
      <dl className="mc-stats" data-slot="match-stats">
        {tiles.map(t=>(
          <div key={t.label} className={cn('mc-stat-tile',t.className)}>
            <dt className="mc-stat-label">{t.hint?<Hint content={t.hint}>{t.label}</Hint>:t.label}</dt>
            <dd className={cn('mc-stat-value',t.value==null?'text-muted-foreground':t.tone)}>{t.value??'—'}</dd>
            {t.foot&&<dd className="mc-stat-foot">{t.foot}</dd>}
          </div>
        ))}
      </dl>
      <RRNotes m={m}/>
    </section>
  );
}

// Phones: two lines next to the agent tile. Result, score, the average lobby
// and RR change; then map, K/D/A and one score with your place after it: PS,
// or ACS on older matches without PS. ACS left the phone line on 22 Nov 2026
// (on request) to make room for the place; it is still in the roster.
// Everything else is in the opened card.
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
              <RRChange m={m} v={v} className="text-[15px]"/>
            </span>
            <span className="flex min-w-0 items-center gap-x-3 text-xs tabular-nums text-muted-foreground">
              <span className="min-w-0 truncate font-semibold text-foreground">{m.mapName}</span>
              <PlaceTag v={v} className="shrink-0"/>
              <span className="shrink-0 font-semibold text-foreground"><KdaValue stats={m.myStats}/></span>
              {m.mvpBasis==='acs'
                ?<span className="shrink-0"><span className="font-semibold text-foreground">{v.acs}</span> ACS</span>
                :<span className="shrink-0"><span className="font-semibold text-foreground">{v.performanceScore}</span> PS</span>}
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
// result, your performance (K/D/A, ACS, PS), server, RR change. The map splash is a faded backdrop on
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
          <span className="mc-cell mc-identity">
            <span className="match-map">{m.mapName}</span>
            <span className="mc-sub">
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

function DayHeader({ms,stat,first}){
  let avgValue='—',avgClass='',rrValue='—',rrClass='';
  if(stat&&stat.count>0){
    const {tier}=tierRR(stat.sum/stat.count);
    avgValue=lobbyRankText(stat.sum/stat.count);avgClass=RANK_TEXT[rClass(tier)];
  }
  if(stat&&stat.rrCount>0){rrValue=`${stat.rrTotal>=0?'+':''}${stat.rrTotal} RR`;rrClass=stat.rrTotal>=0?'text-positive':'text-negative';}
  const matchCount=stat?.matches??0;
  const record=[stat?.wins?[`${stat.wins}W`,'text-positive']:null,stat?.losses?[`${stat.losses}L`,'text-negative']:null,stat?.draws?[`${stat.draws}D`,'text-draw']:null].filter(Boolean);
  return (
    <div className={cn('match-day-header',first&&'first')}>
      <div className="match-day-heading">
        <span className="match-day-title">{dayHeaderLabel(ms)}</span>
        <span className="match-day-count">{matchCount} {matchCount===1?'match':'matches'}</span>
      </div>
      <div className="match-day-stats" aria-label="Daily recap">
        <span className="match-day-stat"><span className="match-day-stat-label">Record</span>
          <span className="match-day-stat-value">{record.length?record.map(([text,tone],i)=><span key={text}>{i>0&&<span className="text-muted-foreground" aria-hidden="true"> – </span>}<span className={tone}>{text}</span></span>):'—'}</span></span>
        <span className="match-day-stat"><span className="match-day-stat-label">Avg lobby</span><span className={cn('match-day-stat-value',avgClass)}>{avgValue}</span></span>
        <span className="match-day-stat">
          <span className="match-day-stat-label"><Hint content={stat?.rrCount?`Net RR from ${stat.rrCount} of ${matchCount} matches with RR data. Rank Shield losses include their recorded loss.`:'No RR data is available for this day.'}>Net RR</Hint></span>
          <span className={cn('match-day-stat-value',rrClass)}>{rrValue}</span>
          {stat?.rrCount<stat?.matches&&stat?.rrCount>0&&<span className="match-day-coverage">{stat.rrCount}/{stat.matches} covered</span>}
        </span>
      </div>
    </div>
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
