import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { replayHeader } from '../lib/replay-import.mjs';

// Pure helpers from the Replay import block, run in isolation.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const REPLAY_MAGIC=');
const end = html.indexOf('async function loadReplayConfig(', start);
assert.ok(start > 0 && end > start);
const ui = runInNewContext(html.slice(start, end) + '\n({replayMatchRows,replayFileMatchId,replayFileBuild,replayStatusView,replayProgressSteps,replayBuildRange,replayDuration,replaySpeed})', {
  PUUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, TextDecoder, DataView, Uint8Array, Map, Set, String, Math, Date, Number, Array, Boolean, Object,
});
const matchId = 'a27d4487-c781-4b73-8a9e-f4a468139bba';

function header(embedded) {
  const bytes = new Uint8Array(2048);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43f4efdd, true);
  view.setInt32(32, 1784630, true);
  view.setInt32(44, -257, true);
  view.setInt32(704, 26, true);
  [...'++Ares-Core+release-13.09\0'].forEach((c, i) => { bytes[708 + i] = c.charCodeAt(0); });
  const name = embedded.padEnd(256, ' ') + '\0';
  for (let i = 0; i < name.length; i++) view.setUint16(48 + i * 2, name.charCodeAt(i), true);
  return bytes;
}

test('replay rows list each loaded match once, newest first, with score and result', () => {
  const rows = ui.replayMatchRows([
    { matchId: matchId.toUpperCase(), mapName: 'Bind', startedAt: '15 Oct, 19:00', startedAtMs: 1, myR: 13, opR: 9, won: true },
    { matchId: 'bd2ea657-0865-4cd7-934c-f6478cd43a64', mapName: 'Lotus', startedAt: '16 Oct, 19:00', startedAtMs: 2, myR: 12, opR: 14, won: false },
    { matchId, mapName: 'Bind', startedAtMs: 1 },
    { matchId: null, mapName: 'Ghost' },
    { matchId: 'not-a-match', mapName: 'Ghost' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { matchId: 'bd2ea657-0865-4cd7-934c-f6478cd43a64', map: 'Lotus', date: '16 Oct, 19:00', score: '12–14', result: 'loss' },
    { matchId, map: 'Bind', date: '15 Oct, 19:00', score: '13–9', result: 'win' },
  ]);
});

test('the browser header check agrees with the server header check', () => {
  assert.equal(ui.replayFileMatchId(header(matchId)), matchId);
  assert.equal(ui.replayFileMatchId(header(matchId)), replayHeader(header(matchId)).matchId);
  assert.equal(ui.replayFileMatchId(new Uint8Array(2048)), null);
  assert.equal(ui.replayFileMatchId(header(matchId).subarray(0, 64)), null);
});

test('status labels name the source state without inventing results', () => {
  assert.equal(ui.replayStatusView({ status: 'none', eligible: false }).text, 'Not in the verified archive');
  assert.equal(ui.replayStatusView({ status: 'none', eligible: true }).text, 'No replay');
  assert.deepEqual({ ...ui.replayStatusView({ status: 'pending' }) }, { text: 'Queued', tone: 'busy' });
  assert.equal(ui.replayStatusView({ status: 'rejected' }).text, 'Rejected');
  assert.equal(ui.replayFileBuild(header(matchId)), '13.09');
  assert.equal(ui.replayBuildRange(['13.08', '11.06', '13.06']), '11.06–13.08');
  assert.equal(ui.replayDuration(72_000), '1 min 12 s');
});

const plain = steps => JSON.parse(JSON.stringify(steps)).map(({ key, state, label }) => `${key}:${state}:${label}`);
const base = { uploaded_at: '2026-10-29T10:00:00Z', progress: { header_build: '13.09', dispatch: { requested: true, ok: true, at: '2026-10-29T10:00:01Z' } } };

test('queued replays show their position and whether a parser run was requested', () => {
  const steps = ui.replayProgressSteps({ ...base, status: 'pending', progress: { ...base.progress, queue_position: 2 } });
  assert.deepEqual(plain(steps), ['upload:done:Uploaded', 'queue:active:Queued']);
  assert.match(steps[0].detail, /^build 13\.09 per the replay header · /);
  assert.match(steps[1].detail, /^position 2 · parser run requested /);
  assert.equal(steps[1].since, base.uploaded_at, 'elapsed time runs from the upload');
  const noToken = ui.replayProgressSteps({ ...base, status: 'pending', progress: { dispatch: { requested: false } } });
  assert.equal(noToken[1].detail, 'waiting for the daily parser run at 04:23 UTC');
});

test('a parsing replay follows the parser run\'s real jobs', () => {
  const jobs = [
    { name: 'fetch', status: 'completed', conclusion: 'success', started_at: '2026-10-29T10:01:00Z', completed_at: '2026-10-29T10:01:12Z' },
    { name: 'toolchain', status: 'completed', conclusion: 'success', started_at: '2026-10-29T10:01:13Z', completed_at: '2026-10-29T10:01:20Z', cached: true },
    { name: 'parse', status: 'in_progress', conclusion: null, started_at: '2026-10-29T10:01:21Z', completed_at: null },
  ];
  const progress = { ...base.progress, claimed_at: '2026-10-29T10:01:00Z', attempt: 1, run_url: 'https://github.com/araise3/vlravg/actions/runs/1', jobs };
  const steps = ui.replayProgressSteps({ ...base, status: 'parsing', progress });
  assert.deepEqual(plain(steps), ['upload:done:Uploaded', 'queue:done:Queued', 'download:done:Downloaded by the parser',
    'decoder:done:Decoder ready', 'decode:active:Decoding in the sandbox', 'store:pending:Check and store']);
  assert.equal(steps[1].detail, 'waited 1 min 0 s');
  assert.equal(steps[2].detail, '12 s');
  assert.equal(steps[2].link.href, progress.run_url);
  assert.equal(steps[3].detail, 'from cache');
  assert.equal(steps[4].since, '2026-10-29T10:01:21Z');
  assert.equal(steps.some(step => /%/.test(step.detail || '')), false, 'no invented percentages');

  jobs[2] = { ...jobs[2], status: 'completed', conclusion: 'success', completed_at: '2026-10-29T10:01:51Z' };
  jobs.push({ name: 'submit', status: 'in_progress', started_at: '2026-10-29T10:01:52Z' });
  const storing = ui.replayProgressSteps({ ...base, status: 'parsing', progress: { ...progress, decoded_at: '2026-10-29T10:02:00Z',
    export: { files: 14, files_done: 9, bytes: 24814693, bytes_done: 19000000 } } });
  assert.match(storing.at(-1).detail, /result validated .* · 9 of 14 export files · 18\.1 of 23\.7 MB$/);

  // The snapshot stops refreshing once the row is parsed; its running submit job is stale.
  const parsed = ui.replayProgressSteps({ ...base, status: 'parsed', parsed_at: '2026-10-29T10:02:30Z', progress: { ...progress, decoded_at: '2026-10-29T10:02:00Z' } });
  assert.deepEqual(plain(parsed).slice(-2), ['store:done:Checked and stored', 'stored:done:Stored']);
  assert.equal(parsed.some(step => step.state === 'active' || step.state === 'pending'), false, 'nothing keeps running after the row is parsed');
  assert.equal(parsed.at(-2).detail, '', 'no duration is invented for the unfinished snapshot');
});

test('a failure names the failing step and the reason the pipeline reported', () => {
  const progress = { ...base.progress, claimed_at: '2026-10-29T10:01:00Z', supported_builds: ['11.06', '13.06', '13.08'],
    jobs: [{ name: 'fetch', status: 'completed', conclusion: 'success' }, { name: 'toolchain', status: 'completed', conclusion: 'success' },
      { name: 'parse', status: 'completed', conclusion: 'success' }, { name: 'submit', status: 'completed', conclusion: 'success' }] };
  const steps = ui.replayProgressSteps({ ...base, status: 'failed', error: 'decoder_validate_failed', progress });
  assert.deepEqual(plain(steps).slice(-1), ['decode:failed:Decoded in the sandbox']);
  assert.equal(steps.at(-1).detail, 'Game version 13.09 is not supported by this parser build (it reads 11.06–13.08). It is retried automatically once support is added.');
  const rejected = ui.replayProgressSteps({ ...base, status: 'rejected', error: 'players_mismatch', progress });
  assert.equal(rejected.at(-1).key, 'store');
  assert.equal(rejected.at(-1).state, 'failed');
  const old = ui.replayProgressSteps({ status: 'failed', error: 'timeout', uploaded_at: base.uploaded_at, progress: { claimed_at: '2026-10-29T10:01:00Z' } });
  assert.deepEqual(plain(old), ['upload:done:Uploaded', 'queue:done:Queued', 'run:failed:Parser run'], 'rows without job data still say where it failed');
});

test('upload speed is measured over the last few seconds', () => {
  const samples = [];
  assert.equal(ui.replaySpeed(samples, 0, 0), null, 'no speed before half a second is measured');
  ui.replaySpeed(samples, 1000, 4 * 1048576);
  assert.equal(ui.replaySpeed(samples, 2000, 8 * 1048576), 4 * 1048576);
  assert.equal(ui.replaySpeed(samples, 6000, 12 * 1048576), 4 * 1048576 / 4, 'older samples age out');
});

test('the page is routed like the other detail pages', () => {
  assert.match(readFileSync(new URL('../_redirects', import.meta.url), 'utf8'), /^\/replays \/index\.html 200$/m);
  assert.match(html, /<a href="\/replays" data-page="replays">Replays<\/a>/);
  assert.match(html, /path==='\/replays'\?'replays'/);
  assert.match(html, /replays:'replays'\}/);
});
