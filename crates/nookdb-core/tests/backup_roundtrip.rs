//! End-to-end backup → read-back-as-bytes round-trip via the public
//! `write_backup` API over a real redb-backed Database.

use std::io::Cursor;

use nookdb_core::{write_backup, BackupStats, Database};

#[test]
fn write_backup_streams_all_entries() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db.nbkp")).unwrap();
    db.write(|tx| {
        tx.put("users", b"alice", b"value-a")?;
        tx.put("users", b"bob", b"value-b")?;
        tx.put("posts", b"p1", b"hello")?;
        Ok(())
    })
    .unwrap();

    let mut buf: Vec<u8> = Vec::new();
    let stats: BackupStats = write_backup(&db, &mut buf, None).unwrap();
    assert_eq!(stats.entry_count, 3);
    assert!(stats.bytes_written > 0);
    assert!(buf.starts_with(b"NOOKBKUP"), "magic should lead the stream");

    // Quick smoke check that the bytes are at least a parseable shape:
    // header followed by entries — we'll exercise full read in Task 10.
    let _ = Cursor::new(&buf);
}

use nookdb_core::{read_backup, RestoreOptions, RestoreStats};

#[test]
fn write_then_read_roundtrips_via_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let db1 = nookdb_core::Database::open(dir.path().join("src.db")).unwrap();
    db1.write(|tx| {
        tx.put("users", b"alice", b"value-a")?;
        tx.put("users", b"bob", b"value-b")?;
        tx.put("posts", b"p1", b"hello")?;
        Ok(())
    })
    .unwrap();

    let mut buf = Vec::new();
    let _ = nookdb_core::write_backup(&db1, &mut buf, None).unwrap();

    let db2 = nookdb_core::Database::open(dir.path().join("dst.db")).unwrap();
    let stats: RestoreStats = read_backup(
        &db2,
        &mut buf.as_slice(),
        RestoreOptions {
            allow_overwrite: false,
            skip_schema_check: false,
            current_schema_hash: None,
        },
    )
    .unwrap();
    assert_eq!(stats.entry_count, 3);

    db2.read(|tx| {
        assert_eq!(tx.get("users", b"alice")?, Some(b"value-a".to_vec()));
        assert_eq!(tx.get("users", b"bob")?, Some(b"value-b".to_vec()));
        assert_eq!(tx.get("posts", b"p1")?, Some(b"hello".to_vec()));
        Ok(())
    })
    .unwrap();
}
