import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const sourceRoot = resolve(process.argv[2] || join(repoRoot, '..', 'vct-2026-data-analysis'));
const trackerPath = join(sourceRoot, 'src', 'lib', 'trackerLinks.json');
const bucketsPath = join(sourceRoot, 'public', 'data', 'player_buckets.json');
const outputPath = join(repoRoot, 'pro-players.json');

const [trackerLinks, playerBuckets] = await Promise.all([
  readFile(trackerPath, 'utf8').then(JSON.parse),
  readFile(bucketsPath, 'utf8').then(JSON.parse),
]);

const metaByHandle = new Map(
  Object.entries(playerBuckets.meta || {}).map(([handle, meta]) => [handle.toLocaleLowerCase('en'), meta]),
);

const players = Object.entries(trackerLinks)
  .map(([handle, accounts]) => {
    const meta = metaByHandle.get(handle.toLocaleLowerCase('en')) || {};
    return {
      handle,
      team: meta.team || null,
      region: meta.region || null,
      countryCode: meta.countryCode || null,
      accounts: accounts.map(({ puuid, riotId }) => ({
        puuid: puuid || null,
        riotId,
        trackerUrl: `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(riotId)}`,
      })),
    };
  })
  .sort((a, b) => a.handle.localeCompare(b.handle, 'en', { sensitivity: 'base' }));

const accountCount = players.reduce((total, player) => total + player.accounts.length, 0);
const resolvedCount = players.reduce(
  (total, player) => total + player.accounts.filter(account => account.puuid).length,
  0,
);
const output = {
  source: 'vct-2026-data-analysis/src/lib/trackerLinks.json',
  playerCount: players.length,
  accountCount,
  resolvedPuuidCount: resolvedCount,
  players,
};

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Wrote ${players.length} pros / ${accountCount} accounts to ${outputPath} (${resolvedCount} PUUIDs).`);
