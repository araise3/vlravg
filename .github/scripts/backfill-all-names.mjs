import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {listPlayers,backfillPlayer} from './refresh-rr-history.mjs';
import {createRequestScheduler} from './request-scheduler.mjs';

export async function drainBackfill(players,{origin,fetchImpl=createRequestScheduler(),concurrency=4,
  deadline=Date.now()+300*60000,now=Date.now,log=console.log,runPage=backfillPlayer}={}) {
  const eligible=players.filter(p=>p.region&&p.platform);
  const progress=p=>(Number(p.next_start)||0)+(Number(p.stored_scanned)||0);
  const cursor=p=>`${p.matchlist_complete??(p.phase?.startsWith('stored')?1:0)}:${p.next_start||0}:${p.stored_page||1}:${p.stored_complete||0}:${p.stored_pending_count||0}`;
  const limited=p=>(!p.matchlist_complete&&p.next_start>=10000)||
    (p.matchlist_complete&&!p.stored_complete&&!p.stored_pending_count&&p.stored_scanned>=10000);
  // Oldest-touched players go first after a restart; round-robin pages keep
  // large histories from monopolizing a run. Never process a player twice at once.
  const queue=eligible.filter(p=>!p.backfill_complete&&!limited(p))
    .sort((a,b)=>(a.backfill_updated_at||'').localeCompare(b.backfill_updated_at||'')||a.puuid.localeCompare(b.puuid));
  const pending=new Set(eligible.filter(p=>!p.backfill_complete).map(p=>p.puuid));
  const errors=[];
  for(const p of eligible.filter(p=>!p.backfill_complete&&limited(p)))errors.push({puuid:p.puuid,reason:'backfill safety limit reached'});
  let pages=0,matches=0,completed=0;
  async function worker(){
    while(queue.length && now()<deadline){
      const player=queue.shift();
      let result;
      try{result=await runPage(player,{origin,pages:1,fetchImpl});}
      catch{result={ok:false,reason:'unexpected request failure'};}
      if(!result.ok){errors.push({puuid:player.puuid,reason:result.reason});log(`FAILED ${player.puuid}: ${result.reason}; cursor preserved`);continue;}
      if(!result.available){pending.delete(player.puuid);continue;}
      const before=cursor(player),advanced=progress(result)-progress(player);
      if(!result.complete&&cursor(result)===before){errors.push({puuid:player.puuid,reason:'cursor did not advance'});log(`FAILED ${player.puuid}: cursor did not advance`);continue;}
      pages++;matches+=Math.max(0,advanced);Object.assign(player,result,{backfill_complete:result.complete?1:0});
      if(result.complete){pending.delete(player.puuid);completed++;log(`Complete ${player.puuid}: ${result.next_start} full matches + ${result.stored_scanned||0} stored records`);}
      else queue.push(player);
      if(pages%30===0)log(`Progress: ${pages} pages, ${matches} matches, ${completed} players completed, ${pending.size} remaining`);
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},()=>worker()));
  const remaining=pending.size;
  return {pages,matches,completed,remaining,errors,continue:remaining>0&&pages>0};
}

export async function main(env=process.env){
  for(const key of ['CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])if(!env[key])throw new Error(`Missing required secret: ${key}`);
  const minutes=Number(env.RUNTIME_MINUTES||300);
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>300)throw new Error('RUNTIME_MINUTES must be between 1 and 300');
  const deadline=Date.now()+minutes*60000;
  const players=await listPlayers(env);
  console.log(`Backfilling all ${players.length} tracked players from live and stored match indexes; four workers share a 60 request/minute ceiling and proxy cooldowns.`);
  const result=await drainBackfill(players,{origin:new URL(env.SITE_ORIGIN||'https://vlravg1.pages.dev').origin,deadline});
  console.log(JSON.stringify(result));
  if(env.GITHUB_OUTPUT)appendFileSync(env.GITHUB_OUTPUT,`continue=${result.continue}\nremaining=${result.remaining}\n`);
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,
    `## Historical name backfill\n\n${result.matches} match records scanned in ${result.pages} pages; ${result.completed} players completed this run. ${result.remaining} players remain.\n\n`+
    (result.continue?'The next run resumes automatically.\n':result.remaining?'Stopped without progress; inspect the failed player logs before retrying.\n':'All eligible tracked players are complete.\n'));
  if(result.remaining&&!result.continue)process.exitCode=1;
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
