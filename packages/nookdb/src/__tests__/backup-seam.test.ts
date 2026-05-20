// packages/nookdb/src/__tests__/backup-seam.test.ts
//
// Pre-1.0 extension §M5 mirror — uses the FREESTANDING orchestrator
// helpers (`backupToPath` / `restoreFromPath`) and only public root
// imports (`nookdb`). An external integrator may attach to this
// same surface without touching the MIT core.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupToPath, open, restoreFromPath, s } from '../index.js';

describe('seam: backup → mutate → restore via public API', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-seam-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips state via freestanding helpers', async () => {
    const schema = {
      users: s.collection({ id: s.id(), email: s.string().email() }).uniqueIndex('email'),
    };
    const db = await open(join(dir, 'orig.db'), { schema });

    await db.users.insert({ id: 'alice', email: 'a@x.com' });
    await db.users.insert({ id: 'bob',   email: 'b@x.com' });

    const stats = await backupToPath(db, join(dir, 'snap.nbkp'));
    expect(stats.entryCount).toBeGreaterThanOrEqual(2);

    await db.users.insert({ id: 'charlie', email: 'c@x.com' });
    await db.users.delete({ id: 'alice' });

    await restoreFromPath(db, join(dir, 'snap.nbkp'), { allowOverwrite: true });

    const all = await db.users.find();
    expect(all.map(u => u.id).sort()).toEqual(['alice', 'bob']);
    db.close();
  });
});
