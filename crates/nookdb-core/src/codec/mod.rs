//! Composite-key encoding for the storage layer.
//!
//! Every entry in the underlying redb table has its key encoded as
//! `{collection_bytes}\0{user_key_bytes}`. The `\0` separator means
//! collection names cannot contain a null byte; this is enforced by
//! `encode_key` and `collection_prefix_*` at the public boundary.

use crate::error::NookError;

/// Separator byte between the collection name and the user key.
pub const SEPARATOR: u8 = 0;

/// Encodes a composite key for the storage table.
///
/// # Errors
///
/// Returns `NookError::InvalidArg` if `collection` is empty or contains
/// the reserved `\0` separator byte.
pub fn encode_key(collection: &str, user_key: &[u8]) -> Result<Vec<u8>, NookError> {
    validate_collection(collection)?;
    let coll_bytes = collection.as_bytes();
    let mut out = Vec::with_capacity(coll_bytes.len() + 1 + user_key.len());
    out.extend_from_slice(coll_bytes);
    out.push(SEPARATOR);
    out.extend_from_slice(user_key);
    Ok(out)
}

/// Lower bound (inclusive) for a range scan of one collection.
///
/// Equivalent to `encode_key(collection, &[])`.
///
/// # Errors
///
/// Returns `NookError::InvalidArg` if `collection` is empty or contains
/// the reserved `\0` separator byte.
pub fn collection_prefix_lower(collection: &str) -> Result<Vec<u8>, NookError> {
    encode_key(collection, &[])
}

/// Upper bound (exclusive) for a range scan of one collection.
///
/// `{collection}\x01` sorts immediately after every `{collection}\0...`
/// composite key in lexicographic order, giving us a closed range
/// `[collection_prefix_lower, collection_prefix_upper)` that contains
/// exactly the entries of one collection.
///
/// # Errors
///
/// Returns `NookError::InvalidArg` if `collection` is empty or contains
/// the reserved `\0` separator byte.
pub fn collection_prefix_upper(collection: &str) -> Result<Vec<u8>, NookError> {
    validate_collection(collection)?;
    let mut out = Vec::with_capacity(collection.len() + 1);
    out.extend_from_slice(collection.as_bytes());
    out.push(1);
    Ok(out)
}

/// Returns the user-key portion of a composite key, or `None` if the
/// composite key does not have the expected `{collection}\0` prefix.
#[must_use]
pub fn strip_collection_prefix<'a>(composite: &'a [u8], collection: &str) -> Option<&'a [u8]> {
    let coll_bytes = collection.as_bytes();
    let prefix_len = coll_bytes.len() + 1;
    if composite.len() < prefix_len {
        return None;
    }
    if &composite[..coll_bytes.len()] != coll_bytes {
        return None;
    }
    if composite[coll_bytes.len()] != SEPARATOR {
        return None;
    }
    Some(&composite[prefix_len..])
}

fn validate_collection(collection: &str) -> Result<(), NookError> {
    if collection.is_empty() {
        return Err(NookError::InvalidArg {
            msg: "collection name cannot be empty".into(),
        });
    }
    if collection.as_bytes().contains(&SEPARATOR) {
        return Err(NookError::InvalidArg {
            msg: format!("collection name cannot contain a null byte: {collection:?}"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::NookErrorKind;

    #[test]
    fn encode_key_concatenates_collection_separator_and_user_key() {
        let k = encode_key("users", b"alice").unwrap();
        assert_eq!(k, b"users\0alice");
    }

    #[test]
    fn encode_key_allows_empty_user_key() {
        let k = encode_key("users", b"").unwrap();
        assert_eq!(k, b"users\0");
    }

    #[test]
    fn encode_key_allows_binary_user_keys() {
        let k = encode_key("blob", &[0xff, 0x00, 0x42]).unwrap();
        assert_eq!(k, b"blob\0\xff\x00\x42");
    }

    #[test]
    fn encode_key_rejects_empty_collection() {
        let err = encode_key("", b"x").unwrap_err();
        assert_eq!(err.kind(), NookErrorKind::InvalidArg);
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn encode_key_rejects_collection_with_null_byte() {
        let err = encode_key("bad\0name", b"x").unwrap_err();
        assert_eq!(err.kind(), NookErrorKind::InvalidArg);
        assert!(err.to_string().contains("null"));
    }

    #[test]
    fn prefix_bounds_bracket_collection_entries_exclusively() {
        let lo = collection_prefix_lower("users").unwrap();
        let hi = collection_prefix_upper("users").unwrap();
        let in_range = encode_key("users", b"z").unwrap();
        let out_of_range_next = encode_key("usersx", b"").unwrap();
        assert!(lo.as_slice() <= in_range.as_slice());
        assert!(in_range.as_slice() < hi.as_slice());
        assert!(out_of_range_next.as_slice() >= hi.as_slice());
    }

    #[test]
    fn strip_collection_prefix_returns_user_key_on_match() {
        let composite = b"users\0alice";
        let user_key = strip_collection_prefix(composite, "users").unwrap();
        assert_eq!(user_key, b"alice");
    }

    #[test]
    fn strip_collection_prefix_returns_none_on_short_input() {
        assert!(strip_collection_prefix(b"u", "users").is_none());
    }

    #[test]
    fn strip_collection_prefix_returns_none_on_mismatched_collection() {
        assert!(strip_collection_prefix(b"posts\0p1", "users").is_none());
    }

    #[test]
    fn strip_collection_prefix_returns_none_when_separator_missing() {
        // No `\0` after "users"
        assert!(strip_collection_prefix(b"usersalice", "users").is_none());
    }
}

pub mod doc;
