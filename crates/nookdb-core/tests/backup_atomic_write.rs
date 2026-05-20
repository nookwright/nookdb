use nookdb_core::{
    backup_to_path, restore_from_path, BackupStats, Database, RestoreOptions, RestoreStats,
};

#[test]
fn backup_to_path_writes_then_renames_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("src.db")).unwrap();
    db.write(|tx| tx.put("c", b"k", b"v")).unwrap();

    let dest = dir.path().join("out.nbkp");
    let stats: BackupStats = backup_to_path(&db, &dest, None).unwrap();
    assert_eq!(stats.entry_count, 1);
    assert!(dest.exists());

    // No leftover .tmp file.
    let tmp = dir.path().join("out.nbkp.tmp");
    assert!(!tmp.exists(), "tmp file should be renamed away");
}

#[test]
fn restore_from_path_replays_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let db_src = Database::open(dir.path().join("src.db")).unwrap();
    db_src
        .write(|tx| {
            tx.put("c", b"k1", b"v1")?;
            tx.put("c", b"k2", b"v2")?;
            Ok(())
        })
        .unwrap();

    let snap = dir.path().join("snap.nbkp");
    backup_to_path(&db_src, &snap, None).unwrap();

    let db_dst = Database::open(dir.path().join("dst.db")).unwrap();
    let stats: RestoreStats = restore_from_path(&db_dst, &snap, RestoreOptions::default()).unwrap();
    assert_eq!(stats.entry_count, 2);

    db_dst
        .read(|tx| {
            assert_eq!(tx.get("c", b"k1")?, Some(b"v1".to_vec()));
            assert_eq!(tx.get("c", b"k2")?, Some(b"v2".to_vec()));
            Ok(())
        })
        .unwrap();
}
