//! The seam between the sync engine and a storage provider.
//!
//! The engine owns everything that must behave the same for every provider:
//! checksums (it computes every SHA-256 and passes it in), multipart
//! bookkeeping and resume (`sync_multipart`/`sync_part`), retries, backoff,
//! error handling by [`ErrorClass`], tombstones, the daily index and
//! encryption. A provider only moves bytes:
//!
//! - [`super::s3::S3Target`]: presigned SigV4 to any S3-compatible bucket, with
//!   static credentials (`sync.provider = "s3"`) or credentials from an issuer
//!   (`"kortix"`, see `issuer.rs`). It is the only provider the app ships.
//! - Tests implement the trait over memory or a directory.
//!
//! Per item the engine calls the puts (`put_bytes`, `put_file`, or
//! `create_multipart` / `upload_part` / `complete_multipart`), then `head` on
//! each object to verify its size, the manifest last.
//!
//! Errors: return a [`TargetError`] with the right class (auth and config
//! stop the pass; transient and integrity back off per chunk) and status 404
//! for a missing object. A request that never got a response may return the
//! raw `reqwest::Error`; [`classify`] treats it as transient.

use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    /// 401/403: wrong or revoked credentials.
    Auth,
    /// Bad endpoint, bucket, region or request (most other 4xx), missing settings or key.
    Config,
    /// The local clock is too far off and the server gave no usable `Date`.
    ClockSkew,
    /// 5xx, 408, 429, timeouts, connection errors.
    Transient,
    /// The server computed a different checksum or size than the one sent.
    Integrity,
    /// Reading a local file failed.
    Local,
}

impl ErrorClass {
    /// Auth, config and clock errors fail every chunk the same way, so they stop the pass.
    pub fn halts(self) -> bool {
        matches!(self, Self::Auth | Self::Config | Self::ClockSkew)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Config => "config",
            Self::ClockSkew => "clock_skew",
            Self::Transient => "transient",
            Self::Integrity => "integrity",
            Self::Local => "local",
        }
    }
}

#[derive(Debug)]
pub struct TargetError {
    pub class: ErrorClass,
    /// HTTP status, or 0 when the error is not from a response.
    pub status: u16,
    pub code: String,
    pub message: String,
    pub op: String,
}

impl fmt::Display for TargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.status == 0 {
            write!(f, "{}: {}", self.op, self.message)
        } else {
            write!(
                f,
                "{}: HTTP {} {} {}",
                self.op, self.status, self.code, self.message
            )
        }
    }
}

impl std::error::Error for TargetError {}

impl TargetError {
    pub fn new(
        class: ErrorClass,
        status: u16,
        code: impl Into<String>,
        message: impl Into<String>,
        op: impl Into<String>,
    ) -> anyhow::Error {
        Self {
            class,
            status,
            code: code.into(),
            message: message.into(),
            op: op.into(),
        }
        .into()
    }
}

/// The class of the first target, HTTP or I/O error in the chain. A request
/// that never got a response (DNS, refused, reset, timeout) is transient.
pub fn classify(err: &anyhow::Error) -> ErrorClass {
    for cause in err.chain() {
        if let Some(e) = cause.downcast_ref::<TargetError>() {
            return e.class;
        }
        if cause.is::<reqwest::Error>() {
            return ErrorClass::Transient;
        }
        if cause.is::<std::io::Error>() {
            return ErrorClass::Local;
        }
    }
    ErrorClass::Transient
}

/// Like [`classify`], but `None` when no cause is a target, network or file error.
pub fn classify_known(err: &anyhow::Error) -> Option<ErrorClass> {
    err.chain().any(|c| {
        c.is::<TargetError>() || c.is::<reqwest::Error>() || c.is::<std::io::Error>()
    }).then(|| classify(err))
}

/// True when the error is a 404 (missing object or multipart upload).
pub fn is_not_found(err: &anyhow::Error) -> bool {
    err.chain().any(|c| {
        c.downcast_ref::<TargetError>()
            .is_some_and(|e| e.status == 404)
    })
}

fn unsupported(op: &str) -> anyhow::Error {
    TargetError::new(
        ErrorClass::Config,
        0,
        "Unsupported",
        "this sync provider has no multipart upload",
        op,
    )
}

/// A finished multipart part.
#[derive(Debug, Clone)]
pub struct CompletedPart {
    pub number: u16,
    pub etag: String,
    /// Base64 SHA-256 of the part, as sent.
    pub sha256_b64: String,
}

pub trait UploadTarget: Send + Sync {
    /// A short name for logs (`s3`).
    fn provider(&self) -> &'static str;
    /// Full key of a name relative to the device root (`<device>/...`).
    fn key(&self, rel: &str) -> String;
    /// Inverse of [`UploadTarget::key`].
    fn rel<'k>(&self, key: &'k str) -> &'k str;
    /// Files larger than this go multipart, in parts of this size. `u64::MAX`: never.
    fn part_size(&self) -> u64 {
        u64::MAX
    }
    /// Request-body bytes sent so far (throughput and resume accounting).
    fn bytes_sent(&self) -> u64;
    /// Clock offset the target learned from the server, in ms.
    fn clock_offset_ms(&self) -> i64 {
        0
    }

    /// Store `body` under `key`; reject it unless its SHA-256 is `sha256`.
    fn put_bytes(
        &self,
        key: &str,
        body: &[u8],
        content_type: &str,
        sha256: &[u8; 32],
    ) -> Result<()>;
    /// Store `len` bytes of `file` under `key`, streamed; reject unless its SHA-256 is `sha256`.
    fn put_file(
        &self,
        key: &str,
        file: &Path,
        len: u64,
        sha256: &[u8; 32],
        content_type: &str,
    ) -> Result<()>;
    /// Start a multipart upload; returns its id.
    fn create_multipart(&self, _key: &str, _content_type: &str) -> Result<String> {
        Err(unsupported("create_multipart"))
    }
    /// Upload part `n` (`len` bytes of `file` from `offset`, SHA-256 `sha256`); returns its ETag.
    #[allow(clippy::too_many_arguments)]
    fn upload_part(
        &self,
        _key: &str,
        _upload_id: &str,
        _n: u16,
        _file: &Path,
        _offset: u64,
        _len: u64,
        _sha256: &[u8; 32],
    ) -> Result<String> {
        Err(unsupported("upload_part"))
    }
    fn complete_multipart(
        &self,
        _key: &str,
        _upload_id: &str,
        _parts: &[CompletedPart],
    ) -> Result<()> {
        Err(unsupported("complete_multipart"))
    }
    /// Abort a multipart upload; a missing upload is not an error.
    fn abort_multipart(&self, _key: &str, _upload_id: &str) -> Result<()> {
        Ok(())
    }
    /// Object size, or None when it does not exist.
    fn head(&self, key: &str) -> Result<Option<u64>>;
    /// Delete an object; a missing object is not an error.
    fn delete(&self, key: &str) -> Result<()>;
    /// Whole object, or None when it does not exist.
    fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>>;
    /// Download to `out`; returns (size, SHA-256) of the bytes received.
    fn get_to_file(&self, key: &str, out: &Path) -> Result<(u64, [u8; 32])>;
    /// Keys and sizes under `prefix`, or with `delimiter` the prefixes one level below it.
    fn list(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
    ) -> Result<(Vec<(String, u64)>, Vec<String>)>;

    /// PUT, HEAD and DELETE a probe object; proves the target and credentials.
    fn probe(&self, device: &str) -> Result<Duration> {
        let t0 = Instant::now();
        let key = self.key(&format!(
            "{device}/.probe-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let body = b"kortix-capture probe";
        self.put_bytes(&key, body, "text/plain", &Sha256::digest(body).into())?;
        let size = self.head(&key)?;
        self.delete(&key)?;
        if size != Some(body.len() as u64) {
            anyhow::bail!(
                "probe object read back with size {size:?}, expected {}",
                body.len()
            );
        }
        Ok(t0.elapsed())
    }
}

pub fn sha256_b64(digest: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(digest)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of `len` bytes of `file` from `offset`.
pub fn sha256_range(file: &Path, offset: u64, len: u64) -> Result<[u8; 32]> {
    let mut f = std::fs::File::open(file)
        .map_err(|e| anyhow::Error::from(e).context(format!("open {}", file.display())))?;
    f.seek(SeekFrom::Start(offset))?;
    let mut h = Sha256::new();
    std::io::copy(&mut f.take(len), &mut h)?;
    Ok(h.finalize().into())
}

/// Size and SHA-256 of a whole file.
pub fn file_digest(file: &Path) -> Result<(u64, [u8; 32])> {
    let len = std::fs::metadata(file)
        .map_err(|e| anyhow::Error::from(e).context(format!("stat {}", file.display())))?
        .len();
    Ok((len, sha256_range(file, 0, len)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_walks_the_error_chain() {
        let e = TargetError::new(ErrorClass::Auth, 403, "AccessDenied", "", "PUT k");
        assert_eq!(classify(&e.context("upload chunk 7")), ErrorClass::Auth);
        let io: anyhow::Error = std::io::Error::new(std::io::ErrorKind::NotFound, "gone").into();
        assert_eq!(classify(&io.context("read video")), ErrorClass::Local);
        assert!(is_not_found(&TargetError::new(
            ErrorClass::Config,
            404,
            "NoSuchUpload",
            "",
            "x"
        )));
        assert!(
            ErrorClass::Auth.halts() && ErrorClass::Config.halts() && ErrorClass::ClockSkew.halts()
        );
        assert!(
            !ErrorClass::Transient.halts()
                && !ErrorClass::Integrity.halts()
                && !ErrorClass::Local.halts()
        );
        assert_eq!(
            TargetError::new(ErrorClass::Config, 0, "Config", "no key", "sync").to_string(),
            "sync: no key"
        );
        assert_eq!(
            TargetError::new(ErrorClass::Auth, 403, "AccessDenied", "denied", "PUT k").to_string(),
            "PUT k: HTTP 403 AccessDenied denied"
        );
    }

    /// A provider with only the required methods gets probe and refuses multipart.
    struct Mem(std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>);
    impl UploadTarget for Mem {
        fn provider(&self) -> &'static str {
            "mem"
        }
        fn key(&self, rel: &str) -> String {
            rel.into()
        }
        fn rel<'k>(&self, key: &'k str) -> &'k str {
            key
        }
        fn bytes_sent(&self) -> u64 {
            0
        }
        fn put_bytes(&self, key: &str, body: &[u8], _: &str, sha256: &[u8; 32]) -> Result<()> {
            if <[u8; 32]>::from(Sha256::digest(body)) != *sha256 {
                return Err(TargetError::new(
                    ErrorClass::Integrity,
                    400,
                    "BadDigest",
                    "",
                    key,
                ));
            }
            self.0.lock().unwrap().insert(key.into(), body.to_vec());
            Ok(())
        }
        fn put_file(
            &self,
            key: &str,
            file: &Path,
            _: u64,
            sha256: &[u8; 32],
            ct: &str,
        ) -> Result<()> {
            self.put_bytes(key, &std::fs::read(file)?, ct, sha256)
        }
        fn head(&self, key: &str) -> Result<Option<u64>> {
            Ok(self.0.lock().unwrap().get(key).map(|b| b.len() as u64))
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
        fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn get_to_file(&self, key: &str, out: &Path) -> Result<(u64, [u8; 32])> {
            let b = self
                .get_bytes(key)?
                .ok_or_else(|| TargetError::new(ErrorClass::Config, 404, "NoSuchKey", "", key))?;
            std::fs::write(out, &b)?;
            Ok((b.len() as u64, Sha256::digest(&b).into()))
        }
        fn list(&self, prefix: &str, _: Option<&str>) -> Result<(Vec<(String, u64)>, Vec<String>)> {
            Ok((
                self.0
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(k, _)| k.starts_with(prefix))
                    .map(|(k, v)| (k.clone(), v.len() as u64))
                    .collect(),
                vec![],
            ))
        }
    }

    /// The device can write its own folder, so a `policy.json` there must never
    /// replace the account policy (its mandatory exclusions and its pause).
    #[test]
    fn a_policy_in_the_device_folder_is_ignored() {
        let m = Mem(Default::default());
        let put = |k: &str, body: &str| {
            m.put_bytes(
                k,
                body.as_bytes(),
                "application/json",
                &Sha256::digest(body.as_bytes()).into(),
            )
            .unwrap()
        };
        put(
            "dev/policy.json",
            r#"{"schema":2,"recording":{"paused":false}}"#,
        );
        assert!(crate::memory::sync::fetch_policy(&m).unwrap().is_none());
        put("policy.json", r#"{"schema":2,"recording":{"paused":true}}"#);
        let got = crate::memory::sync::fetch_policy(&m).unwrap().unwrap();
        assert_eq!(got.source, "policy.json");
        assert!(got.policy.recording.paused);
    }

    #[test]
    fn a_minimal_provider_probes_and_has_no_multipart() {
        let m = Mem(Default::default());
        m.probe("dev").unwrap();
        assert!(
            m.list("", None).unwrap().0.is_empty(),
            "the probe object is deleted"
        );
        assert_eq!(m.part_size(), u64::MAX);
        assert_eq!(
            classify(&m.create_multipart("k", "x").unwrap_err()),
            ErrorClass::Config
        );
    }
}
