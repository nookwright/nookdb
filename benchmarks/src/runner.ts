import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInsertSuite } from './cases/insert.bench.js';
import { runFindSuite } from './cases/find.bench.js';
import { runCountSuite } from './cases/count.bench.js';
import { runTransactionSuite } from './cases/transaction.bench.js';
import { runLiveSuite } from './cases/live.bench.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results.json');

interface SuiteResult {
  case: string;
  seed: number;
  rows: Array<{ name: string; hz: number; meanMs: number; samples: number }>;
}

// Seed sizes. The default `[1_000]` is the dev-machine quick run (<2 min).
// The CI Ubuntu runner (M5c) sets NOOK_BENCH_SEEDS=1000,10000,100000 for the
// canonical numbers. Local users wanting larger seeds can do the same:
//   NOOK_BENCH_SEEDS=1000,10000 pnpm --filter @nookdb/benchmarks run
function parseSeeds(): readonly number[] {
  const raw = process.env.NOOK_BENCH_SEEDS;
  if (!raw) return [1_000] as const;
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

async function main() {
  const seeds = parseSeeds();
  const results: SuiteResult[] = [];
  for (const seed of seeds) {
    results.push(await runInsertSuite(seed));
    results.push(await runFindSuite(seed));
    results.push(await runCountSuite(seed));
    results.push(await runTransactionSuite(seed));
    results.push(await runLiveSuite(seed));
  }

  const payload = {
    machine: { platform: process.platform, arch: process.arch, node: process.version },
    timestamp: new Date().toISOString(),
    results,
  };

  writeFileSync(RESULTS, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${RESULTS}`);

  for (const s of results) {
    console.log(`\n## ${s.case} (seed=${s.seed})`);
    for (const r of s.rows) {
      console.log(`  ${r.name.padEnd(28)} ${r.hz.toFixed(1).padStart(10)} hz   ${r.meanMs.toFixed(3).padStart(8)} ms/op   n=${r.samples}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
