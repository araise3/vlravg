import { SAMPLE_SQL, benchmarkPlayer } from '../../lib/riot-benchmark.mjs';

export async function onRequest({ request, env }) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const key = env.RIOT_BENCH_KEY || env.RIOT_PROBE_KEY;
  if (!key || key.length < 32 || env.RIOT_PROBE_ENABLED !== 'true') return reply({ error: 'Not found' }, 404);
  if (request.method !== 'POST') return reply({ error: 'Use POST' }, 405);
  const supplied = request.headers.get('Authorization') || '';
  if(supplied.length>512)return reply({error:'Unauthorized'},401);
  const encode = new TextEncoder();
  const hashes = await Promise.all([supplied, `Bearer ${key}`].map(v => crypto.subtle.digest('SHA-256', encode.encode(v))));
  const [a,b] = hashes.map(h => new Uint8Array(h));
  let diff = 0; for (let i=0;i<a.length;i++) diff |= a[i]^b[i];
  if (diff) return reply({ error: 'Unauthorized' }, 401);
  if (!env.APP_DB) return reply({ error: 'Missing cache database binding' }, 503);
  const index = Number(new URL(request.url).searchParams.get('index'));
  if (!Number.isInteger(index) || index < 0 || index >= 24) return reply({ error: 'Invalid sample index' }, 400);
  const { results } = await env.APP_DB.prepare(SAMPLE_SQL).all();
  if (!results[index]) return reply({ done: true, samples: results.length });
  const deep = new URL(request.url).searchParams.get('deep') === 'true';
  const report = await benchmarkPlayer(env, results[index], index, fetch, undefined, deep);
  report.playerHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(results[index].puuid))))
    .map(b=>b.toString(16).padStart(2,'0')).join('');
  return reply({ samples: results.length, report });
}
