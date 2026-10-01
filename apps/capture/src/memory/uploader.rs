//! Cloud upload of finalized video chunks, and the capture gate.
//!
//! The recorder captures only while the Kortix API allows it. The uploader
//! thread polls `GET /v1/capture/agent/config` with the machine credential of
//! the agent tunnel (`$AGENT_TUNNEL_HOME/config.json`: `token`, `tunnelId`,
//! `apiUrl`). When `capture_allowed` is false, or there is no credential, the
//! capture loop idles in state `off` and no upload starts.
//!
//! For each finalized video without `uploaded_at` the uploader runs:
//! `POST /chunks` (idempotent on `client_uid` = file sha256), `PUT` the mp4 to
//! the returned URL, `POST /chunks/:id/commit` with the chunk's frames. A
//! failure backs off per video: 5 s, doubling to 10 min. Attempts and the last
//! error persist in the `video` row.
//!
//! After a committed upload the local video is deleted after
//! `upload.keep_local_hours` (default 24) and the local text rows after
//! `upload.text_keep_days` (default 7).

use super::paths::MemoryPaths;
use super::retention;
use super::settings::Settings;
use super::store::{self, now_ms};
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const API_URL_ENV: &str = "KORTIX_CAPTURE_API_URL";
const TICK: Duration = Duration::from_secs(5);
const BACKOFF_MIN: Duration = Duration::from_secs(5);
const BACKOFF_MAX: Duration = Duration::from_secs(600);
const DEFAULT_POLL: Duration = Duration::from_secs(60);
const TEXT_CAP: usize = 32 * 1024;
const MS_PER_HOUR: i64 = 3_600_000;

/// `upload` block of `recorder.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UploadStatus {
    pub pending: i64,
    /// ISO-8601 UTC.
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Gate {
    pub allowed: bool,
    /// Why capture is off: `not_paired`, `capture_not_allowed`, `api_<status>`.
    pub reason: String,
}

/// State shared by the capture loop (reads the gate) and the uploader (writes it).
pub struct Cloud {
    gate: Mutex<Gate>,
    upload: Mutex<UploadStatus>,
    /// False for `record --local`: no gate, no uploads.
    pub enabled: bool,
}

impl Cloud {
    pub fn local() -> Arc<Self> {
        Arc::new(Self { gate: Mutex::new(Gate { allowed: true, reason: String::new() }), upload: Mutex::default(), enabled: false })
    }

    /// Capture stays off until the API allows it.
    pub fn gated() -> Arc<Self> {
        Arc::new(Self { gate: Mutex::new(Gate { allowed: false, reason: "not_paired".into() }), upload: Mutex::default(), enabled: true })
    }

    pub fn gate(&self) -> Gate {
        self.gate.lock().expect("gate lock").clone()
    }

    pub fn upload(&self) -> Option<UploadStatus> {
        self.enabled.then(|| self.upload.lock().expect("upload lock").clone())
    }

    fn set_gate(&self, allowed: bool, reason: &str) {
        *self.gate.lock().expect("gate lock") = Gate { allowed, reason: if allowed { String::new() } else { reason.into() } };
    }
}

#[derive(Debug, Clone)]
pub struct Credentials {
    /// API origin without a path, for example `https://api.kortix.com`.
    pub api: String,
    pub token: String,
    pub tunnel_id: String,
}

/// `https://host/v1/tunnel`, `https://host/v1` and `https://host/` all become `https://host`.
fn api_origin(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/');
    for suffix in ["/tunnel", "/v1"] {
        u = u.strip_suffix(suffix).unwrap_or(u);
    }
    u.trim_end_matches('/').to_string()
}

fn tunnel_home() -> PathBuf {
    match std::env::var("AGENT_TUNNEL_HOME") {
        Ok(h) if !h.trim().is_empty() => PathBuf::from(h),
        _ => directories::BaseDirs::new().map(|b| b.home_dir().join(".agent-tunnel")).unwrap_or_else(|| PathBuf::from(".agent-tunnel")),
    }
}

/// Machine credential from the agent tunnel; `None` until the machine is paired.
pub fn load_credentials() -> Option<Credentials> {
    let cfg: Value = serde_json::from_slice(&std::fs::read(tunnel_home().join("config.json")).ok()?).ok()?;
    let field = |k: &str| cfg.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let api = std::env::var(API_URL_ENV).ok().filter(|u| !u.trim().is_empty()).or_else(|| field("apiUrl"))?;
    Some(Credentials { api: api_origin(&api), token: field("token")?, tunnel_id: field("tunnelId")? })
}

#[derive(Debug)]
struct ApiError {
    status: Option<u16>,
    message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

fn api_error(err: ureq::Error) -> ApiError {
    match err {
        ureq::Error::Status(code, resp) => {
            let body: String = resp.into_string().unwrap_or_default().chars().take(200).collect();
            ApiError { status: Some(code), message: format!("HTTP {code}: {body}") }
        }
        other => ApiError { status: None, message: other.to_string() },
    }
}

struct VideoRow {
    id: i64,
    path: String,
    width: i64,
    height: i64,
    start: i64,
    end: i64,
    attempts: i64,
}

pub fn backoff(attempts: i64) -> Duration {
    let exp = attempts.clamp(1, 20) as u32 - 1;
    BACKOFF_MIN.saturating_mul(1u32 << exp.min(10)).min(BACKOFF_MAX)
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn capped_text(foreground: Option<String>, background: Option<String>) -> String {
    let mut text = [foreground, background].into_iter().flatten().filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ");
    if text.len() > TEXT_CAP {
        let mut end = TEXT_CAP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

fn frames_json(conn: &Connection, video: i64) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT f.video_index, f.timestamp, a.bundle_id, a.display_name, f.title, s.url, d.normalized_domain, f.foreground, f.background
         FROM frame f
         LEFT JOIN segment s ON s.id = f.segment
         LEFT JOIN application a ON a.id = s.application
         LEFT JOIN domain d ON d.id = s.domain
         WHERE f.video = ?1 ORDER BY f.video_index",
    )?;
    let rows = stmt.query_map([video], |r| {
        Ok(json!({
            "frame_index": r.get::<_, Option<i64>>(0)?,
            "ts": iso(r.get(1)?),
            "app_bundle": r.get::<_, Option<String>>(2)?,
            "app_name": r.get::<_, Option<String>>(3)?,
            "window_title": r.get::<_, Option<String>>(4)?,
            "url": r.get::<_, Option<String>>(5)?,
            "domain": r.get::<_, Option<String>>(6)?,
            "text": capped_text(r.get(7)?, r.get(8)?),
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub struct Uploader {
    paths: MemoryPaths,
    cloud: Arc<Cloud>,
    agent: ureq::Agent,
    credentials: Box<dyn Fn() -> Option<Credentials> + Send>,
    next_try: HashMap<i64, Instant>,
    config_due: Option<Instant>,
    last_cleanup: Option<Instant>,
}

impl Uploader {
    pub fn new(paths: MemoryPaths, cloud: Arc<Cloud>) -> Self {
        Self::with_credentials(paths, cloud, Box::new(load_credentials))
    }

    pub fn with_credentials(paths: MemoryPaths, cloud: Arc<Cloud>, credentials: Box<dyn Fn() -> Option<Credentials> + Send>) -> Self {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(300)).build();
        Self { paths, cloud, agent, credentials, next_try: HashMap::new(), config_due: None, last_cleanup: None }
    }

    fn call(&self, creds: &Credentials, method: &str, path: &str, body: Option<Value>) -> Result<Value, ApiError> {
        let req = self
            .agent
            .request(method, &format!("{}/v1/capture/agent/{path}", creds.api))
            .set("Authorization", &format!("Bearer {}", creds.token))
            .set("X-Tunnel-Id", &creds.tunnel_id);
        let resp = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        }
        .map_err(api_error)?;
        resp.into_json().map_err(|e| ApiError { status: None, message: format!("bad JSON: {e}") })
    }

    /// One cycle: gate poll (when due), uploads (when allowed), local cleanup.
    pub fn tick(&mut self, now: Instant) {
        let Some(creds) = (self.credentials)() else {
            self.cloud.set_gate(false, "not_paired");
            return;
        };
        let mut error: Option<String> = None;
        if self.config_due.map_or(true, |t| now >= t) {
            match self.call(&creds, "GET", "config", None) {
                Ok(cfg) => {
                    let allowed = cfg.get("capture_allowed").and_then(Value::as_bool).unwrap_or(false);
                    self.cloud.set_gate(allowed, "capture_not_allowed");
                    let poll = cfg.get("poll_seconds").and_then(Value::as_u64).map(Duration::from_secs).unwrap_or(DEFAULT_POLL);
                    self.config_due = Some(now + poll.max(Duration::from_secs(1)));
                }
                Err(err) => {
                    // A 4xx is a decision (revoked, no owner): capture stops. A network or 5xx failure keeps the last gate.
                    if err.status.is_some_and(|s| (400..500).contains(&s)) {
                        self.cloud.set_gate(false, &format!("api_{}", err.status.unwrap_or(0)));
                    }
                    self.config_due = Some(now + BACKOFF_MIN);
                    error = Some(format!("config: {err}"));
                }
            }
        }
        let conn = match store::open(&self.paths) {
            Ok(c) => c,
            Err(err) => {
                tracing::warn!("uploader: open store: {err:#}");
                return;
            }
        };
        if self.cloud.gate().allowed {
            if let Err(err) = self.upload_pending(&conn, &creds, now) {
                error = Some(format!("{err:#}"));
            }
        }
        if self.last_cleanup.map_or(true, |t| now.duration_since(t) > Duration::from_secs(60)) {
            self.last_cleanup = Some(now);
            let s = Settings::load(&self.paths);
            if let Err(err) = cleanup(&conn, &self.paths, &s, now_ms()) {
                tracing::warn!("uploader cleanup failed: {err:#}");
            }
        }
        let pending = conn.query_row("SELECT count(*) FROM video WHERE status < 2 AND uploaded_at IS NULL", [], |r| r.get(0)).unwrap_or(0);
        let mut up = self.cloud.upload.lock().expect("upload lock");
        up.pending = pending;
        up.last_error = error;
    }

    fn upload_pending(&mut self, conn: &Connection, creds: &Credentials, now: Instant) -> Result<()> {
        let mut stmt = conn.prepare(
            "SELECT id, path, width, height, COALESCE(start_timestamp, 0), COALESCE(end_timestamp, 0), upload_attempts
             FROM video WHERE status < 2 AND uploaded_at IS NULL ORDER BY id",
        )?;
        let videos: Vec<VideoRow> = stmt
            .query_map([], |r| {
                Ok(VideoRow { id: r.get(0)?, path: r.get(1)?, width: r.get(2)?, height: r.get(3)?, start: r.get(4)?, end: r.get(5)?, attempts: r.get(6)? })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut first_error = None;
        for v in videos {
            if self.next_try.get(&v.id).is_some_and(|t| now < *t) {
                continue;
            }
            match self.upload_video(conn, creds, &v) {
                Ok(()) => {
                    self.next_try.remove(&v.id);
                    self.cloud.upload.lock().expect("upload lock").last_success_at = Some(iso(now_ms()));
                }
                Err(err) if err.downcast_ref::<ApiError>().is_some_and(|e| e.status == Some(403)) => {
                    // The account or the user turned capture off since the last poll.
                    self.cloud.set_gate(false, "capture_not_allowed");
                    return Err(err);
                }
                Err(err) => {
                    let attempts = v.attempts + 1;
                    let msg = format!("{err:#}");
                    conn.execute("UPDATE video SET upload_attempts = ?1, upload_error = ?2 WHERE id = ?3", params![attempts, msg, v.id])?;
                    self.next_try.insert(v.id, now + backoff(attempts));
                    first_error.get_or_insert(format!("video {}: {msg}", v.id));
                }
            }
        }
        first_error.map_or(Ok(()), |e| Err(anyhow!(e)))
    }

    fn upload_video(&self, conn: &Connection, creds: &Credentials, v: &VideoRow) -> Result<()> {
        let file = self.paths.videos_dir().join(&v.path);
        let bytes = match std::fs::read(&file) {
            Ok(b) => b,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                // Storage policy removed it before the upload; nothing can be sent.
                conn.execute("UPDATE video SET status = ?1, upload_error = 'video file missing' WHERE id = ?2", params![retention::STATUS_DELETED, v.id])?;
                return Ok(());
            }
            Err(err) => return Err(err).with_context(|| format!("read {}", file.display())),
        };
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let frames = frames_json(conn, v.id)?;
        let chunk = self.call(
            creds,
            "POST",
            "chunks",
            Some(json!({
                "client_uid": sha, "started_at": iso(v.start), "ended_at": iso(v.end), "frame_count": frames.len(),
                "width": v.width, "height": v.height, "codec": "hevc", "video_bytes": bytes.len(), "video_sha256": sha,
            })),
        )?;
        if chunk["already_committed"].as_bool() != Some(true) {
            let chunk_id = chunk["chunk_id"].as_str().context("chunk response has no chunk_id")?;
            let upload = &chunk["upload"];
            let url = upload["url"].as_str().context("chunk response has no upload url")?;
            let mut put = self.agent.put(url);
            for (k, val) in upload["headers"].as_object().into_iter().flatten() {
                if let Some(val) = val.as_str() {
                    put = put.set(k, val);
                }
            }
            put.send_bytes(&bytes).map_err(|e| anyhow!("PUT video: {}", api_error(e)))?;
            self.call(creds, "POST", &format!("chunks/{chunk_id}/commit"), Some(json!({"frames": frames})))?;
        }
        conn.execute("UPDATE video SET uploaded_at = ?1, upload_error = NULL WHERE id = ?2", params![now_ms(), v.id])?;
        Ok(())
    }
}

/// Delete local videos and text of committed uploads once their keep windows end.
pub fn cleanup(conn: &Connection, paths: &MemoryPaths, s: &Settings, now: i64) -> Result<()> {
    let video_cutoff = now - s.upload.keep_local_hours as i64 * MS_PER_HOUR;
    let mut stmt = conn.prepare("SELECT id, path FROM video WHERE status < 2 AND uploaded_at IS NOT NULL AND uploaded_at < ?1")?;
    let old: Vec<(i64, String)> = stmt.query_map([video_cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    for (id, path) in old {
        retention::delete_video(conn, paths, id, &path)?;
    }
    let text_cutoff = now - s.upload.text_keep_days as i64 * 24 * MS_PER_HOUR;
    let tx = conn.unchecked_transaction()?;
    let expired = "(SELECT id FROM video WHERE status = 2 AND uploaded_at IS NOT NULL AND uploaded_at < ?1)";
    for table in ["ocr", "window_bound"] {
        tx.execute(&format!("DELETE FROM {table} WHERE frame IN (SELECT id FROM frame WHERE video IN {expired})"), [text_cutoff])?;
    }
    tx.execute(&format!("DELETE FROM frame WHERE video IN {expired}"), [text_cutoff])?;
    tx.execute(&format!("DELETE FROM video WHERE id IN {expired}"), [text_cutoff])?;
    tx.execute("DELETE FROM segment WHERE id NOT IN (SELECT segment FROM frame WHERE segment IS NOT NULL)", [])?;
    tx.execute("DELETE FROM ax_blob WHERE hash NOT IN (SELECT hash FROM ax_snapshot)", [])?;
    tx.commit()?;
    Ok(())
}

/// Uploader thread body: runs until `stop`.
pub fn run(paths: MemoryPaths, cloud: Arc<Cloud>, stop: Arc<AtomicBool>) {
    let mut uploader = Uploader::new(paths, cloud);
    while !stop.load(Ordering::SeqCst) {
        uploader.tick(Instant::now());
        let until = Instant::now() + TICK;
        while !stop.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MockState {
        allowed: bool,
        fail_chunks: usize,
        fail_commit: usize,
        deny_chunks: bool,
        /// client_uid -> (chunk_id, committed)
        chunks: HashMap<String, (String, bool)>,
        chunk_bodies: Vec<Value>,
        puts: Vec<(String, usize, Option<String>)>,
        commits: Vec<(String, Value)>,
        calls: Vec<String>,
    }

    struct Mock {
        url: String,
        state: Arc<Mutex<MockState>>,
    }

    /// In-process stand-in for the three machine endpoints plus the storage PUT target.
    fn mock(allowed: bool) -> Mock {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        let state = Arc::new(Mutex::new(MockState { allowed, ..Default::default() }));
        let (st, base) = (state.clone(), url.clone());
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let header = |name: &str| req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.to_string());
                let (auth, tunnel, sse) = (header("authorization"), header("x-tunnel-id"), header("x-amz-server-side-encryption"));
                let (method, path) = (req.method().to_string(), req.url().to_string());
                let mut body = Vec::new();
                req.as_reader().read_to_end(&mut body).unwrap();
                let mut s = st.lock().unwrap();
                s.calls.push(format!("{method} {path}"));
                let json = |v: Value| tiny_http::Response::from_string(v.to_string()).with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap());
                let machine = path.starts_with("/v1/capture/agent/");
                let resp = if machine && (auth.as_deref() != Some("Bearer tok") || tunnel.as_deref() != Some("tnl")) {
                    json(json!({"error": "unauthorized"})).with_status_code(401)
                } else if method == "GET" && path == "/v1/capture/agent/config" {
                    json(json!({"capture_allowed": s.allowed, "account_enabled": true, "device_enabled": s.allowed, "paused_until": null, "retention_days": 30, "poll_seconds": 60}))
                } else if method == "POST" && path == "/v1/capture/agent/chunks" {
                    let b: Value = serde_json::from_slice(&body).unwrap();
                    let uid = b["client_uid"].as_str().unwrap().to_string();
                    s.chunk_bodies.push(b);
                    if s.deny_chunks {
                        json(json!({"code": "CAPTURE_DISABLED"})).with_status_code(403)
                    } else if s.fail_chunks > 0 {
                        s.fail_chunks -= 1;
                        json(json!({"error": "boom"})).with_status_code(500)
                    } else if s.chunks.get(&uid).is_some_and(|c| c.1) {
                        json(json!({"chunk_id": s.chunks[&uid].0, "already_committed": true}))
                    } else {
                        let n = s.chunks.len() + 1;
                        let id = s.chunks.entry(uid).or_insert((format!("chunk-{n}"), false)).0.clone();
                        json(json!({"chunk_id": id, "already_committed": false,
                            "upload": {"method": "PUT", "url": format!("{base}/put/{id}"), "headers": {"x-amz-server-side-encryption": "AES256"}}}))
                    }
                } else if method == "PUT" && path.starts_with("/put/") {
                    s.puts.push((path.trim_start_matches("/put/").to_string(), body.len(), sse));
                    tiny_http::Response::from_string("").with_status_code(200)
                } else if method == "POST" && path.starts_with("/v1/capture/agent/chunks/") && path.ends_with("/commit") {
                    let id = path.trim_start_matches("/v1/capture/agent/chunks/").trim_end_matches("/commit").to_string();
                    let b: Value = serde_json::from_slice(&body).unwrap();
                    if s.fail_commit > 0 {
                        s.fail_commit -= 1;
                        json(json!({"error": "boom"})).with_status_code(500)
                    } else {
                        let n = b["frames"].as_array().unwrap().len();
                        for c in s.chunks.values_mut().filter(|c| c.0 == id) {
                            c.1 = true;
                        }
                        s.commits.push((id, b));
                        json(json!({"ok": true, "frames": n}))
                    }
                } else {
                    json(json!({})).with_status_code(404)
                };
                let _ = req.respond(resp);
            }
        });
        Mock { url, state }
    }

    struct Fixture {
        dir: PathBuf,
        paths: MemoryPaths,
        cloud: Arc<Cloud>,
        up: Uploader,
        video_sha: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    const T0: i64 = 1_700_000_000_000;

    /// One finalized video of 3 frames with real bytes on disk.
    fn fixture(name: &str, api: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("kcap-up-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = MemoryPaths::at(&dir);
        let conn = store::open(&paths).unwrap();
        let bytes = format!("fake-mp4-{name}").into_bytes();
        std::fs::write(paths.videos_dir().join("v1.mp4"), &bytes).unwrap();
        conn.execute("INSERT INTO application(bundle_id, version, display_name) VALUES ('com.example.editor', '', 'Editor')", []).unwrap();
        conn.execute("INSERT INTO domain(normalized_domain) VALUES ('example.com')", []).unwrap();
        conn.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (1, 1, 1, 'https://example.com/a')", []).unwrap();
        conn.execute(
            "INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp) VALUES (720, 1280, 'v1.mp4', 3, ?1, ?2, ?3)",
            params![bytes.len() as i64, T0, T0 + 4000],
        )
        .unwrap();
        for i in 0..3i64 {
            let fg = if i == 2 { "é".repeat(40_000) } else { format!("synthetic text {i}") };
            conn.execute(
                "INSERT INTO frame(timestamp, video, video_index, title, segment, foreground, background, ocr_status) VALUES (?1, 1, ?2, ?3, 1, ?4, ?5, 1)",
                params![T0 + i * 2000, i, format!("Window {i}"), fg, (i == 0).then_some("menu text")],
            )
            .unwrap();
        }
        let cloud = Cloud::gated();
        let api = api.to_string();
        let up = Uploader::with_credentials(
            paths.clone(),
            cloud.clone(),
            Box::new(move || Some(Credentials { api: api.clone(), token: "tok".into(), tunnel_id: "tnl".into() })),
        );
        Fixture { dir, paths, cloud, up, video_sha: format!("{:x}", Sha256::digest(&bytes)) }
    }

    fn video(f: &Fixture) -> (Option<i64>, i64, Option<String>) {
        let conn = store::open(&f.paths).unwrap();
        conn.query_row("SELECT uploaded_at, upload_attempts, upload_error FROM video WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
    }

    fn calls(m: &Mock, prefix: &str) -> usize {
        m.state.lock().unwrap().calls.iter().filter(|c| c.starts_with(prefix)).count()
    }

    fn chunk_posts(m: &Mock) -> usize {
        m.state.lock().unwrap().calls.iter().filter(|c| *c == "POST /v1/capture/agent/chunks").count()
    }

    #[test]
    fn no_credentials_or_gate_off_means_no_upload() {
        let m = mock(false);
        let mut f = fixture("gate-off", &m.url);
        f.up.tick(Instant::now());
        assert!(!f.cloud.gate().allowed);
        assert_eq!(f.cloud.gate().reason, "capture_not_allowed");
        assert_eq!(calls(&m, "GET /v1/capture/agent/config"), 1);
        assert_eq!(calls(&m, "POST"), 0, "no chunk request while capture is not allowed");
        assert_eq!(video(&f).0, None);
        assert_eq!(f.cloud.upload().unwrap().pending, 1);

        let mut unpaired = Uploader::with_credentials(f.paths.clone(), f.cloud.clone(), Box::new(|| None));
        unpaired.tick(Instant::now());
        assert_eq!(f.cloud.gate().reason, "not_paired");
        assert_eq!(calls(&m, ""), 1, "no request without a credential");
    }

    #[test]
    fn gate_on_uploads_chunk_once_with_frames() {
        let m = mock(true);
        let mut f = fixture("gate-on", &m.url);
        let t = Instant::now();
        f.up.tick(t);
        assert!(f.cloud.gate().allowed);
        {
            let s = m.state.lock().unwrap();
            let b = &s.chunk_bodies[0];
            assert_eq!(b["client_uid"], f.video_sha.as_str());
            assert_eq!(b["video_sha256"], f.video_sha.as_str());
            assert_eq!((b["frame_count"].as_i64(), b["width"].as_i64(), b["height"].as_i64(), b["codec"].as_str()), (Some(3), Some(1280), Some(720), Some("hevc")));
            assert_eq!(b["started_at"], "2023-11-14T22:13:20.000Z");
            assert_eq!(b["ended_at"], "2023-11-14T22:13:24.000Z");
            assert_eq!(s.puts, vec![("chunk-1".to_string(), b["video_bytes"].as_u64().unwrap() as usize, Some("AES256".to_string()))]);
            let (id, commit) = &s.commits[0];
            assert_eq!(id, "chunk-1");
            let frames = commit["frames"].as_array().unwrap();
            assert_eq!(frames.len(), 3);
            assert_eq!(
                frames[0],
                json!({"frame_index": 0, "ts": "2023-11-14T22:13:20.000Z", "app_bundle": "com.example.editor", "app_name": "Editor",
                       "window_title": "Window 0", "url": "https://example.com/a", "domain": "example.com", "text": "synthetic text 0 menu text"})
            );
            assert_eq!(frames[2]["text"].as_str().unwrap().len(), TEXT_CAP, "text is capped at 32 KB on a char boundary");
        }
        let (uploaded, attempts, error) = video(&f);
        assert!(uploaded.is_some() && attempts == 0 && error.is_none());
        let up = f.cloud.upload().unwrap();
        assert_eq!((up.pending, up.last_error.is_some(), up.last_success_at.is_some()), (0, false, true));
        let before = calls(&m, "");
        f.up.tick(t + Duration::from_secs(10));
        assert_eq!(calls(&m, ""), before, "an uploaded video is never sent again");
    }

    #[test]
    fn failed_commit_retries_the_same_chunk_without_duplicates() {
        let m = mock(true);
        m.state.lock().unwrap().fail_commit = 1;
        let mut f = fixture("commit-retry", &m.url);
        let t = Instant::now();
        f.up.tick(t);
        let (uploaded, attempts, error) = video(&f);
        assert!(uploaded.is_none() && attempts == 1 && error.unwrap().contains("500"));
        assert!(f.cloud.upload().unwrap().last_error.unwrap().contains("video 1"));
        f.up.tick(t + backoff(1) + Duration::from_secs(1));
        let s = m.state.lock().unwrap();
        assert_eq!(s.chunks.len(), 1, "same client_uid maps to one chunk");
        assert_eq!(s.commits.len(), 1);
        assert_eq!(s.puts.len(), 2, "the PUT is repeated, it is idempotent");
        drop(s);
        assert!(video(&f).0.is_some());
    }

    #[test]
    fn server_error_backs_off_per_video() {
        let m = mock(true);
        m.state.lock().unwrap().fail_chunks = 2;
        let mut f = fixture("backoff", &m.url);
        let t = Instant::now();
        f.up.tick(t);
        assert_eq!(chunk_posts(&m), 1);
        f.up.tick(t + Duration::from_secs(2));
        assert_eq!(chunk_posts(&m), 1, "still inside the 5 s backoff");
        f.up.tick(t + Duration::from_secs(6));
        assert_eq!(chunk_posts(&m), 2);
        assert_eq!(video(&f).1, 2);
        f.up.tick(t + Duration::from_secs(12));
        assert_eq!(chunk_posts(&m), 2, "second failure waits 10 s");
        f.up.tick(t + Duration::from_secs(17));
        assert_eq!(chunk_posts(&m), 3);
        assert!(video(&f).0.is_some());
        assert_eq!([1, 2, 3, 8, 9, 30].map(|n| backoff(n).as_secs()), [5, 10, 20, 600, 600, 600]);
    }

    #[test]
    fn already_committed_short_circuits() {
        let m = mock(true);
        let mut f = fixture("already", &m.url);
        m.state.lock().unwrap().chunks.insert(f.video_sha.clone(), ("chunk-9".into(), true));
        f.up.tick(Instant::now());
        assert_eq!(calls(&m, "PUT"), 0);
        assert_eq!(calls(&m, "POST /v1/capture/agent/chunks/"), 0);
        assert!(video(&f).0.is_some());
    }

    #[test]
    fn disabled_response_closes_the_gate_and_is_not_retried() {
        let m = mock(true);
        m.state.lock().unwrap().deny_chunks = true;
        let mut f = fixture("denied", &m.url);
        f.up.tick(Instant::now());
        assert!(!f.cloud.gate().allowed);
        assert_eq!(video(&f).1, 0, "a disabled account is not an upload failure");
    }

    #[test]
    fn cleanup_deletes_video_after_a_day_and_text_after_a_week() {
        let m = mock(true);
        let mut f = fixture("cleanup", &m.url);
        f.up.tick(Instant::now());
        let conn = store::open(&f.paths).unwrap();
        let uploaded: i64 = video(&f).0.unwrap();
        let s = Settings::default();
        cleanup(&conn, &f.paths, &s, uploaded + 23 * MS_PER_HOUR).unwrap();
        assert!(f.paths.videos_dir().join("v1.mp4").exists());
        cleanup(&conn, &f.paths, &s, uploaded + 25 * MS_PER_HOUR).unwrap();
        assert!(!f.paths.videos_dir().join("v1.mp4").exists());
        let frames = |c: &Connection| c.query_row("SELECT count(*) FROM frame", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(frames(&conn), 3, "text stays for 7 days");
        cleanup(&conn, &f.paths, &s, uploaded + 8 * 24 * MS_PER_HOUR).unwrap();
        assert_eq!(frames(&conn), 0);
        let rows = |t: &str| conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!((rows("video"), rows("segment")), (0, 0));
    }

    #[test]
    fn credentials_come_from_the_tunnel_config() {
        assert_eq!(api_origin("https://api.kortix.com/v1/tunnel"), "https://api.kortix.com");
        assert_eq!(api_origin("http://127.0.0.1:8008/v1/"), "http://127.0.0.1:8008");
        let home = std::env::temp_dir().join(format!("kcap-home-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("config.json"), r#"{"token":"kortix_tnl_x","tunnelId":"t1","apiUrl":"https://api.kortix.com/v1/tunnel","allowedPaths":[]}"#).unwrap();
        std::env::set_var("AGENT_TUNNEL_HOME", &home);
        std::env::remove_var(API_URL_ENV);
        let c = load_credentials().unwrap();
        assert_eq!((c.api.as_str(), c.token.as_str(), c.tunnel_id.as_str()), ("https://api.kortix.com", "kortix_tnl_x", "t1"));
        std::env::set_var(API_URL_ENV, "http://127.0.0.1:9/");
        assert_eq!(load_credentials().unwrap().api, "http://127.0.0.1:9");
        std::fs::write(home.join("config.json"), r#"{"apiUrl":"x"}"#).unwrap();
        assert!(load_credentials().is_none(), "no token, not paired");
        std::env::remove_var(API_URL_ENV);
        let _ = std::fs::remove_dir_all(home);
    }

    /// Manual proof: `KORTIX_CAPTURE_REAL_LIB=<library dir> cargo test real_library -- --ignored --nocapture`.
    /// Uploads the first video of a real recorded library (a copy) to the mock.
    #[test]
    #[ignore]
    fn real_library_chunk_uploads_to_mock() {
        let src = PathBuf::from(std::env::var("KORTIX_CAPTURE_REAL_LIB").expect("KORTIX_CAPTURE_REAL_LIB"));
        let m = mock(true);
        let mut f = fixture("real", &m.url);
        let _ = std::fs::remove_dir_all(&f.dir);
        std::fs::create_dir_all(f.paths.videos_dir()).unwrap();
        std::fs::copy(src.join("memory.db"), f.paths.db()).unwrap();
        for e in std::fs::read_dir(src.join("videos")).unwrap() {
            let e = e.unwrap();
            std::fs::copy(e.path(), f.paths.videos_dir().join(e.file_name())).unwrap();
        }
        f.up.tick(Instant::now());
        let s = m.state.lock().unwrap();
        let (id, commit) = &s.commits[0];
        println!("mock calls: {:?}", s.calls);
        println!("chunk {id}: PUT {} bytes, commit frames = {}, body = {}", s.puts[0].1, commit["frames"].as_array().unwrap().len(), s.chunk_bodies[0]);
        println!("pending after = {}", f.cloud.upload().unwrap().pending);
    }
}
