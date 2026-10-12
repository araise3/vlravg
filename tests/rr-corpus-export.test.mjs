import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {exportCorpus} from '../scripts/export-rr-corpus.mjs';

test('snapshot export preserves complete reported competitive updates and nullable values',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vlravg-rr-export-'));
  t.after(async()=>{
    await Promise.all(['corpus.ndjson.gz','manifest.json'].map(file=>unlink(join(directory,file))));
    await rmdir(directory);
  });
  const puuid='11111111-1111-4111-8111-111111111111';
  const rr={match_id:'reported-match',last_change:17,tier:{id:22},rr:10,
    tier_before_update:{id:21},rr_before_update:88,rr_performance_bonus:0,rr_penalty:.25,
    afk_penalty:0,new_map_incentive_rr_forgiven:null,is_placement_match:false,
    was_derank_protection_replenished:false,queue_id:'competitive',match_length:2088176,
    competitive_movement:'MOVEMENT_UNKNOWN',season:{id:'act',short:'test'},date:'2026-10-10T00:00:00Z'};
  const result=await exportCorpus({CORPUS_OUT:directory},async()=>[
    {puuid,match_id:rr.match_id,rr:JSON.stringify(rr),features:null,previous_rr:null,platform:'pc',region:'eu'},
  ]);
  const bytes=await readFile(join(directory,'corpus.ndjson.gz'));
  const saved=JSON.parse(gunzipSync(bytes).toString().trim());
  assert.deepEqual(saved.rr,rr);
  assert.equal(saved.previous_rr,null);
  assert.equal(saved.features,null);
  assert.equal(saved.player,createHash('sha256').update(puuid).digest('hex'));
  assert.equal(result.rows,1);
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
});
