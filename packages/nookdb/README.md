# nookdb

> Schema-first, reactive, local-first database for Electron and Node 20+.

Built on a Rust core ([`redb`](https://crates.io/crates/redb)) exposed via NAPI-rs. ACID transactions, fsync where it matters, kill-9 crash safety.

## Install

```
npm install nookdb
```

The native binding is delivered automatically per platform via `@nookdb/binding-<triple>` packages (no postinstall script required).

## Quick start

```ts
import { open, s } from 'nookdb';

const schema = {
  users: s.collection({
    id: s.id(),
    email: s.string().email(),
    role: s.enum(['admin', 'user'] as const),
  }).uniqueIndex('email').index('role'),
};

const db = await open('./app.db', { schema });
await db.users.insert({ id: 'u1', email: 'a@b.c', role: 'admin' });
const admins = await db.users.find({ role: 'admin' });
db.close();
```

## Reactive queries

```ts
const lq = db.users.live({ role: 'admin' });
const off = lq.subscribe((admins) => console.log(admins.length));
```

See full documentation at https://nookdb.pages.dev.

## License

MIT
