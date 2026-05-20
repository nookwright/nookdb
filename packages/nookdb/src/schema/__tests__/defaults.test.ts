import { describe, it, expect } from 'vitest';
import { s } from '../s.js';
import { applyDefaults } from '../defaults.js';

describe('applyDefaults', () => {
  const schema = {
    u: s.collection({
      id: s.id(),
      createdAt: s.date().default(() => new Date('2026-01-01T00:00:00.000Z')),
      role: s.enum(['a', 'b']).default('a'),
    }),
  };
  it('generates a uuid v7 id when absent', () => {
    const out = applyDefaults(schema.u, { role: 'b' });
    expect(typeof out.id).toBe('string');
    expect((out.id as string).length).toBeGreaterThan(0);
  });
  it('applies function and literal defaults but keeps provided values', () => {
    const out = applyDefaults(schema.u, { id: 'keep' });
    expect(out.id).toBe('keep');
    expect(out.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(out.role).toBe('a');
  });
});
