// Archived HenrikDev match payloads (gzip JSON) live in R2, one object per
// match, shared by every player whose history contains it (binding
// MATCH_BUCKET, docs/match-archive-r2.md). D1's match_archive keeps the
// per-player index. Rows saved before the move still hold their payload
// inline until the migration empties it; an empty payload means "in R2".
const MATCH_ID_RE = /^[0-9a-z-]{1,64}$/i;

export function matchKey(matchId) {
  if (!MATCH_ID_RE.test(matchId || '')) throw new Error('Invalid match id');
  return `matches/${matchId.toLowerCase()}.json.gz`;
}

export function hasInlinePayload(payload) {
  return payload != null && new Uint8Array(payload).byteLength > 0;
}

// Compressed bytes for one archive row ({match_id, payload}), or null when
// neither D1 nor R2 holds it.
export async function readArchivedPayload(env, row) {
  if (!row) return null;
  if (hasInlinePayload(row.payload)) return new Uint8Array(row.payload);
  if (!env.MATCH_BUCKET) return null;
  let key;
  try { key = matchKey(row.match_id); } catch { return null; }
  const object = await env.MATCH_BUCKET.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

// Run fn over items with at most `limit` in flight, keeping input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
