import { startCapacitySession, runCapacityFrame } from '../../lib/riot-capacity-probe.mjs';
const encoder = new TextEncoder();
async function keyFor(secret) {
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function seal(state,secret,id) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(id)},await keyFor(secret),encoder.encode(JSON.stringify(state))));
  return {iv:Array.from(iv),data:btoa(String.fromCharCode(...bytes))};
}
async function open(sealed,secret,id) {
  const bytes = Uint8Array.from(atob(sealed.data),c=>c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(sealed.iv),additionalData:encoder.encode(id)},await keyFor(secret),bytes);
  return JSON.parse(new TextDecoder().decode(plain));
}
export async function onRequest({request,env}) {
  const reply = (body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  const key = env.RIOT_BENCH_KEY || env.RIOT_PROBE_KEY;
  if (!key || key.length<32 || env.RIOT_PROBE_ENABLED!=='true' || !env.RIOT_PROBE_KEY) return reply({error:'Not found'},404);
  if (request.method!=='POST') return reply({error:'Use POST'},405);
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length>512) return reply({error:'Unauthorized'},401);
  const hashes = await Promise.all([supplied, `Bearer ${key}`].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const [a,b] = hashes.map(h=>new Uint8Array(h));
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  if(diff)return reply({error:'Unauthorized'},401);
  const url = new URL(request.url), op=url.searchParams.get('op'), id=url.searchParams.get('session');
  if (!['start','run','finish'].includes(op)) return reply({error:'Invalid operation'},400);
  if (op!=='start' && !/^[0-9a-f-]{36}$/.test(id || '')) return reply({error:'Invalid session'},400);
  const cache = await caches.open('riot-capacity-encrypted-v1');
  const cacheUrl = sid=>`${url.origin}/_riot-capacity-private/${sid}`;
  const save = async (sid,state)=>cache.put(cacheUrl(sid),Response.json(await seal(state,env.RIOT_PROBE_KEY,sid),
    {headers:{'Cache-Control':`public, max-age=${Math.max(1,Math.ceil((state.expiresAt-Date.now())/1000))}`}}));
  try {
    if (op==='start') {
      if (!env.APP_DB) return reply({error:'Missing cache database'},503);
      const player = await env.APP_DB.prepare("SELECT puuid,region FROM rr_players WHERE region='eu' AND platform='pc' ORDER BY puuid LIMIT 1").first();
      if (!player) return reply({error:'No EU sample'},404);
      const result = await startCapacitySession(env,player);
      if (!result.ok) return reply(result);
      const sid=crypto.randomUUID();
      await save(sid,result.state);
      return reply({ok:true,session:sid,region:'eu',endpoint:'match-details',matchCount:result.state.matchIds.length,
        expiresAt:result.state.expiresAt,colo:request.cf?.colo || 'unknown',setupMetrics:result.setupMetrics});
    }
    if(op==='finish'){await cache.delete(cacheUrl(id));return reply({ok:true});}
    const stored=await cache.match(cacheUrl(id));
    if(!stored)return reply({error:'Session cache unavailable; stop experiment'},409);
    const state=await open(await stored.json(),env.RIOT_PROBE_KEY,id);
    const phase=url.searchParams.get('phase');
    if(!['burst1','burst2','steady'].includes(phase))return reply({error:'Invalid phase'},400);
    const result=await runCapacityFrame(state,phase);
    await save(id,state);
    return reply({...result,session:id,colo:request.cf?.colo || 'unknown'});
  } catch {return reply({error:'Capacity experiment failed; stop'},502);}
}
