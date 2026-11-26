// Parser job 2 of 3, before the sandbox: download the claimed replays. The
// parse job holds no secrets; it asks GitHub for an OIDC token naming this
// run's parse job (permissions: id-token: write) and the Function serves each
// file the run claimed once (lib/actions-oidc.mjs, readRawOnce). Writes
//   <out>/replays/<match>/replay.vrf and <out>/replays/jobs.json  -> sandbox
//   <out>/parsed/<match>/source.json {bytes, sha256}, or error.txt -> submit
// source.json is written here, outside the sandbox; the sandbox's output is
// unpacked through an allowlist that does not include it.
//
// Usage: node replay-download.mjs <work dir>   (env JOBS, SITE_ORIGIN)
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AUDIENCE = 'vlravg-replay-raw';

export async function actionsToken({ url, token, fetchImpl = fetch }) {
  if (!url || !token) throw new Error('no OIDC token: the job needs permissions: id-token: write');
  const res = await fetchImpl(`${url}&audience=${AUDIENCE}`, { headers: { Authorization: `bearer ${token}` } });
  if (!res.ok) throw new Error(`OIDC token request failed: ${res.status}`);
  return (await res.json()).value;
}

export async function downloadJobs({ origin, jobs, out, idToken, fetchImpl = fetch }) {
  const ready = [];
  await Promise.all(jobs.filter(job => UUID.test(job.match_id) && Number.isSafeInteger(job.bytes) && job.bytes > 0).map(async job => {
    const dir = `${out}/replays/${job.match_id}`, parsed = `${out}/parsed/${job.match_id}`;
    await mkdir(dir, { recursive: true });
    await mkdir(parsed, { recursive: true });
    const hash = createHash('sha256');
    let ok = false;
    try {
      const res = await fetchImpl(`${origin}/api/replays/raw-once/${job.match_id}`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok && res.body) {
        await pipeline(Readable.fromWeb(res.body).on('data', chunk => hash.update(chunk)), createWriteStream(`${dir}/replay.vrf`));
        ok = (await stat(`${dir}/replay.vrf`)).size === job.bytes;
      }
    } catch {}
    if (!ok) { await writeFile(`${parsed}/error.txt`, 'download_failed\n'); return; }
    const sha256 = hash.digest('hex');
    await writeFile(`${parsed}/source.json`, JSON.stringify({ bytes: job.bytes, sha256 }));
    ready.push({ match_id: job.match_id, bytes: job.bytes, sha256 });
  }));
  await writeFile(`${out}/replays/jobs.json`, JSON.stringify(ready));
  return ready;
}

if (process.argv[1]?.endsWith('replay-download.mjs')) {
  const out = process.argv[2] || 'replay-work';
  const jobs = JSON.parse(process.env.JOBS || '[]');
  await mkdir(`${out}/replays`, { recursive: true });
  const idToken = await actionsToken({ url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN });
  const ready = await downloadJobs({ origin: process.env.SITE_ORIGIN, jobs, out, idToken });
  console.log(`Downloaded ${ready.length} of ${jobs.length} replay(s)`);
}
