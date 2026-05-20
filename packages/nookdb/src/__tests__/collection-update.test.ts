import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { open } from '../index.js';
import { s } from '../schema/s.js';
import { NookSchemaError, NookTransactionError } from '../errors.js';

const schema = {
  users: s.collection({
    id: s.id(),
    email: s.string().email(),
    role: s.enum(['admin', 'user']),
  }).uniqueIndex('email'),
};

// Returns both the .db file path AND the parent tmp dir, so cleanup uses
// the dir ref directly (Windows-safe — does not depend on path separator).
function freshDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nookdb-update-'));
  return { path: join(dir, 'app.db'), dir };
}

describe('Collection.update', () => {
  it('updates each matched doc and returns the count', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'a@b.c', role: 'user' });
      await db.users.insert({ email: 'b@b.c', role: 'user' });
      await db.users.insert({ email: 'c@b.c', role: 'admin' });

      const n = await db.users.update({ role: 'user' }, { role: 'admin' });
      expect(n).toBe(2);

      const admins = await db.users.find({ role: 'admin' });
      expect(admins).toHaveLength(3);
      const users = await db.users.find({ role: 'user' });
      expect(users).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 and writes nothing when no doc matches', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'a@b.c', role: 'user' });
      const before = await db.users.find();
      const n = await db.users.update({ role: 'admin' }, { role: 'user' });
      expect(n).toBe(0);
      const after = await db.users.find();
      expect(after).toEqual(before);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws NookSchemaError when patch.id differs from a matched doc id (no partial state)', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'a@b.c', role: 'user' });
      const before = await db.users.find();
      const stableId = before[0]?.id ?? '';

      await expect(
        db.users.update({ role: 'user' }, { id: 'different-id' } as never),
      ).rejects.toThrow(NookSchemaError);

      const after = await db.users.find();
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(stableId);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws NookSchemaError when patch.id is explicitly undefined', async () => {
    // T7 review follow-up: locks the `'id' in patch && patch.id !== doc.id`
    // guard against a regression to `patch.id !== undefined && ...`.
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'a@b.c', role: 'user' });
      await expect(
        db.users.update({ role: 'user' }, { id: undefined } as never),
      ).rejects.toThrow(NookSchemaError);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back when validation fails on a merged doc', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'orig@b.c', role: 'user' });
      const before = await db.users.find();
      const origId = before[0]?.id ?? '';

      await expect(
        db.users.update({ role: 'user' }, { email: 'not-an-email-at-all' }),
      ).rejects.toThrow();

      const after = await db.users.find();
      expect(after).toHaveLength(1);
      expect(after[0]?.email).toBe('orig@b.c');
      expect(after[0]?.id).toBe(origId);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects concurrent updates on the same handle via the nested-tx guard', async () => {
    // Spec §3.1 (nested-transactions): each `update` opens a write-tx, and a
    // second top-level `transaction`/`update` on the same native handle while
    // one is in flight throws `NookTransactionError` synchronously (the
    // `inWriteTxnFlags` guard). Sum of resolved counts is exactly 1: the
    // first update sees the row as 'user' and flips it to 'admin'; the
    // second is rejected before it can read or write. This locks the
    // M5c Task 5 single-writer invariant against silent regression to
    // implicit JS-side queueing.
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.users.insert({ email: 'a@b.c', role: 'user' });
      const results = await Promise.allSettled([
        db.users.update({ role: 'user' }, { role: 'admin' }),
        db.users.update({ role: 'user' }, { role: 'admin' }),
      ]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]?.value).toBe(1);
      expect(rejected[0]?.reason).toBeInstanceOf(NookTransactionError);
      const all = await db.users.find();
      expect(all).toHaveLength(1);
      expect(all[0]?.role).toBe('admin');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
