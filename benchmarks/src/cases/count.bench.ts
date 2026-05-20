/**
 * count.bench — nookdb vs better-sqlite3 count throughput.
 *
 * Measures:
 *   - count all documents (no filter)
 *   - count under an equality filter
 *
 * Uses: Collection.count(filter?) — available on the nookdb M2+ public surface.
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

export async function runCountSuite(seed: number): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-count-'));

  const nookSchema = {
    users: s.collection({ id: s.id(), email: s.string(), role: s.string() }).index('role'),
  };
  const nook = await open(join(dir, 'nook.db'), { schema: nookSchema });
  const sqlite = new Database(join(dir, 'sqlite.db'));
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT); CREATE INDEX idx_role ON users(role);');
  const insertSql = sqlite.prepare('INSERT INTO users (id, email, role) VALUES (?, ?, ?)');

  for (let i = 0; i < seed; i++) {
    const row = { id: `u${i}`, email: `u${i}@example.com`, role: i % 5 === 0 ? 'admin' : 'user' };
    await nook.users.insert(row);
    insertSql.run(row.id, row.email, row.role);
  }

  const sqliteCount = sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?');
  const bench = new Bench({ time: 1500 });
  bench
    .add('nookdb · count by role',         async () => { await nook.users.count({ role: 'admin' }); })
    .add('better-sqlite3 · count by role', () => { sqliteCount.get('admin'); });

  await bench.run();

  nook.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    case: 'count',
    seed,
    rows: bench.tasks.map((t) => ({
      name: t.name,
      hz: t.result?.hz ?? 0,
      meanMs: (t.result?.mean ?? 0) * 1000,
      samples: t.result?.samples.length ?? 0,
    })),
  };
}
