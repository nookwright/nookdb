import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { open } from '../index.js';
import { s, toDescriptor } from '../schema/s.js';

const schema = {
  notes: s.collection({
    id: s.id(),
    title: s.string().min(1).max(10).regex(/^[a-zA-Z ]+$/),
  }),
};

// Returns both the .db file path AND the parent tmp dir, so cleanup uses
// the dir ref directly (Windows-safe — does not depend on path separator).
function freshDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nookdb-strchain-'));
  return { path: join(dir, 'app.db'), dir };
}

describe('s.string() chain methods', () => {
  it('min: 1 rejects empty string', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await expect(db.notes.insert({ title: '' })).rejects.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('max: 10 rejects 11-char string', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await expect(db.notes.insert({ title: 'a'.repeat(11) })).rejects.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regex rejects digit-containing string', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await expect(db.notes.insert({ title: 'has 123' })).rejects.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a valid string matching all 3 constraints', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.notes.insert({ title: 'Hello' });
      const all = await db.notes.find();
      expect(all).toHaveLength(1);
      expect(all[0]?.title).toBe('Hello');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('descriptor carries min/max/regex on the field', () => {
    // White-box: build the schema, toDescriptor it, parse the JSON, check.
    interface RawFieldShape {
      name: string;
      type: string;
      min?: number;
      max?: number;
      regex?: string;
    }
    interface RawCollectionShape {
      fields: RawFieldShape[];
    }
    const desc = JSON.parse(toDescriptor(schema)) as Record<string, RawCollectionShape>;
    const titleField = desc.notes?.fields.find(
      (f) => f.name === 'title',
    );
    expect(titleField).toMatchObject({
      name: 'title',
      type: 'string',
      min: 1,
      max: 10,
      regex: '^[a-zA-Z ]+$',
    });
  });
});
