//! Read and write transaction handles wrapping redb transactions.

use redb::{ReadableTable, Table, TableDefinition};

use crate::codec::{
    collection_prefix_lower, collection_prefix_upper, encode_key, strip_collection_prefix,
};
use crate::database::{map_redb_storage_error, map_redb_table_error};
use crate::error::NookError;
use crate::notify::{ChangeOp, DocChange};

/// All entries live in this single redb table. Collection routing is
/// done via composite keys (see `crate::codec`).
pub(crate) const ENTRIES: TableDefinition<&[u8], &[u8]> = TableDefinition::new("entries");

/// One (key, value) pair from a `list_collection` scan. Both byte vectors.
pub type Entry = (Vec<u8>, Vec<u8>);

/// Handle exposed to read transaction callbacks. MVCC snapshot.
///
/// No lifetime parameter: `redb::ReadOnlyTable` is `Arc<TransactionGuard>`-backed
/// and fully owns its data. The read-side table does not borrow the `ReadTransaction`.
pub struct ReadTx {
    /// `None` when the "entries" table has never been written to (fresh db).
    table: Option<redb::ReadOnlyTable<&'static [u8], &'static [u8]>>,
    /// `None` when the index table has never been written to (no index
    /// maintenance has occurred yet). Opened from the same MVCC snapshot
    /// as `table`; like `table`, the `Arc`-backed `ReadOnlyTable` fully
    /// owns its data and does not borrow the `ReadTransaction`.
    index_table: Option<redb::ReadOnlyTable<&'static [u8], &'static [u8]>>,
}

impl ReadTx {
    pub(crate) fn new(txn: &redb::ReadTransaction) -> Result<Self, NookError> {
        let table = match txn.open_table(ENTRIES) {
            Ok(table) => Some(table),
            Err(redb::TableError::TableDoesNotExist(_)) => None,
            Err(e) => return Err(map_redb_table_error(e)),
        };
        let index_table = match txn.open_table(crate::index::engine::INDEX_ENTRIES) {
            Ok(t) => Some(t),
            Err(redb::TableError::TableDoesNotExist(_)) => None,
            Err(e) => return Err(map_redb_table_error(e)),
        };
        Ok(Self { table, index_table })
    }

    /// Returns the value stored under `(collection, key)`, or `None`.
    ///
    /// # Errors
    ///
    /// Returns `NookError::InvalidArg` if `collection` is empty or contains
    /// a null byte. Returns `NookError::Storage` or `NookError::Corruption`
    /// on underlying storage failure.
    pub fn get(&self, collection: &str, key: &[u8]) -> Result<Option<Vec<u8>>, NookError> {
        let Some(ref table) = self.table else {
            // Validate the collection name BEFORE the empty-table early return, so a bad collection still yields InvalidArg (not Ok(None)/Ok(empty)) even on a fresh, never-written db.
            encode_key(collection, key)?;
            return Ok(None);
        };
        let composite = encode_key(collection, key)?;
        let guard = table
            .get(composite.as_slice())
            .map_err(map_redb_storage_error)?;
        Ok(guard.map(|v| v.value().to_vec()))
    }

    /// Returns all `(key, value)` pairs in the named collection,
    /// in lexicographic key order. May be empty.
    ///
    /// # Errors
    ///
    /// Returns `NookError::InvalidArg` if `collection` is empty or contains
    /// a null byte. Returns `NookError::Storage` or `NookError::Corruption`
    /// on underlying storage failure.
    pub fn list_collection(&self, collection: &str) -> Result<Vec<Entry>, NookError> {
        let Some(ref table) = self.table else {
            // Validate the collection name BEFORE the empty-table early return, so a bad collection still yields InvalidArg (not Ok(None)/Ok(empty)) even on a fresh, never-written db.
            collection_prefix_lower(collection)?;
            return Ok(vec![]);
        };
        let lower = collection_prefix_lower(collection)?;
        let upper = collection_prefix_upper(collection)?;
        let iter = table
            .range::<&[u8]>(lower.as_slice()..upper.as_slice())
            .map_err(map_redb_storage_error)?;
        let mut out = Vec::new();
        for entry in iter {
            let (k, v) = entry.map_err(map_redb_storage_error)?;
            let composite: &[u8] = k.value();
            let user_key = strip_collection_prefix(composite, collection)
                .ok_or_else(|| NookError::Corruption {
                    msg: format!(
                        "composite key missing expected prefix for collection {collection:?}"
                    ),
                })?
                .to_vec();
            out.push((user_key, v.value().to_vec()));
        }
        Ok(out)
    }

    /// Returns every `(composite_key, value)` pair across the entire
    /// `entries` table, in key order. Used by `crate::backup::write_backup`
    /// to stream a full DB snapshot. The composite key encoding is opaque
    /// here — the backup format does not decompose it (restore writes the
    /// same composite keys back).
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` or `NookError::Corruption` on
    /// underlying storage failure.
    pub fn list_entries_raw(&self) -> Result<Vec<Entry>, NookError> {
        let Some(ref table) = self.table else {
            return Ok(vec![]);
        };
        let iter = table.iter().map_err(map_redb_storage_error)?;
        let mut out = Vec::new();
        for entry in iter {
            let (k, v) = entry.map_err(map_redb_storage_error)?;
            out.push((k.value().to_vec(), v.value().to_vec()));
        }
        Ok(out)
    }

    /// Returns every value stored under index keys in the half-open
    /// range `[lo, hi)` of the secondary-index table, in key order.
    ///
    /// Returns an empty vector when the index table has never been
    /// written (no index maintenance has occurred yet). Used by the
    /// index engine for equality lookups; collection/key routing is
    /// encoded into `lo`/`hi` by `crate::index::engine`.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` or `NookError::Corruption` on
    /// underlying storage failure.
    pub fn index_range_values(&self, lo: &[u8], hi: &[u8]) -> Result<Vec<Vec<u8>>, NookError> {
        let Some(ref t) = self.index_table else {
            return Ok(vec![]);
        };
        let iter = t.range::<&[u8]>(lo..hi).map_err(map_redb_storage_error)?;
        let mut out = Vec::new();
        for r in iter {
            let (_k, v) = r.map_err(map_redb_storage_error)?;
            out.push(v.value().to_vec());
        }
        Ok(out)
    }
}

/// Handle exposed to write transaction callbacks. Serializable.
pub struct WriteTx<'tx> {
    table: Table<'tx, &'static [u8], &'static [u8]>,
    /// Secondary-index table, opened from the SAME write transaction as
    /// `table` so index maintenance and document writes commit (or roll
    /// back) atomically together. redb permits multiple tables open
    /// concurrently within one `WriteTransaction`; each `Table` borrows
    /// `&'tx WriteTransaction` immutably (`open_table` takes `&'txn self`).
    index_table: Table<'tx, &'static [u8], &'static [u8]>,
    /// Accumulates document-level changes made within this transaction.
    /// Drained by `take_touched` after a successful commit; rollback drops
    /// `WriteTx` without ever calling `take_touched`, so the vec is simply
    /// discarded.
    touched: Vec<DocChange>,
}

impl<'tx> WriteTx<'tx> {
    pub(crate) fn new(txn: &'tx redb::WriteTransaction) -> Result<Self, NookError> {
        let table = txn.open_table(ENTRIES).map_err(map_redb_table_error)?;
        let index_table = txn
            .open_table(crate::index::engine::INDEX_ENTRIES)
            .map_err(map_redb_table_error)?;
        Ok(Self {
            table,
            index_table,
            touched: Vec::new(),
        })
    }

    /// Drains and returns every document change accumulated so far in this
    /// transaction. A second call on the same transaction returns an empty
    /// `Vec`. Intended to be called by `Database::write` immediately after
    /// a successful commit to build a [`crate::notify::CommitEvent`];
    /// rollback simply drops `WriteTx` without calling this method.
    pub fn take_touched(&mut self) -> Vec<DocChange> {
        std::mem::take(&mut self.touched)
    }

    /// Inserts or overwrites `(collection, key) -> value`.
    ///
    /// # Errors
    ///
    /// Returns `NookError::InvalidArg` if `collection` is empty or contains
    /// a null byte. Returns `NookError::Storage` on underlying storage failure.
    pub fn put(&mut self, collection: &str, key: &[u8], value: &[u8]) -> Result<(), NookError> {
        let composite = encode_key(collection, key)?;
        self.table
            .insert(composite.as_slice(), value)
            .map_err(map_redb_storage_error)?;
        self.touched.push(DocChange {
            collection: collection.to_string(),
            op: ChangeOp::Insert,
            doc_id: key.to_vec(),
        });
        Ok(())
    }

    /// Same semantics as `ReadTx::get`, but reads from the current
    /// uncommitted state of this write transaction.
    ///
    /// # Errors
    ///
    /// Returns `NookError::InvalidArg` if `collection` is empty or contains
    /// a null byte. Returns `NookError::Storage` or `NookError::Corruption`
    /// on underlying storage failure.
    pub fn get(&self, collection: &str, key: &[u8]) -> Result<Option<Vec<u8>>, NookError> {
        let composite = encode_key(collection, key)?;
        let guard = self
            .table
            .get(composite.as_slice())
            .map_err(map_redb_storage_error)?;
        Ok(guard.map(|v| v.value().to_vec()))
    }

    /// Removes `(collection, key)`. Returns `true` if the key was
    /// present, `false` otherwise.
    ///
    /// # Errors
    ///
    /// Returns `NookError::InvalidArg` if `collection` is empty or contains
    /// a null byte. Returns `NookError::Storage` on underlying storage failure.
    pub fn delete(&mut self, collection: &str, key: &[u8]) -> Result<bool, NookError> {
        let composite = encode_key(collection, key)?;
        let removed = self
            .table
            .remove(composite.as_slice())
            .map_err(map_redb_storage_error)?;
        let existed = removed.is_some();
        if existed {
            self.touched.push(DocChange {
                collection: collection.to_string(),
                op: ChangeOp::Delete,
                doc_id: key.to_vec(),
            });
        }
        Ok(existed)
    }

    /// Inserts (or overwrites) a raw `key -> value` pair into the
    /// secondary-index table within this write transaction. The
    /// composite index key layout is owned by `crate::index::engine`;
    /// this method is layout-agnostic.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` on underlying storage failure.
    pub fn index_put(&mut self, k: &[u8], v: &[u8]) -> Result<(), NookError> {
        self.index_table
            .insert(k, v)
            .map_err(map_redb_storage_error)?;
        Ok(())
    }

    /// Removes a raw key from the secondary-index table within this
    /// write transaction. A missing key is not an error.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` on underlying storage failure.
    pub fn index_delete(&mut self, k: &[u8]) -> Result<(), NookError> {
        self.index_table.remove(k).map_err(map_redb_storage_error)?;
        Ok(())
    }

    /// Same semantics as `ReadTx::index_range_values`, but reads from the
    /// current uncommitted state of this write transaction. Lets the
    /// index engine perform a unique-constraint pre-check that observes
    /// the in-flight write (a separate read snapshot would miss prior
    /// inserts made within the same transaction).
    ///
    /// Returns an empty vector when no index maintenance has occurred in
    /// this transaction (the index table is created lazily). The
    /// composite index key layout is owned by `crate::index::engine`;
    /// this method is layout-agnostic.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` or `NookError::Corruption` on
    /// underlying storage failure.
    pub fn index_range_values(&self, lo: &[u8], hi: &[u8]) -> Result<Vec<Vec<u8>>, NookError> {
        let iter = self
            .index_table
            .range::<&[u8]>(lo..hi)
            .map_err(map_redb_storage_error)?;
        let mut out = Vec::new();
        for r in iter {
            let (_k, v) = r.map_err(map_redb_storage_error)?;
            out.push(v.value().to_vec());
        }
        Ok(out)
    }

    /// Returns true iff the `entries` table has at least one row.
    ///
    /// Used by backup restore to enforce the `allow_overwrite` gate.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` on underlying storage failure.
    pub fn has_any_entry(&self) -> Result<bool, NookError> {
        let mut iter = self.table.iter().map_err(map_redb_storage_error)?;
        Ok(iter.next().is_some())
    }

    /// Removes every row from the `entries` table AND the index table.
    ///
    /// Used by backup restore when `allow_overwrite=true`.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` on underlying storage failure.
    pub fn clear_entries(&mut self) -> Result<(), NookError> {
        self.table
            .retain(|_, _| false)
            .map_err(map_redb_storage_error)?;
        self.index_table
            .retain(|_, _| false)
            .map_err(map_redb_storage_error)?;
        Ok(())
    }

    /// Inserts a raw `(composite_key, value)` pair into the `entries` table.
    ///
    /// Used by backup restore to replay a `.nbkp` snapshot. Does NOT touch
    /// the index table — backup restore replays composite keys from the same
    /// source table, and the index table is empty (cleared by `clear_entries`)
    /// so secondary indexes will be lost after restore until reindexed.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Storage` on underlying storage failure.
    pub fn put_raw(&mut self, composite_key: &[u8], value: &[u8]) -> Result<(), NookError> {
        self.table
            .insert(composite_key, value)
            .map_err(map_redb_storage_error)?;
        Ok(())
    }

    /// Same semantics as `ReadTx::list_collection`, but reads from the
    /// current uncommitted state of this write transaction.
    ///
    /// # Errors
    ///
    /// Returns `NookError::InvalidArg` if `collection` is empty or contains
    /// a null byte. Returns `NookError::Storage` or `NookError::Corruption`
    /// on underlying storage failure.
    pub fn list_collection(&self, collection: &str) -> Result<Vec<Entry>, NookError> {
        let lower = collection_prefix_lower(collection)?;
        let upper = collection_prefix_upper(collection)?;
        let iter = self
            .table
            .range::<&[u8]>(lower.as_slice()..upper.as_slice())
            .map_err(map_redb_storage_error)?;
        let mut out = Vec::new();
        for entry in iter {
            let (k, v) = entry.map_err(map_redb_storage_error)?;
            let composite: &[u8] = k.value();
            let user_key = strip_collection_prefix(composite, collection)
                .ok_or_else(|| NookError::Corruption {
                    msg: format!(
                        "composite key missing expected prefix for collection {collection:?}"
                    ),
                })?
                .to_vec();
            out.push((user_key, v.value().to_vec()));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use crate::database::Database;
    use crate::notify::ChangeOp;

    fn fresh_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let db = Database::open(&path).unwrap();
        (dir, db)
    }

    #[test]
    fn write_tx_records_put_as_insert_and_real_delete_as_delete() {
        let (_dir, db) = fresh_db();
        let touched = db
            .write(|tx| {
                tx.put("users", b"u1", b"Ali")?;
                tx.put("users", b"u2", b"Veli")?;
                let _ = tx.delete("users", b"u2")?; // existed → recorded
                let _ = tx.delete("users", b"ghost")?; // absent → NOT recorded
                Ok(tx.take_touched())
            })
            .unwrap();
        let summary: Vec<(&str, ChangeOp, &[u8])> = touched
            .iter()
            .map(|c| (c.collection.as_str(), c.op, c.doc_id.as_slice()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("users", ChangeOp::Insert, &b"u1"[..]),
                ("users", ChangeOp::Insert, &b"u2"[..]),
                ("users", ChangeOp::Delete, &b"u2"[..]),
            ]
        );
    }

    #[test]
    fn take_touched_drains_so_a_second_call_is_empty() {
        let (_dir, db) = fresh_db();
        let (first, second) = db
            .write(|tx| {
                tx.put("c", b"k", b"v")?;
                let a = tx.take_touched();
                let b = tx.take_touched();
                Ok((a.len(), b.len()))
            })
            .unwrap();
        assert_eq!((first, second), (1, 0));
    }
}
