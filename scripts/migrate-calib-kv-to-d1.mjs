// One-off migration: turns a dumped `calibmodel` KV value (the JSON blob the
// old KV-backed calibration store used — {bands:[{lo,hi,n_win,n_loss,Sww,...}],
// updatedAt}) into SQL that sets calib_bands (the D1 replacement, see
// schema.sql) to those same values, instead of starting back at 0.
//
// Usage:
//   npx wrangler kv key get "calibmodel" --namespace-id=<KV_NAMESPACE_ID> --remote > calibmodel.json
//   node scripts/migrate-calib-kv-to-d1.mjs calibmodel.json > migrate.sql
//   npx wrangler d1 execute <D1_DB_NAME> --remote --file=migrate.sql
//
// Safe to run more than once — it's a plain UPDATE of the pre-seeded rows,
// not an accumulate.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node migrate-calib-kv-to-d1.mjs <calibmodel.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(path, "utf8"));
const bands = raw.bands || raw; // tolerate either the wrapper or a bare array
if (!Array.isArray(bands) || !bands.length) {
  console.error("No bands found in", path);
  process.exit(1);
}

const num = (v) => (Number.isFinite(v) ? v : 0);
const now = new Date().toISOString();

for (const b of bands) {
  console.log(
    `UPDATE calib_bands SET ` +
      `n_win=${num(b.n_win)}, n_loss=${num(b.n_loss)}, ` +
      `Sww=${num(b.Sww)}, Sll=${num(b.Sll)}, Swz=${num(b.Swz)}, Slz=${num(b.Slz)}, ` +
      `Szz=${num(b.Szz)}, Swy=${num(b.Swy)}, Sly=${num(b.Sly)}, Szy=${num(b.Szy)}, ` +
      `updated_at='${now}' ` +
      `WHERE lo=${num(b.lo)};`
  );
}
