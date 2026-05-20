import { describe, expect, it } from 'vitest';
import { canonicalize } from '../shared/canonical.js';

describe('canonicalize', () => {
  it('sorts object keys alphabetically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('is order-independent for nested objects', () => {
    const a = canonicalize({ x: { c: 3, b: 2, a: 1 }, y: 0 });
    const b = canonicalize({ y: 0, x: { a: 1, b: 2, c: 3 } });
    expect(a).toBe(b);
  });

  it('preserves array element order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([3, 1, 2])).not.toBe(canonicalize([1, 2, 3]));
  });

  it('handles primitives and null', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hi')).toBe('"hi"');
  });

  it('round-trips through JSON.parse to the same logical value', () => {
    const v = { users: { idField: 'id', fields: [{ name: 'id', type: 'id' }], indexes: [] } };
    expect(JSON.parse(canonicalize(v))).toEqual(v);
  });

  it('handles deeply nested mixed structures deterministically', () => {
    const a = canonicalize({
      collections: {
        users: { idField: 'id', fields: [{ name: 'role', variants: ['admin', 'user'] }] },
      },
    });
    const b = canonicalize({
      collections: {
        users: { fields: [{ variants: ['admin', 'user'], name: 'role' }], idField: 'id' },
      },
    });
    expect(a).toBe(b);
  });
});
