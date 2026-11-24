// Measured HenrikDev units per upstream call (lib/upstream-pacing.mjs).
//
// HenrikDev charges "1 request to the API = +1" and "1 background request to
// Riot = +1" (docs.henrikdev.xyz general/rate-limiting) but reports no cost
// per call. The gate therefore measures it: a call admitted right after the
// previous call's response was seen, and whose own response is the newest,
// had the key to itself, so the drop in HenrikDev's remaining count between
// the two responses is that call's cost (`clean` in upstream-pacing). Each
// such sample is kept in quota_cost_samples, by route key.
//
// Admission reserves the route's measured cost: the 90th percentile of its
// newest QUOTA_COST_SAMPLES samples, so one call that shared the key with
// something outside the gate does not set the price. A route not measured
// yet reserves the highest measured route cost; with no samples at all, the
// documented minimum of 1. The response header then sets the real count.
export const QUOTA_COST_SAMPLES=30;
export const QUOTA_COST_PERCENTILE=0.9;
export const QUOTA_COST_CACHE_MS=60_000;
export const QUOTA_COST_KEEP_DAYS=14;
export const QUOTA_COST_MINIMUM=1;

export const QUOTA_COST_SCHEMA=`CREATE TABLE IF NOT EXISTS quota_cost_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,observed_at TEXT NOT NULL,pool TEXT NOT NULL,
  route TEXT NOT NULL,cache_status TEXT,status INTEGER,cost INTEGER NOT NULL
)`;

// The route key a cost is measured and looked up by: the /api path's first
// segment, plus the page size for match lists and the phase for name
// backfill, since those decide how much HenrikDev fetches.
export function costKey(route,match,url,requestPath){
  const segment=String(requestPath||'').split('/')[1]||'other';
  if(route?.nameBackfill)return `${segment}:${match?.state?.phase||'live'}`;
  if(route?.historyByPuuid||segment==='history'){
    const size=Number(url?.searchParams?.get('size'));
    return `${segment}:${Number.isInteger(size)&&size>0?size:'default'}`;
  }
  return segment;
}

export function percentile(values,p=QUOTA_COST_PERCENTILE){
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1))];
}

// One cached cost table per database binding, refreshed every
// QUOTA_COST_CACHE_MS, so admission does not add a D1 read per call.
const tables=new WeakMap();

async function loadTable(db,now){
  const since=new Date(now-QUOTA_COST_KEEP_DAYS*86400000).toISOString();
  const {results}=await db.prepare(`SELECT route,cost FROM (
      SELECT route,cost,ROW_NUMBER() OVER (PARTITION BY route ORDER BY id DESC) AS rn
      FROM quota_cost_samples WHERE observed_at>=?1)
    WHERE rn<=?2`).bind(since,QUOTA_COST_SAMPLES).all();
  const byRoute=new Map();
  for(const row of results||[]){
    if(!Number.isInteger(row.cost)||row.cost<0)continue;
    if(!byRoute.has(row.route))byRoute.set(row.route,[]);
    byRoute.get(row.route).push(row.cost);
  }
  const costs=new Map([...byRoute].map(([key,values])=>[key,{cost:Math.max(QUOTA_COST_MINIMUM,percentile(values)),samples:values.length}]));
  return {at:now,costs};
}

// {cost, source: 'measured' | 'highest-measured' | 'minimum', samples}
export async function measuredCost(db,key,{now=Date.now()}={}){
  let table=tables.get(db);
  if(!table||now-table.at>=QUOTA_COST_CACHE_MS){
    // Without a readable table (none yet, or storage trouble the gate will
    // report itself), keep the last loaded costs, or start measuring.
    try{table=await loadTable(db,now);}
    catch{table={at:now,costs:table?.costs||new Map()};}
    tables.set(db,table);
  }
  const own=table.costs.get(key);
  if(own)return {cost:own.cost,source:'measured',samples:own.samples};
  const highest=Math.max(0,...[...table.costs.values()].map(entry=>entry.cost));
  return highest>0?{cost:highest,source:'highest-measured',samples:0}:{cost:QUOTA_COST_MINIMUM,source:'minimum',samples:0};
}

export async function recordCostSample(db,{pool,route,cacheStatus=null,status=null,cost,now=Date.now()}){
  if(!Number.isInteger(cost)||cost<0)return;
  const key=/^[a-z0-9:-]{1,48}$/.test(route||'')?route:'other';
  const cache=/^[A-Z_]{1,16}$/.test(cacheStatus||'')?cacheStatus:null;
  await db.prepare(QUOTA_COST_SCHEMA).run();
  await db.prepare(`INSERT INTO quota_cost_samples(observed_at,pool,route,cache_status,status,cost)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(new Date(now).toISOString(),pool==='workflow'?'workflow':'public',key,cache,
    Number.isInteger(status)?status:null,cost).run();
  await db.prepare('DELETE FROM quota_cost_samples WHERE observed_at<?1')
    .bind(new Date(now-QUOTA_COST_KEEP_DAYS*86400000).toISOString()).run();
}
