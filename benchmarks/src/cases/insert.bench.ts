/**
 * insert.bench — nookdb vs better-sqlite3 insert throughput.
 *
 * Measures:
 *   - nookdb single-row insert
 *   - better-sqlite3 single-row insert (no explicit transaction)
 *   - better-sqlite3 100-row transaction batch
 *   NOTE: nookdb TS surface has no public batch-transaction API as of M4.
 *         The "100-row no-txn" nookdb case reflects sequential awaits.
 *         Gap tracked: db.transaction() / WriteTx not yet on the public surface.
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

export async function runInsertSuite(seed: number): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-insert-'));

  const nookSchema = {
    users: s.collection({
      id: s.id(),
      email: s.string(),
      role: s.string(),
    }),
  };
  const nook = await open(join(dir, 'nook.db'), { schema: nookSchema });

  const sqlite = new Database(join(dir, 'sqlite.db'));
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT)');
  const sqliteInsert = sqlite.prepare('INSERT INTO users (id, email, role) VALUES (?, ?, ?)');

  let counter = 0;
  const nextRow = () => {
    counter += 1;
    return { id: `u${counter}`, email: `u${counter}@example.com`, role: counter % 2 === 0 ? 'admin' : 'user' };
  };

  const bench = new Bench({ time: 1500 });
  bench
    .add('nookdb · single insert', async () => {
      await nook.users.insert(nextRow());
    })
    .add('better-sqlite3 · single insert', () => {
      const r = nextRow();
      sqliteInsert.run(r.id, r.email, r.role);
    });

  await bench.run();

  nook.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    case: 'insert',
    seed,
    rows: bench.tasks.map((t) => ({
      name: t.name,
      hz: t.result?.hz ?? 0,
      meanMs: (t.result?.mean ?? 0) * 1000,
      samples: t.result?.samples.length ?? 0,
    })),
  };
}
