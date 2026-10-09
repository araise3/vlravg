import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';

const source=readFileSync(new URL('../functions/api/[[path]].js',import.meta.url),'utf8');
const api=runInNewContext(source.slice(source.indexOf('async function gzipMatch('),source.indexOf('async function readMatchArchiveCounts('))+
  '\n({save:saveMatchArchivePage,read:readMatchArchive,gzip:gzipMatch,gunzip:gunzipMatch})',{
  Blob,Response,CompressionStream,DecompressionStream,TextEncoder,Uint8Array,
  MATCH_ARCHIVE_PAGE_SIZE:10,MATCH_ARCHIVE_COMPRESSED_BUDGET:512*1024,MATCH_ARCHIVE_JSON_BUDGET:8*1024*1024,
  json:(body,status)=>Response.json(body,{status}),
});
const puuid='11111111-1111-4111-8111-111111111111',season='act';
const match=performance=>({metadata:{match_id:'game',season:{id:season},started_at:'2026-09-01'},players:[{
  puuid,stats:{kills:20},...(performance===undefined?{}:{performance}),
}]});
function fixture(t){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE match_archive (puuid TEXT,season_id TEXT,match_id TEXT,started_at TEXT,payload BLOB,PRIMARY KEY(puuid,match_id))');
  t.after(()=>db.close());
  const statement=(sql,args=[])=>({bind(...values){return statement(sql,values);},
    async all(){return{results:db.prepare(sql).all(...args)};},
    execute(){return db.prepare(sql).run(...args);}});
  let writes=0,beforeBatch=null;
  const env={APP_DB:{prepare:sql=>statement(sql),async batch(statements){
    if(beforeBatch){await beforeBatch();beforeBatch=null;}
    for(const statement of statements){writes+=Number(statement.execute().changes);}
  }}};
  return{db,env,save:row=>api.save(env,JSON.stringify({data:[row]}),puuid),
    read:async()=>(await (await api.read(env,puuid,season,0,10)).json()).data[0],
    writes:()=>writes,race:fn=>{beforeBatch=fn;}};
}

test('pre-4.10 archives are marked stale and refreshed scores persist without replacing match stats',async t=>{
  const f=fixture(t);await f.save(match());
  assert.equal((await f.read())._performanceRefreshNeeded,true);
  const fresh=match({score:250});fresh.players[0].stats.kills=99;
  await f.save(fresh);
  const saved=await f.read();
  assert.equal(saved._performanceRefreshNeeded,false);
  assert.equal(saved.players[0].performance.score,250);
  assert.equal(saved.players[0].stats.kills,20);
  const writes=f.writes();await f.save(fresh);await f.save(match());
  assert.equal(f.writes(),writes,'repeat visits and old cache hits must not rewrite or erase scores');
});

test('fresh null PS is marked checked once; a later real zero score can still enrich it',async t=>{
  const f=fixture(t);await f.save(match());await f.save(match(null));
  assert.equal((await f.read())._performanceRefreshNeeded,false);
  const writes=f.writes();await f.save(match(null));assert.equal(f.writes(),writes);
  await f.save(match({score:0}));await f.save(match({score:999}));
  assert.equal((await f.read()).players[0].performance.score,0);
});

test('a concurrent newer archive update cannot be overwritten by a slower enrichment',async t=>{
  const f=fixture(t);await f.save(match());
  f.race(async()=>{
    const payload=await api.gzip(match({score:400}));
    f.db.prepare('UPDATE match_archive SET payload=?').run(payload);
  });
  await f.save(match({score:200}));
  assert.equal((await f.read()).players[0].performance.score,400);
});

test('refreshing one player never touches another player archive',async t=>{
  const f=fixture(t),other='22222222-2222-4222-8222-222222222222';
  await f.save(match());
  await api.save(f.env,JSON.stringify({data:[{...match(),players:[{puuid:other}]}]}),other);
  await f.save(match({score:200}));
  const saved=await api.gunzip(f.db.prepare('SELECT payload FROM match_archive WHERE puuid=?').get(other).payload);
  assert.equal(Object.hasOwn(saved.players[0],'performance'),false);
});
