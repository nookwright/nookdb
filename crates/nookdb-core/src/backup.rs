//! Portable `.nbkp` backup and restore.
//!
//! Online logical export of all entries via a redb read-txn snapshot;
//! restore replays into a single redb write transaction. The Rust core
//! is schema-agnostic — the schema hash, when known to the caller, is
//! recorded in the backup header.
//!

// Public surface filled in by subsequent tasks.

const MAGIC: &[u8; 8] = b"NOOKBKUP";
const FORMAT_VER: u16 = 1;

/// The redb major.minor marker recorded in the header. Informational; the
/// logical backup format does not depend on redb internals.
const REDB_MARKER: u32 = 0x0200_0000;

/// Backup header. All multi-byte integers are big-endian.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackupHeader {
    pub format_ver: u16,
    pub created_ms: u64,
    pub schema_hash: Option<[u8; 32]>,
    pub redb_marker: u32,
    pub entry_count_hint: u64,
}

impl BackupHeader {
    /// Total on-disk size of the header, in bytes.
    #[cfg(test)]
    pub(crate) const SIZE: usize = 8 + 2 + 8 + 1 + 32 + 4 + 8;

    pub(crate) fn write_to<W: std::io::Write>(&self, w: &mut W) -> std::io::Result<()> {
        w.write_all(MAGIC)?;
        w.write_all(&self.format_ver.to_be_bytes())?;
        w.write_all(&self.created_ms.to_be_bytes())?;
        if let Some(h) = self.schema_hash {
            w.write_all(&[1u8])?;
            w.write_all(&h)?;
        } else {
            w.write_all(&[0u8])?;
            w.write_all(&[0u8; 32])?;
        }
        w.write_all(&self.redb_marker.to_be_bytes())?;
        w.write_all(&self.entry_count_hint.to_be_bytes())?;
        Ok(())
    }

    pub(crate) fn read_from<R: std::io::Read>(r: &mut R) -> Result<Self, crate::error::NookError> {
        let mut magic = [0u8; 8];
        read_exact_or_truncated(r, &mut magic)?;
        if &magic != MAGIC {
            return Err(crate::error::NookError::Corruption {
                msg: "invalid backup magic".into(),
            });
        }
        let mut fv = [0u8; 2];
        read_exact_or_truncated(r, &mut fv)?;
        let format_ver = u16::from_be_bytes(fv);
        if format_ver != FORMAT_VER {
            return Err(crate::error::NookError::Corruption {
                msg: format!("unsupported backup format version {format_ver}"),
            });
        }
        let mut cm = [0u8; 8];
        read_exact_or_truncated(r, &mut cm)?;
        let created_ms = u64::from_be_bytes(cm);
        let mut sp = [0u8; 1];
        read_exact_or_truncated(r, &mut sp)?;
        let mut sh = [0u8; 32];
        read_exact_or_truncated(r, &mut sh)?;
        let schema_hash = match sp[0] {
            0 => None,
            1 => Some(sh),
            other => {
                return Err(crate::error::NookError::Corruption {
                    msg: format!("invalid schema_present byte {other}"),
                });
            }
        };
        let mut rm = [0u8; 4];
        read_exact_or_truncated(r, &mut rm)?;
        let redb_marker = u32::from_be_bytes(rm);
        let mut ec = [0u8; 8];
        read_exact_or_truncated(r, &mut ec)?;
        let entry_count_hint = u64::from_be_bytes(ec);
        Ok(Self {
            format_ver,
            created_ms,
            schema_hash,
            redb_marker,
            entry_count_hint,
        })
    }
}

fn read_exact_or_truncated<R: std::io::Read>(
    r: &mut R,
    buf: &mut [u8],
) -> Result<(), crate::error::NookError> {
    r.read_exact(buf).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => crate::error::NookError::Corruption {
            msg: "truncated backup stream".into(),
        },
        _ => crate::error::NookError::Storage(e),
    })
}

/// Writes one entry: `key_len u32 BE | key | value_len u32 BE | value`.
/// `key.len()` must be > 0 — a zero-length key is reserved for the sentinel.
pub(crate) fn write_entry<W: std::io::Write>(
    w: &mut W,
    key: &[u8],
    value: &[u8],
) -> std::io::Result<()> {
    debug_assert!(!key.is_empty(), "entry key must be non-empty");
    w.write_all(
        &u32::try_from(key.len())
            .expect("key too large for backup frame")
            .to_be_bytes(),
    )?;
    w.write_all(key)?;
    w.write_all(
        &u32::try_from(value.len())
            .expect("value too large for backup frame")
            .to_be_bytes(),
    )?;
    w.write_all(value)?;
    Ok(())
}

/// Writes the end-of-entries sentinel: a single `u32 BE = 0` key length.
pub(crate) fn write_sentinel<W: std::io::Write>(w: &mut W) -> std::io::Result<()> {
    w.write_all(&0u32.to_be_bytes())?;
    Ok(())
}

/// One streamed read result: either an entry, or the sentinel marking EOF.
#[derive(Debug)]
pub(crate) enum ReadEntry {
    Entry { key: Vec<u8>, value: Vec<u8> },
    Sentinel,
}

pub(crate) fn read_entry<R: std::io::Read>(
    r: &mut R,
) -> Result<ReadEntry, crate::error::NookError> {
    let mut kl = [0u8; 4];
    read_exact_or_truncated(r, &mut kl)?;
    let key_len = u32::from_be_bytes(kl) as usize;
    if key_len == 0 {
        return Ok(ReadEntry::Sentinel);
    }
    let mut key = vec![0u8; key_len];
    read_exact_or_truncated(r, &mut key)?;
    let mut vl = [0u8; 4];
    read_exact_or_truncated(r, &mut vl)?;
    let value_len = u32::from_be_bytes(vl) as usize;
    let mut value = vec![0u8; value_len];
    read_exact_or_truncated(r, &mut value)?;
    Ok(ReadEntry::Entry { key, value })
}

/// Wrapper that mirrors bytes through to `inner` while updating a
/// running CRC32 hash.
pub(crate) struct CrcWriter<W: std::io::Write> {
    inner: W,
    crc: crc32fast::Hasher,
}

impl<W: std::io::Write> CrcWriter<W> {
    pub(crate) fn new(inner: W) -> Self {
        Self {
            inner,
            crc: crc32fast::Hasher::new(),
        }
    }
    pub(crate) fn finish(mut self) -> std::io::Result<(W, u32)> {
        let sum = self.crc.finalize();
        self.inner.write_all(&sum.to_be_bytes())?;
        Ok((self.inner, sum))
    }
}

impl<W: std::io::Write> std::io::Write for CrcWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.crc.update(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Wrapper that mirrors bytes from `inner` while updating a running
/// CRC32 hash. Caller is responsible for reading exactly the bytes that
/// were CRC'd at write time, then calling `finish_and_verify`.
pub(crate) struct CrcReader<R: std::io::Read> {
    inner: R,
    crc: crc32fast::Hasher,
}

impl<R: std::io::Read> CrcReader<R> {
    pub(crate) fn new(inner: R) -> Self {
        Self {
            inner,
            crc: crc32fast::Hasher::new(),
        }
    }
    pub(crate) fn finish_and_verify(mut self) -> Result<(), crate::error::NookError> {
        let mut footer = [0u8; 4];
        // Read the footer DIRECTLY from inner (do NOT update CRC with the footer itself).
        self.inner
            .read_exact(&mut footer)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::UnexpectedEof => crate::error::NookError::Corruption {
                    msg: "truncated backup stream".into(),
                },
                _ => crate::error::NookError::from(e),
            })?;
        let expected = u32::from_be_bytes(footer);
        let actual = self.crc.finalize();
        if expected != actual {
            return Err(crate::error::NookError::Corruption {
                msg: "backup checksum mismatch".into(),
            });
        }
        Ok(())
    }
}

impl<R: std::io::Read> std::io::Read for CrcReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.crc.update(&buf[..n]);
        Ok(n)
    }
}

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::database::Database;
use crate::error::NookError;

/// Statistics returned by a successful [`write_backup`] call.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackupStats {
    pub entry_count: u64,
    pub bytes_written: u64,
}

/// Statistics returned by a successful restore call.
#[derive(Debug, Clone, Copy, Default)]
pub struct RestoreStats {
    pub entry_count: u64,
    pub bytes_read: u64,
}

/// Options controlling restore behaviour.
#[derive(Debug, Clone, Copy, Default)]
pub struct RestoreOptions {
    pub allow_overwrite: bool,
    pub skip_schema_check: bool,
    pub current_schema_hash: Option<[u8; 32]>,
}

/// Streams every (`composite_key`, value) entry in `db` to `w` in the `.nbkp` v1 format.
///
/// The DB is read under a single redb read transaction (consistent MVCC snapshot —
/// concurrent writers are not blocked). `schema_hash` is recorded in the header when
/// `Some`; pass `None` if no schema is registered with this Database.
///
/// # Errors
///
/// Returns `NookError::Storage` on I/O failures and `NookError::Corruption`
/// on internal invariants violated (e.g. composite key with empty prefix —
/// not expected on a well-formed redb).
pub fn write_backup<W: std::io::Write>(
    db: &Database,
    w: &mut W,
    schema_hash: Option<[u8; 32]>,
) -> Result<BackupStats, NookError> {
    let created_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));

    #[allow(clippy::redundant_closure_for_method_calls)]
    // trait method lookup requires explicit closure
    let entries = db.read(|tx| tx.list_entries_raw())?;

    let mut counting = CountingWriter { inner: w, count: 0 };
    let mut crc = CrcWriter::new(&mut counting);
    let header = BackupHeader {
        format_ver: FORMAT_VER,
        created_ms,
        schema_hash,
        redb_marker: REDB_MARKER,
        entry_count_hint: entries.len() as u64,
    };
    header.write_to(&mut crc).map_err(NookError::from)?;
    for (k, v) in &entries {
        write_entry(&mut crc, k, v).map_err(NookError::from)?;
    }
    write_sentinel(&mut crc).map_err(NookError::from)?;
    crc.finish().map_err(NookError::from)?;

    Ok(BackupStats {
        entry_count: entries.len() as u64,
        bytes_written: counting.count as u64,
    })
}

struct CountingWriter<'a, W: std::io::Write> {
    inner: &'a mut W,
    count: usize,
}

impl<W: std::io::Write> std::io::Write for CountingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Reads a `.nbkp` v1 stream from `r` into `db` according to `opts`.
///
/// Validates magic, format version, and CRC32 footer. Schema-hash and
/// overwrite checks are applied before any data is written; the redb
/// write transaction is atomic (rolled back on any failure).
///
/// # Errors
///
/// `NookError::Corruption` for format problems (magic, version, CRC,
/// truncation). `NookError::Schema` for schema-hash mismatch.
/// `NookError::Conflict` for non-empty target without `allow_overwrite`.
/// `NookError::Storage` for I/O failures.
pub fn read_backup<R: std::io::Read>(
    db: &Database,
    r: &mut R,
    opts: RestoreOptions,
) -> Result<RestoreStats, NookError> {
    let mut counting = CountingReader { inner: r, count: 0 };
    let mut crc = CrcReader::new(&mut counting);
    let header = BackupHeader::read_from(&mut crc)?;
    if !opts.skip_schema_check {
        if let (Some(bh), Some(ch)) = (header.schema_hash, opts.current_schema_hash) {
            if bh != ch {
                return Err(NookError::Schema {
                    msg: "backup schema hash mismatch".into(),
                });
            }
        }
    }

    let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    loop {
        match read_entry(&mut crc)? {
            ReadEntry::Sentinel => break,
            ReadEntry::Entry { key, value } => entries.push((key, value)),
        }
    }
    crc.finish_and_verify()?;

    db.write(|tx| {
        if opts.allow_overwrite {
            tx.clear_entries()?;
        } else if tx.has_any_entry()? {
            return Err(NookError::Conflict {
                msg: "restore target not empty".into(),
            });
        }
        for (k, v) in &entries {
            tx.put_raw(k, v)?;
        }
        Ok(())
    })?;

    let bytes_read = u64::try_from(counting.count).unwrap_or(u64::MAX);
    let entry_count = u64::try_from(entries.len()).unwrap_or(u64::MAX);
    Ok(RestoreStats {
        entry_count,
        bytes_read,
    })
}

struct CountingReader<'a, R: std::io::Read> {
    inner: &'a mut R,
    count: usize,
}

impl<R: std::io::Read> std::io::Read for CountingReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count += n;
        Ok(n)
    }
}

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write as _};

/// Writes a backup to `path` atomically: first to `<path>.tmp`, then
/// fsync, then rename.
///
/// On success the original `path` contains the complete backup and no
/// leftover `.tmp` file remains.
///
/// # Errors
///
/// Same as [`write_backup`], plus filesystem errors for tmp creation,
/// fsync, or rename.
pub fn backup_to_path(
    db: &Database,
    path: &Path,
    schema_hash: Option<[u8; 32]>,
) -> Result<BackupStats, NookError> {
    let tmp_path = path.with_extension(path.extension().map_or_else(
        || "tmp".to_string(),
        |e| format!("{}.tmp", e.to_string_lossy()),
    ));
    let stats = {
        let file = File::create(&tmp_path).map_err(NookError::from)?;
        let mut bw = BufWriter::new(file);
        let stats = write_backup(db, &mut bw, schema_hash)?;
        let mut file = bw
            .into_inner()
            .map_err(|e| NookError::from(std::io::Error::other(format!("flush tmp: {e}"))))?;
        file.flush().map_err(NookError::from)?;
        file.sync_all().map_err(NookError::from)?;
        stats
    };
    fs::rename(&tmp_path, path).map_err(NookError::from)?;
    Ok(stats)
}

/// Reads a backup file at `path` and restores it into `db` per `opts`.
///
/// # Errors
///
/// Same as [`read_backup`], plus filesystem errors for opening `path`.
pub fn restore_from_path(
    db: &Database,
    path: &Path,
    opts: RestoreOptions,
) -> Result<RestoreStats, NookError> {
    let file = File::open(path).map_err(NookError::from)?;
    let mut br = BufReader::new(file);
    read_backup(db, &mut br, opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BackupHeader {
        BackupHeader {
            format_ver: FORMAT_VER,
            created_ms: 1_700_000_000_000,
            schema_hash: Some([7u8; 32]),
            redb_marker: REDB_MARKER,
            entry_count_hint: 42,
        }
    }

    #[test]
    fn header_roundtrip_with_schema_hash() {
        let h = sample();
        let mut buf = Vec::new();
        h.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), BackupHeader::SIZE);
        let read = BackupHeader::read_from(&mut buf.as_slice()).unwrap();
        assert_eq!(read, h);
    }

    #[test]
    fn header_roundtrip_without_schema_hash() {
        let h = BackupHeader {
            schema_hash: None,
            ..sample()
        };
        let mut buf = Vec::new();
        h.write_to(&mut buf).unwrap();
        let read = BackupHeader::read_from(&mut buf.as_slice()).unwrap();
        assert_eq!(read, h);
        assert!(read.schema_hash.is_none());
    }

    #[test]
    fn header_rejects_bad_magic() {
        let mut buf = Vec::new();
        sample().write_to(&mut buf).unwrap();
        buf[0] = b'X';
        let err = BackupHeader::read_from(&mut buf.as_slice()).unwrap_err();
        match err {
            crate::error::NookError::Corruption { msg } => {
                assert!(msg.contains("invalid backup magic"), "msg={msg}");
            }
            other => panic!("expected Corruption, got {other:?}"),
        }
    }

    #[test]
    fn header_rejects_unknown_format_version() {
        let mut buf = Vec::new();
        sample().write_to(&mut buf).unwrap();
        buf[8] = 0; // high byte
        buf[9] = 2; // low byte → format_ver=2 (BE)
        let err = BackupHeader::read_from(&mut buf.as_slice()).unwrap_err();
        match err {
            crate::error::NookError::Corruption { msg } => assert!(
                msg.contains("unsupported backup format version 2"),
                "msg={msg}"
            ),
            other => panic!("expected Corruption, got {other:?}"),
        }
    }

    #[test]
    fn header_truncated_yields_corruption() {
        let mut buf = Vec::new();
        sample().write_to(&mut buf).unwrap();
        buf.truncate(BackupHeader::SIZE - 1);
        let err = BackupHeader::read_from(&mut buf.as_slice()).unwrap_err();
        match err {
            crate::error::NookError::Corruption { msg } => {
                assert!(msg.contains("truncated"), "msg={msg}");
            }
            other => panic!("expected Corruption, got {other:?}"),
        }
    }

    #[test]
    fn entry_roundtrip() {
        let mut buf = Vec::new();
        write_entry(&mut buf, b"users\0alice", b"value-a").unwrap();
        write_entry(&mut buf, b"posts\0p1", b"hello").unwrap();
        write_sentinel(&mut buf).unwrap();
        let mut r = buf.as_slice();
        match read_entry(&mut r).unwrap() {
            ReadEntry::Entry { key, value } => {
                assert_eq!(key, b"users\0alice");
                assert_eq!(value, b"value-a");
            }
            ReadEntry::Sentinel => panic!("expected entry"),
        }
        match read_entry(&mut r).unwrap() {
            ReadEntry::Entry { key, value } => {
                assert_eq!(key, b"posts\0p1");
                assert_eq!(value, b"hello");
            }
            ReadEntry::Sentinel => panic!("expected entry"),
        }
        assert!(matches!(read_entry(&mut r).unwrap(), ReadEntry::Sentinel));
    }

    #[test]
    fn entry_truncated_after_key_len_is_corruption() {
        // 4 bytes of key_len = 5, then EOF before the key body.
        let buf = [0u8, 0u8, 0u8, 5u8];
        let err = read_entry(&mut buf.as_slice()).unwrap_err();
        match err {
            crate::error::NookError::Corruption { msg } => {
                assert!(msg.contains("truncated"), "msg={msg}");
            }
            other => panic!("expected Corruption, got {other:?}"),
        }
    }

    #[test]
    fn entry_empty_value_roundtrip() {
        let mut buf = Vec::new();
        write_entry(&mut buf, b"k", b"").unwrap();
        write_sentinel(&mut buf).unwrap();
        let mut r = buf.as_slice();
        match read_entry(&mut r).unwrap() {
            ReadEntry::Entry { key, value } => {
                assert_eq!(key, b"k");
                assert!(value.is_empty());
            }
            ReadEntry::Sentinel => panic!("expected entry"),
        }
    }

    #[test]
    fn crc_roundtrip_clean() {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = CrcWriter::new(&mut buf);
            sample().write_to(&mut w).unwrap();
            write_entry(&mut w, b"k", b"v").unwrap();
            write_sentinel(&mut w).unwrap();
            let (_inner, _sum) = w.finish().unwrap();
        }
        let mut r = CrcReader::new(buf.as_slice());
        let _hdr = BackupHeader::read_from(&mut r).unwrap();
        match read_entry(&mut r).unwrap() {
            ReadEntry::Entry { .. } => {}
            ReadEntry::Sentinel => panic!("expected entry"),
        }
        assert!(matches!(read_entry(&mut r).unwrap(), ReadEntry::Sentinel));
        r.finish_and_verify().unwrap();
    }

    #[test]
    fn crc_byte_flip_in_payload_detected() {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = CrcWriter::new(&mut buf);
            sample().write_to(&mut w).unwrap();
            write_entry(&mut w, b"k", b"v").unwrap();
            write_sentinel(&mut w).unwrap();
            w.finish().unwrap();
        }
        // Flip one byte of the entry value (after the header).
        buf[BackupHeader::SIZE + 4 + 1 + 4] ^= 0x55;
        let mut r = CrcReader::new(buf.as_slice());
        let _hdr = BackupHeader::read_from(&mut r).unwrap();
        // The corrupted value may still parse as an entry; we expect the
        // CRC verify at the end to detect the corruption.
        let _ = read_entry(&mut r);
        let _ = read_entry(&mut r);
        let err = r.finish_and_verify().unwrap_err();
        match err {
            crate::error::NookError::Corruption { msg } => {
                assert!(msg.contains("checksum"), "msg={msg}");
            }
            other => panic!("expected Corruption, got {other:?}"),
        }
    }

    use proptest::prelude::*;

    proptest! {
        #[test]
        fn write_then_read_roundtrips_random_entries(
            entries in proptest::collection::vec(
                (proptest::collection::vec(any::<u8>(), 1..32),
                 proptest::collection::vec(any::<u8>(), 0..128)),
                0..50,
            )
        ) {
            let mut buf: Vec<u8> = Vec::new();
            {
                let mut w = CrcWriter::new(&mut buf);
                BackupHeader {
                    format_ver: FORMAT_VER,
                    created_ms: 1,
                    schema_hash: None,
                    redb_marker: REDB_MARKER,
                    entry_count_hint: entries.len() as u64,
                }.write_to(&mut w).unwrap();
                for (k, v) in &entries {
                    write_entry(&mut w, k, v).unwrap();
                }
                write_sentinel(&mut w).unwrap();
                w.finish().unwrap();
            }
            let mut r = CrcReader::new(buf.as_slice());
            let _hdr = BackupHeader::read_from(&mut r).unwrap();
            let mut read = Vec::new();
            loop {
                match read_entry(&mut r).unwrap() {
                    ReadEntry::Sentinel => break,
                    ReadEntry::Entry { key, value } => read.push((key, value)),
                }
            }
            r.finish_and_verify().unwrap();
            prop_assert_eq!(read, entries);
        }
    }
}
