/**
 * transaction.bench — read-modify-write loop comparison.
 *
 * Measures a loop of 100 read-modify-write operations:
 *   - nookdb: sequential awaits (findOne → delete → insert).
 *             NOTE: the nookdb TS public surface has no db.transaction(cb) or
 *             WriteTx wrapper as of M4. All collection ops (insert/findOne/
 *             delete/find/count/live) are top-level async methods; there is no
 *             batch-transaction API. This case therefore uses sequential awaits
 *             as the closest apples-to-apples approximation of the nookdb RMW
 *             workload. A future db.transaction(fn) API would let this switch
 *             to a real transaction and close the comparison.
 *   - better-sqlite3: db.transaction(fn)() wrapping the same 100 ops
 *
 * Filled in T16.
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

export async function runTransactionSuite(seed: number): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-tx-'));

  const nookSchema = {
    counters: s.collection({ id: s.id(), value: s.number() }),
  };
  const nook = await open(join(dir, 'nook.db'), { schema: nookSchema });
  const sqlite = new Database(join(dir, 'sqlite.db'));
  sqlite.exec('CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER)');
  const sqliteInsert = sqlite.prepare('INSERT INTO counters (id, value) VALUES (?, ?)');
  const sqliteSelect = sqlite.prepare('SELECT value FROM counters WHERE id = ?');
  const sqliteUpdate = sqlite.prepare('UPDATE counters SET value = ? WHERE id = ?');

  // Seed exactly 100 counters (seed param is unused for this case — the
  // transaction workload is fixed at N=100 to keep each bench iteration
  // predictable regardless of which seed the runner passes in).
  const N = 100;
  for (let i = 0; i < N; i++) {
    await nook.counters.insert({ id: `c${i}`, value: 0 });
    sqliteInsert.run(`c${i}`, 0);
  }

  const sqliteTx = sqlite.transaction(() => {
    for (let i = 0; i < N; i++) {
      const cur = sqliteSelect.get(`c${i}`) as { value: number };
      sqliteUpdate.run(cur.value + 1, `c${i}`);
    }
  });

  const bench = new Bench({ time: 2000 });
  bench
    // The nookdb TS surface lacks a `db.transaction(cb)` wrapper today;
    // this case approximates with sequential awaits + delete+insert (no
    // collection.update). Once the surface exposes db.transaction the
    // case will switch to that and become a true apples-to-apples.
    .add('nookdb · 100-doc RMW (sequential awaits)', async () => {
      for (let i = 0; i < N; i++) {
        const cur = await nook.counters.findOne({ id: `c${i}` });
        if (cur === null) continue;
        await nook.counters.delete({ id: `c${i}` });
        await nook.counters.insert({ id: `c${i}`, value: cur.value + 1 });
      }
    })
    .add('better-sqlite3 · 100-doc RMW tx', () => {
      sqliteTx();
    });

  await bench.run();

  nook.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    case: 'transaction',
    seed,
    rows: bench.tasks.map((t) => ({
      name: t.name,
      hz: t.result?.hz ?? 0,
      meanMs: (t.result?.mean ?? 0) * 1000,
      samples: t.result?.samples.length ?? 0,
    })),
  };
}
