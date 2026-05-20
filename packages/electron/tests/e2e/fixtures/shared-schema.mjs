/**
 * Shared schema definitions for the E2E harness.
 *
 * NOTE: This file imports from the nookdb schema sub-module directly (NOT from
 * 'nookdb') so it can be safely loaded in the Electron renderer preload context
 * without triggering the native binding load (nookdb/dist/index.js calls
 * loadBinding() at module level which crashes the renderer process).
 *
 * Import resolution: this file resolves relative to fixtures/, walking up to
 * packages/electron/node_modules/nookdb/dist/schema/s.js.
 */
import { s } from '../../../node_modules/nookdb/dist/schema/s.js';

export const schema = {
  users: s
    .collection({
      id: s.id(),
      role: s.enum(['admin', 'user']),
    })
    .index('role'),
};

/** Constraint-only diff: dropped 'user' from the enum — same shape_hash, different constraint. */
export const alternateSchema = {
  users: s
    .collection({
      id: s.id(),
      role: s.enum(['admin']),
    })
    .index('role'),
};

export function deniedAuthorizer() {
  return {
    authorize(_sender, op) {
      // Deny insert on users collection; allow everything else
      return !(op.collection === 'users' && op.kind === 'insert');
    },
  };
}
