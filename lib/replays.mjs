// Replay storage is deliberately separate from the HenrikDev proxy. A VRF is
// too large for D1, so D1 indexes a private R2 object by its match UUID.
const MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REPLAY_BYTES = 95_000_000; // under Cloudflare's 100 MB Free/Pro request cap
const HEADER_READ_BYTES = 2048;
const REPLAY_MAGIC = 0x43f4efdd;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function validCode(request, expected) {
  const supplied = request.headers.get('X-Replay-Code') || '';
  if (!expected || !supplied || supplied.length > 256) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([expected, supplied].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function matchIdFromName(name) {
  if (typeof name !== 'string' || !name.toLowerCase().endsWith('.vrf')) return null;
  const id = name.slice(0, -4);
  return MATCH_ID.test(id) ? id.toLowerCase() : null;
}

function replayMatchIdFromHeader(bytes, totalSize) {
  if (totalSize < 48 || bytes.byteLength < 48) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== REPLAY_MAGIC) return null;
  if (view.getInt32(32, true) <= 0) return null;

  // Unreal serializes this replay's FriendlyName as an FString. A negative
  // length means UTF-16 code units including the trailing NUL. VALORANT puts
  // the authoritative match UUID here; unlike the local filename, changing it
  // requires changing the replay contents themselves.
  const nameUnits = view.getInt32(44, true);
  if (nameUnits >= 0) return null;
  const nameBytes = -nameUnits * 2;
  const nameEnd = 48 + nameBytes;
  if (!Number.isSafeInteger(nameEnd) || nameEnd > totalSize || nameEnd > bytes.byteLength) return null;
  try {
    const embedded = new TextDecoder('utf-16le', { fatal: true })
      .decode(bytes.subarray(48, nameEnd)).replace(/\0+$/, '').trim();
    return MATCH_ID.test(embedded) ? embedded.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function replayRows(db) {
  const { results } = await db.prepare(
    'SELECT match_id, size_bytes, uploaded_at, status FROM replay_uploads ORDER BY uploaded_at DESC LIMIT 100'
  ).all();
  return results;
}

export async function handleReplayRequest({ request, env }, path) {
  if (path !== '/replays' && !/^\/replays\/[0-9a-f-]+$/i.test(path)) return null;
  if (!env.REPLAY_BUCKET || !env.APP_DB || !env.REPLAY_UPLOAD_CODE) {
    return reply({ error: 'Replay storage is not configured' }, 503);
  }
  if (!await validCode(request, env.REPLAY_UPLOAD_CODE)) {
    return reply({ error: 'Invalid replay upload code' }, 401);
  }

  if (path === '/replays' && request.method === 'GET') {
    try { return reply({ data: await replayRows(env.APP_DB) }); }
    catch { return reply({ error: 'Replay index unavailable; run the schema migration' }, 503); }
  }

  const matchRoute = path.match(/^\/replays\/([0-9a-f-]+)$/i);

  if (path === '/replays' && request.method === 'POST') {
    return reply({ error: 'Choose the match this replay belongs to' }, 400);
  }

  if (matchRoute && request.method === 'POST' && MATCH_ID.test(matchRoute[1])) {
    const targetMatchId = matchRoute[1].toLowerCase();
    const name = request.headers.get('X-Replay-Name');
    const matchId = matchIdFromName(name);
    const size = Number(request.headers.get('X-Replay-Size'));
    const lengthHeader = request.headers.get('Content-Length');
    const length = lengthHeader === null ? null : Number(lengthHeader);
    if (!matchId) return reply({ error: 'Use the original match UUID .vrf filename' }, 400);
    if (matchId !== targetMatchId) {
      return reply({ error: 'Replay filename does not match the selected match ID' }, 400);
    }
    if (!Number.isSafeInteger(size) || size < 48 || size > MAX_REPLAY_BYTES ||
        (length !== null && (!Number.isSafeInteger(length) || length !== size))) {
      return reply({ error: 'Replay must have a known size between 48 bytes and 95 MB' }, 413);
    }
    if (!request.body) return reply({ error: 'Missing replay body' }, 400);

    try {
      const knownMatch = await env.APP_DB.prepare(
        'SELECT match_id FROM match_archive WHERE match_id=?1 LIMIT 1'
      ).bind(matchId).first();
      if (!knownMatch) {
        return reply({ error: 'Match ID is not in the verified match history' }, 404);
      }
      const existing = await env.APP_DB.prepare(
        'SELECT match_id FROM replay_uploads WHERE match_id=?1'
      ).bind(matchId).first();
      if (existing) return reply({ error: 'This match was already uploaded' }, 409);
    } catch { return reply({ error: 'Replay index unavailable; run the schema migration' }, 503); }

    // Read only the bounded header prefix, then pass the prefix and untouched
    // remainder through to R2. Never buffer the 95 MB body.
    const reader = request.body.getReader();
    const prefix = [];
    let prefixLength = 0;
    let firstRemainder = null;
    const prefixTarget = Math.min(HEADER_READ_BYTES, size);
    while (prefixLength < prefixTarget) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const take = Math.min(chunk.value.length, prefixTarget - prefixLength);
      prefix.push(chunk.value.subarray(0, take));
      prefixLength += take;
      if (take < chunk.value.length) firstRemainder = chunk.value.subarray(take);
    }
    const firstBytes = new Uint8Array(prefixLength);
    let offset = 0;
    for (const part of prefix) { firstBytes.set(part, offset); offset += part.length; }
    const embeddedMatchId = replayMatchIdFromHeader(firstBytes, size);
    if (!embeddedMatchId) {
      await reader.cancel();
      return reply({ error: 'Replay header does not contain a valid VALORANT match ID' }, 400);
    }
    if (embeddedMatchId !== targetMatchId) {
      await reader.cancel();
      return reply({ error: 'Replay contents do not match the selected match ID' }, 400);
    }
    let sent = prefixLength + (firstRemainder?.length || 0);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(firstBytes);
        if (firstRemainder) controller.enqueue(firstRemainder);
      },
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else {
          sent += chunk.value.length;
          if (sent > size) {
            controller.error(new Error('Replay exceeded declared size'));
            await reader.cancel();
          } else controller.enqueue(chunk.value);
        }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    const key = `replays/${crypto.randomUUID()}.vrf`;
    try {
      const object = await env.REPLAY_BUCKET.put(key, body, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      if (!object || object.size !== size || sent !== size) {
        await env.REPLAY_BUCKET.delete(key);
        return reply({ error: 'Incomplete replay upload' }, 400);
      }
      try {
        await env.APP_DB.prepare(
          'INSERT INTO replay_uploads (match_id, object_key, size_bytes, uploaded_at, status) VALUES (?1,?2,?3,?4,?5)'
        ).bind(matchId, key, size, new Date().toISOString(), 'awaiting_parser').run();
      } catch {
        await env.REPLAY_BUCKET.delete(key);
        return reply({ error: 'Could not save replay index' }, 503);
      }
      return reply({ data: { match_id: matchId, size_bytes: size, status: 'awaiting_parser' } }, 201);
    } catch {
      await env.REPLAY_BUCKET.delete(key).catch(() => {});
      return reply({ error: 'Replay storage failed' }, 503);
    }
  }

  const download = matchRoute;
  if (download && request.method === 'GET' && MATCH_ID.test(download[1])) {
    const id = download[1].toLowerCase();
    const row = await env.APP_DB.prepare(
      'SELECT object_key FROM replay_uploads WHERE match_id=?1'
    ).bind(id).first();
    if (!row) return reply({ error: 'Replay not found' }, 404);
    const object = await env.REPLAY_BUCKET.get(row.object_key);
    if (!object) return reply({ error: 'Replay object missing' }, 404);
    return new Response(object.body, { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${id}.vrf"`,
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  }
  return reply({ error: 'Unknown replay route' }, 404);
}
