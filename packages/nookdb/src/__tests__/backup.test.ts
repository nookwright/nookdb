import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, s } from '../index.js';

describe('Database.backup / .restore round-trip', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nook-backup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('backs up and restores via method form', async () => {
    const schema = {
      users: s.collection({ id: s.id(), email: s.string().email() }).uniqueIndex('email'),
    };
    const db1 = await open(join(dir, 'src.db'), { schema });
    await db1.users.insert({ id: 'alice', email: 'a@x.com' });
    await db1.users.insert({ id: 'bob',   email: 'b@x.com' });

    const bk = await db1.backup(join(dir, 'snap.nbkp'));
    expect(bk.entryCount).toBeGreaterThanOrEqual(2);
    expect(bk.bytesWritten).toBeGreaterThan(0);

    db1.close();

    const db2 = await open(join(dir, 'dst.db'), { schema });
    const rs = await db2.restore(join(dir, 'snap.nbkp'));
    expect(rs.entryCount).toBe(bk.entryCount);

    const all = await db2.users.find();
    expect(all.map(u => u.id).sort()).toEqual(['alice', 'bob']);
    db2.close();
  });
});
