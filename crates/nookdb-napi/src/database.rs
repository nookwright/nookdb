//! JS-facing `Database` class.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;
use nookdb_core::collection::Collection;
use nookdb_core::live::{LiveEngine, SubId};
use nookdb_core::migrate::Runner;
use nookdb_core::schema::ir::SchemaIr;
use nookdb_core::{
    backup_to_path, restore_from_path, Database as CoreDatabase, NookError, RestoreOptions,
};

use crate::backup::{JsBackupStats, JsRestoreOptions, JsRestoreStats};
use crate::error::{map_join_error, map_nook_error};
use crate::live::TsfnSink;

/// Source of unique, opaque live-subscription ids (`live-<n>`). A plain
/// monotonic counter — ids are never reused within a process, so a
/// stale `liveCancel(id)` after the sub already ended is a harmless
/// no-op (registry miss).
static LIVE_ID: AtomicU64 = AtomicU64::new(0);

/// Mints the next opaque live-subscription id.
fn next_live_id() -> String {
    format!("live-{}", LIVE_ID.fetch_add(1, Ordering::Relaxed))
}

/// Shared, `'static`-safe handle to the opened core database plus the
/// (optional) compiled schema.
///
/// `crate::collection::Collection<'a>` borrows `&'a Database` AND
/// `&'a SchemaIr`, and `crate::migrate::Runner<'a>` borrows `&'a Database`.
/// `tokio::task::spawn_blocking` needs owned/`'static` data moved into the
/// closure, so this struct owns reference-counted handles. Each typed op
/// clones the `Arc`(s), moves the clone(s) into the blocking closure, and
/// constructs the short-lived borrowing type *inside* the closure (the
/// borrows are local to that closure → `'static`-safe).
#[derive(Clone)]
struct DbHandle {
    db: Arc<CoreDatabase>,
    /// `None` for the M1 bytes-only `open` constructor; `Some` after
    /// `open_with_schema`. The typed ops require it; the M1 bytes ops and
    /// `migrate_status` do not.
    schema: Option<Arc<SchemaIr>>,
    /// `None` for the bytes-only `open` constructor; `Some` after
    /// `open_with_schema` (the reactive engine needs the compiled
    /// schema for `Collection::find`). Dropping the last clone of this
    /// `Arc` joins the live worker thread + unregisters the reactive
    /// observer (graceful complete), so it must be cancelled-then-let-go
    /// only after every live sub is detached (see `close()`).
    live: Option<Arc<LiveEngine>>,
}

/// JS-facing handle to a Nook database file.
#[napi(js_name = "Database")]
pub struct JsDatabase {
    inner: Mutex<Option<DbHandle>>,
    /// Live subscriptions registered via `live()`, keyed by the opaque
    /// `live-<n>` id. Holds the core `SubId` (to `cancel` through the
    /// engine) and the `Arc<TsfnSink>` (to `mark_closed` on cancel,
    /// and to keep the `ThreadsafeFunction` alive while the sub is
    /// active — dropping it releases the JS callback). Separate from
    /// `inner` so a `live`/`liveCancel` never contends the data-op lock.
    live_subs: Mutex<HashMap<String, (SubId, Arc<TsfnSink>)>>,
    /// In-flight `db.transaction(cb)` write txns, keyed by the
    /// monotonic `i64` handle minted by `next_tx_id`. Each entry buffers
    /// pending ops in memory; on `commit_write_txn` the buffered ops are
    /// replayed inside a single `Database::write` closure (atomic
    /// commit/rollback). See M5c §3.1 — the buffer-then-replay shape
    /// sidesteps redb's `WriteTransaction: !Send` constraint + napi-rs
    /// async-callback complexity. Lock is held only for handle-table
    /// mutation (insert/remove/append-op); the actual commit drops the
    /// guard before doing redb work.
    tx_states: Arc<Mutex<HashMap<i64, WriteTxState>>>,
    /// Monotonic source of `db.transaction` handles. `i64` (not `u64`)
    /// so the NAPI surface returns a plain JS number-safe integer.
    /// Wraps after `i64::MAX` ops in one process (~292 billion years at
    /// 1 µs per txn) — accepted.
    next_tx_id: Arc<AtomicI64>,
}

/// State for one in-flight `db.transaction(cb)` write txn. The pending
/// ops accumulate as the TS callback awaits each `tx.*` call; on
/// commit they are replayed inside a single `Database::write` closure.
/// Sidesteps redb's `WriteTransaction: !Send` constraint + napi-rs
/// async-callback complexity by keeping the actual redb txn entirely
/// within the synchronous `commit_write_txn` blocking section.
struct WriteTxState {
    /// Shared handle to the opened core DB — cloned at `begin` so a
    /// concurrent `close()` does not race the commit replay (the last
    /// in-flight `Arc` clone keeps the DB alive).
    db_arc: Arc<CoreDatabase>,
    /// Compiled schema, needed at commit-time to construct a
    /// `Collection` for each pending op (typed insert/delete-many
    /// require it). `None` if the DB was opened without a schema — but
    /// in that case `begin_write_txn` rejects up front so the schema is
    /// always present when ops are buffered.
    schema: Arc<SchemaIr>,
    /// Ops buffered so far, in TS call order. Replayed in this order at
    /// commit-time.
    ops: Vec<PendingOp>,
}

/// One op buffered inside a `WriteTxState`. Each variant carries
/// exactly the inputs the corresponding `Collection` typed method
/// needs; the actual decode + validate happens at commit-time so a
/// malformed op aborts the whole txn (no partial state).
enum PendingOp {
    /// `tx.insert(collection, docJson)` — schema-validated insert.
    Insert {
        collection: String,
        doc_json: String,
    },
    /// `tx.deleteMany(collection, filterJson)` — schema-aware filter
    /// delete. Count not returned eagerly (the buffered model has no
    /// pre-commit count).
    DeleteMany {
        collection: String,
        filter_json: String,
    },
}

/// One `(key, value)` pair returned from `listCollection`.
#[napi(object)]
pub struct DbEntry {
    pub key: Buffer,
    pub value: Buffer,
}

/// Snapshot of the migration-version ledger (the §6b `Runner`).
#[napi(object)]
pub struct MigrateStatus {
    /// The highest applied version number, or 0 if none.
    pub current_version: u32,
    /// The number of applied migration versions.
    pub applied_count: u32,
}

/// Result of registering a live query via `live()`.
#[napi(object)]
pub struct LiveRegistration {
    /// Opaque id to pass to `liveCancel` to detach this subscription.
    pub subscription_id: String,
    /// The synchronously computed first snapshot envelope
    /// (`{"ok":true,"value":[…]}` | `{"ok":false,"error":"[kind] msg"}`),
    /// so the TS surface can populate `.value` without waiting for the
    /// first commit.
    pub initial_json: String,
}

#[napi]
impl JsDatabase {
    /// Opens the database at `path`, creating it if necessary.
    #[napi(factory)]
    pub async fn open(path: String) -> napi::Result<Self> {
        let db = tokio::task::spawn_blocking(move || CoreDatabase::open(&path))
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)?;
        Ok(Self {
            inner: Mutex::new(Some(DbHandle {
                db: Arc::new(db),
                schema: None,
                live: None,
            })),
            live_subs: Mutex::new(HashMap::new()),
            tx_states: Arc::new(Mutex::new(HashMap::new())),
            next_tx_id: Arc::new(AtomicI64::new(1)),
        })
    }

    /// Opens the database at `path` and binds it to the compiled schema
    /// described by `schema_descriptor` (the JSON descriptor produced by the
    /// TS `s.*` DSL). Required for the typed ops
    /// (`insert`/`find`/`findOne`/`count`/`delete`).
    #[napi(factory)]
    pub async fn open_with_schema(path: String, schema_descriptor: String) -> napi::Result<Self> {
        let (db, schema) = tokio::task::spawn_blocking(move || {
            let db = CoreDatabase::open(&path)?;
            let schema = SchemaIr::compile(&schema_descriptor)?;
            Ok::<_, NookError>((db, schema))
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)?;
        let db = Arc::new(db);
        let schema = Arc::new(schema);
        // Live requires the compiled schema (its worker recomputes via
        // `Collection::find`), so the engine is built here and only here.
        // `LiveEngine::new` registers the reactive observer on `db`'s
        // notifier + spawns the single worker thread.
        let live = Some(LiveEngine::new(db.clone(), schema.clone()));
        Ok(Self {
            inner: Mutex::new(Some(DbHandle {
                db,
                schema: Some(schema),
                live,
            })),
            live_subs: Mutex::new(HashMap::new()),
            tx_states: Arc::new(Mutex::new(HashMap::new())),
            next_tx_id: Arc::new(AtomicI64::new(1)),
        })
    }

    /// Stores `value` under `(collection, key)`.
    #[napi]
    pub async fn put(&self, collection: String, key: Buffer, value: Buffer) -> napi::Result<()> {
        let db = self.get_db()?;
        let key_vec: Vec<u8> = key.into();
        let value_vec: Vec<u8> = value.into();
        tokio::task::spawn_blocking(move || {
            db.write(|tx| tx.put(&collection, &key_vec, &value_vec))
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)
    }

    /// Retrieves the value at `(collection, key)`, or `null`.
    #[napi]
    pub async fn get(&self, collection: String, key: Buffer) -> napi::Result<Option<Buffer>> {
        let db = self.get_db()?;
        let key_vec: Vec<u8> = key.into();
        let opt = tokio::task::spawn_blocking(move || db.read(|tx| tx.get(&collection, &key_vec)))
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)?;
        Ok(opt.map(Buffer::from))
    }

    /// Removes `(collection, key)`. Returns `true` if it existed.
    #[napi]
    pub async fn delete(&self, collection: String, key: Buffer) -> napi::Result<bool> {
        let db = self.get_db()?;
        let key_vec: Vec<u8> = key.into();
        tokio::task::spawn_blocking(move || db.write(|tx| tx.delete(&collection, &key_vec)))
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)
    }

    /// Returns every `(key, value)` pair in `collection`, in key order.
    #[napi(js_name = "listCollection")]
    pub async fn list_collection(&self, collection: String) -> napi::Result<Vec<DbEntry>> {
        let db = self.get_db()?;
        let entries =
            tokio::task::spawn_blocking(move || db.read(|tx| tx.list_collection(&collection)))
                .await
                .map_err(map_join_error)?
                .map_err(map_nook_error)?;
        Ok(entries
            .into_iter()
            .map(|(k, v)| DbEntry {
                key: Buffer::from(k),
                value: Buffer::from(v),
            })
            .collect())
    }

    /// Validates and stores `doc_json` (a single JSON document) in
    /// `collection`, maintaining every secondary index atomically.
    ///
    /// Requires the database to have been opened via `openWithSchema`.
    #[napi]
    pub async fn insert(&self, collection: String, doc_json: String) -> napi::Result<()> {
        let (db, schema) = self.get_db_and_schema()?;
        let doc: serde_json::Value = serde_json::from_str(&doc_json).map_err(|e| {
            map_nook_error(NookError::Schema {
                msg: format!("invalid document JSON: {e}"),
            })
        })?;
        tokio::task::spawn_blocking(move || {
            let c = Collection::new(&db, &schema, &collection)?;
            c.insert(&doc)
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)
    }

    /// Returns every document in `collection` matching `filter_json`, as a
    /// list of JSON strings (the TS surface parses them back).
    ///
    /// Requires the database to have been opened via `openWithSchema`.
    #[napi]
    pub async fn find(
        &self,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
    ) -> napi::Result<Vec<String>> {
        let (db, schema) = self.get_db_and_schema()?;
        let filter = parse_filter(&filter_json)?;
        let opts = parse_options(options_json)?;
        let docs = tokio::task::spawn_blocking(move || {
            let c = Collection::new(&db, &schema, &collection)?;
            c.find_with(&filter, &opts)
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)?;
        docs_to_json(docs)
    }

    /// Returns the first document in `collection` matching `filter_json` as a
    /// JSON string, or `null`.
    ///
    /// Requires the database to have been opened via `openWithSchema`.
    #[napi(js_name = "findOne")]
    pub async fn find_one(
        &self,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
    ) -> napi::Result<Option<String>> {
        let (db, schema) = self.get_db_and_schema()?;
        let filter = parse_filter(&filter_json)?;
        let opts = parse_options(options_json)?;
        let doc = tokio::task::spawn_blocking(move || {
            let c = Collection::new(&db, &schema, &collection)?;
            c.find_one_with(&filter, &opts)
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)?;
        doc.map(value_to_json).transpose()
    }

    /// Returns the number of documents in `collection` matching
    /// `filter_json`.
    ///
    /// Requires the database to have been opened via `openWithSchema`.
    #[napi]
    pub async fn count(
        &self,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
    ) -> napi::Result<u32> {
        let (db, schema) = self.get_db_and_schema()?;
        let filter = parse_filter(&filter_json)?;
        let opts = parse_options(options_json)?;
        let n = tokio::task::spawn_blocking(move || {
            let c = Collection::new(&db, &schema, &collection)?;
            c.count_with(&filter, &opts)
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)?;
        Ok(clamp_count(n))
    }

    /// Deletes every document in `collection` matching `filter_json`,
    /// returning the number removed.
    ///
    /// Requires the database to have been opened via `openWithSchema`.
    #[napi(js_name = "deleteMany")]
    pub async fn delete_many(&self, collection: String, filter_json: String) -> napi::Result<u32> {
        let (db, schema) = self.get_db_and_schema()?;
        let filter = parse_filter(&filter_json)?;
        let n = tokio::task::spawn_blocking(move || {
            let c = Collection::new(&db, &schema, &collection)?;
            c.delete(&filter)
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)?;
        Ok(clamp_count(n))
    }

    /// Begins a buffered write transaction and returns a monotonic
    /// `i64` handle. Subsequent `txInsert`/`txDeleteMany` ops are
    /// buffered against this handle; `commitWriteTxn` replays them
    /// atomically inside a single `Database::write` closure.
    /// `rollbackWriteTxn` discards the buffer without writing.
    ///
    /// Requires the database to have been opened via `openWithSchema`
    /// (typed ops need the compiled schema at commit-time).
    ///
    /// See M5c §3.1 for the rationale behind the buffer-then-replay
    /// shape (redb `WriteTransaction: !Send` + napi-rs async-callback
    /// complexity).
    #[napi(js_name = "beginWriteTxn")]
    // Async signature kept for JS-surface uniformity (every typed op is
    // `Promise<T>` even when the Rust body is sync); see the surrounding
    // tx_* methods.
    #[allow(clippy::unused_async)]
    pub async fn begin_write_txn(&self) -> napi::Result<i64> {
        // Validate the open-with-schema invariant up front so the
        // failure mode is "[schema] no schema" at begin, not later at
        // commit (cleaner TS-side error path).
        let (db_arc, schema) = self.get_db_and_schema()?;
        let id = self.next_tx_id.fetch_add(1, Ordering::SeqCst);
        let mut guard = self
            .tx_states
            .lock()
            .map_err(|_| napi::Error::from_reason("[transaction] tx registry mutex poisoned"))?;
        guard.insert(
            id,
            WriteTxState {
                db_arc,
                schema,
                ops: Vec::new(),
            },
        );
        drop(guard);
        Ok(id)
    }

    /// Buffers an `insert` op against the in-flight write txn
    /// `txHandle`. Validation + storage write happen at commit-time
    /// inside the shared `Database::write` closure.
    ///
    /// # Errors
    ///
    /// Returns `[transaction]` with `unknown tx handle` if the handle
    /// was never `beginWriteTxn`'d or has already been committed /
    /// rolled back.
    #[napi(js_name = "txInsert")]
    // Async signature kept for JS-surface uniformity; the body is a pure
    // in-memory buffer push (no awaits).
    #[allow(clippy::unused_async)]
    pub async fn tx_insert(
        &self,
        tx_handle: i64,
        collection: String,
        doc_json: String,
    ) -> napi::Result<()> {
        let mut guard = self
            .tx_states
            .lock()
            .map_err(|_| napi::Error::from_reason("[transaction] tx registry mutex poisoned"))?;
        let state = guard.get_mut(&tx_handle).ok_or_else(|| {
            napi::Error::from_reason(
                "[transaction] unknown tx handle (already committed/rolled back?)",
            )
        })?;
        state.ops.push(PendingOp::Insert {
            collection,
            doc_json,
        });
        drop(guard);
        Ok(())
    }

    /// Buffers a `deleteMany` op against the in-flight write txn
    /// `txHandle`. Returns `0` eagerly — the actual delete count is
    /// only known after the buffer is replayed at commit time. The
    /// M5c TS surface ignores this return value for in-txn deletes.
    ///
    /// # Errors
    ///
    /// Returns `[transaction]` with `unknown tx handle` if the handle
    /// is unknown.
    #[napi(js_name = "txDeleteMany")]
    // Async signature kept for JS-surface uniformity; the body is a pure
    // in-memory buffer push (no awaits).
    #[allow(clippy::unused_async)]
    pub async fn tx_delete_many(
        &self,
        tx_handle: i64,
        collection: String,
        filter_json: String,
    ) -> napi::Result<i64> {
        let mut guard = self
            .tx_states
            .lock()
            .map_err(|_| napi::Error::from_reason("[transaction] tx registry mutex poisoned"))?;
        let state = guard
            .get_mut(&tx_handle)
            .ok_or_else(|| napi::Error::from_reason("[transaction] unknown tx handle"))?;
        state.ops.push(PendingOp::DeleteMany {
            collection,
            filter_json,
        });
        drop(guard);
        // Count only known at commit-time; M5c keeps the buffered model
        // simple. Read-after-write inside the same txn is M6 retrofit.
        Ok(0)
    }

    /// Reads inside an in-flight `db.transaction(cb)` see the latest
    /// committed snapshot, NOT the in-flight buffer (M5c limitation;
    /// see M6 retrofit note in the design spec). The `txHandle` is
    /// accepted for API symmetry but is not consulted by the read path.
    #[napi(js_name = "txFind")]
    pub async fn tx_find(
        &self,
        tx_handle: i64,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
    ) -> napi::Result<Vec<String>> {
        // M5c limitation: tx-aware read deferred to M6. The handle is
        // accepted purely for API symmetry; the actual read goes via
        // the same path as the atomic `find` (latest committed
        // snapshot). Validate the handle exists so a `tx.find(...)`
        // after the txn was rolled back / committed still surfaces as
        // `[transaction] unknown tx handle` rather than silently
        // succeeding on stale data.
        {
            let guard = self.tx_states.lock().map_err(|_| {
                napi::Error::from_reason("[transaction] tx registry mutex poisoned")
            })?;
            if !guard.contains_key(&tx_handle) {
                return Err(napi::Error::from_reason(
                    "[transaction] unknown tx handle (already committed/rolled back?)",
                ));
            }
        }
        self.find(collection, filter_json, options_json).await
    }

    /// Same M5c limitation as `txFind`: reads see the latest committed
    /// snapshot, not the in-flight buffer.
    #[napi(js_name = "txFindOne")]
    pub async fn tx_find_one(
        &self,
        tx_handle: i64,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
    ) -> napi::Result<Option<String>> {
        {
            let guard = self.tx_states.lock().map_err(|_| {
                napi::Error::from_reason("[transaction] tx registry mutex poisoned")
            })?;
            if !guard.contains_key(&tx_handle) {
                return Err(napi::Error::from_reason(
                    "[transaction] unknown tx handle (already committed/rolled back?)",
                ));
            }
        }
        self.find_one(collection, filter_json, options_json).await
    }

    /// Same M5c limitation as `txFind`: reads see the latest committed
    /// snapshot, not the in-flight buffer.
    #[napi(js_name = "txCount")]
    pub async fn tx_count(
        &self,
        tx_handle: i64,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
    ) -> napi::Result<u32> {
        {
            let guard = self.tx_states.lock().map_err(|_| {
                napi::Error::from_reason("[transaction] tx registry mutex poisoned")
            })?;
            if !guard.contains_key(&tx_handle) {
                return Err(napi::Error::from_reason(
                    "[transaction] unknown tx handle (already committed/rolled back?)",
                ));
            }
        }
        self.count(collection, filter_json, options_json).await
    }

    /// Replays the buffered ops for `txHandle` atomically inside one
    /// `Database::write` closure. The buffer is removed from the
    /// registry BEFORE the redb write runs (so the registry guard
    /// drops cleanly); a failure inside `write` rolls back the entire
    /// txn (every buffered op).
    ///
    /// After commit (success OR failure), the handle is no longer
    /// valid — a subsequent `tx_*` call surfaces
    /// `[transaction] unknown tx handle`.
    ///
    /// # Errors
    ///
    /// Returns `[transaction]` with `unknown tx handle` if the handle
    /// is unknown, or propagates the underlying op error verbatim
    /// (typed `[schema]`, `[conflict]`, `[storage]`, …).
    #[napi(js_name = "commitWriteTxn")]
    pub async fn commit_write_txn(&self, tx_handle: i64) -> napi::Result<()> {
        // Remove the state first so the registry guard drops before we
        // spawn_blocking onto the redb write path. A failed replay
        // still consumes the handle (txn already aborted; caller must
        // begin a new one).
        let state = {
            let mut guard = self.tx_states.lock().map_err(|_| {
                napi::Error::from_reason("[transaction] tx registry mutex poisoned")
            })?;
            guard.remove(&tx_handle).ok_or_else(|| {
                napi::Error::from_reason(
                    "[transaction] unknown tx handle (already committed/rolled back?)",
                )
            })?
        };
        let WriteTxState {
            db_arc,
            schema,
            ops,
        } = state;
        tokio::task::spawn_blocking(move || -> Result<(), NookError> {
            db_arc.write(|tx| {
                for op in &ops {
                    match op {
                        PendingOp::Insert {
                            collection,
                            doc_json,
                        } => {
                            // Parse + validate + write inside the txn so
                            // a bad doc aborts the whole replay.
                            let doc: serde_json::Value =
                                serde_json::from_str(doc_json).map_err(|e| NookError::Schema {
                                    msg: format!("invalid document JSON: {e}"),
                                })?;
                            let c = Collection::new(&db_arc, &schema, collection)?;
                            c.insert_in_tx(tx, &doc)?;
                        }
                        PendingOp::DeleteMany {
                            collection,
                            filter_json,
                        } => {
                            let filter: serde_json::Value = serde_json::from_str(filter_json)
                                .map_err(|e| NookError::Schema {
                                    msg: format!("invalid filter JSON: {e}"),
                                })?;
                            let c = Collection::new(&db_arc, &schema, collection)?;
                            let _ = c.delete_in_tx(tx, &filter)?;
                        }
                    }
                }
                Ok(())
            })
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)
    }

    /// Discards the in-flight buffer for `txHandle` without writing.
    /// Idempotent only for the FIRST call — a second
    /// `rollback_write_txn` on the same handle surfaces
    /// `[transaction] unknown tx handle`.
    ///
    /// # Errors
    ///
    /// Returns `[transaction]` with `unknown tx handle` if the handle
    /// is unknown.
    #[napi(js_name = "rollbackWriteTxn")]
    // Async signature kept for JS-surface uniformity; the body is a pure
    // in-memory `HashMap::remove` (no awaits).
    #[allow(clippy::unused_async)]
    pub async fn rollback_write_txn(&self, tx_handle: i64) -> napi::Result<()> {
        let mut guard = self
            .tx_states
            .lock()
            .map_err(|_| napi::Error::from_reason("[transaction] tx registry mutex poisoned"))?;
        guard
            .remove(&tx_handle)
            .ok_or_else(|| napi::Error::from_reason("[transaction] unknown tx handle"))?;
        drop(guard);
        Ok(())
    }

    /// Returns a snapshot of the migration-version ledger (the §6b
    /// `Runner`).
    ///
    /// `Runner` needs only the `Database` (no schema), so this works whether
    /// the database was opened via `open` or `openWithSchema`.
    #[napi(js_name = "migrateStatus")]
    pub async fn migrate_status(&self) -> napi::Result<MigrateStatus> {
        let db = self.get_db()?;
        let status = tokio::task::spawn_blocking(move || Runner::new(&db).status())
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)?;
        Ok(MigrateStatus {
            current_version: status.current_version,
            applied_count: clamp_count(status.applied_count),
        })
    }

    /// Records the given migration versions in the ledger via the M2 seam
    /// `Runner` (single-txn read-merge-write, M5a hardened).
    ///
    /// Already-applied versions are silently skipped.
    #[napi(js_name = "migrateRun")]
    pub async fn migrate_run(&self, versions: Vec<u32>) -> napi::Result<()> {
        let db = self.get_db()?;
        tokio::task::spawn_blocking(move || Runner::new(&db).run(&versions))
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)
    }

    /// Returns every distinct collection name observed in the `entries`
    /// table by scanning composite-key prefixes (`{name}\0{user_key}`).
    /// Used by the CLI `inspect` command. Cheap on small DBs; O(N)
    /// on large DBs.
    #[napi(js_name = "listCollectionNames")]
    pub async fn list_collection_names(&self) -> napi::Result<Vec<String>> {
        let db = self.get_db()?;
        let names = tokio::task::spawn_blocking(move || {
            db.read(|tx| {
                let entries = tx.list_entries_raw()?;
                let mut seen = std::collections::BTreeSet::new();
                for (k, _v) in entries {
                    if let Some(pos) = k.iter().position(|b| *b == 0) {
                        if let Ok(name) = std::str::from_utf8(&k[..pos]) {
                            seen.insert(name.to_string());
                        }
                    }
                }
                Ok::<_, nookdb_core::NookError>(seen.into_iter().collect::<Vec<_>>())
            })
        })
        .await
        .map_err(map_join_error)?
        .map_err(map_nook_error)?;
        Ok(names)
    }

    /// Returns the applied migration versions in the order they were
    /// applied. Used by the CLI's `migrate status` command.
    #[napi(js_name = "migrateListApplied")]
    pub async fn migrate_list_applied(&self) -> napi::Result<Vec<u32>> {
        let db = self.get_db()?;
        let list = tokio::task::spawn_blocking(move || Runner::new(&db).list_applied())
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)?;
        Ok(list)
    }

    /// Streams a portable `.nbkp` snapshot to `destPath`. Atomic write
    /// (`.tmp` + fsync + rename). If the DB was opened with a schema,
    /// the schema hash is recorded in the backup header.
    #[napi]
    pub async fn backup(&self, dest_path: String) -> napi::Result<JsBackupStats> {
        let (db, schema) = self.get_db_and_optional_schema()?;
        let schema_hash = schema.as_ref().map(|s| s.schema_hash());
        let path = PathBuf::from(dest_path);
        let stats = tokio::task::spawn_blocking(move || backup_to_path(&db, &path, schema_hash))
            .await
            .map_err(map_join_error)?
            .map_err(map_nook_error)?;
        Ok(JsBackupStats {
            entry_count: i64::try_from(stats.entry_count).unwrap_or(i64::MAX),
            bytes_written: i64::try_from(stats.bytes_written).unwrap_or(i64::MAX),
        })
    }

    /// Restores `srcPath` into this DB per `opts`. The DB's current
    /// schema hash (if any) is forwarded as `current_schema_hash`.
    #[napi]
    pub async fn restore(
        &self,
        src_path: String,
        opts: Option<JsRestoreOptions>,
    ) -> napi::Result<JsRestoreStats> {
        let (db, schema) = self.get_db_and_optional_schema()?;
        let current_schema_hash = schema.as_ref().map(|s| s.schema_hash());
        let opts = opts.unwrap_or(JsRestoreOptions {
            allow_overwrite: None,
            skip_schema_check: None,
        });
        let restore_opts = RestoreOptions {
            allow_overwrite: opts.allow_overwrite.unwrap_or(false),
            skip_schema_check: opts.skip_schema_check.unwrap_or(false),
            current_schema_hash,
        };
        let path = PathBuf::from(src_path);
        let stats =
            tokio::task::spawn_blocking(move || restore_from_path(&db, &path, restore_opts))
                .await
                .map_err(map_join_error)?
                .map_err(map_nook_error)?;
        Ok(JsRestoreStats {
            entry_count: i64::try_from(stats.entry_count).unwrap_or(i64::MAX),
            bytes_read: i64::try_from(stats.bytes_read).unwrap_or(i64::MAX),
        })
    }

    /// Registers a live query on `collection` filtered by `filter_json`.
    ///
    /// Returns `{ subscriptionId, initialJson }`: `initialJson` is the
    /// **synchronously** computed first snapshot envelope
    /// (`{"ok":true,"value":[…]}` | `{"ok":false,"error":"[kind] msg"}`),
    /// and every subsequent recompute (on a matching commit) is pushed
    /// to `on_emit` carrying the same envelope shape. Envelopes are
    /// produced verbatim by core — this surface does not reshape them.
    ///
    /// Requires the database to have been opened via `openWithSchema`
    /// (the reactive engine recomputes via the typed `Collection::find`).
    #[napi]
    pub async fn live(
        &self,
        collection: String,
        filter_json: String,
        options_json: Option<String>,
        // Inline (not the `crate::live::EmitTsfn` alias) so napi-derive's
        // TS codegen resolves it to a proper JS function type in the
        // generated `.d.ts` (an alias identifier would be emitted
        // verbatim and left undefined). Same concrete type as `EmitTsfn`.
        on_emit: ThreadsafeFunction<String, (), String, Status, false>,
    ) -> napi::Result<LiveRegistration> {
        let engine = self.get_live_engine()?;
        let filter: serde_json::Value = serde_json::from_str(&filter_json).map_err(|e| {
            map_nook_error(NookError::Schema {
                msg: format!("invalid filter JSON: {e}"),
            })
        })?;
        let opts = parse_options(options_json)?;
        let sink = Arc::new(TsfnSink::new(on_emit));
        let sink_dyn: Arc<dyn nookdb_core::live::EmitSink> = sink.clone();
        // `register` computes the initial snapshot synchronously via
        // `Collection::find` (a blocking redb read) — run it on the
        // blocking pool like every other typed op so the async runtime
        // isn't stalled.
        let (sub, initial) = tokio::task::spawn_blocking(move || {
            engine.register(&collection, filter, opts, sink_dyn)
        })
        .await
        .map_err(map_join_error)?;
        let id = next_live_id();
        self.live_registry_insert(id.clone(), sub, sink);
        Ok(LiveRegistration {
            subscription_id: id,
            initial_json: initial,
        })
    }

    /// Cancels the live subscription `subscription_id`. Idempotent: an
    /// unknown / already-cancelled id is a no-op.
    #[napi(js_name = "liveCancel")]
    pub fn live_cancel(&self, subscription_id: String) -> napi::Result<()> {
        if let Some((sub, sink)) = self.live_registry_remove(&subscription_id) {
            // Stop emissions immediately (worker may be mid-pass), then
            // drop the core sub through the engine if the db is still
            // open. Dropping `sink` here releases this sink's tsfn ref.
            sink.mark_closed();
            if let Ok(guard) = self.inner.lock() {
                if let Some(engine) = guard.as_ref().and_then(|h| h.live.as_ref()) {
                    engine.cancel(sub);
                }
            }
        }
        Ok(())
    }

    /// Releases the underlying file lock. Subsequent calls return
    /// `[closed] database is closed`.
    ///
    /// `close()` is a "no new operations" gate, not an abort. A call that
    /// already obtained an `Arc` clone via `get_db`/`get_db_and_schema`
    /// (i.e. is mid-flight in `spawn_blocking`) runs to completion; the
    /// underlying `CoreDatabase` (and its file lock) is released only when
    /// the last in-flight operation drops its `Arc` clone.
    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        // Drop the guard before returning to satisfy significant_drop_tightening.
        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("[storage] internal mutex poisoned"))?;
            // Detach every live sub BEFORE releasing the handle: mark
            // each sink closed (so any in-flight worker pass becomes a
            // no-op + the sub is dropped) and cancel its core sub
            // through the still-present engine. Then `*guard = None`
            // drops the `DbHandle` → drops the last `Arc<LiveEngine>`
            // → its `Drop` joins the worker thread and unregisters the
            // reactive observer (graceful complete).
            if let Ok(mut subs) = self.live_subs.lock() {
                if let Some(engine) = guard.as_ref().and_then(|h| h.live.as_ref()) {
                    for (_, (sub, sink)) in subs.drain() {
                        sink.mark_closed();
                        engine.cancel(sub);
                    }
                } else {
                    subs.clear();
                }
            }
            *guard = None;
        }
        Ok(())
    }

    /// Clones the shared `Arc<CoreDatabase>`, or maps `NookError::Closed`
    /// when the database has been closed. Used by the M1 bytes ops and
    /// `migrate_status` (neither needs a schema).
    fn get_db(&self) -> napi::Result<Arc<CoreDatabase>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("[storage] internal mutex poisoned"))?;
        guard
            .as_ref()
            .map(|h| h.db.clone())
            .ok_or_else(|| map_nook_error(NookError::Closed))
    }

    /// Clones the shared `Arc<CoreDatabase>` + optional `Arc<SchemaIr>` for
    /// backup/restore ops. Returns `[closed]` if the database is closed.
    /// Unlike `get_db_and_schema`, this succeeds even when the DB was opened
    /// without a schema (schema will be `None`).
    pub(crate) fn get_db_and_optional_schema(
        &self,
    ) -> napi::Result<(Arc<CoreDatabase>, Option<Arc<SchemaIr>>)> {
        // Clone the whole handle inside one expression so the guard drops
        // immediately (clippy::significant_drop_tightening), mirroring
        // `get_db_and_schema`.
        let handle = self
            .inner
            .lock()
            .map_err(|_| napi::Error::new(Status::GenericFailure, "DB lock poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| napi::Error::new(Status::GenericFailure, "[closed] database closed"))?;
        Ok((handle.db, handle.schema))
    }

    /// Clones the shared `Arc<CoreDatabase>` + `Arc<SchemaIr>` for a typed
    /// op. Returns `[closed]` if the database is closed, or a `[schema]`
    /// error if it was opened via the bytes-only `open` (no schema).
    fn get_db_and_schema(&self) -> napi::Result<(Arc<CoreDatabase>, Arc<SchemaIr>)> {
        // Resolve the whole handle clone in one expression so the guard
        // drops immediately (clippy::significant_drop_tightening), mirroring
        // M1's `get_inner` shape; the schema-absent branch runs lock-free.
        let handle = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("[storage] internal mutex poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| map_nook_error(NookError::Closed))?;
        let schema = handle.schema.ok_or_else(|| {
            map_nook_error(NookError::Schema {
                msg: "database opened without a schema; use open({ schema }) for typed operations"
                    .to_string(),
            })
        })?;
        Ok((handle.db, schema))
    }

    /// Clones the shared `Arc<LiveEngine>` for a `live()` call. Maps
    /// `[closed]` if the database is closed, or `[schema]` if it was
    /// opened via the bytes-only `open` (no schema → no engine) —
    /// exactly mirroring `get_db_and_schema`'s two failure modes.
    fn get_live_engine(&self) -> napi::Result<Arc<LiveEngine>> {
        let handle = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("[storage] internal mutex poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| map_nook_error(NookError::Closed))?;
        handle.live.ok_or_else(|| {
            map_nook_error(NookError::Schema {
                msg: "database opened without a schema; use open({ schema }) for live()"
                    .to_string(),
            })
        })
    }

    /// Records a freshly registered live sub. A poisoned registry lock
    /// drops the entry (the sub stays in core but can never be
    /// `liveCancel`led individually — still cancelled wholesale by
    /// `close()`); this only happens if another holder panicked.
    fn live_registry_insert(&self, id: String, sub: SubId, sink: Arc<TsfnSink>) {
        if let Ok(mut m) = self.live_subs.lock() {
            m.insert(id, (sub, sink));
        }
    }

    /// Removes and returns a live sub by id (for `liveCancel`).
    /// `None` if unknown / already removed (idempotent cancel) or the
    /// registry lock is poisoned.
    fn live_registry_remove(&self, id: &str) -> Option<(SubId, Arc<TsfnSink>)> {
        self.live_subs.lock().ok().and_then(|mut m| m.remove(id))
    }
}

/// Parses a filter JSON string, mapping a parse failure to a `[schema]`
/// error (a malformed query filter is a caller/schema-shaped fault).
fn parse_filter(filter_json: &str) -> napi::Result<serde_json::Value> {
    serde_json::from_str(filter_json).map_err(|e| {
        map_nook_error(NookError::Schema {
            msg: format!("invalid filter JSON: {e}"),
        })
    })
}

/// Decodes the optional `optionsJson` wire payload into core `QueryOptions`.
/// `None`/empty → default. Decode errors map to a typed `[invalid_arg]`.
fn parse_options(options_json: Option<String>) -> napi::Result<nookdb_core::query::QueryOptions> {
    nookdb_core::query::QueryOptions::parse(options_json.as_deref()).map_err(map_nook_error)
}

/// Serialises one document `Value` back to a JSON string. A serialisation
/// failure is mapped to `[corruption]` (the stored/decoded document could
/// not be re-encoded).
fn value_to_json(v: serde_json::Value) -> napi::Result<String> {
    serde_json::to_string(&v).map_err(|e| {
        map_nook_error(NookError::Corruption {
            msg: format!("failed to serialise document: {e}"),
        })
    })
}

/// Serialises a list of documents back to JSON strings.
fn docs_to_json(docs: Vec<serde_json::Value>) -> napi::Result<Vec<String>> {
    docs.into_iter().map(value_to_json).collect()
}

/// Saturating `usize` → `u32` for count-shaped return values (NAPI has no
/// native `usize`; a result set larger than `u32::MAX` cannot occur in
/// M2's single-process model and would saturate rather than wrap).
fn clamp_count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}
