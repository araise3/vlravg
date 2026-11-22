// Moves match_archive payloads from D1 to R2 (docs/match-archive-r2.md) by
// calling the proxy's workflow-only POST /api/match-archive-migrate in rowid
// ranges. The proxy reads only its own D1 rows, so nothing here supplies data.
// Re-running is safe: rows already moved are skipped.
import {pathToFileURL} from 'node:url';
import {d1Query,d1DatabaseSize} from './d1-query.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Contiguous ranges (after, before) covering rowids 1..maxRowid exactly once.
export function rowidRanges(maxRowid,workers){
  if(maxRowid<1)return [];
  const width=Math.ceil(maxRowid/workers),ranges=[];
  for(let after=0;after<maxRowid;after+=width)ranges.push({after,before:Math.min(after+width,maxRowid)+1});
  return ranges;
}

export async function migrateRange(range,{origin,key,limit=40,deadline=Infinity,now=Date.now,
  fetchImpl=fetch,sleepImpl=sleep,log=console.log}){
  let after=range.after,moved=0,steps=0,failures=0;
  while(now()<deadline){
    const url=`${origin}/api/match-archive-migrate?after=${after}&before=${range.before}&limit=${limit}`;
    let res,body;
    try{
      res=await fetchImpl(url,{method:'POST',headers:{'X-Workflow-Key':key},signal:AbortSignal.timeout(60000)});
      body=await res.json().catch(()=>null);
    }catch(error){res=null;body={error:String(error?.message||error)};}
    if(res?.status===401)throw new Error('Migration route refused the workflow key');
    if(!res?.ok||!body?.data){
      // D1 overload or a transient R2 error: back off, then repeat the same step.
      if(++failures>=8)throw new Error(`Migration step after rowid ${after} kept failing: ${JSON.stringify(body).slice(0,200)}`);
      await sleepImpl(Math.min(60000,2000*2**failures));continue;
    }
    failures=0;steps++;
    moved+=body.data.moved;after=body.data.last;
    if(steps%50===0)log(`range ${range.after}-${range.before}: at rowid ${after}, ${moved} moved`);
    if(body.data.done)return{...range,moved,last:after,done:true};
  }
  return{...range,moved,last:after,done:false};
}

export async function main(env=process.env){
  for(const name of ['HENRIK_WORKFLOW_KEY','CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DATABASE_ID'])
    if(!env[name])throw new Error(`Missing ${name}`);
  const origin=new URL(env.SITE_ORIGIN||'https://vlravg1.pages.dev').origin;
  const workers=Number(env.WORKERS||4),runtime=Number(env.RUNTIME_MINUTES||330);
  if(!Number.isSafeInteger(workers)||workers<1||workers>8)throw new Error('WORKERS must be 1-8');
  const deadline=Date.now()+runtime*60000;
  const [{maxRowid}]=await d1Query(env,'SELECT COALESCE(MAX(rowid),0) AS maxRowid FROM match_archive');
  const sizeBefore=await d1DatabaseSize(env);
  console.log(`D1 ${(sizeBefore/1e9).toFixed(2)} GB; migrating rowids 1-${maxRowid} with ${workers} workers.`);
  const results=await Promise.all(rowidRanges(maxRowid,workers).map(range=>
    migrateRange(range,{origin,key:env.HENRIK_WORKFLOW_KEY,deadline})));
  const [{inline}]=await d1Query(env,'SELECT COUNT(*) AS inline FROM match_archive WHERE length(payload)>0');
  const sizeAfter=await d1DatabaseSize(env);
  const moved=results.reduce((sum,r)=>sum+r.moved,0);
  console.log(`Moved ${moved} payloads; ${inline} rows still inline; D1 ${(sizeBefore/1e9).toFixed(2)} -> ${(sizeAfter/1e9).toFixed(2)} GB.`);
  if(results.some(r=>!r.done))console.log(`Unfinished ranges: ${JSON.stringify(results.filter(r=>!r.done))}. Run again to continue.`);
  if(inline>0)process.exitCode=1;
  return{moved,inline,sizeBefore,sizeAfter,results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
