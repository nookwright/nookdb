//! Extension seam acceptance test (M3 — post-commit notifier hook).
//! Verbatim criterion: a passive observer registered alongside a
//! `live()` subscription; one write; the observer receives the commit
//! event AND the `live()` subscriber still receives its update
//! unchanged. PUBLIC CRATE-ROOT PATHS ONLY (external-reachability proof).
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nookdb_core::live::{EmitSink, LiveEngine};
use nookdb_core::schema::ir::SchemaIr;
use nookdb_core::{CommitEvent, CommitObserver, Database};

#[derive(Default)]
struct PassiveObserver(Mutex<Vec<Vec<String>>>);
impl CommitObserver for PassiveObserver {
    fn on_commit(&self, ev: &CommitEvent) {
        self.0.lock().unwrap().push(
            ev.touched_collections()
                .into_iter()
                .map(str::to_string)
                .collect(),
        );
    }
}

#[derive(Default)]
struct RecordingSink(Mutex<Vec<String>>);
impl EmitSink for RecordingSink {
    fn emit(&self, e: &str) {
        self.0.lock().unwrap().push(e.to_string());
    }
    fn is_closed(&self) -> bool {
        false
    }
}

#[test]
fn passive_observer_and_live_subscriber_both_receive_and_live_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(dir.path().join("seam.db")).unwrap());
    let schema = Arc::new(
        SchemaIr::compile(
            r#"{"u":{"idField":"id","fields":[
              {"name":"id","type":"id"},{"name":"role","type":"enum","variants":["admin","user"]}],
              "indexes":[]}}"#,
        )
        .unwrap(),
    );

    // A `live()` subscription (the reactive path).
    let engine = LiveEngine::new(db.clone(), schema.clone());
    let sink = Arc::new(RecordingSink::default());
    let (_sub, initial) = engine.register(
        "u",
        serde_json::json!({"role":"admin"}),
        nookdb_core::query::QueryOptions::default(),
        sink.clone(),
    );
    assert!(initial.contains("\"ok\":true"));

    // A PASSIVE observer attached through the public seam, alongside it.
    let passive = Arc::new(PassiveObserver::default());
    let _h = db.add_observer(passive.clone());

    // One write.
    nookdb_core::collection::Collection::new(&db, &schema, "u")
        .unwrap()
        .insert(&serde_json::json!({"id":"1","role":"admin"}))
        .unwrap();

    // The passive observer received the commit event …
    assert_eq!(
        passive.0.lock().unwrap().clone(),
        vec![vec!["u".to_string()]]
    );

    // … AND the live subscriber still received its update unchanged.
    let start = Instant::now();
    loop {
        if sink.0.lock().unwrap().iter().any(|s| s.contains("\"1\"")) {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "live update timed out"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let last = sink.0.lock().unwrap().last().unwrap().clone();
    assert!(last.contains("\"ok\":true") && last.contains("\"1\""));
}
