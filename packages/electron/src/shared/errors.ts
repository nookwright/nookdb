import { NookError, mapNativeError } from 'nookdb';
import type { SerializedError } from './wire.js';

/**
 * Thrown in the renderer when the bridge response carries
 * `kind:'forbidden'` (the authorizer denied an op). M4 adds this single
 * error class to the existing M2/M3 `nookdb` taxonomy (spec §8) —
 * `@nookdb/electron` does NOT extend `nookdb`'s error catalogue;
 * consumers import via `@nookdb/electron/renderer` (re-exported in
 * Task 13's `index.ts`).
 */
export class NookForbiddenError extends NookError {
  override readonly name = 'NookForbiddenError';
}

/**
 * Renderer-side mapping from a wire `SerializedError` to a typed
 * `NookError` instance. Dispatches by `kind`:
 * - `'forbidden'` → `NookForbiddenError` (M4-local class)
 * - everything else → routed through `mapNativeError` so M2/M3 kinds
 *   (`schema`, `storage`, `invalid_arg`, …) become their proper
 *   `NookError` subclass. Preserves the `[kind] message` convention
 *   end-to-end.
 */
export function mapBridgeError(ser: SerializedError): NookError {
  if (ser.kind === 'forbidden') {
    return new NookForbiddenError(ser.message);
  }
  return mapNativeError(new Error(`[${ser.kind}] ${ser.message}`));
}
