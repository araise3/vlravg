// Parser job 1 of 3 (holds HENRIK_WORKFLOW_KEY): claim queued replay uploads
// and download them. Writes two artifact folders:
//   <out>/replays/<match>/replay.vrf + <out>/replays/jobs.json  -> parse job
//   <out>/claims/claims.json (claim IDs, byte counts, SHA-256)   -> submit job
// The parse job never sees claim IDs or the key, and the submit job takes the
// source size and hash from claims.json, not from the parser's output.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function fetchJobs({ origin, key, out, decoder = '', fetchImpl = fetch }) {
  const headers = { 'X-Workflow-Key': key };
  // Naming this run's decoder lets the Function retry uploads an older decoder could not read.
  const res = await fetchImpl(`${origin}/api/replays/claim`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decoder }) });
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  const jobs = (await res.json()).data.filter(job => UUID.test(job.match_id) && UUID.test(job.claim));
  await mkdir(`${out}/replays`, { recursive: true });
  await mkdir(`${out}/claims`, { recursive: true });
  const claims = [];
  for (const job of jobs) {
    const dir = `${out}/replays/${job.match_id}`;
    await mkdir(dir, { recursive: true });
    const raw = await fetchImpl(`${origin}/api/replays/raw/${job.match_id}?claim=${job.claim}`, { headers });
    const hash = createHash('sha256');
    let error = null;
    if (!raw.ok || !raw.body) error = 'download_failed';
    else {
      const file = createWriteStream(`${dir}/replay.vrf`);
      await pipeline(Readable.fromWeb(raw.body).on('data', chunk => hash.update(chunk)), file);
      if ((await stat(`${dir}/replay.vrf`)).size !== job.bytes) error = 'download_failed';
    }
    claims.push({ match_id: job.match_id, claim: job.claim, bytes: job.bytes, sha256: error ? null : hash.digest('hex'), error });
  }
  const parseable = claims.filter(c => !c.error).map(({ match_id, bytes, sha256 }) => ({ match_id, bytes, sha256 }));
  await writeFile(`${out}/replays/jobs.json`, JSON.stringify(parseable));
  await writeFile(`${out}/claims/claims.json`, JSON.stringify(claims));
  return claims;
}

if (process.argv[1]?.endsWith('replay-fetch.mjs')) {
  const decoder = (process.env.VRFKIT_REVISION || '') + (process.env.VRFKIT_PATCH_SHA256 ? `+${process.env.VRFKIT_PATCH_SHA256}` : '');
  const claims = await fetchJobs({ origin: process.env.SITE_ORIGIN, key: process.env.HENRIK_WORKFLOW_KEY, out: process.argv[2] || 'replay-work', decoder });
  console.log(`Claimed ${claims.length} replay(s)`);
  // Lets the workflow skip the parse and submit jobs when nothing is queued.
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `count=${claims.length}\n`, { flag: 'a' });
}
