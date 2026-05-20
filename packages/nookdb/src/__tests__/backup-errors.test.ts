import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, s, NookCorruptionError, NookStorageError } from '../index.js';

describe('backup/restore error mapping', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-bkerr-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('throws NookCorruptionError on invalid backup magic', async () => {
    const bad = join(dir, 'bad.nbkp');
    await writeFile(bad, Buffer.alloc(128, 0)); // zeros — bad magic
    const schema = { c: s.collection({ id: s.id() }) };
    const db = await open(join(dir, 'db.db'), { schema });
    await expect(db.restore(bad)).rejects.toBeInstanceOf(NookCorruptionError);
    db.close();
  });

  it('throws NookStorageError when the source backup file does not exist', async () => {
    const schema = { c: s.collection({ id: s.id() }) };
    const db = await open(join(dir, 'db.db'), { schema });
    await expect(db.restore(join(dir, 'absent.nbkp'))).rejects.toBeInstanceOf(NookStorageError);
    db.close();
  });
});
