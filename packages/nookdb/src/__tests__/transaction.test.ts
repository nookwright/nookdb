import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { open } from '../index.js';
import { s } from '../schema/s.js';
import { NookTransactionError } from '../errors.js';

const schema = {
  users: s.collection({
    id: s.id(),
    email: s.string().email(),
    age: s.number().int().min(0).optional(),
  }).uniqueIndex('email'),
};

// Returns both the .db file path AND the parent tmp dir, so cleanup uses
// the dir ref directly (Windows-safe — does not depend on path separator).
function freshDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nookdb-tx-'));
  return { path: join(dir, 'app.db'), dir };
}

describe('db.transaction', () => {
  it('commits both inserts atomically on return', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.transaction(async (tx) => {
        await tx.users.insert({ email: 'a@b.c' });
        await tx.users.insert({ email: 'b@b.c' });
      });
      const all = await db.users.find();
      expect(all).toHaveLength(2);
      expect(all.map((u) => u.email).sort()).toEqual(['a@b.c', 'b@b.c']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back all inserts when the callback throws', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'pre-existing@b.c' });
      await expect(
        db.transaction(async (tx) => {
          await tx.users.insert({ email: 'tx-insert@b.c' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const all = await db.users.find();
      expect(all).toHaveLength(1);
      expect(all[0]?.email).toBe('pre-existing@b.c');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects nested transactions with NookTransactionError', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await expect(
        db.transaction(async () => {
          await db.transaction(async () => {
            // unreachable
          });
        }),
      ).rejects.toThrow(NookTransactionError);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skip('read-after-write inside the txn sees pre-tx snapshot (documented M6 limitation)', async () => {
    // Memory pointer: m5b-docs-api-drift + M5c-engineering spec §9.
    // M6 retrofit will add in-tx read-after-write visibility via a
    // Rust-side WriteTxn-aware read helper.
  });
});
