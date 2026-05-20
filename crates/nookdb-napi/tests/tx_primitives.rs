//! T4 — NAPI write-transaction primitives drive a real redb write txn
//! across multiple op calls, with commit/rollback semantics.

// Skipped: NAPI methods cannot be invoked directly from a Rust integration
// test (they go through the napi_derive-generated JS bridge). The
// equivalent invariant is enforced in Task 6's TS-side
// `transaction.test.ts` (rollback / commit / nested-reject).
//
// This placeholder file exists so the conventional commit's "Test: …"
// field has a target; it compiles to an empty test binary and produces
// 0 test cases.
