// Daily check for a newer vrfkit release than the one parse-replays.yml pins.
// VALORANT changes the replay payload transform with every patch, so a new
// game build needs a new decoder; this opens one issue per release saying
// which builds it adds, so the pin can be reviewed and bumped. It never edits
// the workflow itself: new upstream code is read before it runs.
import { readFile } from 'node:fs/promises';

const UPSTREAM = 'yakisoba0728/vrfkit';
const API = 'https://api.github.com';
const LIB = 'crates/vrf-transform/src/lib.rs';

// "13.09"-style builds registered in a vrf-transform lib.rs.
export function registeredBuilds(source) {
  return [...source.matchAll(/^\s+V\d+ V\d+_\d+ "(\d+\.\d+)"/gm)].map(m => m[1]);
}

export function pinnedDecoder(workflow) {
  const revision = workflow.match(/^\s+VRFKIT_REVISION: ([0-9a-f]{40})$/m)?.[1];
  const patch = workflow.match(/^\s+VRFKIT_PATCH: (\S*)$/m)?.[1]?.replace(/^''$/, '') || '';
  if (!revision) throw new Error('VRFKIT_REVISION not found');
  return { revision, patch };
}

// Returns the issue to open, or null when the pin is current.
export function plan({ pinned, release, releaseSha, pinnedBuilds, releaseBuilds }) {
  if (releaseSha === pinned.revision) return null;
  const added = releaseBuilds.filter(build => !pinnedBuilds.includes(build));
  const title = `vrfkit ${release} is available${added.length ? ` (adds ${added.join(', ')})` : ''}`;
  const body = [
    `[vrfkit ${release}](https://github.com/${UPSTREAM}/releases/tag/${release}) (\`${releaseSha}\`) is newer than the pinned \`${pinned.revision}\`.`,
    '',
    `- Builds in the release: ${releaseBuilds.join(', ')}`,
    `- Builds new to this pin: ${added.join(', ') || 'none'}`,
    pinned.patch ? `- The pin is patched with \`${pinned.patch}\`. If the release contains that patch's build, drop the patch.` : '- The pin is unpatched.',
    '',
    'To update: review the release diff, set `VRFKIT_REVISION` in `.github/workflows/parse-replays.yml`, adjust `VRFKIT_PATCH`, and update the tests. Pushing the change runs the parser, which retries uploads the previous decoder could not read.',
  ].join('\n');
  return { title, body };
}

async function github(path, token, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vlravg-vrfkit-watch',
    ...(token && { Authorization: `Bearer ${token}` }), ...init.headers } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function raw(ref, token) {
  const file = await github(`/repos/${UPSTREAM}/contents/${LIB}?ref=${ref}`, token);
  return Buffer.from(file.content, 'base64').toString('utf8');
}

if (process.argv[1]?.endsWith('vrfkit-watch.mjs')) {
  const token = process.env.GITHUB_TOKEN;
  const pinned = pinnedDecoder(await readFile('.github/workflows/parse-replays.yml', 'utf8'));
  const release = (await github(`/repos/${UPSTREAM}/releases/latest`, token)).tag_name;
  const releaseSha = (await github(`/repos/${UPSTREAM}/commits/${release}`, token)).sha;
  const issue = plan({ pinned, release, releaseSha,
    pinnedBuilds: registeredBuilds(await raw(pinned.revision, token)), releaseBuilds: registeredBuilds(await raw(releaseSha, token)) });
  if (!issue) console.log(`Pinned vrfkit ${pinned.revision} is the latest release (${release}).`);
  else {
    const repo = process.env.GITHUB_REPOSITORY;
    const open = await github(`/repos/${repo}/issues?state=open&per_page=100`, token);
    if (open.some(existing => existing.title === issue.title)) console.log(`Already open: ${issue.title}`);
    else {
      await github(`/repos/${repo}/issues`, token, { method: 'POST', body: JSON.stringify(issue), headers: { 'Content-Type': 'application/json' } });
      console.log(`Opened: ${issue.title}`);
    }
  }
}
