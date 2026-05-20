# migrate-from-sehawq-v5

A standalone TypeScript script that imports a [sehawq.db v5](https://www.npmjs.com/package/sehawq.db) JSON export into a new nookdb database.

This is the **only** v5 migration path. There is no `nookdb import` CLI command — see PRD §11 (revised 2026-05-20) and the [Migrating from sehawq.db v5 guide](https://nookdb.pages.dev/guides/migrating-from-sehawq-v5/) for the rationale.

## Usage

```sh
# Install dependencies once at the repo root
pnpm install

# Run the migrator
pnpm dlx tsx convert.ts ./sehawq.json ./schema.ts ./app.db
```

`schema.ts` must `export default` a schema object built with the `s.*` DSL whose collection names match your v5 keys (the part before `::`).

## Limitations

- Only the v5 JSON export is supported. The `.log` (WAL) file is NOT replayed.
- The script assumes the v5 export uses the shape `{ "version": 5, "data": { "<collection>::<id>": <record> } }`. If your export has a different layout, adapt this 50-line script.
- Schema is REQUIRED — there is no schema inference. Records that fail schema validation are skipped and reported in the final tally.
- Indexes on the new DB are built lazily by the inserts; no manual reindex step is needed.
