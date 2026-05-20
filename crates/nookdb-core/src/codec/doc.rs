//! Schema-driven JSON document codec and the `ValueCodec` byte-transform seam.
//!
//! The `ValueCodec` seam sits at the storage write/read boundary
//! (JSON bytes <-> stored bytes). The default is identity (plain JSON on
//! disk). A future codec can inject here WITHOUT modifying
//! this crate (extension seam §6a). No Pro code lives here.
use serde_json::Value;

use crate::error::NookError;
use crate::schema::ir::CollectionIr;

/// Seam for transforming stored values at the storage read/write boundary.
///
/// Implement this in an external crate to inject an alternate codec (e.g.
/// at-rest encryption) without forking or modifying nookdb-core. The default
/// is [`IdentityCodec`] (pass-through → plain JSON on disk).
///
/// # Examples
///
/// ```
/// use nookdb_core::{ValueCodec, IdentityCodec};
///
/// // The default codec is a pass-through.
/// let codec = IdentityCodec;
/// assert_eq!(codec.encode(b"hi"), b"hi");
/// assert_eq!(codec.decode(b"hi").unwrap(), b"hi");
///
/// // An external crate can implement the seam against the PUBLIC path.
/// struct Xor7;
/// impl ValueCodec for Xor7 {
///     fn encode(&self, v: &[u8]) -> Vec<u8> {
///         v.iter().map(|b| b ^ 7).collect()
///     }
///     fn decode(&self, v: &[u8]) -> Result<Vec<u8>, nookdb_core::NookError> {
///         Ok(v.iter().map(|b| b ^ 7).collect())
///     }
/// }
/// let x = Xor7;
/// assert_eq!(x.decode(&x.encode(b"abc")).unwrap(), b"abc");
/// ```
pub trait ValueCodec: Send + Sync {
    fn encode(&self, value: &[u8]) -> Vec<u8>;
    /// # Errors
    /// Returns `NookError::Corruption` if stored bytes cannot be decoded.
    fn decode(&self, stored: &[u8]) -> Result<Vec<u8>, NookError>;
}

/// The free-tier default: bytes pass through unchanged → plain JSON on disk.
pub struct IdentityCodec;
impl ValueCodec for IdentityCodec {
    fn encode(&self, value: &[u8]) -> Vec<u8> {
        value.to_vec()
    }
    fn decode(&self, stored: &[u8]) -> Result<Vec<u8>, NookError> {
        Ok(stored.to_vec())
    }
}

/// Encodes a validated document to stored bytes via the `ValueCodec` seam.
///
/// Serializes `doc` to canonical JSON bytes, then passes them through
/// `codec.encode`. `_c` is reserved for decode-time coercion of future
/// non-JSON-native types (unused in M2, where all field types carry their
/// canonical JSON representation).
///
/// # Errors
/// Returns `NookError::Schema` if `doc` is not serializable.
pub fn encode_document(
    _c: &CollectionIr,
    doc: &Value,
    codec: &dyn ValueCodec,
) -> Result<Vec<u8>, NookError> {
    let json = serde_json::to_vec(doc).map_err(|e| NookError::Schema {
        msg: format!("cannot serialize document: {e}"),
    })?;
    Ok(codec.encode(&json))
}

/// Decodes stored bytes back to a document value (seam first, then JSON).
///
/// # Errors
/// Returns `NookError::Corruption` if the stored bytes are not the
/// JSON this codec produced.
pub fn decode_document(
    _c: &CollectionIr,
    stored: &[u8],
    codec: &dyn ValueCodec,
) -> Result<Value, NookError> {
    let json = codec.decode(stored)?;
    serde_json::from_slice(&json).map_err(|e| NookError::Corruption {
        msg: format!("corrupt document json: {e}"),
    })
}

#[cfg(test)]
mod doc_tests {
    use super::*;
    use crate::schema::ir::SchemaIr;
    use serde_json::json;

    fn ir() -> SchemaIr {
        SchemaIr::compile(
            r#"{"u":{"idField":"id","fields":[
          {"name":"id","type":"id"},{"name":"name","type":"string"},
          {"name":"born","type":"date"}],"indexes":[]}}"#,
        )
        .unwrap()
    }

    #[test]
    fn json_round_trips_through_identity_codec() {
        let s = ir();
        let c = s.collection("u").unwrap();
        let doc = json!({"id":"1","name":"Ali","born":"2026-05-19T00:00:00.000Z"});
        let bytes = encode_document(c, &doc, &IdentityCodec).unwrap();
        assert!(
            serde_json::from_slice::<serde_json::Value>(&bytes).is_ok(),
            "stored bytes must be valid JSON (debuggability goal)"
        );
        let back = decode_document(c, &bytes, &IdentityCodec).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn decode_fails_corruption_on_garbage() {
        let s = ir();
        let c = s.collection("u").unwrap();
        let e = decode_document(c, b"\xff\xff", &IdentityCodec).unwrap_err();
        assert_eq!(e.kind(), crate::error::NookErrorKind::Corruption);
    }
}

#[cfg(test)]
mod seam_tests {
    use super::*;

    #[test]
    fn default_codec_is_identity_and_selected_via_seam() {
        let codec: &dyn ValueCodec = &IdentityCodec;
        let input = b"{\"a\":1}";
        let stored = codec.encode(input);
        assert_eq!(stored, input);
        assert_eq!(codec.decode(&stored).unwrap(), input);
    }

    // Test-only stub proving the seam accepts an alternate codec.
    // NOT Pro code — lives in the test module only.
    struct ReverseCodec;
    impl ValueCodec for ReverseCodec {
        fn encode(&self, v: &[u8]) -> Vec<u8> {
            v.iter().rev().copied().collect()
        }
        fn decode(&self, v: &[u8]) -> Result<Vec<u8>, crate::error::NookError> {
            Ok(v.iter().rev().copied().collect())
        }
    }

    #[test]
    fn alternate_codec_swaps_in_through_public_seam_api() {
        let codec: &dyn ValueCodec = &ReverseCodec;
        let input = b"abc";
        let stored = codec.encode(input);
        assert_eq!(stored, b"cba");
        assert_eq!(codec.decode(&stored).unwrap(), input);
    }
}
