import { SAMPLE_SQL } from '../../lib/riot-benchmark.mjs';
import { benchmarkUnpaced } from '../../lib/riot-unpaced-benchmark.mjs';

export async function onRequest({ request, env }) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const key = env.RIOT_BENCH_KEY || env.RIOT_PROBE_KEY;
  if (!key || key.length < 32 || env.RIOT_PROBE_ENABLED !== 'true') return reply({ error: 'Not found' }, 404);
  if (request.method !== 'POST') return reply({ error: 'Use POST' }, 405);
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 512) return reply({ error: 'Unauthorized' }, 401);
  const encode = new TextEncoder();
  const hashes = await Promise.all([supplied, `Bearer ${key}`].map(v => crypto.subtle.digest('SHA-256', encode.encode(v))));
  const [a,b] = hashes.map(h => new Uint8Array(h));
  let diff = 0; for (let i=0;i<a.length;i++) diff |= a[i]^b[i];
  if (diff) return reply({ error: 'Unauthorized' }, 401);
  const params = new URL(request.url).searchParams;
  const batch = Number(params.get('batch')), concurrency = Number(params.get('concurrency'));
  if (!Number.isInteger(batch) || batch < 0 || batch > 7 || ![1,2,4].includes(concurrency)) return reply({ error: 'Invalid workload' }, 400);
  if (!env.APP_DB) return reply({ error: 'Missing cache database binding' }, 503);
  const { results } = await env.APP_DB.prepare(SAMPLE_SQL).all();
  const players = results.slice(batch * 3, batch * 3 + 3);
  if (!players.length) return reply({ done: true });
  const report = await benchmarkUnpaced(env, players, concurrency);
  for (const page of report.pages) {
    page.sample = batch * 3 + page.index;
    page.playerHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(players[page.index].puuid))))
      .map(b => b.toString(16).padStart(2,'0')).join('');
  }
  return reply({ batch, report });
}
