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
});
