import { describe, it, expect, vi } from 'vitest';
import { makeCollection, type NativeSchemaDatabase } from '../collection.js';

function stubNative() {
  return {
    find: vi.fn(() => Promise.resolve([] as string[])),
    findOne: vi.fn(() => Promise.resolve(null)),
    count: vi.fn(() => Promise.resolve(0)),
    deleteMany: vi.fn(() => Promise.resolve(0)),
  } as unknown as NativeSchemaDatabase & {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
}

const builder = { $type: {} as { id: string; n: number }, _fields: {} } as never;
const noTx = ((cb: never) => Promise.resolve(cb)) as never;

describe('query options serialization', () => {
  it('serializes sort object to ordered pairs on the wire', async () => {
    const native = stubNative();
    const c = makeCollection<{ id: string; n: number }>(native, 'u', builder, noTx);
    await c.find({ n: { $gt: 1 } }, { sort: { n: 'desc' }, limit: 5, offset: 2 });
    expect(native.find).toHaveBeenCalledWith(
      'u',
      JSON.stringify({ n: { $gt: 1 } }),
      JSON.stringify({ sort: [['n', 'desc']], limit: 5, offset: 2 }),
    );
  });

  it('omits optionsJson when no options given (backward compat)', async () => {
    const native = stubNative();
    const c = makeCollection<{ id: string; n: number }>(native, 'u', builder, noTx);
    await c.find({});
    expect(native.find).toHaveBeenCalledWith('u', JSON.stringify({}), undefined);
  });

  it('passes options through findOne and count', async () => {
    const native = stubNative();
    const c = makeCollection<{ id: string; n: number }>(native, 'u', builder, noTx);
    await c.findOne({}, { sort: { n: 'asc' } });
    await c.count({}, { limit: 10 });
    expect(native.findOne).toHaveBeenCalledWith('u', '{}', JSON.stringify({ sort: [['n', 'asc']] }));
    expect(native.count).toHaveBeenCalledWith('u', '{}', JSON.stringify({ limit: 10 }));
  });

  it('sends limit:0 (meaningful falsy value, not dropped)', async () => {
    const native = stubNative();
    const c = makeCollection<{ id: string; n: number }>(native, 'u', builder, noTx);
    await c.find({}, { limit: 0 });
    expect(native.find).toHaveBeenCalledWith('u', '{}', JSON.stringify({ limit: 0 }));
  });

  it('empty sort object with no other options sends undefined', async () => {
    const native = stubNative();
    const c = makeCollection<{ id: string; n: number }>(native, 'u', builder, noTx);
    await c.find({}, { sort: {} });
    expect(native.find).toHaveBeenCalledWith('u', '{}', undefined);
  });
});
