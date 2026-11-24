// Read-only export of the existing production D1 corpus for curve research.
// Uses the configured environment token without printing or saving it.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {d1Query,D1_META} from '../.github/scripts/d1-query.mjs';
// Through d1Query, so these reads are paced like every other script's.
const env={CF_API_TOKEN:process.env.CLOUDFLARE_API_TOKEN,CF_ACCOUNT_ID:'93c06b602c99e1f2aff33315515de690',
  CF_D1_DATABASE_ID:'548b9cc8-9d01-4adf-8dbe-24f29f1b2d1b'};
const directory=new URL('../.local/rr-curve-prod/',import.meta.url);
await mkdir(directory,{recursive:true});
const metadata=[];
async function query(sql){
  if(!/^SELECT\b/i.test(sql))throw new Error('This export accepts SELECT statements only');
  const rows=await d1Query(env,sql);
  const meta=rows[D1_META];
  if(meta.rows_written||meta.changed_db||meta.changes)throw new Error('Unexpected database modification');
  metadata.push({sql,meta});
  return rows;
}
const players=await query('SELECT puuid,name,tag,region,platform FROM rr_players ORDER BY puuid');
const byPuuid=new Map(players.map(p=>[p.puuid,p]));
const histories={};let historyCount=0;
for(let offset=0;;offset+=5000){
  const cache=new URL(`rr-${offset}.json`,directory);
  let page;
  try{page=JSON.parse(await readFile(cache,'utf8'));}catch{
    page=await query(`SELECT puuid,data FROM rr_history ORDER BY puuid,match_id LIMIT 5000 OFFSET ${offset}`);
    await writeFile(cache,JSON.stringify(page));
  }
  for(const r of page){
    const p=byPuuid.get(r.puuid);const name=p?.name&&p?.tag?`${p.name}#${p.tag}`:`puuid:${r.puuid}`;
    (histories[name]??={region:p?.region,puuid:r.puuid,history:[]}).history.push(JSON.parse(r.data));
  }
  historyCount+=page.length;
  console.log('RR entries read:',historyCount);
  if(page.length<5000)break;
}
const matches={};let detailCount=0;
for(let offset=0;;offset+=100){
  const cache=new URL(`details-${offset}.json`,directory);
  let page;
  try{page=JSON.parse(await readFile(cache,'utf8'));}catch{
    page=await query(`SELECT a.puuid,a.match_id,hex(a.payload) AS payload FROM match_archive a JOIN rr_history h ON a.puuid=h.puuid AND a.match_id=h.match_id ORDER BY a.puuid,a.match_id LIMIT 100 OFFSET ${offset}`);
    await writeFile(cache,JSON.stringify(page));
  }
  for(const r of page){
    const raw=JSON.parse(gunzipSync(Buffer.from(r.payload,'hex')).toString('utf8'));
    const m=raw.data??raw;
    const me=m.players.find(p=>p.puuid===r.puuid);
    if(!me)continue;
    const t=m.teams.find(t=>t.team_id===me.team_id);
    const rw=t.rounds.won,rl=t.rounds.lost,rounds=rw+rl;
    const party=me.party_id?m.players.filter(p=>p.team_id===me.team_id&&p.party_id===me.party_id).length:1;
    const acs=m.players.map(p=>p.stats.score/Math.max(rounds,1));
    const mean=acs.reduce((a,b)=>a+b,0)/acs.length;
    const sd=Math.sqrt(acs.reduce((sum,v)=>sum+(v-mean)**2,0)/acs.length)||1;
    const p=byPuuid.get(r.puuid);const name=p?.name&&p?.tag?`${p.name}#${p.tag}`:`puuid:${r.puuid}`;
    (matches[name]??=[]).push({mid:r.match_id,won:t.won,rw,rl,rd:rw-rl,draw:rw===rl,party,
      pen:(m.metadata.party_rr_penaltys||[]).find(p=>p.party_id===me.party_id)?.penalty??0,
      my_tier:me.tier.id,acs_z:(me.stats.score/Math.max(rounds,1)-mean)/sd});
  }
  detailCount+=page.length;
  console.log('Joined archived matches read:',detailCount);
  if(page.length<100)break;
}
await writeFile(new URL('production-hist.json',directory),JSON.stringify(histories));
await writeFile(new URL('production-matches.json',directory),JSON.stringify(matches));
await writeFile(new URL('export-metadata.json',directory),JSON.stringify({exportedAt:new Date().toISOString(),historyCount,detailCount,players:players.length,queries:metadata},null,2));
console.log(JSON.stringify({historyCount,detailCount,players:players.length,allQueriesReadOnly:true}));
