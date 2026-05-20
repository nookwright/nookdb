//! Compiles the JS-side schema descriptor (JSON) into a typed IR.
use std::collections::BTreeMap;

use serde::Deserialize;

use crate::error::NookError;

/// The type tag for a field in the schema IR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldType {
    /// Auto-generated primary-key field.
    Id,
    /// UTF-8 string.
    String,
    /// IEEE-754 double (or integer when `int` is set).
    Number,
    /// Boolean.
    Bool,
    /// Closed set of string variants.
    Enum,
    /// ISO-8601 date/datetime.
    Date,
    /// Homogeneous list of `inner`-typed items (S2d).
    Array(Box<Self>),
}

/// Compiled representation of a single schema field.
// Four independent boolean constraint flags (optional, nullable, int, email)
// cannot be meaningfully collapsed into a state machine; allow the lint.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone)]
pub struct FieldIr {
    /// Field name.
    pub name: String,
    /// Field type tag.
    pub ty: FieldType,
    /// `true` when the field may be absent from a document.
    pub optional: bool,
    /// `true` when the field may hold an explicit `null`.
    pub nullable: bool,
    /// Inclusive lower bound for `Number` fields.
    pub min: Option<f64>,
    /// Inclusive upper bound for `Number` fields.
    pub max: Option<f64>,
    /// Require integer values when `true` (only meaningful for `Number`).
    pub int: bool,
    /// Require RFC 5321 email syntax when `true` (only meaningful for `String`).
    pub email: bool,
    /// Optional regex pattern that string values must match (only meaningful
    /// for `String`/`Id`). The pattern source is fed into `schema_hash` so that
    /// two schemas differing only in regex produce distinct digests.
    pub regex: Option<String>,
    /// Allowed variants for `Enum` fields.
    pub variants: Vec<String>,
}

/// Compiled representation of a secondary index.
#[derive(Debug, Clone)]
pub struct IndexIr {
    /// The indexed field name.
    pub field: String,
    /// Whether the index enforces uniqueness.
    pub unique: bool,
}

/// Compiled representation of one collection in the schema.
#[derive(Debug, Clone)]
pub struct CollectionIr {
    /// Name of the primary-key field (must have type `Id`).
    pub id_field: String,
    /// All fields in declaration order.
    pub fields: Vec<FieldIr>,
    /// Secondary indexes defined on this collection.
    pub indexes: Vec<IndexIr>,
}

impl CollectionIr {
    /// Returns the field with the given name, if it exists.
    #[must_use]
    pub fn field(&self, name: &str) -> Option<&FieldIr> {
        self.fields.iter().find(|f| f.name == name)
    }
}

/// The compiled schema IR — a typed, validated representation of the
/// JS-side schema descriptor object.
#[derive(Debug, Clone)]
pub struct SchemaIr {
    collections: BTreeMap<String, CollectionIr>,
}

// ── Raw serde types (private) ─────────────────────────────────────────────────

// Same rationale as `FieldIr`: four independent constraint flags from JSON.
#[allow(clippy::struct_excessive_bools)]
#[derive(Deserialize)]
struct RawField {
    // When used at top level, the JS surface always emits `name`. When
    // recursed into as the `items` descriptor of an `array` field, the
    // payload is anonymous (the outer field carries the name), so default
    // to empty rather than rejecting the descriptor.
    #[serde(default)]
    name: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    nullable: bool,
    min: Option<f64>,
    max: Option<f64>,
    #[serde(default)]
    int: bool,
    #[serde(default)]
    email: bool,
    #[serde(default)]
    regex: Option<String>,
    #[serde(default)]
    variants: Vec<String>,
    /// Recursive descriptor for `array` item type (S2d).
    items: Option<Box<Self>>,
}

#[derive(Deserialize)]
struct RawIndex {
    field: String,
    #[serde(default)]
    unique: bool,
}

#[derive(Deserialize)]
struct RawCollection {
    #[serde(rename = "idField")]
    id_field: String,
    fields: Vec<RawField>,
    #[serde(default)]
    indexes: Vec<RawIndex>,
}

// ── SchemaIr impl ─────────────────────────────────────────────────────────────

impl SchemaIr {
    /// Parses and validates a JSON schema descriptor, returning a compiled IR.
    ///
    /// # Errors
    ///
    /// Returns [`NookError::Schema`] when:
    /// - the JSON is syntactically invalid,
    /// - a field has an unknown type string,
    /// - a collection does not contain a field whose name matches `idField`
    ///   with type `"id"`, or
    /// - an index targets a field that is `optional`, `nullable`, or absent.
    pub fn compile(descriptor_json: &str) -> Result<Self, NookError> {
        let raw: BTreeMap<String, RawCollection> =
            serde_json::from_str(descriptor_json).map_err(|e| NookError::Schema {
                msg: format!("invalid descriptor: {e}"),
            })?;

        let mut collections = BTreeMap::new();
        for (cname, rc) in raw {
            // `_meta` is the reserved internal collection backing the §6b
            // migration-version ledger (it shares the single M1 `entries`
            // keyspace). A user schema declaring `_meta` would alias the
            // ledger — a data-integrity hazard — so reject it here, at the
            // authoritative compile step, before the typed API can reach it.
            if cname == "_meta" {
                return Err(NookError::Schema {
                    msg: r#"collection name "_meta" is reserved (migration ledger)"#.to_string(),
                });
            }
            let fields = Self::compile_fields(&cname, &rc.fields)?;
            Self::validate_id_field(&cname, &rc.id_field, &fields)?;
            let indexes = Self::compile_indexes(&cname, &rc.indexes, &fields)?;
            collections.insert(
                cname,
                CollectionIr {
                    id_field: rc.id_field,
                    fields,
                    indexes,
                },
            );
        }
        Ok(Self { collections })
    }

    /// Returns the compiled collection with the given name, if present.
    #[must_use]
    pub fn collection(&self, name: &str) -> Option<&CollectionIr> {
        self.collections.get(name)
    }

    /// Returns a release-portable, order-independent SHA-256 digest of this schema.
    ///
    /// Used by the M4 multi-process handshake (bytewise comparison) and the M5a
    /// backup header (raw 32-byte slot). The digest is derived from a
    /// [`BTreeMap`] (sorted key order) over a length-prefixed canonical byte
    /// stream and is consistent for the same logical schema regardless of
    /// caller-side JSON ordering.
    ///
    /// # Panics
    ///
    /// Panics if any string or slice component of the schema — including the
    /// `variants` list or any individual variant string — is longer than
    /// `u64::MAX` bytes, which cannot occur on any supported platform.
    #[must_use]
    pub fn schema_hash(&self) -> [u8; 32] {
        use sha2::{Digest, Sha256};

        /// Feed all bytes of a slice, length-prefixed (8-byte LE u64) to prevent
        /// aliasing between distinct variable-length strings.
        fn feed<D: Digest>(h: &mut D, bytes: &[u8]) {
            let len = u64::try_from(bytes.len()).expect("schema component length fits in u64");
            h.update(len.to_le_bytes());
            h.update(bytes);
        }

        /// Recursive marker-byte feeder for `FieldType`. Marker bytes are
        /// independent of Rust enum discriminants so `FieldType`'s declaration
        /// order can evolve without breaking the digest contract. Array
        /// recurses through its inner type, distinguishing e.g.
        /// `Array(String)` from `Array(Number)`.
        fn feed_field_type<D: Digest>(h: &mut D, ft: &FieldType) {
            match ft {
                FieldType::Id => h.update([0x01u8]),
                FieldType::String => h.update([0x02u8]),
                FieldType::Number => h.update([0x03u8]),
                FieldType::Bool => h.update([0x04u8]),
                FieldType::Date => h.update([0x05u8]),
                FieldType::Enum => h.update([0x06u8]),
                FieldType::Array(inner) => {
                    h.update([0x10u8]);
                    feed_field_type(h, inner);
                }
            }
        }

        let mut h = Sha256::new();

        for (cn, c) in &self.collections {
            feed(&mut h, cn.as_bytes());
            feed(&mut h, c.id_field.as_bytes());

            let fields_len =
                u64::try_from(c.fields.len()).expect("schema component length fits in u64");
            h.update(fields_len.to_le_bytes());

            for f in &c.fields {
                feed(&mut h, f.name.as_bytes());
                feed_field_type(&mut h, &f.ty);
                h.update([u8::from(f.optional)]);
                h.update([u8::from(f.nullable)]);
                h.update([u8::from(f.int)]);
                h.update([u8::from(f.email)]);

                // min: presence marker + LE bytes when present
                h.update([u8::from(f.min.is_some())]);
                if let Some(m) = f.min {
                    h.update(m.to_le_bytes());
                }
                h.update([u8::from(f.max.is_some())]);
                if let Some(m) = f.max {
                    h.update(m.to_le_bytes());
                }

                // regex: presence marker + length-prefixed bytes
                h.update([u8::from(f.regex.is_some())]);
                if let Some(re) = &f.regex {
                    feed(&mut h, re.as_bytes());
                }

                // variants: length-prefixed (declared order is significant)
                let variants_len =
                    u64::try_from(f.variants.len()).expect("schema component length fits in u64");
                h.update(variants_len.to_le_bytes());
                for v in &f.variants {
                    feed(&mut h, v.as_bytes());
                }
            }

            let indexes_len =
                u64::try_from(c.indexes.len()).expect("schema component length fits in u64");
            h.update(indexes_len.to_le_bytes());
            for i in &c.indexes {
                feed(&mut h, i.field.as_bytes());
                h.update([u8::from(i.unique)]);
            }
        }

        h.finalize().into()
    }

    // ── private helpers ───────────────────────────────────────────────────────

    fn compile_fields(cname: &str, raw_fields: &[RawField]) -> Result<Vec<FieldIr>, NookError> {
        let mut fields = Vec::with_capacity(raw_fields.len());
        for f in raw_fields {
            let ty = Self::parse_field_type_recursive(f, cname)?;
            fields.push(FieldIr {
                name: f.name.clone(),
                ty,
                optional: f.optional,
                nullable: f.nullable,
                min: f.min,
                max: f.max,
                int: f.int,
                email: f.email,
                regex: f.regex.clone(),
                variants: f.variants.clone(),
            });
        }
        Ok(fields)
    }

    fn parse_field_type_recursive(raw: &RawField, cname: &str) -> Result<FieldType, NookError> {
        match raw.ty.as_str() {
            "id" => Ok(FieldType::Id),
            "string" => Ok(FieldType::String),
            "number" => Ok(FieldType::Number),
            "boolean" => Ok(FieldType::Bool),
            "enum" => Ok(FieldType::Enum),
            "date" => Ok(FieldType::Date),
            "array" => {
                let items = raw.items.as_deref().ok_or_else(|| NookError::Schema {
                    msg: format!(
                        "array field {:?} in collection {cname:?} missing 'items' descriptor",
                        raw.name,
                    ),
                })?;
                if items.ty == "id" {
                    return Err(NookError::Schema {
                        msg: format!(
                            "array field {:?} in collection {cname:?}: id is not a valid array item type",
                            raw.name,
                        ),
                    });
                }
                let inner = Self::parse_field_type_recursive(items, cname)?;
                Ok(FieldType::Array(Box::new(inner)))
            }
            other => Err(NookError::Schema {
                msg: format!("unknown field type {other:?} in collection {cname:?}"),
            }),
        }
    }

    fn validate_id_field(cname: &str, id_field: &str, fields: &[FieldIr]) -> Result<(), NookError> {
        if !fields
            .iter()
            .any(|f| f.name == id_field && f.ty == FieldType::Id)
        {
            return Err(NookError::Schema {
                msg: format!("collection {cname:?} missing id field {id_field:?} with type \"id\""),
            });
        }
        Ok(())
    }

    fn compile_indexes(
        cname: &str,
        raw_indexes: &[RawIndex],
        fields: &[FieldIr],
    ) -> Result<Vec<IndexIr>, NookError> {
        let mut indexes = Vec::with_capacity(raw_indexes.len());
        for idx in raw_indexes {
            let Some(fld) = fields.iter().find(|f| f.name == idx.field) else {
                return Err(NookError::Schema {
                    msg: format!(
                        "index on unknown field {:?} in collection {cname:?}",
                        idx.field
                    ),
                });
            };
            if fld.optional || fld.nullable {
                return Err(NookError::Schema {
                    msg: format!(
                        "index requires a required, non-null field; {:?} is optional/nullable",
                        idx.field
                    ),
                });
            }
            if matches!(fld.ty, FieldType::Array(_)) {
                return Err(NookError::Schema {
                    msg: format!(
                        "cannot index array field {:?} in collection {cname:?} (M5c limitation: composite-key index codec stores scalars only)",
                        idx.field,
                    ),
                });
            }
            indexes.push(IndexIr {
                field: idx.field.clone(),
                unique: idx.unique,
            });
        }
        Ok(indexes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desc() -> &'static str {
        r#"{"users":{"idField":"id","fields":[
          {"name":"id","type":"id"},
          {"name":"email","type":"string","email":true},
          {"name":"role","type":"enum","variants":["admin","user"]},
          {"name":"age","type":"number","int":true,"min":0,"optional":true}],
          "indexes":[{"field":"email","unique":true},{"field":"role","unique":false}]}}"#
    }

    #[test]
    fn compiles_valid_descriptor() {
        let ir = SchemaIr::compile(desc()).unwrap();
        let c = ir.collection("users").unwrap();
        assert_eq!(c.id_field, "id");
        assert_eq!(c.fields.len(), 4);
        assert_eq!(c.indexes.len(), 2);
    }

    #[test]
    fn rejects_collection_without_id_field() {
        let d = r#"{"c":{"idField":"id","fields":[{"name":"x","type":"string"}],"indexes":[]}}"#;
        let e = SchemaIr::compile(d).unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Schema);
    }

    #[test]
    fn rejects_index_on_optional_field() {
        let d = r#"{"c":{"idField":"id","fields":[
          {"name":"id","type":"id"},{"name":"x","type":"string","optional":true}],
          "indexes":[{"field":"x","unique":false}]}}"#;
        let e = SchemaIr::compile(d).unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Schema);
    }

    #[test]
    fn rejects_reserved_meta_collection_name() {
        let d = r#"{"_meta":{"idField":"id","fields":[{"name":"id","type":"id"}],"indexes":[]}}"#;
        let e = SchemaIr::compile(d).unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Schema);
    }

    #[allow(clippy::too_many_lines)]
    #[test]
    fn schema_hash_diverges_on_constraint_only_diff() {
        // Each pair differs ONLY in one constraint axis. If the hash function
        // doesn't actually feed that axis, the two collide and the assertion
        // fires for that axis — surfacing the regression. M2/M3 carry-forward:
        // closes the constraint-blindness gap so M4's handshake is non-hollow.
        fn h(d: &str) -> [u8; 32] {
            SchemaIr::compile(d).unwrap().schema_hash()
        }

        // min:
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","min":1}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","min":2}],"indexes":[]}}"#),
            "min must affect schema_hash",
        );

        // max:
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","max":100}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","max":200}],"indexes":[]}}"#),
            "max must affect schema_hash",
        );

        // min present vs absent (verifies the Some/None marker, not just value):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number"}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","min":0}],"indexes":[]}}"#),
            "Some(min) vs None must affect schema_hash",
        );

        // max present vs absent (verifies the Some/None marker for max):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number"}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","max":0}],"indexes":[]}}"#),
            "Some(max) vs None must affect schema_hash",
        );

        // int:
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","int":true}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"number","int":false}],"indexes":[]}}"#),
            "int must affect schema_hash",
        );

        // email:
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string","email":true}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string","email":false}],"indexes":[]}}"#),
            "email must affect schema_hash",
        );

        // variants (extending the list):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"r","type":"enum","variants":["a","b"]}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"r","type":"enum","variants":["a","b","c"]}],"indexes":[]}}"#),
            "variants set must affect schema_hash",
        );

        // variants (reordering — must STILL differ, length-prefixed feed keeps order significant):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"r","type":"enum","variants":["a","b"]}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"r","type":"enum","variants":["b","a"]}],"indexes":[]}}"#),
            "variants order must affect schema_hash (declared order is part of the schema)",
        );

        // optional (already fed pre-M4 — test prevents regression):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string","optional":true}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string","optional":false}],"indexes":[]}}"#),
            "optional must affect schema_hash",
        );

        // nullable (already fed pre-M4 — test prevents regression):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string","nullable":true}],"indexes":[]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string","nullable":false}],"indexes":[]}}"#),
            "nullable must affect schema_hash",
        );

        // index unique (already fed pre-M4 — test prevents regression):
        assert_ne!(
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string"}],
                  "indexes":[{"field":"x","unique":true}]}}"#),
            h(r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"x","type":"string"}],
                  "indexes":[{"field":"x","unique":false}]}}"#),
            "index unique must affect schema_hash",
        );
    }

    #[test]
    fn schema_hash_is_stable_and_order_independent() {
        let h1: [u8; 32] = SchemaIr::compile(desc()).unwrap().schema_hash();
        let h2: [u8; 32] = SchemaIr::compile(desc()).unwrap().schema_hash();
        assert_eq!(h1, h2);
        assert!(h1.iter().any(|&b| b != 0));

        // Verify that the hash is independent of the top-level JSON key order
        // (BTreeMap iterates in sorted key order regardless of JSON input order).
        let a = r#"{"alpha":{"idField":"id","fields":[{"name":"id","type":"id"}],"indexes":[]},
                    "beta":{"idField":"id","fields":[{"name":"id","type":"id"}],"indexes":[]}}"#;
        let b = r#"{"beta":{"idField":"id","fields":[{"name":"id","type":"id"}],"indexes":[]},
                    "alpha":{"idField":"id","fields":[{"name":"id","type":"id"}],"indexes":[]}}"#;
        assert_eq!(
            SchemaIr::compile(a).unwrap().schema_hash(),
            SchemaIr::compile(b).unwrap().schema_hash(),
            "schema_hash must be independent of top-level collection JSON key order",
        );
    }

    #[test]
    fn array_field_type_compiles_and_distinguishes_inner_type() {
        let str_arr = SchemaIr::compile(
            r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"tags","type":"array","items":{"type":"string"}}],
                  "indexes":[]}}"#,
        )
        .unwrap();

        let num_arr = SchemaIr::compile(
            r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"tags","type":"array","items":{"type":"number"}}],
                  "indexes":[]}}"#,
        )
        .unwrap();

        assert_ne!(
            str_arr.schema_hash(),
            num_arr.schema_hash(),
            "Array(String) and Array(Number) must produce different hashes",
        );

        let c = str_arr.collection("c").unwrap();
        let tags_field = c.field("tags").unwrap();
        match &tags_field.ty {
            FieldType::Array(inner) => assert!(matches!(**inner, FieldType::String)),
            other => panic!("expected Array(String), got {other:?}"),
        }
    }

    #[test]
    fn schema_hash_returns_32_bytes() {
        // S1 invariant: schema_hash MUST be a raw 32-byte digest (SHA-256),
        // not a hex string. This contract locks the M5a backup format's
        // 32-byte slot to receive raw bytes (no padding) and the M4 handshake
        // to bytewise-compare across both ends.
        let d = r#"{"u":{"idField":"id","fields":[{"name":"id","type":"id"}],"indexes":[]}}"#;
        let h: [u8; 32] = SchemaIr::compile(d).unwrap().schema_hash();
        assert_eq!(h.len(), 32);
        // Not all-zeros (SHA-256 of any non-empty input has high entropy):
        assert!(
            h.iter().any(|&b| b != 0),
            "schema_hash must not be all zeros"
        );
    }
}
