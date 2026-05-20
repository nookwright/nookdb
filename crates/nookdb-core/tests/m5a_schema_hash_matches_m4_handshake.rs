//! S1 — M5a backup header `schema_hash` must equal the M4 handshake hash
//! for the same schema descriptor, bytewise. Locks the pre-1.0 alignment
//! from memory `m5a-schema-hash-shape`.
//!
//! The Rust core has a single `SchemaIr::schema_hash() -> [u8; 32]` function
//! (SHA-256 raw bytes). This test pins that whatever value M4's handshake
//! computes for a descriptor is bytewise-identical to the 32 header bytes
//! M5a's backup format reserves, so the two subsystems can never silently
//! drift even when only one of them is updated.

use nookdb_core::schema::ir::SchemaIr;
use nookdb_core::{backup_to_path, restore_from_path, Database, RestoreOptions};

const DESCRIPTOR: &str = r#"{
  "users": {
    "idField": "id",
    "fields": [
      {"name": "id", "type": "id"},
      {"name": "email", "type": "string", "email": true, "min": 3, "max": 320},
      {"name": "role", "type": "enum", "variants": ["admin", "user"]}
    ],
    "indexes": [{"field": "email", "unique": true}]
  }
}"#;

#[test]
fn m5a_backup_schema_hash_matches_m4_handshake_format() {
    // Compute hash via the public Rust API (what M4 handshake uses).
    let ir = SchemaIr::compile(DESCRIPTOR).unwrap();
    let expected: [u8; 32] = ir.schema_hash();

    let dir = tempfile::tempdir().unwrap();
    let src_db_path = dir.path().join("src.db");
    let snap_path = dir.path().join("snap.nbkp");

    // Write a backup with this schema_hash set.
    let src_db = Database::open(&src_db_path).unwrap();
    src_db
        .write(|tx| tx.put("users", b"alice", b"some-doc"))
        .unwrap();

    let stats = backup_to_path(&src_db, &snap_path, Some(expected)).unwrap();
    assert!(stats.entry_count >= 1);

    // Success path: a restore with the same hash must accept the backup,
    // proving the bytes on disk match what the M4 handshake would produce.
    let dst_db_path = dir.path().join("dst.db");
    let dst_db = Database::open(&dst_db_path).unwrap();
    let restore_stats = restore_from_path(
        &dst_db,
        &snap_path,
        RestoreOptions {
            allow_overwrite: false,
            skip_schema_check: false,
            current_schema_hash: Some(expected),
        },
    )
    .unwrap();
    assert!(restore_stats.entry_count >= 1);

    // Tamper test: a 1-bit-different hash MUST cause restore to reject,
    // proving the bytewise compare is non-vacuous (the success path above
    // wasn't passing just because schema-hash comparison was a no-op).
    let mut tampered = expected;
    tampered[0] ^= 0x01;
    let dst_db_path2 = dir.path().join("dst2.db");
    let dst_db2 = Database::open(&dst_db_path2).unwrap();
    let err = restore_from_path(
        &dst_db2,
        &snap_path,
        RestoreOptions {
            allow_overwrite: false,
            skip_schema_check: false,
            current_schema_hash: Some(tampered),
        },
    )
    .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("schema") || msg.contains("hash"),
        "tampered hash must produce a schema/hash error, got: {msg}",
    );
}
