//! NAPI bridge for the M5a backup/restore API.

use napi_derive::napi;

#[napi(object)]
pub struct JsBackupStats {
    pub entry_count: i64,
    pub bytes_written: i64,
}

#[napi(object)]
pub struct JsRestoreStats {
    pub entry_count: i64,
    pub bytes_read: i64,
}

#[napi(object)]
pub struct JsRestoreOptions {
    pub allow_overwrite: Option<bool>,
    pub skip_schema_check: Option<bool>,
}
