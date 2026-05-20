use nookdb_core::{backup_to_path, restore_from_path, Database, RestoreOptions};

#[test]
fn restore_into_non_empty_db_without_allow_overwrite_fails_with_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let src = Database::open(dir.path().join("src.db")).unwrap();
    src.write(|tx| tx.put("c", b"k", b"snap")).unwrap();
    let snap = dir.path().join("snap.nbkp");
    backup_to_path(&src, &snap, None).unwrap();

    let dst = Database::open(dir.path().join("dst.db")).unwrap();
    dst.write(|tx| tx.put("c", b"k", b"existing")).unwrap();

    let err = restore_from_path(
        &dst,
        &snap,
        RestoreOptions {
            allow_overwrite: false,
            ..Default::default()
        },
    )
    .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("restore target not empty"), "got: {msg}");
}

#[test]
fn restore_with_allow_overwrite_replaces_existing_entries() {
    let dir = tempfile::tempdir().unwrap();
    let src = Database::open(dir.path().join("src.db")).unwrap();
    src.write(|tx| tx.put("c", b"k", b"snap")).unwrap();
    let snap = dir.path().join("snap.nbkp");
    backup_to_path(&src, &snap, None).unwrap();

    let dst = Database::open(dir.path().join("dst.db")).unwrap();
    dst.write(|tx| {
        tx.put("c", b"existing", b"old")?;
        tx.put("c", b"k", b"existing")?;
        Ok(())
    })
    .unwrap();

    restore_from_path(
        &dst,
        &snap,
        RestoreOptions {
            allow_overwrite: true,
            ..Default::default()
        },
    )
    .unwrap();

    dst.read(|tx| {
        assert_eq!(tx.get("c", b"existing")?, None);
        assert_eq!(tx.get("c", b"k")?, Some(b"snap".to_vec()));
        Ok(())
    })
    .unwrap();
}
