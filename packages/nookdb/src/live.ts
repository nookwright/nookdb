/**
 * Reactive query handle (`LiveQuery<T>`, PRD §7.3).
 *
 * `collection.live(...)` (Task 10) returns this **synchronously** while
 * the underlying native registration (`LiveNative.live`) runs
 * asynchronously. Declared in this module (with its own `LiveNative`
 * surface) so the proxy is unit-testable against a stub — it needs no
 * real binding.
 *
 * Semantics:
 * - `.value` is `[]` until the first snapshot resolves, then holds the
 *   latest snapshot.
 * - `subscribe(next, onError?)` is behavior-subject: if a snapshot has
 *   already arrived it fires `next` immediately, otherwise on the first
 *   one, then on every subsequent emission. Returns an unsubscribe fn.
 * - `for await … of lq` yields snapshots; `break` (→ iterator
 *   `return()`) disposes.
 * - A recompute error envelope (`{ ok:false }`) is **terminal**:
 *   `onError` fires, `for await` rejects, the core subscription is
 *   cancelled, and any further envelopes are ignored.
 * - `dispose()` is idempotent.
 * - If `dispose()` is called *before* the async native registration
 *   resolves, the constructor's `.then` handler cancels the core
 *   subscription so it cannot leak.
 */

import { mapNativeError, type NookError } from './errors.js';

/** Native subscription surface (declared here so the proxy is unit-testable with a stub). */
export interface LiveNative {
  live(
    collection: string,
    filterJson: string,
    optionsJson: string | undefined,
    onEmit: (envelopeJson: string) => void,
  ): Promise<{ subscriptionId: string; initialJson: string }>;
  liveCancel(subscriptionId: string): void;
}

type Envelope = { ok: true; value: unknown[] } | { ok: false; error: string };

interface Subscriber<T> {
  next: (v: T[]) => void;
  onError: ((e: NookError) => void) | undefined;
}

interface IterDriver<T> {
  push: (v: T[]) => void;
  fail: (e: unknown) => void;
  end: () => void;
}

/**
 * A reactive query handle (PRD §7.3). Returned **synchronously** from
 * `collection.live(...)`; the underlying native registration runs
 * asynchronously, so `.value` is `[]` until the first snapshot
 * resolves, then holds the latest. `subscribe`/`for await` follow
 * behavior-subject semantics. A recompute error is terminal: `onError`
 * fires, `for await` throws, the subscription is cancelled.
 */
export class LiveQuery<T> {
  #value: T[] = [];
  #subs = new Set<Subscriber<T>>();
  #iterDrivers = new Set<IterDriver<T>>();
  #subscriptionId: string | undefined;
  #disposed = false;
  #errored = false;
  #native: LiveNative | undefined;
  #received = false;

  constructor(
    native: LiveNative,
    collection: string,
    filter: Record<string, unknown>,
    optionsJson?: string,
  ) {
    void native
      .live(collection, JSON.stringify(filter), optionsJson, (env) => {
        this.#onEnvelope(env);
      })
      .then(({ subscriptionId, initialJson }) => {
        this.#subscriptionId = subscriptionId;
        if (this.#disposed) {
          // LOAD-BEARING: dispose() ran before the async native
          // registration resolved. Cancel the core subscription now or
          // it leaks (dispose() could not see #subscriptionId yet).
          native.liveCancel(subscriptionId);
          return;
        }
        this.#native = native;
        this.#onEnvelope(initialJson);
      })
      .catch((err: unknown) => {
        this.#fail(mapNativeError(err));
      });
  }

  /**
   * Latest snapshot. NOTE: this is the live internal array reference (no
   * defensive copy — copying per read/emission would be wasteful); treat
   * it as read-only and do not mutate it.
   */
  get value(): T[] {
    return this.#value;
  }

  subscribe(next: (v: T[]) => void, onError?: (e: NookError) => void): () => void {
    if (this.#disposed) return () => {};
    const rec: Subscriber<T> = { next, onError };
    this.#subs.add(rec);
    if (this.#received) next(this.#value);
    return () => {
      this.#subs.delete(rec);
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<T[]> {
    const queue: T[][] = [];
    let pending: ((r: IteratorResult<T[]>) => void) | undefined;
    let pendingReject: ((e: unknown) => void) | undefined;
    let failWith: unknown;
    let ended = false;
    const driver: IterDriver<T> = {
      push: (v: T[]) => {
        if (pending) {
          pending({ value: v, done: false });
          pending = undefined;
          pendingReject = undefined;
        } else queue.push(v);
      },
      fail: (e: unknown) => {
        failWith = e;
        if (pendingReject) {
          pendingReject(e);
          pending = undefined;
          pendingReject = undefined;
        }
      },
      end: () => {
        ended = true;
        if (pending) {
          pending({ value: undefined as unknown as T[], done: true });
          pending = undefined;
          pendingReject = undefined;
        }
      },
    };
    this.#iterDrivers.add(driver);
    if (this.#received) driver.push(this.#value);
    return {
      next: () =>
        new Promise<IteratorResult<T[]>>((resolve, reject) => {
          if (failWith !== undefined) {
            reject(failWith);
            return;
          }
          if (queue.length) {
            resolve({ value: queue.shift()!, done: false });
            return;
          }
          if (ended) {
            resolve({ value: undefined as unknown as T[], done: true });
            return;
          }
          pending = resolve;
          pendingReject = reject;
        }),
      return: () => {
        this.#iterDrivers.delete(driver);
        this.dispose();
        return Promise.resolve({ value: undefined as unknown as T[], done: true });
      },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const d of this.#iterDrivers) d.end();
    this.#iterDrivers.clear();
    this.#subs.clear();
    if (this.#subscriptionId && this.#native) this.#native.liveCancel(this.#subscriptionId);
  }

  #onEnvelope(envelopeJson: string): void {
    if (this.#disposed || this.#errored) return;
    let env: Envelope;
    try {
      env = JSON.parse(envelopeJson) as Envelope;
    } catch {
      this.#fail(mapNativeError(new Error('[corruption] malformed live envelope')));
      return;
    }
    if (env.ok) {
      this.#value = env.value as T[];
      this.#received = true;
      for (const s of this.#subs) s.next(this.#value);
      for (const d of this.#iterDrivers) d.push(this.#value);
    } else {
      this.#fail(mapNativeError(new Error(env.error)));
    }
  }

  #fail(err: NookError): void {
    if (this.#errored) return;
    this.#errored = true;
    for (const s of this.#subs) s.onError?.(err);
    for (const d of this.#iterDrivers) d.fail(err);
    this.dispose();
  }
}
