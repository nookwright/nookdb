# @nookdb/binding

NAPI-rs binding for [`nookdb`](https://www.npmjs.com/package/nookdb).

This package is the platform-dispatch loader. The actual native binary is delivered via one of the per-platform sibling packages, selected automatically by npm via `optionalDependencies`:

- `@nookdb/binding-darwin-x64`
- `@nookdb/binding-darwin-arm64`
- `@nookdb/binding-linux-x64-gnu`
- `@nookdb/binding-linux-arm64-gnu`
- `@nookdb/binding-linux-x64-musl`
- `@nookdb/binding-win32-x64-msvc`

You should not depend on this package directly — install [`nookdb`](https://www.npmjs.com/package/nookdb) instead.
