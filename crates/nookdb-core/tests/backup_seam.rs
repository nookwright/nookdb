//! Pre-1.0 extension §M5 — backup/restore via public API only.
//! This test imports ONLY from `nookdb_core::*` (no internal paths) and
//! demonstrates the orchestrator round-trip: create → mutate → restore.

use nookdb_core::{backup_to_path, restore_from_path, Database, RestoreOptions};

#[test]
fn seam_backup_mutate_restore_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("orig.db");
    let backup_path = dir.path().join("snap.nbkp");

    let db = Database::open(&db_path).unwrap();
    db.write(|tx| {
        tx.put("users", b"alice", b"value-a")?;
        tx.put("users", b"bob", b"value-b")?;
        tx.put("posts", b"p1", b"hello")?;
        Ok(())
    })
    .unwrap();

    // Public API: create backup
    let stats = backup_to_path(&db, &backup_path, None).unwrap();
    assert_eq!(stats.entry_count, 3);

    // Mutate
    db.write(|tx| {
        tx.delete("users", b"alice")?;
        tx.put("users", b"charlie", b"value-c")?;
        Ok(())
    })
    .unwrap();

    // Public API: restore (orchestrator contract — explicit allow_overwrite)
    let restore_stats = restore_from_path(
        &db,
        &backup_path,
        RestoreOptions {
            allow_overwrite: true,
            skip_schema_check: false,
            current_schema_hash: None,
        },
    )
    .unwrap();
    assert_eq!(restore_stats.entry_count, 3);

    // Assert DB matches the backup snapshot
    db.read(|tx| {
        assert_eq!(tx.get("users", b"alice")?, Some(b"value-a".to_vec()));
        assert_eq!(tx.get("users", b"bob")?, Some(b"value-b".to_vec()));
        assert_eq!(tx.get("users", b"charlie")?, None);
        assert_eq!(tx.get("posts", b"p1")?, Some(b"hello".to_vec()));
        Ok(())
    })
    .unwrap();
}
