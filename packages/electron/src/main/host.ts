/**
 * Host — main-process message router for the @nookdb/electron bridge.
 *
 * Each connected renderer port is tracked as a `PortState`. On handshake
 * the canonical descriptor is compared byte-for-byte; on success the port
 * is promoted to "hello seen" and query/subscribe envelopes are routed.
 *
 * Subscriptions use the existing M3 `Collection.live()` surface on the
 * main side — zero new core surface, same coalesce + dispose semantics.
 * The `PortBoundEmitSink` from the spec is the subscriber callback closure
 * that forwards snapshots as `subscribe-emit` envelopes over the wire.
 *
 * Transport.close() is NOT called from #drain — the renderer or the
 * schema-mismatch path already triggered close; calling it again would
 * re-invoke onclose (loop).
 */

import { type SchemaDatabase, type SchemaShape, toDescriptor } from 'nookdb';
import { type Authorizer, type SenderInfo } from '../shared/authorizer.js';
import { canonicalize } from '../shared/canonical.js';
import type { BridgeOp, Envelope, QueryOp, SerializedError } from '../shared/wire.js';

/**
 * The server-side transport interface. Same shape as the renderer-side
 * `Transport` but documented as the Host's incoming side. The Electron
 * adapter wraps `MessagePortMain`; tests pass a memory stub.
 */
export interface ServerTransport {
  postMessage(env: Envelope): void;
  onmessage(handler: (env: Envelope) => void): void;
  onclose(handler: () => void): void;
  close(): void;
}

export type { SenderInfo };

interface SubscriptionHandle {
  dispose: () => void;
}

interface PortState {
  transport: ServerTransport;
  sender: SenderInfo;
  /** Renderer-chosen subscriptionId → handle that disposes the M3 LiveQuery. */
  subs: Map<string, SubscriptionHandle>;
  helloSeen: boolean;
  closed: boolean;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const { name } = err;
    const kind =
      name === 'NookForbiddenError' ? 'forbidden'
      : name === 'NookSchemaError' ? 'schema'
      : name === 'NookInvalidArgError' ? 'invalid_arg'
      : name === 'NookStorageError' ? 'storage'
      : name === 'NookCorruptionError' ? 'corruption'
      : name === 'NookConflictError' ? 'conflict'
      : name === 'NookTransactionError' ? 'transaction'
      : name === 'NookClosedError' ? 'closed'
      : name === 'NookMigrationError' ? 'migration'
      : 'storage';
    return { kind, message: err.message };
  }
  return { kind: 'storage', message: String(err) };
}

/**
 * Typed handle for a single collection, narrowed to the ops Host needs.
 * Using `unknown[]` for find/findOne/count/delete to avoid any-propagation
 * through the untyped dispatch path.
 */
interface CollectionHandle {
  insert(doc: unknown): Promise<void>;
  find(filter: Record<string, unknown>): Promise<unknown[]>;
  findOne(filter: Record<string, unknown>): Promise<unknown>;
  count(filter: Record<string, unknown>): Promise<number>;
  delete(filter: Record<string, unknown>): Promise<number>;
  live(filter: Record<string, unknown>): LiveQueryHandle;
}

/** The subset of LiveQuery<T> that Host depends on. */
interface LiveQueryHandle {
  value: unknown[];
  subscribe(
    next: (v: unknown[]) => void,
    onError: (e: unknown) => void,
  ): () => void;
  dispose(): void;
}

export class Host<TSchema extends SchemaShape> {
  readonly #db: SchemaDatabase<TSchema>;
  readonly #expectedDescriptor: string;
  readonly #authorizer: Authorizer;
  readonly #ports = new Set<PortState>();

  constructor(db: SchemaDatabase<TSchema>, schema: TSchema, authorizer: Authorizer) {
    this.#db = db;
    this.#expectedDescriptor = canonicalize(JSON.parse(toDescriptor(schema as never)) as unknown);
    this.#authorizer = authorizer;
  }

  /** Registers a connected port. Tests inject a memory ServerTransport. */
  acceptClient(transport: ServerTransport, sender: SenderInfo): void {
    const state: PortState = {
      transport,
      sender,
      subs: new Map(),
      helloSeen: false,
      closed: false,
    };
    this.#ports.add(state);
    transport.onmessage((env) => {
      void this.#route(state, env).catch((err: unknown) => {
        console.error('nook bridge route error', err);
      });
    });
    transport.onclose(() => {
      this.#drain(state);
    });
  }

  /** Disposes all active ports. */
  async close(): Promise<void> {
    // Snapshot first — #drain mutates #ports.
    const ports = [...this.#ports];
    for (const state of ports) this.#drain(state);
    return Promise.resolve();
  }

  async #route(state: PortState, env: Envelope): Promise<void> {
    if (state.closed) return;

    if (env.type === 'hello') {
      if (state.helloSeen) return;
      try {
        const incoming = canonicalize(JSON.parse(env.descriptor) as unknown);
        if (incoming === this.#expectedDescriptor) {
          state.helloSeen = true;
          state.transport.postMessage({
            type: 'hello-ack',
            clientId: env.clientId,
            sessionId: `s-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`,
          });
        } else {
          state.transport.postMessage({
            type: 'response',
            id: 'hello',
            ok: false,
            error: { kind: 'schema', message: 'descriptor mismatch' },
          });
          state.transport.close();
        }
      } catch {
        state.transport.postMessage({
          type: 'response',
          id: 'hello',
          ok: false,
          error: { kind: 'schema', message: 'malformed descriptor' },
        });
        state.transport.close();
      }
      return;
    }

    // No ops before handshake.
    if (!state.helloSeen) return;

    if (env.type === 'query') {
      await this.#handleQuery(state, env);
      return;
    }
    if (env.type === 'subscribe') {
      await this.#handleSubscribe(state, env);
      return;
    }
    if (env.type === 'subscribe-cancel') {
      const handle = state.subs.get(env.subscriptionId);
      if (handle !== undefined) {
        handle.dispose();
        state.subs.delete(env.subscriptionId);
      }
      return;
    }
    // Renderer-bound envelopes (response, subscribe-emit, hello-ack) are
    // ignored on the host side — they must never arrive here in normal
    // operation but we silently drop them rather than throwing.
  }

  async #handleQuery(
    state: PortState,
    env: Extract<Envelope, { type: 'query' }>,
  ): Promise<void> {
    try {
      const op: BridgeOp = {
        collection: env.collection,
        kind: env.op,
        args: env.argsJson,
      };
      const allowed = await Promise.resolve(this.#authorizer.authorize(state.sender, op));
      if (!allowed) {
        state.transport.postMessage({
          type: 'response',
          id: env.id,
          ok: false,
          error: {
            kind: 'forbidden',
            message: `authorizer denied ${env.op} on ${env.collection}`,
          },
        });
        return;
      }
      const value = await this.#dispatch(env.collection, env.op, env.argsJson);
      state.transport.postMessage({ type: 'response', id: env.id, ok: true, value });
    } catch (err) {
      state.transport.postMessage({
        type: 'response',
        id: env.id,
        ok: false,
        error: serializeError(err),
      });
    }
  }

  async #handleSubscribe(
    state: PortState,
    env: Extract<Envelope, { type: 'subscribe' }>,
  ): Promise<void> {
    try {
      const op: BridgeOp = {
        collection: env.collection,
        kind: 'subscribe',
        args: { filter: env.filterJson },
      };
      const allowed = await Promise.resolve(this.#authorizer.authorize(state.sender, op));
      if (!allowed) {
        state.transport.postMessage({
          type: 'response',
          id: env.id,
          ok: false,
          error: {
            kind: 'forbidden',
            message: `authorizer denied subscribe on ${env.collection}`,
          },
        });
        return;
      }
      const coll = this.#getCollection(env.collection);
      const filter = JSON.parse(env.filterJson) as Record<string, unknown>;
      const lq = coll.live(filter);

      // Wait one microtask for the M3 LiveQuery to receive its initial snapshot.
      await new Promise<void>((r) => setTimeout(r, 0));
      const initial = JSON.stringify({ ok: true, value: lq.value });

      const off = lq.subscribe(
        (snapshot: unknown[]) => {
          if (state.closed || !state.subs.has(env.subscriptionId)) return;
          state.transport.postMessage({
            type: 'subscribe-emit',
            subscriptionId: env.subscriptionId,
            envelope: JSON.stringify({ ok: true, value: snapshot }),
          });
        },
        (e: unknown) => {
          if (state.closed || !state.subs.has(env.subscriptionId)) return;
          const s = serializeError(e);
          state.transport.postMessage({
            type: 'subscribe-emit',
            subscriptionId: env.subscriptionId,
            envelope: JSON.stringify({
              ok: false,
              error: `[${s.kind}] ${s.message}`,
            }),
          });
        },
      );

      state.subs.set(env.subscriptionId, {
        dispose: () => {
          off();
          lq.dispose();
        },
      });

      state.transport.postMessage({
        type: 'response',
        id: env.id,
        ok: true,
        value: { subscriptionId: env.subscriptionId, initialJson: initial },
      });
    } catch (err) {
      state.transport.postMessage({
        type: 'response',
        id: env.id,
        ok: false,
        error: serializeError(err),
      });
    }
  }

  /** Retrieves a typed collection handle from the SchemaDatabase. */
  #getCollection(collection: string): CollectionHandle {
    const db = this.#db as unknown as Record<string, unknown>;
    const coll = db[collection];
    if (coll === undefined || typeof coll !== 'object' || coll === null) {
      throw new Error(`[invalid_arg] unknown collection ${collection}`);
    }
    return coll as CollectionHandle;
  }

  async #dispatch(collection: string, op: QueryOp, argsJson: string): Promise<unknown> {
    const coll = this.#getCollection(collection);
    if (op === 'insert') {
      await coll.insert(JSON.parse(argsJson) as unknown);
      return undefined;
    }
    const filter = JSON.parse(argsJson) as Record<string, unknown>;
    if (op === 'find') return coll.find(filter);
    if (op === 'findOne') return coll.findOne(filter);
    if (op === 'count') return coll.count(filter);
    if (op === 'delete') return coll.delete(filter);
    throw new Error(`[invalid_arg] unknown op ${op as string}`);
  }

  #drain(state: PortState): void {
    if (state.closed) return;
    state.closed = true;
    for (const [, handle] of state.subs) handle.dispose();
    state.subs.clear();
    this.#ports.delete(state);
  }
}
