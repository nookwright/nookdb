//! Crash-test worker.
//!
//! Opens the DB at `argv[1]` and writes (`worker/<i>`, `v_old`) then
//! immediately overwrites with `v_new` in an infinite loop. Designed
//! to be killed mid-execution by `tests/crash_safety.rs`.
//!
//! On every iteration, the worker uses two separate write transactions
//! so the kill can land in the gap between them (testing partial
//! crash) or during a commit's fsync (testing torn-write resistance).

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: crash_worker <db-path>");
        return ExitCode::from(2);
    };
    let path = PathBuf::from(arg);
    let db = match nookdb_core::Database::open(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("worker: open failed: {e}");
            return ExitCode::from(3);
        }
    };

    let mut i: u32 = 0;
    loop {
        let key_string = i.to_string();
        let key_bytes = key_string.as_bytes();

        if let Err(e) = db.write(|tx| tx.put("worker", key_bytes, b"v_old")) {
            eprintln!("worker: put v_old failed: {e}");
            return ExitCode::from(4);
        }
        if let Err(e) = db.write(|tx| tx.put("worker", key_bytes, b"v_new")) {
            eprintln!("worker: put v_new failed: {e}");
            return ExitCode::from(5);
        }

        i = i.wrapping_add(1);
    }
}
