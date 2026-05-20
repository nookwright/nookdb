use nookdb_core::{backup_to_path, restore_from_path, Database, RestoreOptions};

#[test]
fn restore_fails_when_backup_and_current_schema_hashes_differ() {
    let dir = tempfile::tempdir().unwrap();
    let src = Database::open(dir.path().join("src.db")).unwrap();
    src.write(|tx| tx.put("c", b"k", b"v")).unwrap();

    let snap = dir.path().join("snap.nbkp");
    backup_to_path(&src, &snap, Some([0xAA; 32])).unwrap();

    let dst = Database::open(dir.path().join("dst.db")).unwrap();
    let err = restore_from_path(
        &dst,
        &snap,
        RestoreOptions {
            allow_overwrite: false,
            skip_schema_check: false,
            current_schema_hash: Some([0xBB; 32]),
        },
    )
    .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("backup schema hash mismatch"), "got: {msg}");
}

#[test]
fn restore_succeeds_when_skip_schema_check_is_true() {
    let dir = tempfile::tempdir().unwrap();
    let src = Database::open(dir.path().join("src.db")).unwrap();
    src.write(|tx| tx.put("c", b"k", b"v")).unwrap();

    let snap = dir.path().join("snap.nbkp");
    backup_to_path(&src, &snap, Some([0xAA; 32])).unwrap();

    let dst = Database::open(dir.path().join("dst.db")).unwrap();
    restore_from_path(
        &dst,
        &snap,
        RestoreOptions {
            allow_overwrite: false,
            skip_schema_check: true,
            current_schema_hash: Some([0xBB; 32]),
        },
    )
    .unwrap();
}

#[test]
fn restore_succeeds_when_either_side_has_no_schema_hash() {
    // backup carries no schema → check is silently skipped.
    let dir = tempfile::tempdir().unwrap();
    let src = Database::open(dir.path().join("src.db")).unwrap();
    src.write(|tx| tx.put("c", b"k", b"v")).unwrap();
    let snap = dir.path().join("snap.nbkp");
    backup_to_path(&src, &snap, None).unwrap();
    let dst = Database::open(dir.path().join("dst.db")).unwrap();
    restore_from_path(
        &dst,
        &snap,
        RestoreOptions {
            allow_overwrite: false,
            skip_schema_check: false,
            current_schema_hash: Some([0xCC; 32]),
        },
    )
    .unwrap();
}
