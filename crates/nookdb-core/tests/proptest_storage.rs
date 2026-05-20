//! Property-based tests for the storage layer.
//!
//! Strategy: generate a random sequence of operations, apply each one
//! both to a real `Database` and to an in-memory reference model
//! (`HashMap<(String, Vec<u8>), Vec<u8>>`). After every operation,
//! assert that observations from the real DB match the model.
//!
//! This file also contains four review-carryover tests (marked
//! "CARRYOVER") that close coverage gaps from Tasks 3 & 4 code
//! reviews.

// The test file uses proptest macros that generate some pedantic/nursery
// warnings. Scope the allow to this file only, not crate-wide.
#![allow(clippy::pedantic)]

use std::collections::HashMap;

use nookdb_core::{Database, NookError, NookErrorKind};
use proptest::prelude::*;
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Operation model (plan verbatim)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Op {
    Put {
        collection: String,
        key: Vec<u8>,
        value: Vec<u8>,
    },
    Get {
        collection: String,
        key: Vec<u8>,
    },
    Delete {
        collection: String,
        key: Vec<u8>,
    },
    List {
        collection: String,
    },
}

/// Generates a collection name composed of ASCII letters + digits, 1-8
/// chars. This stays clear of the `\0` separator and keeps the search
/// space focused on the routing logic, not Unicode edge cases.
fn collection_strategy() -> impl Strategy<Value = String> {
    "[a-z]{1,8}"
}

// 0-length user keys are intentional: encode_key allows empty user keys, so
// the 0..16 range deliberately exercises the empty-key code path.
fn key_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>(), 0..16)
}

fn value_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>(), 0..32)
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        (collection_strategy(), key_strategy(), value_strategy()).prop_map(|(c, k, v)| Op::Put {
            collection: c,
            key: k,
            value: v
        }),
        (collection_strategy(), key_strategy()).prop_map(|(c, k)| Op::Get {
            collection: c,
            key: k
        }),
        (collection_strategy(), key_strategy()).prop_map(|(c, k)| Op::Delete {
            collection: c,
            key: k
        }),
        collection_strategy().prop_map(|c| Op::List { collection: c }),
    ]
}

fn apply_op(
    db: &Database,
    model: &mut HashMap<(String, Vec<u8>), Vec<u8>>,
    op: &Op,
) -> Result<(), TestCaseError> {
    match op {
        Op::Put {
            collection,
            key,
            value,
        } => {
            db.write(|tx| tx.put(collection, key, value))
                .map_err(|e| TestCaseError::fail(format!("put failed: {e}")))?;
            model.insert((collection.clone(), key.clone()), value.clone());
        }
        Op::Get { collection, key } => {
            let observed = db
                .read(|tx| tx.get(collection, key))
                .map_err(|e| TestCaseError::fail(format!("get failed: {e}")))?;
            let expected = model.get(&(collection.clone(), key.clone())).cloned();
            prop_assert_eq!(observed, expected);
        }
        Op::Delete { collection, key } => {
            let observed = db
                .write(|tx| tx.delete(collection, key))
                .map_err(|e| TestCaseError::fail(format!("delete failed: {e}")))?;
            let removed = model.remove(&(collection.clone(), key.clone())).is_some();
            prop_assert_eq!(observed, removed);
        }
        Op::List { collection } => {
            let mut observed = db
                .read(|tx| tx.list_collection(collection))
                .map_err(|e| TestCaseError::fail(format!("list failed: {e}")))?;
            observed.sort();
            let mut expected: Vec<(Vec<u8>, Vec<u8>)> = model
                .iter()
                .filter(|((c, _), _)| c == collection)
                .map(|((_, k), v)| (k.clone(), v.clone()))
                .collect();
            expected.sort();
            prop_assert_eq!(observed, expected);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Plan properties (verbatim from Task 5 plan)
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 64,
        max_shrink_iters: 256,
        ..ProptestConfig::default()
    })]

    /// Storage matches the reference model under random operation sequences.
    #[test]
    fn storage_matches_reference_model(ops in prop::collection::vec(op_strategy(), 0..40)) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("prop.db");
        let db = Database::open(&path).unwrap();
        let mut model: HashMap<(String, Vec<u8>), Vec<u8>> = HashMap::new();
        for op in &ops {
            apply_op(&db, &mut model, op)?;
        }
    }

    /// After a tx ends, the persisted state survives reopen.
    #[test]
    fn state_survives_reopen(
        ops in prop::collection::vec(op_strategy(), 0..30),
    ) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("reopen.db");
        let mut model: HashMap<(String, Vec<u8>), Vec<u8>> = HashMap::new();
        {
            let db = Database::open(&path).unwrap();
            for op in &ops {
                apply_op(&db, &mut model, op)?;
            }
        } // drop closes
        let db = Database::open(&path).unwrap();
        // Note: we only verify surviving keys read back. Deleted keys were already
        // removed from the reference model by apply_op, so they aren't checked here
        // (this mirrors the plan's prescribed body; a targeted delete-persists-across-
        // reopen test would be additive, tracked for a later task).
        for ((collection, key), expected) in &model {
            let observed = db
                .read(|tx| tx.get(collection, key))
                .map_err(|e: NookError| TestCaseError::fail(format!("read failed: {e}")))?;
            prop_assert_eq!(observed.as_ref(), Some(expected));
        }
    }
}

// ---------------------------------------------------------------------------
// CARRYOVER (a)+(b): Collection-prefix exclusion — both adversarial pairs
//
// Verifies that entries of one collection NEVER appear in another
// collection's list_collection, for prefix-related name pairs where one
// name is a strict ASCII prefix of the other.
// ---------------------------------------------------------------------------

/// Helper: put a set of key→value pairs into a collection, then assert
/// `list_collection` for THAT collection returns exactly those pairs and
/// nothing else, and `get` of those keys under a DIFFERENT (related)
/// collection returns None.
fn assert_prefix_isolation(
    db: &Database,
    coll_a: &str,
    entries_a: &[(&[u8], &[u8])],
    coll_b: &str,
    entries_b: &[(&[u8], &[u8])],
) {
    // Insert all entries for both collections.
    db.write(|tx| {
        for (k, v) in entries_a {
            tx.put(coll_a, k, v)?;
        }
        for (k, v) in entries_b {
            tx.put(coll_b, k, v)?;
        }
        Ok(())
    })
    .expect("write should succeed");

    // list_collection(coll_a) must return exactly entries_a.
    let mut got_a = db
        .read(|tx| tx.list_collection(coll_a))
        .expect("list_collection(coll_a) should succeed");
    got_a.sort();
    let mut want_a: Vec<(Vec<u8>, Vec<u8>)> = entries_a
        .iter()
        .map(|(k, v)| (k.to_vec(), v.to_vec()))
        .collect();
    want_a.sort();
    assert_eq!(
        got_a, want_a,
        "list_collection({coll_a:?}) must return exactly its own entries"
    );

    // list_collection(coll_b) must return exactly entries_b.
    let mut got_b = db
        .read(|tx| tx.list_collection(coll_b))
        .expect("list_collection(coll_b) should succeed");
    got_b.sort();
    let mut want_b: Vec<(Vec<u8>, Vec<u8>)> = entries_b
        .iter()
        .map(|(k, v)| (k.to_vec(), v.to_vec()))
        .collect();
    want_b.sort();
    assert_eq!(
        got_b, want_b,
        "list_collection({coll_b:?}) must return exactly its own entries"
    );

    // get of coll_a keys under coll_b must return None.
    for (k, _) in entries_a {
        let got = db
            .read(|tx| tx.get(coll_b, k))
            .expect("cross-collection get should succeed");
        assert!(
            got.is_none(),
            "get({coll_b:?}, key from {coll_a:?}) must return None, got {got:?}"
        );
    }

    // get of coll_b keys under coll_a must return None.
    for (k, _) in entries_b {
        let got = db
            .read(|tx| tx.get(coll_a, k))
            .expect("cross-collection get should succeed");
        assert!(
            got.is_none(),
            "get({coll_a:?}, key from {coll_b:?}) must return None, got {got:?}"
        );
    }
}

/// CARRYOVER (a): "users" vs "usersx" — one name has the other as a strict
/// prefix (the longer name has extra chars after the prefix).
///
/// Keys are deliberately disjoint between the two collections so that the
/// cross-collection `get` check tests genuine codec isolation (not merely
/// whether an identically-named key happens to exist in the other collection).
#[test]
fn collection_prefix_exclusion_users_vs_usersx() {
    let dir = TempDir::new().unwrap();
    let db = Database::open(dir.path().join("a.db")).unwrap();
    assert_prefix_isolation(
        &db,
        "users",
        &[(b"ua1", b"v1"), (b"ua2", b"v2")],
        "usersx",
        &[(b"ux1", b"vx1"), (b"ux3", b"vx3")],
    );
}

/// CARRYOVER (b): "user" vs "users" — "user" is a strict prefix of "users".
///
/// Keys are deliberately disjoint between the two collections (same reason
/// as the test above).
#[test]
fn collection_prefix_exclusion_user_vs_users() {
    let dir = TempDir::new().unwrap();
    let db = Database::open(dir.path().join("b.db")).unwrap();
    assert_prefix_isolation(
        &db,
        "user",
        &[(b"uk1", b"v_user1"), (b"uk2", b"v_user2")],
        "users",
        &[(b"us1", b"v_users1"), (b"us4", b"v_users4")],
    );
}

// ---------------------------------------------------------------------------
// CARRYOVER (c): Real MVCC snapshot isolation with an interleaved committed
// write.
//
// The existing unit test in src/database.rs (read_tx_sees_snapshot_not_later_writes)
// is weak: it never performs an interleaved write while the read transaction
// is still open, so it would pass even on a non-MVCC store.
//
// Here we test REAL interleaving:
//   1. Write ("c", "k") = b"v_old" and commit.
//   2. Open a read transaction (via db.read closure).
//   3. WHILE that read transaction is still open (inside the closure),
//      call db.write(|tx| ...) to commit ("c", "k") = b"v_new".
//      Both db.read and db.write take &self, so this is syntactically
//      valid. redb's MVCC allows a write to begin and commit while a
//      read transaction is open on the same handle (readers do not block
//      writers; the write creates a new snapshot).
//   4. Assert the still-open read transaction still observes b"v_old"
//      (snapshot isolation).
//   5. After the read closure returns, open a new read transaction and
//      assert it observes b"v_new" (the committed write is visible).
// ---------------------------------------------------------------------------

#[test]
fn mvcc_snapshot_isolation_with_interleaved_write() {
    let dir = TempDir::new().unwrap();
    let db = Database::open(dir.path().join("mvcc.db")).unwrap();

    // Step 1: commit v_old.
    db.write(|tx| tx.put("c", b"k", b"v_old")).unwrap();

    // Step 2+3+4: open a read tx; inside the closure, commit a write,
    // then verify the read tx still sees v_old.
    let read_result = db.read(|tx| {
        // Snapshot must see v_old at start of closure.
        let before = tx.get("c", b"k")?;
        assert_eq!(
            before.as_deref(),
            Some(b"v_old" as &[u8]),
            "read tx must see v_old at start of snapshot"
        );

        // Interleaved write: commit v_new while the read tx is still open.
        // db is captured by the closure via the outer scope.
        // redb MVCC: begin_write succeeds even with an open read transaction
        // (writers do not wait for readers; readers do not block writers).
        // IMPORTANT: this works only because no other write transaction spans this db.read() call. Do NOT introduce a write tx around the outer db.read() — the inner db.write() would then block forever on a single thread (redb serializes writers with a blocking mutex, no timeout). Keep this test single-threaded.
        db.write(|wtx| wtx.put("c", b"k", b"v_new"))
            .expect("interleaved write must succeed");

        // Step 4: snapshot must still see v_old (snapshot isolation).
        let after = tx.get("c", b"k")?;
        assert_eq!(
            after.as_deref(),
            Some(b"v_old" as &[u8]),
            "read tx snapshot must not change after interleaved committed write"
        );

        Ok(())
    });
    read_result.unwrap();

    // Step 5: fresh read transaction must see v_new.
    let fresh = db.read(|tx| tx.get("c", b"k")).unwrap();
    assert_eq!(
        fresh.as_deref(),
        Some(b"v_new" as &[u8]),
        "fresh read tx must see v_new after the committed write"
    );
}

// ---------------------------------------------------------------------------
// CARRYOVER (d): Fresh-db bad-collection validation.
//
// On a brand-new, never-written Database (so the internal "entries" redb
// table does not yet exist), a bad collection name must still return
// NookError::InvalidArg, NOT Ok(None) / Ok(empty). The code path that
// handles TableDoesNotExist must validate the collection first.
// ---------------------------------------------------------------------------

#[test]
fn fresh_db_bad_collection_yields_invalid_arg() {
    let dir = TempDir::new().unwrap();
    // Open but never write — the redb table does not exist yet.
    let db = Database::open(dir.path().join("fresh.db")).unwrap();

    // get("") on a fresh db must return InvalidArg, not Ok(None).
    let err = db
        .read(|tx| tx.get("", b"k"))
        .expect_err("get with empty collection must fail");
    assert_eq!(
        err.kind(),
        NookErrorKind::InvalidArg,
        "get(\"\", ...) on fresh db must be InvalidArg, got: {err}"
    );

    // get("bad\0name") on a fresh db must return InvalidArg, not Ok(None).
    let err = db
        .read(|tx| tx.get("bad\0name", b"k"))
        .expect_err("get with null-byte collection must fail");
    assert_eq!(
        err.kind(),
        NookErrorKind::InvalidArg,
        "get(\"bad\\0name\", ...) on fresh db must be InvalidArg, got: {err}"
    );

    // list_collection("") on a fresh db must return InvalidArg, not Ok(vec![]).
    let err = db
        .read(|tx| tx.list_collection(""))
        .expect_err("list_collection with empty collection must fail");
    assert_eq!(
        err.kind(),
        NookErrorKind::InvalidArg,
        "list_collection(\"\") on fresh db must be InvalidArg, got: {err}"
    );

    // list_collection("bad\0name") on a fresh db must return InvalidArg.
    let err = db
        .read(|tx| tx.list_collection("bad\0name"))
        .expect_err("list_collection with null-byte collection must fail");
    assert_eq!(
        err.kind(),
        NookErrorKind::InvalidArg,
        "list_collection(\"bad\\0name\") on fresh db must be InvalidArg, got: {err}"
    );
}
