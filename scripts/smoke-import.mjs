// Cross-platform smoke test used by build-matrix.yml.
// Verifies the NAPI binding loads and a minimal CRUD happy-path works.
//
// Usage (from repo root, after `pnpm build`):
//   node scripts/smoke-import.mjs
//
// Imports nookdb via a workspace-relative path so it works without `nookdb`
// being installed at the repo root.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nookdbEntry = path.resolve(__dirname, '..', 'packages', 'nookdb', 'dist', 'index.js');
const { open, s } = await import(pathToFileURL(nookdbEntry).href);

const dbPath = path.join(os.tmpdir(), 'nook-smoke-' + Date.now() + '.db');

const db = await open(dbPath, {
  schema: {
    items: s.collection({
      id: s.id(),
      v: s.number(),
    }),
  },
});

await db.items.insert({ id: 'a', v: 1 });
const all = await db.items.find({});

if (all.length !== 1) {
  console.error(`smoke FAILED: expected 1 item, got ${all.length}`);
  process.exit(1);
}

db.close();
console.log('smoke OK');
