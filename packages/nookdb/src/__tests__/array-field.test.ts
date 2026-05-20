import { describe, expect, expectTypeOf, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { open } from '../index.js';
import { s, toDescriptor } from '../schema/s.js';

const schema = {
  notes: s.collection({
    id: s.id(),
    title: s.string(),
    tags: s.array(s.string()),
  }),
};

function freshDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nookdb-array-'));
  return { path: join(dir, 'app.db'), dir };
}

describe('s.array', () => {
  it('round-trips an array field through insert + find', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.notes.insert({ title: 'a', tags: ['rust', 'electron'] });
      const all = await db.notes.find();
      expect(all).toHaveLength(1);
      expect(all[0]?.tags).toEqual(['rust', 'electron']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles empty array', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await db.notes.insert({ title: 'b', tags: [] });
      const all = await db.notes.find();
      expect(all[0]?.tags).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects wrong item type (server-side validation)', async () => {
    const { path, dir } = freshDb();
    const db = await open(path, { schema });
    try {
      await expect(
        db.notes.insert({ title: 'c', tags: [123] as never }),
      ).rejects.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('infers tags: string[] at the TS type level', () => {
    type NoteDoc = typeof schema.notes.$type;
    expectTypeOf<NoteDoc['tags']>().toEqualTypeOf<string[]>();
  });

  it('emits the descriptor with nested items', () => {
    // Type the parsed shape so the `.find` callback below is not on `any`
    // (matches the ESLint flat-config rules for this package; see also the
    // pre-existing pattern in string-chains.test.ts which the M5c cleanup
    // pass will tighten).
    interface DescField {
      name: string;
      type: string;
      items?: DescField;
    }
    interface DescCollection {
      fields: DescField[];
    }
    const desc = JSON.parse(toDescriptor(schema)) as Record<string, DescCollection>;
    const tagsField = desc.notes?.fields.find((f) => f.name === 'tags');
    expect(tagsField).toMatchObject({
      name: 'tags',
      type: 'array',
      items: { name: '__item__', type: 'string' },
    });
  });
});
