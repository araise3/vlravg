import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProPlayers, mergeTrackedPlayers, proPlayersFromLibrary } from '../.github/scripts/refresh-rr-history.mjs';

test('the committed pro library supplies every resolved account to the refresh queue', async () => {
  const players = await loadProPlayers();
  assert.equal(players.length, 416);
  assert.equal(new Set(players.map(player => player.puuid)).size, players.length);
  assert.ok(players.every(player => player.platform === 'pc'));
  assert.ok(players.some(player => player.pro_handle === 'zekken'
    && player.puuid === '57bf3aff-d0e2-5ef3-a446-1fcfe199853d'));
  assert.ok(players.some(player => player.pro_handle === 'aspas'
    && player.puuid === '56e7a83e-b9c0-59c9-8485-0254134dbacf'));
});

test('invalid and duplicate library accounts are ignored', () => {
  const puuid = '57bf3aff-d0e2-5ef3-a446-1fcfe199853d';
  const players = proPlayersFromLibrary({ players: [
    { handle: 'first', accounts: [{ puuid: puuid.toUpperCase(), riotId: 'First#ONE' }] },
    { handle: 'duplicate', accounts: [{ puuid, riotId: 'Duplicate#TWO' }] },
    { handle: 'missing', accounts: [{ puuid: null, riotId: 'Missing#ID' }] },
    { handle: 'bad', accounts: [{ puuid: 'not-a-puuid', riotId: 'Bad#ID' }] },
  ] });
  assert.deepEqual(players, [{ puuid, platform: 'pc', pro_handle: 'first', riot_id: 'First#ONE' }]);
});

test('stored tracking state wins when a pro is already enrolled', () => {
  const puuid = '57bf3aff-d0e2-5ef3-a446-1fcfe199853d';
  const merged = mergeTrackedPlayers(
    [{ puuid, region: 'na', platform: 'pc', name: 'MIBR zekken', tag: '1515' }],
    [{ puuid, platform: 'pc', pro_handle: 'zekken', riot_id: 'MIBR zekken#1515' }],
  );
  assert.deepEqual(merged, [{
    puuid,
    platform: 'pc',
    pro_handle: 'zekken',
    riot_id: 'MIBR zekken#1515',
    region: 'na',
    name: 'MIBR zekken',
    tag: '1515',
  }]);
});

test('the committed pro library counts non-partnered roster players as expected without giving them teams', async () => {
  const { readFile } = await import('node:fs/promises');
  const library = JSON.parse(await readFile(new URL('../pro-players.json', import.meta.url), 'utf8'));
  assert.equal(library.expectedPlayerCount, 389);
  assert.equal(library.expectedPartnerPlayerCount, 153);
  assert.equal(library.expectedListedCount + library.expectedMissingCount, library.expectedPlayerCount);
  assert.ok(library.expectedPlayerCount > library.expectedPartnerPlayerCount);
  assert.ok(library.expectedListedCount > library.partnerPlayerCount, 'non-partnered roster players count as listed');
  // kolosha is on NAVI, a non-partnered rostermania roster: expected, but still teamless.
  const kolosha = library.players.find(player => player.handle === 'kolosha');
  assert.equal(kolosha.team, null);
  assert.equal(kolosha.teamCode, null);
});
