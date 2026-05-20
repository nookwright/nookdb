# nookdb · electron-todo example

A minimal Electron + React + nookdb app showing schema + CRUD + reactive `live()` in one screen.

## Run

```bash
# From the repo root
pnpm install
pnpm --filter @nookdb/example-electron-todo dev
```

A window opens with an input box, an add button, and a list of todos. Adding/toggling/deleting a todo updates the list immediately via `useLive`.

## What this example covers

- Schema definition with `s.*` (in `src/schema.ts`).
- `openHost()` in main, `connectNook()` in renderer.
- Typed `db.todos.insert / find / delete`.
- React `useLive` for reactive list rendering.

For a multi-window reactive demo, see [`examples/electron-notes`](../electron-notes/).
