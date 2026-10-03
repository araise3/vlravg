// A fresh, versioned snapshot every run; no reusable OFFSET page cache.
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {d1Query} from '../.github/scripts/d1-query.mjs';

export async function exportCorpus(env=process.env,query=d1Query){
  const started=new Date().toISOString();
  const directory=env.CORPUS_OUT||`.local/rr-corpus/snapshots/${started.replace(/[:.]/g,'-')}`;
  await mkdir(directory,{recursive:true});
  let puuid='',matchId='',count=0;
  const lines=[];
  for(;;){
    const rows=await query(env,`SELECT h.puuid,h.match_id,h.data AS rr,f.data AS features,
      previous.data AS previous_rr,p.platform,p.region
      FROM rr_history h LEFT JOIN rr_match_features f ON f.puuid=h.puuid AND f.match_id=h.match_id
      LEFT JOIN rr_predecessors w ON w.puuid=h.puuid AND w.match_id=h.match_id
      LEFT JOIN rr_history previous ON previous.puuid=w.puuid AND previous.match_id=w.previous_match_id
      LEFT JOIN rr_players p ON p.puuid=h.puuid
      WHERE h.puuid>?1 OR (h.puuid=?1 AND h.match_id>?2)
      ORDER BY h.puuid,h.match_id LIMIT 1000`,[puuid,matchId]);
    for(const row of rows)lines.push(JSON.stringify({player:createHash('sha256').update(row.puuid.toLowerCase()).digest('hex'),
      match_id:row.match_id,region:row.region,platform:row.platform,
      rr:JSON.parse(row.rr),previous_rr:row.previous_rr?JSON.parse(row.previous_rr):null,
      features:row.features?JSON.parse(row.features):null}));
    count+=rows.length;
    if(rows.length<1000)break;
    puuid=rows.at(-1).puuid;matchId=rows.at(-1).match_id;
  }
  const bytes=gzipSync(lines.join('\n')+'\n');
  await writeFile(`${directory}/corpus.ndjson.gz`,bytes);
  const metadata={format:1,started,finished:new Date().toISOString(),rows:count,
    sha256:createHash('sha256').update(bytes).digest('hex'),
    identity:'SHA-256 of permanent PUUID; names are not exported',
    consistency:'Keyset pagination of live D1; concurrent corrections/enrolment can occur during export. Snapshot bytes are immutable and checksum identifies the benchmark input.'};
  await writeFile(`${directory}/manifest.json`,JSON.stringify(metadata,null,2));
  console.log(JSON.stringify({directory,...metadata}));
  return {directory,...metadata};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)exportCorpus().catch(e=>{console.error(e.message);process.exitCode=1;});
