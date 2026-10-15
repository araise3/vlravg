import {pathToFileURL} from 'node:url';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {listPlayers,refreshPlayer,requestJSON} from './refresh-rr-history.mjs';
import {createRequestScheduler} from './request-scheduler.mjs';
import {d1Query} from './d1-query.mjs';
import {randomUUID} from 'node:crypto';
import {readQuotaAudit,quotaCheckReport} from './workflow-quota-check.mjs';
import {loadActivity,loadCandidates} from './rr-activity-query.mjs';
import {loadFeaturePlan} from './rr-feature-plan.mjs';
import {selectPollingPlayers,selectDiscoveryCandidates,pollingPolicy} from '../../lib/rr-activity.mjs';

export async function collectPlayers(players,{origin,fetchImpl,log=console.log,concurrency=4,
  deadline=Infinity,now=Date.now,retryPass=true,sleepImpl}){
  let index=0,checked=0,gaps=0;
  const failures=[],unavailable=[];
  async function worker(){
    while(index<players.length&&now()<deadline){
      const player=players[index++];
      try{
        let region=player.region,platform=player.platform;
        if(!region||!platform){
          const discovered=await refreshPlayer(player,{origin,fetchImpl});
          region=discovered.name.data?.region||region;
          platform=discovered.rr.platform||platform;
        }
        if(!region||!platform)throw new Error('region/platform unavailable');
        const collect=()=>requestJSON(`${origin}/api/rr-collect/${region}/${platform}/${player.puuid}`,fetchImpl,sleepImpl,{deadline,now});
        let result=await collect();
        if(result.status===404){
          // PUUID stays stable across transfers; the stored shard may not.
          // This route forces an upstream account refresh, independent of the
          // saved name timeline. Only retry the shard reported for this PUUID.
          const account=await requestJSON(`${origin}/api/account-by-puuid/${player.puuid}`,fetchImpl,sleepImpl,{deadline,now});
          if(account.ok){
            const fresh=account.data?.region?.toLowerCase();
            if(account.data?.puuid?.toLowerCase()!==player.puuid||!['eu','na','ap','kr','latam','br'].includes(fresh))
              throw new Error('invalid account region response');
            if(fresh!==region){
              log(`RR region changed ${player.puuid}: ${region} -> ${fresh}`);
              region=fresh;player.region=fresh;
              result=await collect();
            }
          }else if(account.status!==404){
            const error=new Error(`Region lookup: ${account.reason}`);error.retryable=Boolean(account.retryable);throw error;
          }
          if(result.status===404){
            // The proxy durably records this failed attempt in D1. Polling
            // retries after a day, without pretending any RR was collected.
            unavailable.push({puuid:player.puuid,region,platform,reason:'upstream_account_unavailable'});
            log(`RR unavailable ${player.puuid}: ${region}/${platform}; retry after cooldown`);
            continue;
          }
        }
        if(!result.ok||result.data?.puuid!==player.puuid||!result.data.checked_at){
          const error=new Error(result.reason||'invalid collection receipt');error.retryable=Boolean(result.retryable);throw error;
        }
        checked++;gaps+=result.data.possible_gap?1:0;
        if(checked%50===0)log(`RR committed: ${checked}/${players.length}`);
      }catch(error){
        if(error?.code==='WORKFLOW_CONFIGURATION')throw error;
        if(error?.code==='WORKFLOW_BUDGET')break;
        failures.push({puuid:player.puuid,reason:error.message,retryable:Boolean(error.retryable)});log(`RR FAILED ${player.puuid}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,players.length)},worker));
  const retryIds=new Set(failures.filter(f=>f.retryable).map(f=>f.puuid));
  if(retryPass&&retryIds.size&&now()<deadline){
    log(`Retrying ${retryIds.size} transient capture failures before enrichment.`);
    const retried=await collectPlayers(players.filter(p=>retryIds.has(p.puuid)),{
      origin,fetchImpl,log,concurrency,deadline,now,retryPass:false,sleepImpl});
    for(let i=failures.length-1;i>=0;i--)if(retryIds.has(failures[i].puuid))failures.splice(i,1);
    failures.push(...retried.failures);unavailable.push(...retried.unavailable);checked+=retried.checked;gaps+=retried.gaps;
  }
  return {players:players.length,checked,gaps,failures,unavailable,deferred:players.length-checked-failures.length-unavailable.length};
}

export async function collectMatchFeatures(rows,{origin,fetchImpl,log=console.log,concurrency=4,
  deadline=Infinity,now=Date.now}){
  let index=0,saved=0,deferred=0,failed=0;
  const discoveryMatches=new Set();
  async function worker(){while(index<rows.length&&now()<deadline){
    const row=rows[index++];
    const discover=discoveryMatches.size<50&&!discoveryMatches.has(row.match_id);
    if(discover)discoveryMatches.add(row.match_id);
    let result;
    try{result=await requestJSON(`${origin}/api/rr-feature/${row.region}/${row.puuid}/${row.match_id}${discover?'?discover=1':''}`,fetchImpl,undefined,{deadline,now});}
    catch(error){if(error?.code==='WORKFLOW_BUDGET')break;throw error;}
    const valid=result.ok&&result.data?.match_id===row.match_id&&result.data?.puuid===row.puuid;
    if(valid&&result.data.saved===true)saved++;
    else if(valid&&result.data.deferred===true&&result.data.reason==='upstream_match_not_found'&&result.data.retry_at){
      deferred++;
      log(`Detail deferred ${row.match_id}: upstream match not found; retry after ${result.data.retry_at} UTC; RR retained`);
    }else{failed++;log(`Detail FAILED ${row.puuid}/${row.match_id}: ${result.reason||'invalid receipt'}`);}
  }}
  await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},worker));
  return {saved,deferred,failed,budgetDeferred:rows.length-saved-deferred-failed};
}

export async function corpusReport(env,query=d1Query){
  const ranks=await query(env,`SELECT json_extract(h.data,'$.season.id') AS season_id,
    json_extract(h.data,'$.season.short') AS act,json_extract(h.data,'$.tier.id') AS ending_tier,
    COUNT(*) AS payouts,COUNT(DISTINCT h.puuid) AS players,
    MIN(h.date) AS first_game,MAX(h.date) AS latest_game,
    SUM(CASE WHEN json_extract(h.data,'$.is_placement_match')=1 THEN 1 ELSE 0 END) AS placements,
    SUM(CASE WHEN f.match_id IS NOT NULL THEN 1 ELSE 0 END) AS with_features,
    SUM(CASE WHEN json_extract(h.data,'$.last_change')>0 THEN 1 ELSE 0 END) AS gains,
    SUM(CASE WHEN json_extract(h.data,'$.last_change')<0 THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN json_type(h.data,'$.tier_before_update.id')='integer' AND json_type(h.data,'$.rr_before_update') IN ('integer','real') THEN 1 ELSE 0 END) AS reported_start,
    SUM(CASE WHEN json_type(h.data,'$.rr_performance_bonus') IN ('integer','real') THEN 1 ELSE 0 END) AS bonus_known,
    SUM(CASE WHEN json_extract(h.data,'$.rr_performance_bonus')<>0 THEN 1 ELSE 0 END) AS bonus_nonzero,
    SUM(CASE WHEN json_type(h.data,'$.afk_penalty') IN ('integer','real') THEN 1 ELSE 0 END) AS afk_penalty_known,
    SUM(CASE WHEN json_type(h.data,'$.rr_penalty') IN ('integer','real') THEN 1 ELSE 0 END) AS rr_penalty_known,
    SUM(CASE WHEN json_type(h.data,'$.new_map_incentive_rr_forgiven') IN ('integer','real') THEN 1 ELSE 0 END) AS map_forgiveness_known,
    SUM(CASE WHEN json_type(h.data,'$.is_placement_match') IN ('true','false') THEN 1 ELSE 0 END) AS placement_known
    FROM rr_history h LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
    GROUP BY season_id,act,ending_tier ORDER BY act,ending_tier`);
  const latest=ranks.filter(row=>row.season_id&&row.latest_game).sort((a,b)=>Date.parse(b.latest_game)-Date.parse(a.latest_game))[0];
  const currentRows=latest?ranks.filter(row=>row.season_id===latest.season_id):[];
  const currentAct=latest?{id:latest.season_id,act:latest.act,
    first_game:currentRows.map(row=>row.first_game).sort()[0],latest_game:latest.latest_game,
    payouts:currentRows.reduce((n,row)=>n+row.payouts,0),placements:currentRows.reduce((n,row)=>n+row.placements,0)}:null;
  const health=await query(env,`WITH activity AS (
    SELECT p.puuid,c.checked_at,c.possible_gaps,failed.checked_at AS failed_probe_at,
      (SELECT MAX(julianday(date)) FROM rr_history h WHERE h.puuid=p.puuid) AS last_game,
      (SELECT COUNT(*) FROM rr_history h WHERE h.puuid=p.puuid AND julianday(date)>=julianday('now','-7 days')) AS games
    FROM rr_players p LEFT JOIN rr_collection c ON c.puuid=p.puuid AND c.platform=p.platform
    LEFT JOIN rr_candidate_checks failed ON failed.puuid=p.puuid AND failed.platform=p.platform
  ) SELECT COUNT(*) AS tracked,
    SUM(CASE WHEN (last_game<julianday('now','-7 days') OR (last_game IS NULL AND checked_at IS NOT NULL))
      AND (?1 IS NULL OR julianday(checked_at)>=julianday(?1)) THEN 1 ELSE 0 END) AS inactive,
    SUM(CASE WHEN julianday(failed_probe_at)>julianday('now','-1 day')
      AND (checked_at IS NULL OR julianday(failed_probe_at)>julianday(checked_at)) THEN 0
      WHEN checked_at IS NULL AND (last_game IS NULL OR last_game>=julianday('now','-7 days')) THEN 1
      WHEN last_game>=julianday('now','-7 days') AND julianday(checked_at)<=julianday('now')-
        CASE WHEN games>=10 AND last_game>=julianday('now','-2 days') THEN 4.0/24
          WHEN games>=3 AND last_game>=julianday('now','-3 days') THEN 12.0/24 ELSE 1 END THEN 1
      WHEN ?1 IS NOT NULL AND (checked_at IS NULL OR julianday(checked_at)<julianday(?1)) THEN 1 ELSE 0 END) AS stale,
    SUM(COALESCE(possible_gaps,0)) AS possible_gaps FROM activity`,[currentAct?.first_game??null]);
  const competitiveUpdates={};
  for(const field of ['payouts','reported_start','bonus_known','bonus_nonzero','afk_penalty_known','rr_penalty_known','map_forgiveness_known','placement_known']){
    competitiveUpdates[field]=ranks.reduce((sum,row)=>sum+(Number(row[field])||0),0);
  }
  return {at:new Date().toISOString(),health:health[0],currentAct,ranks,competitiveUpdates,
    note:'Rank buckets use ending tier for collection monitoring. Model evaluation reconstructs starting rank and excludes ambiguous rows.'};
}

export async function main(env=process.env){
  if(!env.HENRIK_WORKFLOW_KEY)throw new Error('Missing required secret: HENRIK_WORKFLOW_KEY');
  const origin=new URL(env.SITE_ORIGIN||'https://vlravg1.pages.dev').origin;
  const limit=Number(env.DETAIL_LIMIT||1500);
  if(!Number.isSafeInteger(limit)||limit<0||limit>5000)throw new Error('Invalid DETAIL_LIMIT');
  const runtime=Number(env.RUNTIME_MINUTES||180);
  if(!Number.isSafeInteger(runtime)||runtime<10||runtime>210)throw new Error('RUNTIME_MINUTES must be between 10 and 210');
  const deadline=Date.now()+(runtime-5)*60000; // Reserve time for the report before the next four-hour run.
  const tracked=await loadActivity(env,await listPlayers(env));
  const players=selectPollingPlayers(tracked);
  const candidates=selectDiscoveryCandidates(await loadCandidates(env),tracked,25);
  console.log(`Polling ${players.length}/${tracked.length} tracked accounts due by activity; scouting ${candidates.length} recent roster candidates.`);
  const runId=env.GITHUB_RUN_ID?`${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT||1}:${randomUUID()}`:randomUUID();
  const quotaBefore=await readQuotaAudit(env,runId);
  const fetchImpl=createRequestScheduler({workflowKey:env.HENRIK_WORKFLOW_KEY,origin,runId,serialize:true,deadline});
  // Capture the irreplaceable rolling payout window before slower detail work.
  const refresh=await collectPlayers(players,{origin,fetchImpl,deadline});
  // Spend remaining quota on incomplete tracked capture before optional research work.
  const captureIncomplete=refresh.failures.some(f=>f.retryable)||refresh.deferred>0;
  const activityCounts={};
  for(const p of tracked){const cohort=pollingPolicy(p).cohort;activityCounts[cohort]=(activityCounts[cohort]||0)+1;}
  const report={at:new Date().toISOString(),refresh,scouting:null,details:0,
    detailDeferred:0,detailFailed:0,detailBudgetDeferred:0,detailQueued:0,activityCounts,candidatesScouted:0,
    enrichmentSkipped:captureIncomplete?'tracked_capture_incomplete':null};
  await mkdir('.local/rr-corpus',{recursive:true});
  // Preserve payouts already committed before any optional query or request.
  await writeFile('.local/rr-corpus/collection-report.json',JSON.stringify(report,null,2));
  try{
    report.scouting=await collectPlayers(captureIncomplete?[]:candidates,{origin,fetchImpl,deadline});
    report.candidatesScouted=report.scouting.players;
    const plan=await loadFeaturePlan(env,!captureIncomplete&&Date.now()<deadline?limit:0);
    report.detailInventory=plan.inventory;
    const pending=plan.rows;
    console.log(`Database inventory: ${plan.inventory.saved} completed feature rows skipped; ${plan.inventory.missing} missing; ${plan.inventory.archived} available from saved matches; ${plan.inventory.waitingRetry} waiting for upstream retry.`);
    report.detailQueued=pending.length;
    const features=await collectMatchFeatures(pending,{origin,fetchImpl,deadline});
    Object.assign(report,{details:features.saved,detailDeferred:features.deferred,
      detailFailed:features.failed,detailBudgetDeferred:features.budgetDeferred});
  }catch(error){report.enrichmentError=error.message;console.error(`Enrichment failed: ${error.message}`);}
  try{Object.assign(report,await corpusReport(env));}
  catch(error){report.coverageError=error.message;console.error(`Coverage report failed: ${error.message}`);}
  report.quotaCheck=quotaCheckReport(quotaBefore,await readQuotaAudit(env,runId));
  if(['other_proxy_activity','possible_external_usage'].includes(report.quotaCheck.status))
    console.warn(`::warning::Workflow key may be shared: ${report.quotaCheck.otherProxyCalls} other proxy calls; ${report.quotaCheck.unexplainedRequests} unexplained quota units.`);
  await writeFile('.local/rr-corpus/collection-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,
    `## RR corpus\n\n${refresh.checked}/${refresh.players} accounts committed; ${refresh.failures.length} failed; ${refresh.deferred} deferred by the run budget. ${report.details} match feature rows saved; ${report.detailDeferred} upstream matches deferred for retry (RR retained); ${report.detailFailed} detail errors; ${report.detailBudgetDeferred} details deferred by the run budget.\n\n${report.health?.stale??'Unknown'} accounts overdue; ${report.health?.possible_gaps??'Unknown'} possible rolling-window gaps.\n`+
    (report.currentAct?`\nObserved act: ${report.currentAct.act||report.currentAct.id}; ${report.currentAct.payouts} payouts, including ${report.currentAct.placements} placements.\n`:'')+
    `\nAccounts unavailable after a region check: ${refresh.unavailable?.length||0}; saved RR retained, retry cooldown applied.\n`+
    (report.detailInventory?`\nDatabase inventory before enrichment: ${report.detailInventory.saved} completed feature rows skipped; ${report.detailInventory.missing} missing, including ${report.detailInventory.archived} archived matches ready without an upstream fetch, ${report.detailInventory.waitingRetry} waiting for retry, and ${report.detailInventory.missingRegion} without a known region.\n`:'')+
    `\nQuota check: ${report.quotaCheck.status}; ${report.quotaCheck.otherProxyCalls??'unknown'} other proxy calls; ${report.quotaCheck.unexplainedRequests??'unknown'} unexplained quota units. This cannot identify another instance or prove exclusive use.\n`+
    (report.enrichmentSkipped?'\nOptional enrichment skipped because tracked capture is incomplete.\n':'')+
    (report.enrichmentError||report.coverageError?'\nEnrichment or coverage reporting failed; see the job log. Committed RR is retained.\n':''));
  if(refresh.failures.length||refresh.deferred||report.detailFailed||report.enrichmentError||report.coverageError)process.exitCode=1;
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
