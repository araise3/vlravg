// Maintenance switch for the public site (docs/ml-sim-pilot.md, "Maintenance mode").
// One D1 row turns it on, no redeploy needed:
//   CREATE TABLE IF NOT EXISTS site_flags (name TEXT PRIMARY KEY, value TEXT, until INTEGER);
//   INSERT OR REPLACE INTO site_flags VALUES ('maintenance', '<random token>', <end, ms since epoch>);
// and DELETE FROM site_flags WHERE name='maintenance' (or reaching `until`) turns it off.
// While on, visitors' API requests get a 503, collector workflows keep their own key pool but may
// not borrow public slots, and only requests carrying the token (X-Sim-Pilot) use the public key.
// Read at most every 15 s per isolate and database; a missing table or any storage error counts as
// off, so the site can't go dark by accident.
const CACHE_MS=15000;
const cache=new WeakMap();

export async function maintenance(db,now=Date.now()){
  if(!db)return null;
  const hit=cache.get(db);
  if(hit&&now-hit.at<CACHE_MS)return live(hit.value,now);
  let value=null;
  try{
    const row=await db.prepare(`SELECT value,until FROM site_flags WHERE name='maintenance'`).first();
    if(row?.value)value={token:String(row.value),until:row.until!=null&&Number.isFinite(Number(row.until))?Number(row.until):null};
  }catch{value=null;}
  cache.set(db,{at:now,value});
  return live(value,now);
}
const live=(v,now)=>v&&!(v.until!=null&&v.until<=now)?v:null; // no end time: on until deleted
