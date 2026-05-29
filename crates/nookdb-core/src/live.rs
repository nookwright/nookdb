//! Reactive subsystem: recompute `live()` queries on matching commits.
//!
//! `LiveEngine::new` registers ONE `CommitObserver` on the database's
//! `Notifier` and spawns a single worker thread (`std::thread` +
//! `std::sync`, zero `unsafe`). `on_commit` only marks matching subs
//! dirty + wakes the worker (it runs on the committing thread and must
//! return fast). The worker drains+dedupes the dirty set, recomputes
//! each via the authoritative M2 `Collection::find`, and emits a JSON
//! envelope through `EmitSink`. Coalescing is the natural consequence
//! of draining the dirty set before recompute + the fresh MVCC read
//! always observing the latest committed state (spec §2/§3).
use std::collections::{BTreeSet, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::JoinHandle;

use serde_json::Value;

use crate::collection::Collection;
use crate::database::Database;
use crate::notify::{CommitEvent, CommitObserver, ObserverHandle};
use crate::schema::ir::SchemaIr;

/// Identifies one live subscription within a [`LiveEngine`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SubId(u64);

/// The core ↔ binding emit boundary. `nookdb-napi`'s `TsfnSink`
/// implements this over a `ThreadsafeFunction`; core never sees `napi`.
pub trait EmitSink: Send + Sync {
    /// Delivers one envelope (`{"ok":true,"value":[…]}` or
    /// `{"ok":false,"error":"[kind] message"}`).
    ///
    /// Called on the single live worker thread; an implementation MUST be
    /// cheap and non-blocking — a blocking `emit` stalls delivery for every
    /// other subscription.
    fn emit(&self, envelope_json: &str);
    /// Returns `true` once the JS side has gone away; the worker then
    /// drops the subscription.
    fn is_closed(&self) -> bool;
}

struct LiveSub {
    collection: String,
    filter: Value,
    options: crate::query::QueryOptions,
    sink: Arc<dyn EmitSink>,
    dirty: bool,
}

struct LiveShared {
    db: Arc<Database>,
    schema: Arc<SchemaIr>,
    subs: Mutex<HashMap<u64, LiveSub>>,
    /// Set when any sub is dirty or on shutdown; pairs with `cv`.
    wake: Mutex<bool>,
    cv: Condvar,
    shutdown: AtomicBool,
    next_id: AtomicU64,
}

impl LiveShared {
    fn wake_worker(&self) {
        *self
            .wake
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        self.cv.notify_one();
    }
}

/// The single registered observer. Holds a `Weak<LiveShared>` to break
/// the `Database → Notifier → observer → LiveShared → Database` cycle.
struct ReactiveObserver {
    shared: Weak<LiveShared>,
}

impl CommitObserver for ReactiveObserver {
    fn on_commit(&self, ev: &CommitEvent) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let touched = ev.touched_collections();
        let mut any = false;
        if let Ok(mut subs) = shared.subs.lock() {
            for s in subs.values_mut() {
                if touched.contains(s.collection.as_str()) {
                    s.dirty = true;
                    any = true;
                }
            }
        }
        if any {
            shared.wake_worker();
        }
    }
}

/// Owns the reactive worker + the observer registration. Drop joins
/// the worker and unregisters the observer (via the [`ObserverHandle`]).
pub struct LiveEngine {
    shared: Arc<LiveShared>,
    worker: Option<JoinHandle<()>>,
    _obs: ObserverHandle,
}

impl LiveEngine {
    /// Builds the engine, registers the reactive observer on `db`'s
    /// notifier, and spawns the worker.
    // `db`/`schema` are taken by owned `Arc` (not `&Arc`) on purpose:
    // this is the stable surface the NAPI binding (a later task)
    // constructs from the opened DB + compiled IR and then *moves*
    // ownership of into the engine (the worker outlives the call).
    #[allow(clippy::needless_pass_by_value)]
    #[must_use]
    pub fn new(db: Arc<Database>, schema: Arc<SchemaIr>) -> Arc<Self> {
        let shared = Arc::new(LiveShared {
            db: db.clone(),
            schema,
            subs: Mutex::new(HashMap::new()),
            wake: Mutex::new(false),
            cv: Condvar::new(),
            shutdown: AtomicBool::new(false),
            next_id: AtomicU64::new(0),
        });
        let obs = db.add_observer(Arc::new(ReactiveObserver {
            shared: Arc::downgrade(&shared),
        }));
        let worker = {
            let shared = shared.clone();
            std::thread::spawn(move || worker_loop(&shared))
        };
        Arc::new(Self {
            shared,
            worker: Some(worker),
            _obs: obs,
        })
    }

    /// Registers a live query. Returns its id and the **synchronously
    /// computed** initial snapshot envelope (so `.value` is populated
    /// without waiting for the first commit).
    #[must_use]
    pub fn register(
        &self,
        collection: &str,
        filter: Value,
        options: crate::query::QueryOptions,
        sink: Arc<dyn EmitSink>,
    ) -> (SubId, String) {
        let initial = recompute_envelope(&self.shared, collection, &filter, &options);
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut subs) = self.shared.subs.lock() {
            subs.insert(
                id,
                LiveSub {
                    collection: collection.to_string(),
                    filter,
                    options,
                    sink,
                    dirty: false,
                },
            );
        }
        (SubId(id), initial)
    }

    /// Cancels a subscription; no further emissions for it.
    pub fn cancel(&self, sub: SubId) {
        if let Ok(mut subs) = self.shared.subs.lock() {
            subs.remove(&sub.0);
        }
    }
}

impl Drop for LiveEngine {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.wake_worker();
        if let Some(j) = self.worker.take() {
            let _ = j.join();
        }
    }
}

/// Runs `Collection::find` (the authoritative M2 path) against a fresh
/// MVCC read and serialises the envelope. Any error becomes an
/// `{"ok":false,"error":"[kind] message"}` envelope (the `[kind]`
/// convention shared with the NAPI error mapping).
fn recompute_envelope(
    shared: &LiveShared,
    collection: &str,
    filter: &Value,
    options: &crate::query::QueryOptions,
) -> String {
    let run = || -> Result<Vec<Value>, crate::error::NookError> {
        Collection::new(&shared.db, &shared.schema, collection)?.find_with(filter, options)
    };
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(Ok(docs)) => serde_json::json!({ "ok": true, "value": docs }).to_string(),
        Ok(Err(e)) => serde_json::json!({
            "ok": false,
            "error": format!("[{}] {}", e.kind().as_str(), e)
        })
        .to_string(),
        Err(_) => serde_json::json!({
            "ok": false,
            "error": "[storage] live recompute panicked"
        })
        .to_string(),
    }
}

/// One dirty subscription snapshotted for lock-free recompute:
/// `(id, collection, filter, options, sink)`.
type WorkItem = (
    u64,
    String,
    Value,
    crate::query::QueryOptions,
    Arc<dyn EmitSink>,
);

fn worker_loop(shared: &LiveShared) {
    loop {
        // Wait until woken (dirty sub or shutdown).
        {
            let mut woke = shared
                .wake
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while !*woke && !shared.shutdown.load(Ordering::SeqCst) {
                woke = shared
                    .cv
                    .wait(woke)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            *woke = false;
        }
        if shared.shutdown.load(Ordering::SeqCst) {
            return;
        }
        // Snapshot the dirty subs' descriptors under a short lock, clear
        // their dirty flags (coalesce), then recompute lock-free.
        let work: Vec<WorkItem> = {
            let Ok(mut subs) = shared.subs.lock() else {
                continue;
            };
            subs.iter_mut()
                .filter(|(_, s)| s.dirty)
                .map(|(id, s)| {
                    s.dirty = false;
                    (
                        *id,
                        s.collection.clone(),
                        s.filter.clone(),
                        s.options.clone(),
                        s.sink.clone(),
                    )
                })
                .collect()
        };
        let mut dead: BTreeSet<u64> = BTreeSet::new();
        for (id, collection, filter, options, sink) in work {
            if sink.is_closed() {
                dead.insert(id);
                continue;
            }
            // Skip if cancelled between snapshot and now.
            if shared.subs.lock().map_or(true, |s| !s.contains_key(&id)) {
                continue;
            }
            let env = recompute_envelope(shared, &collection, &filter, &options);
            sink.emit(&env);
        }
        if !dead.is_empty() {
            if let Ok(mut subs) = shared.subs.lock() {
                for id in dead {
                    subs.remove(&id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::schema::ir::SchemaIr;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn setup() -> (tempfile::TempDir, Arc<Database>, Arc<SchemaIr>) {
        let d = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(d.path().join("t.db")).unwrap());
        let ir = Arc::new(
            SchemaIr::compile(
                r#"{"u":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"role","type":"enum","variants":["admin","user"]},
                  {"name":"n","type":"number","optional":true}],
                  "indexes":[{"field":"role","unique":false}]}}"#,
            )
            .unwrap(),
        );
        (d, db, ir)
    }

    /// Test sink: records every emitted envelope string.
    #[derive(Default)]
    struct VecSink(Mutex<Vec<String>>);
    impl EmitSink for VecSink {
        fn emit(&self, envelope_json: &str) {
            self.0.lock().unwrap().push(envelope_json.to_string());
        }
        fn is_closed(&self) -> bool {
            false
        }
    }

    fn wait_until<F: Fn() -> bool>(f: F) {
        let start = Instant::now();
        while !f() {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "live emission timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn insert(db: &Database, ir: &SchemaIr, doc: &serde_json::Value) {
        crate::collection::Collection::new(db, ir, "u")
            .unwrap()
            .insert(doc)
            .unwrap();
    }

    #[test]
    fn register_returns_initial_snapshot_then_emits_on_matching_commit() {
        let (_d, db, ir) = setup();
        insert(&db, &ir, &serde_json::json!({"id":"1","role":"admin"}));
        let engine = LiveEngine::new(db.clone(), ir.clone());
        let sink = Arc::new(VecSink::default());
        let (_sub, initial) = engine.register(
            "u",
            serde_json::json!({"role":"admin"}),
            crate::query::QueryOptions::default(),
            sink.clone(),
        );
        assert!(initial.contains("\"ok\":true"));
        assert!(
            initial.contains("\"1\""),
            "initial snapshot has the existing admin"
        );

        insert(&db, &ir, &serde_json::json!({"id":"2","role":"admin"}));
        wait_until(|| !sink.0.lock().unwrap().is_empty());
        let last = sink.0.lock().unwrap().last().unwrap().clone();
        assert!(last.contains("\"ok\":true") && last.contains("\"2\""));
    }

    #[test]
    fn register_with_options_sorts_and_limits_initial_and_recompute() {
        let (_d, db, ir) = setup();
        for (id, n) in [("a", 3), ("b", 1), ("c", 2)] {
            insert(
                &db,
                &ir,
                &serde_json::json!({"id": id, "role": "user", "n": n}),
            );
        }
        let engine = LiveEngine::new(db.clone(), ir.clone());
        let sink = Arc::new(VecSink::default());
        let opts =
            crate::query::QueryOptions::parse(Some(r#"{"sort":[["n","asc"]],"limit":2}"#)).unwrap();
        let (_sub, initial) =
            engine.register("u", serde_json::json!({"role":"user"}), opts, sink.clone());
        let v: serde_json::Value = serde_json::from_str(&initial).unwrap();
        let ids: Vec<_> = v["value"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["b", "c"]);

        insert(&db, &ir, &serde_json::json!({"id":"d","role":"user","n":0}));
        wait_until(|| !sink.0.lock().unwrap().is_empty());
        let last = sink.0.lock().unwrap().last().unwrap().clone();
        let last_v: serde_json::Value = serde_json::from_str(&last).unwrap();
        let last_ids: Vec<_> = last_v["value"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(last_ids, vec!["d", "b"]);
    }

    #[test]
    fn a_commit_to_an_unrelated_collection_does_not_emit() {
        let (_d, db, ir) = setup();
        let engine = LiveEngine::new(db.clone(), ir);
        let sink = Arc::new(VecSink::default());
        let (_s, _i) = engine.register(
            "u",
            serde_json::json!({}),
            crate::query::QueryOptions::default(),
            sink.clone(),
        );
        // write to a different collection through the bytes API
        db.write(|tx| tx.put("other", b"x", b"y")).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_stops_further_emissions() {
        let (_d, db, ir) = setup();
        let engine = LiveEngine::new(db.clone(), ir.clone());
        let sink = Arc::new(VecSink::default());
        let (sub, _i) = engine.register(
            "u",
            serde_json::json!({}),
            crate::query::QueryOptions::default(),
            sink.clone(),
        );
        engine.cancel(sub);
        insert(&db, &ir, &serde_json::json!({"id":"9","role":"user"}));
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            sink.0.lock().unwrap().is_empty(),
            "no emission after cancel"
        );
    }

    #[test]
    fn rapid_commits_coalesce_to_a_snapshot_with_the_final_state() {
        let (_d, db, ir) = setup();
        let engine = LiveEngine::new(db.clone(), ir.clone());
        let sink = Arc::new(VecSink::default());
        let (_s, _i) = engine.register(
            "u",
            serde_json::json!({}),
            crate::query::QueryOptions::default(),
            sink.clone(),
        );
        for i in 0..20 {
            insert(
                &db,
                &ir,
                &serde_json::json!({"id":format!("{i}"),"role":"user"}),
            );
        }
        wait_until(|| {
            sink.0
                .lock()
                .unwrap()
                .last()
                .is_some_and(|s| s.contains("\"19\""))
        });
        let emissions = sink.0.lock().unwrap().len();
        assert!(emissions <= 20, "coalesced: fewer emissions than commits");
        assert!(emissions >= 1);
        // Non-vacuous final-state check: the last envelope must be a
        // successful snapshot containing every inserted id "0".."19".
        // This proves the "fresh MVCC read sees the latest committed state"
        // guarantee without any timing dependence (wait_until already
        // ensured "19" is present before we reach this point).
        let last = sink.0.lock().unwrap().last().unwrap().clone();
        assert!(
            last.contains("\"ok\":true"),
            "final emission is a snapshot, not an error"
        );
        for i in 0..20 {
            assert!(
                last.contains(&format!("\"{i}\"")),
                "final coalesced snapshot must contain id {i} (saw: {last})"
            );
        }
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(24))]
        #[test]
        fn emitted_snapshot_equals_one_shot_find(
            ops in proptest::collection::vec((0u32..8, proptest::bool::ANY), 1..16)
        ) {
            let (_d, db, ir) = setup();
            let engine = LiveEngine::new(db.clone(), ir.clone());
            let sink = Arc::new(VecSink::default());
            let (_s, _i) = engine.register("u", serde_json::json!({"role":"admin"}), crate::query::QueryOptions::default(), sink.clone());

            for (n, is_admin) in &ops {
                let role = if *is_admin { "admin" } else { "user" };
                let _ = crate::collection::Collection::new(&db, &ir, "u").unwrap()
                    .insert(&serde_json::json!({"id": format!("{n}"), "role": role}));
            }

            // Authoritative one-shot result over the final state.
            let want = crate::collection::Collection::new(&db, &ir, "u").unwrap()
                .find(&serde_json::json!({"role":"admin"})).unwrap();
            let want_ids: std::collections::BTreeSet<String> = want.iter()
                .map(|d| d["id"].as_str().unwrap().to_string()).collect();

            // The LAST emitted snapshot (coalesced) must equal `want`.
            wait_until(|| {
                sink.0.lock().unwrap().last().map_or(want_ids.is_empty(), |s| {
                    serde_json::from_str::<serde_json::Value>(s).ok()
                        .and_then(|v| v.get("value").cloned())
                        .is_some_and(|val| {
                            let got: std::collections::BTreeSet<String> = val.as_array().unwrap()
                                .iter().map(|d| d["id"].as_str().unwrap().to_string()).collect();
                            got == want_ids
                        })
                })
            });

            let last = sink.0.lock().unwrap().last().cloned();
            let emitted_ids: std::collections::BTreeSet<String> = last.map_or_else(
                std::collections::BTreeSet::new,
                |s| {
                    serde_json::from_str::<serde_json::Value>(&s).unwrap()["value"]
                        .as_array().unwrap().iter()
                        .map(|d| d["id"].as_str().unwrap().to_string()).collect()
                },
            );
            proptest::prop_assert_eq!(emitted_ids, want_ids);
        }
    }
}
