/**
 * `s.*` schema DSL — builds a JSON descriptor compatible with the Rust
 * `SchemaIr::compile` serde contract (see `crates/nookdb-core/src/schema/ir.rs`).
 *
 * The emitted descriptor shape is:
 *   `{ [collectionName]: { idField, fields: RawField[], indexes: RawIndex[] } }`
 *
 * Only flags that are set/true (or min/max when provided) are included in the
 * emitted field object so that `toContainEqual` exact-matches work and Rust
 * `#[serde(default)]` fields stay at their defaults.
 *
 * Schema is the single source of truth: the inferred TypeScript document type
 * derives from the builders via the `$type` phantom — there is **no type
 * duplication** (PRD §4 Design Principle 1, §7.1). `typeof
 * schema.users.$type` resolves to the real document shape (Fix A); the
 * inference-carrying surface (`s.collection` / `toDescriptor`) is
 * generic-preserving so Task 13's typed proxy can recover each collection's
 * literal field map (Fix B).
 */

// ── Raw descriptor types (mirror of ir.rs serde structs) ─────────────────────

interface RawField {
  name: string;
  type: string;
  optional?: true;
  nullable?: true;
  min?: number;
  max?: number;
  int?: true;
  email?: true;
  regex?: string;
  variants?: string[];
  items?: RawField;
}

interface RawIndex {
  field: string;
  unique: boolean;
}

interface RawCollection {
  idField: string;
  fields: RawField[];
  indexes: RawIndex[];
}

type RawDescriptor = Record<string, RawCollection>;

// ── Field builder state ───────────────────────────────────────────────────────

interface FieldState {
  type: string;
  optional?: true;
  nullable?: true;
  min?: number;
  max?: number;
  int?: true;
  email?: true;
  regex?: string;
  variants?: string[];
  defaultVal?: unknown;
}

// ── Shared chainable builder methods ─────────────────────────────────────────

/**
 * Base builder that carries the accumulated field state plus phantom type
 * parameters that thread the modifier state into the *type* (not just the
 * runtime `_state`):
 *
 * - `TOut`  — the base TypeScript value type this builder infers
 *   (e.g. `string` for {@link StringBuilder}, the literal union for
 *   {@link EnumBuilder}). Carried by the `_out` phantom (zero runtime).
 * - `Opt`   — `true` once `.optional()` has been called ⇒ the field becomes
 *   an OPTIONAL KEY in {@link DocOf} (`{ k?: T }`,
 *   `exactOptionalPropertyTypes`-correct).
 * - `Null`  — `true` once `.nullable()` has been called ⇒ the field's value
 *   type becomes `T | null` in {@link DocOf}.
 *
 * `.min/.max/.email/.int/.default` deliberately do NOT change the inferred
 * TS type. Runtime accumulation (`_state`) is unchanged — only the builder's
 * TYPE threads the modifier.
 *
 * `.optional()` / `.nullable()` are chain *terminators*: they return a
 * base-typed `FieldBuilder<TOut, …>` (subclass-specific methods like
 * `.email()` / `.int()` are applied before them, mirroring the canonical
 * `s.number().int().min(0).optional()` order). Returning the base type — not
 * a subclass-conditional re-stamp — avoids F-bounded circularity and the
 * structural-collision between identically-shaped builders, while
 * {@link DocOf} still recovers the full document type because it reads only
 * the `_out` / `_opt` / `_null` phantoms (subclass identity is irrelevant to
 * inference).
 */
class FieldBuilder<TOut, Opt extends boolean = false, Null extends boolean = false> {
  /** @internal */ readonly _state: FieldState;

  /**
   * Compile-time phantom carrying this builder's inferred base value type.
   * `declare` ⇒ zero JavaScript emission; never serialized, never read at
   * runtime. Used only by {@link DocOf} to derive the document shape.
   */
  declare readonly _out: TOut;
  /** Compile-time phantom: `true` iff `.optional()` was applied. */
  declare readonly _opt: Opt;
  /** Compile-time phantom: `true` iff `.nullable()` was applied. */
  declare readonly _null: Null;

  constructor(state: FieldState) {
    this._state = state;
  }

  optional(): FieldBuilder<TOut, true, Null> {
    return new FieldBuilder<TOut, true, Null>({ ...this._state, optional: true });
  }

  nullable(): FieldBuilder<TOut, Opt, true> {
    return new FieldBuilder<TOut, Opt, true>({ ...this._state, nullable: true });
  }

  default(val: unknown): FieldBuilder<TOut, Opt, Null> {
    return new FieldBuilder<TOut, Opt, Null>({ ...this._state, defaultVal: val });
  }
}

// ── Typed builder subclasses ──────────────────────────────────────────────────
//
// Each subclass fixes its `TOut` (the base inferred value type). `TOut` for
// `date` is `Date`: the TS-facing inferred type is `Date` even though the
// at-rest/JSON form is an ISO-8601 string (the storage codec handles the
// string⇄Date round-trip; the inference surface is `Date`).

class IdBuilder extends FieldBuilder<string> {
  constructor(state: FieldState = { type: 'id' }) {
    super(state);
  }
}

class StringBuilder extends FieldBuilder<string> {
  constructor(state: FieldState = { type: 'string' }) {
    super(state);
  }

  email(): StringBuilder {
    return new StringBuilder({ ...this._state, email: true });
  }

  min(value: number): StringBuilder {
    return new StringBuilder({ ...this._state, min: value });
  }

  max(value: number): StringBuilder {
    return new StringBuilder({ ...this._state, max: value });
  }

  regex(re: RegExp): StringBuilder {
    return new StringBuilder({ ...this._state, regex: re.source });
  }
}

class NumberBuilder extends FieldBuilder<number> {
  constructor(state: FieldState = { type: 'number' }) {
    super(state);
  }

  int(): NumberBuilder {
    return new NumberBuilder({ ...this._state, int: true });
  }

  min(value: number): NumberBuilder {
    return new NumberBuilder({ ...this._state, min: value });
  }

  max(value: number): NumberBuilder {
    return new NumberBuilder({ ...this._state, max: value });
  }
}

class BooleanBuilder extends FieldBuilder<boolean> {
  constructor(state: FieldState = { type: 'boolean' }) {
    super(state);
  }
}

/**
 * `TVariant` is the literal union of the enum's variants (e.g.
 * `'admin' | 'user'`) — preserved end-to-end so `$type` infers the union,
 * not `string`.
 */
class EnumBuilder<TVariant extends string> extends FieldBuilder<TVariant> {
  constructor(state: FieldState) {
    super(state);
  }
}

class DateBuilder extends FieldBuilder<Date> {
  constructor(state: FieldState = { type: 'date' }) {
    super(state);
  }
}

/**
 * `TItem` is the inner builder; the inferred TS value is `TItem['_out'][]`.
 */
class ArrayBuilder<TItem extends FieldBuilder<unknown, boolean, boolean>>
  extends FieldBuilder<TItem['_out'][]>
{
  /** @internal — the item builder for descriptor recursion */
  readonly _itemBuilder: TItem;

  constructor(itemBuilder: TItem) {
    super({ type: 'array' });
    this._itemBuilder = itemBuilder;
  }
}

// ── AnyBuilder union (what a field slot in s.collection() can hold) ───────────
//
// The base `FieldBuilder<…>` covers `.optional()` / `.nullable()` chain
// terminators (which return the base type by design — see FieldBuilder doc).

export type AnyBuilder = FieldBuilder<unknown, boolean, boolean>;

type Fields = Record<string, AnyBuilder>;

// ── Builder → document-type inference ─────────────────────────────────────────

/** The inferred value type of a single builder, with `| null` if nullable. */
type ValueOf<B> =
  B extends { readonly _out: infer T; readonly _null: infer N }
    ? N extends true
      ? T | null
      : T
    : never;

/** Keys whose builder has `_opt === true` (become optional keys via `?`). */
type OptionalKeys<TFields> = {
  [K in keyof TFields]: TFields[K] extends { readonly _opt: true } ? K : never;
}[keyof TFields];

/** Keys whose builder has `_opt === false` (stay required). */
type RequiredKeys<TFields> = Exclude<keyof TFields, OptionalKeys<TFields>>;

/**
 * Flattens an intersection into a single readable object literal so the
 * inferred document type prints (and compares) as one flat shape rather than
 * `A & B`. Uses the `infer`-rebuild identity (no `& {}`, which
 * `@typescript-eslint/ban-types` rejects).
 */
type Simplify<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/**
 * The document type inferred from a collection's field map.
 *
 * - Required builders → required keys.
 * - `.optional()` builders → OPTIONAL KEYS (`{ k?: T }`) — correct under
 *   `exactOptionalPropertyTypes` (an optional key, not `T | undefined`).
 * - `.nullable()` builders → value type `T | null`.
 * - `s.enum([...])` → the literal union of its variants.
 *
 * {@link Simplify} collapses the required ∩ optional intersection into a
 * single object literal (so `{ id: string; …; age?: number }`, not `A & B`).
 */
export type DocOf<TFields> = Simplify<
  {
    [K in RequiredKeys<TFields>]: ValueOf<TFields[K]>;
  } & {
    [K in OptionalKeys<TFields>]?: ValueOf<TFields[K]>;
  }
>;

// ── CollectionBuilder ─────────────────────────────────────────────────────────

/**
 * Returned by `s.collection(fields)`.
 * Accumulates index declarations; carries a `$type` phantom for downstream
 * TypeScript inference (zero runtime cost — never emitted into the descriptor).
 *
 * `TFields` is the *literal* field map (never widened to the generic `Fields`),
 * so `typeof someCollection.$type` and Task 13's typed proxy resolve to the
 * exact document shape.
 */
class CollectionBuilder<TFields extends Fields> {
  /** @internal */ readonly _fields: TFields;
  /** @internal */ readonly _indexes: RawIndex[];

  /**
   * Compile-time phantom: the inferred document type
   * `DocOf<TFields>` (e.g. `{ id: string; email: string;
   * role: 'admin' | 'user'; age?: number }`). `declare` ⇒ zero JavaScript
   * emission; never serialized, never read at runtime. Consumed by
   * `type User = typeof schema.users.$type` (PRD §7.1) and Task 13's
   * typed collection proxy.
   */
  declare readonly $type: DocOf<TFields>;

  constructor(fields: TFields, indexes: RawIndex[] = []) {
    this._fields = fields;
    this._indexes = indexes;
  }

  // NOTE: `.index()` / `.uniqueIndex()` only constrain the argument to a
  // declared field name here; field-vs-constraint legality (e.g. an index on
  // an unknown/invalid field) is enforced server-side by the authoritative
  // Rust `SchemaIr::compile`.
  index(field: string & keyof TFields): CollectionBuilder<TFields> {
    return new CollectionBuilder<TFields>(this._fields, [
      ...this._indexes,
      { field, unique: false },
    ]);
  }

  uniqueIndex(field: string & keyof TFields): CollectionBuilder<TFields> {
    return new CollectionBuilder<TFields>(this._fields, [
      ...this._indexes,
      { field, unique: true },
    ]);
  }
}

// ── s namespace object ────────────────────────────────────────────────────────

export const s = {
  id(): IdBuilder {
    return new IdBuilder();
  },

  string(): StringBuilder {
    return new StringBuilder();
  },

  number(): NumberBuilder {
    return new NumberBuilder();
  },

  boolean(): BooleanBuilder {
    return new BooleanBuilder();
  },

  /**
   * `variants` is captured as a literal-union generic (`T[number]`), so the
   * inferred field type is e.g. `'admin' | 'user'` — not `string`. The
   * variants array is still emitted to the descriptor unchanged at runtime.
   */
  enum<const T extends readonly string[]>(variants: T): EnumBuilder<T[number]> {
    return new EnumBuilder<T[number]>({ type: 'enum', variants: [...variants] });
  },

  date(): DateBuilder {
    return new DateBuilder();
  },

  /**
   * Homogeneous array of items typed by `itemBuilder`. Primitive item types
   * only (string / number / boolean / date / enum / nested array); s.object
   * nested-struct fields are PRD v2 work.
   */
  array<TItem extends FieldBuilder<unknown, boolean, boolean>>(
    itemBuilder: TItem,
  ): ArrayBuilder<TItem> {
    return new ArrayBuilder(itemBuilder);
  },

  /**
   * Preserves the *literal* `fields` object as `TFields` (generic is inferred
   * from the exact argument — never widened to `Fields`), so the resulting
   * `CollectionBuilder<{ id: …, email: … }>` keeps every field's concrete
   * type for `$type` inference and Task 13's typed proxy.
   */
  collection<TFields extends Fields>(fields: TFields): CollectionBuilder<TFields> {
    return new CollectionBuilder(fields);
  },
} as const;

// ── toDescriptor ─────────────────────────────────────────────────────────────

/**
 * Emits the minimal `RawField` record for a single builder, recursing into
 * `ArrayBuilder`'s inner item builder. Only flags that are `true` (or
 * `min`/`max`/`regex`/`variants` when provided) are included so Rust's
 * `#[serde(default)]` fields stay at their defaults and `toContainEqual`
 * exact-matches work in tests.
 */
function emitFieldDescriptor(
  name: string,
  builder: FieldBuilder<unknown, boolean, boolean>,
): RawField {
  const st = builder._state;
  const raw: RawField = { name, type: st.type };
  if (st.optional === true) raw.optional = true;
  if (st.nullable === true) raw.nullable = true;
  if (st.int === true) raw.int = true;
  if (st.email === true) raw.email = true;
  if (st.min !== undefined) raw.min = st.min;
  if (st.max !== undefined) raw.max = st.max;
  if (st.regex !== undefined) raw.regex = st.regex;
  if (st.variants !== undefined && st.variants.length > 0) raw.variants = st.variants;
  if (st.type === 'array' && builder instanceof ArrayBuilder) {
    raw.items = emitFieldDescriptor(
      '__item__',
      builder._itemBuilder as FieldBuilder<unknown, boolean, boolean>,
    );
  }
  return raw;
}

/**
 * Serialises a schema object (built with `s.*`) to the JSON descriptor string
 * consumed by the Rust `SchemaIr::compile`.
 *
 * The generic `S` preserves each collection's literal `TFields` (it is NOT
 * widened to `Record<string, CollectionBuilder<Fields>>`), so a concrete
 * schema's `CollectionBuilder<{ id: …, email: … }>` survives for Task 13's
 * typed proxy. Runtime body is unchanged — emits byte-identical JSON.
 *
 * Only flags that are `true` (or `min`/`max` when provided) are included so
 * Rust's `#[serde(default)]` fields stay at their defaults and
 * `toContainEqual` exact-matches work in tests.
 */
export function toDescriptor<S extends Record<string, CollectionBuilder<Fields>>>(
  schema: S,
): string {
  const descriptor: RawDescriptor = {};

  for (const [collName, coll] of Object.entries(schema)) {
    let idField: string | undefined;
    const fields: RawField[] = [];

    for (const [fieldName, builder] of Object.entries(coll._fields)) {
      const raw = emitFieldDescriptor(fieldName, builder);

      if (raw.type === 'id') {
        idField = fieldName;
      }

      fields.push(raw);
    }

    if (idField === undefined) {
      throw new Error(
        `s.collection '${collName}': no s.id() field found; every collection needs an id field.`,
      );
    }

    descriptor[collName] = {
      idField,
      fields,
      indexes: coll._indexes,
    };
  }

  return JSON.stringify(descriptor);
}

// ── Compile-time inference guard (zero runtime) ───────────────────────────────
//
// Pins the canonical schema's inferred `$type` to its exact expected shape.
// This is TYPE-ONLY (no values, no JS emitted) and lives in a file the default
// `tsconfig.json` type-checks, so a regression that hollows `$type` back to
// `unknown` (or breaks optionality / the enum literal union / nullability)
// fails `tsc --noEmit`. The runtime-facing `expectTypeOf` mirror lives in
// `__tests__/s.test.ts` (spec §7 mandate).

/** `true` iff `A` and `B` are mutually assignable (exact type equality). */
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** Compile error unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

// Derives `_CanonicalDoc` from a LIVE `s.*` builder method chain — exercising
// `s.collection` / `s.id()` / `s.string().email()` / `s.enum(['admin','user'])`
// (const-union generic) / `s.number().int().min(0).optional()` end-to-end
// through `DocOf`, so any regression in the real inference pipeline is caught
// by `tsc --noEmit` (the CI typecheck gate). `_liveCanonical` is intentionally
// unused at runtime: it is module-private, unreferenced, and never exported —
// a bundler/tree-shaker drops it with zero behavior impact.
const _liveCanonical = {
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

type _CanonicalDoc = (typeof _liveCanonical)['users']['$type'];

// If `$type` regresses to `unknown` / wrong optionality / lost enum union /
// lost nullability, this alias errors at `tsc --noEmit` time (the primary
// verify gate). The runtime `expectTypeOf` mirror in `__tests__/s.test.ts`
// asserts the same shape against the literal `s.*` chain (spec §7).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _InferenceGuard = AssertTrue<
  Equals<
    _CanonicalDoc,
    { id: string; email: string; role: 'admin' | 'user'; age?: number }
  >
>;
