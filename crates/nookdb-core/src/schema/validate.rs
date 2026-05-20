//! Authoritative document validation against a `CollectionIr`.
use serde_json::Value;

use crate::error::NookError;
use crate::schema::ir::{CollectionIr, FieldIr, FieldType};

/// Validates `doc` against `c`. The Rust core is the sole authority
/// (PRD §3); TS has already applied id/defaults before this runs.
///
/// # Errors
/// Returns `NookError::Schema` on any type mismatch, constraint
/// violation, unknown field, or missing required field.
pub fn validate_document(c: &CollectionIr, doc: &Value) -> Result<(), NookError> {
    let obj = doc.as_object().ok_or_else(|| NookError::Schema {
        msg: "document must be an object".into(),
    })?;

    for key in obj.keys() {
        if c.field(key).is_none() {
            return Err(NookError::Schema {
                msg: format!("unknown field {key:?}"),
            });
        }
    }

    for f in &c.fields {
        match obj.get(&f.name) {
            None => {
                if !f.optional {
                    return Err(NookError::Schema {
                        msg: format!("missing required field {:?}", f.name),
                    });
                }
            }
            Some(Value::Null) => {
                if !f.nullable {
                    return Err(NookError::Schema {
                        msg: format!("field {:?} is not nullable", f.name),
                    });
                }
            }
            Some(v) => check_field(f, v)?,
        }
    }

    Ok(())
}

fn check_field(f: &FieldIr, v: &Value) -> Result<(), NookError> {
    check_value(&f.ty, f, v, &f.name)
}

/// Recursive value checker. Carries the original [`FieldIr`] for constraint
/// access (min/max/email/regex/variants) and a slash/index-tagged `path`
/// for human-readable error messages on nested values.
///
/// Per-item constraints on inner array types are out of scope for M5c: the
/// `s.array(s.string())` surface attaches `min/.max/.regex/.email` only to
/// the outer field, so the inner recursion intentionally reuses the same
/// `FieldIr` constraint slots (they are no-ops on the inner type for the
/// shapes the JS surface can produce — `s.array(s.string().min(1))` is not
/// yet on the TS API).
fn check_value(ty: &FieldType, f: &FieldIr, v: &Value, path: &str) -> Result<(), NookError> {
    let bad = |m: String| NookError::Schema { msg: m };

    match ty {
        FieldType::Id | FieldType::String => {
            let s = v
                .as_str()
                .ok_or_else(|| bad(format!("field {path:?} must be a string")))?;

            // Convert char count to f64 without precision loss.
            // u32::MAX (4_294_967_295) is below 2^32, well within f64's exact integer range
            // (2^53), so f64::from(u32) is lossless.  Strings longer than u32::MAX chars
            // are clamped to u32::MAX, which will correctly fail any sane max bound.
            //
            // CONTRACT: length is measured in Unicode scalar values (Rust `char`s).
            // This is the authoritative definition (PRD §3 — the Rust core is the sole
            // validation authority). It may differ from a JS schema author's UTF-16
            // `String.length` (and from grapheme-cluster intuition) for astral/combining
            // characters; the Rust scalar count is canonical by fiat, not a bug.
            let char_count = s.chars().count();
            let len_f64 = f64::from(u32::try_from(char_count).unwrap_or(u32::MAX));

            if f.min.is_some_and(|m| len_f64 < m) || f.max.is_some_and(|m| len_f64 > m) {
                return Err(bad(format!("field {path:?} length out of range")));
            }
            if f.email && !s.contains('@') {
                return Err(bad(format!("field {path:?} must be an email")));
            }
            if let Some(re_src) = &f.regex {
                let re = regex::Regex::new(re_src)
                    .map_err(|e| bad(format!("field {path:?} has invalid regex pattern: {e}")))?;
                if !re.is_match(s) {
                    return Err(bad(format!("field {path:?} does not match pattern")));
                }
            }
        }
        FieldType::Number => {
            let n = v
                .as_f64()
                .ok_or_else(|| bad(format!("field {path:?} must be a number")))?;
            // For |n| >= 2^53, f64 cannot represent a fractional part, so `fract()` is
            // always 0.0 and such values pass the integer check. This is inherent to
            // JSON's f64 number model (serde_json default features) and out of M2 scope;
            // `max` is the intended guard for out-of-range magnitudes. NaN/Infinity are
            // unreachable here — serde_json rejects them at parse time.
            if f.int && n.fract() != 0.0 {
                return Err(bad(format!("field {path:?} must be an integer")));
            }
            if f.min.is_some_and(|m| n < m) || f.max.is_some_and(|m| n > m) {
                return Err(bad(format!("field {path:?} out of range")));
            }
        }
        FieldType::Bool => {
            if !v.is_boolean() {
                return Err(bad(format!("field {path:?} must be a boolean")));
            }
        }
        FieldType::Enum => {
            let s = v
                .as_str()
                .ok_or_else(|| bad(format!("field {path:?} must be a string")))?;
            if !f.variants.iter().any(|x| x == s) {
                return Err(bad(format!("field {path:?} not a valid variant")));
            }
        }
        FieldType::Date => {
            // Schema-driven JSON stores Date as an ISO-8601 string.
            if !v.is_string() {
                return Err(bad(format!("field {path:?} must be an ISO date string")));
            }
        }
        FieldType::Array(item_ty) => {
            let arr = v
                .as_array()
                .ok_or_else(|| bad(format!("field {path:?} must be an array")))?;
            for (i, item) in arr.iter().enumerate() {
                check_value(item_ty, f, item, &format!("{path}[{i}]"))?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::ir::SchemaIr;
    use serde_json::json;

    fn ir() -> SchemaIr {
        SchemaIr::compile(
            r#"{"u":{"idField":"id","fields":[
          {"name":"id","type":"id"},
          {"name":"name","type":"string","min":1,"max":3},
          {"name":"role","type":"enum","variants":["a","b"]},
          {"name":"age","type":"number","int":true,"min":0,"optional":true}],
          "indexes":[]}}"#,
        )
        .unwrap()
    }

    #[test]
    fn accepts_valid_document() {
        let c = ir();
        let c = c.collection("u").unwrap();
        validate_document(c, &json!({"id":"x","name":"Al","role":"a"})).unwrap();
    }

    #[test]
    fn rejects_wrong_type() {
        let c = ir();
        let c = c.collection("u").unwrap();
        let e = validate_document(c, &json!({"id":"x","name":5,"role":"a"})).unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Schema);
    }

    #[test]
    fn rejects_string_too_long_and_bad_enum_and_missing_required() {
        let c = ir();
        let c = c.collection("u").unwrap();
        assert!(validate_document(c, &json!({"id":"x","name":"AAAA","role":"a"})).is_err());
        assert!(validate_document(c, &json!({"id":"x","name":"Al","role":"z"})).is_err());
        assert!(validate_document(c, &json!({"id":"x","role":"a"})).is_err());
    }

    #[test]
    fn allows_absent_optional_but_rejects_non_int_number() {
        let c = ir();
        let c = c.collection("u").unwrap();
        validate_document(c, &json!({"id":"x","name":"Al","role":"a"})).unwrap();
        assert!(validate_document(c, &json!({"id":"x","name":"Al","role":"a","age":1.5})).is_err());
    }

    proptest::proptest! {
        #[test]
        fn name_length_bound_is_enforced(s in ".*") {
            let c = ir();
            let c = c.collection("u").unwrap();
            let r = validate_document(c, &json!({"id":"x","name":s,"role":"a"}));
            let len = s.chars().count();
            proptest::prop_assert_eq!(r.is_ok(), (1..=3).contains(&len));
        }
    }

    #[test]
    fn array_field_round_trip_succeeds() {
        let ir = SchemaIr::compile(
            r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"tags","type":"array","items":{"type":"string"}}],
                  "indexes":[]}}"#,
        )
        .unwrap();
        let c = ir.collection("c").unwrap();
        validate_document(c, &json!({"id":"x","tags":["a","b","c"]})).unwrap();
        validate_document(c, &json!({"id":"x","tags":[]})).unwrap(); // empty OK
    }

    #[test]
    fn array_item_type_mismatch_rejected() {
        let ir = SchemaIr::compile(
            r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"tags","type":"array","items":{"type":"string"}}],
                  "indexes":[]}}"#,
        )
        .unwrap();
        let c = ir.collection("c").unwrap();
        let e = validate_document(c, &json!({"id":"x","tags":["a", 42]})).unwrap_err();
        let msg = e.to_string();
        assert!(
            msg.contains("tags[1]") || msg.contains("tags"),
            "expected path-tagged error, got: {msg}"
        );
    }

    #[test]
    fn nested_array_validates_recursively() {
        let ir = SchemaIr::compile(
            r#"{"c":{"idField":"id","fields":[
                  {"name":"id","type":"id"},
                  {"name":"matrix","type":"array","items":{"type":"array","items":{"type":"number"}}}],
                  "indexes":[]}}"#,
        )
        .unwrap();
        let c = ir.collection("c").unwrap();
        validate_document(c, &json!({"id":"x","matrix":[[1.0, 2.0],[3.0]]})).unwrap();
        assert!(validate_document(c, &json!({"id":"x","matrix":[["not-a-number"]]})).is_err());
    }
}
