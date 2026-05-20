import { NookError, NookPlatformError } from './loader.js';

export { NookError, NookPlatformError };

export class NookStorageError extends NookError {
  override readonly name = 'NookStorageError';
}

export class NookCorruptionError extends NookError {
  override readonly name = 'NookCorruptionError';
}

export class NookConflictError extends NookError {
  override readonly name = 'NookConflictError';
}

export class NookTransactionError extends NookError {
  override readonly name = 'NookTransactionError';
}

export class NookInvalidArgError extends NookError {
  override readonly name = 'NookInvalidArgError';
}

export class NookClosedError extends NookError {
  override readonly name = 'NookClosedError';
}

export class NookSchemaError extends NookError {
  override readonly name = 'NookSchemaError';
}

export class NookMigrationError extends NookError {
  override readonly name = 'NookMigrationError';
}

const PREFIX_RE = /^\[([a-z_]+)\] (.*)$/s;

const KIND_TO_CLASS: Readonly<Record<string, new (msg: string) => NookError>> = Object.freeze({
  storage: NookStorageError,
  corruption: NookCorruptionError,
  conflict: NookConflictError,
  transaction: NookTransactionError,
  invalid_arg: NookInvalidArgError,
  closed: NookClosedError,
  schema: NookSchemaError,
  migration: NookMigrationError,
});

/**
 * Converts an error thrown by the native NAPI binding into one of the
 * typed `NookError` subclasses based on the `[kind]` prefix the Rust
 * side emits. Falls back to a generic `NookError` for unknown prefixes
 * or non-Error inputs.
 */
export function mapNativeError(err: unknown): NookError {
  if (!(err instanceof Error)) {
    return new NookError(String(err));
  }
  const match = PREFIX_RE.exec(err.message);
  if (match === null) {
    return new NookError(err.message);
  }
  const [, kind, body] = match;
  if (kind === undefined || body === undefined) {
    return new NookError(err.message);
  }
  const Cls = KIND_TO_CLASS[kind];
  if (Cls === undefined) {
    return new NookError(err.message);
  }
  return new Cls(body);
}
