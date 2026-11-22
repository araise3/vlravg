// In-memory stand-in for an R2 bucket binding: get/head/put/delete with the
// conditional writes the archive relies on (etagMatches, If-None-Match: *).
export function memoryBucket() {
  const objects = new Map();
  const stats = { gets: 0, puts: 0 };
  let version = 0, beforePut = null;
  const meta = (key, o) => ({ key, size: o.bytes.byteLength, etag: o.etag });
  const fails = (onlyIf, current) => {
    if (!onlyIf) return false;
    if (onlyIf instanceof Headers) {
      if (onlyIf.get('If-None-Match') === '*' && current) return true;
      const ifMatch = onlyIf.get('If-Match');
      return !!ifMatch && current?.etag !== ifMatch;
    }
    if (onlyIf.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) return true;
    return onlyIf.etagDoesNotMatch !== undefined && current?.etag === onlyIf.etagDoesNotMatch;
  };
  const toBytes = value => value instanceof ArrayBuffer ? new Uint8Array(value.slice(0))
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      : new TextEncoder().encode(String(value));
  return {
    objects, stats,
    // Run fn once, just before the next put is evaluated (simulates a race).
    race(fn) { beforePut = fn; },
    async get(key) {
      stats.gets++;
      const o = objects.get(key);
      return o ? { ...meta(key, o), async arrayBuffer() { return o.bytes.slice().buffer; } } : null;
    },
    async head(key) { const o = objects.get(key); return o ? meta(key, o) : null; },
    async put(key, value, options = {}) {
      if (beforePut) { const fn = beforePut; beforePut = null; await fn(); }
      if (fails(options.onlyIf, objects.get(key))) return null;
      stats.puts++;
      const o = { bytes: toBytes(value), etag: `etag-${++version}` };
      objects.set(key, o);
      return meta(key, o);
    },
    async delete(key) { for (const k of [key].flat()) objects.delete(k); },
  };
}
