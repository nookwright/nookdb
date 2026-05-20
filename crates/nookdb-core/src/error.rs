//! Error type hierarchy for `nookdb-core`.
//!
//! Every public function in this crate returns `Result<_, NookError>`.
//! The `kind()` accessor gives a stable string discriminant the NAPI
//! binding uses to translate Rust errors into typed JS error classes.

use std::io;

use thiserror::Error;

/// Stable kind tag used to map a `NookError` to a JS error class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NookErrorKind {
    Storage,
    Corruption,
    Conflict,
    Transaction,
    InvalidArg,
    Closed,
    Schema,
    Migration,
}

impl NookErrorKind {
    /// Returns the lowercase string slug used in the NAPI message prefix.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "storage",
            Self::Corruption => "corruption",
            Self::Conflict => "conflict",
            Self::Transaction => "transaction",
            Self::InvalidArg => "invalid_arg",
            Self::Closed => "closed",
            Self::Schema => "schema",
            Self::Migration => "migration",
        }
    }
}

#[derive(Debug, Error)]
pub enum NookError {
    #[error("storage error: {0}")]
    Storage(#[from] io::Error),

    #[error("database corruption: {msg}")]
    Corruption { msg: String },

    #[error("write conflict: {msg}")]
    Conflict { msg: String },

    #[error("transaction error: {msg}")]
    Transaction { msg: String },

    #[error("invalid argument: {msg}")]
    InvalidArg { msg: String },

    #[error("database is closed")]
    Closed,

    #[error("schema error: {msg}")]
    Schema { msg: String },

    #[error("migration error: {msg}")]
    Migration { msg: String },
}

impl NookError {
    /// Stable discriminant suitable for cross-language error mapping.
    #[must_use]
    pub const fn kind(&self) -> NookErrorKind {
        match self {
            Self::Storage(_) => NookErrorKind::Storage,
            Self::Corruption { .. } => NookErrorKind::Corruption,
            Self::Conflict { .. } => NookErrorKind::Conflict,
            Self::Transaction { .. } => NookErrorKind::Transaction,
            Self::InvalidArg { .. } => NookErrorKind::InvalidArg,
            Self::Closed => NookErrorKind::Closed,
            Self::Schema { .. } => NookErrorKind::Schema,
            Self::Migration { .. } => NookErrorKind::Migration,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_str_matches_variant() {
        assert_eq!(NookErrorKind::Storage.as_str(), "storage");
        assert_eq!(NookErrorKind::Corruption.as_str(), "corruption");
        assert_eq!(NookErrorKind::Conflict.as_str(), "conflict");
        assert_eq!(NookErrorKind::Transaction.as_str(), "transaction");
        assert_eq!(NookErrorKind::InvalidArg.as_str(), "invalid_arg");
        assert_eq!(NookErrorKind::Closed.as_str(), "closed");
        assert_eq!(NookErrorKind::Schema.as_str(), "schema");
        assert_eq!(NookErrorKind::Migration.as_str(), "migration");
    }

    #[test]
    fn display_includes_message() {
        let e = NookError::InvalidArg {
            msg: "bad collection".to_string(),
        };
        assert_eq!(e.to_string(), "invalid argument: bad collection");
    }

    #[test]
    fn io_error_converts_to_storage_variant() {
        use std::error::Error as _;

        let io_err = io::Error::new(io::ErrorKind::PermissionDenied, "nope");
        let nook: NookError = io_err.into();
        assert_eq!(nook.kind(), NookErrorKind::Storage);
        assert!(nook.to_string().contains("storage error"));
        assert!(
            nook.source().is_some(),
            "Storage variant must chain the inner io::Error as its source",
        );
    }

    #[test]
    fn kind_is_stable_across_variants() {
        assert_eq!(
            NookError::Conflict { msg: "x".into() }.kind(),
            NookErrorKind::Conflict,
        );
        assert_eq!(NookError::Closed.kind(), NookErrorKind::Closed);
        assert_eq!(
            NookError::Corruption { msg: "x".into() }.kind(),
            NookErrorKind::Corruption,
        );
    }

    #[test]
    fn error_implements_std_error_trait() {
        fn assert_error<E: std::error::Error>() {}
        assert_error::<NookError>();
    }

    #[test]
    fn schema_and_migration_kinds_have_stable_slugs() {
        assert_eq!(NookErrorKind::Schema.as_str(), "schema");
        assert_eq!(NookErrorKind::Migration.as_str(), "migration");
    }

    #[test]
    fn schema_error_carries_message_and_kind() {
        let e = NookError::Schema {
            msg: "bad field".into(),
        };
        assert_eq!(e.kind(), NookErrorKind::Schema);
        assert!(e.to_string().contains("bad field"));
    }

    #[test]
    fn conflict_error_carries_message_and_kind() {
        let e = NookError::Conflict {
            msg: "users.email = a@b".into(),
        };
        assert_eq!(e.kind(), NookErrorKind::Conflict);
        assert!(e.to_string().contains("a@b"));
    }

    #[test]
    fn migration_error_carries_message_and_kind() {
        let e = NookError::Migration {
            msg: "version gap".into(),
        };
        assert_eq!(e.kind(), NookErrorKind::Migration);
        assert!(e.to_string().contains("version gap"));
    }
}
