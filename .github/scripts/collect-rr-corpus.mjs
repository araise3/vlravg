import {pathToFileURL} from 'node:url';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {listPlayers,refreshPlayer,requestJSON} from './refresh-rr-history.mjs';
import {createRequestScheduler} from './request-scheduler.mjs';
import {d1Query} from './d1-query.mjs';

export async function collectPlayers(players,{origin,fetchImpl,log=console.log,concurrency=4}){
  let index=0,checked=0,gaps=0;
  const failures=[];
  async function worker(){
    while(index<players.length){
      const player=players[index++];
      try{
        let region=player.region,platform=player.platform;
        if(!region||!platform){
          const discovered=await refreshPlayer(player,{origin,fetchImpl});
          region=discovered.name.data?.region||region;
          platform=discovered.rr.platform||platform;
        }
        if(!region||!platform)throw new Error('region/platform unavailable');
        const result=await requestJSON(`${origin}/api/rr-collect/${region}/${platform}/${player.puuid}`,fetchImpl);
        if(!result.ok||result.data?.puuid!==player.puuid||!result.data.checked_at)throw new Error(result.reason||'invalid collection receipt');
        checked++;gaps+=result.data.possible_gap?1:0;
        if(checked%50===0)log(`RR committed: ${checked}/${players.length}`);
      }catch(error){failures.push({puuid:player.puuid,reason:error.message});log(`RR FAILED ${player.puuid}: ${error.message}`);}
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,players.length)},worker));
  return {players:players.length,checked,gaps,failures};
}

export async function corpusReport(env,query=d1Query){
  const ranks=await query(env,`SELECT json_extract(h.data,'$.season.id') AS season_id,
    json_extract(h.data,'$.season.short') AS act,json_extract(h.data,'$.tier.id') AS ending_tier,
    COUNT(*) AS payouts,COUNT(DISTINCT h.puuid) AS players,
    SUM(CASE WHEN f.match_id IS NOT NULL THEN 1 ELSE 0 END) AS with_features,
    SUM(CASE WHEN json_extract(h.data,'$.last_change')>0 THEN 1 ELSE 0 END) AS gains,
    SUM(CASE WHEN json_extract(h.data,'$.last_change')<0 THEN 1 ELSE 0 END) AS losses
    FROM rr_history h LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
    GROUP BY season_id,act,ending_tier ORDER BY act,ending_tier`);
  const health=await query(env,`SELECT COUNT(*) AS tracked,
    SUM(CASE WHEN c.checked_at IS NULL OR julianday(c.checked_at)<julianday('now','-8 hours') THEN 1 ELSE 0 END) AS stale,
    SUM(COALESCE(c.possible_gaps,0)) AS possible_gaps
    FROM rr_players p LEFT JOIN rr_collection c ON c.puuid=p.puuid AND c.platform=p.platform`);
  return {at:new Date().toISOString(),health:health[0],ranks,
    note:'Rank buckets use ending tier for collection monitoring. Model evaluation reconstructs starting rank and excludes ambiguous rows.'};
}

export async function main(env=process.env){
  const origin=new URL(env.SITE_ORIGIN||'https://vlravg1.pages.dev').origin;
  const limit=Number(env.DETAIL_LIMIT||1500);
  if(!Number.isSafeInteger(limit)||limit<0||limit>5000)throw new Error('Invalid DETAIL_LIMIT');
  const players=await listPlayers(env);
  const times=await d1Query(env,'SELECT puuid,MIN(checked_at) AS checked_at FROM rr_collection GROUP BY puuid');
  const checked=new Map(times.map(p=>[p.puuid,p.checked_at]));
  players.sort((a,b)=>(checked.get(a.puuid)||'').localeCompare(checked.get(b.puuid)||''));
  const fetchImpl=createRequestScheduler({intervalMs:1500});
  // Capture the irreplaceable rolling payout window before slower detail work.
  const refresh=await collectPlayers(players,{origin,fetchImpl});
  let details=0,detailFailed=0;
  const pending=limit?await d1Query(env,`SELECT h.puuid,h.match_id,p.region FROM rr_history h
    JOIN rr_players p ON p.puuid=h.puuid LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
    LEFT JOIN rr_feature_retry r ON r.puuid=h.puuid AND r.match_id=h.match_id
    WHERE f.match_id IS NULL AND p.region IS NOT NULL AND (r.next_attempt_at IS NULL OR r.next_attempt_at<datetime('now'))
    ORDER BY h.date DESC,h.puuid,h.match_id LIMIT ?1`,[limit]):[];
  let index=0;
  async function worker(){while(index<pending.length){
    const row=pending[index++];
    const result=await requestJSON(`${origin}/api/rr-feature/${row.region}/${row.puuid}/${row.match_id}`,fetchImpl);
    if(result.ok&&result.data.saved&&result.data.match_id===row.match_id)details++;
    else{detailFailed++;console.log(`Detail unavailable ${row.puuid}/${row.match_id}: ${result.reason||'invalid receipt'}`);}
  }}
  await Promise.all(Array.from({length:Math.min(4,pending.length)},worker));
  const report={...await corpusReport(env),refresh,details,detailFailed,detailQueued:pending.length};
  await mkdir('.local/rr-corpus',{recursive:true});
  await writeFile('.local/rr-corpus/collection-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,
    `## RR corpus\n\n${refresh.checked}/${refresh.players} accounts committed; ${refresh.failures.length} failed. ${details} match feature rows saved; ${detailFailed} unavailable.\n\n${report.health.stale} accounts overdue; ${report.health.possible_gaps} possible rolling-window gaps. See the report artifact for act/rank sample counts.\n`);
  if(refresh.failures.length)process.exitCode=1;
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
