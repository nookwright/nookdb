//! `index_entries` table + key codec + maintenance + equality lookup.
//!
//! Index key: `{collection}\0{field}\0{encoded_value}\0{doc_id}` -> `doc_id`.
//! `encoded_value` is a dedicated deterministic encoding per type
//! (independent of the human-readable JSON document form).
//!
//! # Key-uniqueness invariant (load-bearing)
//!
//! The index key uses a single `\0` byte as the field separator and is
//! **not** length-prefixed. As a direct consequence, **`doc_id` MUST NOT
//! contain a `\0` byte**: index-key uniqueness and `lookup_eq`
//! range-exactness both depend on it. Without this guarantee a distinct
//! `(value, doc_id)` pair could serialize to identical key bytes — e.g.
//! `(value="a", doc_id="b\0c")` and `(value="a\0b", doc_id="c")` would
//! both produce `...\0a\0b\0c` — breaking uniqueness and letting the
//! half-open `lookup_eq` range over- or under-match. A future Task-7
//! `doc_id` encoding MUST uphold this NUL-free invariant; it is enforced
//! here by a `debug_assert!` in `key()`.
//!
//! String *field values* that contain an interior `\0` immediately
//! adjacent to the value/`doc_id` boundary can analogously collide with a
//! `\0`-adjacent neighboring value. This is an **accepted M2 limitation**:
//! M2 unique constraints do not rely on that case, and it is not
//! exercised by any test. A robust length-prefixed key encoding that
//! removes both restrictions is tracked as post-M2/M3+ hardening,
//! conditional on whether the Task-7 `doc_id` encoding ever permits a
//! `\0` byte.
use redb::TableDefinition;
use serde_json::Value;

use crate::error::NookError;
use crate::storage::{ReadTx, WriteTx};

pub(crate) const INDEX_ENTRIES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("index_entries");

const SEP: u8 = 0;

/// Deterministic per-type byte encoding of a JSON value for index keys.
///
/// This is intentionally distinct from the human-readable stored
/// document form. Numbers use `serde_json::Number::to_string()`, so
/// `1` and `1.0` encode differently and ordering is lexicographic over
/// the string form rather than numeric — an accepted M2 scope decision
/// (equality lookup only; no numeric-range index in M2).
#[must_use]
pub fn encode_index_value(v: &Value) -> Vec<u8> {
    match v {
        Value::String(s) => s.as_bytes().to_vec(),
        Value::Bool(b) => vec![u8::from(*b)],
        Value::Number(n) => n.to_string().into_bytes(),
        Value::Null => b"\0null".to_vec(),
        other => other.to_string().into_bytes(),
    }
}

fn key(collection: &str, field: &str, enc_val: &[u8], doc_id: &[u8]) -> Vec<u8> {
    debug_assert!(
        !doc_id.contains(&0),
        "index doc_id must be NUL-free: the \\0-delimited, non-length-prefixed \
         index key relies on this for uniqueness and lookup_eq range-exactness",
    );
    let mut k =
        Vec::with_capacity(collection.len() + field.len() + enc_val.len() + doc_id.len() + 3);
    k.extend_from_slice(collection.as_bytes());
    k.push(SEP);
    k.extend_from_slice(field.as_bytes());
    k.push(SEP);
    k.extend_from_slice(enc_val);
    k.push(SEP);
    k.extend_from_slice(doc_id);
    k
}

/// Half-open key range `[lo, hi)` selecting exactly the entries whose
/// `{collection}\0{field}\0{enc_val}\0` prefix matches. `hi` reuses the
/// prefix but ends with `SEP + 1` (`\x01`), which sorts immediately
/// after every `...\0{doc_id}` key in the group — the same trick the
/// composite-key codec uses for collection scans.
fn prefix(collection: &str, field: &str, enc_val: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut lo = Vec::with_capacity(collection.len() + field.len() + enc_val.len() + 3);
    lo.extend_from_slice(collection.as_bytes());
    lo.push(SEP);
    lo.extend_from_slice(field.as_bytes());
    lo.push(SEP);
    lo.extend_from_slice(enc_val);
    lo.push(SEP);
    let mut hi = lo.clone();
    // `lo` always ends with the just-pushed `SEP`; replace that final
    // byte with `SEP + 1` to get the exclusive upper bound. Built
    // without `unwrap`/`expect` to stay clippy-clean.
    let last = lo.len() - 1;
    hi[last] = SEP + 1;
    (lo, hi)
}

// Caller must ensure `doc_id` is NUL-free; see module docs.
/// Inserts an index entry mapping `value` to `doc_id` for
/// `(collection, field)`.
///
/// # Errors
///
/// Returns `NookError::Storage` on underlying failure.
pub fn put_index_entry(
    tx: &mut WriteTx<'_>,
    collection: &str,
    field: &str,
    value: &Value,
    doc_id: &[u8],
) -> Result<(), NookError> {
    let k = key(collection, field, &encode_index_value(value), doc_id);
    tx.index_put(&k, doc_id)
}

// Caller must ensure `doc_id` is NUL-free; see module docs.
/// Removes the index entry for `(collection, field, value, doc_id)`.
///
/// # Errors
///
/// Returns `NookError::Storage` on underlying failure.
pub fn delete_index_entry(
    tx: &mut WriteTx<'_>,
    collection: &str,
    field: &str,
    value: &Value,
    doc_id: &[u8],
) -> Result<(), NookError> {
    let k = key(collection, field, &encode_index_value(value), doc_id);
    tx.index_delete(&k)
}

/// Returns all doc ids indexed under `(collection, field)` equal to
/// `value`, in index-key order.
///
/// # Errors
///
/// Returns `NookError::Storage` on underlying failure.
pub fn lookup_eq(
    tx: &ReadTx,
    collection: &str,
    field: &str,
    value: &Value,
) -> Result<Vec<Vec<u8>>, NookError> {
    let (lo, hi) = prefix(collection, field, &encode_index_value(value));
    tx.index_range_values(&lo, &hi)
}

/// Returns `true` if at least one doc is indexed under
/// `(collection, field)` with `value` (used for unique-constraint
/// checks).
///
/// # Errors
///
/// Returns `NookError::Storage` on underlying failure.
pub fn index_value_exists(
    tx: &ReadTx,
    collection: &str,
    field: &str,
    value: &Value,
) -> Result<bool, NookError> {
    Ok(!lookup_eq(tx, collection, field, value)?.is_empty())
}

/// Like [`index_value_exists`], but observes the in-flight write txn.
///
/// Used for the unique-constraint pre-check inside `Collection::insert`:
/// a separate read snapshot would not see prior inserts performed
/// earlier in the same transaction, so two colliding inserts within one
/// txn must still conflict. The composite-key codec stays owned by this
/// module; `WriteTx` only provides a layout-agnostic range scan.
///
/// # Errors
///
/// Returns `NookError::Storage` on underlying failure.
pub fn index_value_exists_writing(
    tx: &WriteTx<'_>,
    collection: &str,
    field: &str,
    value: &Value,
) -> Result<bool, NookError> {
    let (lo, hi) = prefix(collection, field, &encode_index_value(value));
    Ok(!tx.index_range_values(&lo, &hi)?.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use serde_json::json;

    fn db() -> (tempfile::TempDir, Database) {
        let d = tempfile::tempdir().unwrap();
        let db = Database::open(d.path().join("t.db")).unwrap();
        (d, db)
    }

    #[test]
    fn encode_index_value_is_deterministic_per_type() {
        assert_eq!(
            encode_index_value(&json!("ab")),
            encode_index_value(&json!("ab"))
        );
        assert_eq!(encode_index_value(&json!(true)), b"\x01");
        assert_ne!(encode_index_value(&json!(1)), encode_index_value(&json!(2)));
    }

    #[test]
    fn put_then_lookup_returns_doc_ids_and_delete_removes_them() {
        let (_d, db) = db();
        db.write(|tx| {
            put_index_entry(tx, "u", "role", &json!("admin"), b"u1")?;
            put_index_entry(tx, "u", "role", &json!("admin"), b"u2")?;
            put_index_entry(tx, "u", "role", &json!("user"), b"u3")?;
            Ok(())
        })
        .unwrap();
        let mut hits = db
            .read(|tx| lookup_eq(tx, "u", "role", &json!("admin")))
            .unwrap();
        hits.sort();
        assert_eq!(hits, vec![b"u1".to_vec(), b"u2".to_vec()]);
        db.write(|tx| delete_index_entry(tx, "u", "role", &json!("admin"), b"u1"))
            .unwrap();
        let hits2 = db
            .read(|tx| lookup_eq(tx, "u", "role", &json!("admin")))
            .unwrap();
        assert_eq!(hits2, vec![b"u2".to_vec()]);
    }

    #[test]
    fn unique_violation_is_detected() {
        let (_d, db) = db();
        db.write(|tx| put_index_entry(tx, "u", "email", &json!("a@b"), b"u1"))
            .unwrap();
        let dup = db
            .read(|tx| index_value_exists(tx, "u", "email", &json!("a@b")))
            .unwrap();
        assert!(dup);
        let absent = db
            .read(|tx| index_value_exists(tx, "u", "email", &json!("z@z")))
            .unwrap();
        assert!(!absent);
    }

    /// A value that is a byte-prefix of another value must not bleed
    /// across the equality lookup. Indexing `"a"` and `"ab"` under the
    /// same `(collection, field)`, then looking up `"a"`, must return
    /// only the `"a"` doc — proving the trailing `\0` separator makes
    /// `prefix()`'s half-open range exact. A missing/incorrect
    /// separator would let the `"a"` range also span the `"ab"` key.
    #[test]
    fn value_prefix_does_not_cross_match() {
        let (_d, db) = db();
        db.write(|tx| {
            put_index_entry(tx, "u", "name", &json!("a"), b"d_a")?;
            put_index_entry(tx, "u", "name", &json!("ab"), b"d_ab")?;
            Ok(())
        })
        .unwrap();
        let mut for_a = db
            .read(|tx| lookup_eq(tx, "u", "name", &json!("a")))
            .unwrap();
        for_a.sort();
        assert_eq!(for_a, vec![b"d_a".to_vec()]);
        let mut for_ab = db
            .read(|tx| lookup_eq(tx, "u", "name", &json!("ab")))
            .unwrap();
        for_ab.sort();
        assert_eq!(for_ab, vec![b"d_ab".to_vec()]);
    }

    /// A field name that is a byte-prefix of another field name must not
    /// cross-match: `role` and `roles` (same collection, same value)
    /// are distinct index groups thanks to the `\0` after the field
    /// segment.
    #[test]
    fn adjacent_field_names_do_not_bleed() {
        let (_d, db) = db();
        db.write(|tx| {
            put_index_entry(tx, "u", "role", &json!("x"), b"r1")?;
            put_index_entry(tx, "u", "roles", &json!("x"), b"r2")?;
            Ok(())
        })
        .unwrap();
        let mut for_role = db
            .read(|tx| lookup_eq(tx, "u", "role", &json!("x")))
            .unwrap();
        for_role.sort();
        assert_eq!(for_role, vec![b"r1".to_vec()]);
        let mut for_roles = db
            .read(|tx| lookup_eq(tx, "u", "roles", &json!("x")))
            .unwrap();
        for_roles.sort();
        assert_eq!(for_roles, vec![b"r2".to_vec()]);
    }

    // Deliberately NOT covered by a test: the `\0`-in-value collision
    // case described in the module docs (a string field value with an
    // interior `\0` adjacent to the value/doc_id boundary colliding with
    // a `\0`-adjacent neighboring value). It is an accepted M2
    // limitation whose absence of collision depends entirely on the
    // Task-7 `doc_id` encoding upholding the NUL-free invariant
    // (enforced by the `debug_assert!` in `key()`). Writing a test here
    // would either assert the buggy colliding behavior or duplicate the
    // NUL-free assertion; neither is useful, so this is documented
    // rather than tested.
}
