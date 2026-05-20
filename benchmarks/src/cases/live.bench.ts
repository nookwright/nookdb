/**
 * live.bench — nookdb reactive LiveQuery throughput (nookdb-only).
 *
 * Measures:
 *   - 1 insert + emit cycle: how quickly a committed write propagates to a
 *     subscribed LiveQuery and its subscriber callback fires. A setImmediate
 *     yield after each insert lets the coalesced emit land before the next
 *     iteration — coarse but representative of the real wall-clock cost.
 *
 * better-sqlite3 has no reactive equivalent; this case is nookdb-only.
 * Uses: Collection.live(filter?) → LiveQuery — available on the nookdb M3+
 * public surface.
 *
 * Filled in T16.
 */

import { Bench } from 'tinybench';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, s } from 'nookdb';

export interface SuiteResult {
  case: string;
  seed: number;
  rows: Array<{ name: string; hz: number; meanMs: number; samples: number }>;
}

export async function runLiveSuite(seed: number): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-live-'));

  const nookSchema = {
    items: s.collection({ id: s.id(), value: s.number() }).index('value'),
  };
  const nook = await open(join(dir, 'nook.db'), { schema: nookSchema });

  // Seed
  for (let i = 0; i < seed; i++) {
    await nook.items.insert({ id: `i${i}`, value: i });
  }

  const lq = nook.items.live({});
  const off = lq.subscribe(() => {
    // Subscriber drains the snapshot; no work here so the bench measures
    // just the commit→emit cost.
  });

  const bench = new Bench({ time: 2000 });
  bench.add('nookdb · live() — 1 insert + emit', async () => {
    await nook.items.insert({ id: `extra-${Math.random().toString(36).slice(2)}`, value: -1 });
    // Wait one tick so the emit lands (coalesced) — coarse but representative.
    await new Promise((r) => setImmediate(r));
  });

  await bench.run();

  off();
  lq.dispose();
  nook.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    case: 'live',
    seed,
    rows: bench.tasks.map((t) => ({
      name: t.name,
      hz: t.result?.hz ?? 0,
      meanMs: (t.result?.mean ?? 0) * 1000,
      samples: t.result?.samples.length ?? 0,
    })),
  };
}
