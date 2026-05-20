import { describe, it, expect, expectTypeOf } from 'vitest';
import { s, toDescriptor } from '../s.js';
import { NookSchemaError, NookMigrationError, NookError } from '../../errors.js';

interface DescriptorField {
  name: string;
  type: string;
  [k: string]: unknown;
}

interface DescriptorIndex {
  field: string;
  unique: boolean;
}

interface DescriptorCollection {
  idField: string;
  fields: DescriptorField[];
  indexes: DescriptorIndex[];
}

type ParsedDescriptor = Record<string, DescriptorCollection>;

describe('s.* DSL', () => {
  it('builds a JSON descriptor for a collection', () => {
    const schema = {
      users: s.collection({
        id: s.id(),
        email: s.string().email(),
        role: s.enum(['admin', 'user']),
        age: s.number().int().min(0).optional(),
      }).uniqueIndex('email').index('role'),
    };
    const d = JSON.parse(toDescriptor(schema)) as ParsedDescriptor;
    expect(d['users']?.idField).toBe('id');
    expect(d['users']?.fields).toContainEqual({ name: 'email', type: 'string', email: true });
    expect(d['users']?.indexes).toContainEqual({ field: 'email', unique: true });
  });

  it('new error classes extend NookError', () => {
    expect(new NookSchemaError('x')).toBeInstanceOf(NookError);
    expect(new NookMigrationError('x')).toBeInstanceOf(NookError);
  });

  // Type-level test (spec §7 mandate): the schema is the single source of
  // truth — `typeof schema.users.$type` MUST derive the exact document type
  // with NO type duplication (PRD §4 Principle 1, §7.1). `toEqualTypeOf` is
  // an exact (mutually-assignable) check enforced at type-check time, so a
  // regression to `unknown` / wrong optionality / lost enum union / lost
  // nullability fails the build (mirrored by the compile-time
  // `_InferenceGuard` in `s.ts`, which the default tsconfig type-checks).
  it('infers $type as the exact document shape', () => {
    const schema = {
      users: s
        .collection({
          id: s.id(),
          email: s.string().email(),
          role: s.enum(['admin', 'user']),
          age: s.number().int().min(0).optional(),
        })
        .uniqueIndex('email')
        .index('role'),
    };

    type User = typeof schema.users.$type;
    expectTypeOf<User>().toEqualTypeOf<{
      id: string;
      email: string;
      role: 'admin' | 'user';
      age?: number;
    }>();

    // Non-vacuous spot-checks: each modifier must be reflected exactly.
    expectTypeOf<User['role']>().toEqualTypeOf<'admin' | 'user'>();
    expectTypeOf<User>().not.toEqualTypeOf<Record<string, unknown>>();

    // `.nullable()` ⇒ value type `T | null`; `.optional()` ⇒ optional key.
    const nullableSchema = {
      notes: s.collection({
        id: s.id(),
        body: s.string().nullable(),
        tag: s.enum(['a', 'b']).optional(),
      }),
    };
    type Note = typeof nullableSchema.notes.$type;
    expectTypeOf<Note>().toEqualTypeOf<{
      id: string;
      body: string | null;
      tag?: 'a' | 'b';
    }>();

    // Runtime assertion so the test is not type-only at runtime.
    expect(JSON.parse(toDescriptor(schema)) as Record<string, unknown>).toHaveProperty(
      'users',
    );
  });
});
