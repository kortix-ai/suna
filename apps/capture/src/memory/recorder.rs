//! The 24/7 capture recorder.
//!
//! Three threads share one SQLite library:
//! 1. capture: every `interval_ms`, ask the engine for a still plus metadata
//!    (app, window, URL, windows, AX tree) and insert a frame.
//! 2. OCR: drain frames with `ocr_status = 0`. A frame whose still is
//!    byte-identical to the previous frame copies that frame's text instead of
//!    running Vision again. A backlog switches to the fast recognizer.
//! 3. finalizer: pack OCR'd stills into 1 fps HEVC chunks and delete them.
//!
//! Audio memory (`audio.rs`) adds two threads while `audio.enabled` is on.
//!
//! Retention runs on the finalizer thread (see `retention.rs`).

use super::engine::Engine;
use super::paths::MemoryPaths;
use super::redaction;
use super::retention;
use super::settings::Settings;
use super::store::{self, normalize_domain, now_ms};
use anyhow::{Context, Result};
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

pub(crate) const SEGMENT_GAP_MS: i64 = 5 * 60 * 1000;
const OCR_BACKLOG_FAST: i64 = 30;
const FINALIZE_IDLE_MS: i64 = 120_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecorderStatus {
    pub pid: u32,
    /// recording | paused | disabled | inactive | locked | excluded | low_disk | error | stopped
    pub state: String,
    pub reason: Option<String>,
    /// Why no frame is being recorded right now; None while recording. One of
    /// `disabled`, `paused`, `low_disk`, `sync_backlog`, `self_on_screen`, `locked`,
    /// `inactive`, `excluded_app`, `excluded_domain`, `private_browsing`,
    /// `unknown_bundle`, `no_frontmost_app`, `error`.
    #[serde(default)]
    pub inactive_reason: Option<String>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_frame_id: Option<i64>,
    pub last_capture_ms: Option<i64>,
    pub frames_this_run: u64,
    pub ocr_backlog: i64,
    pub last_error: Option<String>,
    pub permissions: Option<Value>,
    /// Every connected display at the last capture, the focused one first.
    #[serde(default)]
    pub displays: Vec<DisplayStatus>,
}

/// One connected display: its layout (points, global coordinates, top-left
/// origin) and when it last wrote a frame.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DisplayStatus {
    pub id: i64,
    pub name: Option<String>,
    pub main: bool,
    pub focused: bool,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
    pub last_frame_ms: Option<i64>,
}

impl DisplayStatus {
    fn from_capture(d: &Value, previous: &[DisplayStatus]) -> Self {
        let n = |k: &str| d.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        let b = |k: &str| d.get(k).and_then(Value::as_bool).unwrap_or(false);
        let id = d.get("id").and_then(Value::as_i64).unwrap_or(0);
        DisplayStatus {
            id,
            name: d.get("name").and_then(Value::as_str).map(str::to_string),
            main: b("main"),
            focused: b("focused"),
            x: n("x"),
            y: n("y"),
            w: n("w"),
            h: n("h"),
            scale: d.get("scale").and_then(Value::as_f64).unwrap_or(1.0),
            last_frame_ms: previous
                .iter()
                .find(|p| p.id == id)
                .and_then(|p| p.last_frame_ms),
        }
    }
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

pub use crate::os_proc::pid_alive;

/// Hot-reloading effective settings: re-read when the settings file or the
/// cached policy (`policy.rs`) changes, and apply the policy.
struct SettingsWatch {
    paths: MemoryPaths,
    mtime: Option<(Option<SystemTime>, Option<SystemTime>)>,
    raw: Settings,
    current: Settings,
    loaded_valid_file: bool,
}

impl SettingsWatch {
    fn new(paths: &MemoryPaths) -> Self {
        let mut w = Self {
            paths: paths.clone(),
            mtime: None,
            raw: Settings::default(),
            current: Settings::default(),
            loaded_valid_file: false,
        };
        w.refresh();
        w
    }
    fn refresh(&mut self) -> &Settings {
        let stamp = |p: std::path::PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let settings_mtime = stamp(self.paths.settings());
        let policy_mtime = stamp(super::policy::path(&self.paths));
        if self.mtime.is_none() || self.mtime.map(|m| m.0) != Some(settings_mtime) {
            match std::fs::read(self.paths.settings()) {
                Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
                    Ok(settings) => {
                        self.raw = settings;
                        self.loaded_valid_file = true;
                    }
                    Err(_) => {
                        if !self.loaded_valid_file {
                            self.raw.recording_enabled = false;
                        }
                        tracing::warn!("invalid capture settings; retaining last valid policy (capture stays disabled without a valid initial file)");
                    }
                },
                // A missing/temporarily unreadable file must not silently turn
                // off privacy in an already running recorder.
                Err(err) => {
                    if !self.loaded_valid_file && err.kind() != std::io::ErrorKind::NotFound {
                        self.raw.recording_enabled = false;
                    }
                }
            }
        }
        if self.mtime != Some((settings_mtime, policy_mtime)) {
            self.current = self.raw.clone();
            self.current.apply_policy(&self.paths);
            self.current.apply_host(&self.paths);
            self.mtime = Some((settings_mtime, policy_mtime));
        }
        &self.current
    }
}

/// Run until `stop` is set. Holds an exclusive lock so only one recorder writes.
pub fn run(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
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
    run_once_tasks(&conn, &paths)?;
    drop(conn);

    let mut threads = Vec::new();
    for (name, f) in [
        (
            "memory-ocr",
            ocr_loop as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>,
        ),
        (
            "memory-finalize",
            finalize_loop as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>,
        ),
        (
            "memory-sync",
            super::sync::run as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>,
        ),
        (
            "memory-audio",
            super::audio::run as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>,
        ),
        (
            "memory-audio-finalize",
            super::audio::finalize_loop as fn(MemoryPaths, Arc<AtomicBool>) -> Result<()>,
        ),
    ] {
        let (p, s) = (paths.clone(), stop.clone());
        threads.push(
            std::thread::Builder::new()
                .name(name.into())
                .spawn(move || {
                    if let Err(err) = f(p, s) {
                        tracing::error!("{name} stopped: {err:#}");
                    }
                })?,
        );
    }

    let result = capture_loop(&paths, &stop);
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

/// One-shot migrations, recorded in `once_tasks`. Append only; never rename a task.
fn run_once_tasks(conn: &Connection, paths: &MemoryPaths) -> Result<()> {
    // The default archived scale rose from 0.5 to 0.75. `Settings::save` writes every
    // field, so a library that ever saved settings pins the old default. Move those
    // to the new default once; a value the user picked later is left alone.
    store::run_once(conn, "settings-archived-scale-0.75", |_| {
        if paths.settings().exists() {
            let mut s = Settings::load(paths);
            if s.storage.archived_scale == 0.5 {
                s.storage.archived_scale = 0.75;
                s.save(paths)?;
            }
        }
        Ok(())
    })?;
    // "Keep recordings on this computer" became 7 days (it was "until space runs low"
    // while sync was off). A library still on that old default moves once; a value the
    // person chose (another mode, size or day count) is left alone.
    store::run_once(conn, "settings-keep-7-days", |_| {
        if paths.settings().exists() {
            let mut s = Settings::load(paths);
            let st = &s.storage;
            if st.management_mode == "storage_cap"
                && st.cap_action == "delete"
                && st.limit_gb == 50.0
                && st.retention_days == 90
                && st.retention_action == "downscale"
            {
                s.storage.management_mode = "retention".into();
                s.storage.retention_days = 7;
                s.storage.retention_action = "delete".into();
                s.save(paths)?;
            }
        }
        Ok(())
    })?;
    // Input idleness used to stop screen capture 5 s after the last key or click
    // (the old default), so reading or watching recorded nothing. It no longer
    // stops capture; turn the stored switch off so the settings say so.
    store::run_once(conn, "settings-idle-never-pauses", |_| {
        if paths.settings().exists() {
            let mut s = Settings::load(paths);
            if s.pause_on_inactivity {
                s.pause_on_inactivity = false;
                s.save(paths)?;
            }
        }
        Ok(())
    })?;
    Ok(())
}

fn record_environment(conn: &Connection) -> Result<()> {
    let tz = iana_timezone();
    let last: Option<String> = conn
        .query_row(
            "SELECT identifier FROM timezone ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if last.as_deref() != Some(tz.as_str()) {
        conn.execute(
            "INSERT INTO timezone(identifier, observed_at) VALUES (?1, ?2)",
            params![tz, now_ms()],
        )?;
    }
    let version = env!("CARGO_PKG_VERSION");
    let last: Option<String> = conn
        .query_row(
            "SELECT version FROM app_version ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if last.as_deref() != Some(version) {
        conn.execute(
            "INSERT INTO app_version(version, observed_at) VALUES (?1, ?2)",
            params![version, now_ms()],
        )?;
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

use crate::os_proc::free_disk_gb;

struct SegmentState {
    id: i64,
    key: (String, Option<i64>, Option<String>),
    last_ts: i64,
}

/// A display unchanged this long writes a frame again (a keep-alive frame), so
/// the timeline never reads a static screen as a gap: frame timestamps alone
/// cover what was on screen (.agents/skills/kortix-capture/references/capture-format.md, "Coverage").
pub(crate) const KEEPALIVE_MS: i64 = 30_000;

/// `{"<display id>": <content hash>}` of the last frame written per display,
/// for the engine to skip encoding a display that has not changed. A display
/// whose last frame is older than the keepalive is left out: it writes again.
pub(crate) fn unchanged_request(last: &HashMap<i64, (String, i64)>, now: i64) -> Value {
    let mut out = serde_json::Map::new();
    for (id, (hash, at)) in last {
        if now - at < KEEPALIVE_MS {
            out.insert(id.to_string(), json!(hash));
        }
    }
    Value::Object(out)
}

/// The connected displays after a capture, the focused one first. A full
/// capture is the layout; an active-display-only capture updates that display
/// and moves the focus to it, keeping the others.
pub(crate) fn update_layout(
    layout: &mut Vec<DisplayStatus>,
    captured: &[Value],
    only_focused: bool,
) {
    let fresh: Vec<DisplayStatus> = captured
        .iter()
        .map(|d| DisplayStatus::from_capture(&d["display"], layout))
        .collect();
    if only_focused {
        for d in fresh {
            for other in layout.iter_mut() {
                other.focused = false;
            }
            match layout.iter_mut().find(|o| o.id == d.id) {
                Some(o) => *o = d,
                None => layout.push(d),
            }
        }
    } else {
        *layout = fresh;
    }
    layout.sort_by_key(|d| !d.focused);
}

/// Why a display's frame was written: unchanged since its last frame means the
/// 30 s keep-alive, else the tick's reason.
pub(crate) fn frame_reason<'a>(
    frame: &Value,
    last: Option<&(String, i64)>,
    tick: &'a str,
) -> &'a str {
    match (frame.get("content_hash").and_then(Value::as_str), last) {
        (Some(hash), Some((prev, _))) if hash == prev => "keepalive",
        _ => tick,
    }
}

/// The display a frame (or capture response) belongs to; 0 for an engine
/// without display ids.
pub(crate) fn display_id_of(v: &Value) -> i64 {
    v.get("display")
        .and_then(|d| d.get("id"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn overlaps(w: &Value, d: &Value) -> bool {
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let (wx, wy, ww, wh) = (n(w, "x"), n(w, "y"), n(w, "w"), n(w, "h"));
    let (dx, dy, dw, dh) = (n(d, "x"), n(d, "y"), n(d, "w"), n(d, "h"));
    wx < dx + dw && dx < wx + ww && wy < dy + dh && dy < wy + wh
}

/// One frame per display that changed, the display holding the focused window
/// first. That display keeps the front app, its URL and AX tree; another
/// display keeps the app, title and URL of its own top window. Each frame's
/// window list keeps the windows on its display. A response from an engine
/// without `displays` is one frame, as before.
pub(crate) fn display_frames(resp: &Value) -> Vec<Value> {
    let Some(displays) = resp.get("displays").and_then(Value::as_array) else {
        return vec![resp.clone()];
    };
    let windows = resp
        .get("windows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let inactive = resp
        .get("inactive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut frames: Vec<Value> = displays
        .iter()
        .filter(|d| {
            d.get("unchanged").and_then(Value::as_bool) != Some(true)
                && d.get("skipped").is_none()
                && (d.get("path").is_some() || d.get("image_base64").is_some())
        })
        .map(|d| {
            let mut f = d.clone();
            if let Some(o) = f.as_object_mut() {
                o.remove("unchanged");
            }
            let focused = d["display"]
                .get("focused")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if focused {
                for k in [
                    "app",
                    "title",
                    "url",
                    "ax_tree",
                    "ax_node_count",
                    "ax_partial",
                    "focused_window",
                ] {
                    if let Some(v) = resp.get(k) {
                        f[k] = v.clone();
                    }
                }
            }
            f["inactive"] = json!(inactive);
            f["windows"] = Value::Array(
                windows
                    .iter()
                    .filter(|w| overlaps(w, &d["display"]))
                    .cloned()
                    .collect(),
            );
            f
        })
        .collect();
    frames.sort_by_key(|f| f["display"].get("focused").and_then(Value::as_bool) != Some(true));
    frames
}

fn capture_loop(paths: &MemoryPaths, stop: &AtomicBool) -> Result<()> {
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
    // Per display: its open segment, and the content hash and time of its last frame.
    let mut segments: HashMap<i64, Option<SegmentState>> = HashMap::new();
    let mut last_hash: HashMap<i64, (String, i64)> = HashMap::new();
    let mut first = true;
    let mut disk_checked_at = Instant::now() - Duration::from_secs(3600);
    let mut free_gb: Option<f64> = None;
    let mut sync_pending_bytes: i64 = 0;
    // Focus at the last capture decision, and why the next capture is early.
    let mut baseline: Option<Focus> = None;
    let mut next_reason: Option<&'static str> = None;

    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();
        let s = settings.refresh().clone();
        let interval = Duration::from_millis(s.interval_ms.max(500));
        // The model is shared with the audio transcript writer (one copy per
        // process); it is locked only while a private frame is prepared.
        if s.privacy.redact_pii && s.privacy.use_local_model {
            if super::privacy_model::shared(paths).is_err() {
                // Masking is on (the person's choice or the organization's policy) and the
                // model is not here: fetch it, and save no frame unmasked meanwhile.
                let fetching = super::privacy_model::status(paths)["downloading"] == true
                    || super::privacy_model::start_install(paths).is_ok();
                status.state = "privacy_model_unavailable".into();
                status.reason = Some(
                    if fetching {
                        "Downloading the privacy model that masks personal data; recording starts when it is ready"
                    } else {
                        "Masking personal data needs the privacy model: run `kortix-capture privacy-model --install`"
                    }
                    .into(),
                );
                status.updated_at_ms = now_ms();
                status.write(paths);
                sleep_until(tick + interval, stop);
                continue;
            }
        } else {
            // Release model weights and the RAM cache when privacy/model is off.
            super::privacy_model::release_shared();
        }
        status.updated_at_ms = now_ms();
        status.ocr_backlog = conn
            .query_row("SELECT count(*) FROM frame WHERE ocr_status = 0", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);

        if disk_checked_at.elapsed() > Duration::from_secs(60) {
            disk_checked_at = Instant::now();
            free_gb = free_disk_gb(&paths.root);
            sync_pending_bytes = if s.sync.enabled {
                conn.query_row(
                    "SELECT (SELECT COALESCE(sum(size_bytes), 0) FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0)
                          + (SELECT COALESCE(sum(size_bytes), 0) FROM audio WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0)",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0)
            } else {
                0
            };
            if let super::reserve::Action::Released(n) =
                super::reserve::maintain(paths, &s, free_gb)
            {
                tracing::warn!(
                    "free disk below {} GB: released the {} MB reserve",
                    super::reserve::CRITICAL_FREE_GB,
                    n / 1_048_576
                );
            }
        }

        if let Some((reason, detail)) = s.recording_gate(now_ms(), free_gb, sync_pending_bytes) {
            status.state = reason.to_string();
            status.inactive_reason = Some(reason.to_string());
            status.reason = detail;
            status.write(paths);
            baseline = None;
            sleep_until(tick + interval, stop);
            continue;
        }

        let mut needs_permission = false;
        let ts = now_ms();
        let staged = paths.frames_dir().join(format!("unfinalized_{ts}.jpg"));
        // A capture a focus change pulled forward records the active display only.
        let only_focused = !first && next_reason.is_some();
        let req = capture_request(
            &s,
            &staged,
            &unchanged_request(&last_hash, ts),
            only_focused,
        );
        // Private capture also completes OCR before returning. A stalled engine
        // is killed at the deadline, with no unfiltered fallback.
        match engine.request(
            req,
            Duration::from_secs(if s.privacy.redact_pii { 60 } else { 6 }),
        ) {
            Ok(resp) => {
                status.last_error = None;
                if is_permission_skip(&resp) {
                    // Missing Screen Recording: report it and check again later.
                    // Nothing here asks macOS for it; only an explicit request
                    // (`permissions --request`, the app's "Allow access") does.
                    let _ = std::fs::remove_file(&staged);
                    needs_permission = true;
                    status.state = "permission_missing".into();
                    status.reason = Some("screen_recording".into());
                    status.inactive_reason = Some("permission_missing".into());
                    status.permissions = engine.permissions().ok();
                } else if let Some(skip) = resp.get("skipped").and_then(Value::as_str) {
                    status.state = match skip {
                        "inactive" => "inactive",
                        "locked" => "locked",
                        "self_on_screen" => "self_on_screen",
                        _ => "excluded",
                    }
                    .into();
                    status.reason = Some(skip.into());
                    status.inactive_reason = Some(skip.into());
                    let _ = std::fs::remove_file(&staged);
                } else {
                    let reason = if first {
                        "initial"
                    } else {
                        next_reason.unwrap_or("fixed_interval")
                    };
                    if let Some(displays) = resp.get("displays").and_then(Value::as_array) {
                        update_layout(&mut status.displays, displays, only_focused);
                    }
                    let mut written = 0u64;
                    let mut failed: Option<String> = None;
                    // The focused display first: its frame and its OCR never wait on another display.
                    for mut frame in display_frames(&resp) {
                        let display = display_id_of(&frame);
                        let path = PathBuf::from(str_of(&frame, "path"));
                        let result = (|| -> Result<i64> {
                            let layout = if s.privacy.redact_pii {
                                let mut model = if s.privacy.use_local_model {
                                    Some(super::privacy_model::shared(paths)?)
                                } else {
                                    None
                                };
                                Some(prepare_private_capture_with_model(
                                    &mut frame,
                                    &path,
                                    s.staging_quality,
                                    model.as_mut().and_then(|m| m.as_mut()),
                                )?)
                            } else {
                                None
                            };
                            let reason = frame_reason(&frame, last_hash.get(&display), reason);
                            let started = Instant::now();
                            let display_id: i64 = display;
                            let id = insert_frame(
                                &conn,
                                paths,
                                &mut engine,
                                &frame,
                                ts,
                                reason,
                                segments.entry(display).or_default(),
                                layout.as_ref(),
                            );
                            tracing::debug!(
                                display_id,
                                ms = started.elapsed().as_millis() as u64,
                                "db_insert"
                            );
                            id
                        })();
                        match result {
                            Ok(id) => {
                                written += 1;
                                status.last_frame_id = Some(id);
                                if let Some(hash) =
                                    frame.get("content_hash").and_then(Value::as_str)
                                {
                                    last_hash.insert(display, (hash.to_string(), ts));
                                }
                                if let Some(d) =
                                    status.displays.iter_mut().find(|d| d.id == display)
                                {
                                    d.last_frame_ms = Some(ts);
                                }
                            }
                            Err(err) => {
                                let _ = std::fs::remove_file(&path);
                                let msg =
                                    format!("frame insert failed (display {display}): {err:#}");
                                tracing::warn!("{msg}");
                                failed = Some(format!("{err:#}"));
                            }
                        }
                    }
                    if let Some(timings) = resp.get("timings") {
                        let timings = timings.to_string();
                        tracing::debug!("capture timings: {timings}");
                    }
                    match failed {
                        Some(err) if written == 0 => {
                            status.state = "error".into();
                            status.inactive_reason = Some("error".into());
                            status.last_error = Some(err);
                        }
                        _ => {
                            first = false;
                            status.state = "recording".into();
                            status.reason = None;
                            status.inactive_reason = None;
                            status.last_capture_ms = Some(ts);
                            status.frames_this_run += written;
                        }
                    }
                }
            }
            Err(err) => {
                let _ = std::fs::remove_file(&staged);
                status.state = "error".into();
                status.inactive_reason = Some("error".into());
                status.last_error = Some(format!("{err:#}"));
                status.permissions = engine.permissions().ok();
                tracing::warn!("capture failed: {err:#}");
            }
        }
        status.updated_at_ms = now_ms();
        status.write(paths);
        next_reason = None;
        if needs_permission {
            // A fresh engine process at the next check: macOS may keep
            // answering "not granted" to a process that started before the grant.
            engine.kill();
            sleep_until(tick + PERMISSION_RECHECK, stop);
            continue;
        }
        if s.capture_on_change {
            let mut probe = || probe_focus(&mut engine);
            next_reason = wait_for_change(
                &mut probe,
                &mut baseline,
                tick + interval,
                tick,
                CHANGE_POLL,
                CHANGE_MIN_GAP,
                stop,
            );
        } else {
            sleep_until(tick + interval, stop);
        }
    }
    Ok(())
}

/// While Screen Recording is missing, check again this often (never prompting).
const PERMISSION_RECHECK: Duration = Duration::from_secs(30);

/// The engine skipped the capture because Screen Recording is not granted.
fn is_permission_skip(resp: &Value) -> bool {
    resp.get("skipped").and_then(Value::as_str) == Some("permission_missing")
}

/// Poll the focus this often between fixed ticks.
const CHANGE_POLL: Duration = Duration::from_millis(400);
/// At least this long between two captures, whatever triggers them.
const CHANGE_MIN_GAP: Duration = Duration::from_secs(1);

/// The recorder's capture: every display, each skipped by the engine while its
/// content hash equals `unchanged`. Input idleness never skips a capture: frames
/// after `inactivity_seconds` without input are marked inactive. `only_focused`:
/// a capture between ticks, after a focus change, records the active display
/// only; every display keeps the fixed tick.
pub(crate) fn capture_request(
    s: &Settings,
    staged: &Path,
    unchanged: &Value,
    only_focused: bool,
) -> Value {
    json!({
        "cmd": if s.privacy.redact_pii { "capture_private" } else { "capture" },
        "all_displays": true,
        "only_focused": only_focused,
        "unchanged": unchanged,
        "out": staged.to_string_lossy(),
        "max_height": s.max_height,
        "max_width": s.max_width,
        "quality": s.staging_quality,
        "exclude_bundle_ids": s.effective_excluded_bundle_ids(),
        "own_bundle_ids": s.own_bundle_ids,
        "exclude_domains": s.effective_excluded_domains(),
        "exclude_private": s.exclude_private_browsing,
        "only_included": s.record_only_included,
        "include_bundle_ids": s.included_bundle_ids,
        "include_domains": s.effective_included_domains(),
        "record_unknown": s.record_unknown_bundle_ids,
        "inactive_after_seconds": s.inactivity_seconds as f64,
        "ax": s.ax_enabled,
        "level": s.ocr_level,
        "languages": s.ocr_languages,
    })
}

/// What the user is looking at: frontmost app, focused window title, browser URL.
#[derive(Debug, Clone, PartialEq, Default)]
struct Focus {
    bundle_id: String,
    title: String,
    url: String,
}

impl Focus {
    /// None when the engine skipped the probe (locked, idle, own window, no app).
    fn from_probe(v: &Value) -> Option<Focus> {
        if v.get("skipped").is_some() {
            return None;
        }
        let app = v.get("app")?;
        Some(Focus {
            bundle_id: str_of(app, "bundle_id").to_lowercase(),
            title: str_of(v, "title").to_string(),
            url: str_of(v, "url").to_string(),
        })
    }
}

/// Why `cur` deserves a capture before the next tick, strongest cause first.
/// A title alone (a terminal spinner, a playing video, an unread count) changes
/// every second and waits for the tick: it pulled a capture and an OCR forward
/// about once a second.
fn change_reason(prev: &Focus, cur: &Focus) -> Option<&'static str> {
    if prev.bundle_id != cur.bundle_id {
        Some("app_switch")
    } else if prev.url != cur.url {
        Some("url_change")
    } else {
        None
    }
}

fn probe_focus(engine: &mut Engine) -> Option<Focus> {
    let resp = engine
        .request(json!({"cmd": "probe"}), Duration::from_secs(2))
        .ok()?;
    Focus::from_probe(&resp)
}

/// Sleep until `deadline`, polling the focus every `poll`. Returns the capture
/// reason as soon as the focus differs from `baseline` and `min_gap` has passed
/// since `last_capture`. Without a change it returns None at the deadline.
///
/// `baseline` follows the focus at each capture decision: a change seen while
/// rate-limited stays pending until a capture happens; the fixed tick adopts the
/// latest focus. The first probe after a gap only fills an empty baseline.
fn wait_for_change(
    probe: &mut dyn FnMut() -> Option<Focus>,
    baseline: &mut Option<Focus>,
    deadline: Instant,
    last_capture: Instant,
    poll: Duration,
    min_gap: Duration,
    stop: &AtomicBool,
) -> Option<&'static str> {
    let mut latest: Option<Focus> = None;
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        std::thread::sleep(poll.min(deadline - now));
        let Some(cur) = probe() else { continue };
        latest = Some(cur.clone());
        match baseline {
            None => *baseline = Some(cur),
            Some(prev) => {
                if let Some(reason) = change_reason(prev, &cur) {
                    if last_capture.elapsed() >= min_gap {
                        *baseline = Some(cur);
                        return Some(reason);
                    }
                }
            }
        }
    }
    if latest.is_some() {
        *baseline = latest;
    }
    None
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
    v.get(key)
        .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn f64_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn file_sha256(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/// Make sure an application row has an icon; fetched once per bundle id.
fn ensure_icon(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    app_id: i64,
    bundle_id: &str,
) {
    let has: Option<String> = conn
        .query_row(
            "SELECT icon_path FROM application WHERE id = ?1",
            [app_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten();
    if has.is_some() || bundle_id.is_empty() {
        return;
    }
    let out = paths
        .icons_dir()
        .join(format!("{}.png", sanitize(bundle_id)));
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
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Record the engine's regular-app classification the first time we see an app.
fn set_user_app(conn: &Connection, app_id: i64, app: &Value) -> Result<()> {
    if let Some(user) = app.get("is_user_app").and_then(Value::as_bool) {
        conn.execute(
            "UPDATE application SET is_user_app = ?1 WHERE id = ?2 AND is_user_app IS NOT ?1",
            params![user as i64, app_id],
        )?;
    }
    Ok(())
}

fn app_for_window(conn: &Connection, bundle_id: &str, name: &str) -> Result<i64> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM application WHERE bundle_id = ?1 ORDER BY id DESC LIMIT 1",
            [bundle_id],
            |r| r.get(0),
        )
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
    private_layout: Option<&OcrLayout>,
) -> Result<i64> {
    let path = PathBuf::from(str_of(resp, "path"));
    let app = resp.get("app").cloned().unwrap_or(Value::Null);
    // Bundle ids are stored lowercased; the icon lookup needs the original case.
    let raw_bundle_id = str_of(&app, "bundle_id").to_string();
    let bundle_id = raw_bundle_id.to_lowercase();
    let app_row = store::upsert_application(
        conn,
        &bundle_id,
        str_of(&app, "version"),
        str_of(&app, "name"),
    )?;
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
    let flag = |v: &Value, k: &str| v.get(k).and_then(Value::as_bool).map(i64::from);
    tx.execute(
        "INSERT INTO frame(timestamp, image_path, width, height, title, segment, is_inactive,
                           capture_display_x, capture_display_y, capture_display_width, capture_display_height,
                           capture_reason, dhash, ocr_status, image_hash, pii_redacted,
                           display_id, display_name, display_main, display_focused, display_scale)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            ts,
            paths.rel(&path),
            i64_of(resp, "width"),
            i64_of(resp, "height"),
            str_of(resp, "title"),
            seg_id,
            resp.get("inactive").and_then(Value::as_bool).unwrap_or(false) as i64,
            f64_of(&display, "x"),
            f64_of(&display, "y"),
            f64_of(&display, "w"),
            f64_of(&display, "h"),
            reason,
            str_of(resp, "dhash"),
            image_hash,
            private_layout.is_some() as i64,
            display.get("id").and_then(Value::as_i64),
            display.get("name").and_then(Value::as_str),
            flag(&display, "main"),
            flag(&display, "focused"),
            f64_of(&display, "scale"),
        ],
    )?;
    let frame_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE segment SET start_frame_id = ?1 WHERE id = ?2 AND start_frame_id = 0",
        params![frame_id, seg_id],
    )?;

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
        tx.execute(
            "INSERT OR IGNORE INTO ax_blob(hash, payload) VALUES (?1, ?2)",
            params![hash, compressed],
        )?;
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
        tx.execute(
            "UPDATE frame SET ax_root_hash = ?1 WHERE id = ?2",
            params![hash, frame_id],
        )?;
    }
    if let Some(layout) = private_layout {
        insert_ocr(&tx, frame_id, layout, 1)?;
    }
    tx.commit()?;
    *segment = Some(SegmentState {
        id: seg_id,
        key,
        last_ts: ts,
    });
    Ok(frame_id)
}

// ---------------------------------------------------------------- OCR worker

/// The next frame to OCR: a staged still first, the focused display's frames
/// before another display's, oldest first.
const OCR_NEXT_SQL: &str = "SELECT id, image_path, image_hash, width, height, capture_display_x, capture_display_y,
        capture_display_width, capture_display_height, display_id, display_focused, timestamp
 FROM frame WHERE ocr_status = 0 ORDER BY image_path IS NULL, COALESCE(display_focused, 1) = 0, id LIMIT 1";

struct PendingFrame {
    id: i64,
    image_path: Option<String>,
    image_hash: Option<String>,
    width: i64,
    height: i64,
    display: (f64, f64, f64, f64),
    display_id: Option<i64>,
    /// The display held the focused window (frames before multi-display count as focused).
    focused: bool,
    ts: i64,
}

fn pending_frame(r: &rusqlite::Row) -> rusqlite::Result<PendingFrame> {
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
        display_id: r.get(9)?,
        focused: r.get::<_, Option<i64>>(10)?.is_none_or(|v| v != 0),
        ts: r.get(11)?,
    })
}

/// A display without the focused window has its text read at most this often;
/// its frames between two reads keep the last text read. Every frame is still written.
pub(crate) const NON_ACTIVE_OCR_EVERY_MS: i64 = 10_000;
/// A display whose last read found at least `CHURN_FRACTION` of it changed
/// (scrolling, a playing video) is read at most this often, focused or not.
pub(crate) const CHURN_OCR_EVERY_MS: i64 = 4_000;
const CHURN_FRACTION: f64 = 0.6;

#[derive(Debug, PartialEq)]
enum OcrPlan {
    /// Copy the text of this earlier frame of the same display.
    Copy(i64),
    Read,
}

/// How a frame gets its text: copied from the previous frame of its display
/// when the still is identical, when the display (without the focus) was read
/// less than `NON_ACTIVE_OCR_EVERY_MS` ago, or when it churns (its last read
/// found `CHURN_FRACTION` of it changed) and was read less than
/// `CHURN_OCR_EVERY_MS` ago; else read. Every frame is written either way.
fn ocr_plan(conn: &Connection, f: &PendingFrame) -> Result<OcrPlan> {
    let prev: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT id, image_hash FROM frame
             WHERE id < ?1 AND ocr_status IN (1, 2) AND pii_redacted = 0 AND display_id IS ?2
             ORDER BY id DESC LIMIT 1",
            params![f.id, f.display_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((prev_id, prev_hash)) = prev else {
        return Ok(OcrPlan::Read);
    };
    if f.image_hash.is_some() && prev_hash == f.image_hash {
        return Ok(OcrPlan::Copy(prev_id));
    }
    if f.display_id.is_some() {
        let last_read: Option<(i64, Option<f64>)> = conn
            .query_row(
                "SELECT timestamp, ocr_changed FROM frame WHERE id < ?1 AND ocr_status = 1 AND display_id IS ?2
                 ORDER BY id DESC LIMIT 1",
                params![f.id, f.display_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((t, changed)) = last_read {
            let every = if !f.focused {
                NON_ACTIVE_OCR_EVERY_MS
            } else if changed.is_some_and(|c| c >= CHURN_FRACTION) {
                CHURN_OCR_EVERY_MS
            } else {
                0
            };
            if f.ts - t < every {
                return Ok(OcrPlan::Copy(prev_id));
            }
        }
    }
    Ok(OcrPlan::Read)
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
        let pending: Option<PendingFrame> =
            conn.query_row(OCR_NEXT_SQL, [], pending_frame).optional()?;
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

fn ocr_one(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
    f: &PendingFrame,
) -> Result<()> {
    // An identical still, or a display without the focus read moments ago: copy the text.
    if let OcrPlan::Copy(prev_id) = ocr_plan(conn, f)? {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE frame SET foreground = (SELECT foreground FROM frame WHERE id = ?2),
                              background = (SELECT background FROM frame WHERE id = ?2), ocr_status = 2
             WHERE id = ?1",
            params![f.id, prev_id],
        )?;
        tx.execute(
            "INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length)
             SELECT ?1, x, y, width, height, text_offset, text_length FROM ocr WHERE frame = ?2",
            params![f.id, prev_id],
        )?;
        tx.commit()?;
        tracing::debug!(frame = f.id, mode = "copied", ms = 0u64, "ocr");
        return Ok(());
    }

    // Staged still, or (imported / deferred frames) a still extracted from its chunk.
    let staged = f
        .image_path
        .as_deref()
        .map(|p| paths.abs(p))
        .filter(|p| p.exists());
    let extracted = match staged {
        Some(_) => None,
        None => {
            let tmp = paths.root.join("tmp").join(format!("ocr_{}.jpg", f.id));
            std::fs::create_dir_all(tmp.parent().expect("tmp dir"))?;
            Some(super::frames::export(
                conn, paths, engine, f.id, &tmp, None,
            )?)
        }
    };
    let image = staged
        .clone()
        .or_else(|| extracted.clone())
        .context("frame has no image")?;
    let backlog: i64 =
        conn.query_row("SELECT count(*) FROM frame WHERE ocr_status = 0", [], |r| {
            r.get(0)
        })?;
    let level = if backlog > OCR_BACKLOG_FAST {
        "fast"
    } else {
        s.ocr_level.as_str()
    };
    let resp = engine.request(
        json!({"cmd": "ocr", "path": image.to_string_lossy(), "level": level, "languages": s.ocr_languages,
               "incremental": staged.is_some(), "cache_key": f.display_id.unwrap_or(0).to_string()}),
        Duration::from_secs(60),
    );
    if let Some(tmp) = &extracted {
        let _ = std::fs::remove_file(tmp);
    }
    let resp = resp?;
    let boxes = resp
        .get("boxes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
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
                      // Pending frames retain the policy at capture time. Private frames already
                      // committed their masked OCR atomically and never enter this worker.
    let layout = split_ocr(&boxes, None);
    write_ocr(conn, f.id, &layout, 1)?;
    conn.execute(
        "UPDATE frame SET ocr_changed = ?1 WHERE id = ?2",
        params![f64_of(&resp, "changed_fraction").unwrap_or(1.0), f.id],
    )?;
    Ok(())
}

fn write_ocr(conn: &Connection, frame: i64, layout: &OcrLayout, status: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    insert_ocr(&tx, frame, layout, status)?;
    tx.commit()?;
    Ok(())
}

fn insert_ocr(conn: &Connection, frame: i64, layout: &OcrLayout, status: i64) -> Result<()> {
    conn.execute(
        "UPDATE frame SET foreground = ?1, background = ?2, ocr_status = ?3 WHERE id = ?4",
        params![
            layout.foreground,
            (!layout.background.is_empty()).then_some(&layout.background),
            status,
            frame
        ],
    )?;
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for b in &layout.boxes {
            stmt.execute(params![frame, b.x, b.y, b.w, b.h, b.offset, b.len])?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
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

/// Redact combined OCR text before its frame and FTS trigger are written.
/// Return the source boxes whose pixels also need covering.
#[cfg(test)]
fn redact_layout(layout: &mut OcrLayout) -> Vec<OcrBox> {
    redact_layout_with_model(layout, None).expect("patterns cannot fail")
}

fn redact_layout_with_model(
    layout: &mut OcrLayout,
    mut model: Option<&mut super::privacy_model::LocalPrivacyModel>,
) -> Result<Vec<OcrBox>> {
    let fg_len = layout.foreground.chars().count();
    let mut fg_scan: Vec<char> = layout.foreground.chars().collect();
    let mut bg_scan: Vec<char> = layout.background.chars().collect();
    // A separator between different screen lines is a detection boundary.
    // Without it a card followed by an SSN on the next line can look like one
    // 19-digit candidate, fail Luhn, and leave the actual card unmasked.
    for pair in layout.boxes.windows(2) {
        let (previous, current) = (&pair[0], &pair[1]);
        if (current.y - previous.y).abs() > previous.h.max(current.h) / 2 {
            let position = current.offset.saturating_sub(1) as usize;
            let (scan, index) = if position < fg_len {
                (&mut fg_scan, position)
            } else {
                (&mut bg_scan, position.saturating_sub(fg_len))
            };
            if let Some(separator) = scan.get_mut(index) {
                if *separator == ' ' {
                    *separator = '\n';
                }
            }
        }
    }
    let fg_text = fg_scan.iter().collect::<String>();
    let bg_text = bg_scan.iter().collect::<String>();
    let fg_spans = model
        .as_mut()
        .map(|m| m.detect(&fg_text))
        .transpose()?
        .unwrap_or_default();
    let bg_spans = model
        .as_mut()
        .map(|m| m.detect(&bg_text))
        .transpose()?
        .unwrap_or_default();
    let fg = redaction::redact_with_spans(&fg_text, &fg_spans);
    let bg = redaction::redact_with_spans(&bg_text, &bg_spans);
    let mut covered = Vec::new();
    for b in &mut layout.boxes {
        let old = b.clone();
        let (start, end, ranges, starts, ends, base) = if b.offset < fg_len as i64 {
            (
                b.offset.max(0) as usize,
                (b.offset + b.len).max(0) as usize,
                &fg.ranges,
                &fg.starts,
                &fg.ends,
                0,
            )
        } else {
            (
                (b.offset - fg_len as i64).max(0) as usize,
                (b.offset + b.len - fg_len as i64).max(0) as usize,
                &bg.ranges,
                &bg.starts,
                &bg.ends,
                fg.text.chars().count(),
            )
        };
        if ranges.iter().any(|(a, z)| start < *z && end > *a) {
            covered.push(old);
        }
        let new_start = starts[start.min(starts.len() - 1)] + base;
        let new_end = ends[end.min(ends.len() - 1)] + base;
        b.offset = new_start as i64;
        b.len = new_end.saturating_sub(new_start) as i64;
    }
    layout.foreground = fg.text.replace('\n', " ");
    layout.background = bg.text.replace('\n', " ");
    Ok(covered)
}

#[cfg(test)]
fn prepare_private_capture(resp: &mut Value, path: &Path, quality: f64) -> Result<OcrLayout> {
    prepare_private_capture_with_model(resp, path, quality, None)
}

pub(crate) fn prepare_private_capture_with_model(
    resp: &mut Value,
    path: &Path,
    quality: f64,
    mut model: Option<&mut super::privacy_model::LocalPrivacyModel>,
) -> Result<OcrLayout> {
    anyhow::ensure!(
        resp.get("privacy_capture").and_then(Value::as_bool) == Some(true),
        "engine does not support in-memory privacy capture"
    );
    let encoded = resp
        .get("image_base64")
        .and_then(Value::as_str)
        .context("private capture missing image")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("invalid private capture image encoding")?;
    let mut image = image::load_from_memory(&bytes)
        .context("invalid private capture image")?
        .to_rgb8();
    anyhow::ensure!(
        i64_of(resp, "width") == image.width() as i64
            && i64_of(resp, "height") == image.height() as i64,
        "private capture dimensions disagree"
    );
    let boxes = resp
        .get("boxes")
        .and_then(Value::as_array)
        .context("private capture missing OCR boxes")?;
    for b in boxes {
        anyhow::ensure!(
            b.get("text").and_then(Value::as_str).is_some(),
            "invalid private OCR text"
        );
        anyhow::ensure!(
            ["x", "y", "w", "h"]
                .iter()
                .all(|key| b.get(*key).and_then(Value::as_i64).is_some()),
            "invalid private OCR coordinates"
        );
        let (x, y, w, h) = (
            i64_of(b, "x"),
            i64_of(b, "y"),
            i64_of(b, "w"),
            i64_of(b, "h"),
        );
        anyhow::ensure!(
            x >= 0
                && y >= 0
                && w > 0
                && h > 0
                && x < image.width() as i64
                && y < image.height() as i64
                && x.saturating_add(w) <= image.width() as i64 + 2
                && y.saturating_add(h) <= image.height() as i64 + 2,
            "invalid private OCR rectangle"
        );
    }
    let original_url = resp.get("url").cloned();
    let mut layout = split_ocr_ordered(boxes, None, true);
    let covered = redact_layout_with_model(&mut layout, model.as_deref_mut())
        .map_err(|_| anyhow::anyhow!("Local privacy inference failed; frame discarded"))?;
    cover_pixels(&mut image, &covered);
    resp["path"] = json!(path.to_string_lossy());

    // Raw IPC payloads never become persisted metadata. Routing identifiers
    // and paths stay intact; only human-facing metadata uses the filter.
    if let Some(obj) = resp.as_object_mut() {
        obj.remove("image_base64");
        obj.remove("boxes");
    }
    for key in ["title", "url", "ax_tree"] {
        if let Some(value) = resp.get_mut(key) {
            redaction::redact_value(value);
        }
    }
    if let Some(name) = resp.get_mut("app").and_then(|app| app.get_mut("name")) {
        redaction::redact_value(name);
    }
    if let Some(windows) = resp.get_mut("windows").and_then(Value::as_array_mut) {
        for window in windows {
            for key in ["title", "url", "app_name"] {
                if let Some(value) = window.get_mut(key) {
                    redaction::redact_value(value);
                }
            }
        }
    }
    if let Some(model) = model {
        // One bounded inference for metadata, retaining neighboring AX labels
        // as context. Routing identifiers and image paths are not model input.
        let mut metadata = json!({"title": resp["title"], "url": resp["url"], "ax_tree": resp["ax_tree"], "app_name": resp["app"]["name"], "windows": resp.get("windows").and_then(Value::as_array).map(|windows| windows.iter().map(|w| json!({"title": w["title"], "url": w["url"], "app_name": w["app_name"]})).collect::<Vec<_>>())});
        super::privacy_model::redact_metadata(model, &mut metadata).map_err(|_| {
            anyhow::anyhow!("Local privacy metadata inference failed; frame discarded")
        })?;
        for key in ["title", "url", "ax_tree"] {
            if resp.get(key).is_some() {
                resp[key] = metadata[key].take();
            }
        }
        if let Some(app) = resp.get_mut("app").and_then(Value::as_object_mut) {
            if app.contains_key("name") {
                app.insert("name".into(), metadata["app_name"].take());
            }
        }
        if let Some(windows) = resp.get_mut("windows").and_then(Value::as_array_mut) {
            for (index, window) in windows.iter_mut().enumerate() {
                for key in ["title", "url", "app_name"] {
                    if window.get(key).is_some() {
                        window[key] = metadata["windows"][index][key].take();
                    }
                }
            }
        }
    }
    if resp.get("url") != original_url.as_ref() && resp.get("domain").is_some() {
        resp["domain"] = json!("[redacted]");
    }
    let thumb = image::imageops::resize(&image, 9, 8, image::imageops::FilterType::Triangle);
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let brightness =
                |pixel: &image::Rgb<u8>| pixel.0.iter().map(|v| u32::from(*v)).sum::<u32>();
            hash = (hash << 1)
                | u64::from(
                    brightness(thumb.get_pixel(x, y)) > brightness(thumb.get_pixel(x + 1, y)),
                );
        }
    }
    resp["dhash"] = json!(format!("{hash:016x}"));
    let mut masked = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(
        &mut masked,
        (quality.clamp(0.0, 1.0) * 100.0) as u8,
    )
    .encode_image(&image)?;
    std::fs::write(path, masked).context("write masked capture")?;
    Ok(layout)
}

fn cover_pixels(image: &mut image::RgbImage, boxes: &[OcrBox]) {
    let (width, height) = image.dimensions();
    for b in boxes {
        let x0 = b.x.saturating_sub(3).clamp(0, width as i64) as u32;
        let y0 = b.y.saturating_sub(3).clamp(0, height as i64) as u32;
        let x1 =
            b.x.saturating_add(b.w)
                .saturating_add(3)
                .clamp(0, width as i64) as u32;
        let y1 =
            b.y.saturating_add(b.h)
                .saturating_add(3)
                .clamp(0, height as i64) as u32;
        for y in y0..y1 {
            for x in x0..x1 {
                image.put_pixel(x, y, image::Rgb([0, 0, 0]));
            }
        }
    }
}

/// Split boxes into focused-window text and the rest, in reading order.
/// Offsets are character offsets into `foreground + background`.
pub fn split_ocr(boxes: &[Value], focus: Option<(f64, f64, f64, f64)>) -> OcrLayout {
    split_ocr_ordered(boxes, focus, false)
}

fn split_ocr_ordered(
    boxes: &[Value],
    focus: Option<(f64, f64, f64, f64)>,
    visual_rows: bool,
) -> OcrLayout {
    let mut items: Vec<(bool, i64, i64, i64, i64, String)> = boxes
        .iter()
        .filter_map(|b| {
            let text = b.get("text")?.as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let (x, y, w, h) = (
                i64_of(b, "x"),
                i64_of(b, "y"),
                i64_of(b, "w"),
                i64_of(b, "h"),
            );
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
    // Different font heights shift OCR tops on the same visual row. Preserve
    // label/value context by ordering each row horizontally, rather than
    // placing a larger value before its smaller field label.
    let mut row = 0;
    while visual_rows && row < items.len() {
        let (fg, _, y, _, h, _) = &items[row];
        let mut end = row + 1;
        while end < items.len()
            && items[end].0 == *fg
            && (items[end].2 - *y).abs() <= items[end].4.max(*h) / 2
        {
            end += 1;
        }
        items[row..end].sort_by_key(|(_, x, y, _, _, _)| (*x, *y));
        row = end;
    }

    let mut foreground = String::new();
    let mut background = String::new();
    let mut boxes_out = Vec::new();
    for (fg, x, y, w, h, text) in &items {
        let target = if *fg {
            &mut foreground
        } else {
            &mut background
        };
        if !target.is_empty() {
            target.push(' ');
        }
        let start = target.chars().count() as i64;
        target.push_str(text);
        let len = text.chars().count() as i64;
        boxes_out.push((
            *fg,
            OcrBox {
                x: *x,
                y: *y,
                w: *w,
                h: *h,
                offset: start,
                len,
            },
        ));
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
    OcrLayout {
        foreground,
        background,
        boxes,
    }
}

// ------------------------------------------------------------ finalizer

struct Staged {
    id: i64,
    path: String,
    width: i64,
    height: i64,
    ts: i64,
    ocr_done: bool,
    display_id: Option<i64>,
}

/// Frames of one display, in order, that become one video.
struct Group<'a> {
    frames: Vec<&'a Staged>,
    /// The newest group of its display: it may still grow.
    open: bool,
}

/// Most recording one item (chunk) covers per display. Live views in Kortix
/// lag an item's length plus OCR, encode and the 5 s sync tick.
pub(crate) const ITEM_SPAN_MS: i64 = 30_000;

/// Consecutive same-size stills of each display, at most `max` per video and
/// at most `ITEM_SPAN_MS` of recording, ordered by their first frame. Frames
/// of different displays interleave in time and never share a video.
fn group_staged(staged: &[Staged], max: usize) -> Vec<Group<'_>> {
    let max = max.max(1);
    let mut groups: Vec<Group> = Vec::new();
    let mut current: HashMap<Option<i64>, usize> = HashMap::new();
    for f in staged {
        let slot = current.get(&f.display_id).copied().filter(|&i| {
            let g = &groups[i];
            g.frames[0].width == f.width
                && g.frames[0].height == f.height
                && g.frames.len() < max
                && f.ts - g.frames[0].ts < ITEM_SPAN_MS
        });
        match slot {
            Some(i) => groups[i].frames.push(f),
            None => {
                if let Some(&i) = current.get(&f.display_id) {
                    groups[i].open = false;
                }
                current.insert(f.display_id, groups.len());
                groups.push(Group {
                    frames: vec![f],
                    open: true,
                });
            }
        }
    }
    for g in &mut groups {
        if g.frames.len() >= max {
            g.open = false;
        }
    }
    groups
}

fn finalize_loop(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
    let conn = store::open(&paths)?;
    let mut engine = Engine::new()?;
    let mut settings = SettingsWatch::new(&paths);
    let mut last_retention = Instant::now() - Duration::from_secs(3600);
    let favicon_rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    while !stop.load(Ordering::SeqCst) {
        let s = settings.refresh().clone();
        match finalize_pass(&conn, &paths, &mut engine, &s, false) {
            Ok(_) => {}
            Err(err) => tracing::warn!("finalize pass failed: {err:#}"),
        }
        if !s.airgap {
            if let Err(err) = fetch_favicons(&conn, &paths, &mut engine, &favicon_rt) {
                tracing::debug!("favicon pass failed: {err:#}");
            }
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

const FAVICON_RETRY_MS: i64 = 7 * 86_400_000;

fn favicon_candidate(domain: &str) -> bool {
    let local = domain == "localhost"
        || domain.ends_with(".localhost")
        || domain.ends_with(".local")
        || domain.ends_with(".internal");
    let ip = domain.parse::<std::net::IpAddr>().is_ok();
    domain.contains('.') && !local && !ip
}

/// Fetch missing website icons (DuckDuckGo icon service), 20 per pass, with a
/// 7-day negative cache. Never runs in airgap mode.
fn fetch_favicons(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    rt: &tokio::runtime::Runtime,
) -> Result<()> {
    let domains: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT d.id, d.normalized_domain FROM domain d
             LEFT JOIN metadata m ON m.key = 'favicon.miss.' || d.normalized_domain
             WHERE d.icon_path IS NULL AND (m.updated_at IS NULL OR m.updated_at < ?1)
             ORDER BY d.id DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([now_ms() - FAVICON_RETRY_MS], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if domains.is_empty() {
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent(super::sync::user_agent())
        .build()?;
    for (id, domain) in domains {
        let fetched = favicon_candidate(&domain)
            .then(|| {
                rt.block_on(async {
                    let resp = client
                        .get(format!("https://icons.duckduckgo.com/ip3/{domain}.ico"))
                        .send()
                        .await
                        .ok()?;
                    if !resp.status().is_success() {
                        return None;
                    }
                    let bytes = resp.bytes().await.ok()?;
                    (bytes.len() > 64).then_some(bytes)
                })
            })
            .flatten();
        match fetched {
            Some(bytes) => {
                let out = paths
                    .icons_dir()
                    .join(format!("domain_{}.ico", sanitize(&domain)));
                std::fs::write(&out, &bytes)?;
                let color = engine
                    .request(
                        json!({"cmd": "image_color", "path": out.to_string_lossy()}),
                        Duration::from_secs(5),
                    )
                    .ok()
                    .and_then(|v| v.get("dominant_color").and_then(Value::as_i64));
                conn.execute(
                    "UPDATE domain SET icon_path = ?1, dominant_color = ?2 WHERE id = ?3",
                    params![paths.rel(&out), color, id],
                )?;
            }
            None => store::set_meta(conn, &format!("favicon.miss.{domain}"), "1")?,
        }
    }
    Ok(())
}

/// Encode ready groups of staged stills. `flush` encodes partial chunks too.
pub fn finalize_pass(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
    flush: bool,
) -> Result<usize> {
    let staged: Vec<Staged> = {
        let mut stmt = conn.prepare(
            "SELECT id, image_path, width, height, timestamp, ocr_status, pii_redacted, display_id FROM frame
             WHERE video IS NULL AND image_path IS NOT NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Staged {
                id: r.get(0)?,
                path: r.get(1)?,
                width: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                height: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                ts: r.get(4)?,
                ocr_done: {
                    let status = r.get::<_, i64>(5)?;
                    if r.get::<_, i64>(6)? != 0 {
                        status == 1
                    } else {
                        status != 0
                    }
                },
                display_id: r.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    // Per display: the stills before its first frame still waiting for OCR.
    let mut blocked: HashMap<Option<i64>, i64> = HashMap::new();
    for f in staged.iter().filter(|f| !f.ocr_done) {
        blocked.entry(f.display_id).or_insert(f.id);
    }
    let ready: Vec<Staged> = staged
        .into_iter()
        .filter(|f| f.ocr_done && blocked.get(&f.display_id).is_none_or(|&b| f.id < b))
        .collect();
    let now = now_ms();
    let mut encoded = 0;
    for group in group_staged(&ready, s.chunk_max_frames) {
        // An open item closes when its span is up, or when its display stopped writing.
        let first = group.frames[0].ts;
        let last = group.frames.last().map(|f| f.ts).unwrap_or(now);
        let due = now - first >= ITEM_SPAN_MS || now - last > FINALIZE_IDLE_MS;
        if group.open && !due && !flush {
            continue;
        }
        encode_group(conn, paths, engine, s, &group.frames)?;
        encoded += 1;
    }
    Ok(encoded)
}

fn encode_group(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
    group: &[&Staged],
) -> Result<()> {
    let inputs: Vec<String> = group
        .iter()
        .map(|f| paths.abs(&f.path).to_string_lossy().into_owned())
        .collect();
    let name = format!(
        "{:x}.mp4",
        Sha256::digest(format!("{}:{}:{}", group[0].id, group[0].ts, now_ms()).as_bytes())
    );
    let out = paths.videos_dir().join(&name);
    let (w, h) = (group[0].width, group[0].height);
    let started = Instant::now();
    let resp = engine.request(
        json!({"cmd": "encode", "inputs": inputs, "out": out.to_string_lossy(), "width": w, "height": h, "quality": s.video_quality}),
        Duration::from_secs(300),
    )?;
    tracing::debug!(
        frames = group.len(),
        w,
        h,
        ms = started.elapsed().as_millis() as u64,
        "encode"
    );
    let size = i64_of(&resp, "size_bytes");
    // The video's display: the newest frame's layout of it (name, bounds, scale).
    let display: Option<String> = conn
        .query_row(
            "SELECT display_id, display_name, capture_display_x, capture_display_y, capture_display_width,
                    capture_display_height, display_scale, display_main
             FROM frame WHERE id = ?1 AND display_id IS NOT NULL",
            [group[group.len() - 1].id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "name": r.get::<_, Option<String>>(1)?,
                    "x": r.get::<_, Option<f64>>(2)?, "y": r.get::<_, Option<f64>>(3)?,
                    "w": r.get::<_, Option<f64>>(4)?, "h": r.get::<_, Option<f64>>(5)?,
                    "scale": r.get::<_, Option<f64>>(6)?, "main": r.get::<_, Option<i64>>(7)?.map(|m| m != 0),
                })
                .to_string())
            },
        )
        .optional()?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO video(height, width, path, num_frames, status, size_bytes, start_timestamp, end_timestamp, display_id, display)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9)",
        params![h, w, name, group.len() as i64, size, group[0].ts, group[group.len() - 1].ts, group[0].display_id, display],
    )?;
    let video_id = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare_cached(
            "UPDATE frame SET video = ?1, video_index = ?2, image_path = NULL WHERE id = ?3",
        )?;
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
    fn private_reading_order_retains_label_context_across_font_sizes() {
        let boxes = [
            b(0, 14, 90, 12, "Customer name"),
            b(100, 10, 90, 20, "Alice Example"),
        ];
        assert_eq!(
            split_ocr_ordered(&boxes, None, true).foreground,
            "Customer name Alice Example"
        );
        assert_eq!(
            split_ocr(&boxes, None).foreground,
            "Alice Example Customer name"
        );
    }

    #[test]
    #[ignore = "requires explicitly installed, checksum-verified local model assets"]
    fn local_model_redacts_synthetic_screen_layout_before_image_database_and_sidecar() {
        let root =
            std::env::var_os("KORTIX_TEST_PRIVACY_MODEL").expect("set test-only model directory");
        let mut model =
            super::super::privacy_model::LocalPrivacyModel::load(std::path::Path::new(&root))
                .unwrap();
        let rows = [
            ("Customer name", "Alice Example"),
            ("Shipping address", "42 Fictional Lane, Example City"),
            ("Email", "alice@example.com"),
            ("Test payment card", "4111 1111 1111 1111"),
            ("Synthetic SSN", "123-45-6789"),
            ("Test phone", "+1 555 010 0100"),
            ("Example IBAN", "GB82 WEST 1234 5698 7654 32"),
            ("Example AWS key", "AKIAIOSFODNN7EXAMPLE"),
            ("Example GitHub token", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ];
        let mut image = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut image)
            .encode_image(&image::RgbImage::from_pixel(
                640,
                480,
                image::Rgb([255, 255, 255]),
            ))
            .unwrap();
        let mut boxes = Vec::new();
        for (index, (label, value)) in rows.iter().enumerate() {
            let y = 10 + index as i64 * 40;
            boxes.push(b(0, y + 4, 220, 12, label));
            boxes.push(b(250, y, 350, 20, value));
        }
        let mut response = json!({"privacy_capture":true,"image_base64":base64::engine::general_purpose::STANDARD.encode(image),"width":640,"height":480,"boxes":boxes});
        let path = std::env::temp_dir().join(format!(
            "kortix-model-synthetic-{}.jpg",
            uuid::Uuid::new_v4()
        ));
        let layout =
            prepare_private_capture_with_model(&mut response, &path, 0.95, Some(&mut model))
                .unwrap();
        let masked = image::open(&path).unwrap().to_rgb8();
        std::fs::remove_file(path).unwrap();
        for (index, (_, value)) in rows.iter().enumerate() {
            assert!(
                !layout.foreground.contains(value),
                "unmasked synthetic field: {value}"
            );
            assert!(masked
                .get_pixel(400, 20 + index as u32 * 40)
                .0
                .iter()
                .all(|v| *v < 3));
        }
        assert!(layout.foreground.contains("[person]"));
        assert!(layout.foreground.contains("[address]"));
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO video(height,width,path,num_frames) VALUES (480,640,'synthetic.mp4',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO frame(timestamp,video,video_index,pii_redacted) VALUES (1,1,0,1)",
            [],
        )
        .unwrap();
        write_ocr(&conn, 1, &layout, 1).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'alice'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let sidecar = String::from_utf8(
            super::super::sync::frames_jsonl(
                &conn,
                &MemoryPaths::at(std::env::temp_dir().join("unused-model-synthetic-library")),
                1,
            )
            .unwrap()
            .0,
        )
        .unwrap();
        for (_, value) in rows {
            assert!(!sidecar.contains(value));
        }
        assert!(sidecar.contains("[person]"));
        assert!(sidecar.contains("\"pii_redacted\":true"));
    }

    fn private_response() -> Value {
        let mut image = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut image)
            .encode_image(&image::RgbImage::from_pixel(
                100,
                40,
                image::Rgb([255, 255, 255]),
            ))
            .unwrap();
        json!({"privacy_capture": true, "image_base64": base64::engine::general_purpose::STANDARD.encode(image),
            "width": 100, "height": 40, "boxes": [b(10, 10, 50, 15, "alice@example.com")],
            "title": "alice@example.com", "url": "https://example.com/?email=alice@example.com",
            "app": {"bundle_id": "com.example.Synthetic", "name": "Synthetic"},
            "windows": [{"bundle_id": "com.example.Synthetic", "title": "alice@example.com"}],
            "ax_tree": {"value": "alice@example.com"}})
    }

    #[test]
    fn private_capture_first_write_is_masked_and_metadata_is_sanitized() {
        let path =
            std::env::temp_dir().join(format!("kortix-private-{}.jpg", uuid::Uuid::new_v4()));
        let mut response = private_response();
        let layout = prepare_private_capture(&mut response, &path, 0.95).unwrap();
        assert_eq!(layout.foreground, "[email]");
        assert!(response.get("image_base64").is_none());
        assert!(response.get("boxes").is_none());
        assert!(!response.to_string().contains("alice@example.com"));
        assert_eq!(response["app"]["bundle_id"], "com.example.Synthetic");
        let pixels = image::open(&path).unwrap().to_rgb8();
        assert!(pixels.get_pixel(30, 15).0.iter().all(|v| *v < 10));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn private_capture_fails_closed_on_unsupported_or_malformed_engine_data() {
        let path =
            std::env::temp_dir().join(format!("kortix-rejected-{}.jpg", uuid::Uuid::new_v4()));
        for key in ["privacy_capture", "image_base64", "boxes"] {
            let mut response = private_response();
            response.as_object_mut().unwrap().remove(key);
            assert!(prepare_private_capture(&mut response, &path, 0.8).is_err());
            assert!(!path.exists());
        }
        let mut response = private_response();
        response["boxes"][0]["x"] = json!(-20);
        assert!(prepare_private_capture(&mut response, &path, 0.8).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn invalid_hot_reload_does_not_turn_privacy_off() {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kortix-settings-{}", uuid::Uuid::new_v4())),
        );
        paths.ensure().unwrap();
        let mut settings = Settings::default();
        settings.privacy.redact_pii = true;
        settings.save(&paths).unwrap();
        let mut watch = SettingsWatch::new(&paths);
        assert!(watch.refresh().privacy.redact_pii);
        std::fs::write(paths.settings(), b"{").unwrap();
        watch.mtime = None;
        assert!(watch.refresh().privacy.redact_pii);
        std::fs::remove_file(paths.settings()).unwrap();
        assert!(watch.refresh().privacy.redact_pii);
        settings.privacy.redact_pii = false;
        settings.save(&paths).unwrap();
        assert!(!watch.refresh().privacy.redact_pii);
        std::fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn invalid_or_unreadable_initial_settings_disable_capture() {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kortix-invalid-settings-{}", uuid::Uuid::new_v4())),
        );
        paths.ensure().unwrap();
        std::fs::write(paths.settings(), b"{").unwrap();
        assert!(!SettingsWatch::new(&paths).refresh().recording_enabled);
        std::fs::remove_file(paths.settings()).unwrap();
        // A directory reliably fails reading even when tests run as root.
        std::fs::create_dir(paths.settings()).unwrap();
        assert!(!SettingsWatch::new(&paths).refresh().recording_enabled);
        std::fs::remove_dir(paths.settings()).unwrap();
        assert!(SettingsWatch::new(&paths).refresh().recording_enabled);
        std::fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn byte_identical_ocr_copy_keeps_the_policy_at_capture_time() {
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        conn.execute("INSERT INTO frame(timestamp, image_hash, foreground, ocr_status, pii_redacted) VALUES (1, 'synthetic-identical', 'alice@example.com', 1, 0)", []).unwrap();
        conn.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (1, 0, 0, 80, 10, 0, 17)", []).unwrap();
        conn.execute("INSERT INTO frame(timestamp, image_hash, foreground, ocr_status, pii_redacted) VALUES (2, 'synthetic-identical', '[email]', 1, 1)", []).unwrap();
        conn.execute("INSERT INTO frame(timestamp, image_hash, ocr_status) VALUES (3, 'synthetic-identical', 0)", []).unwrap();
        let mut engine = Engine::without_process_for_test();
        let mut current_settings = Settings::default();
        current_settings.privacy.redact_pii = true;
        let frame = PendingFrame {
            id: 3,
            image_path: None,
            image_hash: Some("synthetic-identical".into()),
            width: 100,
            height: 40,
            display: (0.0, 0.0, 100.0, 40.0),
            display_id: None,
            focused: true,
            ts: 3,
        };
        ocr_one(
            &conn,
            &MemoryPaths::at("unused-synthetic-library"),
            &mut engine,
            &current_settings,
            &frame,
        )
        .unwrap();
        let (text, status): (String, i64) = conn
            .query_row(
                "SELECT foreground, ocr_status FROM frame WHERE id = 3",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(text, "alice@example.com");
        assert_eq!(status, 2);
        let len: i64 = conn
            .query_row("SELECT text_length FROM ocr WHERE frame = 3", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(len, 17);
    }

    #[test]
    fn redacted_screen_text_stays_out_of_fts_and_sync_sidecar() {
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        conn.execute("INSERT INTO video(height, width, path, num_frames) VALUES (80, 160, 'synthetic.mp4', 1)", []).unwrap();
        conn.execute(
            "INSERT INTO frame(timestamp, video, video_index, title) VALUES (1, 1, 0, 'Synthetic')",
            [],
        )
        .unwrap();
        let mut layout = split_ocr(&[b(10, 10, 140, 20, "alice@example.com")], None);
        let covered = redact_layout(&mut layout);
        assert_eq!(covered.len(), 1);
        assert_eq!(layout.foreground, "[email]");
        write_ocr(&conn, 1, &layout, 1).unwrap();
        let found: i64 = conn
            .query_row(
                "SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'alice'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 0);
        let sidecar = String::from_utf8(
            super::super::sync::frames_jsonl(
                &conn,
                &MemoryPaths::at(std::env::temp_dir().join("kortix-synthetic-sidecar-test")),
                1,
            )
            .unwrap()
            .0,
        )
        .unwrap();
        assert!(sidecar.contains("[email]"));
        assert!(!sidecar.contains("alice@example.com"));

        let plain = split_ocr(&[b(0, 0, 50, 10, "alice@example.com")], None);
        assert_eq!(plain.foreground, "alice@example.com");
    }

    #[test]
    fn redaction_updates_following_box_offsets() {
        let mut layout = split_ocr(
            &[
                b(0, 0, 90, 10, "alice@example.com"),
                b(100, 0, 40, 10, "notes"),
            ],
            None,
        );
        redact_layout(&mut layout);
        assert_eq!(layout.foreground, "[email] notes");
        let text: Vec<char> = layout.foreground.chars().collect();
        let second = &layout.boxes[1];
        assert_eq!(
            text[second.offset as usize..(second.offset + second.len) as usize]
                .iter()
                .collect::<String>(),
            "notes"
        );
    }

    #[test]
    fn adjacent_numeric_screen_lines_cannot_hide_a_valid_card() {
        let mut layout = split_ocr(
            &[
                b(0, 0, 90, 10, "4111 1111 1111 1111"),
                b(0, 30, 90, 10, "123-45-6789"),
            ],
            None,
        );
        let covered = redact_layout(&mut layout);
        assert_eq!(layout.foreground, "[card] [ssn]");
        assert_eq!(covered.len(), 2);
        assert_eq!(layout.boxes[1].offset, 7);
    }

    #[test]
    fn matched_screen_region_is_covered_before_encoding() {
        let path =
            std::env::temp_dir().join(format!("kortix-pii-synthetic-{}.jpg", std::process::id()));
        image::RgbImage::from_pixel(100, 40, image::Rgb([255, 255, 255]))
            .save(&path)
            .unwrap();
        let mut pixels = image::open(&path).unwrap().to_rgb8();
        cover_pixels(
            &mut pixels,
            &[OcrBox {
                x: 10,
                y: 10,
                w: 30,
                h: 12,
                offset: 0,
                len: 7,
            }],
        );
        pixels.save(&path).unwrap();
        let image = image::open(&path).unwrap().to_rgb8();
        assert!(image.get_pixel(20, 15).0.iter().all(|v| *v < 10));
        assert!(image.get_pixel(90, 30).0.iter().all(|v| *v > 245));
        let _ = std::fs::remove_file(path);
    }

    fn b(x: i64, y: i64, w: i64, h: i64, t: &str) -> Value {
        json!({"x": x, "y": y, "w": w, "h": h, "text": t})
    }

    #[test]
    fn ocr_split_orders_text_and_offsets_into_concatenation() {
        let boxes = vec![
            b(500, 10, 50, 20, "menu"),   // outside focus -> background
            b(120, 200, 80, 20, "world"), // focus, second on the row
            b(10, 200, 80, 20, "hello"),  // focus, first on the row
            b(10, 100, 80, 20, "title"),  // focus, earlier row
            b(10, 300, 80, 20, "   "),    // blank dropped
        ];
        let layout = split_ocr(&boxes, Some((0.0, 50.0, 400.0, 400.0)));
        assert_eq!(layout.foreground, "title hello world");
        assert_eq!(layout.background, "menu");
        let all = format!("{}{}", layout.foreground, layout.background);
        for bx in &layout.boxes {
            let text: String = all
                .chars()
                .skip(bx.offset as usize)
                .take(bx.len as usize)
                .collect();
            assert!(
                ["title", "hello", "world", "menu"].contains(&text.as_str()),
                "{text}"
            );
        }
        let menu = layout.boxes.iter().find(|bx| bx.x == 500).unwrap();
        assert_eq!(menu.offset, layout.foreground.chars().count() as i64);
    }

    #[test]
    fn favicons_skip_local_and_ip_hosts() {
        assert!(favicon_candidate("github.com"));
        assert!(!favicon_candidate("localhost"));
        assert!(!favicon_candidate("abc.apps.localhost"));
        assert!(!favicon_candidate("10.0.0.1"));
        assert!(!favicon_candidate("intranet"));
    }

    #[test]
    fn recorder_layout_is_top_to_bottom_space_joined() {
        // Every box in `foreground`, sorted by y then x, joined by one space.
        let boxes = vec![
            b(1392, 7, 50, 20, "a"),
            b(127, 51, 50, 20, "c"),
            b(1494, 8, 50, 20, "b"),
            b(1188, 68, 9, 9, "e"),
            b(876, 68, 9, 9, "d"),
        ];
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

    fn focus(app: &str, title: &str, url: &str) -> Focus {
        Focus {
            bundle_id: app.into(),
            title: title.into(),
            url: url.into(),
        }
    }

    #[test]
    fn change_reason_names_the_strongest_cause() {
        let base = focus("com.a", "Inbox", "https://x.test/1");
        assert_eq!(change_reason(&base, &base.clone()), None);
        assert_eq!(
            change_reason(&base, &focus("com.b", "Inbox", "https://x.test/1")),
            Some("app_switch")
        );
        assert_eq!(
            change_reason(&base, &focus("com.b", "Other", "https://y.test")),
            Some("app_switch")
        );
        assert_eq!(
            change_reason(&base, &focus("com.a", "Inbox", "https://x.test/2")),
            Some("url_change")
        );
        assert_eq!(
            change_reason(&base, &focus("com.a", "Draft", "https://x.test/2")),
            Some("url_change")
        );
        // A title alone (a terminal spinner, a playing video, an unread count)
        // changes every second: it waits for the 2 s tick.
        assert_eq!(
            change_reason(&base, &focus("com.a", "Draft", "https://x.test/1")),
            None
        );
    }

    #[test]
    fn a_missing_screen_permission_is_its_own_skip() {
        assert!(is_permission_skip(
            &json!({"skipped": "permission_missing", "permission": "screen"})
        ));
        for other in ["locked", "inactive", "self_on_screen", "excluded_app"] {
            assert!(!is_permission_skip(&json!({ "skipped": other })));
        }
        assert!(!is_permission_skip(&json!({"app": {"bundle_id": "x"}})));
        assert!(PERMISSION_RECHECK >= Duration::from_secs(30));
    }

    #[test]
    fn probe_response_parses_and_skips_do_not_count() {
        let f = Focus::from_probe(&json!({"app": {"bundle_id": "com.Apple.Safari"}, "title": "T", "url": "https://u.test"})).unwrap();
        assert_eq!(f, focus("com.apple.safari", "T", "https://u.test"));
        assert_eq!(
            Focus::from_probe(&json!({"app": {"bundle_id": "x"}, "title": ""}))
                .unwrap()
                .url,
            ""
        );
        for skipped in ["locked", "inactive", "self_on_screen", "no_frontmost_app"] {
            assert_eq!(
                Focus::from_probe(&json!({"skipped": skipped, "app": {"bundle_id": "x"}})),
                None
            );
        }
    }

    fn scripted(seq: Vec<Option<Focus>>) -> impl FnMut() -> Option<Focus> {
        let mut i = 0;
        move || {
            let v = seq
                .get(i)
                .cloned()
                .unwrap_or_else(|| seq.last().cloned().flatten().map(Some).unwrap_or(None));
            i += 1;
            v
        }
    }

    const POLL: Duration = Duration::from_millis(5);

    #[test]
    fn a_change_triggers_an_early_capture_with_its_reason() {
        let stop = AtomicBool::new(false);
        let mut baseline = Some(focus("com.a", "T", ""));
        let mut probe = scripted(vec![
            Some(focus("com.a", "T", "")),
            Some(focus("com.b", "T", "")),
        ]);
        let started = Instant::now();
        let r = wait_for_change(
            &mut probe,
            &mut baseline,
            started + Duration::from_secs(5),
            started - Duration::from_secs(10),
            POLL,
            Duration::from_millis(50),
            &stop,
        );
        assert_eq!(r, Some("app_switch"));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "returned long before the deadline"
        );
        assert_eq!(
            baseline,
            Some(focus("com.b", "T", "")),
            "baseline moves to the captured focus"
        );
    }

    #[test]
    fn no_change_waits_the_full_interval_and_returns_none() {
        let stop = AtomicBool::new(false);
        let mut baseline = Some(focus("com.a", "T", ""));
        let mut probe = scripted(vec![Some(focus("com.a", "T", ""))]);
        let started = Instant::now();
        let r = wait_for_change(
            &mut probe,
            &mut baseline,
            started + Duration::from_millis(60),
            started,
            POLL,
            Duration::ZERO,
            &stop,
        );
        assert_eq!(r, None);
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[test]
    fn captures_are_rate_limited() {
        let stop = AtomicBool::new(false);
        // The focus changes at once, but the last capture was just now: the min gap holds it back.
        let mut baseline = Some(focus("com.a", "T", ""));
        let mut probe = scripted(vec![Some(focus("com.b", "T", ""))]);
        let started = Instant::now();
        let r = wait_for_change(
            &mut probe,
            &mut baseline,
            started + Duration::from_millis(300),
            started,
            POLL,
            Duration::from_millis(120),
            &stop,
        );
        assert_eq!(r, Some("app_switch"));
        assert!(
            started.elapsed() >= Duration::from_millis(120),
            "waited the min gap: {:?}",
            started.elapsed()
        );

        // A deadline before the gap ends: no early capture, and the fixed tick adopts the latest focus.
        let mut baseline = Some(focus("com.a", "T", ""));
        let mut probe = scripted(vec![Some(focus("com.b", "T", ""))]);
        let started = Instant::now();
        let r = wait_for_change(
            &mut probe,
            &mut baseline,
            started + Duration::from_millis(40),
            started,
            POLL,
            Duration::from_secs(5),
            &stop,
        );
        assert_eq!(r, None);
        assert_eq!(baseline, Some(focus("com.b", "T", "")));
    }

    #[test]
    fn empty_baseline_adopts_the_first_probe_without_triggering() {
        let stop = AtomicBool::new(false);
        let mut baseline = None;
        let mut probe = scripted(vec![Some(focus("com.a", "T", ""))]);
        let started = Instant::now();
        let r = wait_for_change(
            &mut probe,
            &mut baseline,
            started + Duration::from_millis(40),
            started - Duration::from_secs(9),
            POLL,
            Duration::ZERO,
            &stop,
        );
        assert_eq!(r, None);
        assert_eq!(baseline, Some(focus("com.a", "T", "")));
    }

    #[test]
    fn skipped_probes_and_a_stop_flag_never_trigger() {
        let stop = AtomicBool::new(false);
        let mut baseline = Some(focus("com.a", "T", ""));
        let mut probe = || None;
        let started = Instant::now();
        assert_eq!(
            wait_for_change(
                &mut probe,
                &mut baseline,
                started + Duration::from_millis(30),
                started,
                POLL,
                Duration::ZERO,
                &stop
            ),
            None
        );
        assert_eq!(baseline, Some(focus("com.a", "T", "")));
        stop.store(true, Ordering::SeqCst);
        let mut probe = scripted(vec![Some(focus("com.b", "T", ""))]);
        assert_eq!(
            wait_for_change(
                &mut probe,
                &mut baseline,
                started + Duration::from_secs(5),
                started,
                POLL,
                Duration::ZERO,
                &stop
            ),
            None
        );
    }

    #[test]
    fn input_idleness_no_longer_pauses_libraries_that_kept_the_old_default() {
        let dir = std::env::temp_dir().join(format!("kmem-idle-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let conn = store::open(&paths).unwrap();
        assert!(!Settings::default().pause_on_inactivity);
        let mut s = Settings::default();
        s.pause_on_inactivity = true;
        s.inactivity_seconds = 5;
        s.save(&paths).unwrap();
        run_once_tasks(&conn, &paths).unwrap();
        assert!(!Settings::load(&paths).pause_on_inactivity);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_capture_request_marks_idle_frames_but_never_skips_them() {
        let s = Settings::default();
        let mut s = s;
        s.own_bundle_ids = vec!["com.kortix.desktop.capturetest".into()];
        let req = capture_request(&s, Path::new("/tmp/x.jpg"), &json!({"1": "h"}), false);
        assert_eq!(
            req["own_bundle_ids"],
            json!(["com.kortix.desktop.capturetest"])
        );
        assert_eq!(req["all_displays"], true);
        assert_eq!(req["only_focused"], false);
        // A focus change between two ticks captures the active display only;
        // every display keeps the fixed tick.
        assert_eq!(
            capture_request(&s, Path::new("/tmp/x.jpg"), &json!({}), true)["only_focused"],
            true
        );
        assert_eq!(req["inactive_after_seconds"], s.inactivity_seconds as f64);
        assert!(
            req.get("max_idle_seconds").is_none(),
            "idleness never skips a capture"
        );
        assert_eq!(req["unchanged"], json!({"1": "h"}));
    }

    #[test]
    fn archived_scale_default_moves_once_for_libraries_that_pinned_the_old_one() {
        let dir = std::env::temp_dir().join(format!("kmem-once-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let conn = store::open(&paths).unwrap();
        let mut s = Settings::default();
        s.storage.archived_scale = 0.5;
        s.save(&paths).unwrap();
        run_once_tasks(&conn, &paths).unwrap();
        assert_eq!(Settings::load(&paths).storage.archived_scale, 0.75);
        // The user picks 0.5 again later: the task is spent and does not touch it.
        s.storage.archived_scale = 0.5;
        s.save(&paths).unwrap();
        run_once_tasks(&conn, &paths).unwrap();
        assert_eq!(Settings::load(&paths).storage.archived_scale, 0.5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_old_until_space_runs_low_default_moves_to_seven_days_once() {
        let dir = std::env::temp_dir().join(format!("kmem-keep7-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let conn = store::open(&paths).unwrap();
        let mut s = Settings::default();
        (s.storage.management_mode, s.storage.cap_action) = ("storage_cap".into(), "delete".into());
        (s.storage.retention_days, s.storage.retention_action) = (90, "downscale".into());
        s.save(&paths).unwrap();
        run_once_tasks(&conn, &paths).unwrap();
        let st = Settings::load(&paths).storage;
        assert_eq!((st.management_mode.as_str(), st.retention_days, st.retention_action.as_str()), ("retention", 7, "delete"));
        // The person picks "until space runs low" later: the task is spent and leaves it.
        s.save(&paths).unwrap();
        run_once_tasks(&conn, &paths).unwrap();
        assert_eq!(Settings::load(&paths).storage.management_mode, "storage_cap");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ multi-display

    fn two_display_capture(main_unchanged: bool, idle: bool) -> Value {
        json!({
            "app": {"pid": 7, "bundle_id": "com.apple.Safari", "name": "Safari"},
            "title": "Docs", "url": "https://docs.example.com/a",
            "ax_tree": {"role": "AXWindow"}, "ax_node_count": 1, "ax_partial": false,
            "inactive": idle,
            "windows": [
                {"bundle_id": "com.apple.Safari", "app_name": "Safari", "title": "Docs", "x": 0, "y": 0, "w": 1700, "h": 1000, "layer": 0, "z": 0, "focused": true},
                {"bundle_id": "com.tinyspeck.slackmacgap", "app_name": "Slack", "title": "general", "x": 1800, "y": 0, "w": 1600, "h": 1400, "layer": 0, "z": 1, "focused": false}
            ],
            "displays": [
                {"display": {"id": 1, "name": "Built-in Retina Display", "x": 0, "y": 0, "w": 1728, "h": 1117, "scale": 2, "main": true, "focused": true},
                 "unchanged": main_unchanged, "path": "/tmp/a_d1.jpg", "width": 1728, "height": 1117, "dhash": "aa", "content_hash": "h1"},
                {"display": {"id": 2, "name": "LG ULTRAWIDE", "x": 1728, "y": 0, "w": 3440, "h": 1440, "scale": 1, "main": false, "focused": false},
                 "path": "/tmp/a_d2.jpg", "width": 3440, "height": 1440, "dhash": "bb", "content_hash": "h2",
                 "app": {"pid": 9, "bundle_id": "com.tinyspeck.slackmacgap", "name": "Slack"}, "title": "general"}
            ]
        })
    }

    #[test]
    fn every_display_that_changed_becomes_its_own_frame() {
        let frames = display_frames(&two_display_capture(false, false));
        assert_eq!(frames.len(), 2);
        let (main, wide) = (&frames[0], &frames[1]);
        assert_eq!(main["display"]["id"], 1);
        assert_eq!(main["display"]["focused"], true);
        assert_eq!(main["app"]["bundle_id"], "com.apple.Safari");
        assert_eq!(main["url"], "https://docs.example.com/a");
        assert_eq!(main["ax_tree"]["role"], "AXWindow");
        assert_eq!(main["path"], "/tmp/a_d1.jpg");
        // The other display: the app and title of its own top window, no AX tree,
        // no URL of the focused window, and only the windows on it.
        assert_eq!(wide["display"]["name"], "LG ULTRAWIDE");
        assert_eq!(wide["app"]["bundle_id"], "com.tinyspeck.slackmacgap");
        assert_eq!(wide["title"], "general");
        assert!(wide.get("url").is_none());
        assert!(wide.get("ax_tree").is_none());
        let titles: Vec<&str> = wide["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["general"]);
    }

    #[test]
    fn an_unchanged_display_writes_no_frame() {
        let frames = display_frames(&two_display_capture(true, false));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["display"]["id"], 2);
    }

    #[test]
    fn idle_but_screen_changing_still_writes_frames_marked_inactive() {
        let frames = display_frames(&two_display_capture(false, true));
        assert_eq!(
            frames.len(),
            2,
            "no input does not stop recording a display that changes"
        );
        assert!(frames.iter().all(|f| f["inactive"] == true));
    }

    #[test]
    fn an_engine_without_displays_keeps_the_single_frame() {
        let old = json!({"app": {"bundle_id": "com.x"}, "path": "/tmp/x.jpg", "display": {"x": 0, "y": 0, "w": 10, "h": 10}});
        let frames = display_frames(&old);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["path"], "/tmp/x.jpg");
    }

    #[test]
    fn the_unchanged_map_forgets_a_display_after_the_keepalive() {
        let mut last = HashMap::new();
        last.insert(1i64, ("h1".to_string(), 1_000i64));
        last.insert(2i64, ("h2".to_string(), 1_000i64 - KEEPALIVE_MS));
        let req = unchanged_request(&last, 1_000);
        assert_eq!(
            req,
            json!({"1": "h1"}),
            "a display unchanged for the keepalive writes a frame again"
        );
    }

    fn staged(id: i64, display: i64, w: i64, ts: i64) -> Staged {
        Staged {
            id,
            path: format!("f{id}.jpg"),
            width: w,
            height: 10,
            ts,
            ocr_done: true,
            display_id: Some(display),
        }
    }

    #[test]
    fn videos_never_mix_displays() {
        let frames = [
            staged(1, 1, 20, 0),
            staged(2, 2, 40, 0),
            staged(3, 1, 20, 2000),
            staged(4, 2, 40, 2000),
            staged(5, 1, 20, 4000),
        ];
        let groups = group_staged(&frames, 100);
        let ids: Vec<Vec<i64>> = groups
            .iter()
            .map(|g| g.frames.iter().map(|f| f.id).collect())
            .collect();
        assert_eq!(ids, [vec![1, 3, 5], vec![2, 4]]);
        assert!(
            groups.iter().all(|g| g.open),
            "the newest group of each display stays open"
        );
        let full = group_staged(&frames, 2);
        let ids: Vec<Vec<i64>> = full
            .iter()
            .map(|g| g.frames.iter().map(|f| f.id).collect())
            .collect();
        assert_eq!(ids, [vec![1, 3], vec![2, 4], vec![5]]);
        assert_eq!(
            full.iter().map(|g| g.open).collect::<Vec<_>>(),
            [false, false, true],
            "a full group closes; the newest partial one stays open"
        );
    }

    #[test]
    fn an_item_covers_at_most_thirty_seconds_of_a_display() {
        // One frame every 2 s for 70 s on one display: three items, the last one still open.
        let frames: Vec<Staged> = (0..36).map(|i| staged(i + 1, 1, 20, i * 2_000)).collect();
        let groups = group_staged(&frames, 1_000);
        let spans: Vec<(i64, i64)> = groups
            .iter()
            .map(|g| (g.frames[0].ts, g.frames.last().unwrap().ts))
            .collect();
        assert_eq!(spans, [(0, 28_000), (30_000, 58_000), (60_000, 70_000)]);
        assert_eq!(
            groups.iter().map(|g| g.open).collect::<Vec<_>>(),
            [false, false, true]
        );
    }

    #[test]
    fn ocr_reads_the_focused_display_first() {
        let dir = std::env::temp_dir().join(format!("kmem-ocrq-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let conn = store::open(&paths).unwrap();
        for (focused, path) in [(0, "frames/other.jpg"), (1, "frames/focused.jpg")] {
            conn.execute(
                "INSERT INTO frame(timestamp, image_path, ocr_status, display_id, display_focused) VALUES (1, ?1, 0, ?2, ?3)",
                params![path, 10 + focused, focused],
            )
            .unwrap();
        }
        let next: String = conn.query_row(OCR_NEXT_SQL, [], |r| r.get(1)).unwrap();
        assert_eq!(next, "frames/focused.jpg");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The macOS engine matches pages by the one domain rule (the shared vectors).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_engine_matches_domains_by_the_shared_vectors() {
        let Ok(mut engine) = Engine::new() else {
            eprintln!("skipped: no capture engine in this build");
            return;
        };
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/capture-format-v2/domains.json"
        );
        let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for c in v["matches"].as_array().unwrap() {
            let res = engine
                .request(
                    json!({"cmd": "_domain_match", "url": c["url"], "patterns": [c["pattern"]]}),
                    Duration::from_secs(5),
                )
                .unwrap();
            assert_eq!(res["match"], c["match"], "{c}");
        }
    }

    /// The macOS engine's display plan: which windows it hides from every display,
    /// which display a hidden window fully covers, and each display's top window.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_engine_hides_excluded_windows_on_every_display_and_names_each_top_window() {
        let Ok(mut engine) = Engine::new() else {
            eprintln!("skipped: no capture engine in this build");
            return;
        };
        let w = |id: i64,
                 bundle: &str,
                 title: &str,
                 url: Option<&str>,
                 x: i64,
                 wd: i64,
                 hd: i64| {
            json!({"window_id": id, "bundle_id": bundle, "app_name": bundle, "title": title, "url": url,
                   "x": x, "y": 0, "w": wd, "h": hd, "layer": 0})
        };
        let plan = engine
            .request(
                json!({
                    "cmd": "_plan_displays",
                    "exclude_bundle_ids": ["com.1password.1password"],
                    "exclude_domains": ["bank.example"],
                    "exclude_private": true,
                    "own_bundle_ids": ["com.example.host"],
                    "displays": [{"id": 1, "x": 0, "y": 0, "w": 1728, "h": 1117}, {"id": 2, "x": 1728, "y": 0, "w": 3440, "h": 1440}],
                    // Front to back.
                    "windows": [
                        w(5, "com.kortix.desktop.capturetest", "Kortix Capture", None, 1800, 800, 600),
                        w(6, "com.example.host", "Host", None, 2700, 300, 300),
                        w(10, "com.apple.Safari", "Notes — Private Browsing", None, 0, 1728, 1117),
                        w(20, "com.1password.1password", "Vault", None, 1800, 600, 400),
                        w(30, "com.tinyspeck.slackmacgap", "general", None, 2000, 1600, 1400),
                        w(40, "com.google.Chrome", "Statement", Some("https://login.bank.example/s"), 1728, 3440, 1440),
                    ],
                }),
                Duration::from_secs(5),
            )
            .unwrap();
        let mut hidden: Vec<i64> = plan["hidden"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        hidden.sort();
        assert_eq!(
            hidden,
            [5, 6, 10, 20, 40],
            "Kortix's own windows are never recorded"
        );
        let d = |id: i64| {
            plan["displays"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(
            d(1)["covered"],
            true,
            "a private window filling the display: no frame of it"
        );
        assert_eq!(d(2)["covered"], false);
        assert_eq!(
            d(2)["top"]["bundle_id"],
            "com.tinyspeck.slackmacgap",
            "hidden windows never name a display"
        );
        assert_eq!(d(2)["top"]["title"], "general");

        // Record only included: Slack (an app) and github.com (a website, in any browser).
        let plan = engine
            .request(
                json!({
                    "cmd": "_plan_displays",
                    "exclude_private": true,
                    "only_included": true,
                    "include_bundle_ids": ["com.tinyspeck.slackmacgap"],
                    "include_domains": ["github.com"],
                    "displays": [{"id": 1, "x": 0, "y": 0, "w": 1728, "h": 1117}, {"id": 2, "x": 1728, "y": 0, "w": 3440, "h": 1440}],
                    "windows": [
                        w(10, "com.spotify.client", "Spotify", None, 0, 1728, 1117),
                        w(30, "com.tinyspeck.slackmacgap", "general", None, 2000, 1600, 1400),
                        w(40, "com.google.Chrome", "PR", Some("https://github.com/kortix-ai/suna"), 1728, 3440, 1440),
                        w(50, "com.google.Chrome", "Video", Some("https://youtube.com/watch"), 1728, 800, 600),
                    ],
                }),
                Duration::from_secs(5),
            )
            .unwrap();
        let mut hidden: Vec<i64> = plan["hidden"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        hidden.sort();
        assert_eq!(hidden, [10, 50], "not included: hidden");
        let d = |id: i64| {
            plan["displays"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(d(1)["covered"], true, "no included window: no frame");
        assert_eq!(d(2)["covered"], false);
    }

    #[test]
    fn a_static_display_writes_keepalive_frames() {
        let frame = json!({"content_hash": "h1"});
        assert_eq!(
            frame_reason(&frame, Some(&("h1".into(), 0)), "fixed_interval"),
            "keepalive"
        );
        assert_eq!(
            frame_reason(&frame, Some(&("h0".into(), 0)), "fixed_interval"),
            "fixed_interval"
        );
        assert_eq!(frame_reason(&frame, None, "initial"), "initial");
    }

    #[test]
    fn an_active_display_only_capture_keeps_the_other_displays_in_the_status() {
        let mut displays = vec![
            DisplayStatus {
                id: 1,
                focused: true,
                last_frame_ms: Some(10),
                ..Default::default()
            },
            DisplayStatus {
                id: 4,
                focused: false,
                last_frame_ms: Some(10),
                ..Default::default()
            },
        ];
        let only =
            json!([{"display": {"id": 4, "focused": true, "x": 0, "y": 0, "w": 10, "h": 10}}]);
        update_layout(&mut displays, only.as_array().unwrap(), true);
        assert_eq!(
            displays
                .iter()
                .map(|d| (d.id, d.focused))
                .collect::<Vec<_>>(),
            [(4, true), (1, false)]
        );
        let all = json!([{"display": {"id": 4, "focused": true}}]);
        update_layout(&mut displays, all.as_array().unwrap(), false);
        assert_eq!(
            displays.iter().map(|d| d.id).collect::<Vec<_>>(),
            [4],
            "a full capture is the layout: a display that left is gone"
        );
    }

    fn ocr_lib() -> (MemoryPaths, Connection) {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kmem-ocrp-{}", uuid::Uuid::new_v4().simple())),
        );
        paths.ensure().unwrap();
        let conn = store::open(&paths).unwrap();
        (paths, conn)
    }

    /// A frame of `display` at `ts`, OCR'd (`read`) or pending, with an image hash.
    fn ocr_frame(
        conn: &Connection,
        display: i64,
        focused: bool,
        ts: i64,
        hash: &str,
        status: i64,
    ) -> i64 {
        conn.execute(
            "INSERT INTO frame(timestamp, image_path, image_hash, ocr_status, display_id, display_focused, foreground)
             VALUES (?1, 'frames/x.jpg', ?2, ?3, ?4, ?5, 'text')",
            params![ts, hash, status, display, focused as i64],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn pending(conn: &Connection, id: i64) -> PendingFrame {
        conn.query_row(
            &OCR_NEXT_SQL.replace("WHERE ocr_status = 0", "WHERE id = ?1"),
            [id],
            pending_frame,
        )
        .unwrap()
    }

    #[test]
    fn an_identical_still_copies_the_text_of_its_own_display_only() {
        let (paths, conn) = ocr_lib();
        let a = ocr_frame(&conn, 1, true, 1_000, "same", 1);
        ocr_frame(&conn, 4, false, 1_500, "other", 1);
        let f = ocr_frame(&conn, 1, true, 3_000, "same", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, f)).unwrap(),
            OcrPlan::Copy(a)
        );
        let g = ocr_frame(&conn, 4, true, 3_100, "same", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, g)).unwrap(),
            OcrPlan::Read,
            "another display's still is not this one's"
        );
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn a_display_without_focus_reads_its_text_at_most_every_ten_seconds() {
        let (paths, conn) = ocr_lib();
        let read = ocr_frame(&conn, 4, false, 10_000, "v1", 1);
        let soon = ocr_frame(&conn, 4, false, 14_000, "v2", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, soon)).unwrap(),
            OcrPlan::Copy(read)
        );
        let later = ocr_frame(&conn, 4, false, 10_000 + NON_ACTIVE_OCR_EVERY_MS, "v3", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, later)).unwrap(),
            OcrPlan::Read
        );
        // The active display is read every frame.
        let active = ocr_frame(&conn, 4, true, 15_000, "v4", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, active)).unwrap(),
            OcrPlan::Read
        );
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn a_churning_active_display_is_read_at_most_every_four_seconds() {
        let (paths, conn) = ocr_lib();
        // The last read found most of the display changed (scrolling, a playing video).
        let read = ocr_frame(&conn, 1, true, 10_000, "c1", 1);
        conn.execute("UPDATE frame SET ocr_changed = 0.82 WHERE id = ?1", [read])
            .unwrap();
        let next = ocr_frame(&conn, 1, true, 12_000, "c2", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, next)).unwrap(),
            OcrPlan::Copy(read)
        );
        let later = ocr_frame(&conn, 1, true, 10_000 + CHURN_OCR_EVERY_MS, "c3", 0);
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, later)).unwrap(),
            OcrPlan::Read
        );
        // A small change (typing) is read every frame.
        conn.execute("UPDATE frame SET ocr_changed = 0.05 WHERE id = ?1", [read])
            .unwrap();
        assert_eq!(
            ocr_plan(&conn, &pending(&conn, next)).unwrap(),
            OcrPlan::Read
        );
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    /// The engine keeps one incremental-OCR cache per display: frames of two
    /// displays interleave and each still diffs against its own display.
    #[cfg(target_os = "macos")]
    #[test]
    fn incremental_ocr_diffs_each_display_against_itself() {
        let Ok(mut engine) = Engine::new() else {
            eprintln!("skipped: no capture engine in this build");
            return;
        };
        let dir = std::env::temp_dir().join(format!("kmem-ocrc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        image::RgbImage::from_pixel(640, 400, image::Rgb([250, 250, 250]))
            .save(&a)
            .unwrap();
        image::RgbImage::from_pixel(800, 300, image::Rgb([30, 30, 30]))
            .save(&b)
            .unwrap();
        let mut ocr = |path: &Path, key: i64| {
            engine
                .request(json!({"cmd": "ocr", "path": path.to_string_lossy(), "incremental": true, "cache_key": key.to_string()}), Duration::from_secs(30))
                .unwrap()["mode"]
                .as_str()
                .unwrap()
                .to_string()
        };
        ocr(&a, 1);
        ocr(&b, 4);
        assert_eq!(ocr(&a, 1), "unchanged");
        assert_eq!(ocr(&b, 4), "unchanged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_frame_row_keeps_its_display() {
        let dir = std::env::temp_dir().join(format!("kmem-disp-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let conn = store::open(&paths).unwrap();
        let mut engine = Engine::without_process_for_test();
        let mut segments: HashMap<i64, Option<SegmentState>> = HashMap::new();
        for f in display_frames(&two_display_capture(false, true)) {
            let id = display_id_of(&f);
            insert_frame(
                &conn,
                &paths,
                &mut engine,
                &f,
                5_000,
                "fixed_interval",
                segments.entry(id).or_default(),
                None,
            )
            .unwrap();
        }
        let rows: Vec<(i64, String, i64, i64, i64)> = conn
            .prepare("SELECT display_id, display_name, display_main, display_focused, is_inactive FROM frame ORDER BY display_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap()
            .collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(
            rows,
            [
                (1, "Built-in Retina Display".into(), 1, 1, 1),
                (2, "LG ULTRAWIDE".into(), 0, 0, 1)
            ]
        );
        let segs: i64 = conn
            .query_row("SELECT count(*) FROM segment", [], |r| r.get(0))
            .unwrap();
        assert_eq!(segs, 2, "each display has its own segment");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
