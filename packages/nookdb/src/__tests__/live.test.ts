import { describe, it, expect, vi } from 'vitest';
import { LiveQuery, type LiveNative } from '../live.js';
import type { NookError } from '../errors.js';

/**
 * Stub: capture the emit callback so the test can drive emissions.
 *
 * `live` is written as a non-`async` function returning an
 * already-resolved promise (vs. the plan's `async` arrow) purely to
 * satisfy `@typescript-eslint/require-await` — behaviourally identical:
 * `onEmit` is still captured synchronously and the returned promise is
 * already resolved, so the sync-return / async-populate timing the test
 * exercises is unchanged. `liveCancel` is captured into its own const
 * so assertions reference the bound mock (avoids
 * `@typescript-eslint/unbound-method` on a method read off `native`).
 */
function stubNative(initial: unknown[]) {
  let cb: ((env: string) => void) | undefined;
  const liveCancel = vi.fn<[string], void>();
  const native: LiveNative = {
    live: vi.fn((_c: string, _f: string, onEmit: (env: string) => void) => {
      cb = onEmit;
      return Promise.resolve({
        subscriptionId: 's1',
        initialJson: JSON.stringify({ ok: true, value: initial }),
      });
    }),
    liveCancel,
  };
  return { native, liveCancel, emit: (env: unknown) => cb?.(JSON.stringify(env)) };
}

describe('LiveQuery', () => {
  it('subscribe gets the initial snapshot then each emission; .value tracks latest', async () => {
    const { native, emit } = stubNative([{ id: '1' }]);
    const lq = new LiveQuery<{ id: string }>(native, 'u', {});
    const seen: { id: string }[][] = [];
    lq.subscribe((v) => seen.push(v));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toEqual([{ id: '1' }]);
    emit({ ok: true, value: [{ id: '1' }, { id: '2' }] });
    await vi.waitFor(() => expect(seen.length).toBe(2));
    expect(lq.value).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('async iterator yields snapshots and break disposes', async () => {
    const { native, liveCancel, emit } = stubNative([]);
    const lq = new LiveQuery<{ id: string }>(native, 'u', {});
    const out: number[] = [];
    const loop = (async () => {
      for await (const snap of lq) {
        out.push(snap.length);
        if (out.length === 2) break;
      }
    })();
    await vi.waitFor(() => expect(out.length).toBe(1)); // initial []
    emit({ ok: true, value: [{ id: 'a' }] });
    await loop;
    expect(out).toEqual([0, 1]);
    expect(liveCancel).toHaveBeenCalledWith('s1');
  });

  it('an error envelope invokes onError and makes for-await throw; query is terminal', async () => {
    const { native, liveCancel, emit } = stubNative([]);
    const lq = new LiveQuery<unknown>(native, 'u', {});
    const onError = vi.fn<[NookError], void>();
    lq.subscribe(() => {}, onError);
    emit({ ok: false, error: '[storage] disk gone' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // Terminal → cancelled. The error arrives synchronously (before the
    // async native registration `.then` resolves), so `dispose()` cannot
    // yet see `subscriptionId`; the load-bearing constructor `.then`
    // branch performs the cancel once registration settles. That settle
    // is a later microtask than the (already-synchronous) `onError`, so
    // wait for it the same behavior-subject way the other tests await
    // async settling — the assertion (terminal => liveCancel) is intact.
    await vi.waitFor(() => expect(liveCancel).toHaveBeenCalled());
  });

  it('dispose is idempotent and stops delivery', async () => {
    const { native, emit } = stubNative([{ id: '1' }]);
    const lq = new LiveQuery<{ id: string }>(native, 'u', {});
    const seen: unknown[] = [];
    lq.subscribe((v) => seen.push(v));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    lq.dispose();
    lq.dispose(); // no throw
    emit({ ok: true, value: [{ id: '9' }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.length).toBe(1);
  });

  it('a terminal error rejects a parked for-await loop (does not deadlock); query is terminal', async () => {
    const { native, liveCancel, emit } = stubNative([]);
    const lq = new LiveQuery<{ id: string }>(native, 'u', {});
    const out: number[] = [];
    let caught: unknown;
    let settled = false;
    // No `break`: after the initial [] snapshot the loop re-enters
    // `next()` and parks awaiting the next emission. A terminal error
    // must reject that parked promise (pre-fix: silently abandoned → the
    // `for await` hangs forever).
    const loopPromise = (async () => {
      try {
        for await (const snap of lq) {
          out.push(snap.length);
        }
      } catch (e) {
        caught = e;
      } finally {
        settled = true;
      }
    })();
    // Wait until the loop has consumed the initial snapshot and is parked
    // on the next `next()`.
    await vi.waitFor(() => expect(out).toEqual([0]));
    emit({ ok: false, error: '[storage] gone' });
    // Real timeout discipline: if the loop deadlocks this race resolves
    // to the timeout sentinel and the assertions below fail (test fails,
    // does not hang the suite).
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 500));
    const result = await Promise.race([loopPromise.then(() => 'settled' as const), timeout]);
    expect(result).toBe('settled');
    expect(settled).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    // Terminal => the core subscription is cancelled.
    await vi.waitFor(() => expect(liveCancel).toHaveBeenCalled());
  });

  it('slow consumer: snapshots emitted faster than consumed are buffered in order', async () => {
    const { native, emit } = stubNative([]);
    const lq = new LiveQuery<{ n: number }>(native, 'u', {});
    const seen: number[][] = [];
    const loop = (async () => {
      for await (const snap of lq) {
        seen.push(snap.map((r) => r.n));
        if (seen.length === 4) break; // initial [] + 3 emissions
        // Yield slowly so the queue must buffer ahead of consumption.
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    // Drain the initial [] snapshot first so the loop is parked, then
    // burst three emissions with no awaits between them — faster than the
    // 15ms-per-iteration consumer, forcing queue growth.
    await vi.waitFor(() => expect(seen).toEqual([[]]));
    emit({ ok: true, value: [{ n: 1 }] });
    emit({ ok: true, value: [{ n: 2 }] });
    emit({ ok: true, value: [{ n: 3 }] });
    await vi.waitFor(() => expect(seen.length).toBe(4));
    await loop;
    expect(seen).toEqual([[], [1], [2], [3]]);
  });
});
