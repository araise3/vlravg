import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReplayRequest } from '../lib/replays.mjs';

const id = '645dafbb-ecaa-4281-be6d-878e7b117f3a';
const otherId = '745dafbb-ecaa-4281-be6d-878e7b117f3a';
const unknownId = '845dafbb-ecaa-4281-be6d-878e7b117f3a';

function fixture() {
  const rows = new Map(), objects = new Map(), archived = new Set([id]);
  const db = { prepare(sql) {
    let args;
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes('FROM match_archive')) return archived.has(args[0]) ? { match_id: args[0] } : null;
        return rows.get(args[0]) || null;
      },
      async all() { return { results: [...rows.values()] }; },
      async run() {
        if (!sql.startsWith('INSERT')) throw Error('Unexpected SQL');
        if (rows.has(args[0])) throw Error('Duplicate');
        rows.set(args[0], { match_id: args[0], object_key: args[1], size_bytes: args[2], uploaded_at: args[3], status: args[4] });
      },
    };
  } };
  const bucket = {
    async put(key, body) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, bytes);
      return { size: bytes.length };
    },
    async delete(key) { objects.delete(key); },
    async get(key) {
      const value = objects.get(key);
      return value ? { size: value.length, body: new Blob([value]).stream() } : null;
    },
  };
  return { rows, objects, archived, env: { APP_DB: db, REPLAY_BUCKET: bucket, REPLAY_UPLOAD_CODE: 'test-code' } };
}

function request(method, path, body, code = 'test-code', name = `${id}.vrf`) {
  return new Request(`https://example.test/api${path}`, {
    method,
    headers: { 'X-Replay-Code': code, ...(body ? { 'X-Replay-Name': name, 'X-Replay-Size': String(body.length) } : {}) },
    body,
  });
}

function replayBytes(matchId, size = 256) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43f4efdd, true);
  view.setInt32(32, 3_400_000, true);
  view.setUint32(36, 0x1ca7efe6, true);
  view.setUint32(40, 5_092_570, true);
  view.setInt32(44, -(matchId.length + 1), true);
  for (let i = 0; i < matchId.length; i++) view.setUint16(48 + i * 2, matchId.charCodeAt(i), true);
  return bytes;
}

test('rejects unauthenticated and malformed uploads before writing to R2', async () => {
  const f = fixture();
  const bytes = new Uint8Array(48);
  const unauthorized = await handleReplayRequest({ env: f.env, request: request('POST', `/replays/${id}`, bytes, 'wrong') }, `/replays/${id}`);
  assert.equal(unauthorized.status, 401);
  const bad = await handleReplayRequest({ env: f.env, request: request('POST', `/replays/${id}`, bytes) }, `/replays/${id}`);
  assert.equal(bad.status, 400);
  assert.equal(f.objects.size, 0);
});

test('only accepts the original replay for a verified target match', async () => {
  const f = fixture();
  f.archived.add(otherId);
  const renamedBytes = replayBytes(id);
  const renamed = await handleReplayRequest(
    { env: f.env, request: request('POST', `/replays/${otherId}`, renamedBytes, 'test-code', `${otherId}.vrf`) },
    `/replays/${otherId}`
  );
  assert.equal(renamed.status, 400);
  assert.match((await renamed.json()).error, /contents do not match/i);

  const unknownBytes = replayBytes(unknownId);
  const unknown = await handleReplayRequest(
    { env: f.env, request: request('POST', `/replays/${unknownId}`, unknownBytes, 'test-code', `${unknownId}.vrf`) },
    `/replays/${unknownId}`
  );
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /verified match history/i);
  assert.equal(f.objects.size, 0);
});

test('streams a replay into R2, indexes it, lists it, and downloads the original bytes', async () => {
  const f = fixture();
  const bytes = replayBytes(id);
  const upload = await handleReplayRequest({ env: f.env, request: request('POST', `/replays/${id}`, bytes) }, `/replays/${id}`);
  assert.equal(upload.status, 201);
  assert.equal(f.rows.get(id).status, 'awaiting_parser');
  const list = await handleReplayRequest({ env: f.env, request: request('GET', '/replays') }, '/replays');
  assert.equal((await list.json()).data[0].match_id, id);
  const download = await handleReplayRequest({ env: f.env, request: request('GET', `/replays/${id}`) }, `/replays/${id}`);
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  const duplicate = await handleReplayRequest({ env: f.env, request: request('POST', `/replays/${id}`, bytes) }, `/replays/${id}`);
  assert.equal(duplicate.status, 409);
  assert.equal(f.objects.size, 1);
});
