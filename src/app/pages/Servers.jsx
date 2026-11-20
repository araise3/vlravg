import {useEffect,useState} from 'react';
import {PARTY_LABELS,setServerPartySize,winRateLabel,winRateTone} from '@/engine/core.mjs';
import {useEngine} from '@/app/hooks.js';
import {EmptyState,LobbyValue,PageHeading,PartySizeFilter,PlacementToggle,SortableTable,TableSection,toneClass} from '@/app/shared.jsx';
import {Card} from '@/components/ui/card';

// The EU ping map (assets/ping-map) is a standalone D3 script that binds to the
// element IDs below when it loads, so this markup must stay as it is.
let pingMapLoad=null;
function loadServerPingMap(onError){
  if(pingMapLoad)return;
  pingMapLoad=(async()=>{
    if(!document.querySelector('link[data-ping-map-style]')){
      const css=document.createElement('link');css.rel='stylesheet';css.href='/assets/ping-map/map.css';css.dataset.pingMapStyle='';document.head.appendChild(css);
    }
    for(const file of ['d3.min.js','countries.js','map.js']){
      if(document.querySelector(`script[data-ping-map-file="${file}"]`))continue;
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='/assets/ping-map/'+file;script.dataset.pingMapFile=file;
        script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Map asset unavailable'));};document.head.appendChild(script);
      });
    }
  })().catch(()=>{pingMapLoad=null;onError();});
}

function PingMap({active}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>{if(active){setFailed(false);loadServerPingMap(()=>setFailed(true));}},[active]);
  return (
    <section id="server-ping-map" className="map-panel" aria-label="Europe server ping map" style={{'--text':'var(--foreground)','--font-body':'var(--font-sans)'}}>
      <div className="map-heading">
        <div className="map-server-heading"><strong id="map-server-name">Frankfurt</strong><span>10 ms contours, informed by 7 measured locations</span></div>
      </div>
      <svg id="map" viewBox="0 0 1000 760" preserveAspectRatio="xMidYMid slice" aria-label="Select a server pin and a country to explore approximate ping."><defs><clipPath id="map-clip"><rect width="1000" height="760"/></clipPath></defs><g clipPath="url(#map-clip)"><g id="map-scene"></g></g></svg>
      <div className="map-controls" aria-label="Map controls"><button id="zoom-in" type="button" aria-label="Zoom in">+</button><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="reset-map" type="button" aria-label="Reset map view">↺</button></div>
      <div id="tooltip" role="tooltip" hidden></div>
      <div className="map-footer">
        <div className="map-location-selects"><label>Country<select id="map-country" aria-label="Ping reference country"></select></label></div>
        <div id="map-readout" className="map-readout" role="status" aria-live="polite">{failed?'Map unavailable. Reopen Servers to retry.':'Loading map…'}</div>
        <div className="legend" aria-label="Estimated ping bands">
          {[['#62dfb4','<20 ms'],['#9ad579','20–35'],['#e2c06c','35–50'],['#e99a68','50–75'],['#dc758d','75+ ms']].map(([color,label])=>(
            <span key={label}><i style={{'--color':color}}></i>{label}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ServersTable({rows}){
  const tableRows=rows.map(row=>({key:row.name,cells:[
    <span className="block max-w-48 truncate" title={row.name}>{row.name}</span>,
    <>{row.games} <span className="text-xs text-muted-foreground">({Math.round(row.share)}%)</span></>,
    <LobbyValue sum={row.lobbySum} count={row.lobbyCount}/>,
    row.kd==null?'—':row.kd.toFixed(2),
    row.acs==null?'—':Math.round(row.acs),
    row.performanceScore==null?'—':Math.round(row.performanceScore),
    winRateLabel(row.winRate),
  ],cellProps:[null,null,null,{className:toneClass(row.kd)},null,
    {title:`${row.performanceCount} of ${row.games} matches have Performance Score data`},
    {className:winRateTone(row.winRate)==='rank-positive'?'text-positive':winRateTone(row.winRate)==='rank-negative'?'text-negative':''},
  ]}));
  const values=rows.map(row=>[row.name,row.games,row.avgLobby,row.kd,row.acs,row.performanceScore,row.winRate]);
  return (
    <SortableTable id="servers-table" standalone rows={tableRows} values={values}
      caption="Match results and performance grouped by game server; match share is the percentage of matches with a known server"
      columns={[{label:'Server'},{label:'Matches'},{label:'Avg Lobby',wide:true,align:'left'},{label:'K/D'},{label:'ACS',title:'Average combat score'},{label:'PS',title:'Avg PS across matches with available data'},{label:'Win rate',title:'Wins divided by wins plus losses; draws excluded'}]}
      maxima={[{column:1,label:'matches and match share'},{column:2,label:'average lobby rank'},{column:3,label:'K/D'},{column:4,label:'average ACS'},{column:5,label:'Avg PS'},{column:6,label:'win rate'}]}/>
  );
}

export function ServersPage({active}){
  const s=useEngine();
  const ready=s.analysisState==='ready';
  const hasServers=ready&&s.serverData.length>0;
  const showFilters=ready&&s.statMatches.some(m=>m.serverName);
  const empty=s.analysisState==='loading'?'Loading this player’s matches…':ready
    ?(s.serverPartySize&&s.serverFilteredMatchCount===0
      ?`No ${PARTY_LABELS[s.serverPartySize]||s.serverPartySize+'-Stack'} matches found for these filters.`
      :s.allMatches.length?'No server information was returned for these matches.':'No matches found for this season. Try another act.')
    :'Search for a player above to compare their servers.';
  return (
    <main aria-labelledby="servers-title" className="space-y-6">
      <PageHeading id="servers-title" title="Servers"/>
      {showFilters&&(
        <div className="flex flex-wrap items-center justify-between gap-4">
          <PartySizeFilter value={s.serverPartySize} available={s.partySizeAvailability['servers-party-size']} onChange={setServerPartySize}/>
          <PlacementToggle/>
        </div>
      )}
      {hasServers&&(
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4 max-sm:gap-px max-sm:overflow-hidden max-sm:rounded-xl max-sm:border max-sm:bg-border" aria-label="Server summary">
            {(s.serverSummary||[]).map(item=>(
              <Card key={item.label} className="gap-1 py-4 max-sm:rounded-none max-sm:border-0 max-sm:py-3">
                <dt className="px-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">{item.label}</dt>
                <dd className="truncate px-4 text-xl font-semibold" title={item.value}>{item.value}</dd>
                {item.note&&<small className="px-4 text-xs text-muted-foreground">{item.note}</small>}
              </Card>
            ))}
          </dl>
          <TableSection label="Servers"><ServersTable rows={s.serverData}/></TableSection>
        </>
      )}
      {!hasServers&&s.analysisState!=='error'&&<EmptyState loading={s.analysisState==='loading'}>{empty}</EmptyState>}
      <PingMap active={active}/>
    </main>
  );
}
