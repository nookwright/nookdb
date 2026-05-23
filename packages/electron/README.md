# @nookdb/electron

Multi-process bridge for [`nookdb`](https://www.npmjs.com/package/nookdb). Electron renderers use the same `db.users.find/live` shape as the main process — no manual IPC.

## Install

```
npm install @nookdb/electron nookdb
```

Peer deps: `nookdb ^1.0.0`, `electron ^28`.

## Three-process layout

**main.ts**

```ts
import { openHost } from '@nookdb/electron/main';
import { schema } from './shared/schema';

const host = await openHost('./app.db', { schema });
const { port1, port2 } = new MessageChannelMain();
host.connectPort(port1, { frameUrl: win.webContents.getURL(), origin: null, webContentsId: win.webContents.id });
win.webContents.postMessage('nook:port', null, [port2]);
```

**preload.ts**

```ts
import { exposeNookBridge } from '@nookdb/electron/preload';
exposeNookBridge();
```

**renderer.ts**

```ts
import { connectNook } from '@nookdb/electron/renderer';
import { schema } from './shared/schema';

const db = await connectNook({ schema });
const admins = await db.users.find({ role: 'admin' });
```

Strict schema-hash handshake throws `NookSchemaError` on mismatch. A pluggable `Authorizer` lets you gate ops per (sender, op); default is permissive.

See https://nookdb.pages.dev/reference/electron.

## License

MIT
