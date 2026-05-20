import { describe, expect, it } from 'vitest';
import {
  NookError,
  NookStorageError,
  NookCorruptionError,
  NookConflictError,
  NookTransactionError,
  NookInvalidArgError,
  NookClosedError,
  mapNativeError,
} from '../errors.js';

describe('NookError class hierarchy', () => {
  it('NookStorageError is a NookError', () => {
    const err = new NookStorageError('boom');
    expect(err).toBeInstanceOf(NookError);
    expect(err).toBeInstanceOf(NookStorageError);
    expect(err.name).toBe('NookStorageError');
    expect(err.message).toBe('boom');
  });

  it('all six subclasses inherit from NookError', () => {
    const classes = [
      NookStorageError,
      NookCorruptionError,
      NookConflictError,
      NookTransactionError,
      NookInvalidArgError,
      NookClosedError,
    ];
    for (const C of classes) {
      const e = new C('x');
      expect(e).toBeInstanceOf(NookError);
    }
  });
});

describe('mapNativeError', () => {
  it('maps [storage] prefix to NookStorageError', () => {
    const src = new Error('[storage] storage error: io failed');
    const mapped = mapNativeError(src);
    expect(mapped).toBeInstanceOf(NookStorageError);
    expect(mapped.message).toBe('storage error: io failed');
  });

  it('maps [corruption] prefix to NookCorruptionError', () => {
    const mapped = mapNativeError(new Error('[corruption] database corruption: bad page'));
    expect(mapped).toBeInstanceOf(NookCorruptionError);
  });

  it('maps [conflict] prefix to NookConflictError', () => {
    const mapped = mapNativeError(new Error('[conflict] write conflict'));
    expect(mapped).toBeInstanceOf(NookConflictError);
  });

  it('maps [transaction] prefix to NookTransactionError', () => {
    const mapped = mapNativeError(new Error('[transaction] rollback failed'));
    expect(mapped).toBeInstanceOf(NookTransactionError);
  });

  it('maps [invalid_arg] prefix to NookInvalidArgError', () => {
    const mapped = mapNativeError(new Error('[invalid_arg] collection cannot be empty'));
    expect(mapped).toBeInstanceOf(NookInvalidArgError);
  });

  it('maps [closed] prefix to NookClosedError', () => {
    const mapped = mapNativeError(new Error('[closed] database is closed'));
    expect(mapped).toBeInstanceOf(NookClosedError);
  });

  it('falls back to plain NookError for unknown prefix', () => {
    const mapped = mapNativeError(new Error('[unknown_kind] something'));
    expect(mapped).toBeInstanceOf(NookError);
    expect(mapped).not.toBeInstanceOf(NookStorageError);
  });

  it('falls back to plain NookError when there is no prefix', () => {
    const mapped = mapNativeError(new Error('just a message'));
    expect(mapped).toBeInstanceOf(NookError);
    expect(mapped.message).toBe('just a message');
  });

  it('handles non-Error input', () => {
    const mapped = mapNativeError('a string');
    expect(mapped).toBeInstanceOf(NookError);
    expect(mapped.message).toBe('a string');
  });
});
