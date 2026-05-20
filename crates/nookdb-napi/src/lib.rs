//! NAPI-rs binding for nookdb-core.
//!
//! This crate is `cdylib`-only and produces the `.node` file consumed
//! by the `nookdb` npm package.

// NAPI-rs requires owned types in #[napi] signatures so it can move the value
// across the JS↔Rust boundary. Clippy's pedantic rule is a false positive here.
#![allow(clippy::needless_pass_by_value)]
// napi-derive emits async-trait shaped code that triggers some pedantic lints.
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::future_not_send)]
// napi-derive macro expansion emits a trailing zero-sized array in a helper
// struct (`NapiRefContainer`) that we cannot annotate with `#[repr(C)]`.
#![allow(clippy::trailing_empty_array)]

pub mod backup;
pub mod database;
pub mod error;
pub mod live;

pub use database::{DbEntry, JsDatabase};
