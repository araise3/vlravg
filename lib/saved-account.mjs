// A search's account lookup answered from D1 when the public quota cannot
// serve it (docs/profile-quota-reserve.md). The identity comes only from
// player_name_history, which is written from server-fetched HenrikDev account
// responses (lib/name-history.mjs observeName), plus the region saved beside it
// in rr_players. Nothing here is ever taken from a browser-supplied payload.

// An identity not re-observed for this long is not served: the Riot ID may
// have moved to another account since. The live lookup decides those.
export const SAVED_ACCOUNT_MAX_AGE_MS=30*24*60*60*1000;

const PUUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Returns {puuid,name,tag,region,platform,...} or null when D1 holds no single,
// recent, region-bearing current identity for the lookup.
export async function readSavedAccount(db,{puuid,name,tag},now=Date.now()){
  let rows;
  if(puuid){
    const id=String(puuid).toLowerCase();
    if(!PUUID.test(id))return null;
    ({results:rows}=await db.prepare(`SELECT h.puuid,h.name,h.tag,h.last_seen,p.region,p.platform
      FROM player_name_history h LEFT JOIN rr_players p ON p.puuid=h.puuid
      WHERE h.puuid=?1 AND h.ended_at IS NULL LIMIT 2`).bind(id).all());
  }else{
    if(typeof name!=='string'||!name||typeof tag!=='string'||!tag)return null;
    // Every account currently claiming this Riot ID, at any age: two claims
    // mean one of them is stale, and D1 cannot tell which.
    ({results:rows}=await db.prepare(`SELECT h.puuid,h.name,h.tag,h.last_seen,p.region,p.platform
      FROM player_name_history h LEFT JOIN rr_players p ON p.puuid=h.puuid
      WHERE lower(h.name)=lower(?1) AND lower(h.tag)=lower(?2) AND h.ended_at IS NULL LIMIT 2`)
      .bind(name,tag).all());
  }
  if(rows?.length!==1)return null;
  const row=rows[0];
  const seen=Date.parse(row.last_seen);
  if(!Number.isFinite(seen)||seen<now-SAVED_ACCOUNT_MAX_AGE_MS)return null;
  // Without a region the client would read the wrong shard's history.
  if(typeof row.region!=='string'||!row.region)return null;
  return {puuid:row.puuid,region:row.region.toLowerCase(),name:row.name,tag:row.tag,
    ...(row.platform?{platform:row.platform}:{}),
    vlravg_source:'saved-account',observed_at:new Date(seen).toISOString()};
}
