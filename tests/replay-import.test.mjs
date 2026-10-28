import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/replays/[[path]].js';
import { REPLAY_LIMITS, REPLAY_PART_BYTES, replayHeader, replayBuild } from '../lib/replay-import.mjs';
import { validateCompact, validateSummary, summarizeCompact, decodeTrack } from '../lib/replay-compact.mjs';

const matchId = 'a27d4487-c781-4b73-8a9e-f4a468139bba';
const otherMatch = 'bd2ea657-0865-4cd7-934c-f6478cd43a64';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const players = Array.from({ length: 10 }, (_, n) => id(n + 1));
const workflowKey = 'workflow-test-key';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gzip = async text => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

// A header shaped like a real .vrf: magic, duration at 32, the match UUID as a
// space-padded UTF-16 FString at 44. The rest is filler.
function replayBytes(size, embedded = matchId) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43f4efdd, true);
  view.setInt32(32, 1784630, true);
  view.setInt32(44, -257, true);
  const name = embedded.padEnd(256, ' ') + '\0';
  for (let i = 0; i < name.length; i++) view.setUint16(48 + i * 2, name.charCodeAt(i), true);
  // Build FString as VALORANT writes it: length at 704, text at 708.
  view.setInt32(704, 26, true);
  [...'++Ares-Core+release-13.09\0'].forEach((c, i) => { bytes[708 + i] = c.charCodeAt(0); });
  for (let i = 1000; i < size; i += 4096) bytes[i] = i % 251;
  return bytes;
}

function bucket() {
  const objects = new Map(), uploads = new Map();
  const r2 = {
    objects, uploads,
    async createMultipartUpload(key) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return r2.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        uploadId, key,
        async uploadPart(n, bytes) { uploads.get(uploadId).parts.set(n, new Uint8Array(bytes)); return { partNumber: n, etag: `etag-${n}` }; },
        async complete(parts) {
          const upload = uploads.get(uploadId);
          const chunks = parts.map(p => upload.parts.get(p.partNumber));
          const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
          let at = 0; for (const c of chunks) { out.set(c, at); at += c.byteLength; }
          objects.set(key, out); uploads.delete(uploadId);
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
    async get(key) { const d = objects.get(key); return d ? { body: new Blob([d]).stream(), size: d.byteLength } : null; },
    async put(key, data) { objects.set(key, new Uint8Array(data)); },
    async delete(key) { objects.delete(key); },
  };
  return r2;
}

let githubJobs = [];
async function fixture(t, { archive = true, env: extra = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind(...values) { return statement(sql, values); },
    async first() { return db.prepare(sql).get(...args) || null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    execute() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  });
  const binding = { prepare: sql => statement(sql), async batch(list) {
    db.exec('BEGIN');
    try { const r = list.map(s => s.execute()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
  if (archive) {
    const payload = await gzip(JSON.stringify({ metadata: { match_id: matchId }, players: players.map(puuid => ({ puuid })) }));
    db.prepare('INSERT INTO match_archive (puuid,season_id,match_id,started_at,payload) VALUES (?,?,?,?,?)')
      .run(players[0], id(99), matchId, '2026-10-15T18:00:00Z', payload);
  }
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (address, init = {}) => {
    calls.push({ address: String(address), init });
    if (String(address).includes('turnstile')) return Response.json({ success: init.body.get('response') === 'ok' });
    if (String(address).includes('/actions/runs/')) return Response.json({ jobs: githubJobs });
    if (String(address).startsWith('https://api.github.com/')) return new Response(null, { status: 204 });
    throw new Error('Unexpected fetch ' + address);
  };
  t.after(() => { globalThis.fetch = savedFetch; db.close(); });
  const r2 = bucket();
  const env = { APP_DB: binding, REPLAY_BUCKET: r2, TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET: 'secret',
    HENRIK_WORKFLOW_KEY: workflowKey, GITHUB_DISPATCH_TOKEN: 'gh-token', ...extra };
  const jobs = [];
  const call = async (method, path, { body, headers = {}, workflow = false, ip = '203.0.113.7' } = {}) => {
    const h = new Headers({ 'CF-Connecting-IP': ip, ...headers });
    if (workflow) h.set('X-Workflow-Key', workflowKey);
    let payload = body;
    if (body && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h.set('Content-Type', 'application/json'); }
    if (payload !== undefined) h.set('Content-Length', String(payload.byteLength ?? new TextEncoder().encode(payload).byteLength));
    const request = new Request('https://vlravg.test/api/replays' + path, { method, headers: h, body: payload });
    const response = await onRequest({ request, env, waitUntil: p => jobs.push(p) });
    await Promise.all(jobs.splice(0));
    const text = await response.clone().text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, response };
  };
  return { db, r2, env, calls, call };
}

async function upload(f, bytes, { token = 'ok' } = {}) {
  const start = await f.call('POST', `/upload/${matchId}`, { body: { size: bytes.byteLength, turnstileToken: token } });
  if (start.status !== 201) return { start };
  const { uploadToken, parts } = start.json.data;
  const results = [];
  for (let n = 1; n <= parts; n++) {
    results.push(await f.call('PUT', `/upload/${matchId}/part/${n}`, {
      body: bytes.subarray((n - 1) * REPLAY_PART_BYTES, n * REPLAY_PART_BYTES), headers: { 'X-Upload-Token': uploadToken } }));
  }
  const complete = await f.call('POST', `/upload/${matchId}/complete`, { headers: { 'X-Upload-Token': uploadToken } });
  return { start, results, complete, uploadToken };
}

function compactDoc(bytes, subjects = players) {
  return {
    format: 'vlravg.replay-compact', version: 1, match_id: matchId,
    source: { bytes: bytes.byteLength, sha256: sha(bytes) },
    decoder: { name: 'vrfkit', revision: 'b9496df61c40fa304d4f539689c1dd627804946e', patch: null },
    replay: { build: '++Ares-Core+release-13.08', map_path: '/Game/Maps/Duality/Duality', duration_ms: 1784630, recorded_ticks: '639275987627950000' },
    quality: { content_blocks_lost: 0, movement_rows: 10, event_rows: 3, malformed_packets: 0, transform_failures: 0 },
    players: subjects.map(subject => ({ subject, character_id: null })),
    events: { rounds: [[63, 0]], kills: [[58030, 0, 6]], plants: [75330], defuses: [], detonations: [], ultimates: [[316076, 0]], switch_teams: [] },
    movement: { interval_ms: 250, encoding: 'delta-v1', tracks: [{ player: 0, samples: [2, 15100, -700, 200, 180, 1, 5, 0, 0, -10] }] },
  };
}

// A small full export: one multipart table plus the required files.
const exportFiles = () => ({
  'manifest.json': new TextEncoder().encode('{"friendly_name":"x"}'),
  'movement.parquet': new Uint8Array(REPLAY_PART_BYTES + 77).fill(7),
  'events.parquet': new Uint8Array(300).fill(3),
});

async function uploadExport(f, job, files = exportFiles()) {
  const list = Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: sha(bytes) }));
  const start = await f.call('POST', `/result/${matchId}/export`, { body: { claim: job.claim, files: list }, workflow: true });
  if (start.status !== 201) return start;
  for (const { name, parts } of start.json.data.files) {
    for (let n = 1; n <= parts; n++) {
      await f.call('PUT', `/result/${matchId}/export/${name}/part/${n}?claim=${job.claim}`, { workflow: true,
        body: files[name].subarray((n - 1) * REPLAY_PART_BYTES, n * REPLAY_PART_BYTES) });
    }
    await f.call('POST', `/result/${matchId}/export/${name}/complete?claim=${job.claim}`, { workflow: true });
  }
  return start;
}

async function submit(f, job, compact, { withExport = true } = {}) {
  const blob = await gzip(JSON.stringify(validateCompact(compact, { matchId })));
  const summary = summarizeCompact(compact, { bytes: blob.byteLength, sha256: sha(blob) });
  const result = await f.call('POST', `/result/${matchId}`, { body: { claim: job.claim, ok: true, summary }, workflow: true });
  const accepted = result.json?.data?.status === 'awaiting_compact';
  if (accepted && withExport) await uploadExport(f, job);
  const stored = accepted ? await f.call('PUT', `/result/${matchId}/compact?claim=${job.claim}`, { body: blob, workflow: true }) : null;
  return { result, stored, blob };
}

test('replay header reads the embedded match UUID and rejects other files', () => {
  assert.deepEqual(replayHeader(replayBytes(2048)), { matchId, durationMs: 1784630 });
  assert.equal(replayHeader(new Uint8Array(2048)), null);
  assert.equal(replayHeader(replayBytes(2048).subarray(0, 100)), null);
});

test('config is disabled until R2, D1 and Turnstile are bound', async t => {
  const f = await fixture(t, { env: { TURNSTILE_SECRET: undefined } });
  assert.equal((await f.call('GET', '/config')).json.data.enabled, false);
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size: 2 ** 21, turnstileToken: 'ok' } })).status, 503);
  f.env.TURNSTILE_SECRET = 'secret';
  assert.deepEqual((await f.call('GET', '/config')).json.data,
    { enabled: true, turnstileSiteKey: 'site', partBytes: REPLAY_PART_BYTES, minBytes: 1048576, maxBytes: 157286400 });
  f.env.REPLAY_UPLOADS_DISABLED = '1';
  assert.equal((await f.call('GET', '/config')).json.data.enabled, false);
});

test('upload, claim, parse report and compact storage work end to end', async t => {
  const f = await fixture(t);
  const bytes = replayBytes(REPLAY_PART_BYTES + 3 * 1024 * 1024);
  let status = await f.call('GET', `/status?ids=${matchId},${otherMatch}`);
  assert.deepEqual([status.json.data[matchId].status, status.json.data[matchId].eligible, status.json.data[matchId].can_upload], ['none', true, true]);
  assert.equal(status.json.data[otherMatch].eligible, false);

  const { start, results, complete } = await upload(f, bytes);
  assert.equal(start.status, 201);
  assert.equal(start.json.data.parts, 2);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(complete.status, 200);
  const dispatch = f.calls.find(c => c.address.startsWith('https://api.github.com/'));
  assert.equal(dispatch.address, 'https://api.github.com/repos/araise3/vlravg/actions/workflows/parse-replays.yml/dispatches');
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: 'main' }, 'no user-controlled workflow inputs');
  assert.equal((await f.call('GET', `/status?ids=${matchId}`)).json.data[matchId].status, 'pending');

  assert.equal((await f.call('POST', '/claim')).status, 401, 'parser routes need the workflow key');
  const claim = await f.call('POST', '/claim', { workflow: true });
  const [job] = claim.json.data;
  assert.equal(job.match_id, matchId);
  assert.deepEqual((await f.call('POST', '/claim', { workflow: true })).json.data, [], 'a claimed job is not handed out twice');
  const raw = await f.call('GET', `/raw/${matchId}?claim=${job.claim}`, { workflow: true });
  assert.equal(sha(new Uint8Array(await raw.response.arrayBuffer())), sha(bytes));
  assert.equal((await f.call('GET', `/raw/${matchId}?claim=${crypto.randomUUID()}`, { workflow: true })).status, 404);

  const { result, stored, blob } = await submit(f, job, compactDoc(bytes));
  assert.equal(result.status, 200);
  assert.equal(stored.status, 200);
  status = (await f.call('GET', `/status?ids=${matchId}`)).json.data[matchId];
  assert.equal(status.status, 'parsed');
  assert.equal(status.source, 'user-upload');
  assert.equal(status.map_path, '/Game/Maps/Duality/Duality');
  assert.equal(status.counts.kills, 1);
  assert.equal(status.can_upload, false);
  const compact = await f.call('GET', `/compact/${matchId}`);
  assert.equal(compact.response.headers.get('X-Replay-Source'), 'user-upload');
  assert.equal(f.r2.objects.get(`compact/${matchId}.json.gz`).byteLength, blob.byteLength);
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size: bytes.byteLength, turnstileToken: 'ok' } })).status, 409);
  // Uploaded data never reaches the trusted evidence tables.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM match_archive').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rr_history').get().n, 0);
});

test('uploads are gated before anything reaches R2', async t => {
  const f = await fixture(t);
  const size = 2 * 1024 * 1024;
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size, turnstileToken: 'bad' } })).status, 403);
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size: 1000, turnstileToken: 'ok' } })).status, 413);
  assert.equal((await f.call('POST', `/upload/${otherMatch}`, { body: { size, turnstileToken: 'ok' } })).status, 404, 'unknown match');

  const wrong = await upload(f, replayBytes(size, otherMatch));
  assert.equal(wrong.results[0].status, 409, 'replay of another match');
  assert.equal(f.r2.objects.size, 0);
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size, turnstileToken: 'ok' } })).status, 409, 'upload in progress');
  await f.call('POST', `/upload/${matchId}/abort`, { headers: { 'X-Upload-Token': wrong.uploadToken } });

  const junk = await upload(f, new Uint8Array(size));
  assert.equal(junk.results[0].status, 415);
  assert.equal(junk.complete.status, 409, 'missing parts cannot complete');
  assert.equal((await f.call('PUT', `/upload/${matchId}/part/1`, { body: replayBytes(size), headers: { 'X-Upload-Token': 'guess' } })).status, 404);
  assert.equal((await f.call('PUT', `/upload/${matchId}/part/1`, { body: replayBytes(size - 1), headers: { 'X-Upload-Token': junk.uploadToken } })).status, 400);
});

test('daily and per-match budgets are enforced atomically', async t => {
  const f = await fixture(t);
  const saved = { ...REPLAY_LIMITS };
  t.after(() => Object.assign(REPLAY_LIMITS, saved));
  REPLAY_LIMITS.ipUploads = 2;
  const size = 2 * 1024 * 1024;
  const start = () => f.call('POST', `/upload/${matchId}`, { body: { size, turnstileToken: 'ok' } });
  const first = await start();
  await f.call('POST', `/upload/${matchId}/abort`, { headers: { 'X-Upload-Token': first.json.data.uploadToken } });
  const second = await start();
  assert.equal(second.status, 201);
  await f.call('POST', `/upload/${matchId}/abort`, { headers: { 'X-Upload-Token': second.json.data.uploadToken } });
  assert.equal((await start()).status, 429, 'per-connection daily cap');
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size, turnstileToken: 'ok' }, ip: '198.51.100.2' })).status, 201);
  REPLAY_LIMITS.ipUploads = 99;
  f.db.prepare("UPDATE replay_imports SET status='failed',uploads=?1").run(REPLAY_LIMITS.uploadsPerMatch);
  assert.equal((await start()).status, 429, 'per-match attempt cap');
});

test('parser results are validated and cross-checked against HenrikDev players', async t => {
  const f = await fixture(t);
  const bytes = replayBytes(2 * 1024 * 1024);
  await upload(f, bytes);
  let [job] = (await f.call('POST', '/claim', { workflow: true })).json.data;
  const bad = compactDoc(bytes);
  bad.players[0].subject = 'not-a-uuid';
  const blob = await gzip('{}');
  const invalid = await f.call('POST', `/result/${matchId}`, { workflow: true,
    body: { claim: job.claim, ok: true, summary: { ...summarizeCompact(compactDoc(bytes), { bytes: blob.byteLength, sha256: sha(blob) }), players: bad.players } } });
  assert.equal(invalid.status, 422);

  const tampered = await submit(f, job, compactDoc(bytes));
  const wrongBlob = await f.call('PUT', `/result/${matchId}/compact?claim=${job.claim}`, { body: await gzip('{"x":1}'), workflow: true });
  assert.equal(tampered.stored.status, 200, 'matching blob is stored');
  assert.equal(wrongBlob.status, 404, 'claim is closed once stored');

  // A replay without every HenrikDev player is rejected and its raw file deleted.
  const g = await fixture(t);
  await upload(g, bytes);
  [job] = (await g.call('POST', '/claim', { workflow: true })).json.data;
  const rejected = await submit(g, job, compactDoc(bytes, players.slice(1).concat(id(77))));
  assert.equal(rejected.result.json.data.status, 'rejected');
  assert.equal([...g.r2.objects.keys()].some(key => key.startsWith('raw/')), false);
  const status = (await g.call('GET', `/status?ids=${matchId}`)).json.data[matchId];
  assert.deepEqual([status.status, status.error, status.can_upload], ['rejected', 'players_mismatch', true]);

  const h = await fixture(t);
  await upload(h, bytes);
  [job] = (await h.call('POST', '/claim', { workflow: true })).json.data;
  await h.call('POST', `/result/${matchId}`, { workflow: true, body: { claim: job.claim, ok: false, error: 'rm -rf /' } });
  assert.equal((await h.call('GET', `/status?ids=${matchId}`)).json.data[matchId].error, 'parser_failed', 'failure codes are enumerated');
});

test('compact validator rejects malformed or out-of-range documents', () => {
  const doc = compactDoc(replayBytes(2048));
  assert.doesNotThrow(() => validateCompact(structuredClone(doc), { matchId }));
  const broken = [
    d => { d.extra = 1; },
    d => { d.match_id = otherMatch; },
    d => { d.events.kills.push([58030, 0, 10]); },
    d => { d.events.rounds.push([99_999_999, 1]); },
    d => { d.movement.tracks[0].samples.push(0, 0, 0, 0, 0); },
    d => { d.movement.tracks[0].samples[4] = 400; },
    d => { d.movement.tracks[0].samples[1] = 1.5; },
    d => { d.replay.map_path = '<script>'; },
    d => { d.players.push({ ...d.players[0] }); },
  ];
  for (const mutate of broken) {
    const copy = structuredClone(doc);
    mutate(copy);
    assert.throws(() => validateCompact(copy, { matchId }), mutate.toString());
  }
  assert.deepEqual(decodeTrack(doc.movement.tracks[0].samples), [
    { t_ms: 500, x: 15100, y: -700, z: 200, yaw: 180 }, { t_ms: 750, x: 15105, y: -700, z: 200, yaw: 170 }]);
  const summary = summarizeCompact(doc, { bytes: 100, sha256: '0'.repeat(64) });
  assert.equal(summary.counts.movement_samples, 2);
  assert.doesNotThrow(() => validateSummary(summary, { matchId }));
  assert.throws(() => validateSummary({ ...summary, counts: { ...summary.counts, kills: -1 } }));
});

test('the full vrfkit export is stored opaque, file by file, before the compact record', async t => {
  const f = await fixture(t);
  const bytes = replayBytes(2 * 1024 * 1024);
  await upload(f, bytes);
  const [job] = (await f.call('POST', '/claim', { workflow: true })).json.data;
  const doc = compactDoc(bytes);
  const blob = await gzip(JSON.stringify(doc));
  const summary = summarizeCompact(doc, { bytes: blob.byteLength, sha256: sha(blob) });
  const files = exportFiles();
  const list = Object.entries(files).map(([name, b]) => ({ name, bytes: b.byteLength, sha256: sha(b) }));
  assert.equal((await f.call('POST', `/result/${matchId}/export`, { body: { claim: job.claim, files: list }, workflow: true })).status, 404,
    'export needs an accepted summary first');
  await f.call('POST', `/result/${matchId}`, { body: { claim: job.claim, ok: true, summary }, workflow: true });
  assert.equal((await f.call('PUT', `/result/${matchId}/compact?claim=${job.claim}`, { body: blob, workflow: true })).status, 409,
    'compact cannot finish without the export');
  for (const bad of [[...list, { name: '../raw.vrf', bytes: 1, sha256: 'a'.repeat(64) }], [...list, { ...list[2], name: 'notes.txt' }],
    list.filter(file => file.name !== 'movement.parquet'), [...list, list[0]], [{ ...list[0], extra: 1 }, ...list.slice(1)]]) {
    assert.equal((await f.call('POST', `/result/${matchId}/export`, { body: { claim: job.claim, files: bad }, workflow: true })).status, 422);
  }
  assert.equal((await f.call('POST', `/result/${matchId}/export`, { body: { claim: job.claim, files: list } })).status, 401);
  await uploadExport(f, job, files);
  assert.equal((await f.call('PUT', `/result/${matchId}/export/events.parquet/part/1?claim=${job.claim}`, { body: files['events.parquet'], workflow: true })).status, 404,
    'a finished file is closed');
  assert.equal((await f.call('PUT', `/result/${matchId}/compact?claim=${job.claim}`, { body: blob, workflow: true })).status, 200);
  for (const [name, b] of Object.entries(files)) assert.equal(sha(f.r2.objects.get(`export/${matchId}/${name}`)), sha(b), name);
  const status = (await f.call('GET', `/status?ids=${matchId}`)).json.data[matchId];
  assert.equal(status.export_bytes, Object.values(files).reduce((s, b) => s + b.byteLength, 0));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM replay_export_parts').get().n, 0);
});

test('stored exports count against the storage cap', async t => {
  const f = await fixture(t);
  const saved = { ...REPLAY_LIMITS };
  t.after(() => Object.assign(REPLAY_LIMITS, saved));
  f.db.prepare("INSERT INTO replay_export_files (match_id,name,claim_id,bytes,sha256,object_key,done) VALUES ('x','movement.parquet','c',?1,'s','k',1)")
    .run(REPLAY_LIMITS.storedRawBytes - 1024 * 1024);
  assert.equal((await f.call('POST', `/upload/${matchId}`, { body: { size: 2 * 1024 * 1024, turnstileToken: 'ok' } })).status, 429);
});

test('uploads a decoder could not read are retried once by a different decoder build', async t => {
  const f = await fixture(t);
  await upload(f, replayBytes(2 * 1024 * 1024));
  const old = 'b9496df61c40fa304d4f539689c1dd627804946e';
  const patched = `${old}+${'7'.repeat(64)}`;
  const claim = decoder => f.call('POST', '/claim', { workflow: true, body: { decoder } });
  let [job] = (await claim(old)).json.data;
  await f.call('POST', `/result/${matchId}`, { workflow: true, body: { claim: job.claim, ok: false, error: 'decoder_validate_failed', decoder: old } });
  assert.deepEqual((await claim(old)).json.data, [], 'the same decoder does not retry');
  [job] = (await claim(patched)).json.data;
  assert.equal(job?.match_id, matchId, 'a new decoder re-queues it');
  await f.call('POST', `/result/${matchId}`, { workflow: true, body: { claim: job.claim, ok: false, error: 'decoder_validate_failed', decoder: patched } });
  assert.deepEqual((await claim(patched)).json.data, [], 'and does not loop');
  f.db.prepare("UPDATE replay_imports SET error='timeout',decoder_id=NULL").run();
  assert.deepEqual((await claim(`${old}+${'8'.repeat(64)}`)).json.data, [], 'other failures are not retried');
  f.db.prepare("UPDATE replay_imports SET error='decoder_validate_failed',raw_key=NULL").run();
  assert.deepEqual((await claim(`${old}+${'9'.repeat(64)}`)).json.data, [], 'nothing to retry without the raw file');
  assert.equal((await claim('not a decoder; DROP TABLE x')).status, 200, 'an invalid decoder name is ignored');
});

test('status reports live pipeline progress from what the pipeline recorded', async t => {
  const f = await fixture(t);
  const bytes = replayBytes(2 * 1024 * 1024);
  assert.equal(replayBuild(bytes), '13.09');
  assert.equal(replayBuild(new Uint8Array(4096)), null);
  await upload(f, bytes);
  const progress = async () => (await f.call('GET', `/status?ids=${matchId}`)).json.data[matchId].progress;
  let p = await progress();
  assert.equal(p.header_build, '13.09', 'read from the replay header at upload');
  assert.equal(p.dispatch.requested, true);
  assert.equal(p.dispatch.ok, true);
  assert.equal(p.queue_position, 1);
  assert.equal(p.run_url, null);

  githubJobs = [
    { name: 'fetch', status: 'completed', conclusion: 'success', started_at: '2026-10-29T10:00:00Z', completed_at: '2026-10-29T10:00:20Z' },
    { name: 'toolchain', status: 'completed', conclusion: 'success', started_at: '2026-10-29T10:00:21Z', completed_at: '2026-10-29T10:00:40Z',
      steps: [{ name: 'Run git clone --filter=blob:none x', conclusion: 'skipped' }] },
    { name: 'parse', status: 'in_progress', conclusion: null, started_at: '2026-10-29T10:00:41Z', completed_at: null },
    { name: 'unrelated', status: 'queued' },
  ];
  const [job] = (await f.call('POST', '/claim', { workflow: true, body: { decoder: 'a'.repeat(40), run_id: '987654' } })).json.data;
  p = await progress();
  assert.equal(p.run_url, 'https://github.com/araise3/vlravg/actions/runs/987654');
  assert.equal(p.attempt, 1);
  assert.deepEqual(p.jobs.map(j => [j.name, j.status, j.cached]), [['fetch', 'completed', undefined], ['toolchain', 'completed', true], ['parse', 'in_progress', undefined]]);
  const calls = f.calls.filter(c => c.address.includes('/actions/runs/')).length;
  await progress();
  assert.equal(f.calls.filter(c => c.address.includes('/actions/runs/')).length, calls, 'GitHub is asked at most every 15 s');

  const doc = compactDoc(bytes);
  const blob = await gzip(JSON.stringify(doc));
  await f.call('POST', `/result/${matchId}`, { workflow: true, body: { claim: job.claim, ok: true, summary: summarizeCompact(doc, { bytes: blob.byteLength, sha256: sha(blob) }) } });
  const files = exportFiles();
  const list = Object.entries(files).map(([name, b]) => ({ name, bytes: b.byteLength, sha256: sha(b) }));
  await f.call('POST', `/result/${matchId}/export`, { body: { claim: job.claim, files: list }, workflow: true });
  await f.call('PUT', `/result/${matchId}/export/movement.parquet/part/1?claim=${job.claim}`, { workflow: true, body: files['movement.parquet'].subarray(0, REPLAY_PART_BYTES) });
  p = await progress();
  assert.ok(p.decoded_at);
  assert.deepEqual(p.export, { files: 3, files_done: 0, bytes: list.reduce((s, x) => s + x.bytes, 0), bytes_done: REPLAY_PART_BYTES }, 'stored parts count live');
});

test("a decoder failure reports the decoder's supported builds", async t => {
  const f = await fixture(t);
  await upload(f, replayBytes(2 * 1024 * 1024));
  const [job] = (await f.call('POST', '/claim', { workflow: true, body: {} })).json.data;
  await f.call('POST', `/result/${matchId}`, { workflow: true, body: { claim: job.claim, ok: false, error: 'decoder_validate_failed', supported_builds: ['13.06', '13.08', '<b>'] } });
  let p = (await f.call('GET', `/status?ids=${matchId}`)).json.data[matchId].progress;
  assert.equal(p.supported_builds, null, 'a malformed list is dropped');
  f.db.prepare("UPDATE replay_imports SET status='parsing',claim_id=?1").run(job.claim);
  await f.call('POST', `/result/${matchId}`, { workflow: true, body: { claim: job.claim, ok: false, error: 'decoder_validate_failed', supported_builds: ['13.06', '13.08'] } });
  p = (await f.call('GET', `/status?ids=${matchId}`)).json.data[matchId].progress;
  assert.deepEqual([p.header_build, p.supported_builds], ['13.09', ['13.06', '13.08']]);
});
