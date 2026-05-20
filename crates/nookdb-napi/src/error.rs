//! Conversion from `nookdb_core::NookError` to `napi::Error`.
//!
//! Format: `[<kind>] <Display impl>` — the TS side parses the bracket
//! prefix to select the correct typed JS error class. See
//! `packages/nookdb/src/errors.ts::mapNativeError`.

use nookdb_core::NookError;

#[must_use]
pub fn map_nook_error(err: NookError) -> napi::Error {
    let kind = err.kind().as_str();
    napi::Error::from_reason(format!("[{kind}] {err}"))
}

/// Wraps a `tokio::task::JoinError` into a transaction-shaped napi error.
///
/// A `JoinError` means the `spawn_blocking` task panicked or the runtime
/// is shutting down. We deliberately map it to the `[transaction]` prefix
/// so the TS layer treats it as a transient failure (not corruption or a
/// closed-DB condition). The `#[must_use]` keeps callers from discarding it.
#[must_use]
pub fn map_join_error(err: tokio::task::JoinError) -> napi::Error {
    napi::Error::from_reason(format!("[transaction] join error: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_includes_kind_prefix() {
        let err = NookError::Conflict {
            msg: "concurrent write".into(),
        };
        let napi_err = map_nook_error(err);
        assert!(napi_err.reason.starts_with("[conflict]"));
    }

    #[test]
    fn map_includes_message_body() {
        let err = NookError::InvalidArg {
            msg: "bad name".to_string(),
        };
        let napi_err = map_nook_error(err);
        assert!(napi_err.reason.contains("bad name"));
        assert!(napi_err.reason.starts_with("[invalid_arg]"));
    }
}
