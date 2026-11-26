// Parser job 2 of 3, after the sandbox: split each replay's output so the
// submit job can store the record before it downloads the large export
// (26 Nov 2026: downloading the 58 MB export first cost about 7 s of the wait).
//   <work>/parsed/<match>/export-files.json   [{name, bytes, sha256}]  small artifact
//   <work>/parsed-export/<match>/export/...   the export tables        large artifact
// Runs outside the sandbox. The export folder was unpacked through the
// allowlist (replay-unpack.py); only regular files are listed here, and the
// submit job validates the list again and checks every file against it.
//
// Usage: node replay-export-list.mjs <work dir>
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises';

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function splitExports(work) {
  let ids;
  try { ids = await readdir(`${work}/parsed`); } catch { return []; }
  const done = [];
  for (const id of ids) {
    const dir = `${work}/parsed/${id}/export`;
    let names;
    try { names = (await readdir(dir)).sort(); } catch { continue; }
    const files = [];
    for (const name of names) {
      const info = await lstat(`${dir}/${name}`);
      if (info.isFile()) files.push({ name, bytes: info.size, sha256: await sha256File(`${dir}/${name}`) });
    }
    await writeFile(`${work}/parsed/${id}/export-files.json`, JSON.stringify(files));
    await mkdir(`${work}/parsed-export/${id}`, { recursive: true });
    await rename(dir, `${work}/parsed-export/${id}/export`);
    done.push(id);
  }
  return done;
}

if (process.argv[1]?.endsWith('replay-export-list.mjs')) {
  const done = await splitExports(process.argv[2] || 'replay-work');
  console.log(`Listed ${done.length} export(s)`);
}
