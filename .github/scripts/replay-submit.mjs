// Parser job 3 of 3 (holds HENRIK_WORKFLOW_KEY): validate what the sandboxed
// parse job produced and report it. The parse job processed hostile input, so
// its files are data only: each compact.json is size-capped, parsed and run
// through the strict validator; its source size and hash must equal what the
// fetch job recorded; error codes outside the fixed list become parser_failed.
// The full export tables are never opened here: only their names (an exact
// allowlist) and sizes are checked before they are stored as opaque files.
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { validateCompact, summarizeCompact, COMPACT_MAX_JSON_BYTES } from '../../lib/replay-compact.mjs';
import { EXPORT_FILES, EXPORT_MAX_BYTES } from '../../lib/replay-import.mjs';

const ERRORS = new Set(['decoder_validate_failed', 'decoder_export_failed', 'compact_failed', 'timeout', 'oversize',
  'match_id_mismatch', 'download_failed', 'output_rejected']);
const EXPORT_FILE_MAX_BYTES = 256 * 1024 * 1024;

async function readSmall(path, max) {
  try {
    if ((await stat(path)).size > max) return { oversize: true };
    return { text: await readFile(path, 'utf8') };
  } catch { return null; }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const handle = await open(path);
  try { for await (const chunk of handle.readableWebStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

// [{name, path, bytes, sha256}] or an error code.
async function exportFiles(dir) {
  let names;
  try { names = await readdir(dir); } catch { return 'export_missing'; }
  if (names.some(name => !EXPORT_FILES.includes(name)) || !names.includes('manifest.json') || !names.includes('movement.parquet'))
    return 'export_missing';
  const files = [];
  for (const name of names) {
    const info = await stat(`${dir}/${name}`);
    if (!info.isFile() || info.size < 1) return 'export_missing';
    if (info.size > EXPORT_FILE_MAX_BYTES) return 'oversize';
    files.push({ name, path: `${dir}/${name}`, bytes: info.size, sha256: await sha256File(`${dir}/${name}`) });
  }
  if (files.reduce((sum, file) => sum + file.bytes, 0) > EXPORT_MAX_BYTES) return 'oversize';
  return files;
}

// Returns {ok:true, summary, blob, files} or {ok:false, error}.
export async function prepareResult(claim, dir, decoder = null) {
  if (claim.error) return { ok: false, error: claim.error };
  const compact = await readSmall(`${dir}/compact.json`, COMPACT_MAX_JSON_BYTES);
  if (compact?.oversize) return { ok: false, error: 'oversize' };
  if (!compact) {
    const code = (await readSmall(`${dir}/error.txt`, 64))?.text?.trim();
    return { ok: false, error: ERRORS.has(code) ? code : 'parser_failed' };
  }
  let doc;
  try {
    doc = validateCompact(JSON.parse(compact.text), { matchId: claim.match_id });
  } catch { return { ok: false, error: 'compact_invalid' }; }
  if (doc.source.bytes !== claim.bytes || doc.source.sha256 !== claim.sha256) return { ok: false, error: 'compact_invalid' };
  if (decoder && (doc.decoder.revision !== decoder.revision || doc.decoder.patch !== decoder.patch)) return { ok: false, error: 'compact_invalid' };
  const files = await exportFiles(`${dir}/export`);
  if (typeof files === 'string') return { ok: false, error: files };
  const blob = gzipSync(JSON.stringify(doc), { level: 9 });
  return { ok: true, blob, files, summary: summarizeCompact(doc, { bytes: blob.byteLength, sha256: createHash('sha256').update(blob).digest('hex') }) };
}

async function uploadExport({ origin, key, claim, files, fetchImpl }) {
  const base = `${origin}/api/replays/result/${claim.match_id}/export`;
  const json = res => res.json().catch(() => ({}));
  const start = await fetchImpl(base, { method: 'POST', headers: { 'X-Workflow-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim: claim.claim, files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }) });
  if (start.status !== 201) return `export_http_${start.status}`;
  const { partBytes, files: plan } = (await json(start)).data;
  // Parts upload EXPORT_CONCURRENCY at a time across all files (sequential
  // uploads of a 34 MB export took 39 s); each file completes after its parts.
  const left = new Map(plan.map(({ name, parts }) => [name, parts]));
  const parts = plan.flatMap(({ name, parts }) => Array.from({ length: parts }, (_, i) => ({ name, n: i + 1 })));
  let failure = null;
  await mapLimit(parts, EXPORT_CONCURRENCY, async ({ name, n }) => {
    if (failure) return;
    const file = files.find(f => f.name === name);
    const length = Math.min(partBytes, file.bytes - (n - 1) * partBytes);
    const buffer = Buffer.alloc(length);
    const handle = await open(file.path);
    try { await handle.read(buffer, 0, length, (n - 1) * partBytes); } finally { await handle.close(); }
    const res = await fetchImpl(`${base}/${name}/part/${n}?claim=${claim.claim}`, { method: 'PUT', headers: { 'X-Workflow-Key': key }, body: buffer });
    if (!res.ok) { failure ??= `export_http_${res.status}`; return; }
    left.set(name, left.get(name) - 1);
    if (left.get(name)) return;
    const done = await fetchImpl(`${base}/${name}/complete?claim=${claim.claim}`, { method: 'POST', headers: { 'X-Workflow-Key': key } });
    if (!done.ok) failure ??= `export_http_${done.status}`;
  });
  return failure;
}

const EXPORT_CONCURRENCY = 4;
export async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function submitAll({ origin, key, work, decoder = null, fetchImpl = fetch }) {
  const claims = JSON.parse(await readFile(`${work}/claims/claims.json`, 'utf8'));
  // Written by the trusted toolchain job from the decoder's transform registry.
  let supported = null;
  try { supported = JSON.parse(await readFile(`${work}/decoder/supported-builds.json`, 'utf8')); } catch {}
  const headers = { 'X-Workflow-Key': key, 'Content-Type': 'application/json' };
  const outcomes = [];
  for (const claim of claims) {
    const result = await prepareResult(claim, `${work}/parsed/${claim.match_id}`, decoder);
    const body = result.ok ? { claim: claim.claim, ok: true, summary: result.summary }
      : { claim: claim.claim, ok: false, error: result.error, ...(decoder && { decoder: decoder.revision + (decoder.patch ? `+${decoder.patch}` : '') }),
        ...(Array.isArray(supported) && { supported_builds: supported }) };
    const res = await fetchImpl(`${origin}/api/replays/result/${claim.match_id}`, { method: 'POST', headers, body: JSON.stringify(body) });
    let status = (await res.json().catch(() => ({})))?.data?.status || `http_${res.status}`;
    if (result.ok && status === 'awaiting_compact') {
      // The export goes first: the compact upload is what marks a replay parsed.
      status = await uploadExport({ origin, key, claim, files: result.files, fetchImpl }) || status;
      if (status === 'awaiting_compact') {
        const put = await fetchImpl(`${origin}/api/replays/result/${claim.match_id}/compact?claim=${claim.claim}`, {
          method: 'PUT', headers: { 'X-Workflow-Key': key, 'Content-Type': 'application/gzip' }, body: result.blob });
        status = (await put.json().catch(() => ({})))?.data?.status || `http_${put.status}`;
      }
    }
    outcomes.push({ match_id: claim.match_id, status, error: result.ok ? null : result.error });
  }
  return outcomes;
}

if (process.argv[1]?.endsWith('replay-submit.mjs')) {
  const decoder = process.env.VRFKIT_REVISION ? { revision: process.env.VRFKIT_REVISION, patch: process.env.VRFKIT_PATCH_SHA256 || null } : null;
  const outcomes = await submitAll({ origin: process.env.SITE_ORIGIN, key: process.env.HENRIK_WORKFLOW_KEY, work: process.argv[2] || 'replay-work', decoder });
  for (const o of outcomes) console.log(`${o.match_id} ${o.status}${o.error ? ` (${o.error})` : ''}`);
  if (outcomes.some(o => !['parsed', 'failed', 'rejected'].includes(o.status))) process.exitCode = 1;
}
