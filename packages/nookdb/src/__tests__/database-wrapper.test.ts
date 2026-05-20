import { describe, expect, it, vi } from 'vitest';
import { Database } from '../database.js';
import { NookClosedError, NookInvalidArgError } from '../errors.js';

describe('Database (wrapper-level error mapping)', () => {
  it('wraps native [closed] error as NookClosedError', async () => {
    const fakeInner = {
      put: vi.fn().mockRejectedValue(new Error('[closed] database is closed')),
      get: vi.fn(),
      delete: vi.fn(),
      listCollection: vi.fn(),
      close: vi.fn(),
    };
    const db = new Database(fakeInner as never);
    await expect(db.put('c', Buffer.from('k'), Buffer.from('v'))).rejects.toBeInstanceOf(
      NookClosedError,
    );
  });

  it('wraps native [invalid_arg] error as NookInvalidArgError', async () => {
    const fakeInner = {
      put: vi.fn().mockRejectedValue(new Error('[invalid_arg] collection cannot be empty')),
      get: vi.fn(),
      delete: vi.fn(),
      listCollection: vi.fn(),
      close: vi.fn(),
    };
    const db = new Database(fakeInner as never);
    await expect(db.put('', Buffer.from('k'), Buffer.from('v'))).rejects.toBeInstanceOf(
      NookInvalidArgError,
    );
  });

  it('passes through non-error rejection values', async () => {
    const fakeInner = {
      put: vi.fn(),
      get: vi.fn().mockRejectedValue('just a string'),
      delete: vi.fn(),
      listCollection: vi.fn(),
      close: vi.fn(),
    };
    const db = new Database(fakeInner as never);
    await expect(db.get('c', Buffer.from('k'))).rejects.toMatchObject({
      name: 'NookError',
      message: 'just a string',
    });
  });

  it('wraps a synchronous native [closed] throw from close() as NookClosedError', () => {
    const fakeInner = {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      listCollection: vi.fn(),
      close: vi.fn(() => {
        throw new Error('[closed] database is closed');
      }),
    };
    const db = new Database(fakeInner as never);
    expect(() => db.close()).toThrow(NookClosedError);
  });
});
