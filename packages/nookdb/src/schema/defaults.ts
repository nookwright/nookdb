/**
 * Client-side default application for the typed collection API.
 *
 * `applyDefaults` is the small pure transform run *before* a document is
 * JSON-serialised and handed to the native `insert`:
 *
 * - the `s.id()` field, when absent, is filled with a freshly generated
 *   **UUID v7** (RFC 9562) — time-ordered, monotone-ish, and rendered as the
 *   canonical lowercase hex string (`xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`),
 *   which is inherently `\0`-free and therefore satisfies the Rust
 *   index-key doc_id NUL-free invariant (Task 6/7) by construction;
 * - every field carrying a `.default(...)` is filled when absent — a
 *   function default is *called*, a literal default is used verbatim;
 * - any `Date` value (a function default that returns `Date`, a literal
 *   `Date` default, or a caller-supplied `Date`) is serialised to an
 *   ISO-8601 string via `.toISOString()`. This is the schema-driven JSON
 *   convention shared with the Rust side (Task-3 validate / Task-5 codec
 *   treat a `date` field as an ISO-8601 string at rest).
 *
 * Authoritative *validation* (required fields, types, ranges, enum
 * membership, NUL-free user-supplied ids, unique-index conflicts) is
 * performed server-side by the Rust core — this function only fills
 * conventional client-side defaults.
 */

import { randomFillSync } from 'node:crypto';

/**
 * Minimal structural view of a builder's accumulated state. Mirrors the
 * `@internal FieldState` in `s.ts` (kept local so this module does not
 * depend on a non-exported type; only the members read here are listed).
 */
interface BuilderStateView {
  readonly type: string;
  readonly defaultVal?: unknown;
}

/**
 * Minimal structural view of a single field builder — only `_state` is
 * read here. Compatible with every `s.*` builder (they all expose a
 * `readonly _state`).
 */
interface BuilderView {
  readonly _state: BuilderStateView;
}

/**
 * Minimal structural view of a `CollectionBuilder` — only `_fields` is
 * read here. Structurally compatible with `s.collection(...)`'s result
 * (the `CollectionBuilder` class is not exported from `s.ts`, so this
 * module consumes it structurally).
 */
interface CollectionView {
  readonly _fields: Record<string, BuilderView>;
}

/**
 * Generates a UUID v7 string per RFC 9562 §5.7.
 *
 * Layout (128 bits, big-endian):
 * - bits 0..47   : `unix_ts_ms` — 48-bit big-endian Unix epoch milliseconds.
 * - bits 48..51  : `ver` — the 4-bit version, set to `0b0111` (7).
 * - bits 52..63  : `rand_a` — 12 random bits.
 * - bits 64..65  : `var` — the 2-bit variant, set to `0b10` (RFC 4122).
 * - bits 66..127 : `rand_b` — 62 random bits.
 *
 * Rendered as the canonical lowercase hyphenated hex form
 * `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`. `node:crypto.randomUUID` is v4
 * only, so this is a small dedicated v7 implementation seeded from the
 * platform CSPRNG (`randomFillSync`). The hex rendering contains no
 * embedded NUL bytes, so a generated id is a valid `\0`-free doc_id.
 */
export function uuidV7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  // 48-bit big-endian Unix-ms timestamp into bytes 0..5.
  const ts = Date.now();
  // `ts` is well under 2^48 until year ~10889; split into high/low 24-bit
  // halves to stay within JS safe-integer bitwise range (bitwise ops are
  // 32-bit; the full 48-bit value would overflow `<<`).
  const tsHigh = Math.floor(ts / 0x1_00_00_00); // top 24 bits
  const tsLow = ts % 0x1_00_00_00; // bottom 24 bits
  bytes[0] = (tsHigh >>> 16) & 0xff;
  bytes[1] = (tsHigh >>> 8) & 0xff;
  bytes[2] = tsHigh & 0xff;
  bytes[3] = (tsLow >>> 16) & 0xff;
  bytes[4] = (tsLow >>> 8) & 0xff;
  bytes[5] = tsLow & 0xff;

  // Version: high nibble of byte 6 = 0b0111 (7); low nibble stays random.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Variant: top two bits of byte 8 = 0b10; remaining bits stay random.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = new Array<string>(16);
  for (let i = 0; i < 16; i++) {
    hex[i] = bytes[i]!.toString(16).padStart(2, '0');
  }
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-` +
    `${hex[4]}${hex[5]}-` +
    `${hex[6]}${hex[7]}-` +
    `${hex[8]}${hex[9]}-` +
    `${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

/** Serialises a `Date` to its ISO-8601 string; passes other values through. */
function normalizeValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Returns a new plain object: a shallow clone of `input` with the `s.id()`
 * field filled (UUID v7) when absent, every `.default(...)`-carrying field
 * filled when absent, and any `Date` value serialised to ISO-8601.
 *
 * Provided values are always kept (defaults only fill *absent* fields).
 * The returned object is the value that gets `JSON.stringify`-d and passed
 * to the native `insert`.
 */
export function applyDefaults(
  collection: CollectionView,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Carry every caller-supplied field through first (Date → ISO).
  for (const [key, value] of Object.entries(input)) {
    out[key] = normalizeValue(value);
  }

  for (const [fieldName, builder] of Object.entries(collection._fields)) {
    if (Object.prototype.hasOwnProperty.call(out, fieldName)) {
      // Caller supplied this field — keep it (already normalized above).
      continue;
    }

    const state = builder._state;

    if (state.type === 'id') {
      out[fieldName] = uuidV7();
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(state, 'defaultVal')) {
      const def = state.defaultVal;
      const produced = typeof def === 'function' ? (def as () => unknown)() : def;
      out[fieldName] = normalizeValue(produced);
    }
  }

  return out;
}
