/**
 * Typed collection proxy.
 *
 * `makeCollection` wraps the schema-aware native ops behind a small typed
 * facade keyed off a single `CollectionBuilder`. Its generic parameter is
 * the collection's *inferred* document type — `typeof
 * schema.users.$type` (Task-12 `DocOf`) — so `db.users.find(...)` resolves
 * to `Promise<User[]>`, `findOne` to `Promise<User | null>`, etc. (PRD
 * §7.1/§7.2: the schema is the single source of truth, no type
 * duplication).
 *
 * Native method-name mapping (verified against
 * `crates/nookdb-napi/index.d.ts`):
 * - `.insert(doc)`         → `native.insert(coll, docJson)`
 * - `.find(filter?)`       → `native.find(coll, filterJson)`
 * - `.findOne(filter?)`    → `native.findOne(coll, filterJson)`
 * - `.count(filter?)`      → `native.count(coll, filterJson)`
 * - `.delete(filter?)`     → `native.deleteMany(coll, filterJson)`
 *   (the typed bulk delete; the bare `native.delete` is the M1
 *   bytes-keyspace delete and is intentionally NOT used here).
 *
 * Every native call is wrapped in the `try/catch → mapNativeError`
 * pattern used throughout `database.ts`, so a `[kind] message` Rust error
 * surfaces as the matching typed `NookError` subclass.
 */

import { mapNativeError } from './errors.js';
import { applyDefaults } from './schema/defaults.js';
import { LiveQuery, type LiveNative } from './live.js';

/**
 * The schema-aware subset of the native `Database` used by the typed
 * proxy. Declared here (rather than imported from the binding `.d.ts`)
 * so the proxy can be unit-tested against a stub, mirroring
 * `database.ts`'s `NativeDatabase`.
 */
export interface NativeSchemaDatabase extends LiveNative {
  insert(collection: string, docJson: string): Promise<void>;
  find(collection: string, filterJson: string): Promise<string[]>;
  findOne(collection: string, filterJson: string): Promise<string | null>;
  count(collection: string, filterJson: string): Promise<number>;
  deleteMany(collection: string, filterJson: string): Promise<number>;
  // S2a — transaction primitives (M5c T4 on the Rust side). The Rust core
  // buffers `txInsert` / `txDeleteMany` ops against `txHandle` and replays
  // them atomically inside one `Database::write` closure on
  // `commitWriteTxn`; `rollbackWriteTxn` discards the buffer. Reads
  // (`txFind` / `txFindOne` / `txCount`) see the latest committed
  // snapshot in M5c — in-tx read-after-write is M6 work (see plan
  // `2026-05-20-m5c-engineering.md` §9).
  beginWriteTxn(): Promise<number>;
  commitWriteTxn(txHandle: number): Promise<void>;
  rollbackWriteTxn(txHandle: number): Promise<void>;
  txInsert(txHandle: number, collection: string, docJson: string): Promise<void>;
  txFind(txHandle: number, collection: string, filterJson: string): Promise<string[]>;
  txFindOne(txHandle: number, collection: string, filterJson: string): Promise<string | null>;
  txCount(txHandle: number, collection: string, filterJson: string): Promise<number>;
  txDeleteMany(txHandle: number, collection: string, filterJson: string): Promise<number>;
  backup(destPath: string): Promise<{ entryCount: number; bytesWritten: number }>;
  restore(
    srcPath: string,
    opts?: { allowOverwrite?: boolean; skipSchemaCheck?: boolean },
  ): Promise<{ entryCount: number; bytesRead: number }>;
  migrateStatus(): Promise<{ currentVersion: number; appliedCount: number }>;
  migrateRun(versions: number[]): Promise<void>;
  migrateListApplied(): Promise<number[]>;
  listCollectionNames(): Promise<string[]>;
  close(): void;
}

/**
 * Structural view of a `CollectionBuilder` (the class is not exported
 * from `s.ts`). The `$type` phantom carries the inferred document type;
 * only it is needed at the type level. `_fields` is the runtime field map
 * `applyDefaults` reads.
 */
export interface CollectionBuilderLike<TDoc> {
  /** Compile-time inferred document type (`DocOf<TFields>`). */
  readonly $type: TDoc;
  /** Runtime field-builder map (consumed by `applyDefaults`). */
  readonly _fields: Record<string, { readonly _state: { readonly type: string; readonly defaultVal?: unknown } }>;
}

/**
 * Input document for `.insert`. All keys are optional: the auto-generated
 * `s.id()` value and every `.default(...)`-carrying field are filled by
 * `applyDefaults` *before* the document reaches the wire, and the Rust
 * core is the authoritative validator for everything else (required
 * fields, types, ranges, enum membership, unique indexes). `.default()` /
 * `s.id()` carry no type-level marker in the Task-12 builder phantoms, so
 * a precise `Omit<Doc, defaulted|id>` is not type-recoverable without
 * widening the DSL (out of scope for this task); `Partial<TDoc>` is the
 * ergonomic, never-wrongly-rejecting M2 input — it accepts exactly the
 * valid shapes plus any field the runtime fills, deferring authoritative
 * rejection to Rust (the same client-trusts-Rust split `s.ts` documents
 * for index legality).
 */
export type InsertDoc<TDoc> = Partial<TDoc>;

/** The typed collection facade returned for each `db[collectionName]`. */
export interface Collection<TDoc> {
  /**
   * Validates (server-side) and stores one document, after filling the
   * `s.id()` field (UUID v7) and any `.default(...)` fields client-side.
   */
  insert(doc: InsertDoc<TDoc>): Promise<void>;
  /** Returns every document matching `filter` (default: all documents). */
  find(filter?: Record<string, unknown>): Promise<TDoc[]>;
  /** Returns the first document matching `filter`, or `null`. */
  findOne(filter?: Record<string, unknown>): Promise<TDoc | null>;
  /** Returns the number of documents matching `filter`. */
  count(filter?: Record<string, unknown>): Promise<number>;
  /** Deletes every document matching `filter`, returning the count removed. */
  delete(filter?: Record<string, unknown>): Promise<number>;
  /**
   * Drizzle-style shallow object merge. For each document matching
   * `filter`, builds `{...doc, ...patch}` and replaces it. Wrapped in a
   * single `db.transaction` so the entire update is atomic on success and
   * fully rolled back on any per-doc validation failure.
   *
   * **Constraint:** `patch` cannot change the document's id field; if a
   * matched doc's id differs from `patch.id` (when present), throws
   * {@link NookSchemaError} and the transaction rolls back. No Mongo
   * `$set/$unset/$inc` operators — plain shallow `Object.assign` semantics.
   */
  update(filter: Record<string, unknown>, patch: Partial<TDoc>): Promise<number>;
  /**
   * Opens a reactive live query for this collection. The returned
   * {@link LiveQuery} fires its subscribers/async-iterator on every
   * committed write that touches a document matching `filter`.
   */
  live(filter?: Record<string, unknown>): LiveQuery<TDoc>;
}

/**
 * Lightweight tx-proxy subset that {@link makeCollection}'s `update`
 * implementation needs from a `tx[collName]` proxy. The full
 * `TxCollection<TDoc>` (from `database.ts`) is structurally assignable
 * to this interface, so `makeSchemaDatabase` can pass `tx[collName]`
 * directly without an extra adapter.
 */
export interface TxProxyForUpdate<TDoc> {
  insert(doc: Partial<TDoc>): Promise<void>;
  find(filter?: Record<string, unknown>): Promise<TDoc[]>;
  delete(filter?: Record<string, unknown>): Promise<number>;
}

/**
 * Shared `update(filter, patch)` body for both the top-level
 * {@link Collection.update} and the transaction-scoped
 * `TxCollection.update` (in `database.ts`). The two call sites have
 * identical semantics: find matches, guard against id rewrites, then
 * `delete({id}) + insert(merged)` per match.
 *
 * **Constraint:** `patch` cannot change a matched document's id field.
 * The guard uses `'id' in patch` (not `patch.id !== undefined`) so that
 * an explicit `{ id: undefined }` is still rejected — silently dropping
 * the id key on the merged doc would re-key the row to a freshly
 * applied default, producing the silent-renumber bug this helper exists
 * to prevent. Throws a typed `[schema]` {@link NookSchemaError} on
 * mismatch; the throw escapes the caller, triggering rollback of any
 * per-doc deletes already buffered.
 *
 * @internal — shared implementation detail; not part of the public API.
 */
export async function applyUpdateLoop<TDoc>(
  tx: TxProxyForUpdate<TDoc>,
  filter: Record<string, unknown>,
  patch: Partial<TDoc>,
): Promise<number> {
  const matches = await tx.find(filter);
  let count = 0;
  for (const doc of matches as (TDoc & { id: string })[]) {
    if ('id' in patch && (patch as { id?: string }).id !== doc.id) {
      throw mapNativeError(
        new Error(`[schema] cannot change id field in update (matched id=${doc.id})`),
      );
    }
    const merged = { ...doc, ...patch };
    await tx.delete({ id: doc.id });
    await tx.insert(merged as Partial<TDoc>);
    count += 1;
  }
  return count;
}

/**
 * Builds the typed proxy for one collection.
 *
 * @typeParam TDoc - the collection's inferred document type, recovered
 *   from `builder.$type` (so callers never restate the shape).
 *
 * `transactionFn` powers the top-level {@link Collection.update} as a
 * `db.transaction`-wrapped delete-and-insert loop. `makeSchemaDatabase`
 * passes in an adapter that calls `handle.transaction(cb)` with the
 * matching `tx[collName]` proxy — the `handle.transaction` reference
 * is resolved at call time so this still works while `handle` is being
 * built (`makeCollection` is invoked from inside `makeSchemaDatabase`'s
 * schema loop before `handle.transaction` is observed by anyone).
 */
export function makeCollection<TDoc>(
  native: NativeSchemaDatabase,
  collName: string,
  builder: CollectionBuilderLike<TDoc>,
  transactionFn: <T>(cb: (tx: TxProxyForUpdate<TDoc>) => Promise<T>) => Promise<T>,
): Collection<TDoc> {
  return {
    async insert(doc: InsertDoc<TDoc>): Promise<void> {
      const filled = applyDefaults(builder, doc as Record<string, unknown>);
      try {
        await native.insert(collName, JSON.stringify(filled));
      } catch (err) {
        throw mapNativeError(err);
      }
    },

    async find(filter: Record<string, unknown> = {}): Promise<TDoc[]> {
      let rows: string[];
      try {
        rows = await native.find(collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
      // Safety: `JSON.parse(r) as TDoc` is sound because the Rust core is the
      // authoritative validator (PRD §3 Rust-is-authority): every document stored
      // by `insert` has already been validated and round-tripped through the
      // schema-driven JSON codec, which controls the at-rest shape symmetrically
      // with `applyDefaults` in the insert direction. The returned bytes are
      // guaranteed to match `TDoc`'s structure; the cast makes the type explicit.
      return rows.map((r) => JSON.parse(r) as TDoc);
    },

    async findOne(filter: Record<string, unknown> = {}): Promise<TDoc | null> {
      let row: string | null;
      try {
        row = await native.findOne(collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
      // Safety: same Rust-authority / schema-driven codec rationale as `find` above.
      return row === null ? null : (JSON.parse(row) as TDoc);
    },

    async count(filter: Record<string, unknown> = {}): Promise<number> {
      try {
        return await native.count(collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
    },

    async delete(filter: Record<string, unknown> = {}): Promise<number> {
      try {
        return await native.deleteMany(collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
    },

    async update(
      filter: Record<string, unknown>,
      patch: Partial<TDoc>,
    ): Promise<number> {
      // Delegates to `applyUpdateLoop` so the top-level and
      // tx-scoped `update` share one implementation (id-guard, merge,
      // delete-then-insert loop). The throw inside the helper escapes
      // `transactionFn`, triggering rollback of any per-doc deletes
      // already buffered for this transaction.
      return transactionFn((tx) => applyUpdateLoop<TDoc>(tx, filter, patch));
    },

    live(filter: Record<string, unknown> = {}): LiveQuery<TDoc> {
      return new LiveQuery<TDoc>(native, collName, filter);
    },
  };
}

// ── Compile-time DX guard: Task-12 `$type` consumption (zero runtime) ─────────
//
// Proves the headline §7.1/§7.2 DX is NOT silently hollow: a `db[coll]`
// proxy built from a LIVE `s.*` chain must expose `find()` typed as
// `Promise<Doc[]>` / `findOne()` as `Promise<Doc | null>` / `insert(doc)`
// accepting the document — NOT `Promise<unknown[]>`. This is TYPE-ONLY
// (no values, no JS emitted) and lives in a file the default
// `tsconfig.json` type-checks (`src/**/*`, `__tests__` excluded), so a
// regression that drops the inferred document type back to `unknown`
// fails `tsc --noEmit` (the CI typecheck gate) — mirroring the
// `_InferenceGuard` pattern Task 12 established in `s.ts`. The
// runtime-facing `expectTypeOf` mirror lives in
// `__tests__/collection.test.ts`.

/** `true` iff `A` and `B` are mutually assignable (exact type equality). */
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** Compile error unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

// A LIVE `s.*` schema chain exercised end-to-end through the real
// `makeCollection` return type, so any regression in the typed-proxy
// generics is caught at `tsc --noEmit` time. `_dxProbe` is intentionally
// unused at runtime: module-private, unreferenced, never exported — a
// tree-shaker drops it with zero behavior impact.
declare const _dxProbe: {
  users: ReturnType<
    typeof makeCollection<{
      id: string;
      email: string;
      role: 'admin' | 'user';
      age?: number;
    }>
  >;
};

interface _UsersDoc {
  id: string;
  email: string;
  role: 'admin' | 'user';
  age?: number;
}

// `find()` MUST be `Promise<_UsersDoc[]>` (NOT `Promise<unknown[]>`).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _FindReturnsDocArray = AssertTrue<
  Equals<Awaited<ReturnType<(typeof _dxProbe)['users']['find']>>, _UsersDoc[]>
>;
// `findOne()` MUST be `Promise<_UsersDoc | null>`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _FindOneReturnsDocOrNull = AssertTrue<
  Equals<Awaited<ReturnType<(typeof _dxProbe)['users']['findOne']>>, _UsersDoc | null>
>;
// `count()` / `delete()` MUST be `Promise<number>`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CountReturnsNumber = AssertTrue<
  Equals<Awaited<ReturnType<(typeof _dxProbe)['users']['count']>>, number>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _DeleteReturnsNumber = AssertTrue<
  Equals<Awaited<ReturnType<(typeof _dxProbe)['users']['delete']>>, number>
>;
// `insert` MUST accept the (partial) document — not `never` / `unknown`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _InsertAcceptsDoc = AssertTrue<
  Equals<Parameters<(typeof _dxProbe)['users']['insert']>[0], Partial<_UsersDoc>>
>;
// `live()` MUST return `LiveQuery<_UsersDoc>` (NOT `LiveQuery<unknown>`).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _LiveReturnsLiveQuery = AssertTrue<
  Equals<ReturnType<(typeof _dxProbe)['users']['live']>, LiveQuery<_UsersDoc>>
>;
