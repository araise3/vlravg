// Parser job 1 of 3 (holds HENRIK_WORKFLOW_KEY): claim queued replay uploads.
// Writes <out>/claims/claims.json (claim IDs and byte counts) for the submit
// job, and the job output `jobs` (match IDs and byte counts only) for the parse
// job. The parse job downloads the files itself with its GitHub OIDC token
// (replay-download.mjs), so no replay passes through artifact storage, and it
// never sees claim IDs or the key.
import { mkdir, writeFile } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function fetchJobs({ origin, key, out, decoder = '', runId = '', fetchImpl = fetch }) {
  // Naming this run's decoder lets the Function retry uploads an older decoder
  // could not read; the run ID is what the parse job's token must match.
  const res = await fetchImpl(`${origin}/api/replays/claim`, { method: 'POST',
    headers: { 'X-Workflow-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ decoder, run_id: runId }) });
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  const claims = (await res.json()).data
    .filter(job => UUID.test(job.match_id) && UUID.test(job.claim) && Number.isSafeInteger(job.bytes) && job.bytes > 0)
    .map(({ match_id, claim, bytes }) => ({ match_id, claim, bytes }));
  await mkdir(`${out}/claims`, { recursive: true });
  await writeFile(`${out}/claims/claims.json`, JSON.stringify(claims));
  return claims;
}

// What the parse job may know: no claim IDs.
export const parseJobs = claims => claims.map(({ match_id, bytes }) => ({ match_id, bytes }));

if (process.argv[1]?.endsWith('replay-fetch.mjs')) {
  const decoder = (process.env.DECODER_REVISION || '') + (process.env.DECODER_PATCH ? `+${process.env.DECODER_PATCH}` : '');
  const claims = await fetchJobs({ origin: process.env.SITE_ORIGIN, key: process.env.HENRIK_WORKFLOW_KEY, out: process.argv[2] || 'replay-work', decoder,
    runId: process.env.GITHUB_RUN_ID || '' });
  console.log(`Claimed ${claims.length} replay(s)`);
  // `count` lets the workflow skip the parse and submit jobs when nothing is queued.
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `count=${claims.length}\njobs=${JSON.stringify(parseJobs(claims))}\n`, { flag: 'a' });
  }
}
