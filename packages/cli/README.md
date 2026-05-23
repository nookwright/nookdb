# @nookdb/cli

Command-line tool for [`nookdb`](https://www.npmjs.com/package/nookdb) — backup, restore, migrate, inspect.

## Install

```
npm install -g @nookdb/cli
```

Or run ad-hoc via `npx`:

```
npx @nookdb/cli inspect ./app.db
```

## Commands

| Command | Description |
| --- | --- |
| `nookdb backup <db> <out.nbkp>` | Create a consistent snapshot. |
| `nookdb restore <snapshot> <db> [--allow-overwrite]` | Restore from a snapshot. |
| `nookdb migrate status <db>` | Show applied vs pending migrations. |
| `nookdb migrate up <db> [--versions 1,2,3]` | Apply pending migrations. |
| `nookdb inspect <db>` | Print schema, collection counts, index summary. |

Exit codes: `0` success, `1` user error, `2` corruption / unrecoverable.

See https://nookdb.pages.dev/reference/cli.

## License

MIT
