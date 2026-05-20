//! Kill-9 crash-safety test.
//!
//! Spawns the `crash_worker` binary against a temp DB, kills it mid-flight,
//! reopens the DB, and asserts every observed value is `v_old` or `v_new`
//! (no torn writes, no garbage), and every key parses as a `u32`.

// The test file uses serial_test macros that may generate pedantic/nursery
// warnings. Scope the allow to this file only, not crate-wide.
#![allow(clippy::pedantic)]

use std::process::{Command, Stdio};
use std::time::Duration;

use serial_test::serial;
use tempfile::TempDir;

/// Reopens the database after the worker was hard-killed, tolerating the
/// brief window during which Windows has not yet released the killed
/// process's file lock.
///
/// Retries ONLY while the error kind is `Storage` (which is what a
/// still-held file lock / "database already open" maps to) and only
/// within a bounded deadline. ANY other error kind — crucially
/// `Corruption` — panics IMMEDIATELY: a corruption after a crash is a
/// real ACID-violation defect and must never be retried/masked. If the
/// deadline elapses while still failing, we panic with the last error
/// (a persistent Storage failure is also a real failure, not masked).
fn open_after_kill(db_path: &std::path::Path) -> nookdb_core::Database {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(2000);
    loop {
        match nookdb_core::Database::open(db_path) {
            Ok(db) => return db,
            Err(e) => {
                assert_eq!(
                    e.kind(),
                    nookdb_core::NookErrorKind::Storage,
                    "post-kill reopen failed with a non-Storage error \
                     (kind={:?}); a corruption/integrity failure after a \
                     crash is a REAL defect and must not be retried: {e}",
                    e.kind(),
                );
                if Instant::now() >= deadline {
                    panic!(
                        "db did not reopen within deadline after worker kill; \
                         last error (kind=Storage): {e}"
                    );
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[test]
#[serial]
fn database_survives_kill_9_mid_write() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("crash.db");

    let worker_exe = env!("CARGO_BIN_EXE_crash_worker");

    let mut child = Command::new(worker_exe)
        .arg(&db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn crash_worker");

    // Efficacy-critical: do NOT shorten. The worker must commit many entries
    // BEFORE the kill, or the integrity assertions become vacuous (0 entries).
    // Empirically ~100+ entries at 500ms.
    std::thread::sleep(Duration::from_millis(500));

    child.kill().expect("kill worker");
    // Reap the child; its exit status is irrelevant — the kill was unconditional.
    // Handle release is handled by open_after_kill's bounded retry.
    let _ = child.wait();

    // Reopen and verify integrity.
    let db = open_after_kill(&db_path);

    db.read(|tx| {
        let entries = tx.list_collection("worker")?;
        // Worker writes at least once if it ran. Empty is suspicious
        // but not strictly an integrity failure — accept it but warn.
        if entries.is_empty() {
            // Should not occur with the 500ms window (empirically ~100+ entries).
            // If this ever fires consistently in CI, investigate worker startup/spawn
            // latency — do NOT just lengthen blindly.
            eprintln!("warning: worker produced 0 entries before kill");
        }
        for (key, value) in entries {
            // Value must be one of the two intended values.
            assert!(
                value == b"v_old" || value == b"v_new",
                "corrupted value at key={:?}: {:?}",
                String::from_utf8_lossy(&key),
                value,
            );
            // Key must be a valid u32 string.
            let key_str =
                std::str::from_utf8(&key).unwrap_or_else(|_| panic!("non-utf8 key: {key:?}"));
            key_str
                .parse::<u32>()
                .unwrap_or_else(|_| panic!("non-u32 key: {key_str:?}"));
        }
        Ok(())
    })
    .expect("read after crash");
}

#[test]
#[serial]
fn database_survives_three_consecutive_kills() {
    // Hammer test: open, run, kill, reopen, repeat. Three iterations is
    // enough to catch a class of bugs where the first kill happens to
    // miss a write-in-progress but subsequent ones don't.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("hammer.db");
    let worker_exe = env!("CARGO_BIN_EXE_crash_worker");

    for round in 0..3 {
        let mut child = Command::new(worker_exe)
            .arg(&db_path)
            // Hammer test: worker output is discarded; test1 captures diagnostics.
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn crash_worker");
        // Efficacy-critical: do NOT shorten. 300ms ×3 rounds is the
        // budget-conscious choice; still lands during active writes.
        // The worker must commit many entries BEFORE the kill, or the
        // integrity assertions become vacuous (0 entries).
        std::thread::sleep(Duration::from_millis(300));
        child.kill().expect("kill worker");
        // Reap the child; its exit status is irrelevant — the kill was unconditional.
        // Handle release is handled by open_after_kill's bounded retry.
        let _ = child.wait();

        let db = open_after_kill(&db_path);
        db.read(|tx| {
            let entries = tx.list_collection("worker")?;
            for (key, value) in entries {
                assert!(
                    value == b"v_old" || value == b"v_new",
                    "round {round}: corrupted value at key={:?}: {:?}",
                    String::from_utf8_lossy(&key),
                    value,
                );
            }
            Ok(())
        })
        .unwrap_or_else(|e| panic!("round {round}: read failed: {e}"));
        // Database `db` drops here, releasing the lock so the next round can open.
    }
}
