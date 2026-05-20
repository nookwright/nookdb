import { describe, expect, it } from 'vitest';
import {
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
} from '../index.js';

describe('NookError prototype chain (sub-ES2015 transpile safety)', () => {
  it('NookError direct instances have the expected prototype', () => {
    const err = new NookError('x');
    expect(err instanceof NookError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(Object.getPrototypeOf(err)).toBe(NookError.prototype);
  });

  it.each([
    ['NookStorageError', NookStorageError],
    ['NookCorruptionError', NookCorruptionError],
    ['NookConflictError', NookConflictError],
    ['NookTransactionError', NookTransactionError],
    ['NookInvalidArgError', NookInvalidArgError],
    ['NookClosedError', NookClosedError],
    ['NookSchemaError', NookSchemaError],
    ['NookMigrationError', NookMigrationError],
  ] as const)('%s preserves instanceof chain', (_name, Cls) => {
    const err = new Cls('x');
    expect(err instanceof Cls).toBe(true);
    expect(err instanceof NookError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(Object.getPrototypeOf(err)).toBe(Cls.prototype);
  });

  it('NookPlatformError preserves instanceof chain (it has its own constructor)', () => {
    const err = new NookPlatformError('x', { platform: 'linux', arch: 'x64', libc: 'glibc' });
    expect(err instanceof NookPlatformError).toBe(true);
    expect(err instanceof NookError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(Object.getPrototypeOf(err)).toBe(NookPlatformError.prototype);
  });
});
