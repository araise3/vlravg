// Strict validator for the compact replay format (scripts/replay-compact.py).
// The parser runs on hostile input, so its output is untrusted too: every key,
// type, range and length is checked here, both in the submit job and again in
// the Function before anything is stored. Unknown keys are rejected.
export const COMPACT_FORMAT = 'vlravg.replay-compact';
export const COMPACT_VERSION = 1;
export const COMPACT_MAX_JSON_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const MAX_PLAYERS = 12;
const MAX_COORD = 2_000_000; // cm; VALORANT maps span well under 1 km
const EVENT_LIMITS = { rounds: 200, kills: 3000, plants: 200, defuses: 200, detonations: 200, ultimates: 2000, switch_teams: 20 };

class CompactError extends Error {}
const fail = message => { throw new CompactError(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} out of range`);
  return value;
};
const str = (value, max, name, pattern) => {
  if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) fail(`${name} invalid`);
  return value;
};
function keys(value, allowed, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) fail(`${name} has unknown key ${extra}`);
  const missing = allowed.find(key => !Object.hasOwn(value, key));
  if (missing) fail(`${name} is missing ${missing}`);
}
function list(value, max, name) {
  if (!Array.isArray(value) || value.length > max) fail(`${name} invalid`);
  return value;
}

// Returns the compact document unchanged, or throws CompactError.
export function validateCompact(compact, { matchId } = {}) {
  keys(compact, ['format', 'version', 'match_id', 'source', 'decoder', 'replay', 'quality', 'players', 'events', 'movement'], 'compact');
  if (compact.format !== COMPACT_FORMAT || compact.version !== COMPACT_VERSION) fail('unsupported format');
  str(compact.match_id, 36, 'match_id', UUID);
  if (matchId && compact.match_id !== matchId) fail('match_id mismatch');
  keys(compact.source, ['bytes', 'sha256'], 'source');
  int(compact.source.bytes, 48, 512 * 1024 * 1024, 'source.bytes');
  str(compact.source.sha256, 64, 'source.sha256', /^[0-9a-f]{64}$/);
  keys(compact.decoder, ['name', 'revision', 'patch'], 'decoder');
  if (compact.decoder.name !== 'vrfkit') fail('decoder.name invalid');
  str(compact.decoder.revision, 40, 'decoder.revision', /^[0-9a-f]{40}$/);
  // SHA-256 of a patch applied on top of upstream vrfkit (VRFKIT_PATCH in parse-replays.yml), or null.
  if (compact.decoder.patch !== null) str(compact.decoder.patch, 64, 'decoder.patch', /^[0-9a-f]{64}$/);
  keys(compact.replay, ['build', 'map_path', 'duration_ms', 'recorded_ticks'], 'replay');
  str(compact.replay.build, 64, 'replay.build', /^[\w+.\-]*$/);
  str(compact.replay.map_path, 128, 'replay.map_path', /^[\w/.\-]*$/);
  const duration = int(compact.replay.duration_ms, 1, MAX_DURATION_MS, 'replay.duration_ms');
  str(compact.replay.recorded_ticks, 20, 'replay.recorded_ticks', /^\d*$/);
  keys(compact.quality, ['content_blocks_lost', 'movement_rows', 'event_rows', 'malformed_packets', 'transform_failures'], 'quality');
  for (const [key, value] of Object.entries(compact.quality)) int(value, 0, 1e9, `quality.${key}`);

  const players = list(compact.players, MAX_PLAYERS, 'players');
  if (!players.length) fail('players empty');
  const subjects = new Set();
  players.forEach((player, i) => {
    keys(player, ['subject', 'character_id'], `players[${i}]`);
    str(player.subject, 36, `players[${i}].subject`, UUID);
    if (player.character_id !== null) str(player.character_id, 36, `players[${i}].character_id`, UUID);
    if (subjects.has(player.subject)) fail('duplicate subject');
    subjects.add(player.subject);
  });
  const time = (value, name) => int(value, 0, duration + 60_000, name);
  const who = (value, name) => int(value, -1, players.length - 1, name);

  keys(compact.events, Object.keys(EVENT_LIMITS), 'events');
  for (const [name, limit] of Object.entries(EVENT_LIMITS)) {
    list(compact.events[name], limit, `events.${name}`).forEach((row, i) => {
      const label = `events.${name}[${i}]`;
      if (name === 'rounds') { list(row, 2, label); if (row.length !== 2) fail(label); time(row[0], label); int(row[1], -1, 199, label); }
      else if (name === 'kills') { list(row, 3, label); if (row.length !== 3) fail(label); time(row[0], label); who(row[1], label); who(row[2], label); }
      else if (name === 'ultimates') { list(row, 2, label); if (row.length !== 2) fail(label); time(row[0], label); who(row[1], label); }
      else time(row, label);
    });
  }

  keys(compact.movement, ['interval_ms', 'encoding', 'tracks'], 'movement');
  if (compact.movement.interval_ms !== 250 || compact.movement.encoding !== 'delta-v1') fail('movement encoding unsupported');
  const maxTick = Math.ceil((duration + 60_000) / 250);
  const seen = new Set();
  list(compact.movement.tracks, players.length, 'movement.tracks').forEach((track, i) => {
    keys(track, ['player', 'samples'], `movement.tracks[${i}]`);
    who(track.player, `movement.tracks[${i}].player`);
    if (track.player < 0 || seen.has(track.player)) fail('movement track player invalid');
    seen.add(track.player);
    const samples = list(track.samples, 5 * (maxTick + 1), `movement.tracks[${i}].samples`);
    if (samples.length % 5) fail('movement samples not in groups of five');
    // Decode while validating: ticks strictly increase, positions stay on a map.
    let tick = 0, x = 0, y = 0, z = 0, yaw = 0;
    for (let j = 0; j < samples.length; j += 5) {
      for (let k = 0; k < 5; k++) if (!Number.isSafeInteger(samples[j + k])) fail('movement sample not an integer');
      const dt = samples[j];
      if (j ? dt <= 0 : dt < 0) fail('movement ticks not increasing');
      tick += dt; x += samples[j + 1]; y += samples[j + 2]; z += samples[j + 3]; yaw += samples[j + 4];
      if (tick > maxTick || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD || Math.abs(z) > MAX_COORD || yaw < 0 || yaw > 359)
        fail('movement sample out of range');
    }
  });
  return compact;
}

// The Function cannot afford to inflate and walk a whole compact document
// inside the Workers CPU budget (about 10 ms measured for gunzip, parse and
// validation of a 730 KB document). The trusted submit job validates the full
// document, then sends this small summary plus the gzip blob's SHA-256; the
// Function validates the summary strictly and stores the blob only if its hash
// matches.
export const SUMMARY_COUNTS = [...Object.keys(EVENT_LIMITS), 'movement_samples'];
export function summarizeCompact(compact, blob) {
  const counts = Object.fromEntries(Object.keys(EVENT_LIMITS).map(name => [name, compact.events[name].length]));
  counts.movement_samples = compact.movement.tracks.reduce((sum, track) => sum + track.samples.length / 5, 0);
  const { format, version, match_id, source, decoder, replay, quality, players } = compact;
  return { format, version, match_id, source, decoder, replay, quality, players, counts, compact: blob };
}

export function validateSummary(summary, { matchId } = {}) {
  keys(summary, ['format', 'version', 'match_id', 'source', 'decoder', 'replay', 'quality', 'players', 'counts', 'compact'], 'summary');
  // Reuse the document checks on an empty event/movement body.
  validateCompact({
    ...Object.fromEntries(['format', 'version', 'match_id', 'source', 'decoder', 'replay', 'quality', 'players'].map(key => [key, summary[key]])),
    events: Object.fromEntries(Object.keys(EVENT_LIMITS).map(name => [name, []])),
    movement: { interval_ms: 250, encoding: 'delta-v1', tracks: [] },
  }, { matchId });
  keys(summary.counts, SUMMARY_COUNTS, 'counts');
  for (const [name, limit] of Object.entries(EVENT_LIMITS)) int(summary.counts[name], 0, limit, `counts.${name}`);
  int(summary.counts.movement_samples, 0, MAX_PLAYERS * (Math.ceil((summary.replay.duration_ms + 60_000) / 250) + 1), 'counts.movement_samples');
  keys(summary.compact, ['bytes', 'sha256'], 'compact');
  int(summary.compact.bytes, 18, 4 * 1024 * 1024, 'compact.bytes');
  str(summary.compact.sha256, 64, 'compact.sha256', /^[0-9a-f]{64}$/);
  return summary;
}

export function isCompactError(error) {
  return error instanceof CompactError;
}

// Decodes one delta-v1 track into [{t_ms,x,y,z,yaw}] for readers of the format.
export function decodeTrack(samples, intervalMs = 250) {
  const out = [];
  let tick = 0, x = 0, y = 0, z = 0, yaw = 0;
  for (let j = 0; j < samples.length; j += 5) {
    tick += samples[j]; x += samples[j + 1]; y += samples[j + 2]; z += samples[j + 3]; yaw += samples[j + 4];
    out.push({ t_ms: tick * intervalMs, x, y, z, yaw });
  }
  return out;
}
