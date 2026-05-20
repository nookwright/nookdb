import { mapNativeError } from './errors.js';

export interface BackupStats {
  entryCount: number;
  bytesWritten: number;
}

export interface RestoreStats {
  entryCount: number;
  bytesRead: number;
}

export interface RestoreOptions {
  /**
   * When false (default), `restore` throws `NookConflictError` if the
   * target DB has any entries. Set `true` for destructive replace.
   */
  allowOverwrite?: boolean;
  /**
   * When false (default) AND both sides carry a schema hash, restore
   * validates them and throws `NookSchemaError` on mismatch. When either
   * side has no schema hash, the check is silently skipped.
   */
  skipSchemaCheck?: boolean;
}

/** Minimal shape the freestanding helpers need from a Database-like handle. */
export interface BackupCapable {
  backup(destPath: string): Promise<BackupStats>;
  restore(srcPath: string, opts?: RestoreOptions): Promise<RestoreStats>;
}

/**
 * Creates a portable `.nbkp` snapshot at `destPath`. The DB's schema
 * hash (if any) is recorded automatically. Atomic write (`.tmp` + fsync
 * + rename) — a partial backup never masquerades as a valid file.
 *
 * Equivalent to `db.backup(destPath)`; exists so external orchestrators
 * (point-in-time backup schedulers, corruption recovery tools, etc.)
 * have a stable, side-effectful API by reference rather than by method
 * call (pre-1.0 extension §M5 seam).
 */
export function backupToPath(db: BackupCapable, destPath: string): Promise<BackupStats> {
  return db.backup(destPath);
}

/**
 * Restores `srcPath` into `db` per `opts`. The DB's current schema hash
 * (if any) is forwarded automatically for the validation check.
 *
 * Equivalent to `db.restore(srcPath, opts)`; exists for the same
 * orchestrator pattern as `backupToPath`.
 */
export function restoreFromPath(
  db: BackupCapable,
  srcPath: string,
  opts?: RestoreOptions,
): Promise<RestoreStats> {
  return db.restore(srcPath, opts);
}

/**
 * Maps a native error thrown from the NAPI `backup` / `restore` calls
 * into the typed `NookError` hierarchy. Re-exported so the freestanding
 * helpers can keep error mapping in one place.
 *
 * @internal — exposed for the `Database` method wrappers; not part of
 * the published API.
 */
export const __mapBackupError = mapNativeError;
