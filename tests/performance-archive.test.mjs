import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {matchKey,hasInlinePayload,readArchivedPayload,mapLimit} from '../lib/match-store.mjs';
import {memoryBucket} from './helpers/r2-memory.mjs';

const source=readFileSync(new URL('../functions/api/[[path]].js',import.meta.url),'utf8');
const api=runInNewContext(source.slice(source.indexOf('async function gzipMatch('),source.indexOf('async function readMatchArchiveCounts('))+
  '\n({save:saveMatchArchivePage,read:readMatchArchive,migrate:migrateMatchArchive,gzip:gzipMatch,gunzip:gunzipMatch})',{
  Blob,Response,Headers,CompressionStream,DecompressionStream,TextEncoder,Uint8Array,
  matchKey,hasInlinePayload,readArchivedPayload,mapLimit,
  MATCH_ARCHIVE_PAGE_SIZE:10,MATCH_ARCHIVE_COMPRESSED_BUDGET:512*1024,MATCH_ARCHIVE_JSON_BUDGET:8*1024*1024,
  json:(body,status)=>Response.json(body,{status}),
});
const puuid='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',season='act';
const match=(performance,id='game')=>({metadata:{match_id:id,season:{id:season},started_at:'2026-09-01'},players:[{
  puuid,stats:{kills:20},...(performance===undefined?{}:{performance}),
},{puuid:other,stats:{kills:5}}]});
function fixture(t){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE match_archive (puuid TEXT,season_id TEXT,match_id TEXT,started_at TEXT,payload BLOB NOT NULL,bytes INTEGER,PRIMARY KEY(puuid,match_id))');
  t.after(()=>db.close());
  let writes=0;
  const statement=(sql,args=[])=>({bind(...values){return statement(sql,values);},
    async all(){return{results:db.prepare(sql).all(...args)};},
    async run(){const changes=Number(db.prepare(sql).run(...args).changes);writes+=changes;return{meta:{changes}};},
    execute(){return db.prepare(sql).run(...args);}});
  const bucket=memoryBucket();
  const env={MATCH_BUCKET:bucket,APP_DB:{prepare:sql=>statement(sql),async batch(statements){
    for(const statement of statements){writes+=Number(statement.execute().changes);}
  }}};
  const save=(row,who=puuid)=>api.save(env,JSON.stringify({data:[row]}),who);
  const read=async(who=puuid)=>(await (await api.read(env,who,season,0,10)).json()).data[0];
  return{db,env,bucket,save,read,writes:()=>writes+bucket.stats.puts};
}
const legacyRow=async(f,who,row)=>f.db.prepare('INSERT INTO match_archive (puuid,season_id,match_id,started_at,payload) VALUES (?,?,?,?,?)')
  .run(who,season,row.metadata.match_id,row.metadata.started_at,await api.gzip(row));

test('pre-4.10 archives are marked stale and refreshed scores persist without replacing match stats',async t=>{
  const f=fixture(t);await f.save(match());
  assert.equal((await f.read())._performanceRefreshNeeded,true);
  const fresh=match({score:250});fresh.players[0].stats.kills=99;
  await f.save(fresh);
  const saved=await f.read();
  assert.equal(saved._performanceRefreshNeeded,true,'the other player still has no score');
  assert.equal(saved.players[0].performance.score,250);
  assert.equal(saved.players[0].stats.kills,20);
  const writes=f.writes();await f.save(fresh);await f.save(match());
  assert.equal(f.writes(),writes,'repeat visits and old cache hits must not rewrite or erase scores');
});

test('fresh null PS is marked checked once; a later real zero score can still enrich it',async t=>{
  const f=fixture(t);await f.save(match());await f.save(match(null));
  assert.equal((await f.read()).players[0].performance,null);
  const writes=f.writes();await f.save(match(null));assert.equal(f.writes(),writes);
  await f.save(match({score:0}));await f.save(match({score:999}));
  assert.equal((await f.read()).players[0].performance.score,0);
});

test('a concurrent newer archive update cannot be overwritten by a slower enrichment',async t=>{
  const f=fixture(t);await f.save(match());
  f.bucket.race(async()=>{await f.bucket.put('matches/game.json.gz',await api.gzip(match({score:400})));});
  await f.save(match({score:200}));
  assert.equal((await f.read()).players[0].performance.score,400);
});

test('players who share a match share one stored payload and one D1 index row each',async t=>{
  const f=fixture(t);
  await f.save(match());await f.save(match(),other);
  assert.equal(f.bucket.objects.size,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive').get().n,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive WHERE length(payload)>0').get().n,0,'D1 keeps no payload');
  await f.save(match({score:200}));
  assert.equal((await f.read(other)).players[0].performance.score,200,'enrichment is visible to every player of the match');
});

test('no bucket means no archive write at all, so D1 cannot refill',async t=>{
  const f=fixture(t);delete f.env.MATCH_BUCKET;
  await f.save(match());
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive').get().n,0);
});

test('a visit moves its legacy inline copy to R2 without losing the saved stats',async t=>{
  const f=fixture(t);await legacyRow(f,puuid,match());
  const fresh=match({score:250});fresh.players[0].stats.kills=99;
  await f.save(fresh);
  const row=f.db.prepare('SELECT length(payload) AS inline,bytes FROM match_archive').get();
  assert.equal(row.inline,0);assert.ok(row.bytes>0);
  const saved=await f.read();
  assert.equal(saved.players[0].stats.kills,20);assert.equal(saved.players[0].performance.score,250);
});

test('migration moves inline payloads in rowid batches, merges duplicate copies and is idempotent',async t=>{
  const f=fixture(t);
  await legacyRow(f,puuid,match());                       // no score
  await legacyRow(f,other,match({score:300}));            // same match, has a score
  await legacyRow(f,puuid,match(undefined,'second'));
  const first=await api.migrate(f.env,0,2);
  assert.deepEqual({...first},{moved:2,skipped:0,last:2,done:false});
  const second=await api.migrate(f.env,first.last,2);
  assert.deepEqual({...second},{moved:1,skipped:0,last:3,done:true});
  assert.equal(f.bucket.objects.size,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive WHERE length(payload)>0').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive WHERE bytes>0').get().n,3);
  const page=(await (await api.read(f.env,puuid,season,0,10)).json()).data;
  assert.equal(page.find(m=>m.metadata.match_id==='game').players[0].performance.score,300,'the score from the other copy is kept');
  const again=await api.migrate(f.env,0,10);
  assert.deepEqual({...again},{moved:0,skipped:3,last:3,done:true});
});

test('a migration range stops at its upper rowid bound',async t=>{
  const f=fixture(t);
  for(const id of ['a','b','c'])await legacyRow(f,puuid,match(undefined,id));
  const step=await api.migrate(f.env,0,10,3);
  assert.deepEqual({...step},{moved:2,skipped:0,last:2,done:true});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive WHERE length(payload)>0').get().n,1);
});

test('migration leaves a row alone when a concurrent write already changed it',async t=>{
  const f=fixture(t);await legacyRow(f,puuid,match());
  f.bucket.race(async()=>{f.db.prepare("UPDATE match_archive SET payload=X'01'").run();});
  await api.migrate(f.env,0,10);
  assert.equal(f.db.prepare('SELECT hex(payload) AS h FROM match_archive').get().h,'01');
});
