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
}
