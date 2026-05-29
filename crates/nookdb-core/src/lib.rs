//! Nook core engine.
//!
//! Pure-Rust embedded database. The JS binding lives in `nookdb-napi`;
//! this crate has no NAPI dependencies and can be unit-tested without
//! Node.

pub mod backup;
pub(crate) mod codec;
pub mod collection;
pub mod database;
pub mod error;
pub mod index;
pub mod license_verify;
pub mod live;
pub mod migrate;
pub mod notify;
pub mod query;
pub mod schema;
pub mod storage;

pub use database::Database;
pub use error::{NookError, NookErrorKind};
pub use storage::{Entry, ReadTx, WriteTx};

/// Storage value-codec injection seam (extension seam §6a). Implement
/// [`ValueCodec`] in an external crate to transform stored values (e.g.
/// at-rest encryption) without forking or modifying nookdb-core;
/// [`IdentityCodec`] is the default pass-through (plain JSON on disk).
pub use codec::doc::{IdentityCodec, ValueCodec};

/// Migration-runner API seam (extension seam §6b). Re-exported for
/// crate-root convenience; the full module is at [`migrate`].
pub use migrate::{MigrationStatus, Runner};

/// Post-commit notifier seam (extension seam, M3). Implement
/// [`CommitObserver`] in an external crate and attach via
/// [`Database::add_observer`] to observe commits without forking
/// nookdb-core.
pub use notify::{ChangeOp, CommitEvent, CommitObserver, DocChange, Notifier, ObserverHandle};

/// Reactive subsystem. `LiveEngine` is constructed by the binding from
/// the opened `Database` + compiled `SchemaIr`; `EmitSink` is the
/// core↔binding emit boundary (core stays NAPI-free).
pub use live::{EmitSink, LiveEngine, SubId};

pub use backup::{
    backup_to_path, read_backup, restore_from_path, write_backup, BackupStats, RestoreOptions,
    RestoreStats,
};

/// Offline ed25519 license-token verification utility (extension seam
/// "any milestone — dormant license-verify utility"). Dormant in the MIT
/// core; consumed by external integrators (post-1.0). No network
/// calls; algorithm pinned to Ed25519. Full module: [`license_verify`].
pub use license_verify::{verify as verify_license, LicenseClaims, NookLicenseError};
