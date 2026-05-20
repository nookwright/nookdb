import type { Envelope, SerializedError, Transport } from './wire.js';
import { mapBridgeError } from './errors.js';

let nextId = 1;
function freshId(): string {
  // Prefix avoids collision with handshake's literal 'hello' correlation id.
  return `r${nextId++}`;
}

type SendResult =
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedError };

interface PendingSlot {
  resolve: (r: SendResult) => void;
  reject: (e: unknown) => void;
}

interface ExpectSlot {
  type: Envelope['type'];
  resolve: (env: Envelope) => void;
  reject: (e: unknown) => void;
}

/**
 * Owns the per-transport response routing. One `RpcDispatcher` per
 * connection. `send` posts a query/subscribe envelope (replacing its
 * `id` with a fresh unique id) and returns a promise that resolves
 * when the matching `response` arrives. Close → all in-flight promises
 * reject. `onUnhandled` lets other modules (e.g. `remoteLiveNative`)
 * consume envelopes the dispatcher does not (e.g. `subscribe-emit`).
 */
export class RpcDispatcher {
  readonly #transport: Transport;
  readonly #pending = new Map<string, PendingSlot>();
  // Indexed by the originating envelope's `type` so `hello` is keyed as 'hello'.
  readonly #expecting = new Map<string, ExpectSlot>();
  readonly #unhandled: ((env: Envelope) => void)[] = [];
  #closed = false;

  constructor(transport: Transport) {
    this.#transport = transport;
    transport.onmessage((env) => this.#dispatch(env));
    transport.onclose(() => this.#onClose());
  }

  send(env: Envelope): Promise<SendResult> {
    if (this.#closed) {
      return Promise.reject(new Error('transport closed'));
    }
    if (env.type !== 'query' && env.type !== 'subscribe') {
      return Promise.reject(
        new Error(`rpc.send unsupported envelope type: ${env.type}`),
      );
    }
    const id = freshId();
    const stamped: Envelope = { ...env, id };
    return new Promise<SendResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#transport.postMessage(stamped);
    });
  }

  /**
   * Posts an envelope expecting a specific reply `type`. Correlation id
   * is the originating envelope's `type` (so `hello` is keyed as the
   * literal string 'hello'). If a `response` with `ok:false` arrives
   * with `id` matching that correlation key, it is routed to this slot
   * (the host's handshake-mismatch path uses `id:'hello'`).
   */
  expect(env: Envelope, expectedType: Envelope['type']): Promise<Envelope> {
    if (this.#closed) {
      return Promise.reject(new Error('transport closed'));
    }
    const correlationKey = env.type;
    return new Promise<Envelope>((resolve, reject) => {
      this.#expecting.set(correlationKey, { type: expectedType, resolve, reject });
      this.#transport.postMessage(env);
    });
  }

  postCancel(env: Envelope): void {
    if (this.#closed) return;
    this.#transport.postMessage(env);
  }

  onUnhandled(handler: (env: Envelope) => void): void {
    this.#unhandled.push(handler);
  }

  #dispatch(env: Envelope): void {
    if (env.type === 'response') {
      // Try matching a pending RPC by id.
      const pending = this.#pending.get(env.id);
      if (pending !== undefined) {
        this.#pending.delete(env.id);
        pending.resolve(
          env.ok
            ? { ok: true, value: env.value }
            : { ok: false, error: env.error },
        );
        return;
      }
      // Try matching a pending expect() — handshake mismatch path uses id:'hello'.
      const exp = this.#expecting.get(env.id);
      if (exp !== undefined) {
        this.#expecting.delete(env.id);
        if (env.ok) {
          exp.reject(
            new Error(
              `[protocol] unexpected ok response during ${env.id} expectation`,
            ),
          );
        } else {
          exp.reject(mapBridgeError(env.error));
        }
        return;
      }
      // Orphan response — fall through to onUnhandled.
    } else if (env.type === 'hello-ack') {
      const exp = this.#expecting.get('hello');
      if (exp !== undefined && exp.type === 'hello-ack') {
        this.#expecting.delete('hello');
        exp.resolve(env);
        return;
      }
    }
    // Anything we didn't consume goes to onUnhandled (subscribe-emit,
    // orphan messages, etc.).
    for (const h of this.#unhandled) h(env);
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, slot] of this.#pending) {
      slot.reject(new Error('transport closed'));
    }
    this.#pending.clear();
    for (const [, exp] of this.#expecting) {
      exp.reject(new Error('transport closed'));
    }
    this.#expecting.clear();
  }
}

/**
 * Convenience: send a typed query envelope and unwrap the response.
 * Throws a typed `NookError` on `ok:false`.
 */
export async function rpc<T>(
  d: RpcDispatcher,
  op: 'insert' | 'find' | 'findOne' | 'count' | 'delete',
  collection: string,
  argsJson: string,
): Promise<T> {
  const r = await d.send({
    type: 'query',
    id: '', // replaced by dispatcher
    collection,
    op,
    argsJson,
  });
  if (r.ok) return r.value as T;
  throw mapBridgeError(r.error);
}

/** Convenience for the handshake. */
export async function rpcExpect(
  d: RpcDispatcher,
  env: Envelope,
  expectedType: Envelope['type'],
): Promise<Envelope> {
  return d.expect(env, expectedType);
}
