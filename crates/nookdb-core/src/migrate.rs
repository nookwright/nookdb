//! Stable migration-runner API SEAM (extension seam §6b).
//!
//! This is the stable public surface + a `_meta` schema-version ledger
//! ONLY. The migration DSL / up-down / backfill is the deferred full
//! framework (spec §8). No Pro code. The advanced migration tooling
//! attaches to THIS API without modifying the crate.

use crate::database::Database;
use crate::error::NookError;

// RESERVED internal collection. Shares the single `entries` keyspace
// (M1 composite key) with user collections; a user collection named
// "_meta" would alias this ledger. A reserved-name guard belongs in
// schema::ir compile-time validation (owner: schema DSL task / M3).
const META_COLLECTION: &str = "_meta";
const APPLIED_KEY: &[u8] = b"applied_versions";

/// Snapshot of the current migration-ledger state.
pub struct MigrationStatus {
    /// The highest version number that has been applied, or 0 if none.
    pub current_version: u32,
    /// The number of migration versions that have been applied.
    pub applied_count: usize,
}

/// Stable migration-runner API seam (extension seam §6b).
///
/// Maintains a JSON ledger of applied version numbers in the `_meta`
/// collection. The full migration DSL (up/down/backfill) is deferred
/// to spec §8; this runner provides the version-tracking surface that
/// the future framework will attach to.
///
/// # Examples
///
/// ```
/// use nookdb_core::Database;
/// use nookdb_core::migrate::Runner;
/// # let dir = tempfile::tempdir().unwrap();
/// let db = Database::open(dir.path().join("m.db")).unwrap();
/// let r = Runner::new(&db);
/// assert_eq!(r.status().unwrap().current_version, 0);
/// assert_eq!(r.list_pending(&[1, 2]).unwrap(), vec![1, 2]);
/// r.run(&[1, 2]).unwrap();
/// assert_eq!(r.list_applied().unwrap(), vec![1, 2]);
/// assert_eq!(r.status().unwrap().current_version, 2);
/// ```
pub struct Runner<'a> {
    db: &'a Database,
}

impl<'a> Runner<'a> {
    /// Creates a new `Runner` bound to the given database.
    #[must_use]
    pub const fn new(db: &'a Database) -> Self {
        Self { db }
    }

    fn applied(&self) -> Result<Vec<u32>, NookError> {
        let raw = self.db.read(|tx| tx.get(META_COLLECTION, APPLIED_KEY))?;
        raw.map_or_else(
            || Ok(vec![]),
            |b| {
                serde_json::from_slice(&b).map_err(|e| NookError::Migration {
                    msg: format!("corrupt ledger: {e}"),
                })
            },
        )
    }

    /// Returns the list of applied migration version numbers in the order
    /// they were applied.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Migration` if the ledger is corrupt, or a
    /// storage error if the underlying read fails.
    pub fn list_applied(&self) -> Result<Vec<u32>, NookError> {
        self.applied()
    }

    /// Returns a snapshot of the current migration state.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Migration` if the ledger is corrupt, or a
    /// storage error if the underlying read fails.
    pub fn status(&self) -> Result<MigrationStatus, NookError> {
        let a = self.applied()?;
        Ok(MigrationStatus {
            current_version: a.iter().copied().max().unwrap_or(0),
            applied_count: a.len(),
        })
    }

    /// Returns the versions in `all` that have not yet been applied,
    /// in the same order as given.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Migration` if the ledger is corrupt, or a
    /// storage error if the underlying read fails.
    pub fn list_pending(&self, all: &[u32]) -> Result<Vec<u32>, NookError> {
        let a = self.applied()?;
        Ok(all.iter().copied().filter(|v| !a.contains(v)).collect())
    }

    /// Records the pending subset of `all` as applied (idempotent). M2 has
    /// no real migration-step type yet — this is the no-op-capable runner
    /// that maintains the version ledger.
    ///
    /// Already-applied versions in `all` are silently skipped; the call
    /// is safe to repeat with the same arguments.
    ///
    /// Hardened in M5a: read-merge-write happens in a single write
    /// transaction so concurrent `run`s cannot lost-update the ledger.
    /// See `tests/migrate_concurrent.rs`.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Migration` if the ledger is corrupt or cannot be
    /// serialised, or a storage error if the underlying write fails.
    pub fn run(&self, all: &[u32]) -> Result<(), NookError> {
        self.db.write(|tx| {
            let raw = tx.get(META_COLLECTION, APPLIED_KEY)?;
            let mut a: Vec<u32> = match raw {
                None => Vec::new(),
                Some(b) => serde_json::from_slice(&b).map_err(|e| NookError::Migration {
                    msg: format!("corrupt ledger: {e}"),
                })?,
            };
            let initial_len = a.len();
            for v in all {
                if !a.contains(v) {
                    a.push(*v);
                }
            }
            if a.len() == initial_len {
                return Ok(());
            }
            a.sort_unstable();
            a.dedup();
            let bytes =
                serde_json::to_vec(&a).map_err(|e| NookError::Migration { msg: e.to_string() })?;
            tx.put(META_COLLECTION, APPLIED_KEY, &bytes)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn db() -> (tempfile::TempDir, Database) {
        let d = tempfile::tempdir().unwrap();
        let db = Database::open(d.path().join("t.db")).unwrap();
        (d, db)
    }

    #[test]
    fn status_starts_at_zero_and_run_advances_version() {
        let (_d, db) = db();
        let r = Runner::new(&db);
        assert_eq!(r.status().unwrap().current_version, 0);
        assert_eq!(r.list_applied().unwrap(), Vec::<u32>::new());
        assert_eq!(r.list_pending(&[1, 2]).unwrap(), vec![1, 2]);
        r.run(&[1, 2]).unwrap();
        assert_eq!(r.status().unwrap().current_version, 2);
        assert_eq!(r.list_applied().unwrap(), vec![1, 2]);
        assert_eq!(r.list_pending(&[1, 2, 3]).unwrap(), vec![3]);
    }

    #[test]
    fn run_is_idempotent_for_already_applied_versions() {
        let (_d, db) = db();
        let r = Runner::new(&db);
        r.run(&[1]).unwrap();
        r.run(&[1]).unwrap(); // no-op, no error
        assert_eq!(r.status().unwrap().current_version, 1);
    }
}
