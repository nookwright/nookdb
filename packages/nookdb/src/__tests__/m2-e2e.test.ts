import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, s, NookSchemaError, NookConflictError } from '../index.js';

describe('M2 end-to-end', () => {
  const schema = {
    users: s
      .collection({
        id: s.id(),
        email: s.string().email(),
        role: s.enum(['admin', 'user']),
      })
      .uniqueIndex('email')
      .index('role'),
  };

  it('schema -> insert -> index find -> conflict -> delete -> reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm2-'));
    const path = join(dir, 'app.db');
    let db = await open(path, { schema });

    await db.users.insert({ email: 'a@b.com', role: 'admin' });
    await db.users.insert({ email: 'c@d.com', role: 'user' });

    const admins = await db.users.find({ role: 'admin' });
    expect(admins).toHaveLength(1);
    // noUncheckedIndexedAccess: length-narrowed above so [0] is non-null
    expect(admins[0]!.email).toBe('a@b.com');

    await expect(db.users.insert({ email: 'x', role: 'admin' })).rejects.toBeInstanceOf(
      NookSchemaError,
    ); // not an email

    await expect(db.users.insert({ email: 'a@b.com', role: 'user' })).rejects.toBeInstanceOf(
      NookConflictError,
    ); // unique violation

    expect(await db.users.delete({ role: 'user' })).toBe(1);
    expect(await db.users.count({})).toBe(1);
    db.close();

    db = await open(path, { schema });
    expect(await db.users.count({})).toBe(1); // persisted
    db.close();
  });

  it('on-disk document bytes are valid JSON (debuggability goal)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm2j-'));
    const path = join(dir, 'app.db');
    const db = await open(path, { schema });
    await db.users.insert({ email: 'j@k.com', role: 'admin' });
    db.close();
    const raw = await open(path); // bytes-only handle still works
    const entries = await raw.listCollection('users');
    // noUncheckedIndexedAccess: listCollection returned ≥1 entry per insert above
    // void cast suppresses no-unsafe-return: JSON.parse returns `any` but the
    // test only cares that no exception is thrown, not the parsed value.
    expect(() => { void JSON.parse(entries[0]!.value.toString('utf8')); }).not.toThrow();
    raw.close();
  });

  // ── Task-11 carry-forward: M1 bytes round-trip post-DbHandle-refactor ─────────
  //
  // Exercises put/get/delete/listCollection on the bytes-only open(path) handle
  // AFTER Task 11's get_inner→get_db/DbHandle NAPI refactor, confirming M1 bytes
  // ops are intact end-to-end against the real .node. M1's database.test.ts
  // predates the refactor's binding wiring; this is the only executing test that
  // re-confirms it.
  it('M1 bytes round-trip: put/get/delete/listCollection intact after Task-11 refactor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm2-bytes-'));
    const path = join(dir, 'bytes.db');
    const db = await open(path);

    // put then get
    await db.put('things', Buffer.from('k1'), Buffer.from('hello'));
    const got = await db.get('things', Buffer.from('k1'));
    expect(got).not.toBeNull();
    expect(got!.toString('utf8')).toBe('hello');

    // listCollection sees the entry
    const before = await db.listCollection('things');
    expect(before).toHaveLength(1);
    expect(before[0]!.key.toString('utf8')).toBe('k1');
    expect(before[0]!.value.toString('utf8')).toBe('hello');

    // delete returns true; second delete returns false
    const deleted = await db.delete('things', Buffer.from('k1'));
    expect(deleted).toBe(true);
    const deletedAgain = await db.delete('things', Buffer.from('k1'));
    expect(deletedAgain).toBe(false);

    // listCollection is now empty
    const after = await db.listCollection('things');
    expect(after).toHaveLength(0);

    db.close();
  });
});
