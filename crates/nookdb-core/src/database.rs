//! `Database` — top-level handle owning the redb file lock.

use std::path::Path;
use std::sync::Arc;

use redb::Database as RedbDatabase;

use crate::error::NookError;
use crate::notify::{CommitEvent, CommitObserver, Notifier, ObserverHandle};
use crate::storage::{ReadTx, WriteTx};

/// Owning handle to a Nook database file.
///
/// Holds the OS-level file lock for the duration of its lifetime. Drop
/// releases the lock. There is no explicit `close()` method on this type;
/// the NAPI binding implements its own closure semantics on top.
pub struct Database {
    pub(crate) inner: RedbDatabase,
    notifier: Notifier,
}

impl Database {
    /// Opens the database at `path`, creating it (and any missing parent
    /// directories) if necessary.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` if the file or parent directories cannot
    /// be created, or if the database file cannot be opened or is locked by
    /// another process.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, NookError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let inner = RedbDatabase::create(path).map_err(map_redb_db_error)?;
        Ok(Self {
            inner,
            notifier: Notifier::new(),
        })
    }

    /// Registers a commit observer (stable extension seam, M3).
    /// The returned handle unregisters on drop (RAII).
    #[must_use = "dropping the ObserverHandle immediately unregisters the observer"]
    pub fn add_observer(&self, obs: Arc<dyn CommitObserver>) -> ObserverHandle {
        self.notifier.add_observer(obs)
    }

    /// Runs `f` inside a read transaction (MVCC snapshot). Read
    /// transactions never block writers and may run in parallel with
    /// each other.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Transaction` if the read transaction cannot be
    /// started, or propagates any error returned by `f`.
    pub fn read<F, R>(&self, f: F) -> Result<R, NookError>
    where
        F: FnOnce(&ReadTx) -> Result<R, NookError>,
    {
        let txn = self.inner.begin_read().map_err(map_redb_tx_error)?;
        let tx = ReadTx::new(&txn)?;
        f(&tx)
    }

    /// Runs `f` inside a write transaction. The transaction commits on
    /// `Ok` and rolls back on `Err` or panic.
    ///
    /// Write transactions are serializable: only one runs at a time.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Transaction` if the write transaction cannot be
    /// started or committed, or propagates any error returned by `f`.
    /// Returns `NookError::Storage` or `NookError::Corruption` on
    /// underlying storage failure.
    pub fn write<F, R>(&self, f: F) -> Result<R, NookError>
    where
        F: for<'tx> FnOnce(&mut WriteTx<'tx>) -> Result<R, NookError>,
    {
        let txn = self.inner.begin_write().map_err(map_redb_tx_error)?;
        // Scope-drop `tx` (whose Tables immutably borrow `&txn`) BEFORE
        // `txn.commit()`/`txn.abort()` consume `txn` by value; `take_touched()`
        // moves the change-set out first so it outlives the drop.
        let (result, touched) = {
            let mut tx = WriteTx::new(&txn)?;
            let r = f(&mut tx);
            let t = tx.take_touched();
            (r, t)
        };
        match result {
            Ok(value) => {
                txn.commit().map_err(map_redb_commit_error)?;
                if !touched.is_empty() {
                    self.notifier.dispatch(&CommitEvent::new(touched));
                }
                Ok(value)
            }
            Err(user_err) => {
                if let Err(abort_err) = txn.abort() {
                    return Err(NookError::Transaction {
                        msg: format!("rollback failed ({abort_err}); original error: {user_err}"),
                    });
                }
                Err(user_err)
            }
        }
    }
}

fn map_redb_db_error(e: redb::DatabaseError) -> NookError {
    match e {
        redb::DatabaseError::Storage(s) => map_redb_storage_error(s),
        other => NookError::Storage(std::io::Error::other(other.to_string())),
    }
}

pub(crate) fn map_redb_storage_error(e: redb::StorageError) -> NookError {
    match e {
        redb::StorageError::Io(io_err) => NookError::Storage(io_err),
        redb::StorageError::Corrupted(msg) => NookError::Corruption { msg },
        other => NookError::Transaction {
            msg: other.to_string(),
        },
    }
}

pub(crate) fn map_redb_table_error(e: redb::TableError) -> NookError {
    match e {
        redb::TableError::Storage(s) => map_redb_storage_error(s),
        other => NookError::Transaction {
            msg: other.to_string(),
        },
    }
}

fn map_redb_tx_error(e: redb::TransactionError) -> NookError {
    match e {
        redb::TransactionError::Storage(s) => map_redb_storage_error(s),
        other => NookError::Transaction {
            msg: other.to_string(),
        },
    }
}

fn map_redb_commit_error(e: redb::CommitError) -> NookError {
    match e {
        redb::CommitError::Storage(s) => map_redb_storage_error(s),
        other => NookError::Transaction {
            msg: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::NookErrorKind;

    fn fresh_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let db = Database::open(&path).unwrap();
        (dir, db)
    }

    // ---- open() tests from Task 2 ----

    #[test]
    fn open_creates_file_at_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        assert!(!path.exists());
        let _db = Database::open(&path).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn open_creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b").join("c").join("test.db");
        assert!(!nested.exists());
        let _db = Database::open(&nested).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn open_existing_file_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        {
            let _db = Database::open(&path).unwrap();
        }
        let _db2 = Database::open(&path).unwrap();
        assert!(path.exists());
    }

    // ---- write + read happy path ----

    #[test]
    fn write_then_read_round_trips_a_value() {
        let (_dir, db) = fresh_db();
        db.write(|tx| tx.put("users", b"u1", b"Ali")).unwrap();
        let got = db.read(|tx| tx.get("users", b"u1")).unwrap();
        assert_eq!(got.as_deref(), Some(&b"Ali"[..]));
    }

    #[test]
    fn read_of_missing_key_returns_none() {
        let (_dir, db) = fresh_db();
        let got = db.read(|tx| tx.get("users", b"missing")).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn write_get_inside_same_tx_returns_current_value() {
        let (_dir, db) = fresh_db();
        let observed = db
            .write(|tx| {
                tx.put("c", b"k", b"v1")?;
                tx.get("c", b"k")
            })
            .unwrap();
        assert_eq!(observed.as_deref(), Some(&b"v1"[..]));
    }

    #[test]
    fn delete_returns_true_when_key_existed() {
        let (_dir, db) = fresh_db();
        db.write(|tx| tx.put("c", b"k", b"v")).unwrap();
        let removed = db.write(|tx| tx.delete("c", b"k")).unwrap();
        assert!(removed);
        let got = db.read(|tx| tx.get("c", b"k")).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn delete_returns_false_when_key_missing() {
        let (_dir, db) = fresh_db();
        let removed = db.write(|tx| tx.delete("c", b"missing")).unwrap();
        assert!(!removed);
    }

    #[test]
    fn list_collection_returns_all_entries_for_that_collection_only() {
        let (_dir, db) = fresh_db();
        db.write(|tx| {
            tx.put("users", b"u1", b"Ali")?;
            tx.put("users", b"u2", b"Veli")?;
            tx.put("posts", b"p1", b"Hello")?;
            Ok(())
        })
        .unwrap();
        let mut users = db.read(|tx| tx.list_collection("users")).unwrap();
        users.sort();
        assert_eq!(
            users,
            vec![
                (b"u1".to_vec(), b"Ali".to_vec()),
                (b"u2".to_vec(), b"Veli".to_vec()),
            ]
        );
        let posts = db.read(|tx| tx.list_collection("posts")).unwrap();
        assert_eq!(posts, vec![(b"p1".to_vec(), b"Hello".to_vec())]);
    }

    #[test]
    fn list_collection_returns_empty_for_unknown_collection() {
        let (_dir, db) = fresh_db();
        let entries = db.read(|tx| tx.list_collection("nope")).unwrap();
        assert!(entries.is_empty());
    }

    // ---- rollback semantics ----

    #[test]
    fn write_rolls_back_when_callback_returns_err() {
        let (_dir, db) = fresh_db();
        let result = db.write(|tx| -> Result<(), NookError> {
            tx.put("c", b"k", b"v")?;
            Err(NookError::Transaction {
                msg: "user-induced rollback".into(),
            })
        });
        assert!(matches!(result, Err(NookError::Transaction { .. })));
        let got = db.read(|tx| tx.get("c", b"k")).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn write_rolls_back_when_callback_panics() {
        let (_dir, db) = fresh_db();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = db.write(|tx| -> Result<(), NookError> {
                tx.put("c", b"k", b"v")?;
                panic!("intentional panic");
            });
        }));
        assert!(result.is_err(), "panic should propagate out of write");
        let got = db.read(|tx| tx.get("c", b"k")).unwrap();
        assert_eq!(got, None, "value committed despite panic");
    }

    // ---- persistence ----

    #[test]
    fn writes_persist_across_open_close() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        {
            let db = Database::open(&path).unwrap();
            db.write(|tx| tx.put("c", b"k", b"persistent")).unwrap();
        }
        {
            let db = Database::open(&path).unwrap();
            let got = db.read(|tx| tx.get("c", b"k")).unwrap();
            assert_eq!(got.as_deref(), Some(&b"persistent"[..]));
        }
    }

    // ---- input validation ----

    #[test]
    fn put_rejects_collection_with_null_byte() {
        let (_dir, db) = fresh_db();
        let err = db.write(|tx| tx.put("bad\0name", b"k", b"v")).unwrap_err();
        assert_eq!(err.kind(), NookErrorKind::InvalidArg);
    }

    #[test]
    fn put_rejects_empty_collection() {
        let (_dir, db) = fresh_db();
        let err = db.write(|tx| tx.put("", b"k", b"v")).unwrap_err();
        assert_eq!(err.kind(), NookErrorKind::InvalidArg);
    }

    // ---- read-tx isolation (MVCC snapshot) ----

    #[test]
    fn read_tx_sees_snapshot_not_later_writes() {
        let (_dir, db) = fresh_db();
        db.write(|tx| tx.put("c", b"k", b"v_old")).unwrap();
        let read_observed: Option<Vec<u8>> = db
            .read(|tx| {
                let snapshot = tx.get("c", b"k")?;
                Ok(snapshot)
            })
            .unwrap();
        assert_eq!(read_observed.as_deref(), Some(&b"v_old"[..]));
    }

    #[test]
    fn list_collection_inside_read_returns_committed_entries() {
        let (_dir, db) = fresh_db();
        db.write(|tx| {
            tx.put("c", b"k1", b"v1")?;
            tx.put("c", b"k2", b"v2")?;
            Ok(())
        })
        .unwrap();
        let entries = db.read(|tx| tx.list_collection("c")).unwrap();
        assert_eq!(entries.len(), 2);
    }

    // ---- post-commit dispatch ----

    use crate::notify::{CommitEvent, CommitObserver};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Spy(Mutex<Vec<Vec<String>>>); // one Vec<collection> per received event
    impl CommitObserver for Spy {
        fn on_commit(&self, ev: &CommitEvent) {
            self.0.lock().unwrap().push(
                ev.touched_collections()
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            );
        }
    }

    #[test]
    fn commit_dispatches_one_event_with_touched_collections() {
        let (_dir, db) = fresh_db();
        let spy = Arc::new(Spy::default());
        let _h = db.add_observer(spy.clone());
        db.write(|tx| {
            tx.put("users", b"u1", b"Ali")?;
            tx.put("posts", b"p1", b"Hi")?;
            Ok(())
        })
        .unwrap();
        let got = spy.0.lock().unwrap().clone();
        assert_eq!(got, vec![vec!["posts".to_string(), "users".to_string()]]);
    }

    #[test]
    fn rollback_and_panic_never_dispatch() {
        let (_dir, db) = fresh_db();
        let spy = Arc::new(Spy::default());
        let _h = db.add_observer(spy.clone());

        let _ = db.write(|tx| -> Result<(), NookError> {
            tx.put("c", b"k", b"v")?;
            Err(NookError::Transaction {
                msg: "rollback".into(),
            })
        });
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = db.write(|tx| -> Result<(), NookError> {
                tx.put("c", b"k", b"v")?;
                panic!("boom");
            });
        }));
        assert!(
            spy.0.lock().unwrap().is_empty(),
            "no dispatch on rollback/panic"
        );
    }

    #[test]
    fn a_no_op_commit_does_not_dispatch() {
        let (_dir, db) = fresh_db();
        let spy = Arc::new(Spy::default());
        let _h = db.add_observer(spy.clone());
        db.write(|_tx| Ok(())).unwrap(); // committed but touched nothing
        assert!(
            spy.0.lock().unwrap().is_empty(),
            "empty CommitEvent suppressed"
        );
    }
}
