import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds pro-players.json, the pro library's static search index.
//
//   node scripts/build-pro-player-library.mjs [vct-2026-data-analysis] [rostermania]
//
// Accounts (handle, PUUIDs, country) come from the sibling
// vct-2026-data-analysis project's trackerLinks.json when it is present;
// otherwise the current pro-players.json is the account base, since that
// project no longer ships src/lib (checked 22 Nov 2026).
//
// Team info comes from the sibling rostermania project
// (data/rostermania.json, the VCT 2027 off-season tracker), on request
// (22 Nov 2026): a pro gets a team only when they are on a **partnered**
// team's current roster there (status stay, join or open, confirmed or
// rumored; rumored moves count like announced ones, unmarked, on request). Everyone else has no team and the library lists them under
// "Other players", keeping their 2026 region for the region filter.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const vctRoot = resolve(process.argv[2] || join(repoRoot, '..', 'vct-2026-data-analysis'));
const rosterRoot = resolve(process.argv[3] || join(repoRoot, '..', 'rostermania'));
const trackerPath = join(vctRoot, 'src', 'lib', 'trackerLinks.json');
const bucketsPath = join(vctRoot, 'public', 'data', 'player_buckets.json');
const rosterPath = join(rosterRoot, 'data', 'rostermania.json');
const outputPath = join(repoRoot, 'pro-players.json');

const PUUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION_NAMES = { AMER: 'Americas', EMEA: 'EMEA', APAC: 'Pacific', CN: 'China' };
const CURRENT = new Set(['stay', 'join', 'open']);
const fold = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('en');

async function loadAccountBase() {
  if (existsSync(trackerPath)) {
    const [trackerLinks, playerBuckets] = await Promise.all([
      readFile(trackerPath, 'utf8').then(JSON.parse),
      readFile(bucketsPath, 'utf8').then(JSON.parse),
    ]);
    const metaByHandle = new Map(Object.entries(playerBuckets.meta || {}).map(([handle, meta]) => [fold(handle), meta]));
    return {
      source: 'vct-2026-data-analysis/src/lib/trackerLinks.json',
      players: Object.entries(trackerLinks).map(([handle, accounts]) => {
        const meta = metaByHandle.get(fold(handle)) || {};
        return { handle, region: meta.region || null, countryCode: meta.countryCode || null, accounts };
      }),
    };
  }
  const current = JSON.parse(await readFile(outputPath, 'utf8'));
  return {
    source: current.source,
    // Rebuilds start from each pro's own 2026 region, not the team region a previous run set.
    players: current.players.map(player => ({ ...player, region: 'baseRegion' in player ? player.baseRegion : player.region ?? null })),
  };
}

const [base, roster] = await Promise.all([loadAccountBase(), readFile(rosterPath, 'utf8').then(JSON.parse)]);
const teams = new Map(roster.teams.map(team => [team.code, team]));
const onPartnerRoster = new Map();
for (const entry of roster.entries) {
  const team = teams.get(entry.team);
  if (entry.kind !== 'player' || !CURRENT.has(entry.status) || !team?.partner) continue;
  if (onPartnerRoster.has(fold(entry.name))) throw new Error(`${entry.name} is on two partnered rosters`);
  onPartnerRoster.set(fold(entry.name), { entry, team });
}
// Every current player on any rostermania roster, partnered or not, is a pro
// the library expects to have (on request, 23 Nov 2026). Non-partnered teams
// only count toward that expectation; they never give a player a team.
const onAnyRoster = new Map(onPartnerRoster);
for (const entry of roster.entries) {
  const team = teams.get(entry.team);
  if (entry.kind !== 'player' || !CURRENT.has(entry.status) || !team || onAnyRoster.has(fold(entry.name))) continue;
  onAnyRoster.set(fold(entry.name), { entry, team });
}

const players = base.players
  .map(player => {
    const accounts = player.accounts
      .filter(({ puuid }) => PUUID_RE.test(puuid || ''))
      .map(({ puuid }) => ({ puuid: puuid.toLowerCase() }));
    const match = onPartnerRoster.get(fold(player.handle));
    return {
      handle: match?.entry.name || player.handle,
      team: match?.team.name || null,
      teamCode: match?.team.code || null,
      region: match ? REGION_NAMES[match.team.region] || null : player.region || null,
      baseRegion: player.region || null,
      countryCode: match?.entry.country || player.countryCode || null,
      accounts,
    };
  })
  .filter(player => player.accounts.length)
  .sort((a, b) => a.handle.localeCompare(b.handle, 'en', { sensitivity: 'base' }));

const accountCount = players.reduce((total, player) => total + player.accounts.length, 0);
const output = {
  source: base.source,
  rosterSource: 'rostermania/data/rostermania.json',
  rosterUpdatedAt: roster.updatedAt,
  playerCount: players.length,
  accountCount,
  resolvedPuuidCount: accountCount,
  partnerPlayerCount: players.filter(player => player.teamCode).length,
  ...expectedCounts(),
  players,
};

function expectedCounts() {
  const listed = new Set(players.map(player => fold(player.handle)));
  const expected = [...onAnyRoster.values()];
  const expectedListed = expected.filter(({ entry }) => listed.has(fold(entry.name))).length;
  return {
    expectedPlayerCount: expected.length,
    expectedPartnerPlayerCount: onPartnerRoster.size,
    expectedListedCount: expectedListed,
    expectedMissingCount: expected.length - expectedListed,
  };
}

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const missingFrom = rosters => [...rosters.values()]
  .filter(({ entry, team }) => (rosters === onPartnerRoster || !team.partner) && !players.some(player => fold(player.handle) === fold(entry.name)));
const missingPartner = missingFrom(onPartnerRoster);
const missingOther = missingFrom(onAnyRoster);
const listMissing = missing => missing.map(({ entry, team }) => `${entry.name} (${team.code})`).join(', ');
console.log(`Wrote ${players.length} pros / ${accountCount} accounts to ${outputPath}; ${output.partnerPlayerCount} on partnered rosters.`);
console.log(`Expected ${output.expectedPlayerCount} rostermania players (${output.expectedPartnerPlayerCount} partnered); ${output.expectedListedCount} listed, ${output.expectedMissingCount} without a known PUUID.`);
console.log(`${missingPartner.length} partnered-roster players have no known PUUID: ${listMissing(missingPartner)}`);
console.log(`${missingOther.length} non-partnered-roster players have no known PUUID: ${listMissing(missingOther)}`);
