// Isolated Pages experiment. Disabled unless explicitly enabled with secrets.
import { runRemoteProbe } from '../../lib/riot-remote-probe.mjs';

const encoder = new TextEncoder();
async function sameSecret(a, b) {
  const hashes = await Promise.all([a, b].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export async function onRequest({ request, env }) {
  const reply = (body, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  if (env.RIOT_PROBE_ENABLED !== 'true' || !env.RIOT_PROBE_KEY || env.RIOT_PROBE_KEY.length < 32) {
    return reply({ error: 'Not found' }, 404);
  }
  if (request.method !== 'POST') return reply({ error: 'Use POST' }, 405);
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 512 || !await sameSecret(supplied, `Bearer ${env.RIOT_PROBE_KEY}`)) {
    return reply({ error: 'Unauthorized' }, 401);
  }
  // All targets and credentials are controlled by preview secrets, never input.
  const mode = new URL(request.url).searchParams.get('mode') || 'auth';
  if (!['auth', 'content', 'player', 'custom'].includes(mode)) return reply({ error: 'Invalid mode' }, 400);
  const result = await runRemoteProbe(env, mode);
  return reply(result, result.ok ? 200 : 502);
}
