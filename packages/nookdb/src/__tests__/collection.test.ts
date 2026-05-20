import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { makeCollection } from '../collection.js';
import { LiveQuery } from '../live.js';

// ── Stub helpers ─────────────────────────────────────────────────────────────

/** Minimal native stub satisfying NativeSchemaDatabase (including live members).
 *
 * `live` is written as a non-`async` function returning an already-resolved
 * promise (vs. an `async` arrow) purely to satisfy
 * `@typescript-eslint/require-await` — behaviourally identical: the returned
 * promise is already resolved. Same pattern as `live.test.ts`'s `stubNative`.
 */
function makeNativeStub() {
  return {
    insert: vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined),
    find: vi.fn<[string, string], Promise<string[]>>().mockResolvedValue([]),
    findOne: vi.fn<[string, string], Promise<string | null>>().mockResolvedValue(null),
    count: vi.fn<[string, string], Promise<number>>().mockResolvedValue(0),
    deleteMany: vi.fn<[string, string], Promise<number>>().mockResolvedValue(0),
    close: vi.fn<[], void>(),
    live: vi.fn((_c: string, _f: string, _onEmit: (env: string) => void) =>
      Promise.resolve({
        subscriptionId: 's1',
        initialJson: JSON.stringify({ ok: true, value: [] }),
      }),
    ),
    liveCancel: vi.fn<[string], void>(),
  };
}

/** Minimal CollectionBuilder stub with `$type` phantom and `_fields` map. */
function makeBuilderStub() {
  return {
    $type: undefined as unknown as { id: string; role: 'admin' | 'user' },
    _fields: {
      id: { _state: { type: 'id' } },
      role: { _state: { type: 'enum' } },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('makeCollection — live()', () => {
  it('collection.live(filter?) returns a LiveQuery typed to the document', () => {
    const native = makeNativeStub();
    const builder = makeBuilderStub();
    const c = makeCollection(native as never, 'u', builder);
    const lq = c.live({ role: 'admin' });
    expect(lq).toBeInstanceOf(LiveQuery);
    lq.dispose();
  });

  it('collection.live() with no filter also returns a LiveQuery', () => {
    const native = makeNativeStub();
    const builder = makeBuilderStub();
    const c = makeCollection(native as never, 'u', builder);
    const lq = c.live();
    expect(lq).toBeInstanceOf(LiveQuery);
    lq.dispose();
  });

  it('live() passes the collection name and serialised filter to native.live', async () => {
    const native = makeNativeStub();
    const builder = makeBuilderStub();
    const c = makeCollection(native as never, 'orders', builder);
    const lq = c.live({ status: 'open' });
    // Wait for the async native.live call to be made (constructor fires it)
    await vi.waitFor(() =>
      expect(native.live).toHaveBeenCalledWith(
        'orders',
        JSON.stringify({ status: 'open' }),
        expect.any(Function),
      ),
    );
    lq.dispose();
  });
});

// ── Compile-time type-level guard (zero runtime) ──────────────────────────────
//
// Confirms the `live()` return type is `LiveQuery<Doc>` (NOT `LiveQuery<unknown>`)
// at the `expectTypeOf` level, mirroring the `_LiveReturnsLiveQuery` guard in
// collection.ts. If the proxy widens to `unknown` this assertion fails at
// vitest typecheck time.

it('live() return type is LiveQuery<Doc> (not LiveQuery<unknown>)', () => {
  const native = makeNativeStub();
  const builder = makeBuilderStub();
  const c = makeCollection(native as never, 'u', builder);
  const lq = c.live();
  expectTypeOf(lq).toEqualTypeOf<LiveQuery<{ id: string; role: 'admin' | 'user' }>>();
  lq.dispose();
});
