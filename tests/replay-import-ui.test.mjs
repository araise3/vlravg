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
const ui = runInNewContext(html.slice(start, end) + '\n({replayMatchRows,replayFileMatchId,replayStatusView})', {
  PUUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, TextDecoder, DataView, Uint8Array, Map, Set, String, Math,
});
const matchId = 'a27d4487-c781-4b73-8a9e-f4a468139bba';

function header(embedded) {
  const bytes = new Uint8Array(2048);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43f4efdd, true);
  view.setInt32(32, 1784630, true);
  view.setInt32(44, -257, true);
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
  assert.equal(ui.replayStatusView({ status: 'pending' }).tone, 'busy');
  const parsed = ui.replayStatusView({ status: 'parsed', duration_ms: 1784630, build: '++Ares-Core+release-13.08', counts: { rounds: 19, kills: 156 }, export_bytes: 24814693 });
  assert.equal(parsed.detail, '19 rounds · 156 kills · 30 min · build 13.08 · full export 23.7 MB');
  assert.equal(ui.replayStatusView({ status: 'rejected', error: 'players_mismatch' }).detail, 'The replay’s players do not match this match.');
  assert.equal(ui.replayStatusView({ status: 'failed', error: 'unknown' }).detail, 'The replay could not be processed.');
});

test('the page is routed like the other detail pages', () => {
  assert.match(readFileSync(new URL('../_redirects', import.meta.url), 'utf8'), /^\/replays \/index\.html 200$/m);
  assert.match(html, /<a href="\/replays" data-page="replays">Replays<\/a>/);
  assert.match(html, /path==='\/replays'\?'replays'/);
  assert.match(html, /replays:'replays'\}/);
});
