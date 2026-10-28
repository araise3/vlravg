import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { rm } from 'node:fs/promises';
import { EXPORT_FILES } from '../lib/replay-import.mjs';
import { fetchJobs } from '../.github/scripts/replay-fetch.mjs';
import { prepareResult, submitAll } from '../.github/scripts/replay-submit.mjs';

const matchId = 'a27d4487-c781-4b73-8a9e-f4a468139bba';
const claimId = '11111111-1111-4111-8111-111111111111';
const raw = new Uint8Array(64).map((_, i) => i);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const claim = { match_id: matchId, claim: claimId, bytes: raw.byteLength, sha256: sha(raw), error: null };
const compact = () => ({
  format: 'vlravg.replay-compact', version: 1, match_id: matchId,
  source: { bytes: raw.byteLength, sha256: sha(raw) }, decoder: { name: 'vrfkit', revision: 'b9496df61c40fa304d4f539689c1dd627804946e', patch: null },
  replay: { build: '++Ares-Core+release-13.08', map_path: '/Game/Maps/Duality/Duality', duration_ms: 60000, recorded_ticks: '1' },
  quality: { content_blocks_lost: 0, movement_rows: 0, event_rows: 0, malformed_packets: 0, transform_failures: 0 },
  players: [{ subject: claimId, character_id: null }],
  events: { rounds: [], kills: [], plants: [], defuses: [], detonations: [], ultimates: [], switch_teams: [] },
  movement: { interval_ms: 250, encoding: 'delta-v1', tracks: [] },
});

const exportBytes = () => ({ 'manifest.json': Buffer.from('{}'), 'movement.parquet': Buffer.alloc(20 * 1024 * 1024 + 5, 9) });
async function writeExport(dir, files = exportBytes()) {
  await mkdir(join(dir, 'export'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, 'export', name), bytes);
}

test('fetch keeps claim IDs out of the parse job artifact', async () => {
  const out = await mkdtemp(join(tmpdir(), 'replay-fetch-'));
  const calls = [];
  const claims = await fetchJobs({ origin: 'https://site.test', key: 'k', out, decoder: 'd', fetchImpl: async (url, init) => {
    calls.push([url, init.headers['X-Workflow-Key']]);
    if (url.endsWith('/claim')) assert.deepEqual(JSON.parse(init.body), { decoder: 'd' }, 'the claim names the decoder build');
    if (url.endsWith('/claim')) return Response.json({ data: [{ match_id: matchId, claim: claimId, bytes: raw.byteLength }, { match_id: '../x', claim: claimId, bytes: 1 }] });
    return new Response(raw);
  } });
  assert.equal(claims.length, 1, 'malformed job IDs are dropped');
  assert.ok(calls.every(([, key]) => key === 'k'));
  const jobs = await readFile(join(out, 'replays/jobs.json'), 'utf8');
  assert.deepEqual(JSON.parse(jobs), [{ match_id: matchId, bytes: raw.byteLength, sha256: sha(raw) }]);
  assert.ok(!jobs.includes(claimId));
  assert.equal(JSON.parse(await readFile(join(out, 'claims/claims.json'), 'utf8'))[0].claim, claimId);
});

test('submit validates parser output as untrusted data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-submit-'));
  const write = async (name, text) => writeFile(join(dir, name), text);
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'parser_failed' });
  await write('error.txt', 'decoder_validate_failed\n');
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'decoder_validate_failed' });
  await write('error.txt', '$(curl evil)');
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'parser_failed' });
  await write('compact.json', '{not json');
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'compact_invalid' });
  await write('compact.json', JSON.stringify({ ...compact(), source: { bytes: raw.byteLength, sha256: '0'.repeat(64) } }));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'compact_invalid' }, 'source hash must match the fetch job');
  await write('compact.json', JSON.stringify(compact()));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'export_missing' }, 'the full export is required');
  await writeExport(dir, { 'notes.txt': 'x' });
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'export_missing' }, 'only allowlisted export files');
  await rm(join(dir, 'export'), { recursive: true });
  await writeExport(dir);
  const ok = await prepareResult(claim, dir);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.files.map(f => [f.name, f.bytes]).sort(), [['manifest.json', 2], ['movement.parquet', 20 * 1024 * 1024 + 5]]);
  assert.deepEqual(JSON.parse(gunzipSync(ok.blob)), compact());
  assert.equal(ok.summary.compact.sha256, sha(ok.blob));
});

test('submit posts the summary, then the matching blob', async () => {
  const work = await mkdtemp(join(tmpdir(), 'replay-work-'));
  await mkdir(join(work, 'claims'), { recursive: true });
  await mkdir(join(work, 'parsed', matchId), { recursive: true });
  await writeFile(join(work, 'claims/claims.json'), JSON.stringify([claim]));
  await writeFile(join(work, 'parsed', matchId, 'compact.json'), JSON.stringify(compact()));
  await writeExport(join(work, 'parsed', matchId));
  const requests = [];
  const base = `https://site.test/api/replays/result/${matchId}`;
  const outcomes = await submitAll({ origin: 'https://site.test', key: 'k', work, fetchImpl: async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    if (url === base) return Response.json({ data: { status: 'awaiting_compact' } });
    if (url === base + '/export') {
      const files = JSON.parse(init.body).files;
      return Response.json({ data: { partBytes: 10 * 1024 * 1024, files: files.map(f => ({ name: f.name, parts: Math.ceil(f.bytes / (10 * 1024 * 1024)) })) } }, { status: 201 });
    }
    return Response.json({ data: { status: url.includes('/compact') ? 'parsed' : 'ok' } });
  } });
  assert.deepEqual(outcomes, [{ match_id: matchId, status: 'parsed', error: null }]);
  assert.equal(requests[0].url, base);
  const declared = JSON.parse(requests[1].body).files;
  assert.equal(declared.find(f => f.name === 'movement.parquet').sha256, sha(exportBytes()['movement.parquet']));
  const movementParts = requests.filter(r => r.url.includes('/export/movement.parquet/part/'));
  assert.deepEqual(movementParts.map(r => r.body.byteLength), [10485760, 10485760, 5]);
  assert.equal(sha(Buffer.concat(movementParts.map(r => r.body))), sha(exportBytes()['movement.parquet']));
  assert.equal(requests.at(-1).url, `${base}/compact?claim=${claimId}`, 'compact last, after every export file');
  assert.equal(JSON.parse(requests[0].body).summary.compact.sha256, sha(requests.at(-1).body));
});

test('the parse job holds no secrets and runs the parser in a locked-down container', () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  const parse = workflow.slice(workflow.indexOf('\n  parse:'), workflow.indexOf('\n  submit:'));
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(parse, /permissions: \{\}/);
  assert.doesNotMatch(parse, /secrets\.|actions\/checkout|actions\/cache/);
  assert.doesNotMatch(workflow, /workflow_dispatch:\n\s+inputs:/, 'dispatch takes no inputs');
  assert.match(workflow, /python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}/);
  const sandbox = readFileSync(new URL('../.github/scripts/replay-parse-sandbox.sh', import.meta.url), 'utf8');
  for (const flag of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 65534:65534', '--memory 6g', '--pids-limit']) {
    assert.ok(sandbox.includes(flag), flag);
  }
  assert.doesNotMatch(sandbox, /:\/out:rw|-v "[^"]*:rw"/, 'no writable bind mount');
});

test('the decoder is upstream vrfkit v0.3.0 and its identity is checked on submit', async () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  assert.match(workflow, /VRFKIT_REVISION: b9496df61c40fa304d4f539689c1dd627804946e/);
  assert.ok(workflow.includes('if [ -n "$VRFKIT_PATCH" ]; then\n            echo "$VRFKIT_PATCH_SHA256  $VRFKIT_PATCH" | sha256sum -c -\n            git -C vrfkit apply'),
    'an optional patch is hash-checked before it is applied');
  const dir = await mkdtemp(join(tmpdir(), 'replay-decoder-'));
  await writeFile(join(dir, 'compact.json'), JSON.stringify(compact()));
  await writeExport(dir);
  const upstream = { revision: 'b9496df61c40fa304d4f539689c1dd627804946e', patch: null };
  assert.equal((await prepareResult(claim, dir, upstream)).ok, true);
  assert.deepEqual(await prepareResult(claim, dir, { ...upstream, patch: 'a'.repeat(64) }), { ok: false, error: 'compact_invalid' },
    'a record from another decoder build is refused');
});

test('the unpacker accepts exactly the export allowlist the Function accepts', () => {
  const unpack = readFileSync(new URL('../.github/scripts/replay-unpack.py', import.meta.url), 'utf8');
  const listed = [...unpack.match(/EXPORT_FILES = \(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(listed, EXPORT_FILES);
  const sandbox = readFileSync(new URL('../.github/scripts/replay-parse-sandbox.sh', import.meta.url), 'utf8');
  assert.match(sandbox, /vrfkit export \/in\/replay\.vrf --out \/work\/export --checkpoints/);
  assert.match(sandbox, /replay-unpack\.py/);
});

test('the 13.09 patch is the pinned, reviewed upstream PR code', () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  const patch = readFileSync(new URL('../.github/replay-decoder/vrfkit-13.09.patch', import.meta.url));
  assert.ok(workflow.includes('VRFKIT_PATCH: .github/replay-decoder/vrfkit-13.09.patch\n'));
  assert.equal(sha(patch), workflow.match(/VRFKIT_PATCH_SHA256: ([0-9a-f]{64})/)[1]);
  assert.ok(!patch.includes(13), 'LF-only, so it applies to the upstream blobs');
  assert.ok(patch.toString().includes('\n+    V1309 V13_09 "13.09" 0x7e8c_b50f  0x0f: add 8, add 7, sbox, sub 5, swap, sub 3, sbox, rev;\n'));
  const push = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('\nconcurrency:'));
  assert.ok(push.includes('branches: [main]') && push.includes('- .github/replay-decoder/**'), 'a decoder change runs the parser');
});
