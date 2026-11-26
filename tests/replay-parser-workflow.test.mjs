import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { rm } from 'node:fs/promises';
import { EXPORT_FILES } from '../lib/replay-import.mjs';
import { fetchJobs, parseJobs } from '../.github/scripts/replay-fetch.mjs';
import { actionsToken, downloadJobs } from '../.github/scripts/replay-download.mjs';
import { prepareResult, submitAll } from '../.github/scripts/replay-submit.mjs';
import { validateCompact } from '../lib/replay-compact.mjs';

const matchId = 'a27d4487-c781-4b73-8a9e-f4a468139bba';
const claimId = '11111111-1111-4111-8111-111111111111';
const raw = new Uint8Array(64).map((_, i) => i);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const claim = { match_id: matchId, claim: claimId, bytes: raw.byteLength };
// What the parse job's download step writes beside the sandbox output.
const writeSource = dir => writeFile(join(dir, 'source.json'), JSON.stringify({ bytes: raw.byteLength, sha256: sha(raw) }));
const compact = () => ({
  format: 'vlravg.replay-compact', version: 1, match_id: matchId,
  source: { bytes: raw.byteLength, sha256: sha(raw) }, decoder: { name: 'vrfkit', revision: 'b9496df61c40fa304d4f539689c1dd627804946e', patch: null,
    transform: { source: 'compiled', line: '0x3c17_a9fa -0x06: add 8, rev, rotl 6, sbox, rotr 4, sbox, sbox, rev' } },
  replay: { build: '++Ares-Core+release-13.08', map_path: '/Game/Maps/Duality/Duality', duration_ms: 60000, recorded_ticks: '1' },
  quality: { content_blocks_lost: 0, movement_rows: 0, event_rows: 0, malformed_packets: 0, transform_failures: 0 },
  players: [{ subject: claimId, character_id: null }],
  events: { rounds: [], kills: [], plants: [], defuses: [], detonations: [], ultimates: [], switch_teams: [] },
  movement: { interval_ms: 250, encoding: 'delta-v1', tracks: [] },
});

const exportBytes = () => ({ 'manifest.json': Buffer.from('{}'), 'movement.parquet': Buffer.alloc(20 * 1024 * 1024 + 5, 9) });
// The parse job's split output: export-files.json beside compact.json, and the
// tables in the large artifact's folder (replay-export-list.mjs).
async function writeExport(dir, files = exportBytes(), exportDir = join(dir, 'export')) {
  await mkdir(exportDir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(exportDir, name), bytes);
  const list = Object.entries(files).map(([name, bytes]) => ({ name, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }));
  await writeFile(join(dir, 'export-files.json'), JSON.stringify(list));
}

test('fetch only claims: claim IDs stay with the submit job, the parse job gets match IDs and sizes', async () => {
  const out = await mkdtemp(join(tmpdir(), 'replay-fetch-'));
  const calls = [];
  const claims = await fetchJobs({ origin: 'https://site.test', key: 'k', out, decoder: 'd', runId: '42', fetchImpl: async (url, init) => {
    calls.push([url, init.headers['X-Workflow-Key']]);
    assert.deepEqual(JSON.parse(init.body), { decoder: 'd', run_id: '42' }, 'the claim names the decoder build and the run');
    return Response.json({ data: [{ match_id: matchId, claim: claimId, bytes: raw.byteLength }, { match_id: '../x', claim: claimId, bytes: 1 }] });
  } });
  assert.deepEqual(calls, [['https://site.test/api/replays/claim', 'k']], 'no download: the parse job fetches the files');
  assert.deepEqual(claims, [claim], 'malformed job IDs are dropped');
  assert.deepEqual(JSON.parse(await readFile(join(out, 'claims/claims.json'), 'utf8')), [claim]);
  assert.deepEqual(parseJobs(claims), [{ match_id: matchId, bytes: raw.byteLength }]);
  assert.ok(!JSON.stringify(parseJobs(claims)).includes(claimId));
});

test('the parse job downloads each claimed replay with its OIDC token and records size and hash outside the sandbox', async () => {
  const token = await actionsToken({ url: 'https://oidc.test/token?x=1', token: 'req', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://oidc.test/token?x=1&audience=vlravg-replay-raw');
    assert.equal(init.headers.Authorization, 'bearer req');
    return Response.json({ value: 'jwt' });
  } });
  assert.equal(token, 'jwt');
  await assert.rejects(actionsToken({ url: '', token: '' }), /id-token: write/);
  const out = await mkdtemp(join(tmpdir(), 'replay-download-'));
  const other = 'bd2ea657-0865-4cd7-934c-f6478cd43a64';
  const requests = [];
  const ready = await downloadJobs({ origin: 'https://site.test', out, idToken: 'jwt',
    jobs: [{ match_id: matchId, bytes: raw.byteLength }, { match_id: other, bytes: 999 }, { match_id: '../x', bytes: 1 }],
    fetchImpl: async (url, init) => { requests.push([url, init.headers.Authorization]); return new Response(raw); } });
  assert.deepEqual(requests.sort(), [[`https://site.test/api/replays/raw-once/${matchId}`, 'Bearer jwt'], [`https://site.test/api/replays/raw-once/${other}`, 'Bearer jwt']]);
  assert.deepEqual(ready, [{ match_id: matchId, bytes: raw.byteLength, sha256: sha(raw) }]);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'replays/jobs.json'), 'utf8')), ready);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'parsed', matchId, 'source.json'), 'utf8')), { bytes: raw.byteLength, sha256: sha(raw) });
  assert.equal(await readFile(join(out, 'parsed', other, 'error.txt'), 'utf8'), 'download_failed\n', 'a wrong size is a failed download');
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
  await write('compact.json', JSON.stringify(compact()));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'compact_invalid' }, 'no record of the downloaded file');
  await write('source.json', JSON.stringify({ bytes: raw.byteLength + 1, sha256: sha(raw) }));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'compact_invalid' }, 'the download must have the claimed size');
  await writeSource(dir);
  await write('compact.json', JSON.stringify({ ...compact(), source: { bytes: raw.byteLength, sha256: '0'.repeat(64) } }));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'compact_invalid' }, 'source hash must match the downloaded file');
  await write('compact.json', JSON.stringify(compact()));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'export_missing' }, 'the full export is required');
  await writeExport(dir, { 'notes.txt': 'x' });
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'export_missing' }, 'only allowlisted export files');
  await rm(join(dir, 'export'), { recursive: true });
  await writeFile(join(dir, 'export-files.json'), JSON.stringify([{ name: 'manifest.json', bytes: 2, sha256: 'x' }]));
  assert.deepEqual(await prepareResult(claim, dir), { ok: false, error: 'export_missing' }, 'the list is validated as untrusted');
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
  await writeSource(join(work, 'parsed', matchId));
  await writeExport(join(work, 'parsed', matchId), exportBytes(), join(work, 'parsed-export', matchId, 'export'));
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
  // Parts upload concurrently, so they can finish in any order.
  const movementParts = requests.filter(r => r.url.includes('/export/movement.parquet/part/'))
    .sort((a, b) => Number(a.url.match(/part\/(\d+)/)[1]) - Number(b.url.match(/part\/(\d+)/)[1]));
  assert.deepEqual(movementParts.map(r => r.body.byteLength), [10485760, 10485760, 5]);
  const movementDone = requests.findIndex(r => r.url.includes('/export/movement.parquet/complete'));
  assert.ok(requests.slice(movementDone).every(r => !r.url.includes('/export/movement.parquet/part/')), 'a file completes after all its parts');
  assert.equal(sha(Buffer.concat(movementParts.map(r => r.body))), sha(exportBytes()['movement.parquet']));
  // Declared, then the compact record (which marks the replay stored), then the
  // export's parts: the export no longer delays the record (26 Nov 2026).
  const compactAt = requests.findIndex(r => r.url === `${base}/compact?claim=${claimId}`);
  assert.equal(requests[1].url, base + '/export');
  assert.equal(compactAt, 2, 'compact right after the export is declared');
  assert.ok(requests.slice(compactAt + 1).some(r => r.url.includes('/part/')), 'parts follow the record');
  assert.equal(JSON.parse(requests[0].body).summary.compact.sha256, sha(requests[compactAt].body));
});

test('the parse job holds no secrets and runs the parser in a locked-down container', () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  const parse = workflow.slice(workflow.indexOf('\n  parse:'), workflow.indexOf('\n  submit:'));
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(parse, /permissions:\n\s+id-token: write\n\s+env:/, 'the only permission is its OIDC token');
  assert.doesNotMatch(parse, /secrets\.|actions\/checkout|actions\/cache|name: replays/);
  assert.doesNotMatch(workflow, /workflow_dispatch:\n\s+inputs:/, 'dispatch takes no inputs');
  assert.match(workflow, /RUNTIME_IMAGE: python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}/);
  const sandbox = readFileSync(new URL('../.github/scripts/replay-parse-sandbox.sh', import.meta.url), 'utf8');
  for (const flag of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 65534:65534', '--memory 6g', '--pids-limit']) {
    assert.ok(sandbox.includes(flag), flag);
  }
  assert.doesNotMatch(sandbox, /:\/out:rw|-v "[^"]*:rw"/, 'no writable bind mount');
  assert.doesNotMatch(sandbox, /ACTIONS_ID_TOKEN|--env-file|-e [A-Z_]+ /, 'the OIDC token never reaches the container');
  assert.ok([...sandbox.matchAll(/-e ([A-Z_]+)=/g)].every(m => ['MATCH_ID', 'SOURCE_BYTES', 'SOURCE_SHA256', 'DECODER_REVISION', 'DECODER_PATCH', 'HOME'].includes(m[1])));
});

test('the decoder is parser/, named by its upstream base and its tree digest, and checked on submit', async () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  assert.match(workflow, /DECODER_REVISION: b9496df61c40fa304d4f539689c1dd627804946e/);
  const digest = 'echo "patch=$(git ls-files -s parser | sha256sum | cut -c1-64)" >> "$GITHUB_OUTPUT"';
  for (const [job, next] of [['fetch', 'toolchain'], ['toolchain', 'parse']]) {
    const body = workflow.slice(workflow.indexOf(`\n  ${job}:`), workflow.indexOf(`\n  ${next}:`));
    assert.ok(body.includes(digest), `${job} computes the tree digest`);
  }
  assert.doesNotMatch(workflow, /git clone|git -C vrfkit|VRFKIT_/, 'no upstream clone or patch');
  const dir = await mkdtemp(join(tmpdir(), 'replay-decoder-'));
  await writeFile(join(dir, 'compact.json'), JSON.stringify(compact()));
  await writeSource(dir);
  await writeExport(dir);
  const base = { revision: 'b9496df61c40fa304d4f539689c1dd627804946e', patch: null };
  assert.equal((await prepareResult(claim, dir, base)).ok, true);
  assert.deepEqual(await prepareResult(claim, dir, { ...base, patch: 'a'.repeat(64) }), { ok: false, error: 'compact_invalid' },
    'a record from another decoder build is refused');
});

test('records name the payload transform they were decoded with', () => {
  const doc = compact();
  assert.equal(validateCompact(doc), doc);
  for (const transform of [
    { source: 'guessed', line: doc.decoder.transform.line },
    { source: 'solved', line: '0x2c24_9eb3 0x33: sub 9' },
    { source: 'solved', line: '0x2c24_9eb3 0x33: sub 8; rm -rf /' },
    { source: 'solved', line: '0x2c24_9eb3 0x33: ' + Array(9).fill('not').join(', ') },
    { source: 'solved' },
    null,
  ]) {
    assert.throws(() => validateCompact({ ...doc, decoder: { ...doc.decoder, transform } }), /decoder\.transform/);
  }
  const { transform, ...without } = doc.decoder;
  assert.throws(() => validateCompact({ ...doc, decoder: without }), /decoder is missing transform/);
  assert.ok(validateCompact({ ...doc, decoder: { ...doc.decoder, transform: { source: 'solved', line: '0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1' } } }));
});

test('submit reports a transform solved from an upload', async () => {
  const work = await mkdtemp(join(tmpdir(), 'replay-solved-'));
  await mkdir(join(work, 'claims'), { recursive: true });
  await mkdir(join(work, 'parsed', matchId), { recursive: true });
  await writeFile(join(work, 'claims/claims.json'), JSON.stringify([claim]));
  const doc = compact();
  doc.replay.build = '++Ares-Core+release-13.10';
  doc.decoder.transform = { source: 'solved', line: '0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1' };
  await writeFile(join(work, 'parsed', matchId, 'compact.json'), JSON.stringify(doc));
  await writeSource(join(work, 'parsed', matchId));
  await writeExport(join(work, 'parsed', matchId), exportBytes(), join(work, 'parsed-export', matchId, 'export'));
  const outcomes = await submitAll({ origin: 'https://site.test', key: 'k', work, fetchImpl: async () => Response.json({ data: { status: 'failed' } }) });
  assert.equal(outcomes[0].solved, '13.10 0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1');
});

test('the parse job lists and moves each export; submit sends a file only if it matches the list', async () => {
  const { splitExports } = await import('../.github/scripts/replay-export-list.mjs');
  const { verifyExport } = await import('../.github/scripts/replay-submit.mjs');
  const work = await mkdtemp(join(tmpdir(), 'replay-split-'));
  const files = exportBytes();
  await mkdir(join(work, 'parsed', matchId, 'export'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(work, 'parsed', matchId, 'export', name), bytes);
  await mkdir(join(work, 'parsed', 'failed-one'), { recursive: true });
  assert.deepEqual(await splitExports(work), [matchId]);
  const list = JSON.parse(await readFile(join(work, 'parsed', matchId, 'export-files.json'), 'utf8'));
  assert.deepEqual(list, Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: sha(bytes) })));
  assert.ok(!existsSync(join(work, 'parsed', matchId, 'export')), 'the tables left the small artifact');
  const dir = join(work, 'parsed-export', matchId, 'export');
  assert.deepEqual((await verifyExport(list, dir)).map(f => f.path), list.map(f => `${dir}/${f.name}`));
  await writeFile(join(dir, 'manifest.json'), '{"x":1}');
  assert.equal(await verifyExport(list, dir), 'export_mismatch', 'a changed file is not sent');
  assert.equal(await verifyExport(list, join(work, 'missing')), 'export_mismatch');
});

test('the unpacker accepts exactly the export allowlist the Function accepts', () => {
  const unpack = readFileSync(new URL('../.github/scripts/replay-unpack.py', import.meta.url), 'utf8');
  const listed = [...unpack.match(/EXPORT_FILES = \(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(listed, EXPORT_FILES);
  const sandbox = readFileSync(new URL('../.github/scripts/replay-parse-sandbox.sh', import.meta.url), 'utf8');
  assert.match(sandbox, /vrfkit export \/in\/replay\.vrf --out \/work\/export --checkpoints --require-pass --solve-unknown/);
  assert.doesNotMatch(sandbox, /python3 -s|vrfkit validate/, 'one parser call: no second decode, no Python reducer');
  assert.match(sandbox, /replay-unpack\.py/);
});

test('the fork carries the reviewed 13.09 line and the solved 13.10 line, and a change to it runs the parser', () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../parser/crates/vrf-transform/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(lib.includes('\n    V1309 V13_09 "13.09" 0x7e8c_b50f  0x0f: add 8, add 7, sbox, sub 5, swap, sub 3, sbox, rev;\n'));
  const registry = readFileSync(new URL('../parser/transforms.txt', import.meta.url), 'utf8');
  assert.match(registry, /^13\.10 0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1$/m);
  const push = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('\nconcurrency:'));
  assert.ok(push.includes('branches: [main]') && push.includes('- parser/**'), 'a decoder change runs the parser');
  assert.ok(!existsSync(new URL('../.github/workflows/vrfkit-watch.yml', import.meta.url)), 'no upstream release watcher');
});

test('mapLimit runs at most the limit at once and covers every item', async () => {
  const { mapLimit } = await import('../.github/scripts/replay-submit.mjs');
  let running = 0, peak = 0;
  const seen = [];
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    running++; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 5 * (n % 3)));
    seen.push(n); running--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test('the toolchain builds in parallel with fetch under a key that ignores unrelated workflow edits', () => {
  const workflow = readFileSync(new URL('../.github/workflows/parse-replays.yml', import.meta.url), 'utf8');
  const toolchain = workflow.slice(workflow.indexOf('\n  toolchain:'), workflow.indexOf('\n  parse:'));
  assert.doesNotMatch(toolchain, /needs:/, 'no wait for fetch');
  assert.doesNotMatch(toolchain, /hashFiles\('\.github\/workflows/, 'editing the workflow does not force a rebuild');
  assert.match(toolchain, /key: replay-toolchain-v3-\$\{\{ steps\.decoder\.outputs\.patch \}\}-\$\{\{ env\.RUST_IMAGE \}\}/);
  assert.match(toolchain, /cargo build --release --locked -p vrfkit/);
  // The submit job stores the records before it downloads the large export.
  const submit = workflow.slice(workflow.indexOf('\n  submit:'));
  const at = text => submit.indexOf(text);
  assert.ok(at('replay-submit.mjs replay-work record') > 0 && at('replay-submit.mjs replay-work record') < at('name: parsed-export')
    && at('name: parsed-export') < at('replay-submit.mjs replay-work export'));
  assert.match(workflow.slice(workflow.indexOf('\n  parse:'), workflow.indexOf('\n  submit:')),
    /replay-export-list\.mjs replay-work[\s\S]*name: parsed\n[\s\S]*name: parsed-export\n/);
  const parse = workflow.slice(workflow.indexOf('\n  parse:'), workflow.indexOf('\n  submit:'));
  assert.match(parse, /needs: \[fetch, toolchain\]\n\s+if: needs\.fetch\.outputs\.count != '0'/);
});
