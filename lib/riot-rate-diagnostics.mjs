// Only rate-control values are exposed. Cookies, authorization, redirect URLs,
// opaque partition keys, request IDs and arbitrary upstream error text are not.
export const RATE_HEADER_NAMES = [
  'x-app-rate-limit', 'x-app-rate-limit-count', 'x-method-rate-limit',
  'x-method-rate-limit-count', 'x-rate-limit-type', 'x-ratelimit-limit',
  'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit', 'ratelimit-policy',
  'retry-after',
];
export function rateDiagnostics(headers, now = Date.now()) {
  const present = RATE_HEADER_NAMES.filter(name => headers.has(name));
  const values = {};
  for (const name of present) {
    const raw = headers.get(name)?.trim() || '';
    if (name === 'retry-after') continue;
    if (name === 'x-rate-limit-type') {
      if (['application','method','service'].includes(raw.toLowerCase())) values[name] = raw.toLowerCase();
    } else if (name === 'ratelimit' || name === 'ratelimit-policy') {
      const parameters = [...raw.matchAll(/(?:^|[;,\s])((?:r|t|q|w|remaining|reset|limit))\s*=\s*(\d+)\b/gi)]
        .map(m => ({ parameter: m[1].toLowerCase(), value: Number(m[2]) }));
      if (parameters.length) values[name] = parameters;
    } else if (raw.length <= 256 && /^\d+(?:\s*[:,]\s*\d+)*$/.test(raw)) values[name] = raw;
  }
  const retry = headers.get('retry-after')?.trim();
  let retryAfterMs = null;
  if (retry && /^\d+(?:\.\d+)?$/.test(retry)) retryAfterMs = Math.ceil(Number(retry)*1000);
  else if (retry && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(retry)) {
    const date = Date.parse(retry);
    if (Number.isFinite(date)) retryAfterMs = Math.max(0,date-now);
  }
  if (retryAfterMs != null && !Number.isFinite(retryAfterMs)) retryAfterMs = null;
  if (retryAfterMs != null) values['retry-after-ms'] = retryAfterMs;
  const contentType = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return { present, values, retryAfterMs,
    serverClass: /cloudflare/i.test(headers.get('server') || '') ? 'cloudflare' : headers.has('server') ? 'other' : 'absent',
    contentType: ['application/json','text/plain','text/html'].includes(contentType) ? contentType : 'other',
    cloudflareRayPresent: headers.has('cf-ray'), challenge: headers.get('cf-mitigated') === 'challenge' };
}
