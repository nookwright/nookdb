# Changelog

All notable changes to NookDB are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/nookwright/nookdb/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nookwright/nookdb/releases/tag/v1.0.0
