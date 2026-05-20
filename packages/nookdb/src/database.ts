import { mapNativeError, NookError, NookTransactionError } from './errors.js';
import {
  applyUpdateLoop,
  makeCollection,
  type Collection,
  type CollectionBuilderLike,
  type NativeSchemaDatabase,
  type TxProxyForUpdate,
} from './collection.js';
import { applyDefaults } from './schema/defaults.js';
import type { BackupStats, RestoreOptions, RestoreStats } from './backup.js';

/**
 * Shape of the native `Database` class produced by NAPI. Kept in this
 * file (rather than imported from the binding's `.d.ts`) so the wrapper
 * can be unit-tested with a stub.
 */
export interface NativeDatabase {
  put(collection: string, key: Buffer, value: Buffer): Promise<void>;
  get(collection: string, key: Buffer): Promise<Buffer | null>;
  delete(collection: string, key: Buffer): Promise<boolean>;
  listCollection(collection: string): Promise<{ key: Buffer; value: Buffer }[]>;
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

/** One `(key, value)` pair returned from `listCollection`. */
export interface DbEntry {
  key: Buffer;
  value: Buffer;
}

/**
 * Public Nook database handle.
 *
 * **Stability:** Unstable in M1 — bytes-only API. M2 will add a
 * schema-aware layer (`open(path, { schema })`) on top of this.
 */
export class Database {
  private readonly inner: NativeDatabase;

  /** Internal constructor. Use {@link open} instead. */
  constructor(inner: NativeDatabase) {
    this.inner = inner;
  }

  async put(collection: string, key: Buffer, value: Buffer): Promise<void> {
    try {
      await this.inner.put(collection, key, value);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async get(collection: string, key: Buffer): Promise<Buffer | null> {
    try {
      return await this.inner.get(collection, key);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async delete(collection: string, key: Buffer): Promise<boolean> {
    try {
      return await this.inner.delete(collection, key);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async listCollection(collection: string): Promise<DbEntry[]> {
    try {
      return await this.inner.listCollection(collection);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async backup(destPath: string): Promise<BackupStats> {
    try {
      return await this.inner.backup(destPath);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async restore(srcPath: string, opts?: RestoreOptions): Promise<RestoreStats> {
    try {
      return await this.inner.restore(srcPath, opts);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async migrateStatus(): Promise<{ currentVersion: number; appliedCount: number }> {
    try {
      return await this.inner.migrateStatus();
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async migrateRun(versions: number[]): Promise<void> {
    try {
      await this.inner.migrateRun(versions);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async migrateListApplied(): Promise<number[]> {
    try {
      return await this.inner.migrateListApplied();
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  async listCollectionNames(): Promise<string[]> {
    try {
      return await this.inner.listCollectionNames();
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  /**
   * Releases the underlying database handle. Calling `close()` again (or
   * any other method) after the database is closed throws
   * {@link NookClosedError}.
   */
  close(): void {
    try {
      this.inner.close();
    } catch (err) {
      throw mapNativeError(err);
    }
  }
}

// ── Schema-aware (typed) database handle ─────────────────────────────────────

/**
 * A schema object as passed to `open(path, { schema })`: a map from
 * collection name to the `s.collection(...)` builder. Each builder's
 * `$type` phantom carries that collection's inferred document type
 * (Task-12 `DocOf`), so the returned handle is fully typed with **no type
 * duplication** (PRD §7.1).
 *
 * Constrained structurally (the `CollectionBuilder` class is not exported
 * from `s.ts`) via {@link CollectionBuilderLike}, whose `$type` member is
 * `unknown` here so any concrete builder map is assignable while each
 * collection's *own* `$type` is still recovered per key in
 * {@link SchemaDatabase}.
 */
export type SchemaShape = Record<string, CollectionBuilderLike<unknown>>;

/**
 * The collection proxy presented inside a `db.transaction(async (tx) => …)`
 * callback. Same surface as the top-level {@link Collection} (insert /
 * find / findOne / count / delete / update) but every op is bound to the
 * enclosing write transaction; reads see the latest committed snapshot
 * (in-tx read-after-write is M6 work — see M5c plan §9).
 */
export interface TxCollection<TDoc> {
  insert(doc: Partial<TDoc>): Promise<void>;
  find(filter?: Record<string, unknown>): Promise<TDoc[]>;
  findOne(filter?: Record<string, unknown>): Promise<TDoc | null>;
  count(filter?: Record<string, unknown>): Promise<number>;
  delete(filter?: Record<string, unknown>): Promise<number>;
  update(filter: Record<string, unknown>, patch: Partial<TDoc>): Promise<number>;
}

/**
 * The typed proxy passed into a `db.transaction(async (tx) => …)`
 * callback: `tx[collName]` is a {@link TxCollection} whose document
 * type mirrors the schema's per-collection `$type` phantom (same
 * inference rules as the top-level {@link SchemaDatabase}).
 */
export type TxProxy<TSchema extends SchemaShape> = {
  readonly [K in keyof TSchema]: TxCollection<TSchema[K]['$type']>;
};

/**
 * The handle returned by `open(path, { schema })`.
 *
 * `db[collectionName]` is the typed {@link Collection} proxy for that
 * collection, with its document type recovered from the matching
 * builder's `$type` phantom — so `db.users.find()` is
 * `Promise<{ id: string; … }[]>`, **not** `Promise<unknown[]>`. `close()`
 * releases the underlying native handle.
 */
export type SchemaDatabase<TSchema extends SchemaShape> = {
  readonly [K in keyof TSchema]: Collection<TSchema[K]['$type']>;
} & {
  /**
   * Releases the underlying database handle. Calling any collection op
   * after `close()` throws {@link NookClosedError}.
   */
  close(): void;
  backup(destPath: string): Promise<BackupStats>;
  restore(srcPath: string, opts?: RestoreOptions): Promise<RestoreStats>;
  migrateStatus(): Promise<{ currentVersion: number; appliedCount: number }>;
  migrateRun(versions: number[]): Promise<void>;
  migrateListApplied(): Promise<number[]>;
  listCollectionNames(): Promise<string[]>;
  /**
   * Runs `cb` inside a single atomic write transaction. Every
   * `tx.collection.insert` / `tx.collection.delete` / `tx.collection.update`
   * issued from the callback is buffered and committed together when `cb`
   * returns; any throw inside `cb` rolls the entire transaction back.
   *
   * Nested transactions are not supported — calling `transaction` from
   * within an already-running `transaction` callback throws
   * {@link NookTransactionError}.
   *
   * Reads inside the callback (`tx.collection.find` / `findOne` /
   * `count`) see the latest **committed** snapshot, not the in-flight
   * buffer (read-after-write within the same transaction is M6 work;
   * see M5c plan §9).
   */
  transaction<T>(cb: (tx: TxProxy<TSchema>) => Promise<T>): Promise<T>;
};

/**
 * Per-`NativeSchemaDatabase` "is a write transaction currently in flight?"
 * flag, used to reject nested `db.transaction(...)` calls (S2a invariant
 * "nested transactions are not supported"). Scoped via {@link WeakMap}
 * rather than a property on `SchemaDatabase` so each native instance
 * carries its own flag and the entry is garbage-collected together with
 * the native handle.
 */
const inWriteTxnFlags = new WeakMap<NativeSchemaDatabase, boolean>();

/**
 * Builds the typed {@link SchemaDatabase} handle from an already-opened
 * schema-aware native database plus the original schema object.
 *
 * One {@link makeCollection} proxy is created per declared collection;
 * `close()` is forwarded to the native handle through the same
 * `try/catch → mapNativeError` pattern as {@link Database.close}.
 */
export function makeSchemaDatabase<TSchema extends SchemaShape>(
  native: NativeSchemaDatabase,
  schema: TSchema,
): SchemaDatabase<TSchema> {
  const handle: Record<string, unknown> = {
    close(): void {
      try {
        native.close();
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async backup(destPath: string): Promise<BackupStats> {
      try {
        return await native.backup(destPath);
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async restore(srcPath: string, opts?: RestoreOptions): Promise<RestoreStats> {
      try {
        return await native.restore(srcPath, opts);
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async migrateStatus(): Promise<{ currentVersion: number; appliedCount: number }> {
      try {
        return await native.migrateStatus();
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async migrateRun(versions: number[]): Promise<void> {
      try {
        await native.migrateRun(versions);
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async migrateListApplied(): Promise<number[]> {
      try {
        return await native.migrateListApplied();
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async listCollectionNames(): Promise<string[]> {
      try {
        return await native.listCollectionNames();
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async transaction<T>(cb: (tx: TxProxy<TSchema>) => Promise<T>): Promise<T> {
      if (inWriteTxnFlags.get(native) === true) {
        throw new NookTransactionError('nested transactions are not supported');
      }
      inWriteTxnFlags.set(native, true);

      let txHandle: number;
      try {
        txHandle = await native.beginWriteTxn();
      } catch (err) {
        // `beginWriteTxn` failed before any state changed on the Rust
        // side — release the flag here so a subsequent `transaction`
        // call on this `native` can proceed.
        inWriteTxnFlags.delete(native);
        throw mapNativeError(err);
      }

      const tx = makeTxProxy<TSchema>(native, txHandle, schema);

      try {
        const result = await cb(tx);
        await native.commitWriteTxn(txHandle);
        return result;
      } catch (err) {
        // The user's `cb` (or `commitWriteTxn`) threw. Roll back the
        // buffered ops, but swallow any rollback error so the
        // user-visible error is the original cause — not a secondary
        // "[transaction] unknown tx handle" if the buffer was already
        // dropped by commit-time validation.
        try {
          await native.rollbackWriteTxn(txHandle);
        } catch {
          // Intentionally swallowed: surface the ORIGINAL error.
        }
        // Re-throw policy:
        //
        // Most inner paths are already typed: `makeTxCollection`'s per-op try/catches
        // route NAPI errors through `mapNativeError`, so cb-internal failures are
        // already `NookError` subclasses when they hit this catch. But `commitWriteTxn`
        // (the line above) calls into NAPI raw — replay-time failures (e.g., buffered
        // insert that only fails schema validation at commit-replay) arrive here
        // untyped. So we map only `Error` instances that are NOT already `NookError`,
        // preserving subclass identity for everything else (and propagating user-thrown
        // non-`Error` values unchanged).
        throw err instanceof NookError ? err : (err instanceof Error ? mapNativeError(err) : err);
      } finally {
        inWriteTxnFlags.delete(native);
      }
    },
  };

  for (const [collName, builder] of Object.entries(schema)) {
    handle[collName] = makeCollection(
      native,
      collName,
      builder,
      // Wrap `handle.transaction(cb)` so `Collection.update` can run its
      // delete-and-insert loop inside one atomic write. `handle.transaction`
      // is read AT CALL TIME (not capture time), so this closure is safe
      // even though `handle` is still under construction here — by the time
      // `update` actually invokes us, the full `transaction` method has been
      // assigned. Each collection's adapter narrows the schema-wide `TxProxy`
      // to its own `tx[collName]` (cast through `unknown` because that proxy
      // surface is structurally a superset of `TxProxyForUpdate<unknown>`).
      async <T>(cb: (tx: TxProxyForUpdate<unknown>) => Promise<T>): Promise<T> => {
        return (handle as unknown as SchemaDatabase<TSchema>).transaction(
          async (tx) =>
            // `tx[collName]` is guaranteed present: `collName` originates from
            // the same `Object.entries(schema)` iteration that built the
            // `TxProxy` keys in `makeTxProxy`. The non-null assertion is the
            // ESLint-preferred form (lint rule
            // `@typescript-eslint/non-nullable-type-assertion-style`).
            cb(
              (tx as unknown as Record<string, TxProxyForUpdate<unknown>>)[collName]!,
            ),
        );
      },
    );
  }

  return handle as SchemaDatabase<TSchema>;
}

/**
 * Builds the {@link TxProxy} passed into a `db.transaction(cb)`
 * callback: one {@link TxCollection} per declared schema entry, every
 * op bound to the in-flight `txHandle`.
 */
function makeTxProxy<TSchema extends SchemaShape>(
  native: NativeSchemaDatabase,
  txHandle: number,
  schema: TSchema,
): TxProxy<TSchema> {
  const proxy: Record<string, unknown> = {};

  for (const [collName, builder] of Object.entries(schema)) {
    proxy[collName] = makeTxCollection(native, txHandle, collName, builder);
  }

  return proxy as TxProxy<TSchema>;
}

/**
 * Builds the typed transaction-bound collection proxy for one
 * collection. The shape mirrors {@link makeCollection} (the M2
 * top-level proxy), with three differences:
 *
 * - every native call routes through the `tx*` primitives bound to
 *   `txHandle` so the op is buffered on the Rust side and committed
 *   atomically by `db.transaction`;
 * - `delete` returns `0` eagerly (the actual delete count is only
 *   known at commit-replay time; documented M5c shape);
 * - `update(filter, patch)` is added: this is the transaction-only
 *   "find matching docs, replace each with `{...doc, ...patch}`" helper
 *   that powers the S2a `update` invariant. The top-level
 *   {@link Collection} does NOT (yet) carry `update` — see M5c plan
 *   Task 7 for the public surface.
 */
function makeTxCollection<TDoc>(
  native: NativeSchemaDatabase,
  txHandle: number,
  collName: string,
  builder: CollectionBuilderLike<TDoc>,
): TxCollection<TDoc> {
  return {
    async insert(doc: Partial<TDoc>): Promise<void> {
      const filled = applyDefaults(builder, doc as Record<string, unknown>);
      try {
        await native.txInsert(txHandle, collName, JSON.stringify(filled));
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async find(filter: Record<string, unknown> = {}): Promise<TDoc[]> {
      let rows: string[];
      try {
        rows = await native.txFind(txHandle, collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
      // Safety: same Rust-authority / schema-driven codec rationale as
      // `makeCollection`'s `find` above — every stored doc has been
      // validated and round-tripped through the symmetric codec, so
      // `JSON.parse(r) as TDoc` is sound.
      return rows.map((r) => JSON.parse(r) as TDoc);
    },
    async findOne(filter: Record<string, unknown> = {}): Promise<TDoc | null> {
      let row: string | null;
      try {
        row = await native.txFindOne(txHandle, collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
      return row === null ? null : (JSON.parse(row) as TDoc);
    },
    async count(filter: Record<string, unknown> = {}): Promise<number> {
      try {
        return await native.txCount(txHandle, collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async delete(filter: Record<string, unknown> = {}): Promise<number> {
      try {
        return await native.txDeleteMany(txHandle, collName, JSON.stringify(filter));
      } catch (err) {
        throw mapNativeError(err);
      }
    },
    async update(
      filter: Record<string, unknown>,
      patch: Partial<TDoc>,
    ): Promise<number> {
      // Delegates to the shared `applyUpdateLoop`. `this` is the in-flight
      // `TxCollection<TDoc>`, structurally assignable to
      // `TxProxyForUpdate<TDoc>` (it carries insert / find / delete).
      // The single-implementation guarantee keeps the id-guard and
      // merge semantics in lock-step with `Collection.update`.
      return applyUpdateLoop<TDoc>(this, filter, patch);
    },
  };
}

// ── Compile-time SchemaDatabase seam guard: Task-13 carry-forward (zero runtime) ─
//
// Pins the REAL user seam: `SchemaDatabase<typeof _seedSchema>` (what a caller
// actually gets from `open(path, { schema })`), NOT just `makeCollection<…>`
// directly (which Task-13's `_dxProbe` in collection.ts already covers).
//
// If `SchemaDatabase` regresses so that `db.users.find()` widens to
// `Promise<unknown[]>` instead of `Promise<Doc[]>`, the `AssertTrue<Equals<…>>`
// aliases below produce a compile error at `tsc --noEmit` time (the CI typecheck
// gate), because `Equals<unknown[], Doc[]>` evaluates to `false`, which is not
// assignable to the `true` constraint.
//
// This is TYPE-ONLY (zero runtime behavior impact): `_seedSchema` is a `const`
// that is module-private, never exported, and never referenced by any runtime
// path — a tree-shaker drops it. The `s` import is also only used in this block.
//
// Lives in `src/database.ts` (included by `tsconfig.json`'s `src/**/*`) so
// `pnpm --filter nookdb typecheck` / `pnpm lint` enforces it; `__tests__/` is
// excluded by tsconfig and `expectTypeOf` is a vitest-run no-op, so the guard
// MUST live in `src/`.

import { s as _s } from './schema/s.js';

/** `true` iff `A` and `B` are mutually assignable (exact type equality). */
type _Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** Compile error unless `T` is exactly `true`. */
type _AssertTrue<T extends true> = T;

// A LIVE `s.*` schema chain — mirrors the Task-13 `_liveCanonical` pattern in
// `s.ts`. Module-private const: never exported, never referenced at runtime.
const _seedSchema = {
  users: _s
    .collection({
      id: _s.id(),
      email: _s.string().email(),
      role: _s.enum(['admin', 'user'] as const),
    })
    .uniqueIndex('email')
    .index('role'),
};

// The mapped handle type the user receives from `open(path, { schema })`.
type _SeedDb = SchemaDatabase<typeof _seedSchema>;

// `db.users.find()` MUST resolve to `Doc[]` (NOT `unknown[]`).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SeedFindReturnsDocArray = _AssertTrue<
  _Equals<
    Awaited<ReturnType<_SeedDb['users']['find']>>,
    { id: string; email: string; role: 'admin' | 'user' }[]
  >
>;

// `db.users.findOne()` MUST resolve to `Doc | null`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SeedFindOneReturnsDocOrNull = _AssertTrue<
  _Equals<
    Awaited<ReturnType<_SeedDb['users']['findOne']>>,
    { id: string; email: string; role: 'admin' | 'user' } | null
  >
>;

// `SchemaDatabase` MUST expose `close(): void`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SeedDbHasClose = _AssertTrue<_Equals<_SeedDb['close'], () => void>>;

// Extract `TxProxy<TSchema>` from the `transaction(cb)` callback parameter:
// the same surface a user sees as `tx` inside `db.transaction(async (tx) => …)`.
type _SeedTxProxy = Parameters<_SeedDb['transaction']>[0] extends (
  tx: infer TxP,
) => Promise<unknown>
  ? TxP
  : never;

// `tx.users.find()` MUST resolve to `Promise<Doc[]>` — same `TSchema[K]['$type']`
// guarantee as the top-level proxy. Pins the Task 5 cross-process tx proxy
// against any future regression that drops the per-collection `$type` lookup
// in `TxProxy<TSchema>` back to `unknown` (mirroring the existing top-level
// `_SeedFindReturnsDocArray` guard above).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SeedTxUsersFindReturnsDocArray = _AssertTrue<
  _Equals<
    Awaited<ReturnType<_SeedTxProxy['users']['find']>>,
    { id: string; email: string; role: 'admin' | 'user' }[]
  >
>;
