import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  open,
  Database,
  NookClosedError,
  NookInvalidArgError,
} from '../index.js';

describe('Database (M1 end-to-end)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nookdb-e2e-'));
    dbPath = join(dir, 'test.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('open() returns a Database instance', async () => {
    const db = await open(dbPath);
    try {
      expect(db).toBeInstanceOf(Database);
    } finally {
      db.close();
    }
  });

  it('put + get round-trips a value', async () => {
    const db = await open(dbPath);
    try {
      await db.put('users', Buffer.from('u1'), Buffer.from('Ali'));
      const got = await db.get('users', Buffer.from('u1'));
      expect(got).not.toBeNull();
      expect(got!.toString()).toBe('Ali');
    } finally {
      db.close();
    }
  });

  it('get returns null for a missing key', async () => {
    const db = await open(dbPath);
    try {
      const got = await db.get('users', Buffer.from('missing'));
      expect(got).toBeNull();
    } finally {
      db.close();
    }
  });

  it('delete returns true when key existed, false otherwise', async () => {
    const db = await open(dbPath);
    try {
      await db.put('c', Buffer.from('k'), Buffer.from('v'));
      const r1 = await db.delete('c', Buffer.from('k'));
      expect(r1).toBe(true);
      const r2 = await db.delete('c', Buffer.from('k'));
      expect(r2).toBe(false);
    } finally {
      db.close();
    }
  });

  it('listCollection returns all entries for that collection', async () => {
    const db = await open(dbPath);
    try {
      await db.put('users', Buffer.from('u1'), Buffer.from('Ali'));
      await db.put('users', Buffer.from('u2'), Buffer.from('Veli'));
      await db.put('posts', Buffer.from('p1'), Buffer.from('Hello'));

      const users = await db.listCollection('users');
      expect(users).toHaveLength(2);
      const userMap = new Map(users.map((e) => [e.key.toString(), e.value.toString()]));
      expect(userMap.get('u1')).toBe('Ali');
      expect(userMap.get('u2')).toBe('Veli');

      const posts = await db.listCollection('posts');
      expect(posts).toHaveLength(1);
      expect(posts[0]!.key.toString()).toBe('p1');
    } finally {
      db.close();
    }
  });

  it('listCollection returns [] for an unknown collection', async () => {
    const db = await open(dbPath);
    try {
      const entries = await db.listCollection('nope');
      expect(entries).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('state persists across close + reopen', async () => {
    {
      const db = await open(dbPath);
      try {
        await db.put('c', Buffer.from('k'), Buffer.from('persistent'));
      } finally {
        db.close();
      }
    }
    {
      const db = await open(dbPath);
      try {
        const got = await db.get('c', Buffer.from('k'));
        expect(got).not.toBeNull();
        expect(got!.toString()).toBe('persistent');
      } finally {
        db.close();
      }
    }
  });

  it('operations after close throw NookClosedError', async () => {
    const db = await open(dbPath);
    db.close();
    await expect(db.put('c', Buffer.from('k'), Buffer.from('v'))).rejects.toBeInstanceOf(
      NookClosedError,
    );
    await expect(db.get('c', Buffer.from('k'))).rejects.toBeInstanceOf(NookClosedError);
    await expect(db.delete('c', Buffer.from('k'))).rejects.toBeInstanceOf(NookClosedError);
    await expect(db.listCollection('c')).rejects.toBeInstanceOf(NookClosedError);
  });

  it('empty collection name throws NookInvalidArgError', async () => {
    const db = await open(dbPath);
    try {
      await expect(db.put('', Buffer.from('k'), Buffer.from('v'))).rejects.toBeInstanceOf(
        NookInvalidArgError,
      );
    } finally {
      db.close();
    }
  });

  it('collection name with null byte throws NookInvalidArgError', async () => {
    const db = await open(dbPath);
    try {
      await expect(
        db.put('bad\0name', Buffer.from('k'), Buffer.from('v')),
      ).rejects.toBeInstanceOf(NookInvalidArgError);
    } finally {
      db.close();
    }
  });

  it('handles binary values (non-UTF8 bytes) round-trip', async () => {
    const db = await open(dbPath);
    try {
      const value = Buffer.from([0x00, 0xff, 0x42, 0x7f, 0x80]);
      await db.put('blobs', Buffer.from('b1'), value);
      const got = await db.get('blobs', Buffer.from('b1'));
      expect(got).not.toBeNull();
      expect(Buffer.compare(got!, value)).toBe(0);
    } finally {
      db.close();
    }
  });
});
