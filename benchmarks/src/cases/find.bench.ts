/**
 * find.bench — nookdb vs better-sqlite3 find/query throughput.
 *
 * Measures:
 *   - find by primary key (id equality)
 *   - find by secondary indexed field (equality filter)
 *   - full collection scan (no filter)
 *
 * Uses: Collection.find({ field: value }) — the operator-filter overload
 * available on the nookdb M2+ public surface.
 *
 * Filled in T15.
 */

import { Bench } from 'tinybench';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, s } from 'nookdb';

export interface SuiteResult {
  case: string;
  seed: number;
  rows: Array<{ name: string; hz: number; meanMs: number; samples: number }>;
}

export async function runFindSuite(seed: number): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-find-'));

  const nookSchema = {
    users: s
      .collection({ id: s.id(), email: s.string(), role: s.string() })
      .index('role'),
  };
  const nook = await open(join(dir, 'nook.db'), { schema: nookSchema });
  const sqlite = new Database(join(dir, 'sqlite.db'));
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT); CREATE INDEX idx_role ON users(role);');
  const sqliteInsert = sqlite.prepare('INSERT INTO users (id, email, role) VALUES (?, ?, ?)');

  for (let i = 0; i < seed; i++) {
    const row = { id: `u${i}`, email: `u${i}@example.com`, role: i % 5 === 0 ? 'admin' : 'user' };
    await nook.users.insert(row);
    sqliteInsert.run(row.id, row.email, row.role);
  }

  const targetId = `u${Math.floor(seed / 2)}`;
  const sqliteByPk = sqlite.prepare('SELECT * FROM users WHERE id = ?');
  const sqliteByRole = sqlite.prepare('SELECT * FROM users WHERE role = ?');
  const sqliteScan = sqlite.prepare('SELECT * FROM users');

  const bench = new Bench({ time: 1500 });
  bench
    .add('nookdb · find by id',              async () => { await nook.users.find({ id: targetId }); })
    .add('better-sqlite3 · find by id',      () => { sqliteByPk.get(targetId); })
    .add('nookdb · find by indexed role',    async () => { await nook.users.find({ role: 'admin' }); })
    .add('better-sqlite3 · by indexed role', () => { sqliteByRole.all('admin'); })
    .add('nookdb · full scan',               async () => { await nook.users.find(); })
    .add('better-sqlite3 · full scan',       () => { sqliteScan.all(); });

  await bench.run();

  nook.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    case: 'find',
    seed,
    rows: bench.tasks.map((t) => ({
      name: t.name,
      hz: t.result?.hz ?? 0,
      meanMs: (t.result?.mean ?? 0) * 1000,
      samples: t.result?.samples.length ?? 0,
    })),
  };
}
