# Changelog

All notable changes to NookDB are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-05-30

### Added
- **Query options (`sort` / `limit` / `offset`) across all layers (#20).** `find`, `findOne`, and `count` now accept an options object to sort by a schema field (nulls-last, with a stable `id` tie-break), cap results with `limit`, and page with `offset`. The options flow end to end: through the Rust core (`find_with` / `find_one_with` / `count_with`), the typed `nookdb` API, and reactive `live()` subscriptions, which carry the options through every recompute.

## [1.0.1] - 2026-05-25

### Fixed
- **`nookdb` and `@nookdb/cli` were uninstallable from npm.** `release.yml` used `npm publish`, which does not rewrite pnpm's `workspace:*` protocol. The published 1.0.0 tarballs leaked `"@nookdb/binding": "workspace:*"` (in `nookdb`) and `"nookdb": "workspace:*"` (in `@nookdb/cli`) as runtime dependencies, causing `EUNSUPPORTEDPROTOCOL` on install. Pipeline switched to `pnpm publish` for the 5 main JS packages, which transforms workspace specifiers to the actual version at publish time.
- `nookdb-core` (crate), `@nookdb/binding` (dispatcher), and the 6 per-triple binding siblings were unaffected — they have no `workspace:` references in their source manifests.

## [1.0.0] - 2026-05-25

First stable release.

### Added
- **Storage core (`nookdb-core`):** redb-backed ACID storage with composite-key codec, transactions, fsync-aware durability, kill-9 crash safety.
- **NAPI binding (`@nookdb/binding`):** NAPI-rs v3 binding with multi-process safe transaction primitives; per-platform packages for Linux x64/arm64 (gnu+musl), macOS x64/arm64, Windows x64-msvc.
- **Core API (`nookdb`):** schema-first DSL (`s.*`), typed queries (`find`, `findOne`, `count`, `delete`, `insert`), secondary indexes, unique indexes, reactive `live()` queries with post-commit notifier coalescing, transactions, backup/restore.
- **React bindings (`@nookdb/react`):** `useLive` hook with snapshot semantics.
- **Electron bridge (`@nookdb/electron`):** main↔renderer typed proxy over MessagePortMain, schema-hash handshake (`NookSchemaError` on mismatch), pluggable `Authorizer` (default permissive).
- **CLI (`@nookdb/cli`):** `nookdb backup`, `restore`, `migrate status|up`, `inspect`.
- **Docs site:** Astro/Starlight at https://nookdb.pages.dev.
- **Examples:** `electron-todo`, `electron-notes`, `migrate-from-sehawq-v5`.
- **Benchmarks:** head-to-head harness vs `better-sqlite3`.

### Semver guarantees
- Public API surface (`nookdb`, `@nookdb/react`, `@nookdb/electron`, `@nookdb/cli`) follows semver from this release forward. Breaking changes require a major bump.
- Node 20+ supported. Node 18 explicitly not supported.
- Electron 28+ supported (MessagePortMain modern API requirement).

[Unreleased]: https://github.com/nookwright/nookdb/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/nookwright/nookdb/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/nookwright/nookdb/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nookwright/nookdb/releases/tag/v1.0.0
