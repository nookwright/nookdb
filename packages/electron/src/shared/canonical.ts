/**
 * Deterministic JSON serialization for the M4 handshake descriptor.
 *
 * Sorts object keys alphabetically at every nesting level so two
 * logically-equal schemas produce the byte-identical string regardless
 * of the caller's literal-order. Arrays preserve element order
 * (positional). Primitives serialize via `JSON.stringify`.
 *
 * The renderer sends `canonicalize(toDescriptor(schema))` as the
 * `hello.descriptor` field; the Host compiles + hashes it through the
 * same Rust function used for `main_schema.schema_hash()`. Determinism
 * is required so the byte content the Host sees matches what the
 * renderer sent (the hash itself is computed Rust-side; the determinism
 * is what makes the wire payload reproducible for snapshot tests).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}
