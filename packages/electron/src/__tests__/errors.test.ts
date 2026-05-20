import { describe, expect, it } from 'vitest';
import { NookError, NookSchemaError } from 'nookdb';
import { NookForbiddenError, mapBridgeError } from '../shared/errors.js';
import type { SerializedError } from '../shared/wire.js';

describe('NookForbiddenError', () => {
  it('extends NookError and carries the kind slug', () => {
    const e = new NookForbiddenError('authorizer denied insert on users');
    expect(e).toBeInstanceOf(NookError);
    expect(e).toBeInstanceOf(NookForbiddenError);
    expect(e.name).toBe('NookForbiddenError');
    expect(e.message).toBe('authorizer denied insert on users');
  });
});

describe('mapBridgeError', () => {
  it('maps kind:"forbidden" to NookForbiddenError', () => {
    const ser: SerializedError = { kind: 'forbidden', message: 'denied' };
    const e = mapBridgeError(ser);
    expect(e).toBeInstanceOf(NookForbiddenError);
    expect(e.message).toBe('denied');
  });

  it('maps kind:"schema" to NookSchemaError via the M3 [kind] prefix path', () => {
    const ser: SerializedError = { kind: 'schema', message: 'descriptor mismatch' };
    const e = mapBridgeError(ser);
    expect(e).toBeInstanceOf(NookSchemaError);
    expect(e.message).toBe('descriptor mismatch');
  });

  it('falls back to NookError for unknown kinds', () => {
    const ser: SerializedError = { kind: 'mystery', message: 'huh' };
    const e = mapBridgeError(ser);
    expect(e).toBeInstanceOf(NookError);
    expect(e.message).toContain('huh');
  });
});
