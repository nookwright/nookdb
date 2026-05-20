//! `EmitSink` implemented over a NAPI `ThreadsafeFunction`.
//!
//! Core's reactive worker calls [`EmitSink::emit`] with a ready-made
//! envelope string (`{"ok":true,"value":[…]}` or
//! `{"ok":false,"error":"[kind] message"}`); this sink transports that
//! string verbatim to the JS `onEmit` callback via a
//! `ThreadsafeFunction`. The envelope is **not** reshaped here.
//!
//! ## napi-rs 3.x `ThreadsafeFunction` shape
//!
//! `ThreadsafeFunction<T, Return, CallJsBackArgs, ErrorStatus,
//! const CalleeHandled, const Weak, const MaxQueueSize>`.
//!
//! We use `ThreadsafeFunction<String, (), String, Status, false>`:
//! - `T = String` — the value moved across the boundary per call.
//! - `Return = ()` — the JS callback return is ignored (`NonBlocking`).
//! - `CallJsBackArgs = String` — a single-arg JS call
//!   `onEmit(envelopeJson)` (the `FromNapiValue` impl requires
//!   `CallJsBackArgs == T`).
//! - `ErrorStatus = Status` — the crate default.
//! - `CalleeHandled = false` — the JS callback is a plain
//!   `(envelopeJson: string) => void`, **not** the error-first
//!   `(err, value)` convention. With `CalleeHandled = false`,
//!   `.call(...)` takes a plain `T` (not `Result<T, ErrorStatus>`),
//!   which matches transporting one already-encoded envelope string.
use std::sync::atomic::{AtomicBool, Ordering};

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use nookdb_core::live::EmitSink;

/// The concrete `ThreadsafeFunction` shape for the `onEmit` callback,
/// used by `TsfnSink`.
///
/// WARNING: do NOT use this alias in the `#[napi]` `live()` signature.
/// napi-derive's TS codegen emits the alias *identifier verbatim* into
/// `index.d.ts`, producing an undefined type and silently breaking the
/// `@nookdb` TS consumer (Task 9) while the Rust build still passes.
/// The `#[napi] live` signature MUST spell the inline type out; this
/// alias is for non-`#[napi]` uses (`TsfnSink`) only.
pub type EmitTsfn = ThreadsafeFunction<String, (), String, Status, false>;

/// [`EmitSink`] backed by a JS `onEmit` callback.
///
/// `mark_closed()` is the cooperative-cancel signal: once set, `emit`
/// is a no-op and `is_closed` reports `true`, so core's worker drops
/// the subscription on its next pass even before the underlying
/// `ThreadsafeFunction` is dropped (it is dropped when this sink's last
/// `Arc` goes away — i.e. once removed from the `JsDatabase` registry).
pub struct TsfnSink {
    tsfn: EmitTsfn,
    closed: AtomicBool,
}

impl TsfnSink {
    /// Wraps a JS `onEmit` `ThreadsafeFunction` as an [`EmitSink`].
    #[must_use]
    pub const fn new(tsfn: EmitTsfn) -> Self {
        Self {
            tsfn,
            closed: AtomicBool::new(false),
        }
    }

    /// Marks the sink closed: `emit` becomes a no-op and `is_closed`
    /// returns `true`. Idempotent.
    // Deliberately additive to core's own post-snapshot `contains_key` cancel guard
    // (nookdb-core live.rs): this short-circuits an in-flight `emit` BEFORE core's
    // next worker pass — do not remove either layer as "redundant".
    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl EmitSink for TsfnSink {
    fn emit(&self, envelope_json: &str) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        // `NonBlocking`: never stall core's single live worker on a
        // slow/backed-up JS event loop. The envelope is transported
        // verbatim; the `Status` result is intentionally ignored
        // (a closed/aborted tsfn just means the JS side went away,
        // which `mark_closed` + core's `is_closed` drop already cover).
        let _ = self.tsfn.call(
            envelope_json.to_string(),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}
