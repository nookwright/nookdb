//! Typed CRUD/query composing validate + doc codec + index + storage.
use serde_json::Value;

use crate::codec::doc::{decode_document, encode_document, IdentityCodec, ValueCodec};
use crate::database::Database;
use crate::error::NookError;
use crate::index::engine::{
    delete_index_entry, index_value_exists_writing, lookup_eq, put_index_entry,
};
use crate::schema::ir::{CollectionIr, SchemaIr};
use crate::schema::validate::validate_document;
use crate::storage::WriteTx;

/// A typed handle to one collection.
///
/// Validates, stores, and maintains secondary indexes for documents,
/// composing the schema validator, the document codec seam, and the
/// index engine over a single [`Database`]. The Rust core is the sole
/// validation authority (PRD §3); the TS surface applies id/defaults
/// *before* a document reaches `insert`.
pub struct Collection<'a> {
    db: &'a Database,
    ir: &'a CollectionIr,
    name: String,
    /// Identity in M2; the storage value-codec seam point (§6a). Boxed
    /// so an external crate can later inject an alternate codec without
    /// changing this type's shape.
    codec: Box<dyn ValueCodec>,
}

impl<'a> Collection<'a> {
    /// Binds a collection name to its compiled schema IR.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Schema` if `name` is not a collection in
    /// `schema`.
    pub fn new(db: &'a Database, schema: &'a SchemaIr, name: &str) -> Result<Self, NookError> {
        let ir = schema.collection(name).ok_or_else(|| NookError::Schema {
            msg: format!("unknown collection {name:?}"),
        })?;
        Ok(Self {
            db,
            ir,
            name: name.to_string(),
            codec: Box::new(IdentityCodec),
        })
    }

    /// Extracts the id-field value as a string slice.
    ///
    /// # Errors
    ///
    /// Returns `NookError::Schema` if the id field is absent or not a
    /// string.
    fn doc_id<'v>(&self, doc: &'v Value) -> Result<&'v str, NookError> {
        doc.get(&self.ir.id_field)
            .and_then(Value::as_str)
            .ok_or_else(|| NookError::Schema {
                msg: format!("missing id field {:?}", self.ir.id_field),
            })
    }

    /// Returns `true` when `doc` satisfies every field constraint in `filter`.
    ///
    /// Supported operators (M2): bare equality, `$ne`, `$in`, `$nin`,
    /// `$gt`, `$gte`, `$lt`, `$lte`, `$exists`. An empty filter matches all docs.
    fn matches(doc: &Value, filter: &Value) -> bool {
        let Some(fobj) = filter.as_object() else {
            return true;
        };
        fobj.iter().all(|(field, cond)| {
            let actual = doc.get(field);
            match cond {
                Value::Object(ops) if ops.keys().any(|k| k.starts_with('$')) => {
                    ops.iter().all(|(op, want)| match op.as_str() {
                        "$ne" => actual != Some(want),
                        "$exists" => want.as_bool().unwrap_or(true) == actual.is_some(),
                        "$in" => want
                            .as_array()
                            .is_some_and(|a| actual.is_some_and(|v| a.contains(v))),
                        "$nin" => want
                            .as_array()
                            .is_some_and(|a| actual.map_or(true, |v| !a.contains(v))),
                        "$gt" | "$gte" | "$lt" | "$lte" => Self::cmp(actual, op, want),
                        _ => false,
                    })
                }
                _ => actual == Some(cond),
            }
        })
    }

    /// Numeric comparison for `$gt`, `$gte`, `$lt`, `$lte`.
    ///
    /// Returns `false` if either side is not an `f64`-representable number.
    fn cmp(actual: Option<&Value>, op: &str, want: &Value) -> bool {
        let (Some(a), Some(b)) = (actual.and_then(Value::as_f64), want.as_f64()) else {
            return false;
        };
        match op {
            "$gt" => a > b,
            "$gte" => a >= b,
            "$lt" => a < b,
            _ => a <= b,
        }
    }

    /// Fetches and decodes every document in this collection (full scan).
    fn all_docs(&self) -> Result<Vec<Value>, NookError> {
        self.db.read(|tx| {
            let entries = tx.list_collection(&self.name)?;
            entries
                .iter()
                .map(|(_, v)| decode_document(self.ir, v, self.codec.as_ref()))
                .collect()
        })
    }

    /// Returns a candidate set for `filter`, using the id-field fast-path or
    /// an indexed-field equality fast-path when available, otherwise a full scan.
    ///
    /// `find` ALWAYS re-filters the candidate set through `matches`, so fast
    /// paths can only narrow (never produce wrong answers).
    fn candidates(&self, filter: &Value) -> Result<Vec<Value>, NookError> {
        let Some(obj) = filter.as_object() else {
            return self.all_docs();
        };
        // Primary-id equality → single `tx.get`.
        if let Some(Value::String(idv)) = obj.get(&self.ir.id_field) {
            return self.db.read(|tx| {
                Ok(tx
                    .get(&self.name, idv.as_bytes())?
                    .map(|b| decode_document(self.ir, &b, self.codec.as_ref()))
                    .transpose()?
                    .into_iter()
                    .collect())
            });
        }
        // Indexed-field equality (non-operator value) → index lookup then fetch.
        for idx in &self.ir.indexes {
            if let Some(v) = obj.get(&idx.field) {
                if !v.is_object() {
                    let ids = self
                        .db
                        .read(|tx| lookup_eq(tx, &self.name, &idx.field, v))?;
                    return self.db.read(|tx| {
                        ids.iter()
                            .filter_map(|id| tx.get(&self.name, id).transpose())
                            .map(|r| {
                                r.and_then(|b| decode_document(self.ir, &b, self.codec.as_ref()))
                            })
                            .collect()
                    });
                }
            }
        }
        // No fast path available — full scan.
        self.all_docs()
    }

    /// Returns every document in the collection that matches `filter`,
    /// in storage order. Equivalent to `find_with(filter,
    /// &QueryOptions::default())`.
    ///
    /// Operator support (M2): bare equality, `$ne`, `$in`, `$nin`,
    /// `$gt`, `$gte`, `$lt`, `$lte`, `$exists`. An empty filter (`{}`)
    /// returns all documents.
    ///
    /// # Errors
    ///
    /// Storage/corruption errors.
    pub fn find(&self, filter: &Value) -> Result<Vec<Value>, NookError> {
        self.find_with(filter, &crate::query::QueryOptions::default())
    }

    /// Returns documents matching `filter`, then applies `opts`
    /// (schema-typed sort → offset → limit). null/missing sort last;
    /// ties break by id.
    ///
    /// Operator support for `filter` matches [`find`](Self::find).
    ///
    /// # Errors
    ///
    /// Storage/corruption errors; `NookError::Schema` if a sort field is
    /// unknown or non-orderable.
    pub fn find_with(
        &self,
        filter: &Value,
        opts: &crate::query::QueryOptions,
    ) -> Result<Vec<Value>, NookError> {
        let matched: Vec<Value> = self
            .candidates(filter)?
            .into_iter()
            .filter(|d| Self::matches(d, filter))
            .collect();
        opts.apply(matched, &self.ir.id_field, |f| {
            self.ir.field(f).map(|fi| &fi.ty)
        })
    }

    /// Returns the first document matching `filter`, or `None`.
    ///
    /// # Errors
    ///
    /// Storage/corruption errors.
    pub fn find_one(&self, filter: &Value) -> Result<Option<Value>, NookError> {
        self.find_one_with(filter, &crate::query::QueryOptions::default())
    }

    /// `find_one` honoring `opts`: sorts, then returns the first row.
    /// `limit` is forced to 1 internally.
    ///
    /// # Errors
    ///
    /// Storage/corruption errors; sort-field errors as
    /// [`find_with`](Self::find_with).
    pub fn find_one_with(
        &self,
        filter: &Value,
        opts: &crate::query::QueryOptions,
    ) -> Result<Option<Value>, NookError> {
        let mut one = opts.clone();
        one.limit = Some(1);
        Ok(self.find_with(filter, &one)?.into_iter().next())
    }

    /// Returns the number of documents matching `filter`.
    ///
    /// # Errors
    ///
    /// Storage/corruption errors.
    pub fn count(&self, filter: &Value) -> Result<usize, NookError> {
        self.count_with(filter, &crate::query::QueryOptions::default())
    }

    /// `count` honoring `opts`: `sort` is ignored (irrelevant to a count);
    /// `offset`/`limit` cap the returned count ("are there at most N?").
    ///
    /// # Errors
    ///
    /// Storage/corruption errors.
    pub fn count_with(
        &self,
        filter: &Value,
        opts: &crate::query::QueryOptions,
    ) -> Result<usize, NookError> {
        let total = self
            .candidates(filter)?
            .into_iter()
            .filter(|d| Self::matches(d, filter))
            .count();
        let after_offset = total.saturating_sub(opts.offset);
        Ok(opts.limit.map_or(after_offset, |l| after_offset.min(l)))
    }

    /// Deletes every document matching `filter`, removing each document and
    /// all of its index entries atomically.
    ///
    /// # Errors
    ///
    /// Storage/corruption errors.
    pub fn delete(&self, filter: &Value) -> Result<usize, NookError> {
        // NOTE(M4): victims are resolved in a READ txn, then removed in a
        // SEPARATE write txn using the find-snapshot's values. Safe under M2's
        // single-process / single-threaded model; a concurrent writer (M4
        // multi-process) could change a row between find and write, mis-deleting
        // an index key. Owner: M4 (or a future single-txn find+delete).
        let victims = self.find(filter)?;
        if victims.is_empty() {
            return Ok(0);
        }
        self.db
            .write(|tx| self.delete_victims_in_tx(tx, &victims))?;
        Ok(victims.len())
    }

    /// Removes a pre-resolved set of `victims` (documents) and their index
    /// entries from the in-flight write transaction `tx`. Intended to be
    /// reused by both the public `delete` (which resolves victims via a
    /// separate read snapshot) and the buffered transactional path in the
    /// NAPI binding (which resolves victims via the latest committed
    /// snapshot at buffer time, see M5c §3.1).
    ///
    /// # Errors
    ///
    /// Storage/corruption errors, or `NookError::Schema` if any victim
    /// document lacks the id field.
    fn delete_victims_in_tx(
        &self,
        tx: &mut WriteTx<'_>,
        victims: &[Value],
    ) -> Result<(), NookError> {
        for d in victims {
            let id = self.doc_id(d)?.as_bytes().to_vec();
            for idx in &self.ir.indexes {
                let v = d.get(&idx.field).cloned().unwrap_or(Value::Null);
                delete_index_entry(tx, &self.name, &idx.field, &v, &id)?;
            }
            tx.delete(&self.name, &id)?;
        }
        Ok(())
    }

    /// Variant of [`Self::delete`] that runs the write phase inside the
    /// caller-supplied [`WriteTx`], so multiple delete ops can share one
    /// transaction (see M5c `db.transaction(cb)` and the NAPI
    /// `tx_delete_many` primitive).
    ///
    /// Victims are still resolved against the latest committed snapshot
    /// via [`Self::find`] BEFORE entering the caller's write txn, then
    /// removed atomically. This mirrors the M2 split-txn shape: read +
    /// write are separate observations even when delete is composed with
    /// other ops in one outer txn (read-after-write inside the same
    /// transaction is M6 retrofit work).
    ///
    /// Returns the number of documents removed.
    ///
    /// # Errors
    ///
    /// Storage/corruption errors, or `NookError::Schema` if any victim
    /// document lacks the id field.
    pub fn delete_in_tx(&self, tx: &mut WriteTx<'_>, filter: &Value) -> Result<usize, NookError> {
        let victims = self.find(filter)?;
        if victims.is_empty() {
            return Ok(0);
        }
        self.delete_victims_in_tx(tx, &victims)?;
        Ok(victims.len())
    }

    /// Validates `doc`, stores it, and maintains every secondary index
    /// atomically. Unique indexes are pre-checked against the in-flight
    /// write transaction so two colliding inserts (even within one txn)
    /// conflict and roll back.
    ///
    /// # Errors
    ///
    /// - `NookError::Schema` — `doc` fails schema validation, or the id
    ///   field is missing/not a string.
    /// - `NookError::InvalidArg` — the id contains a `\0` byte (the
    ///   `\0`-delimited index key requires a NUL-free `doc_id`; see
    ///   [`crate::index::engine`]).
    /// - `NookError::Conflict` — a unique-index value already exists;
    ///   the whole transaction is rolled back.
    /// - storage errors propagated from the write transaction.
    pub fn insert(&self, doc: &Value) -> Result<(), NookError> {
        validate_document(self.ir, doc)?;
        let id_str = self.doc_id(doc)?;
        // Uphold the index engine's NUL-free `doc_id` invariant at the
        // boundary. The `\0`-delimited, non-length-prefixed index key
        // (and `lookup_eq`'s range-exactness) depend on it; in release
        // builds the engine's `debug_assert!` is absent, so a `\0` id
        // would otherwise silently collide. Mirrors the existing
        // collection-name NUL rejection in `crate::codec::encode_key`.
        if id_str.contains('\0') {
            return Err(NookError::InvalidArg {
                msg: format!(
                    "id field {:?} must not contain a NUL byte",
                    self.ir.id_field
                ),
            });
        }
        let id = id_str.as_bytes().to_vec();
        let bytes = encode_document(self.ir, doc, self.codec.as_ref())?;
        self.db
            .write(|tx| self.insert_validated_in_tx(tx, doc, &id, &bytes))
    }

    /// Performs the in-txn write portion of [`Self::insert`] against the
    /// caller-supplied [`WriteTx`]. Validation, id extraction, and
    /// document encoding have already run; this method only does the
    /// unique pre-check + `tx.put` + index maintenance against `tx`.
    fn insert_validated_in_tx(
        &self,
        tx: &mut WriteTx<'_>,
        doc: &Value,
        id: &[u8],
        bytes: &[u8],
    ) -> Result<(), NookError> {
        // NOTE(M3+): reading the in-flight write txn here also guarantees
        // that two unique-colliding inserts within ONE `db.write` conflict.
        for idx in &self.ir.indexes {
            if idx.unique {
                let v = doc.get(&idx.field).cloned().unwrap_or(Value::Null);
                // Observe THIS write txn's view (not a read
                // snapshot) so two inserts in one txn still conflict.
                if index_value_exists_writing(tx, &self.name, &idx.field, &v)? {
                    return Err(NookError::Conflict {
                        msg: format!("{}.{} duplicate", self.name, idx.field),
                    });
                }
            }
        }
        tx.put(&self.name, id, bytes)?;
        for idx in &self.ir.indexes {
            let v = doc.get(&idx.field).cloned().unwrap_or(Value::Null);
            put_index_entry(tx, &self.name, &idx.field, &v, id)?;
        }
        Ok(())
    }

    /// Variant of [`Self::insert`] that runs the validation + index
    /// maintenance + storage write inside the caller-supplied
    /// [`WriteTx`], so multiple insert ops can share one transaction
    /// (see M5c `db.transaction(cb)` and the NAPI `tx_insert`
    /// primitive). Same semantics as `insert`, including the
    /// in-transaction unique pre-check that catches two colliding
    /// inserts buffered into one outer txn.
    ///
    /// # Errors
    ///
    /// Same as [`Self::insert`].
    pub fn insert_in_tx(&self, tx: &mut WriteTx<'_>, doc: &Value) -> Result<(), NookError> {
        validate_document(self.ir, doc)?;
        let id_str = self.doc_id(doc)?;
        if id_str.contains('\0') {
            return Err(NookError::InvalidArg {
                msg: format!(
                    "id field {:?} must not contain a NUL byte",
                    self.ir.id_field
                ),
            });
        }
        let id = id_str.as_bytes().to_vec();
        let bytes = encode_document(self.ir, doc, self.codec.as_ref())?;
        self.insert_validated_in_tx(tx, doc, &id, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::schema::ir::SchemaIr;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, Database, SchemaIr) {
        let d = tempfile::tempdir().unwrap();
        let db = Database::open(d.path().join("t.db")).unwrap();
        let ir = SchemaIr::compile(
            r#"{"u":{"idField":"id","fields":[
          {"name":"id","type":"id"},{"name":"email","type":"string"},
          {"name":"role","type":"enum","variants":["admin","user"]}],
          "indexes":[{"field":"email","unique":true},{"field":"role","unique":false}]}}"#,
        )
        .unwrap();
        (d, db, ir)
    }

    #[test]
    fn insert_validates_stores_and_indexes() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        c.insert(&json!({"id":"1","email":"a@b","role":"admin"}))
            .unwrap();
        let stored = db.read(|tx| tx.get("u", b"1")).unwrap().unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&stored).is_ok());
    }

    #[test]
    fn insert_rejects_invalid_document_with_schema_error() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        let e = c
            .insert(&json!({"id":"1","email":"a@b","role":"ghost"}))
            .unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Schema);
    }

    #[test]
    fn unique_index_violation_is_conflict_and_rolls_back() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        c.insert(&json!({"id":"1","email":"a@b","role":"admin"}))
            .unwrap();
        let e = c
            .insert(&json!({"id":"2","email":"a@b","role":"user"}))
            .unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Conflict);
        assert!(
            db.read(|tx| tx.get("u", b"2")).unwrap().is_none(),
            "rolled back"
        );
    }

    #[test]
    fn insert_rejects_nul_in_id_with_invalid_arg_and_persists_nothing() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        let e = c
            .insert(&json!({"id": "a\u{0}b", "email": "a@b", "role": "admin"}))
            .unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::InvalidArg);
        // The NUL-free doc_id invariant (engine::key debug_assert is compiled
        // out in release) is enforced ONLY by this insert-boundary guard, so
        // a rejected insert must persist nothing.
        assert!(
            db.read(|tx| tx.get("u", b"a\x00b")).unwrap().is_none(),
            "rejected NUL-id insert must not persist an entries row"
        );
    }

    #[test]
    fn find_by_id_index_and_scan_paths() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        c.insert(&json!({"id":"1","email":"a@b","role":"admin"}))
            .unwrap();
        c.insert(&json!({"id":"2","email":"c@d","role":"user"}))
            .unwrap();
        c.insert(&json!({"id":"3","email":"e@f","role":"admin"}))
            .unwrap();

        let one = c.find_one(&json!({"id":"2"})).unwrap().unwrap();
        assert_eq!(one["email"], json!("c@d"));
        let mut admins = c.find(&json!({"role":"admin"})).unwrap();
        admins.sort_by_key(|d| d["id"].as_str().unwrap().to_string());
        assert_eq!(admins.len(), 2);
        let ne = c.find(&json!({"role":{"$ne":"admin"}})).unwrap();
        assert_eq!(ne.len(), 1);
        assert_eq!(c.count(&json!({"role":"admin"})).unwrap(), 2);
        assert_eq!(c.count(&json!({})).unwrap(), 3);
    }

    proptest::proptest! {
        #[test]
        fn index_lookup_matches_full_scan(ids in proptest::collection::vec(0u32..50, 0..20)) {
            let (_d, db, ir) = setup();
            let c = Collection::new(&db, &ir, "u").unwrap();
            for (i, n) in ids.iter().enumerate() {
                let role = if n % 2 == 0 { "admin" } else { "user" };
                let _ = c.insert(&json!({"id":format!("{i}"),
                    "email":format!("e{i}@x"),"role":role}));
            }
            let via_index = c.find(&json!({"role":"admin"})).unwrap().len();
            let via_scan = c.find(&json!({})).unwrap().into_iter()
                .filter(|d| d["role"] == json!("admin")).count();
            proptest::prop_assert_eq!(via_index, via_scan);
        }
    }

    #[test]
    fn delete_removes_docs_and_their_index_entries() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        c.insert(&json!({"id":"1","email":"a@b","role":"admin"}))
            .unwrap();
        c.insert(&json!({"id":"2","email":"c@d","role":"admin"}))
            .unwrap();
        let n = c.delete(&json!({"id":"1"})).unwrap();
        assert_eq!(n, 1);
        assert!(c.find_one(&json!({"id":"1"})).unwrap().is_none());
        let admins = c.find(&json!({"role":"admin"})).unwrap();
        assert_eq!(admins.len(), 1);
        assert_eq!(admins[0]["id"], json!("2"));
        c.insert(&json!({"id":"9","email":"a@b","role":"user"}))
            .unwrap();
    }

    #[test]
    fn delete_by_filter_removes_all_matching_victims_atomically() {
        let (_d, db, ir) = setup();
        let c = Collection::new(&db, &ir, "u").unwrap();
        c.insert(&json!({"id":"1","email":"a@b","role":"admin"}))
            .unwrap();
        c.insert(&json!({"id":"2","email":"c@d","role":"admin"}))
            .unwrap();
        c.insert(&json!({"id":"3","email":"e@f","role":"user"}))
            .unwrap();
        let n = c.delete(&json!({"role":"admin"})).unwrap();
        assert_eq!(n, 2);
        assert!(c.find_one(&json!({"id":"1"})).unwrap().is_none());
        assert!(c.find_one(&json!({"id":"2"})).unwrap().is_none());
        // non-matching doc untouched
        assert!(c.find_one(&json!({"id":"3"})).unwrap().is_some());
        assert_eq!(c.count(&json!({})).unwrap(), 1);
        // both deleted docs' unique emails are freed (index entries removed
        // for every victim, not just the first)
        c.insert(&json!({"id":"10","email":"a@b","role":"user"}))
            .unwrap();
        c.insert(&json!({"id":"11","email":"c@d","role":"user"}))
            .unwrap();
    }

    proptest::proptest! {
        #[test]
        fn delete_keeps_index_consistent_with_live_docs(
            // up to 12 docs; `keep[i]` decides whether doc i survives the delete pass
            roles in proptest::collection::vec(0u8..2, 1..12),
            keep  in proptest::collection::vec(proptest::bool::ANY, 1..12),
        ) {
            let (_d, db, ir) = setup();
            let c = Collection::new(&db, &ir, "u").unwrap();
            let n = roles.len().min(keep.len());
            // insert n docs with distinct ids + distinct unique emails
            for (i, &role_idx) in roles.iter().enumerate().take(n) {
                let role = if role_idx == 0 { "admin" } else { "user" };
                c.insert(&json!({"id": format!("{i}"),
                    "email": format!("e{i}@x"), "role": role})).unwrap();
            }
            // delete the docs where !keep[i]
            for (i, &kept) in keep.iter().enumerate().take(n) {
                if !kept {
                    let removed = c.delete(&json!({"id": format!("{i}")})).unwrap();
                    proptest::prop_assert_eq!(removed, 1);
                }
            }
            // invariant 1: index-path find == scan-path filter for each role (no stale
            // index entry surfaces a deleted doc; no live doc is missed)
            for role in ["admin", "user"] {
                let via_index = c.find(&json!({"role": role})).unwrap().len();
                let via_scan = c.find(&json!({})).unwrap().into_iter()
                    .filter(|d| d["role"] == json!(role)).count();
                proptest::prop_assert_eq!(via_index, via_scan);
                // and equals the actual live count
                let live = roles.iter().zip(keep.iter()).take(n)
                    .filter(|(&r, &k)| k && (if r == 0 { "admin" } else { "user" }) == role)
                    .count();
                proptest::prop_assert_eq!(via_index, live);
            }
            // Invariant 2 is the GENUINE lock on unique-index cleanup (the Task-8
            // carry-forward this proptest exists to enforce): re-inserting a deleted
            // doc's unique email succeeds ONLY if delete physically removed the
            // `index_entries` key (insert's unique pre-check reads it independently
            // of the doc row). Invariant 1 above is a find/scan-equivalence + live-
            // count check and is VACUOUS for detecting a stale entry in isolation
            // (find re-fetches by id; a deleted doc's gone row hides a stale
            // non-unique index entry). Do NOT weaken/remove invariant 2.
            for (i, &kept) in keep.iter().enumerate().take(n) {
                if !kept {
                    c.insert(&json!({"id": format!("r{i}"),
                        "email": format!("e{i}@x"), "role": "user"})).unwrap();
                }
            }
        }
    }

    /// Opens a temp DB with a collection `"u"` that has a numeric field `n`,
    /// for exercising sort/limit/offset query options.
    fn setup_numeric() -> (tempfile::TempDir, Database, SchemaIr) {
        let d = tempfile::tempdir().unwrap();
        let db = Database::open(d.path().join("t.db")).unwrap();
        let ir = SchemaIr::compile(
            r#"{"u":{"idField":"id","fields":[
          {"name":"id","type":"id"},{"name":"n","type":"number"}]}}"#,
        )
        .unwrap();
        (d, db, ir)
    }

    #[test]
    fn find_with_sorts_limits_offsets() {
        let (_d, db, ir) = setup_numeric();
        let c = Collection::new(&db, &ir, "u").unwrap();
        for (id, n) in [("a", 4), ("b", 1), ("c", 3), ("d", 2)] {
            c.insert(&serde_json::json!({"id": id, "n": n})).unwrap();
        }
        let opts = crate::query::QueryOptions::parse(Some(
            r#"{"sort":[["n","asc"]],"offset":1,"limit":2}"#,
        ))
        .unwrap();
        let got = c.find_with(&serde_json::json!({}), &opts).unwrap();
        let ns: Vec<_> = got.iter().map(|d| d["n"].as_i64().unwrap()).collect();
        assert_eq!(ns, vec![2, 3]);
    }

    #[test]
    fn count_with_applies_offset_and_limit_cap() {
        let (_d, db, ir) = setup_numeric();
        let c = Collection::new(&db, &ir, "u").unwrap();
        for (id, n) in [("a", 1), ("b", 2), ("c", 3), ("d", 4)] {
            c.insert(&serde_json::json!({"id": id, "n": n})).unwrap();
        }
        let parse = |s: &str| crate::query::QueryOptions::parse(Some(s)).unwrap();
        let f = serde_json::json!({});
        assert_eq!(
            c.count_with(&f, &crate::query::QueryOptions::default())
                .unwrap(),
            4
        );
        assert_eq!(c.count_with(&f, &parse(r#"{"limit":2}"#)).unwrap(), 2);
        assert_eq!(c.count_with(&f, &parse(r#"{"offset":9}"#)).unwrap(), 0);
        assert_eq!(
            c.count_with(&f, &parse(r#"{"offset":1,"limit":2}"#))
                .unwrap(),
            2
        );
        assert_eq!(c.count_with(&f, &parse(r#"{"limit":0}"#)).unwrap(), 0);
    }
}
