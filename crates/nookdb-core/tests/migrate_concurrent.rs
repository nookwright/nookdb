//! Two threads each call `Runner::run` with disjoint version sets. With
//! the M2 implementation that uses separate read+write txns, one of the
//! two `run`s can lost-update the ledger and the final applied list is a
//! subset of {1,2,3,4}. With the M5a single-txn fix, the final list is
//! exactly {1,2,3,4} (in some order).

use std::sync::Arc;

use nookdb_core::migrate::Runner;
use nookdb_core::Database;

#[test]
fn concurrent_run_does_not_lose_updates() {
    // The outer `dir`/`db_path`/`db` are intentionally unused: the spec
    // requires them to appear here (verbatim content) as structural context
    // even though the per-round fresh database is what the test actually uses.
    #[allow(unused_variables)]
    let dir = tempfile::tempdir().unwrap();
    #[allow(unused_variables)]
    let db_path = dir.path().join("ledger.db");
    #[allow(unused_variables)]
    let db = Arc::new(Database::open(&db_path).unwrap());

    // Run several rounds — race window is small; loop amplifies the chance
    // that the pre-fix code lost-updates at least once across the rounds.
    for round in 0..16 {
        // Fresh ledger each round.
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(dir.path().join("l.db")).unwrap());

        let db1 = db.clone();
        let h1 = std::thread::spawn(move || {
            Runner::new(&db1).run(&[1, 2]).unwrap();
        });
        let db2 = db.clone();
        let h2 = std::thread::spawn(move || {
            Runner::new(&db2).run(&[3, 4]).unwrap();
        });
        h1.join().unwrap();
        h2.join().unwrap();

        let mut applied = Runner::new(&db).list_applied().unwrap();
        applied.sort_unstable();
        assert_eq!(applied, vec![1, 2, 3, 4], "lost update in round {round}");
    }
}
