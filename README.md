<p align="center">
  <img src="./brand/nookdb-logo.png" alt="NookDB" width="128" />
</p>

<h1 align="center">NookDB</h1>

<p align="center"><b>Schema-first, reactive, local-first database for Electron.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/nookdb"><img src="https://img.shields.io/npm/v/nookdb.svg?label=nookdb" alt="npm version" /></a>
  <a href="https://github.com/nookwright/nookdb/actions/workflows/ci.yml"><img src="https://github.com/nookwright/nookdb/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/nookwright/nookdb/actions/workflows/build-matrix.yml"><img src="https://github.com/nookwright/nookdb/actions/workflows/build-matrix.yml/badge.svg" alt="Build Matrix" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

Built on a Rust core (redb) and exposed to Node via NAPI-rs. First-class multi-process support (Electron main ↔ renderer) out of the box.

> **1.0.1 released.** The public API is stable. Breaking changes follow semver.

## Why NookDB?

- **Schema-first.** Define your data once; types, validation, and indexes flow from one source.
- **Reactive by default.** Every query has a `.live()` variant. UI stays in sync with the database.
- **Multi-process built in.** Electron renderers use the same API as the main process via a typed proxy — no IPC code.
- **Rust-powered durability.** ACID transactions on `redb`. fsync where it matters.

## Status

**1.0 launched.** Milestones M0–M6 are complete: foundation, storage (redb + ACID + kill-9 safety), schema & query DSL, reactive `live()`, Electron multi-process bridge, polish (CLI, backup, docs, benchmarks), and 1.0 release engineering across a 6-platform native matrix.


## Docs & examples

- **Documentation:** <https://nookdb.pages.dev> (built from `docs/`)
- **Example apps:**
  - [`examples/electron-todo`](./examples/electron-todo/) — minimal CRUD + reactive `live()`
  - [`examples/electron-notes`](./examples/electron-notes/) — two-window reactive showcase
- **Benchmarks:** [`benchmarks/`](./benchmarks/) — head-to-head against `better-sqlite3`
- **Migrating from sehawq.db v5:** [docs page](https://nookdb.pages.dev/guides/migrating-from-sehawq-v5/) + [example script](./examples/migrate-from-sehawq-v5/)

## Install

```bash
pnpm add nookdb
# or
npm install nookdb
```

Companion packages (install as needed):

```bash
pnpm add @nookdb/react      # useLive hook for React
pnpm add @nookdb/electron   # main / preload / renderer bridge
pnpm add -D @nookdb/cli     # nookdb backup | restore | migrate | inspect
```

Prebuilt native binaries ship for linux x64/arm64 (gnu + musl), macOS x64/arm64, and Windows x64-msvc. Requires **Node 20+**.

## Quick start

### Define a schema and query

```ts
import { open, s } from 'nookdb';

const schema = {
  users: s
    .collection({
      id: s.id(),
      email: s.string().email(),
      role: s.enum(['admin', 'user'] as const),
    })
    .uniqueIndex('email')
    .index('role'),
};

const db = await open('./app.db', { schema });

await db.users.insert({ id: 'u1', email: 'ali@example.com', role: 'admin' });

const admins = await db.users.find({ role: 'admin' });
//    ^? { id: string; email: string; role: 'admin' | 'user' }[]

db.close();
```

`db.users` is fully typed from the schema — `find`/`findOne`/`count`/`delete`/`insert` and `live` all infer their argument and return shapes from the `s.*` chain. The Rust core is the authoritative validator.

### Reactive: `live()`

```ts
const lq = db.users.live({ role: 'admin' });

const off = lq.subscribe((admins) => {
  console.log('admins:', admins.length);
});

// Async iterator form:
for await (const admins of db.users.live({ role: 'admin' })) {
  render(admins);
}

lq.dispose();
off();
```

`LiveQuery<T>` emits a snapshot on every committed write that touches a matching document. The post-commit notifier coalesces rapid commits so subscribers only see the final state.

### React: `useLive`

```tsx
import { useLive } from '@nookdb/react';

function AdminList({ db }) {
  const admins = useLive(() => db.users.live({ role: 'admin' }), [db]);
  return <ul>{admins.map((u) => <li key={u.id}>{u.email}</li>)}</ul>;
}
```

### Electron multi-process

The renderer uses the same `db.users.find(...)` / `db.users.live(...)` shape as the main process — no IPC code, no manual serialization.

```ts
// main.ts
import { openHost } from '@nookdb/electron/main';
import { schema } from './shared/schema';

const host = await openHost('./app.db', { schema });

const { port1, port2 } = new MessageChannelMain();
host.connectPort(port1, { frameUrl: win.webContents.getURL(), origin: null, webContentsId: win.webContents.id });
win.webContents.postMessage('nook:port', null, [port2]);
```

```ts
// preload.ts
import { exposeNookBridge } from '@nookdb/electron/preload';
exposeNookBridge();
```

```ts
// renderer.ts
import { connectNook } from '@nookdb/electron/renderer';
import { schema } from './shared/schema';

const db = await connectNook({ schema });
const admins = await db.users.find({ role: 'admin' });
for await (const list of db.users.live({ role: 'admin' })) render(list);
```

Strict schema-hash handshake rejects mismatched schemas at connect time (throws `NookSchemaError`). A pluggable `Authorizer` lets you gate ops per (sender, op); the default is permissive (free-tier).

### CLI: `nookdb`

```
nookdb backup ./app.db ./snapshot.nbkp
nookdb restore ./snapshot.nbkp ./app.db --allow-overwrite
nookdb migrate status ./app.db
nookdb migrate up ./app.db --versions 1,2,3
nookdb inspect ./app.db
```

## Packages

| Package             | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `nookdb`            | Core TypeScript API (schema, queries, reactive)           |
| `@nookdb/react`     | `useLive` hook for React                                  |
| `@nookdb/electron`  | Multi-process bridge — `/main`, `/preload`, `/renderer`   |
| `@nookdb/cli`       | `nookdb` CLI — `backup`, `restore`, `migrate`, `inspect`  |

## Development

Prerequisites: Node 20+, pnpm 10+, Rust stable (**MSRV 1.78**).

```bash
pnpm install
pnpm build         # builds NAPI binding + TS packages
pnpm test          # runs Rust + JS tests
pnpm lint          # runs all lints
```

Playwright Electron E2E (Linux requires xvfb):

```bash
pnpm --filter @nookdb/electron test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## About Nookwright

NookDB is the first product by **Nookwright** — more developer tools in the family to come.

## License

MIT © Nookwright contributors.
