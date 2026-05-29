import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, s } from '../index.js';

describe('M3 reactive E2E', () => {
  it('live() emits initial, tracks insert + delete, then disposes; reopen persists', async () => {
    const schema = {
      users: s
        .collection({ id: s.id(), role: s.enum(['admin', 'user'] as const) })
        .index('role'),
    };
    const dir = mkdtempSync(join(tmpdir(), 'nook-m3-'));
    const path = join(dir, 'app.db');
    const db = await open(path, { schema });

    await db.users.insert({ role: 'admin' });

    const lq = db.users.live({ role: 'admin' });
    const snaps: number[] = [];
    const off = lq.subscribe((v) => snaps.push(v.length));
    await vi.waitFor(() => expect(snaps.at(-1)).toBe(1)); // initial: 1 admin

    await db.users.insert({ role: 'admin' });
    await vi.waitFor(() => expect(snaps.at(-1)).toBe(2));

    const admins = await db.users.find({ role: 'admin' });
    // noUncheckedIndexedAccess: guard via toBeDefined then use !
    const first = admins[0];
    expect(first).toBeDefined();
    await db.users.delete({ id: first!.id });
    await vi.waitFor(() => expect(snaps.at(-1)).toBe(1));

    off();
    lq.dispose();
    db.close();

    // Reopen: data persisted, live layer left storage intact.
    const db2 = await open(path, { schema });
    expect(await db2.users.count({ role: 'admin' })).toBe(1);
    db2.close();
  });

  it('returns sorted + paginated results end-to-end', async () => {
    const schema = {
      tasks: s.collection({
        id: s.id(),
        title: s.string(),
        priority: s.number().int(),
      }),
    };
    const dir = mkdtempSync(join(tmpdir(), 'nook-m3-sort-'));
    const path = join(dir, 'app.db');
    const db = await open(path, { schema });

    // Insert out of order so sorting is genuinely exercised.
    await db.tasks.insert({ title: 'c', priority: 3 });
    await db.tasks.insert({ title: 'a', priority: 1 });
    await db.tasks.insert({ title: 'b', priority: 2 });
    await db.tasks.insert({ title: 'd', priority: 4 });

    // Sorted ascending, skip the smallest, take the next two: 2nd + 3rd smallest.
    const page = await db.tasks.find({}, { sort: { priority: 'asc' }, offset: 1, limit: 2 });
    expect(page.map((r) => r.priority)).toEqual([2, 3]);

    // Sorted descending, first row is the max.
    const first = await db.tasks.findOne({}, { sort: { priority: 'desc' } });
    expect(first?.priority).toBe(4);

    // limit caps the count even though 4 docs match.
    const capped = await db.tasks.count({}, { limit: 2 });
    expect(capped).toBe(2);

    db.close();
  });
});
