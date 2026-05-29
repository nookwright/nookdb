//! Query-shaping options (`sort` / `limit` / `offset`) applied by `find`.
use serde::Deserialize;

/// Sort direction for one sort key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// Decoded query options.
///
/// Sort is an ordered list of `(field, dir)` pairs; the wire encodes it as a
/// JSON array so key/priority order is preserved (a JSON object would lose
/// order through `serde_json`'s map decode).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct QueryOptions {
    pub sort: Vec<(String, SortDir)>,
    pub limit: Option<usize>,
    pub offset: usize,
}

impl QueryOptions {
    /// Parses an optional wire `optionsJson`. `None`/empty → default.
    ///
    /// # Errors
    /// Returns `NookError::InvalidArg` if the JSON is malformed or a value
    /// is out of range (negative / fractional `limit`/`offset`, bad `dir`).
    pub fn parse(options_json: Option<&str>) -> Result<Self, crate::error::NookError> {
        match options_json {
            None => Ok(Self::default()),
            Some(s) if s.trim().is_empty() => Ok(Self::default()),
            Some(s) => serde_json::from_str(s).map_err(|e| crate::error::NookError::InvalidArg {
                msg: format!("invalid query options: {e}"),
            }),
        }
    }

    /// `true` when no sort keys are set.
    #[must_use]
    pub fn has_sort(&self) -> bool {
        !self.sort.is_empty()
    }

    /// Orders `docs` in place by the configured sort keys, then applies
    /// `offset`/`limit`. Comparison is schema-typed via `field_ty`
    /// (a lookup `field name → Option<&FieldType>`). null/missing values
    /// sort LAST regardless of direction; ties break by `id_field` (ascending)
    /// for deterministic pagination.
    ///
    /// # Errors
    /// `NookError::Schema` if a sort field is unknown or its type is not
    /// orderable (array).
    pub fn apply<'f>(
        &self,
        mut docs: Vec<serde_json::Value>,
        id_field: &str,
        field_ty: impl Fn(&str) -> Option<&'f crate::schema::ir::FieldType>,
    ) -> Result<Vec<serde_json::Value>, crate::error::NookError> {
        use crate::schema::ir::FieldType;
        use std::cmp::Ordering;

        // Validate sort fields up front.
        for (field, _) in &self.sort {
            match field_ty(field) {
                None => {
                    return Err(crate::error::NookError::Schema {
                        msg: format!("cannot sort on unknown field {field:?}"),
                    })
                }
                Some(FieldType::Array(_)) => {
                    return Err(crate::error::NookError::Schema {
                        msg: format!("cannot sort on array field {field:?}"),
                    })
                }
                Some(_) => {}
            }
        }

        if self.has_sort() {
            docs.sort_by(|a, b| {
                for (field, dir) in &self.sort {
                    let av = a.get(field);
                    let bv = b.get(field);
                    let ord = cmp_values(av, bv);
                    let ord = match dir {
                        SortDir::Asc => ord,
                        // Desc flips only present-vs-present ordering; nulls
                        // stay last (handled inside cmp_values via None-last).
                        SortDir::Desc => ord.reverse_present(av, bv),
                    };
                    if ord != Ordering::Equal {
                        return ord;
                    }
                }
                // Deterministic tie-break by id (ascending).
                let aid = a.get(id_field).and_then(serde_json::Value::as_str);
                let bid = b.get(id_field).and_then(serde_json::Value::as_str);
                aid.cmp(&bid)
            });
        }

        let start = self.offset.min(docs.len());
        let mut out = docs.split_off(start);
        if let Some(limit) = self.limit {
            out.truncate(limit);
        }
        Ok(out)
    }
}

/// Total order across the JSON scalar types we sort, with null/missing LAST.
///
/// Present values: numbers compared numerically, everything else (string,
/// bool, enum, date-as-ISO-string) compared by its natural `serde_json`
/// ordering via string/bool/number arms. Mixed present types fall back to a
/// stable type-rank so the sort never panics.
fn cmp_values(a: Option<&serde_json::Value>, b: Option<&serde_json::Value>) -> std::cmp::Ordering {
    use serde_json::Value;
    use std::cmp::Ordering;
    let is_absent = |v: Option<&Value>| matches!(v, None | Some(Value::Null));
    match (is_absent(a), is_absent(b)) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater, // null/missing sorts last
        (false, true) => Ordering::Less,
        (false, false) => {
            let (a, b) = (a.unwrap(), b.unwrap());
            match (a, b) {
                (Value::Number(x), Value::Number(y)) => x
                    .as_f64()
                    .partial_cmp(&y.as_f64())
                    .unwrap_or(Ordering::Equal),
                (Value::String(x), Value::String(y)) => x.cmp(y),
                (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
                _ => type_rank(a).cmp(&type_rank(b)),
            }
        }
    }
}

/// Stable rank for mixed present types (keeps `sort_by` total + panic-free).
const fn type_rank(v: &serde_json::Value) -> u8 {
    use serde_json::Value;
    match v {
        Value::Bool(_) => 0,
        Value::Number(_) => 1,
        Value::String(_) => 2,
        _ => 3,
    }
}

/// Extension so a Desc sort flips present/present order but keeps null-last.
trait ReversePresent {
    fn reverse_present(
        self,
        a: Option<&serde_json::Value>,
        b: Option<&serde_json::Value>,
    ) -> std::cmp::Ordering;
}
impl ReversePresent for std::cmp::Ordering {
    fn reverse_present(
        self,
        a: Option<&serde_json::Value>,
        b: Option<&serde_json::Value>,
    ) -> std::cmp::Ordering {
        use serde_json::Value;
        let is_absent = |v: Option<&Value>| matches!(v, None | Some(Value::Null));
        // If either side is null/missing, DON'T reverse — null stays last.
        if is_absent(a) || is_absent(b) {
            self
        } else {
            self.reverse()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_and_empty_decode_to_default() {
        assert_eq!(QueryOptions::parse(None).unwrap().offset, 0);
        assert!(QueryOptions::parse(Some("")).unwrap().sort.is_empty());
        assert!(QueryOptions::parse(Some("  ")).unwrap().limit.is_none());
    }

    #[test]
    fn decodes_sort_pairs_in_order() {
        let o = QueryOptions::parse(Some(
            r#"{"sort":[["status","asc"],["updatedAt","desc"]],"limit":50,"offset":10}"#,
        ))
        .unwrap();
        assert_eq!(o.sort.len(), 2);
        assert_eq!(o.sort[0], ("status".to_string(), SortDir::Asc));
        assert_eq!(o.sort[1], ("updatedAt".to_string(), SortDir::Desc));
        assert_eq!(o.limit, Some(50));
        assert_eq!(o.offset, 10);
    }

    #[test]
    fn rejects_negative_limit() {
        assert!(QueryOptions::parse(Some(r#"{"limit":-1}"#)).is_err());
    }

    #[test]
    fn rejects_fractional_offset() {
        assert!(QueryOptions::parse(Some(r#"{"offset":1.5}"#)).is_err());
    }

    #[test]
    fn rejects_unknown_direction() {
        assert!(QueryOptions::parse(Some(r#"{"sort":[["a","up"]]}"#)).is_err());
    }

    use crate::schema::ir::FieldType;
    use serde_json::json;

    // Returns `Option` to match the `field_ty: Fn(&str) -> Option<&FieldType>`
    // shape that `apply` consumes (a real lookup can miss); the wrap is not
    // redundant at the call site.
    #[allow(clippy::unnecessary_wraps)]
    fn num_ty(_f: &str) -> Option<&'static FieldType> {
        // leaked once; fine for tests
        Some(Box::leak(Box::new(FieldType::Number)))
    }

    #[test]
    fn sorts_numbers_asc_with_nulls_last() {
        let o = QueryOptions::parse(Some(r#"{"sort":[["n","asc"]]}"#)).unwrap();
        let docs = vec![
            json!({"id":"a","n":3}),
            json!({"id":"b"}),
            json!({"id":"c","n":1}),
            json!({"id":"d","n":2}),
        ];
        let out = o.apply(docs, "id", num_ty).unwrap();
        let ns: Vec<_> = out.iter().map(|d| d.get("n").cloned()).collect();
        assert_eq!(
            ns,
            vec![Some(json!(1)), Some(json!(2)), Some(json!(3)), None]
        );
    }

    #[test]
    fn sorts_desc_keeps_nulls_last() {
        let o = QueryOptions::parse(Some(r#"{"sort":[["n","desc"]]}"#)).unwrap();
        let docs = vec![
            json!({"id":"a","n":1}),
            json!({"id":"b"}),
            json!({"id":"c","n":3}),
        ];
        let out = o.apply(docs, "id", num_ty).unwrap();
        let ns: Vec<_> = out.iter().map(|d| d.get("n").cloned()).collect();
        assert_eq!(ns, vec![Some(json!(3)), Some(json!(1)), None]);
    }

    #[test]
    fn ties_break_by_id_ascending() {
        let o = QueryOptions::parse(Some(r#"{"sort":[["n","asc"]]}"#)).unwrap();
        let docs = vec![json!({"id":"z","n":1}), json!({"id":"a","n":1})];
        let out = o.apply(docs, "id", num_ty).unwrap();
        let ids: Vec<_> = out
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["a", "z"]);
    }

    #[test]
    fn offset_and_limit_after_sort() {
        let o =
            QueryOptions::parse(Some(r#"{"sort":[["n","asc"]],"offset":1,"limit":2}"#)).unwrap();
        let docs = vec![
            json!({"id":"a","n":4}),
            json!({"id":"b","n":1}),
            json!({"id":"c","n":3}),
            json!({"id":"d","n":2}),
        ];
        let out = o.apply(docs, "id", num_ty).unwrap();
        let ns: Vec<_> = out.iter().map(|d| d["n"].as_i64().unwrap()).collect();
        assert_eq!(ns, vec![2, 3]);
    }

    #[test]
    fn limit_zero_is_empty_and_offset_past_end_is_empty() {
        let z = QueryOptions::parse(Some(r#"{"limit":0}"#)).unwrap();
        assert!(z
            .apply(vec![json!({"id":"a"})], "id", num_ty)
            .unwrap()
            .is_empty());
        let past = QueryOptions::parse(Some(r#"{"offset":9}"#)).unwrap();
        assert!(past
            .apply(vec![json!({"id":"a"})], "id", num_ty)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_sort_on_unknown_field() {
        let o = QueryOptions::parse(Some(r#"{"sort":[["x","asc"]]}"#)).unwrap();
        let err = o.apply(vec![], "id", |_| None).unwrap_err();
        assert!(matches!(err, crate::error::NookError::Schema { .. }));
    }

    #[test]
    fn rejects_sort_on_array_field() {
        let o = QueryOptions::parse(Some(r#"{"sort":[["tags","asc"]]}"#)).unwrap();
        let arr = Box::leak(Box::new(FieldType::Array(Box::new(FieldType::String))));
        let err = o.apply(vec![], "id", |_| Some(arr)).unwrap_err();
        assert!(matches!(err, crate::error::NookError::Schema { .. }));
    }
}
