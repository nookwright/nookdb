# @nookdb/benchmarks

Head-to-head benchmarks comparing nookdb to [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) on the same workload.

## Run

```bash
pnpm install
pnpm --filter @nookdb/benchmarks run
```

The runner writes `results.json` and prints a Markdown-friendly summary.

## Cases

| Case | What it measures |
| --- | --- |
| `insert` | Single-row, 100-row txn batch (sqlite only — nookdb TS surface has no batch tx yet), 100-row no-txn |
| `find` | Primary id, secondary index equality, full scan |
| `count` | Count under a filter |
| `transaction` | Read-modify-write loop of 100 docs |
| `live` | Initial snapshot + 1000 mutations (nookdb only) |

Each case runs across seed sizes of 1k / 10k / 100k rows.

## Methodology

- A fresh on-disk database is created per case. No shared state across cases.
- `tinybench` orchestrates each `Bench`; we report `hz` (operations/second) and `mean` (ms/op).
- Numbers are advisory when run on a developer machine. The canonical numbers are produced by the GitHub Actions Ubuntu runner (M5c CI matrix); those are what the docs page links.

## Seed sizes

Default `pnpm --filter @nookdb/benchmarks run` uses a single 1,000-row seed (the dev-machine quick run, ~2 minutes). Larger seeds via env var:

```bash
NOOK_BENCH_SEEDS=1000,10000,100000 pnpm --filter @nookdb/benchmarks run
```

The current TS surface inserts records one at a time (no `db.transaction` wrapper exposed yet). On a dev machine, seeding 100k records takes 10+ minutes per case; that's why local default is 1k. M5c CI will run the full ladder for the canonical numbers.
