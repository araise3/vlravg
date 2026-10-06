import {pathToFileURL} from 'node:url';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {listPlayers,refreshPlayer,requestJSON} from './refresh-rr-history.mjs';
import {createRequestScheduler} from './request-scheduler.mjs';
import {d1Query} from './d1-query.mjs';
import {loadActivity,loadCandidates} from './rr-activity-query.mjs';
import {selectPollingPlayers,selectDiscoveryCandidates,pollingPolicy} from '../../lib/rr-activity.mjs';

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

export async function collectMatchFeatures(rows,{origin,fetchImpl,log=console.log,concurrency=4}){
  let index=0,saved=0,deferred=0,failed=0;
  const discoveryMatches=new Set();
  async function worker(){while(index<rows.length){
    const row=rows[index++];
    const discover=discoveryMatches.size<50&&!discoveryMatches.has(row.match_id);
    if(discover)discoveryMatches.add(row.match_id);
    const result=await requestJSON(`${origin}/api/rr-feature/${row.region}/${row.puuid}/${row.match_id}${discover?'?discover=1':''}`,fetchImpl);
    const valid=result.ok&&result.data?.match_id===row.match_id&&result.data?.puuid===row.puuid;
    if(valid&&result.data.saved===true)saved++;
    else if(valid&&result.data.deferred===true&&result.data.reason==='upstream_match_not_found'&&result.data.retry_at){
      deferred++;
      log(`Detail deferred ${row.match_id}: upstream match not found; retry after ${result.data.retry_at} UTC; RR retained`);
    }else{failed++;log(`Detail FAILED ${row.puuid}/${row.match_id}: ${result.reason||'invalid receipt'}`);}
  }}
  await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},worker));
  return {saved,deferred,failed};
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
  const health=await query(env,`WITH activity AS (
    SELECT p.puuid,c.checked_at,c.possible_gaps,
      (SELECT MAX(julianday(date)) FROM rr_history h WHERE h.puuid=p.puuid) AS last_game,
      (SELECT COUNT(*) FROM rr_history h WHERE h.puuid=p.puuid AND julianday(date)>=julianday('now','-7 days')) AS games
    FROM rr_players p LEFT JOIN rr_collection c ON c.puuid=p.puuid AND c.platform=p.platform
  ) SELECT COUNT(*) AS tracked,
    SUM(CASE WHEN last_game<julianday('now','-7 days') OR (last_game IS NULL AND checked_at IS NOT NULL) THEN 1 ELSE 0 END) AS inactive,
    SUM(CASE WHEN checked_at IS NULL AND (last_game IS NULL OR last_game>=julianday('now','-7 days')) THEN 1
      WHEN last_game>=julianday('now','-7 days') AND julianday(checked_at)<=julianday('now')-
        CASE WHEN games>=10 AND last_game>=julianday('now','-2 days') THEN 4.0/24
          WHEN games>=3 AND last_game>=julianday('now','-3 days') THEN 12.0/24 ELSE 1 END THEN 1 ELSE 0 END) AS stale,
    SUM(COALESCE(possible_gaps,0)) AS possible_gaps FROM activity`);
  return {at:new Date().toISOString(),health:health[0],ranks,
    note:'Rank buckets use ending tier for collection monitoring. Model evaluation reconstructs starting rank and excludes ambiguous rows.'};
}

export async function main(env=process.env){
  if(!env.HENRIK_WORKFLOW_KEY)throw new Error('Missing required secret: HENRIK_WORKFLOW_KEY');
  const origin=new URL(env.SITE_ORIGIN||'https://vlravg1.pages.dev').origin;
  const limit=Number(env.DETAIL_LIMIT||1500);
  if(!Number.isSafeInteger(limit)||limit<0||limit>5000)throw new Error('Invalid DETAIL_LIMIT');
  const tracked=await loadActivity(env,await listPlayers(env));
  const players=selectPollingPlayers(tracked);
  const candidates=selectDiscoveryCandidates(await loadCandidates(env),tracked,25);
  console.log(`Polling ${players.length}/${tracked.length} tracked accounts due by activity; scouting ${candidates.length} recent roster candidates.`);
  const fetchImpl=createRequestScheduler({intervalMs:1500,workflowKey:env.HENRIK_WORKFLOW_KEY,origin});
  // Capture the irreplaceable rolling payout window before slower detail work.
  const refresh=await collectPlayers(players,{origin,fetchImpl});
  const scouting=await collectPlayers(candidates,{origin,fetchImpl});
  const pending=limit?await d1Query(env,`SELECT h.puuid,h.match_id,p.region FROM rr_history h
    JOIN rr_players p ON p.puuid=h.puuid LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
    LEFT JOIN rr_feature_retry r ON r.puuid=h.puuid AND r.match_id=h.match_id
    WHERE f.match_id IS NULL AND p.region IS NOT NULL
    AND (julianday(h.date)>=julianday('now','-7 days') OR r.puuid IS NOT NULL)
    AND (r.next_attempt_at IS NULL OR r.next_attempt_at<datetime('now'))
    ORDER BY h.date DESC,h.puuid,h.match_id LIMIT ?1`,[limit]):[];
  const featureResult=await collectMatchFeatures(pending,{origin,fetchImpl});
  const activityCounts={};
  for(const p of tracked){const cohort=pollingPolicy(p).cohort;activityCounts[cohort]=(activityCounts[cohort]||0)+1;}
  const report={...await corpusReport(env),refresh,scouting,details:featureResult.saved,
    detailDeferred:featureResult.deferred,detailFailed:featureResult.failed,detailQueued:pending.length,activityCounts,candidatesScouted:candidates.length};
  await mkdir('.local/rr-corpus',{recursive:true});
  await writeFile('.local/rr-corpus/collection-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,
    `## RR corpus\n\n${refresh.checked}/${refresh.players} accounts committed; ${refresh.failures.length} failed. ${featureResult.saved} match feature rows saved; ${featureResult.deferred} upstream matches deferred for retry (RR retained); ${featureResult.failed} detail errors.\n\n${report.health.stale} accounts overdue; ${report.health.possible_gaps} possible rolling-window gaps.\n`);
  if(refresh.failures.length||featureResult.failed)process.exitCode=1;
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
