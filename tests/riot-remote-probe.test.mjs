import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemoteProbe } from '../lib/riot-remote-probe.mjs';
import { readFile } from 'node:fs/promises';
const routeSource = await readFile(new URL('../functions/riot-probe/run.js', import.meta.url), 'utf8');
const { onRequest } = await import('data:text/javascript;base64,' + Buffer.from(routeSource.replace(
  "'../../lib/riot-remote-probe.mjs'", JSON.stringify(new URL('../lib/riot-remote-probe.mjs', import.meta.url).href))).toString('base64'));
const puuid = '00000000-0000-0000-0000-000000000001';
const env = { RIOT_EXPECTED_RIOT_ID: 'Test#EU', RIOT_SSID: 'private-cookie', RIOT_CLIENT_VERSION: 'test-version' };
const json = value => Response.json(value);
function fakeFetch(overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/authorize?')) return new Response(null, { status: 302,
      headers: { location: overrides.location || 'https://playvalorant.com/opt_in#access_token=private-access-token' } });
    if (url.endsWith('/userinfo')) return json({ sub: puuid, acct: { game_name: overrides.name || 'Test', tag_line: 'EU' } });
    if (url.includes('/api/token/v1')) return json({ entitlements_token: 'private-entitlement' });
    if (url.includes('/content-service/')) return json({ Seasons: [{ Type: 'act' }] });
    if (url.includes('/match-history/')) return overrides.empty ? new Response(null, { status: 404 }) : json({ Total: 1, History: [{ MatchID: puuid }] });
    if (url.includes('/competitiveupdates')) return json({ Matches: [{ MatchID: puuid }] });
    if (url.includes('/match-details/')) return json({ players: [{ partyId: 'private-party' }], roundResults: [], kills: [], matchInfo: { seasonId: 'private-season' } });
    return json({ Subject: puuid, QueueSkills: {} });
  };
  return { calls, fetcher };
}
test('disabled and unauthorized route performs no probe', async () => {
  const request = new Request('https://example.test/riot-probe', { method: 'POST' });
  assert.equal((await onRequest({ request, env: {} })).status, 404);
  assert.equal((await onRequest({ request, env: { RIOT_PROBE_ENABLED: 'true', RIOT_PROBE_KEY: 'x'.repeat(32) } })).status, 401);
});
test('auth renews cookie and checks identity, without player reads or secrets in output', async () => {
  const { calls, fetcher } = fakeFetch();
  const result = await runRemoteProbe(env, 'auth', fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Cookie, 'ssid=private-cookie');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(result), /private-|Test|00000000/);
});
test('wrong identity stops before entitlement and data requests', async () => {
  const { calls, fetcher } = fakeFetch({ name: 'Wrong' });
  const result = await runRemoteProbe(env, 'player', fetcher);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
});
test('login redirect is rejected without forwarding credentials', async () => {
  const { calls, fetcher } = fakeFetch({ location: 'https://unexpected.test/#access_token=secret' });
  assert.equal((await runRemoteProbe(env, 'auth', fetcher)).ok, false);
  assert.equal(calls.length, 1);
});
test('interactive login is classified without revealing redirect parameters', async () => {
  const { fetcher } = fakeFetch({ location: 'https://authenticate.riotgames.com/login?private-cookie=secret' });
  const result = await runRemoteProbe(env, 'auth', fetcher);
  assert.equal(result.steps[0].redirectKind, 'interactive-login');
  assert.doesNotMatch(JSON.stringify(result), /private-cookie|secret|authenticate\.riotgames/);
});
test('SSID header pasted as value is rejected before transmission', async () => {
  const { calls, fetcher } = fakeFetch();
  const result = await runRemoteProbe({ ...env, RIOT_SSID: 'ssid=private-cookie' }, 'auth', fetcher);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});
test('player probe reads one detail and reports only summaries', async () => {
  const { calls, fetcher } = fakeFetch();
  const result = await runRemoteProbe(env, 'player', fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 8);
  assert.equal(result.steps.find(s => s.endpoint === 'competitive-updates').summary.overlapWithHistory, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-|00000000/);
});
test('empty history marks availability unverified', async () => {
  const { fetcher } = fakeFetch({ empty: true });
  assert.match((await runRemoteProbe(env, 'player', fetcher)).note, /unverified/);
});
test('network errors cannot disclose secrets', async () => {
  const result = await runRemoteProbe(env, 'auth', async () => { throw Error('private-cookie'); });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /private-cookie/);
});
