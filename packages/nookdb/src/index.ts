import { loadBinding } from './loader.js';
import {
  Database,
  makeSchemaDatabase,
  type NativeDatabase,
  type SchemaDatabase,
  type SchemaShape,
} from './database.js';
import { type NativeSchemaDatabase } from './collection.js';
import { mapNativeError } from './errors.js';
import { toDescriptor } from './schema/s.js';

interface BindingModule {
  Database: {
    open(path: string): Promise<NativeDatabase>;
    openWithSchema(path: string, schemaDescriptor: string): Promise<NativeSchemaDatabase>;
  };
}

let bindingCache: BindingModule | null = null;
function getBinding(): BindingModule {
  if (bindingCache !== null) return bindingCache;
  // Cast is safe: this local BindingModule is the typed, wider view of the
  // loader's intentionally-`unknown` Database shape (FFI boundary narrowing).
  bindingCache = loadBinding() as BindingModule;
  return bindingCache;
}

/** Options accepted by the schema-aware `open` overload. */
export interface OpenSchemaOptions<TSchema extends SchemaShape> {
  /**
   * The schema object built with `s.*` (a map of collection name →
   * `s.collection(...)`). Drives both the authoritative server-side
   * compile and the fully-typed `db[collectionName]` proxies.
   */
  schema: TSchema;
}

/**
 * Opens (or creates) a Nook database at `path`.
 *
 * **Bytes-only (M1) overload.** Returns the unstable bytes-level
 * {@link Database}. Unchanged from M1.
 */
export async function open(path: string): Promise<Database>;
/**
 * Opens (or creates) a Nook database at `path`, bound to `options.schema`.
 *
 * Returns the typed {@link SchemaDatabase} handle: `db[collectionName]`
 * is a fully-typed collection proxy whose document type derives from the
 * schema (PRD §7.1 — no type duplication). The schema is compiled and
 * validated authoritatively by the Rust core.
 */
export async function open<TSchema extends SchemaShape>(
  path: string,
  options: OpenSchemaOptions<TSchema>,
): Promise<SchemaDatabase<TSchema>>;
export async function open<TSchema extends SchemaShape>(
  path: string,
  options?: OpenSchemaOptions<TSchema>,
): Promise<Database | SchemaDatabase<TSchema>> {
  if (options === undefined) {
    try {
      const native = await getBinding().Database.open(path);
      return new Database(native);
    } catch (err) {
      throw mapNativeError(err);
    }
  }

  try {
    const native = await getBinding().Database.openWithSchema(
      path,
      toDescriptor(options.schema as never),
    );
    return makeSchemaDatabase(native, options.schema);
  } catch (err) {
    throw mapNativeError(err);
  }
}

export { Database } from './database.js';
export type {
  DbEntry,
  NativeDatabase,
  SchemaDatabase,
  SchemaShape,
  TxCollection,
  TxProxy,
} from './database.js';
export type { BackupStats, RestoreOptions, RestoreStats } from './backup.js';
export { backupToPath, restoreFromPath } from './backup.js';
export type { Collection, CollectionBuilderLike, InsertDoc, NativeSchemaDatabase, QueryOptions } from './collection.js';
export { LiveQuery } from './live.js';
export type { LiveNative } from './live.js';
export { s, toDescriptor } from './schema/s.js';
export type { AnyBuilder, DocOf } from './schema/s.js';
export {
  NookError,
  NookStorageError,
  NookCorruptionError,
  NookConflictError,
  NookTransactionError,
  NookInvalidArgError,
  NookClosedError,
  NookSchemaError,
  NookMigrationError,
  NookPlatformError,
  mapNativeError,
} from './errors.js';
export type {
  PlatformDescriptor,
  SupportedArch,
  SupportedLibc,
  SupportedPlatform,
} from './loader.js';
