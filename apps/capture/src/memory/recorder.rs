//! The 24/7 capture recorder.
//!
//! Four threads (three with `--local`) share one SQLite library:
//! 1. capture: every `interval_ms`, ask the engine for a still plus metadata
//!    (app, window, URL, windows, AX tree) and insert a frame.
//! 2. OCR: drain frames with `ocr_status = 0`. A frame whose still is
//!    byte-identical to the previous frame copies that frame's text instead of
//!    running Vision again. A backlog switches to the fast recognizer.
//! 3. finalizer: pack OCR'd stills into 1 fps HEVC chunks and delete them.
//! 4. uploader (see `uploader.rs`): polls the capture gate and uploads chunks.
//!    Capture idles in state `off` while the gate is closed.
//!
//! Retention runs on the finalizer thread (see `retention.rs`).

use super::engine::Engine;
use super::paths::MemoryPaths;
use super::retention;
use super::settings::Settings;
use super::store::{self, normalize_domain, now_ms};
use super::uploader::{self, Cloud, UploadStatus};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const SEGMENT_GAP_MS: i64 = 5 * 60 * 1000;
const OCR_BACKLOG_FAST: i64 = 30;
const FINALIZE_IDLE_MS: i64 = 120_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecorderStatus {
    pub pid: u32,
    /// recording | off | paused | disabled | inactive | locked | excluded | low_disk | error | stopped
    pub state: String,
    pub reason: Option<String>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_frame_id: Option<i64>,
    pub last_capture_ms: Option<i64>,
    pub frames_this_run: u64,
    pub ocr_backlog: i64,
    pub last_error: Option<String>,
    pub permissions: Option<Value>,
    /// None with `--local`.
    pub upload: Option<UploadStatus>,
}

impl RecorderStatus {
    pub fn read(paths: &MemoryPaths) -> Option<Self> {
        let bytes = std::fs::read(paths.status()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Heartbeat younger than 3 capture intervals (min 15 s) and the pid is alive.
    pub fn is_live(&self) -> bool {
        let fresh = now_ms() - self.updated_at_ms < 15_000;
        fresh && self.state != "stopped" && pid_alive(self.pid)
    }

    fn write(&self, paths: &MemoryPaths) {
        let tmp = paths.status().with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(self) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(tmp, paths.status());
            }
        }
    }
}

pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}

/// Env var set by the supervisor (the always-on agent service) to its own pid.
pub const PARENT_PID_ENV: &str = "KORTIX_CAPTURE_PARENT_PID";

/// Set `stop` once process `pid` is gone, so a killed supervisor never leaves an
/// orphan recorder. Polls every `poll`; returns when `stop` is set by anyone.
pub fn stop_when_gone(pid: u32, stop: Arc<AtomicBool>, poll: Duration) {
    while !stop.load(Ordering::SeqCst) {
        if !pid_alive(pid) {
            tracing::info!("supervisor {pid} is gone; stopping");
            stop.store(true, Ordering::SeqCst);
            return;
        }
        sleep_until(Instant::now() + poll, &stop);
    }
}

/// Hot-reloading settings: re-read the file when its mtime changes.
struct SettingsWatch {
    paths: MemoryPaths,
    mtime: Option<SystemTime>,
    current: Settings,
}

impl SettingsWatch {
    fn new(paths: &MemoryPaths) -> Self {
        let mut w = Self { paths: paths.clone(), mtime: None, current: Settings::default() };
        w.refresh();
        w
    }
    fn refresh(&mut self) -> &Settings {
        let mtime = std::fs::metadata(self.paths.settings()).and_then(|m| m.modified()).ok();
        if mtime != self.mtime || self.mtime.is_none() {
            self.current = Settings::load(&self.paths);
            self.mtime = mtime;
        }
        &self.current
    }
}

/// Run until `stop` is set. Holds an exclusive lock so only one recorder writes.
pub fn run(paths: MemoryPaths, stop: Arc<AtomicBool>, local: bool) -> Result<()> {
    paths.ensure()?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())?;
    if lock.try_lock().is_err() {
        anyhow::bail!("another recorder already owns {}", paths.root.display());
    }

    let conn = store::open(&paths)?;
    record_environment(&conn)?;
    drop(conn);

    let mut threads = Vec::new();
    for (name, f) in [
        ("memory-ocr", ocr_loop as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>),
        ("memory-finalize", finalize_loop as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>),
    ] {
        let (p, s) = (paths.clone(), stop.clone());
        threads.push(std::thread::Builder::new().name(name.into()).spawn(move || {
            if let Err(err) = f(p, s) {
                tracing::error!("{name} stopped: {err:#}");
            }
        })?);
    }

    let cloud = if local { Cloud::local() } else { Cloud::gated() };
    if cloud.enabled {
        let (p, c, s) = (paths.clone(), cloud.clone(), stop.clone());
        threads.push(std::thread::Builder::new().name("memory-upload".into()).spawn(move || uploader::run(p, c, s))?);
    }

    let result = capture_loop(&paths, &stop, &cloud);
    stop.store(true, Ordering::SeqCst);
    for t in threads {
        let _ = t.join();
    }
    let mut status = RecorderStatus::read(&paths).unwrap_or_default();
    status.state = "stopped".into();
    status.updated_at_ms = now_ms();
    status.write(&paths);
    result
}

fn record_environment(conn: &Connection) -> Result<()> {
    let tz = iana_timezone();
    let last: Option<String> = conn
        .query_row("SELECT identifier FROM timezone ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .optional()?;
    if last.as_deref() != Some(tz.as_str()) {
        conn.execute("INSERT INTO timezone(identifier, observed_at) VALUES (?1, ?2)", params![tz, now_ms()])?;
    }
    let version = env!("CARGO_PKG_VERSION");
    let last: Option<String> = conn
        .query_row("SELECT version FROM app_version ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .optional()?;
    if last.as_deref() != Some(version) {
        conn.execute("INSERT INTO app_version(version, observed_at) VALUES (?1, ?2)", params![version, now_ms()])?;
    }
    Ok(())
}

fn iana_timezone() -> String {
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.is_empty() {
            return tz;
        }
    }
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|p| {
            let s = p.to_string_lossy().into_owned();
            s.split("zoneinfo/").nth(1).map(str::to_string)
        })
        .unwrap_or_else(|| "UTC".into())
}

#[cfg(windows)]
fn free_disk_gb(path: &Path) -> Option<f64> {
    // `fsutil` needs admin; PowerShell's Get-PSDrive does not.
    let drive = path.to_string_lossy().chars().next()?;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("(Get-PSDrive {drive}).Free")])
        .output()
        .ok()?;
    let bytes: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(bytes / 1e9)
}

#[cfg(not(windows))]
fn free_disk_gb(path: &Path) -> Option<f64> {
    let out = std::process::Command::new("df").arg("-k").arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    let avail_kb: f64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_kb / 1024.0 / 1024.0)
}

struct SegmentState {
    id: i64,
    key: (String, Option<i64>, Option<String>),
    last_ts: i64,
}

fn capture_loop(paths: &MemoryPaths, stop: &AtomicBool, cloud: &Cloud) -> Result<()> {
    let conn = store::open(paths)?;
    let mut engine = Engine::new()?;
    let mut settings = SettingsWatch::new(paths);
    let mut status = RecorderStatus {
        pid: std::process::id(),
        state: "starting".into(),
        started_at_ms: now_ms(),
        ..Default::default()
    };
    status.permissions = engine.permissions().ok();
    let mut segment: Option<SegmentState> = None;
    let mut first = true;
    let mut disk_checked_at = Instant::now() - Duration::from_secs(3600);
    let mut low_disk = false;

    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();
        let s = settings.refresh().clone();
        let interval = Duration::from_millis(s.interval_ms.max(500));
        status.updated_at_ms = now_ms();
        status.ocr_backlog = conn
            .query_row("SELECT count(*) FROM frame WHERE ocr_status = 0", [], |r| r.get(0))
            .unwrap_or(0);

        if disk_checked_at.elapsed() > Duration::from_secs(60) {
            disk_checked_at = Instant::now();
            low_disk = free_disk_gb(&paths.root).map(|gb| gb < s.storage.min_free_gb).unwrap_or(false);
        }

        status.upload = cloud.upload();
        let gate = cloud.gate();
        let blocked = if !gate.allowed {
            Some(("off".to_string(), Some(gate.reason)))
        } else if let Some(reason) = s.inactive_reason(now_ms()) {
            Some((reason.to_string(), None))
        } else if low_disk {
            Some(("low_disk".to_string(), Some(format!("less than {} GB free", s.storage.min_free_gb))))
        } else {
            None
        };
        if let Some((state, reason)) = blocked {
            status.state = state;
            status.reason = reason;
            status.write(paths);
            sleep_until(tick + interval, stop);
            continue;
        }

        let ts = now_ms();
        let staged = paths.frames_dir().join(format!("unfinalized_{ts}.jpg"));
        let req = json!({
            "cmd": "capture",
            "out": staged.to_string_lossy(),
            "max_height": s.max_height,
            "max_width": s.max_width,
            "quality": s.staging_quality,
            "exclude_bundle_ids": s.effective_excluded_bundle_ids(),
            "exclude_domains": s.effective_excluded_domains(),
            "exclude_private": s.exclude_private_browsing,
            "record_unknown": s.record_unknown_bundle_ids,
            "max_idle_seconds": if s.pause_on_inactivity { s.inactivity_seconds as f64 } else { 0.0 },
            "ax": s.ax_enabled,
        });
        match engine.request(req, Duration::from_secs(20)) {
            Ok(resp) => {
                status.last_error = None;
                if let Some(skip) = resp.get("skipped").and_then(Value::as_str) {
                    status.state = match skip {
                        "inactive" => "inactive",
                        "locked" => "locked",
                        "self_on_screen" => "self_on_screen",
                        _ => "excluded",
                    }
                    .into();
                    status.reason = Some(skip.into());
                    let _ = std::fs::remove_file(&staged);
                } else {
                    let reason = if first { "initial" } else { "fixed_interval" };
                    match insert_frame(&conn, paths, &mut engine, &resp, ts, reason, &mut segment) {
                        Ok(id) => {
                            first = false;
                            status.state = "recording".into();
                            status.reason = None;
                            status.last_frame_id = Some(id);
                            status.last_capture_ms = Some(ts);
                            status.frames_this_run += 1;
                        }
                        Err(err) => {
                            let _ = std::fs::remove_file(&staged);
                            status.state = "error".into();
                            status.last_error = Some(format!("{err:#}"));
                            tracing::warn!("frame insert failed: {err:#}");
                        }
                    }
                }
            }
            Err(err) => {
                let _ = std::fs::remove_file(&staged);
                status.state = "error".into();
                status.last_error = Some(format!("{err:#}"));
                status.permissions = engine.permissions().ok();
                tracing::warn!("capture failed: {err:#}");
            }
        }
        status.updated_at_ms = now_ms();
        status.write(paths);
        sleep_until(tick + interval, stop);
    }
    Ok(())
}

fn sleep_until(deadline: Instant, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(250)));
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn i64_of(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))).unwrap_or(0)
}

fn f64_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn file_sha256(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/// Make sure an application row has an icon; fetched once per bundle id.
fn ensure_icon(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, app_id: i64, bundle_id: &str) {
    let has: Option<String> = conn
        .query_row("SELECT icon_path FROM application WHERE id = ?1", [app_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .flatten();
    if has.is_some() || bundle_id.is_empty() {
        return;
    }
    let out = paths.icons_dir().join(format!("{}.png", sanitize(bundle_id)));
    let req = json!({"cmd": "icon", "bundle_id": bundle_id, "out": out.to_string_lossy()});
    if let Ok(resp) = engine.request(req, Duration::from_secs(5)) {
        let rel = paths.rel(&out);
        let color = resp.get("dominant_color").and_then(Value::as_i64);
        let _ = conn.execute(
            "UPDATE application SET icon_path = ?1, dominant_color = ?2 WHERE bundle_id = ?3",
            params![rel, color, bundle_id],
        );
    }
}

pub fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect()
}

/// Record the engine's regular-app classification the first time we see an app.
fn set_user_app(conn: &Connection, app_id: i64, app: &Value) -> Result<()> {
    if let Some(user) = app.get("is_user_app").and_then(Value::as_bool) {
        conn.execute("UPDATE application SET is_user_app = ?1 WHERE id = ?2 AND is_user_app IS NOT ?1", params![user as i64, app_id])?;
    }
    Ok(())
}

fn app_for_window(conn: &Connection, bundle_id: &str, name: &str) -> Result<i64> {
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM application WHERE bundle_id = ?1 ORDER BY id DESC LIMIT 1", [bundle_id], |r| r.get(0))
        .optional()?;
    match existing {
        Some(id) => Ok(id),
        None => Ok(store::upsert_application(conn, bundle_id, "", name)?.id),
    }
}

fn insert_frame(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    resp: &Value,
    ts: i64,
    reason: &str,
    segment: &mut Option<SegmentState>,
) -> Result<i64> {
    let path = PathBuf::from(str_of(resp, "path"));
    let app = resp.get("app").cloned().unwrap_or(Value::Null);
    // Bundle ids are stored lowercased; the icon lookup needs the original case.
    let raw_bundle_id = str_of(&app, "bundle_id").to_string();
    let bundle_id = raw_bundle_id.to_lowercase();
    let app_row = store::upsert_application(conn, &bundle_id, str_of(&app, "version"), str_of(&app, "name"))?;
    set_user_app(conn, app_row.id, &app)?;
    if app_row.icon_path.is_none() {
        ensure_icon(conn, paths, engine, app_row.id, &raw_bundle_id);
    }
    let url = resp.get("url").and_then(Value::as_str).map(str::to_string);
    let domain_id = match url.as_deref().and_then(normalize_domain) {
        Some(d) => Some(store::upsert_domain(conn, &d)?),
        None => None,
    };

    let tx = conn.unchecked_transaction()?;
    // A new segment starts when the app, the domain, or the URL changes.
    let key = (bundle_id.clone(), domain_id, url.clone());
    let seg_id = match segment {
        Some(s) if s.key == key && ts - s.last_ts < SEGMENT_GAP_MS => s.id,
        _ => {
            // Frame id is not known yet; start_frame_id is patched below.
            tx.execute(
                "INSERT INTO segment(start_frame_id, application, domain, url) VALUES (0, ?1, ?2, ?3)",
                params![app_row.id, domain_id, url],
            )?;
            tx.last_insert_rowid()
        }
    };
    let display = resp.get("display").cloned().unwrap_or(Value::Null);
    let image_hash = file_sha256(&path);
    tx.execute(
        "INSERT INTO frame(timestamp, image_path, width, height, title, segment, is_inactive,
                           capture_display_x, capture_display_y, capture_display_width, capture_display_height,
                           capture_reason, dhash, ocr_status, image_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13)",
        params![
            ts,
            paths.rel(&path),
            i64_of(resp, "width"),
            i64_of(resp, "height"),
            str_of(resp, "title"),
            seg_id,
            f64_of(&display, "x"),
            f64_of(&display, "y"),
            f64_of(&display, "w"),
            f64_of(&display, "h"),
            reason,
            str_of(resp, "dhash"),
            image_hash,
        ],
    )?;
    let frame_id = tx.last_insert_rowid();
    tx.execute("UPDATE segment SET start_frame_id = ?1 WHERE id = ?2 AND start_frame_id = 0", params![frame_id, seg_id])?;
    *segment = Some(SegmentState { id: seg_id, key, last_ts: ts });

    // Full on-screen window stack, desktop and menu-bar layers included.
    if let Some(windows) = resp.get("windows").and_then(Value::as_array) {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO window_bound(frame, application, window_title, x, y, width, height, window_layer, z_order, url, is_focussed_window)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for w in windows {
            let layer = i64_of(w, "layer");
            let wb = str_of(w, "bundle_id").to_lowercase();
            let win_app = if wb == bundle_id {
                app_row.id
            } else {
                let id = app_for_window(&tx, &wb, str_of(w, "app_name"))?;
                set_user_app(&tx, id, w)?;
                id
            };
            let focused = w.get("focused").and_then(Value::as_bool).unwrap_or(false);
            stmt.execute(params![
                frame_id,
                win_app,
                str_of(w, "title"),
                i64_of(w, "x"),
                i64_of(w, "y"),
                i64_of(w, "w"),
                i64_of(w, "h"),
                layer,
                i64_of(w, "z"),
                w.get("url").and_then(Value::as_str),
                focused as i64,
            ])?;
        }
    }

    if let Some(tree) = resp.get("ax_tree") {
        let payload = serde_json::to_vec(tree)?;
        let hash = Sha256::digest(&payload).to_vec();
        let compressed = zstd::encode_all(payload.as_slice(), 3)?;
        tx.execute("INSERT OR IGNORE INTO ax_blob(hash, payload) VALUES (?1, ?2)", params![hash, compressed])?;
        tx.execute(
            "INSERT OR REPLACE INTO ax_snapshot(frame_id, hash, timestamp_ms, application_name, bundle_id, process_identifier, node_count, is_partial_tree)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                frame_id,
                hash,
                ts,
                str_of(&app, "name"),
                bundle_id,
                i64_of(&app, "pid"),
                i64_of(resp, "ax_node_count"),
                resp.get("ax_partial").and_then(Value::as_bool).unwrap_or(false) as i64,
            ],
        )?;
        tx.execute("UPDATE frame SET ax_root_hash = ?1 WHERE id = ?2", params![hash, frame_id])?;
    }
    tx.commit()?;
    Ok(frame_id)
}

// ---------------------------------------------------------------- OCR worker

struct PendingFrame {
    id: i64,
    image_path: Option<String>,
    image_hash: Option<String>,
    width: i64,
    height: i64,
    display: (f64, f64, f64, f64),
}

/// macOS VM pressure: 1 normal, 2 warning, 4 critical. Other OSes report normal.
pub fn memory_pressure_level() -> u32 {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl")
            .args(["-n", "kern.memorystatus_vm_pressure_level"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(1)
    }
    #[cfg(not(target_os = "macos"))]
    {
        1
    }
}

fn ocr_loop(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
    let conn = store::open(&paths)?;
    let mut engine = Engine::new()?;
    let mut settings = SettingsWatch::new(&paths);
    let mut pressure_checked = Instant::now() - Duration::from_secs(60);
    while !stop.load(Ordering::SeqCst) {
        // Defer OCR under critical memory pressure; frames keep
        // ocr_status = 0 and are read when pressure returns to normal.
        if pressure_checked.elapsed() > Duration::from_secs(10) {
            pressure_checked = Instant::now();
            if memory_pressure_level() >= 4 {
                tracing::info!("deferring OCR: critical memory pressure");
                std::thread::sleep(Duration::from_secs(10));
                continue;
            }
        }
        let pending: Option<PendingFrame> = conn
            .query_row(
                "SELECT id, image_path, image_hash, width, height, capture_display_x, capture_display_y,
                        capture_display_width, capture_display_height
                 FROM frame WHERE ocr_status = 0 ORDER BY image_path IS NULL, id LIMIT 1",
                [],
                |r| {
                    Ok(PendingFrame {
                        id: r.get(0)?,
                        image_path: r.get(1)?,
                        image_hash: r.get::<_, Option<String>>(2).ok().flatten(),
                        width: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        height: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        display: (
                            r.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                            r.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                            r.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                            r.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
                        ),
                    })
                },
            )
            .optional()?;
        let Some(frame) = pending else {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        if let Err(err) = ocr_one(&conn, &paths, &mut engine, settings.refresh(), &frame) {
            tracing::warn!("ocr frame {} failed: {err:#}", frame.id);
            conn.execute("UPDATE frame SET ocr_status = 3 WHERE id = ?1", [frame.id])?;
        }
    }
    Ok(())
}

fn ocr_one(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings, f: &PendingFrame) -> Result<()> {
    // Identical still as the previous frame: copy its OCR.
    if let Some(hash) = &f.image_hash {
        let prev: Option<(i64, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT id, foreground, background FROM frame
                 WHERE id < ?1 AND ocr_status IN (1, 2) ORDER BY id DESC LIMIT 1",
                [f.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((prev_id, fg, bg)) = prev {
            let prev_hash: Option<String> = conn
                .query_row("SELECT image_hash FROM frame WHERE id = ?1", [prev_id], |r| r.get::<_, Option<String>>(0))
                .optional()?
                .flatten();
            if prev_hash.as_deref() == Some(hash.as_str()) {
                let tx = conn.unchecked_transaction()?;
                tx.execute(
                    "UPDATE frame SET foreground = ?1, background = ?2, ocr_status = 2 WHERE id = ?3",
                    params![fg, bg, f.id],
                )?;
                tx.execute(
                    "INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length)
                     SELECT ?1, x, y, width, height, text_offset, text_length FROM ocr WHERE frame = ?2",
                    params![f.id, prev_id],
                )?;
                tx.commit()?;
                return Ok(());
            }
        }
    }

    // Staged still, or (imported / deferred frames) a still extracted from its chunk.
    let staged = f.image_path.as_deref().map(|p| paths.abs(p)).filter(|p| p.exists());
    let extracted = match staged {
        Some(_) => None,
        None => {
            let tmp = paths.root.join("tmp").join(format!("ocr_{}.jpg", f.id));
            std::fs::create_dir_all(tmp.parent().expect("tmp dir"))?;
            Some(super::frames::export(conn, paths, engine, f.id, &tmp, None)?)
        }
    };
    let image = staged.clone().or_else(|| extracted.clone()).context("frame has no image")?;
    let backlog: i64 = conn.query_row("SELECT count(*) FROM frame WHERE ocr_status = 0", [], |r| r.get(0))?;
    let level = if backlog > OCR_BACKLOG_FAST { "fast" } else { s.ocr_level.as_str() };
    let resp = engine.request(
        json!({"cmd": "ocr", "path": image.to_string_lossy(), "level": level, "languages": s.ocr_languages,
               "incremental": staged.is_some()}),
        Duration::from_secs(60),
    );
    if let Some(tmp) = &extracted {
        let _ = std::fs::remove_file(tmp);
    }
    let resp = resp?;
    let boxes = resp.get("boxes").and_then(Value::as_array).cloned().unwrap_or_default();
    tracing::debug!(
        frame = f.id,
        mode = str_of(&resp, "mode"),
        changed = f64_of(&resp, "changed_fraction").unwrap_or(1.0),
        ms = i64_of(&resp, "elapsed_ms"),
        "ocr"
    );

    // Focused window rect (global points) -> still pixels.
    let focused: Option<(i64, i64, i64, i64)> = conn
        .query_row(
            "SELECT x, y, width, height FROM window_bound WHERE frame = ?1 AND is_focussed_window = 1 LIMIT 1",
            [f.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (dx, dy, dw, dh) = f.display;
    let sx = if dw > 0.0 { f.width as f64 / dw } else { 1.0 };
    let sy = if dh > 0.0 { f.height as f64 / dh } else { 1.0 };
    let focus_px = focused.map(|(x, y, w, h)| {
        let x0 = (x as f64 - dx) * sx;
        let y0 = (y as f64 - dy) * sy;
        (x0, y0, x0 + w as f64 * sx, y0 + h as f64 * sy)
    });

    let _ = focus_px; // All text goes to `foreground`; windows are resolved from boxes at query time.
    let layout = split_ocr(&boxes, None);
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE frame SET foreground = ?1, background = ?2, ocr_status = 1 WHERE id = ?3",
        params![layout.foreground, (!layout.background.is_empty()).then_some(&layout.background), f.id],
    )?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for b in &layout.boxes {
            stmt.execute(params![f.id, b.x, b.y, b.w, b.h, b.offset, b.len])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, PartialEq)]
pub struct OcrBox {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub offset: i64,
    pub len: i64,
}

#[derive(Debug, PartialEq)]
pub struct OcrLayout {
    pub foreground: String,
    pub background: String,
    pub boxes: Vec<OcrBox>,
}

/// Split boxes into focused-window text and the rest, in reading order.
/// Offsets are character offsets into `foreground + background`.
pub fn split_ocr(boxes: &[Value], focus: Option<(f64, f64, f64, f64)>) -> OcrLayout {
    let mut items: Vec<(bool, i64, i64, i64, i64, String)> = boxes
        .iter()
        .filter_map(|b| {
            let text = b.get("text")?.as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let (x, y, w, h) = (i64_of(b, "x"), i64_of(b, "y"), i64_of(b, "w"), i64_of(b, "h"));
            let (cx, cy) = (x as f64 + w as f64 / 2.0, y as f64 + h as f64 / 2.0);
            let fg = match focus {
                Some((x0, y0, x1, y1)) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1,
                None => true,
            };
            Some((fg, x, y, w, h, text))
        })
        .collect();
    // Reading order: top to bottom, then left to right.
    items.sort_by_key(|(fg, x, y, _, _, _)| (!*fg, *y, *x));

    let mut foreground = String::new();
    let mut background = String::new();
    let mut boxes_out = Vec::new();
    for (fg, x, y, w, h, text) in &items {
        let target = if *fg { &mut foreground } else { &mut background };
        if !target.is_empty() {
            target.push(' ');
        }
        let start = target.chars().count() as i64;
        target.push_str(text);
        let len = text.chars().count() as i64;
        boxes_out.push((*fg, OcrBox { x: *x, y: *y, w: *w, h: *h, offset: start, len }));
    }
    let fg_len = foreground.chars().count() as i64;
    let boxes = boxes_out
        .into_iter()
        .map(|(fg, mut b)| {
            if !fg {
                b.offset += fg_len;
            }
            b
        })
        .collect();
    OcrLayout { foreground, background, boxes }
}

// ------------------------------------------------------------ finalizer

struct Staged {
    id: i64,
    path: String,
    width: i64,
    height: i64,
    ts: i64,
    ocr_done: bool,
}

fn finalize_loop(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
    let conn = store::open(&paths)?;
    let mut engine = Engine::new()?;
    let mut settings = SettingsWatch::new(&paths);
    let mut last_retention = Instant::now() - Duration::from_secs(3600);
    while !stop.load(Ordering::SeqCst) {
        let s = settings.refresh().clone();
        match finalize_pass(&conn, &paths, &mut engine, &s, false) {
            Ok(_) => {}
            Err(err) => tracing::warn!("finalize pass failed: {err:#}"),
        }
        if last_retention.elapsed() > Duration::from_secs(600) {
            last_retention = Instant::now();
            if let Err(err) = retention::enforce(&conn, &paths, &mut engine, &s) {
                tracing::warn!("retention pass failed: {err:#}");
            }
        }
        for _ in 0..40 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    // Flush what is ready on shutdown so a restart does not re-encode.
    let s = settings.refresh().clone();
    let _ = finalize_pass(&conn, &paths, &mut engine, &s, true);
    Ok(())
}

/// Encode ready groups of staged stills. `flush` encodes partial chunks too.
pub fn finalize_pass(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings, flush: bool) -> Result<usize> {
    let staged: Vec<Staged> = {
        let mut stmt = conn.prepare(
            "SELECT id, image_path, width, height, timestamp, ocr_status FROM frame
             WHERE video IS NULL AND image_path IS NOT NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Staged {
                id: r.get(0)?,
                path: r.get(1)?,
                width: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                height: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                ts: r.get(4)?,
                ocr_done: r.get::<_, i64>(5)? != 0,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    // Groups of consecutive, same-size, OCR-complete stills.
    let mut groups: Vec<Vec<&Staged>> = Vec::new();
    for f in staged.iter().take_while(|f| f.ocr_done) {
        match groups.last_mut() {
            Some(g) if g[0].width == f.width && g[0].height == f.height && g.len() < s.chunk_max_frames.max(1) => g.push(f),
            _ => groups.push(vec![f]),
        }
    }
    let now = now_ms();
    let total = groups.len();
    let mut encoded = 0;
    for (i, group) in groups.into_iter().enumerate() {
        let is_last = i + 1 == total;
        let full = group.len() >= s.chunk_max_frames.max(1);
        let stale = now - group.last().map(|f| f.ts).unwrap_or(now) > FINALIZE_IDLE_MS;
        if is_last && !full && !stale && !flush {
            break;
        }
        encode_group(conn, paths, engine, s, &group)?;
        encoded += 1;
    }
    Ok(encoded)
}

fn encode_group(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings, group: &[&Staged]) -> Result<()> {
    let inputs: Vec<String> = group.iter().map(|f| paths.abs(&f.path).to_string_lossy().into_owned()).collect();
    let name = format!("{:x}.mp4", Sha256::digest(format!("{}:{}:{}", group[0].id, group[0].ts, now_ms()).as_bytes()));
    let out = paths.videos_dir().join(&name);
    let (w, h) = (group[0].width, group[0].height);
    let resp = engine.request(
        json!({"cmd": "encode", "inputs": inputs, "out": out.to_string_lossy(), "width": w, "height": h, "quality": s.video_quality}),
        Duration::from_secs(300),
    )?;
    let size = i64_of(&resp, "size_bytes");
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO video(height, width, path, num_frames, status, size_bytes, start_timestamp, end_timestamp)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)",
        params![h, w, name, group.len() as i64, size, group[0].ts, group[group.len() - 1].ts],
    )?;
    let video_id = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare_cached("UPDATE frame SET video = ?1, video_index = ?2, image_path = NULL WHERE id = ?3")?;
        for (i, f) in group.iter().enumerate() {
            stmt.execute(params![video_id, i as i64, f.id])?;
        }
    }
    tx.commit()?;
    for f in group {
        let _ = std::fs::remove_file(paths.abs(&f.path));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorder_stops_when_its_supervisor_exits() {
        #[cfg(unix)]
        let mut child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        #[cfg(windows)]
        let mut child = std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (pid, stop) = (child.id(), stop.clone());
            std::thread::spawn(move || stop_when_gone(pid, stop, Duration::from_millis(100)))
        };
        std::thread::sleep(Duration::from_millis(400));
        assert!(!stop.load(Ordering::SeqCst), "supervisor alive: keep recording");
        child.kill().unwrap();
        child.wait().unwrap();
        watcher.join().unwrap();
        assert!(stop.load(Ordering::SeqCst), "supervisor gone: stop flag set");
    }

    fn b(x: i64, y: i64, w: i64, h: i64, t: &str) -> Value {
        json!({"x": x, "y": y, "w": w, "h": h, "text": t})
    }

    #[test]
    fn ocr_split_orders_text_and_offsets_into_concatenation() {
        let boxes = vec![
            b(500, 10, 50, 20, "menu"),     // outside focus -> background
            b(120, 200, 80, 20, "world"),   // focus, second on the row
            b(10, 200, 80, 20, "hello"),    // focus, first on the row
            b(10, 100, 80, 20, "title"),    // focus, earlier row
            b(10, 300, 80, 20, "   "),      // blank dropped
        ];
        let layout = split_ocr(&boxes, Some((0.0, 50.0, 400.0, 400.0)));
        assert_eq!(layout.foreground, "title hello world");
        assert_eq!(layout.background, "menu");
        let all = format!("{}{}", layout.foreground, layout.background);
        for bx in &layout.boxes {
            let text: String = all.chars().skip(bx.offset as usize).take(bx.len as usize).collect();
            assert!(["title", "hello", "world", "menu"].contains(&text.as_str()), "{text}");
        }
        let menu = layout.boxes.iter().find(|bx| bx.x == 500).unwrap();
        assert_eq!(menu.offset, layout.foreground.chars().count() as i64);
    }

    #[test]
    fn recorder_layout_is_top_to_bottom_space_joined() {
        // Every box in `foreground`, sorted by y then x, joined by one space.
        let boxes = vec![b(1392, 7, 50, 20, "a"), b(127, 51, 50, 20, "c"), b(1494, 8, 50, 20, "b"), b(1188, 68, 9, 9, "e"), b(876, 68, 9, 9, "d")];
        let layout = split_ocr(&boxes, None);
        assert_eq!(layout.foreground, "a b c d e");
        assert!(layout.background.is_empty());
        let offsets: Vec<i64> = layout.boxes.iter().map(|b| b.offset).collect();
        assert_eq!(offsets, vec![0, 2, 4, 6, 8]);
    }

    #[test]
    fn no_focus_puts_everything_in_foreground() {
        let layout = split_ocr(&[b(0, 0, 10, 10, "a")], None);
        assert_eq!(layout.foreground, "a");
        assert!(layout.background.is_empty());
    }
}
