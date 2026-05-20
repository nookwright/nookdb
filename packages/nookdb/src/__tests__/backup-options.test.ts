import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, s, NookConflictError } from '../index.js';

describe('RestoreOptions defaults and flags', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-bkopts-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('throws NookConflictError when target DB is non-empty and allowOverwrite is false (default)', async () => {
    const schema = { users: s.collection({ id: s.id(), email: s.string().email() }) };
    const dbA = await open(join(dir, 'a.db'), { schema });
    await dbA.users.insert({ id: 'a', email: 'a@x.com' });
    await dbA.backup(join(dir, 'snap.nbkp'));
    dbA.close();

    const dbB = await open(join(dir, 'b.db'), { schema });
    await dbB.users.insert({ id: 'b', email: 'b@x.com' });

    await expect(dbB.restore(join(dir, 'snap.nbkp'))).rejects.toBeInstanceOf(NookConflictError);
    dbB.close();
  });

  it('replaces existing entries when allowOverwrite is true', async () => {
    const schema = { users: s.collection({ id: s.id(), email: s.string().email() }) };
    const dbA = await open(join(dir, 'a.db'), { schema });
    await dbA.users.insert({ id: 'a', email: 'a@x.com' });
    await dbA.backup(join(dir, 'snap.nbkp'));
    dbA.close();

    const dbB = await open(join(dir, 'b.db'), { schema });
    await dbB.users.insert({ id: 'b', email: 'b@x.com' });
    await dbB.restore(join(dir, 'snap.nbkp'), { allowOverwrite: true });

    const all = await dbB.users.find();
    expect(all.map(u => u.id).sort()).toEqual(['a']);
    dbB.close();
  });
});
