# nookdb · electron-notes example

A two-window Electron + React + nookdb notes app showcasing reactive `live()` across the multi-process bridge.

## Run

```bash
pnpm install
pnpm --filter @nookdb/example-electron-notes dev
```

Two windows open side by side. Both connect to the same `notes.db` via the `@nookdb/electron` Host. Create a note in window A; it appears live in window B. Edit the title in B; A re-renders the sidebar immediately.

## What this example covers

- `openHost` opening two `BrowserWindow`s connected to one database (multi-window pattern).
- The schema-hash handshake on connect.
- React `useLive` driving the sidebar + the editor body.
- Delete-then-reinsert update pattern (no `Collection.update()` on M2 surface).

## Schema adaptation notes

`s.array()` is not on the M2 public surface (the Rust IR field types are: `id`, `string`, `number`, `boolean`, `enum`, `date`). Tags are omitted; the two-window reactive showcase is demonstrated via `title`, `body`, and `updatedAt`.

For a simpler single-window demo, see [`examples/electron-todo`](../electron-todo/).
