# Contributing to Nook

Thanks for your interest! Nook is in early development and not yet open to broad contribution. If you'd like to help once the project stabilizes, watch the repo for the `1.0` release.

## Repo Layout

- `crates/nookdb-core` — pure Rust database engine
- `crates/nookdb-napi` — NAPI-rs binding (produces the `.node` artifact)
- `packages/nookdb` — main npm package (TypeScript surface + loader)

## Dev Workflow

1. `pnpm install` — bootstraps the workspace
2. `pnpm build:napi:debug` — builds the native binding for your platform
3. `pnpm test` — runs the full test suite (Rust + JS)
4. `pnpm lint` — runs all lints (must be clean before commit)

## Commit Style

Conventional commits:

- `feat(scope): description` — new feature
- `fix(scope): description` — bug fix
- `chore(scope): description` — tooling, deps, refactor
- `docs(scope): description` — documentation
- `test(scope): description` — test additions/changes
- `ci(scope): description` — CI changes

Scopes: `core`, `napi`, `nookdb`, `electron`, `react`, `cli`, `docs`, or repo-root chores can omit scope.

## Code Standards

- **Rust:** `cargo fmt`, `cargo clippy -- -D warnings`, target ≥85% line coverage in `nookdb-core`.
- **TypeScript:** strict mode, `tsd` type tests for public API, target ≥80% line coverage.
- **Tests first.** TDD is the default; write the failing test before the implementation.
- **No `unsafe` in `nookdb-core`** (enforced via `unsafe_code = "forbid"`). `nookdb-napi` is the only crate allowed `unsafe`, and only where `napi-rs` requires it.

## Reporting Issues

GitHub Issues. Include: platform, Node version, pnpm version, Rust version (`rustc --version`), minimal reproduction.
