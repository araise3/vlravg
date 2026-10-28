// Public VALORANT replay import (docs/replay-import.md).
//
// A replay is hostile input. This module only stores it: the browser uploads a
// .vrf in R2 multipart parts, and a sandboxed GitHub Actions job claims, parses
// and reports back through the workflow-key routes below. Nothing here parses
// the replay body beyond its fixed header, and nothing here writes the trusted
// HenrikDev evidence tables. Uploaded data stays in replay_* tables and the
// REPLAY_BUCKET, labelled as user-uploaded.
import { workflowAuthorized } from './workflow-auth.mjs';
import { validateSummary, isCompactError } from './replay-compact.mjs';

export const REPLAY_PART_BYTES = 10 * 1024 * 1024;
export const REPLAY_MIN_BYTES = 1024 * 1024;
export const REPLAY_MAX_BYTES = 150 * 1024 * 1024;
export const REPLAY_MAGIC = 0x43f4efdd;
export const REPLAY_LIMITS = {
  ipUploads: 6, ipBytes: 600 * 1024 * 1024,
  globalUploads: 60, globalBytes: 4 * 1024 * 1024 * 1024,
  storedRawBytes: 8 * 1024 * 1024 * 1024,
  uploadsPerMatch: 4, parseAttempts: 3, claimBatch: 2,
};
const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000;
const CLAIM_STALE_MS = 60 * 60 * 1000;
const STATUS_IDS_MAX = 60;
const COMPACT_MAX_BYTES = 4 * 1024 * 1024;
// The complete vrfkit `export --checkpoints` output, kept for offline research
// (exact line of sight needs full-rate movement, pitch, replicated fields,
// actors and checkpoints). Stored opaque: the Function never parses it, and
// readers must treat it as untrusted parser output.
export const EXPORT_FILES = ['manifest.json', 'movement.parquet', 'fields.parquet', 'actors.parquet', 'events.parquet',
  'net_guids.parquet', 'partials.parquet', 'checkpoint_fields.parquet', 'checkpoint_actors.parquet',
  'checkpoint_net_guids.parquet', 'checkpoint_blocks.parquet', 'checkpoint_guid_entries.parquet',
  'checkpoint_export_groups.parquet', 'checkpoint_export_fields.parquet'];
const EXPORT_FILE_MAX_BYTES = 256 * 1024 * 1024;
export const EXPORT_MAX_BYTES = 512 * 1024 * 1024;
const PARSE_ERRORS = new Set(['decoder_validate_failed', 'decoder_export_failed', 'compact_failed',
  'compact_invalid', 'timeout', 'oversize', 'match_id_mismatch', 'download_failed', 'output_rejected', 'export_missing']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The parser build: vrfkit revision, plus "+<patch SHA-256>" when patched.
const DECODER_ID = /^[0-9a-f]{40}(\+[0-9a-f]{64})?$/;
// Failures that a newer decoder can fix. Their raw files are kept, and the
// next claim from a different decoder build re-queues them.
const DECODER_ERRORS = ['decoder_validate_failed', 'decoder_export_failed'];
export const decoderId = decoder => decoder?.revision + (decoder?.patch ? `+${decoder.patch}` : '');
const ID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const PARSER_WORKFLOW = 'parse-replays.yml';

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
const error = (message, status) => reply({ error: message }, status);
const now = () => new Date().toISOString();
const ago = ms => new Date(Date.now() - ms).toISOString();

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function partCount(bytes) {
  return Math.ceil(bytes / REPLAY_PART_BYTES);
}
export function partLength(declared, partNumber) {
  return partNumber < partCount(declared) ? REPLAY_PART_BYTES : declared - (partNumber - 1) * REPLAY_PART_BYTES;
}

// Unreal's local replay header: magic, then at offset 32 the duration and at
// 44 FriendlyName as a UTF-16 FString. VALORANT writes the match UUID there,
// space-padded. Checked on the first part so a wrong file never fills R2.
export function replayHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 48) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== REPLAY_MAGIC) return null;
  const durationMs = view.getInt32(32, true);
  const units = view.getInt32(44, true);
  if (durationMs <= 0 || units >= 0 || units < -1024) return null;
  const end = 48 + -units * 2;
  if (end > bytes.byteLength) return null;
  try {
    const name = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(48, end)).replace(/\0+$/, '').trim().toLowerCase();
    return UUID.test(name) ? { matchId: name, durationMs } : null;
  } catch { return null; }
}

// The header also names the game build as an FString ("++Ares-Core+release-13.09",
// at byte 708 in every replay checked). Reported as the header's claim only;
// the parser's own reading is what decides support.
const BUILD_MARKER = [...'++Ares-Core+release-'].map(c => c.charCodeAt(0));
export function replayBuild(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.byteLength, 4096) - BUILD_MARKER.length;
  for (let i = 4; i <= end; i++) {
    if (BUILD_MARKER.some((c, k) => bytes[i + k] !== c)) continue;
    const length = view.getInt32(i - 4, true);
    if (length < BUILD_MARKER.length + 2 || length > 64 || i + length > bytes.byteLength) continue;
    const text = String.fromCharCode(...bytes.subarray(i, i + length)).replace(/\0$/, '');
    const m = /^\+\+Ares-Core\+release-(\d{1,2}\.\d{1,2})$/.exec(text);
    if (m) return m[1];
  }
  return null;
}

export function replayConfig(env) {
  const enabled = Boolean(env.APP_DB && env.REPLAY_BUCKET && env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY)
    && env.REPLAY_UPLOADS_DISABLED !== '1';
  return { enabled, turnstileSiteKey: enabled ? env.TURNSTILE_SITE_KEY : null,
    partBytes: REPLAY_PART_BYTES, minBytes: REPLAY_MIN_BYTES, maxBytes: REPLAY_MAX_BYTES };
}

async function verifyTurnstile(env, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch(TURNSTILE_VERIFY, { method: 'POST', body: form });
    return (await res.json())?.success === true;
  } catch { return false; }
}

// Atomic daily budgets. The conditional upsert grants or refuses in one write.
async function reserveQuota(db, day, scope, bytes, maxUploads, maxBytes) {
  const res = await db.prepare(
    'INSERT INTO replay_import_quota (day,scope,uploads,bytes) SELECT ?1,?2,1,?3 WHERE ?3<=?5 '
    + 'ON CONFLICT(day,scope) DO UPDATE SET uploads=uploads+1,bytes=bytes+excluded.bytes '
    + 'WHERE replay_import_quota.uploads+1<=?4 AND replay_import_quota.bytes+excluded.bytes<=?5'
  ).bind(day, scope, bytes, maxUploads, maxBytes).run();
  return res.meta.changes === 1;
}

async function readJson(request, maxBytes) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > maxBytes) return null;
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
  try { return JSON.parse(new TextDecoder().decode(buffer)); } catch { return null; }
}

async function triggerParser(env) {
  if (!env.GITHUB_DISPATCH_TOKEN) return { requested: false };
  const repo = env.GITHUB_REPOSITORY || 'araise3/vlravg';
  // No inputs: the workflow drains the queue, so nothing user-controlled
  // reaches the workflow's expressions.
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${PARSER_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vlravg-replay-import', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_DISPATCH_REF || 'main' }),
  });
  if (!res.ok) console.error('Replay parser dispatch failed', res.status);
  return { requested: true, ok: res.ok };
}

// Live progress lives in one JSON column; every value in it is something the
// pipeline itself reported (header, dispatch, claim, GitHub job times, results).
const setProgress = (db, matchId, path, value) => db.prepare(
  "UPDATE replay_imports SET progress=json_set(COALESCE(progress,'{}'),?2,json(?3)) WHERE match_id=?1"
).bind(matchId, path, JSON.stringify(value)).run();

const RUN_JOBS = ['fetch', 'toolchain', 'parse', 'submit'];
const GITHUB_REFRESH_MS = 15000;
const runUrl = (env, runId) => `https://github.com/${env.GITHUB_REPOSITORY || 'araise3/vlravg'}/actions/runs/${runId}`;

// The parser run's job states from GitHub, cached briefly per row. Needs the
// dispatch token (Actions: read is part of Actions: write).
async function runJobs(env, runId) {
  const repo = env.GITHUB_REPOSITORY || 'araise3/vlravg';
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=20`, {
    headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vlravg-replay-import' },
  });
  if (!res.ok) return null;
  const jobs = (await res.json()).jobs || [];
  return RUN_JOBS.map(name => jobs.find(job => job.name === name)).filter(Boolean).map(job => ({
    name: job.name, status: job.status, conclusion: job.conclusion, started_at: job.started_at, completed_at: job.completed_at,
    ...(job.name === 'toolchain' && job.status === 'completed' && { cached: (job.steps || []).some(s => /^Run git clone/.test(s.name) && s.conclusion === 'skipped') }),
  }));
}

async function archivedPlayers(env, matchId) {
  const row = await env.APP_DB.prepare('SELECT payload FROM match_archive WHERE match_id=?1 LIMIT 1').bind(matchId).first();
  if (!row) return null;
  const stream = new Blob([new Uint8Array(row.payload)]).stream().pipeThrough(new DecompressionStream('gzip'));
  const match = JSON.parse(await new Response(stream).text());
  return (match.players || []).map(p => String(p.puuid || '').toLowerCase()).filter(id => UUID.test(id));
}

function publicRow(row, env) {
  let summary = null, progress = {};
  try { summary = row.summary ? JSON.parse(row.summary) : null; } catch {}
  try { progress = row.progress ? JSON.parse(row.progress) : {}; } catch {}
  return {
    progress: {
      header_build: progress.build ?? null, dispatch: progress.dispatch ?? null,
      claimed_at: row.claimed_at, attempt: row.attempts || null,
      run_url: progress.run_id ? runUrl(env, progress.run_id) : null, jobs: progress.github?.jobs ?? null,
      decoded_at: progress.decoded_at ?? null, supported_builds: progress.supported_builds ?? null,
    },
    status: row.status, uploaded_at: row.uploaded_at, parsed_at: row.parsed_at,
    error: row.status === 'failed' || row.status === 'rejected' ? row.error : null,
    build: summary?.replay?.build ?? null, map_path: summary?.replay?.map_path ?? null,
    duration_ms: summary?.replay?.duration_ms ?? null, players: summary?.players?.length ?? null,
    counts: summary?.counts ?? null, decoder_revision: summary?.decoder?.revision ?? null,
    decoder_patch: summary?.decoder?.patch ?? null,
    compact_bytes: row.status === 'parsed' ? row.compact_bytes : null,
    export_bytes: row.status === 'parsed' ? row.export_bytes : null,
    source: 'user-upload',
  };
}

async function readStatus(env, url) {
  const ids = [...new Set((url.searchParams.get('ids') || '').toLowerCase().split(',').filter(Boolean))];
  if (!ids.length || ids.length > STATUS_IDS_MAX || ids.some(id => !UUID.test(id))) return error('Invalid match IDs', 400);
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const [imports, archived] = await Promise.all([
    env.APP_DB.prepare(`SELECT * FROM replay_imports WHERE match_id IN (${marks})`).bind(...ids).all(),
    env.APP_DB.prepare(`SELECT DISTINCT match_id FROM match_archive WHERE match_id IN (${marks})`).bind(...ids).all(),
  ]);
  const known = new Set((archived.results || []).map(row => row.match_id));
  const rows = new Map((imports.results || []).map(row => [row.match_id, row]));
  const staleBefore = ago(UPLOAD_STALE_MS);
  const active = [...rows.values()].filter(row => row.status === 'pending' || row.status === 'parsing');
  const queue = new Map(), exports = new Map();
  if (active.some(row => row.status === 'pending')) {
    const { results } = await env.APP_DB.prepare("SELECT match_id FROM replay_imports WHERE status='pending' ORDER BY uploaded_at,match_id").all();
    (results || []).forEach((row, i) => queue.set(row.match_id, i + 1));
  }
  const parsing = active.filter(row => row.status === 'parsing').map(row => row.match_id);
  if (parsing.length) {
    const marks = parsing.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await env.APP_DB.prepare(
      `SELECT f.match_id,COUNT(*) AS files,SUM(f.done) AS files_done,SUM(f.bytes) AS bytes,`
      + `SUM(CASE WHEN f.done THEN f.bytes ELSE COALESCE((SELECT SUM(p.bytes) FROM replay_export_parts p WHERE p.match_id=f.match_id AND p.name=f.name),0) END) AS bytes_done `
      + `FROM replay_export_files f WHERE f.match_id IN (${marks}) GROUP BY f.match_id`).bind(...parsing).all();
    for (const row of results || []) exports.set(row.match_id, row);
  }
  if (env.GITHUB_DISPATCH_TOKEN) {
    const fetched = new Map();
    for (const row of active) {
      let progress = {};
      try { progress = JSON.parse(row.progress || '{}'); } catch {}
      if (row.status !== 'parsing' || !progress.run_id) continue;
      if (progress.github && Date.now() - Date.parse(progress.github.fetched_at) < GITHUB_REFRESH_MS) continue;
      if (!fetched.has(progress.run_id)) fetched.set(progress.run_id, await runJobs(env, progress.run_id).catch(() => null));
      const jobs = fetched.get(progress.run_id);
      if (!jobs) continue;
      progress.github = { fetched_at: now(), jobs };
      row.progress = JSON.stringify(progress);
      await setProgress(env.APP_DB, row.match_id, '$.github', progress.github);
    }
  }
  const data = Object.fromEntries(ids.map(id => {
    const row = rows.get(id);
    const out = row ? publicRow(row, env) : { status: 'none' };
    if (row && queue.has(id)) out.progress.queue_position = queue.get(id);
    if (row && exports.has(id)) {
      const e = exports.get(id);
      out.progress.export = { files: e.files, files_done: e.files_done, bytes: e.bytes, bytes_done: e.bytes_done };
    }
    out.eligible = known.has(id);
    out.can_upload = out.eligible && (!row || (row.uploads < REPLAY_LIMITS.uploadsPerMatch
      && (['failed', 'rejected'].includes(row.status) || (row.status === 'uploading' && row.created_at < staleBefore))));
    return [id, out];
  }));
  return reply({ data });
}

// Raw replays plus full exports held in R2; both count against one cap.
async function storedBytes(db) {
  return db.prepare("SELECT COALESCE((SELECT SUM(declared_bytes) FROM replay_imports WHERE raw_key IS NOT NULL AND status<>'rejected'),0)"
    + '+COALESCE((SELECT SUM(bytes) FROM replay_export_files),0) AS bytes').first();
}

async function startUpload(env, request, matchId) {
  const body = await readJson(request, 4096);
  const size = body?.size;
  if (!Number.isSafeInteger(size) || size < REPLAY_MIN_BYTES || size > REPLAY_MAX_BYTES)
    return error(`Replay must be between ${REPLAY_MIN_BYTES / 1048576} and ${REPLAY_MAX_BYTES / 1048576} MB`, 413);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!await verifyTurnstile(env, body.turnstileToken, ip)) return error('Verification failed. Try again.', 403);

  const db = env.APP_DB;
  const existing = await db.prepare('SELECT status,uploads,created_at,upload_id,raw_key FROM replay_imports WHERE match_id=?1').bind(matchId).first();
  const staleBefore = ago(UPLOAD_STALE_MS);
  const reopenable = row => ['failed', 'rejected'].includes(row.status) || (row.status === 'uploading' && row.created_at < staleBefore);
  if (existing && !reopenable(existing)) return error(existing.status === 'uploading' ? 'Another upload for this match is in progress' : 'This match already has a replay', 409);
  if (existing && existing.uploads >= REPLAY_LIMITS.uploadsPerMatch) return error('Upload limit reached for this match', 429);
  if (!await db.prepare('SELECT 1 FROM match_archive WHERE match_id=?1 LIMIT 1').bind(matchId).first())
    return error('Search the player first so this match is in the verified match archive', 404);

  const stored = await storedBytes(db);
  if (stored.bytes + size > REPLAY_LIMITS.storedRawBytes) return error('Replay storage is full for now', 429);
  const day = now().slice(0, 10);
  const ipScope = 'ip:' + await sha256Hex(`vlravg-replay:${day}:${ip || 'unknown'}`);
  if (!await reserveQuota(db, day, ipScope, size, REPLAY_LIMITS.ipUploads, REPLAY_LIMITS.ipBytes))
    return error('Daily upload limit reached for this connection', 429);
  if (!await reserveQuota(db, day, 'global', size, REPLAY_LIMITS.globalUploads, REPLAY_LIMITS.globalBytes))
    return error('Daily replay upload capacity is used up', 429);

  const token = randomToken();
  const rawKey = `raw/${matchId}/${randomToken().slice(0, 16)}.vrf`;
  const upload = await env.REPLAY_BUCKET.createMultipartUpload(rawKey, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { match_id: matchId, source: 'user-upload' },
  });
  const created = now();
  // The conditional upsert is the lock: a concurrent start loses and aborts.
  const res = await db.prepare(
    "INSERT INTO replay_imports (match_id,status,uploads,token_hash,upload_id,raw_key,declared_bytes,created_at) VALUES (?1,'uploading',1,?2,?3,?4,?5,?6) "
    + 'ON CONFLICT(match_id) DO UPDATE SET status=excluded.status,uploads=replay_imports.uploads+1,token_hash=excluded.token_hash,'
    + 'upload_id=excluded.upload_id,raw_key=excluded.raw_key,declared_bytes=excluded.declared_bytes,created_at=excluded.created_at,'
    + 'uploaded_at=NULL,claim_id=NULL,claimed_at=NULL,attempts=0,parsed_at=NULL,error=NULL,summary=NULL,compact_key=NULL,compact_sha256=NULL,compact_bytes=NULL,progress=NULL '
    + "WHERE replay_imports.uploads<?7 AND (replay_imports.status IN ('failed','rejected') OR (replay_imports.status='uploading' AND replay_imports.created_at<?8))"
  ).bind(matchId, await sha256Hex(token), upload.uploadId, rawKey, size, created, REPLAY_LIMITS.uploadsPerMatch, staleBefore).run();
  if (res.meta.changes !== 1) {
    await upload.abort().catch(() => {});
    return error('Another upload for this match is in progress', 409);
  }
  if (existing) {
    await db.prepare('DELETE FROM replay_import_parts WHERE match_id=?1').bind(matchId).run();
    if (existing.status === 'uploading' && existing.upload_id)
      await env.REPLAY_BUCKET.resumeMultipartUpload(existing.raw_key, existing.upload_id).abort().catch(() => {});
    else if (existing.raw_key) await env.REPLAY_BUCKET.delete(existing.raw_key).catch(() => {});
  }
  return reply({ data: { uploadToken: token, partBytes: REPLAY_PART_BYTES, parts: partCount(size) } }, 201);
}

async function ownUpload(env, request, matchId) {
  const token = request.headers.get('X-Upload-Token') || '';
  if (!token || token.length > 128) return null;
  const row = await env.APP_DB.prepare("SELECT * FROM replay_imports WHERE match_id=?1 AND status='uploading'").bind(matchId).first();
  if (!row || row.token_hash !== await sha256Hex(token)) return null;
  return row;
}

async function uploadPart(env, request, matchId, partNumber) {
  const row = await ownUpload(env, request, matchId);
  if (!row) return error('Unknown or expired upload', 404);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount(row.declared_bytes)) return error('Invalid part number', 400);
  const expected = partLength(row.declared_bytes, partNumber);
  if (Number(request.headers.get('Content-Length') || expected) !== expected) return error('Wrong part size', 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== expected) return error('Wrong part size', 400);
  if (partNumber === 1) {
    const header = replayHeader(bytes);
    if (!header) return error('Not a VALORANT replay file', 415);
    if (header.matchId !== matchId) return error('This replay belongs to a different match', 409);
    const build = replayBuild(bytes);
    if (build) await setProgress(env.APP_DB, matchId, '$.build', build);
  }
  const part = await env.REPLAY_BUCKET.resumeMultipartUpload(row.raw_key, row.upload_id).uploadPart(partNumber, bytes);
  await env.APP_DB.prepare('INSERT OR REPLACE INTO replay_import_parts (match_id,part_number,etag,bytes) VALUES (?1,?2,?3,?4)')
    .bind(matchId, partNumber, part.etag, expected).run();
  return reply({ data: { part: partNumber } });
}

async function completeUpload(context, matchId) {
  const { env, request } = context;
  const row = await ownUpload(env, request, matchId);
  if (!row) return error('Unknown or expired upload', 404);
  const { results } = await env.APP_DB.prepare('SELECT part_number,etag,bytes FROM replay_import_parts WHERE match_id=?1 ORDER BY part_number')
    .bind(matchId).all();
  const parts = results || [];
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  if (parts.length !== partCount(row.declared_bytes) || total !== row.declared_bytes || parts.some((part, i) => part.part_number !== i + 1))
    return error('Upload is missing parts', 409);
  await env.REPLAY_BUCKET.resumeMultipartUpload(row.raw_key, row.upload_id)
    .complete(parts.map(part => ({ partNumber: part.part_number, etag: part.etag })));
  const res = await env.APP_DB.prepare("UPDATE replay_imports SET status='pending',uploaded_at=?2,token_hash=NULL,upload_id=NULL WHERE match_id=?1 AND status='uploading' AND upload_id=?3")
    .bind(matchId, now(), row.upload_id).run();
  await env.APP_DB.prepare('DELETE FROM replay_import_parts WHERE match_id=?1').bind(matchId).run();
  if (res.meta.changes !== 1) return error('Upload state changed', 409);
  context.waitUntil?.(triggerParser(env).catch(() => ({ requested: true, ok: false }))
    .then(result => setProgress(env.APP_DB, matchId, '$.dispatch', { ...result, at: now() })).catch(() => {}));
  return reply({ data: { status: 'pending' } });
}

async function abortUpload(env, request, matchId) {
  const row = await ownUpload(env, request, matchId);
  if (!row) return error('Unknown or expired upload', 404);
  await env.REPLAY_BUCKET.resumeMultipartUpload(row.raw_key, row.upload_id).abort().catch(() => {});
  await env.APP_DB.batch([
    env.APP_DB.prepare("UPDATE replay_imports SET status='failed',error='upload_aborted',token_hash=NULL,upload_id=NULL,raw_key=NULL WHERE match_id=?1 AND status='uploading'").bind(matchId),
    env.APP_DB.prepare('DELETE FROM replay_import_parts WHERE match_id=?1').bind(matchId),
  ]);
  return reply({ data: { status: 'failed' } });
}

async function readCompact(env, matchId) {
  const row = await env.APP_DB.prepare("SELECT compact_key FROM replay_imports WHERE match_id=?1 AND status='parsed'").bind(matchId).first();
  const object = row && await env.REPLAY_BUCKET.get(row.compact_key);
  if (!object) return error('No parsed replay for this match', 404);
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=3600',
      'X-Replay-Source': 'user-upload' },
    encodeBody: 'manual',
  });
}

// ── Parser (workflow-key) routes ──────────────────────────────────────────
async function claimJobs(env, request) {
  const db = env.APP_DB;
  const stale = ago(CLAIM_STALE_MS);
  const body = await readJson(request, 1024);
  const decoder = body?.decoder;
  const runId = /^\d{1,20}$/.test(String(body?.run_id ?? '')) ? String(body.run_id) : null;
  if (typeof decoder === 'string' && DECODER_ID.test(decoder)) {
    await db.prepare(`UPDATE replay_imports SET status='pending',error=NULL,attempts=0 WHERE status='failed' AND raw_key IS NOT NULL`
      + ` AND error IN (${DECODER_ERRORS.map(e => `'${e}'`).join(',')}) AND (decoder_id IS NULL OR decoder_id<>?1)`).bind(decoder).run();
  }
  await db.prepare("UPDATE replay_imports SET status='failed',error='parser_attempts_exhausted',claim_id=NULL WHERE status='parsing' AND claimed_at<?1 AND attempts>=?2")
    .bind(stale, REPLAY_LIMITS.parseAttempts).run();
  const { results } = await db.prepare(
    "SELECT match_id,declared_bytes FROM replay_imports WHERE status='pending' OR (status='parsing' AND claimed_at<?1) ORDER BY uploaded_at LIMIT ?2"
  ).bind(stale, REPLAY_LIMITS.claimBatch).all();
  const jobs = [];
  for (const row of results || []) {
    const claim = crypto.randomUUID();
    const res = await db.prepare(
      "UPDATE replay_imports SET status='parsing',claim_id=?2,claimed_at=?3,attempts=attempts+1 WHERE match_id=?1 AND (status='pending' OR (status='parsing' AND claimed_at<?4))"
    ).bind(row.match_id, claim, now(), stale).run();
    if (res.meta.changes === 1) {
      jobs.push({ match_id: row.match_id, claim, bytes: row.declared_bytes });
      await db.prepare("UPDATE replay_imports SET progress=json_remove(json_set(COALESCE(progress,'{}'),'$.run_id',?2),'$.github','$.decoded_at','$.supported_builds') WHERE match_id=?1")
        .bind(row.match_id, runId).run();
    }
  }
  return reply({ data: jobs });
}

async function claimedRow(env, matchId, claim) {
  if (!UUID.test(claim || '')) return null;
  return env.APP_DB.prepare("SELECT * FROM replay_imports WHERE match_id=?1 AND status='parsing' AND claim_id=?2").bind(matchId, claim).first();
}

async function readRaw(env, url, matchId) {
  const row = await claimedRow(env, matchId, url.searchParams.get('claim'));
  const object = row && await env.REPLAY_BUCKET.get(row.raw_key);
  if (!object) return error('Unknown claim', 404);
  return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), 'Cache-Control': 'no-store' } });
}

async function reportResult(env, request, matchId) {
  const body = await readJson(request, 64 * 1024);
  if (!body) return error('Invalid result', 400);
  const row = await claimedRow(env, matchId, body.claim);
  if (!row) return error('Unknown claim', 404);
  const db = env.APP_DB;
  if (body.ok === false) {
    const code = PARSE_ERRORS.has(body.error) ? body.error : 'parser_failed';
    const decoder = typeof body.decoder === 'string' && DECODER_ID.test(body.decoder) ? body.decoder : null;
    await db.prepare("UPDATE replay_imports SET status='failed',error=?3,decoder_id=?4,claim_id=NULL WHERE match_id=?1 AND claim_id=?2")
      .bind(matchId, body.claim, code, decoder).run();
    const builds = body.supported_builds;
    if (Array.isArray(builds) && builds.length <= 64 && builds.every(b => typeof b === 'string' && /^\d{1,2}\.\d{1,2}$/.test(b)))
      await setProgress(db, matchId, '$.supported_builds', builds);
    return reply({ data: { status: 'failed' } });
  }
  let summary;
  try { summary = validateSummary(body.summary, { matchId }); }
  catch (e) { if (!isCompactError(e)) throw e; return error(`Invalid summary: ${e.message}`, 422); }
  const reject = async reason => {
    await db.prepare("UPDATE replay_imports SET status='rejected',error=?3,claim_id=NULL,raw_key=NULL WHERE match_id=?1 AND claim_id=?2")
      .bind(matchId, body.claim, reason).run();
    await env.REPLAY_BUCKET.delete(row.raw_key).catch(() => {});
    return reply({ data: { status: 'rejected', reason } });
  };
  if (summary.source.bytes !== row.declared_bytes) return reject('size_mismatch');
  // Every player HenrikDev reports for this match must appear in the replay.
  const trusted = await archivedPlayers(env, matchId);
  const subjects = new Set(summary.players.map(p => p.subject));
  if (!trusted?.length || trusted.some(id => !subjects.has(id))) return reject('players_mismatch');
  await db.prepare("UPDATE replay_imports SET summary=?3,compact_sha256=?4,compact_bytes=?5,decoder_id=?6 WHERE match_id=?1 AND claim_id=?2")
    .bind(matchId, body.claim, JSON.stringify(summary), summary.compact.sha256, summary.compact.bytes, decoderId(summary.decoder)).run();
  await setProgress(db, matchId, '$.decoded_at', now());
  return reply({ data: { status: 'awaiting_compact' } });
}

async function storeCompact(env, request, url, matchId) {
  const row = await claimedRow(env, matchId, url.searchParams.get('claim'));
  if (!row?.compact_sha256) return error('Unknown claim', 404);
  if (Number(request.headers.get('Content-Length') || 0) > COMPACT_MAX_BYTES) return error('Compact replay too large', 413);
  const exported = await env.APP_DB.prepare('SELECT COUNT(*) AS files,COALESCE(SUM(done),0) AS done,COALESCE(SUM(bytes),0) AS bytes FROM replay_export_files WHERE match_id=?1 AND claim_id=?2')
    .bind(matchId, row.claim_id).first();
  if (!exported.files || exported.done !== exported.files) return error('Full export is missing or incomplete', 409);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== row.compact_bytes || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return error('Compact replay must be the reported gzip blob', 422);
  if (await sha256Hex(bytes) !== row.compact_sha256) return error('Compact replay hash mismatch', 422);
  const key = `compact/${matchId}.json.gz`;
  await env.REPLAY_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: { match_id: matchId, source: 'user-upload', sha256: row.compact_sha256 },
  });
  await env.APP_DB.prepare("UPDATE replay_imports SET status='parsed',parsed_at=?3,compact_key=?4,export_bytes=?5,claim_id=NULL,error=NULL WHERE match_id=?1 AND claim_id=?2")
    .bind(matchId, url.searchParams.get('claim'), now(), key, exported.bytes).run();
  return reply({ data: { status: 'parsed' } });
}

// Export upload: declare the file list, then 10 MiB multipart parts per file.
async function startExport(env, request, matchId) {
  const body = await readJson(request, 16 * 1024);
  const row = body && await claimedRow(env, matchId, body.claim);
  if (!row?.compact_sha256) return error('Unknown claim', 404);
  const files = Array.isArray(body.files) ? body.files : [];
  const names = new Set();
  for (const file of files) {
    if (!file || Object.keys(file).sort().join() !== 'bytes,name,sha256' || !EXPORT_FILES.includes(file.name) || names.has(file.name)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > EXPORT_FILE_MAX_BYTES || !/^[0-9a-f]{64}$/.test(file.sha256))
      return error('Invalid export file list', 422);
    names.add(file.name);
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!names.has('manifest.json') || !names.has('movement.parquet') || total > EXPORT_MAX_BYTES) return error('Invalid export file list', 422);
  const db = env.APP_DB;
  // A retried claim replaces the earlier attempt's declarations.
  const { results: old } = await db.prepare('SELECT upload_id,object_key,done FROM replay_export_files WHERE match_id=?1').bind(matchId).all();
  for (const file of old || []) if (!file.done) await env.REPLAY_BUCKET.resumeMultipartUpload(file.object_key, file.upload_id).abort().catch(() => {});
  await db.batch([db.prepare('DELETE FROM replay_export_files WHERE match_id=?1').bind(matchId),
    db.prepare('DELETE FROM replay_export_parts WHERE match_id=?1').bind(matchId)]);
  if ((await storedBytes(db)).bytes + total > REPLAY_LIMITS.storedRawBytes) return error('Replay storage is full for now', 507);
  const out = [];
  for (const file of files) {
    const key = `export/${matchId}/${file.name}`;
    const upload = await env.REPLAY_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: file.name.endsWith('.json') ? 'application/json' : 'application/vnd.apache.parquet' },
      customMetadata: { match_id: matchId, source: 'user-upload', sha256: file.sha256 },
    });
    await db.prepare('INSERT INTO replay_export_files (match_id,name,claim_id,bytes,sha256,upload_id,object_key,done) VALUES (?1,?2,?3,?4,?5,?6,?7,0)')
      .bind(matchId, file.name, row.claim_id, file.bytes, file.sha256, upload.uploadId, key).run();
    out.push({ name: file.name, parts: partCount(file.bytes) });
  }
  return reply({ data: { partBytes: REPLAY_PART_BYTES, files: out } }, 201);
}

async function exportFile(env, url, matchId, name) {
  const row = await claimedRow(env, matchId, url.searchParams.get('claim'));
  if (!row || !EXPORT_FILES.includes(name)) return null;
  return env.APP_DB.prepare('SELECT * FROM replay_export_files WHERE match_id=?1 AND name=?2 AND claim_id=?3 AND done=0')
    .bind(matchId, name, row.claim_id).first();
}

async function exportPart(env, request, url, matchId, name, partNumber) {
  const file = await exportFile(env, url, matchId, name);
  if (!file) return error('Unknown export file', 404);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount(file.bytes)) return error('Invalid part number', 400);
  const expected = partLength(file.bytes, partNumber);
  if (Number(request.headers.get('Content-Length') || expected) !== expected) return error('Wrong part size', 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== expected) return error('Wrong part size', 400);
  const part = await env.REPLAY_BUCKET.resumeMultipartUpload(file.object_key, file.upload_id).uploadPart(partNumber, bytes);
  await env.APP_DB.prepare('INSERT OR REPLACE INTO replay_export_parts (match_id,name,part_number,etag,bytes) VALUES (?1,?2,?3,?4,?5)')
    .bind(matchId, name, partNumber, part.etag, expected).run();
  return reply({ data: { part: partNumber } });
}

async function completeExportFile(env, url, matchId, name) {
  const file = await exportFile(env, url, matchId, name);
  if (!file) return error('Unknown export file', 404);
  const { results } = await env.APP_DB.prepare('SELECT part_number,etag,bytes FROM replay_export_parts WHERE match_id=?1 AND name=?2 ORDER BY part_number')
    .bind(matchId, name).all();
  const parts = results || [];
  if (parts.length !== partCount(file.bytes) || parts.reduce((s, p) => s + p.bytes, 0) !== file.bytes || parts.some((p, i) => p.part_number !== i + 1))
    return error('Export file is missing parts', 409);
  await env.REPLAY_BUCKET.resumeMultipartUpload(file.object_key, file.upload_id)
    .complete(parts.map(p => ({ partNumber: p.part_number, etag: p.etag })));
  await env.APP_DB.batch([
    env.APP_DB.prepare('UPDATE replay_export_files SET done=1,upload_id=NULL WHERE match_id=?1 AND name=?2').bind(matchId, name),
    env.APP_DB.prepare('DELETE FROM replay_export_parts WHERE match_id=?1 AND name=?2').bind(matchId, name),
  ]);
  return reply({ data: { name, stored: true } });
}

const PUBLIC_ROUTES = [
  ['GET', /^\/status$/, ({ env, url }) => readStatus(env, url)],
  ['GET', new RegExp(`^/compact/${ID}$`), ({ env }, id) => readCompact(env, id)],
  ['POST', new RegExp(`^/upload/${ID}$`), ({ env, request }, id) => startUpload(env, request, id), true],
  ['PUT', new RegExp(`^/upload/${ID}/part/(\\d{1,3})$`), ({ env, request }, id, n) => uploadPart(env, request, id, Number(n)), true],
  ['POST', new RegExp(`^/upload/${ID}/complete$`), (context, id) => completeUpload(context, id), true],
  ['POST', new RegExp(`^/upload/${ID}/abort$`), ({ env, request }, id) => abortUpload(env, request, id), true],
];
const PARSER_ROUTES = [
  ['POST', /^\/claim$/, ({ env, request }) => claimJobs(env, request)],
  ['GET', new RegExp(`^/raw/${ID}$`), ({ env, url }, id) => readRaw(env, url, id)],
  ['POST', new RegExp(`^/result/${ID}$`), ({ env, request }, id) => reportResult(env, request, id)],
  ['PUT', new RegExp(`^/result/${ID}/compact$`), ({ env, request, url }, id) => storeCompact(env, request, url, id)],
  ['POST', new RegExp(`^/result/${ID}/export$`), ({ env, request }, id) => startExport(env, request, id)],
  ['PUT', new RegExp(`^/result/${ID}/export/([a-z_]+\\.(?:parquet|json))/part/(\\d{1,3})$`), ({ env, request, url }, id, name, n) => exportPart(env, request, url, id, name, Number(n))],
  ['POST', new RegExp(`^/result/${ID}/export/([a-z_]+\\.(?:parquet|json))/complete$`), ({ env, url }, id, name) => completeExportFile(env, url, id, name)],
];

// path is the part after /api/replays.
export async function handleReplayRequest(context, path) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (path === '/config' && request.method === 'GET') return reply({ data: replayConfig(env) });
  const find = routes => {
    for (const [method, pattern, handler, upload] of routes) {
      const m = path.match(pattern);
      if (m) return { method, handler, upload, args: m.slice(1).map(v => v.toLowerCase()) };
    }
    return null;
  };
  const parser = find(PARSER_ROUTES);
  const route = parser || find(PUBLIC_ROUTES);
  if (!route) return error('Unknown route', 404);
  if (route.method !== request.method) return error('Method not allowed', 405);
  if (parser) {
    if (!env.HENRIK_WORKFLOW_KEY) return error('Replay parser routes are not configured', 503);
    if (!await workflowAuthorized(request, env.HENRIK_WORKFLOW_KEY)) return error('Unauthorized workflow request', 401);
  }
  if (!env.APP_DB || !env.REPLAY_BUCKET) return error('Replay storage is not configured', 503);
  if (route.upload && !replayConfig(env).enabled) return error('Replay uploads are disabled', 503);
  try {
    return await route.handler({ ...context, url }, ...route.args);
  } catch (e) {
    console.error('Replay import failed', e?.message);
    return error('Replay storage unavailable', 503);
  }
}
