//! The `s3` sync provider: presigned SigV4 requests (rusty-s3) sent with
//! blocking reqwest to any S3-compatible bucket.
//!
//! - Every PUT and UploadPart signs an `x-amz-checksum-sha256` header, so the
//!   server rejects a body that does not match it (`400 BadDigest`). AWS S3,
//!   R2, MinIO and versitygw enforce it.
//! - Bodies stream from disk; a shared token bucket caps upload bandwidth.
//! - A 401/403 whose `Date` header is more than 5 min from the local clock is
//!   retried once with the clock offset applied (clock-skew tolerance).
//! - Errors are [`TargetError`]s classed by status and S3 error code.

pub use super::target::{
    classify, file_digest, hex, is_not_found, sha256_b64, sha256_range, ErrorClass, TargetError,
};
use super::target::{CompletedPart, UploadTarget};
use anyhow::{anyhow, Context, Result};
use reqwest::blocking::{Body, Client, Response};
use rusty_s3::{
    actions::{
        AbortMultipartUpload, CompleteMultipartUpload, CreateMultipartUpload, DeleteObject,
        GetObject, HeadObject, ListObjectsV2, PutObject, UploadPart,
    },
    Bucket, Credentials, S3Action, UrlStyle,
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const SIGN_TTL: Duration = Duration::from_secs(900);
/// S3's minimum part size (except the last part).
pub const MIN_PART: u64 = 5 * 1024 * 1024;
/// A signature this far from the server clock is treated as clock skew.
const SKEW_TOLERANCE_MS: i64 = 5 * 60_000;
const READ_CHUNK: usize = 64 * 1024;

fn class_for(status: u16, code: &str) -> ErrorClass {
    match (status, code) {
        (_, "RequestTimeTooSkewed") => ErrorClass::ClockSkew,
        (_, "BadDigest" | "InvalidDigest" | "XAmzContentSHA256Mismatch" | "IncompleteBody") => {
            ErrorClass::Integrity
        }
        (_, "SlowDown" | "RequestTimeout" | "InternalError" | "ServiceUnavailable") => {
            ErrorClass::Transient
        }
        (401 | 403, _) => ErrorClass::Auth,
        (408 | 429 | 500..=599, _) => ErrorClass::Transient,
        _ => ErrorClass::Config,
    }
}

fn xml_tag(body: &str, tag: &str) -> String {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    body.split_once(&open)
        .and_then(|(_, rest)| rest.split_once(&close))
        .map(|(v, _)| v.trim().to_string())
        .unwrap_or_default()
}

/// Shared upload bandwidth cap: callers reserve bytes and sleep until their slot.
pub struct Throttle {
    bytes_per_sec: f64,
    next: Mutex<Instant>,
}

impl Throttle {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            bytes_per_sec: bytes_per_sec.max(1) as f64,
            next: Mutex::new(Instant::now()),
        }
    }
    fn take(&self, n: usize) {
        let wait = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let start = (*next).max(now);
            *next = start + Duration::from_secs_f64(n as f64 / self.bytes_per_sec);
            start.saturating_duration_since(now)
        };
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
    }
}

/// Counts (and throttles) bytes as reqwest reads a body.
pub(super) struct Metered<R> {
    pub(super) inner: R,
    pub(super) throttle: Option<Arc<Throttle>>,
    pub(super) sent: Arc<AtomicU64>,
}

impl<R: Read> Read for Metered<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let cap = buf.len().min(READ_CHUNK);
        let n = self.inner.read(&mut buf[..cap])?;
        if let Some(t) = &self.throttle {
            t.take(n);
        }
        self.sent.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

pub struct S3Target {
    bucket: Bucket,
    creds: Credentials,
    prefix: String,
    http: Client,
    /// Server clock minus local clock, learned from a skew rejection.
    skew_ms: AtomicI64,
    throttle: Option<Arc<Throttle>>,
    /// Bytes of request bodies sent (single PUTs and parts).
    sent: Arc<AtomicU64>,
    /// Files above this size upload as multipart, in parts of this size.
    part: u64,
}

impl S3Target {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        endpoint: &str,
        bucket: &str,
        region: &str,
        prefix: &str,
        path_style: bool,
        access_key_id: &str,
        secret_access_key: &str,
        session_token: Option<&str>,
    ) -> Result<Self> {
        if endpoint.trim().is_empty() || bucket.trim().is_empty() {
            anyhow::bail!("sync needs an endpoint and a bucket (kortix-capture sync setup)");
        }
        let mut endpoint =
            url::Url::parse(endpoint.trim()).with_context(|| format!("bad endpoint {endpoint}"))?;
        // rusty-s3 joins the bucket onto the endpoint; without a trailing slash `Url::join`
        // drops the last path segment (`…/storage/v1/s3` became `…/storage/v1/<bucket>`).
        if !endpoint.path().ends_with('/') {
            let path = format!("{}/", endpoint.path());
            endpoint.set_path(&path);
        }
        let style = if path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(
            endpoint,
            style,
            bucket.trim().to_string(),
            region.trim().to_string(),
        )?;
        let creds = match session_token {
            Some(token) => Credentials::new_with_token(access_key_id, secret_access_key, token),
            None => Credentials::new(access_key_id, secret_access_key),
        };
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // A part at a low bandwidth cap can take minutes; reqwest's timeout covers the whole exchange.
            .timeout(Duration::from_secs(1800))
            .user_agent(super::user_agent())
            .build()?;
        Ok(Self {
            bucket,
            creds,
            prefix: prefix.trim_matches('/').to_string(),
            http,
            skew_ms: AtomicI64::new(0),
            throttle: None,
            sent: Arc::new(AtomicU64::new(0)),
            part: 16 * 1024 * 1024,
        })
    }

    /// Cap upload bandwidth (bytes per second); 0 removes the cap.
    pub fn with_bandwidth(mut self, bytes_per_sec: u64) -> Self {
        self.throttle = (bytes_per_sec > 0).then(|| Arc::new(Throttle::new(bytes_per_sec)));
        self
    }

    pub fn with_part_size(mut self, bytes: u64) -> Self {
        self.part = bytes.max(MIN_PART);
        self
    }

    /// Pretend the local clock is off by `ms` (tests).
    pub fn with_clock_offset(self, ms: i64) -> Self {
        self.skew_ms.store(ms, Ordering::SeqCst);
        self
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    fn signing_time(&self) -> time::OffsetDateTime {
        time::OffsetDateTime::now_utc()
            + time::Duration::milliseconds(self.skew_ms.load(Ordering::SeqCst))
    }

    /// Sign with `sign`, send, and map a non-2xx answer to a [`TargetError`].
    /// `headers` are signed into the URL and sent as real headers.
    fn send(
        &self,
        op: &str,
        method: reqwest::Method,
        sign: &dyn Fn(&time::OffsetDateTime, &[(&'static str, String)]) -> url::Url,
        headers: &[(&'static str, String)],
        body: &dyn Fn() -> Result<Option<Body>>,
    ) -> Result<Response> {
        for attempt in 0..2 {
            let url = sign(&self.signing_time(), headers);
            let mut req = self.http.request(method.clone(), url);
            for (k, v) in headers {
                req = req.header(*k, v);
            }
            if let Some(b) = body()? {
                req = req.body(b);
            }
            // A presigned URL carries the signature and any session token: keep it out of
            // the error, which reaches sync.json, the log, the CLI and the settings window.
            let resp = req
                .send()
                .map_err(reqwest::Error::without_url)
                .with_context(|| op.to_string())?;
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                return Ok(resp);
            }
            let server_ms = resp
                .headers()
                .get(reqwest::header::DATE)
                .and_then(|v| v.to_str().ok())
                .and_then(|d| chrono::DateTime::parse_from_rfc2822(d).ok())
                .map(|d| d.timestamp_millis());
            let text = resp.text().unwrap_or_default();
            let code = xml_tag(&text, "Code");
            let mut class = class_for(status, &code);
            // A rejected signature from a clock far off the server's: adopt the server clock once.
            if matches!(status, 401 | 403) || class == ErrorClass::ClockSkew {
                if let Some(server) = server_ms {
                    let local = self.signing_time().unix_timestamp_nanos() as i64 / 1_000_000;
                    let off = server - local;
                    if off.abs() > SKEW_TOLERANCE_MS {
                        if attempt == 0 {
                            tracing::warn!(offset_ms = off, "sync: local clock is off from the S3 server; signing with the server clock");
                            self.skew_ms.fetch_add(off, Ordering::SeqCst);
                            continue;
                        }
                        class = ErrorClass::ClockSkew;
                    }
                }
            }
            let message: String = xml_tag(&text, "Message").chars().take(300).collect();
            return Err(TargetError::new(class, status, code, message, op));
        }
        unreachable!("the loop returns or continues once")
    }

    fn signer<'s, A: S3Action<'s>>(
        mut action: A,
        at: &time::OffsetDateTime,
        headers: &[(&'static str, String)],
    ) -> url::Url {
        for (k, v) in headers {
            action.headers_mut().insert(*k, v.clone());
        }
        action.sign_with_time(SIGN_TTL, at)
    }

    fn file_body(&self, file: &Path, offset: u64, len: u64) -> Result<Option<Body>> {
        let mut f =
            std::fs::File::open(file).with_context(|| format!("open {}", file.display()))?;
        f.seek(SeekFrom::Start(offset))?;
        let reader = Metered {
            inner: f.take(len),
            throttle: self.throttle.clone(),
            sent: self.sent.clone(),
        };
        Ok(Some(Body::sized(reader, len)))
    }

    fn get(&self, key: &str) -> Result<Response> {
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(GetObject::new(&self.bucket, Some(&self.creds), key), at, h)
        };
        self.send(
            &format!("GET {key}"),
            reqwest::Method::GET,
            &sign,
            &[],
            &|| Ok(None),
        )
    }
}

impl UploadTarget for S3Target {
    fn provider(&self) -> &'static str {
        "s3"
    }

    /// `<prefix>/<rel>`, or `<rel>` without a prefix.
    fn key(&self, rel: &str) -> String {
        if self.prefix.is_empty() {
            rel.to_string()
        } else {
            format!("{}/{rel}", self.prefix)
        }
    }

    fn rel<'k>(&self, key: &'k str) -> &'k str {
        if self.prefix.is_empty() {
            key
        } else {
            key.strip_prefix(&self.prefix)
                .and_then(|k| k.strip_prefix('/'))
                .unwrap_or(key)
        }
    }

    fn part_size(&self) -> u64 {
        self.part
    }

    fn bytes_sent(&self) -> u64 {
        self.sent.load(Ordering::Relaxed)
    }

    fn clock_offset_ms(&self) -> i64 {
        self.skew_ms.load(Ordering::SeqCst)
    }

    /// PUT from memory with `x-amz-checksum-sha256` signed in.
    fn put_bytes(
        &self,
        key: &str,
        body: &[u8],
        content_type: &str,
        sha256: &[u8; 32],
    ) -> Result<()> {
        let headers = [
            ("content-type", content_type.to_string()),
            ("x-amz-checksum-sha256", sha256_b64(sha256)),
        ];
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(PutObject::new(&self.bucket, Some(&self.creds), key), at, h)
        };
        let body = || {
            if let Some(t) = &self.throttle {
                t.take(body.len());
            }
            self.sent.fetch_add(body.len() as u64, Ordering::Relaxed);
            Ok(Some(Body::from(body.to_vec())))
        };
        self.send(
            &format!("PUT {key}"),
            reqwest::Method::PUT,
            &sign,
            &headers,
            &body,
        )?;
        Ok(())
    }

    /// PUT a whole file in one request, streamed from disk, with its checksum.
    fn put_file(
        &self,
        key: &str,
        file: &Path,
        len: u64,
        sha256: &[u8; 32],
        content_type: &str,
    ) -> Result<()> {
        let headers = [
            ("content-type", content_type.to_string()),
            ("x-amz-checksum-sha256", sha256_b64(sha256)),
        ];
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(PutObject::new(&self.bucket, Some(&self.creds), key), at, h)
        };
        self.send(
            &format!("PUT {key}"),
            reqwest::Method::PUT,
            &sign,
            &headers,
            &|| self.file_body(file, 0, len),
        )?;
        Ok(())
    }

    /// Start a multipart upload whose parts carry SHA-256 checksums.
    fn create_multipart(&self, key: &str, content_type: &str) -> Result<String> {
        let headers = [
            ("content-type", content_type.to_string()),
            ("x-amz-checksum-algorithm", "SHA256".to_string()),
        ];
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(
                CreateMultipartUpload::new(&self.bucket, Some(&self.creds), key),
                at,
                h,
            )
        };
        let text = self
            .send(
                &format!("CreateMultipartUpload {key}"),
                reqwest::Method::POST,
                &sign,
                &headers,
                &|| Ok(None),
            )?
            .text()?;
        let parsed = CreateMultipartUpload::parse_response(&text)
            .map_err(|e| anyhow!("CreateMultipartUpload {key}: {e}"))?;
        Ok(parsed.upload_id().to_string())
    }

    fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        n: u16,
        file: &Path,
        offset: u64,
        len: u64,
        sha256: &[u8; 32],
    ) -> Result<String> {
        let headers = [("x-amz-checksum-sha256", sha256_b64(sha256))];
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(
                UploadPart::new(&self.bucket, Some(&self.creds), key, n, upload_id),
                at,
                h,
            )
        };
        let resp = self.send(
            &format!("UploadPart {key} #{n}"),
            reqwest::Method::PUT,
            &sign,
            &headers,
            &|| self.file_body(file, offset, len),
        )?;
        let etag = resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if etag.is_empty() {
            anyhow::bail!("UploadPart {key} #{n}: no ETag in the response");
        }
        Ok(etag)
    }

    fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> Result<()> {
        let esc = |s: &str| {
            s.replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        let mut xml = String::from("<CompleteMultipartUpload>");
        for p in parts {
            xml.push_str(&format!(
                "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag><ChecksumSHA256>{}</ChecksumSHA256></Part>",
                p.number,
                esc(&p.etag),
                p.sha256_b64
            ));
        }
        xml.push_str("</CompleteMultipartUpload>");
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(
                CompleteMultipartUpload::new(
                    &self.bucket,
                    Some(&self.creds),
                    key,
                    upload_id,
                    std::iter::empty::<&str>(),
                ),
                at,
                h,
            )
        };
        let headers = [("content-type", "application/xml".to_string())];
        let resp = self.send(
            &format!("CompleteMultipartUpload {key}"),
            reqwest::Method::POST,
            &sign,
            &headers,
            &|| Ok(Some(Body::from(xml.clone()))),
        )?;
        // S3 can answer 200 with an error document after a slow assembly.
        let text = resp.text().unwrap_or_default();
        if text.contains("<Error>") {
            let code = xml_tag(&text, "Code");
            let status = if code == "NoSuchUpload" { 404 } else { 500 };
            return Err(TargetError::new(
                class_for(status, &code),
                status,
                code,
                xml_tag(&text, "Message"),
                format!("CompleteMultipartUpload {key}"),
            ));
        }
        Ok(())
    }

    fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()> {
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(
                AbortMultipartUpload::new(&self.bucket, Some(&self.creds), key, upload_id),
                at,
                h,
            )
        };
        match self.send(
            &format!("AbortMultipartUpload {key}"),
            reqwest::Method::DELETE,
            &sign,
            &[],
            &|| Ok(None),
        ) {
            Ok(_) => Ok(()),
            Err(e) if is_not_found(&e) => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn head(&self, key: &str) -> Result<Option<u64>> {
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(HeadObject::new(&self.bucket, Some(&self.creds), key), at, h)
        };
        match self.send(
            &format!("HEAD {key}"),
            reqwest::Method::HEAD,
            &sign,
            &[],
            &|| Ok(None),
        ) {
            Ok(resp) => Ok(resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()?.parse().ok())),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn delete(&self, key: &str) -> Result<()> {
        let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
            Self::signer(
                DeleteObject::new(&self.bucket, Some(&self.creds), key),
                at,
                h,
            )
        };
        match self.send(
            &format!("DELETE {key}"),
            reqwest::Method::DELETE,
            &sign,
            &[],
            &|| Ok(None),
        ) {
            Ok(_) => Ok(()),
            Err(e) if is_not_found(&e) => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.get(key) {
            Ok(resp) => Ok(Some(resp.bytes()?.to_vec())),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Download via `out.part`, hashing as it streams.
    fn get_to_file(&self, key: &str, out: &Path) -> Result<(u64, [u8; 32])> {
        let mut resp = self.get(key)?;
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let part = out.with_extension("part");
        struct Tee<W> {
            w: W,
            h: Sha256,
        }
        impl<W: Write> Write for Tee<W> {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let n = self.w.write(buf)?;
                self.h.update(&buf[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.w.flush()
            }
        }
        let mut tee = Tee {
            w: std::io::BufWriter::new(std::fs::File::create(&part)?),
            h: Sha256::new(),
        };
        let n = resp.copy_to(&mut tee)?;
        tee.flush()?;
        drop(tee.w);
        std::fs::rename(&part, out)?;
        Ok((n, tee.h.finalize().into()))
    }

    fn list(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
    ) -> Result<(Vec<(String, u64)>, Vec<String>)> {
        let (mut keys, mut prefixes, mut token) = (Vec::new(), Vec::new(), None::<String>);
        loop {
            let sign = |at: &time::OffsetDateTime, h: &[(&'static str, String)]| {
                let mut a = ListObjectsV2::new(&self.bucket, Some(&self.creds));
                a.with_prefix(prefix);
                if let Some(d) = delimiter {
                    a.with_delimiter(d);
                }
                if let Some(t) = &token {
                    a.with_continuation_token(t.clone());
                }
                Self::signer(a, at, h)
            };
            let text = self
                .send(
                    &format!("LIST {prefix}"),
                    reqwest::Method::GET,
                    &sign,
                    &[],
                    &|| Ok(None),
                )?
                .text()?;
            let page =
                ListObjectsV2::parse_response(&text).map_err(|e| anyhow!("LIST {prefix}: {e}"))?;
            let dec = |s: &str| {
                urlencoding::decode(s)
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| s.to_string())
            };
            keys.extend(page.contents.iter().map(|c| (dec(&c.key), c.size)));
            prefixes.extend(page.common_prefixes.iter().map(|p| dec(&p.prefix)));
            match page.next_continuation_token {
                Some(t) if !t.is_empty() => token = Some(t),
                _ => break,
            }
        }
        Ok((keys, prefixes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_codes_map_to_classes() {
        assert_eq!(class_for(403, "AccessDenied"), ErrorClass::Auth);
        assert_eq!(class_for(403, "SignatureDoesNotMatch"), ErrorClass::Auth);
        assert_eq!(
            class_for(403, "RequestTimeTooSkewed"),
            ErrorClass::ClockSkew
        );
        assert_eq!(class_for(400, "BadDigest"), ErrorClass::Integrity);
        assert_eq!(class_for(404, "NoSuchBucket"), ErrorClass::Config);
        assert_eq!(class_for(301, "PermanentRedirect"), ErrorClass::Config);
        assert_eq!(class_for(503, "SlowDown"), ErrorClass::Transient);
        assert_eq!(class_for(500, ""), ErrorClass::Transient);
        assert_eq!(class_for(429, ""), ErrorClass::Transient);
        assert!(
            ErrorClass::Auth.halts() && ErrorClass::Config.halts() && ErrorClass::ClockSkew.halts()
        );
        assert!(
            !ErrorClass::Transient.halts()
                && !ErrorClass::Integrity.halts()
                && !ErrorClass::Local.halts()
        );
    }

    #[test]
    fn transport_errors_carry_no_presigned_url() {
        // Port 1 refuses the connection: the error comes from reqwest, which names the URL.
        let t = S3Target::new(
            "http://127.0.0.1:1",
            "b",
            "us-east-1",
            "p",
            true,
            "AKIDSYNTHETIC",
            "synthetic-secret",
            Some("synthetic-session-token"),
        )
        .unwrap();
        let err = format!("{:#}", t.probe("dev").unwrap_err());
        for leak in [
            "synthetic-session-token",
            "X-Amz-Signature",
            "X-Amz-Credential",
        ] {
            assert!(!err.contains(leak), "{leak} in {err}");
        }
        assert_eq!(
            classify(&t.probe("dev").unwrap_err()),
            ErrorClass::Transient
        );
    }

    #[test]
    fn error_xml_fields_parse() {
        let body = "<?xml version=\"1.0\"?><Error><Code>BadDigest</Code><Message>The SHA256 you specified did not match.</Message></Error>";
        assert_eq!(xml_tag(body, "Code"), "BadDigest");
        assert_eq!(
            xml_tag(body, "Message"),
            "The SHA256 you specified did not match."
        );
        assert_eq!(xml_tag("", "Code"), "");
    }

    #[test]
    fn throttle_paces_reservations() {
        let t = Throttle::new(1_000_000);
        let t0 = Instant::now();
        for _ in 0..4 {
            t.take(100_000);
        }
        // 400 kB at 1 MB/s: the 4th reservation starts after 300 ms.
        assert!(
            t0.elapsed() >= Duration::from_millis(280),
            "{:?}",
            t0.elapsed()
        );
    }

    #[test]
    fn keys_round_trip_through_the_prefix() {
        let t = S3Target::new(
            "http://127.0.0.1:9",
            "b",
            "us-east-1",
            "/kc/",
            true,
            "k",
            "s",
            None,
        )
        .unwrap();
        assert_eq!(t.key("d/x"), "kc/d/x");
        assert_eq!(t.rel("kc/d/x"), "d/x");
        let t = S3Target::new(
            "http://127.0.0.1:9",
            "b",
            "us-east-1",
            "",
            true,
            "k",
            "s",
            None,
        )
        .unwrap();
        assert_eq!(t.key("d/x"), "d/x");
        assert!(S3Target::new(
            "http://127.0.0.1:9",
            "",
            "us-east-1",
            "",
            true,
            "k",
            "s",
            None
        )
        .is_err());
    }

    #[test]
    fn endpoint_path_prefix_survives_signing() {
        // Supabase Storage serves S3 under a path: http://127.0.0.1:54321/storage/v1/s3
        for endpoint in [
            "http://127.0.0.1:54321/storage/v1/s3",
            "http://127.0.0.1:54321/storage/v1/s3/",
            "http://127.0.0.1:54321",
        ] {
            let t = S3Target::new(endpoint, "b", "us-east-1", "", true, "k", "s", None).unwrap();
            let want = if endpoint.ends_with("54321") {
                "/b/d/x"
            } else {
                "/storage/v1/s3/b/d/x"
            };
            let url = PutObject::new(&t.bucket, Some(&t.creds), "d/x").sign(SIGN_TTL);
            assert_eq!(url.path(), want, "{endpoint}");
            let mut list = ListObjectsV2::new(&t.bucket, Some(&t.creds));
            list.with_prefix("d/");
            assert_eq!(
                list.sign(SIGN_TTL).path(),
                want.trim_end_matches("d/x"),
                "{endpoint} (bucket URL)"
            );
        }
    }

    #[test]
    fn part_size_never_drops_below_the_s3_minimum() {
        let t = S3Target::new("http://127.0.0.1:9", "b", "r", "", true, "k", "s", None)
            .unwrap()
            .with_part_size(1);
        assert_eq!(t.part_size(), MIN_PART);
    }
}
