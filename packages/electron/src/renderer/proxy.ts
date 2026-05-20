import { LiveQuery, type LiveNative, NookError } from 'nookdb';
import type {
  Collection,
  CollectionBuilderLike,
  InsertDoc,
  SchemaDatabase,
  SchemaShape,
  TxProxy,
} from 'nookdb';

import { rpc } from '../shared/rpc.js';
import type { RpcDispatcher } from '../shared/rpc.js';
import { remoteLiveNative } from './livenative.js';
import type { Transport } from '../shared/wire.js';

/**
 * Builds a typed `Collection<TDoc>` proxy that routes ops over the
 * bridge. Matches the M3 `Collection<TDoc>` shape exactly so existing
 * app code (`db.users.find(...)`, `db.users.live(...).subscribe(...)`)
 * is byte-identical to its main-process form.
 *
 * Default-filling (UUID v7 + `.default()`) is currently NOT applied here
 * — `nookdb` does not export `applyDefaults`. The Rust core is the
 * authoritative validator and rejects missing required fields cleanly.
 * M5 follow-up: export `applyDefaults` from `nookdb` for renderer reuse.
 */
export function makeRemoteCollection<TDoc>(
  dispatcher: RpcDispatcher,
  live: LiveNative,
  collName: string,
  builder: CollectionBuilderLike<TDoc>,
): Collection<TDoc> {
  void builder; // Reserved for future use with applyDefaults.
  return {
    async insert(doc: InsertDoc<TDoc>): Promise<void> {
      await rpc<void>(dispatcher, 'insert', collName, JSON.stringify(doc));
    },
    async find(filter: Record<string, unknown> = {}): Promise<TDoc[]> {
      return rpc<TDoc[]>(dispatcher, 'find', collName, JSON.stringify(filter));
    },
    async findOne(filter: Record<string, unknown> = {}): Promise<TDoc | null> {
      return rpc<TDoc | null>(dispatcher, 'findOne', collName, JSON.stringify(filter));
    },
    async count(filter: Record<string, unknown> = {}): Promise<number> {
      return rpc<number>(dispatcher, 'count', collName, JSON.stringify(filter));
    },
    async delete(filter: Record<string, unknown> = {}): Promise<number> {
      return rpc<number>(dispatcher, 'delete', collName, JSON.stringify(filter));
    },
    async update(
      filter: Record<string, unknown>,
      patch: Partial<TDoc>,
    ): Promise<number> {
      // M5c naive renderer-side implementation: find + per-match delete+insert
      // over the wire. Each delete and insert is atomic Host-side (single redb
      // write-tx via NAPI), but ACROSS multiple matched docs there is no
      // atomicity guarantee — another renderer could race-read intermediate
      // state. M5c-release retrofit: add a `update` wire envelope so the Host
      // can call `db.<coll>.update(...)` in one atomic batch.
      const matches = await rpc<(TDoc & { id: string })[]>(
        dispatcher,
        'find',
        collName,
        JSON.stringify(filter),
      );
      let count = 0;
      for (const doc of matches) {
        if (
          'id' in patch &&
          (patch as { id?: string }).id !== doc.id
        ) {
          throw new NookError(
            `[schema] cannot change id field in update (matched id=${doc.id})`,
          );
        }
        const merged = { ...doc, ...patch };
        await rpc<number>(
          dispatcher,
          'delete',
          collName,
          JSON.stringify({ id: doc.id }),
        );
        await rpc<void>(
          dispatcher,
          'insert',
          collName,
          JSON.stringify(merged),
        );
        count += 1;
      }
      return count;
    },
    live(filter: Record<string, unknown> = {}): LiveQuery<TDoc> {
      return new LiveQuery<TDoc>(live, collName, filter);
    },
  };
}

/**
 * Wraps the bridge transport + dispatcher + schema into a typed
 * `SchemaDatabase<TSchema>` handle plus a `disconnect()` method. Each
 * schema collection becomes a `RemoteCollection` proxy.
 */
export function makeRemoteDatabase<TSchema extends SchemaShape>(
  transport: Transport,
  dispatcher: RpcDispatcher,
  schema: TSchema,
): SchemaDatabase<TSchema> & { disconnect(): void } {
  const live = remoteLiveNative(transport, dispatcher);
  const handle: Record<string, unknown> = {
    disconnect(): void {
      transport.close();
    },
    close(): void {
      transport.close();
    },
    transaction<_T>(_cb: (tx: TxProxy<TSchema>) => Promise<_T>): Promise<_T> {
      // M5c naive: `db.transaction(cb)` is not yet wired through the bridge.
      // The Host-side `db.transaction` callback works inside the main process,
      // but cross-process write-tx requires a new wire envelope that buffers
      // tx ops and dispatches them atomically Host-side. M5c-release retrofit.
      return Promise.reject(
        new NookError(
          '[unsupported] db.transaction(cb) is not yet available in the Electron renderer (M5c-release work)',
        ),
      );
    },
  };
  for (const [collName, builder] of Object.entries(schema)) {
    handle[collName] = makeRemoteCollection(
      dispatcher,
      live,
      collName,
      builder,
    );
  }
  return handle as SchemaDatabase<TSchema> & { disconnect(): void };
}
