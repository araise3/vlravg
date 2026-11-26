// Parser job 3 of 3 (holds HENRIK_WORKFLOW_KEY): validate what the sandboxed
// parse job produced and report it. The parse job processed hostile input, so
// its files are data only: each compact.json is size-capped, parsed and run
// through the strict validator; its source size must equal the claim's and its
// hash the one the parse job computed outside its sandbox while downloading
// (source.json); error codes outside the fixed list become parser_failed.
// The full export tables are never opened here: only their names (an exact
// allowlist) and sizes are checked before they are stored as opaque files.
import { createHash } from 'node:crypto';
import { appendFile, lstat, open, readFile, stat, writeFile } from 'node:fs/promises';
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

// The export's declared files [{name, bytes, sha256}] from the parse job's
// export-files.json (replay-export-list.mjs), validated as untrusted, or an
// error code. The files themselves arrive later (verifyExport).
async function exportList(dir) {
  const listed = await readSmall(`${dir}/export-files.json`, 16 * 1024);
  if (listed?.oversize) return 'export_missing';
  let files;
  try { files = JSON.parse(listed?.text ?? 'null'); } catch { return 'export_missing'; }
  if (!Array.isArray(files)) return 'export_missing';
  const names = new Set();
  for (const file of files) {
    if (!file || Object.keys(file).sort().join() !== 'bytes,name,sha256' || !EXPORT_FILES.includes(file.name) || names.has(file.name)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[0-9a-f]{64}$/.test(file.sha256)) return 'export_missing';
    if (file.bytes > EXPORT_FILE_MAX_BYTES) return 'oversize';
    names.add(file.name);
  }
  if (!names.has('manifest.json') || !names.has('movement.parquet')) return 'export_missing';
  if (files.reduce((sum, file) => sum + file.bytes, 0) > EXPORT_MAX_BYTES) return 'oversize';
  return files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
}

// The declared files with their paths, once each file under `dir` has exactly
// its declared size and SHA-256; otherwise an error code.
export async function verifyExport(files, dir) {
  const out = [];
  for (const file of files) {
    const path = `${dir}/${file.name}`;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size !== file.bytes || await sha256File(path) !== file.sha256) return 'export_mismatch';
    } catch { return 'export_mismatch'; }
    out.push({ ...file, path });
  }
  return out;
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
  // The size the Function declared at claim time, and the hash the parse job
  // computed outside its sandbox while downloading (replay-download.mjs).
  const source = await readSmall(`${dir}/source.json`, 256);
  let sha256 = null;
  try { const s = JSON.parse(source?.text || 'null'); if (s?.bytes === claim.bytes && /^[0-9a-f]{64}$/.test(s.sha256)) sha256 = s.sha256; } catch {}
  if (!sha256 || doc.source.bytes !== claim.bytes || doc.source.sha256 !== sha256) return { ok: false, error: 'compact_invalid' };
  if (decoder && (doc.decoder.revision !== decoder.revision || doc.decoder.patch !== decoder.patch)) return { ok: false, error: 'compact_invalid' };
  const files = await exportList(dir);
  if (typeof files === 'string') return { ok: false, error: files };
  const blob = gzipSync(JSON.stringify(doc), { level: 9 });
  return { ok: true, blob, files, summary: summarizeCompact(doc, { bytes: blob.byteLength, sha256: createHash('sha256').update(blob).digest('hex') }) };
}

// Declares the export (the Function reserves its storage); returns the part
// plan, or an error code.
async function declareExport({ origin, key, claim, files, fetchImpl }) {
  const res = await fetchImpl(`${origin}/api/replays/result/${claim.match_id}/export`, { method: 'POST',
    headers: { 'X-Workflow-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim: claim.claim, files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }) });
  if (res.status !== 201) return `export_http_${res.status}`;
  return (await res.json().catch(() => ({}))).data;
}

async function uploadExport({ origin, key, claim, files, plan: { partBytes, files: plan }, fetchImpl }) {
  const base = `${origin}/api/replays/result/${claim.match_id}/export`;
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

// 4 at a time took 24 s for a 58 MB export (2026-11-26, run 45750830809).
const EXPORT_CONCURRENCY = 8;
export async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// Phase 1: report each result and, for a good one, declare the export and
// store the compact record (which marks the replay parsed). Needs only the
// small `parsed` artifact. Returns the outcomes and the exports still to send.
export async function submitRecords({ origin, key, work, decoder = null, fetchImpl = fetch }) {
  const claims = JSON.parse(await readFile(`${work}/claims/claims.json`, 'utf8'));
  // Written by the trusted toolchain job from the decoder's transform registry.
  let supported = null;
  try { supported = JSON.parse(await readFile(`${work}/decoder/supported-builds.json`, 'utf8')); } catch {}
  const headers = { 'X-Workflow-Key': key, 'Content-Type': 'application/json' };
  const outcomes = [], pending = [];
  for (const claim of claims) {
    const result = await prepareResult(claim, `${work}/parsed/${claim.match_id}`, decoder);
    const body = result.ok ? { claim: claim.claim, ok: true, summary: result.summary }
      : { claim: claim.claim, ok: false, error: result.error, ...(decoder && { decoder: decoder.revision + (decoder.patch ? `+${decoder.patch}` : '') }),
        ...(Array.isArray(supported) && { supported_builds: supported }) };
    const res = await fetchImpl(`${origin}/api/replays/result/${claim.match_id}`, { method: 'POST', headers, body: JSON.stringify(body) });
    let status = (await res.json().catch(() => ({})))?.data?.status || `http_${res.status}`;
    if (result.ok && ['awaiting_compact', 'awaiting_export'].includes(status)) {
      // The export is declared first (its storage reserved), then the compact
      // record is stored, which marks the replay parsed, and the export's parts
      // follow in phase 2 (26 Nov 2026: they were most of the wait). The
      // Function keeps the claim until every export file is complete, and a
      // stale claim is retried; `awaiting_export` is such a retry.
      const plan = await declareExport({ origin, key, claim, files: result.files, fetchImpl });
      if (typeof plan === 'string') status = plan;
      else {
        if (status === 'awaiting_compact') {
          const put = await fetchImpl(`${origin}/api/replays/result/${claim.match_id}/compact?claim=${claim.claim}`, {
            method: 'PUT', headers: { 'X-Workflow-Key': key, 'Content-Type': 'application/gzip' }, body: result.blob });
          status = (await put.json().catch(() => ({})))?.data?.status || `http_${put.status}`;
        } else status = 'parsed';
        if (status === 'parsed') pending.push({ claim, files: result.files, plan });
      }
    }
    // A build the decoder did not know, decoded with a transform solved from
    // this replay. Validated by validateCompact, so safe to print; adding it
    // to parser/transforms.txt saves the next upload the solve.
    const transform = result.ok ? result.summary.decoder.transform : null;
    const solved = transform?.source === 'solved'
      ? `${result.summary.replay.build.replace(/^\+\+Ares-Core\+release-/, '')} ${transform.line}` : null;
    outcomes.push({ match_id: claim.match_id, status, error: result.ok ? null : result.error, ...(solved && { solved }) });
  }
  return { outcomes, pending };
}

// Phase 2: the export files, from the `parsed-export` artifact, each checked
// against what phase 1 declared before any part is sent.
export async function submitExports({ origin, key, work, pending, outcomes, fetchImpl = fetch }) {
  for (const { claim, files, plan } of pending) {
    const outcome = outcomes.find(o => o.match_id === claim.match_id);
    const checked = await verifyExport(files, `${work}/parsed-export/${claim.match_id}/export`);
    const failure = typeof checked === 'string' ? checked : await uploadExport({ origin, key, claim, files: checked, plan, fetchImpl });
    if (failure) outcome.status = `parsed_${failure}`;
  }
  return outcomes;
}

export async function submitAll(options) {
  const { outcomes, pending } = await submitRecords(options);
  return submitExports({ ...options, pending, outcomes });
}

async function finish(outcomes) {
  for (const o of outcomes) console.log(`${o.match_id} ${o.status}${o.error ? ` (${o.error})` : ''}`);
  for (const line of new Set(outcomes.map(o => o.solved).filter(Boolean))) {
    console.log(`::notice title=Payload transform solved from an upload::parser/transforms.txt line: ${line}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `Solved payload transform (add to \`parser/transforms.txt\` after checking it on a second replay):\n\n    ${line}\n`);
    }
  }
  if (outcomes.some(o => !['parsed', 'failed', 'rejected'].includes(o.status))) process.exitCode = 1;
}

// `record` (phase 1) saves what `export` (phase 2) sends, on the runner's disk
// only; the workflow downloads the large export artifact between the two, and
// `export` reports every outcome. Default: both phases in one process.
if (process.argv[1]?.endsWith('replay-submit.mjs')) {
  const work = process.argv[2] || 'replay-work', phase = process.argv[3] || 'all';
  const options = { origin: process.env.SITE_ORIGIN, key: process.env.HENRIK_WORKFLOW_KEY, work };
  const state = `${work}/submit-state.json`;
  if (phase === 'export') {
    await finish(await submitExports({ ...options, ...JSON.parse(await readFile(state, 'utf8')) }));
  } else {
    const decoder = process.env.DECODER_REVISION ? { revision: process.env.DECODER_REVISION, patch: process.env.DECODER_PATCH || null } : null;
    const recorded = await submitRecords({ ...options, decoder });
    if (phase === 'record') {
      await writeFile(state, JSON.stringify(recorded));
      for (const o of recorded.outcomes) console.log(`${o.match_id} ${o.status} (record)`);
    } else await finish(await submitExports({ ...options, ...recorded }));
  }
}
