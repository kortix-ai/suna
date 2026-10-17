//! Cloud sync in the Kortix Capture format, schema 2 (`.agents/skills/kortix-capture/references/capture-format.md`):
//! the library's finished items go to an S3-compatible bucket (AWS S3,
//! Cloudflare R2, MinIO, versitygw, ...), and the bucket alone can rebuild the
//! library (`kortix-capture sync restore`). The format is the app's only
//! contract with any cloud.
//!
//! Three kinds of items, under `<prefix>/<device_id>/<YYYY>/<MM>/<DD>/`:
//!
//! - `chunk` (`<start_ms>-<video_id>`): the frames sidecar
//!   (`.frames.jsonl.zst`: every frame's time, app, window, URL, display,
//!   window list, OCR text and boxes, AX tree), the video (`.mp4`) and the
//!   manifest. Icons the frames use go to `assets/` first.
//! - `audio` (`<start_ms>-a<audio_id>`): the `.m4a` and the manifest (with the
//!   transcript lines).
//! - `actions` (`<start_ms>-x<segment_id>`): the action recorder's processed
//!   events (`.actions.jsonl.zst`) and the manifest. Screenshots go to
//!   `assets/` first, once per content.
//!
//! The manifest is written last: a manifest means the item is complete. Every
//! PUT signs `x-amz-checksum-sha256`; every object is read back by HEAD for its
//! size. Files above `sync.part_mb` upload as multipart with part progress in
//! SQLite, so a crash resumes. Then a line goes into the daily index
//! (`index/<YYYY-MM-DD>.jsonl`). After a verified upload the local media is
//! deleted (`sync.keep_local_hours`) and the row becomes `STATUS_REMOTE`;
//! playback downloads it into `cache/` (capped at `sync.cache_mb`).
//!
//! Next to the items: `device.json` (on start and on change), `status.json`
//! (every 60 s), and the operator's `policy.json`, read every 60 s
//! (`policy.rs`).
//!
//! Credentials (`sync.provider`): `s3`, static keys the person set up, or
//! `kortix`, short-lived keys from a credential issuer (`issuer.rs`). Either
//! way the engine talks plain S3 through [`S3Target`].
//!
//! Failures: auth, config and clock-skew errors stop the pass and retry the
//! whole target with backoff; transient errors back off per item (jittered,
//! 5 s doubling to 10 min). Local deletions and `sync.remote_retention_days`
//! queue remote deletes in `sync_tombstone`, swept every pass. State for the
//! CLI and tray is in `<library>/sync.json`.
//!
//! One uploader per library: a pass runs only while it holds the advisory lock
//! `<library>/sync.lock` (see [`lock_passes`]). The recorder's sync thread skips
//! a tick while another process holds it; `sync now` waits for the recorder's
//! pass to finish, then runs its own.

pub mod crypt;
pub mod issuer;
pub mod restore;
pub mod s3;
pub mod target;
pub mod view;

pub use s3::S3Target;
pub use target::{classify, ErrorClass, TargetError, UploadTarget};

use super::{
    paths::MemoryPaths,
    retention::{STATUS_DELETED, STATUS_REMOTE},
    settings::{Settings, SyncSettings},
    store::{self, now_ms},
    timerange::TimeRange,
};
use anyhow::{bail, Context, Result};
use chrono::{TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const TICK: Duration = Duration::from_secs(5);
const BACKOFF_MIN_MS: i64 = 5_000;
const BACKOFF_MAX_MS: i64 = 600_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;
const BATCH: i64 = 24;
const ANNOUNCE_EVERY_MS: i64 = MS_PER_HOUR;
/// Version of the format: manifests, index lines, device.json, status.json, policy.json.
pub const SCHEMA: i64 = 2;
const ENV_KEY: &str = "KORTIX_CAPTURE_S3_ACCESS_KEY_ID";
const ENV_SECRET: &str = "KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY";
const ENV_TOKEN: &str = "KORTIX_CAPTURE_S3_SESSION_TOKEN";
const SUFFIXES: [&str; 3] = [".mp4", ".frames.jsonl.zst", ".manifest.json"];
const AUDIO_SUFFIXES: [&str; 2] = [".m4a", ".manifest.json"];
const ACTION_SUFFIXES: [&str; 2] = [".actions.jsonl.zst", ".manifest.json"];
/// device.json is rewritten at most this often after an upload, and the policy read this often.
const DEVICE_EVERY_MS: i64 = 60_000;
/// status.json goes out this often: readers show how far behind each display is.
const STATUS_EVERY_MS: i64 = 15_000;
/// After a policy change, status.json goes out this long after the change.
const POLICY_STATUS_DELAY_MS: i64 = 15_000;
/// The sync loop ticks every few seconds. A longer gap between two ticks means the
/// computer slept (or the process was frozen); status.json then restarts `host.awakeSinceMs`.
const SLEEP_GAP_MS: i64 = 120_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

pub fn credentials_path(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("sync-credentials.json")
}

/// The environment wins over the credentials file.
pub fn load_credentials(paths: &MemoryPaths) -> Option<SyncCredentials> {
    if let (Ok(key), Ok(secret)) = (std::env::var(ENV_KEY), std::env::var(ENV_SECRET)) {
        return Some(SyncCredentials {
            access_key_id: key,
            secret_access_key: secret,
            session_token: std::env::var(ENV_TOKEN).ok(),
        });
    }
    let bytes = std::fs::read(credentials_path(paths)).ok()?;
    serde_json::from_slice::<SyncCredentials>(&bytes)
        .ok()
        .filter(|c| !c.access_key_id.is_empty() && !c.secret_access_key.is_empty())
}

/// Write via a temp file and rename; mode 0600 on Unix (Windows: the per-user
/// app-data ACL applies).
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(&tmp)?.write_all(bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn save_credentials(paths: &MemoryPaths, creds: &SyncCredentials) -> Result<()> {
    paths.ensure()?;
    write_private(&credentials_path(paths), &serde_json::to_vec_pretty(creds)?)
}

/// An error that stops the sync pass (bad settings, missing key or credentials).
pub fn config_error(msg: impl Into<String>) -> anyhow::Error {
    TargetError::new(ErrorClass::Config, 0, "Config", msg, "sync")
}

/// The S3 provider for these settings and credentials.
pub fn target_for(s: &SyncSettings, c: &SyncCredentials) -> Result<S3Target> {
    let o = &s.s3;
    Ok(S3Target::new(
        &o.endpoint,
        &o.bucket,
        &o.region,
        &o.prefix,
        o.path_style,
        &c.access_key_id,
        &c.secret_access_key,
        c.session_token.as_deref(),
    )
    .map_err(|e| config_error(format!("{e:#}")))?
    .with_bandwidth(s.max_upload_kbps.saturating_mul(1024))
    .with_part_size(s.part_mb.saturating_mul(1024 * 1024)))
}

/// The upload target `sync.provider` names.
pub fn target(paths: &MemoryPaths, s: &Settings) -> Result<Box<dyn UploadTarget>> {
    build_target(paths, s, 0)
}

/// `clock_offset_ms`: the server clock offset a previous pass learned.
fn build_target(
    paths: &MemoryPaths,
    s: &Settings,
    clock_offset_ms: i64,
) -> Result<Box<dyn UploadTarget>> {
    let t = match s.sync.provider.as_str() {
        "s3" | "" => {
            let creds = load_credentials(paths)
                .ok_or_else(|| config_error(format!("no S3 credentials: set {ENV_KEY}/{ENV_SECRET} or run kortix-capture sync setup")))?;
            target_for(&s.sync, &creds)?
        }
        "kortix" => {
            if s.sync.encrypt {
                return Err(config_error("sync.encrypt is not supported with the kortix provider: Kortix reads the bucket to index it for your organization"));
            }
            let c = issuer::credentials(paths)?;
            S3Target::new(
                &c.endpoint,
                &c.bucket,
                &c.region,
                &c.prefix,
                c.path_style,
                &c.access_key_id,
                &c.secret_access_key,
                c.session_token.as_deref(),
            )
            .map_err(|e| config_error(format!("issued credentials: {e:#}")))?
            .with_bandwidth(s.sync.max_upload_kbps.saturating_mul(1024))
            .with_part_size(s.sync.part_mb.saturating_mul(1024 * 1024))
        }
        other => {
            return Err(config_error(format!(
                "unknown sync provider {other:?} (use \"s3\" or \"kortix\")"
            )))
        }
    };
    Ok(Box::new(t.with_clock_offset(clock_offset_ms)))
}

/// The key prefix this device writes under: `sync.s3.prefix`, or the prefix
/// the issuer assigned at sign-in.
pub fn prefix(paths: &MemoryPaths, s: &Settings) -> String {
    match s.sync.provider.as_str() {
        "kortix" => issuer::registration(paths)
            .map(|r| r.prefix)
            .unwrap_or_default(),
        _ => s.sync.s3.prefix.trim_matches('/').to_string(),
    }
}

/// This device's id under the configured target: the one the issuer assigned
/// (`kortix`), else derived from the machine key and the prefix.
pub fn device_id(paths: &MemoryPaths, s: &Settings) -> String {
    if s.sync.provider == "kortix" {
        if let Some(r) = issuer::registration(paths) {
            return r.device_id;
        }
    }
    device_id_for(paths, &prefix(paths, s))
}

/// The stable id of this machine under `prefix`: 32 hex characters of
/// SHA-256(domain, machine key, prefix). One machine keeps one id under one
/// prefix, and the id reveals neither the machine key nor the OS id.
pub fn device_id_for(paths: &MemoryPaths, prefix: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"kortix-capture/device/v2\n");
    h.update(machine_key(paths).as_bytes());
    h.update(b"\n");
    h.update(prefix.trim_matches('/').as_bytes());
    target::hex(&h.finalize())[..32].to_string()
}

/// `machine::machine_key`, or a random key kept in `<library>/machine-key` on a
/// machine without an OS machine id (some Linux containers).
pub fn machine_key(paths: &MemoryPaths) -> String {
    if let Some(k) = crate::machine::machine_key() {
        return k;
    }
    let file = paths.root.join("machine-key");
    if let Some(k) = std::fs::read_to_string(&file)
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| k.len() == 64)
    {
        return k;
    }
    let k = sha256_hex(uuid::Uuid::new_v4().as_bytes());
    let _ = write_private(&file, k.as_bytes());
    k
}

/// The app version items and device.json carry: the release tag, else the crate version.
pub fn app_version() -> &'static str {
    match option_env!("KORTIX_RELEASE_TAG") {
        Some(t) if !t.trim().is_empty() => t,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// The User-Agent of every HTTP request the app makes. Cloudflare, in front of
/// Kortix, refuses a request without one (403), so no client may leave it out.
pub fn user_agent() -> String {
    format!(
        "kortix-capture/{} ({}; {})",
        app_version().trim_start_matches('v'),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// What device.json and the issuer's sign-in learn about this computer.
#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub machine_key_sha256: String,
    pub hostname: String,
    pub computer_name: String,
    pub os: &'static str,
    pub os_version: String,
    pub arch: &'static str,
    pub app_version: &'static str,
}

/// `machine_key_sha256` is the machine key hashed once more, so the key that
/// derives device ids never leaves the machine either.
pub fn identity(paths: &MemoryPaths) -> Identity {
    Identity {
        machine_key_sha256: sha256_hex(machine_key(paths).as_bytes()),
        hostname: crate::machine::hostname(),
        computer_name: crate::machine::computer_name(),
        os: match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            _ => "linux",
        },
        os_version: os_version(),
        arch: std::env::consts::ARCH,
        app_version: app_version(),
    }
}

fn os_version() -> String {
    let cmd: Option<(&str, &[&str])> = if cfg!(target_os = "macos") {
        Some(("sw_vers", &["-productVersion"]))
    } else if cfg!(target_os = "windows") {
        Some(("cmd", &["/C", "ver"]))
    } else {
        None
    };
    if let Some((prog, args)) = cmd {
        let mut c = std::process::Command::new(prog);
        c.args(args);
        crate::os_proc::no_window(&mut c);
        if let Ok(out) = c.output() {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
        return String::new();
    }
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                l.strip_prefix("PRETTY_NAME=")
                    .map(|v| v.trim_matches('"').to_string())
            })
        })
        .unwrap_or_default()
}

/// The encryption key when `sync.encrypt` is on; generated and stored on first use.
pub fn ensure_key(paths: &MemoryPaths, s: &Settings) -> Result<Option<crypt::Key>> {
    if !s.sync.encrypt {
        return Ok(None);
    }
    if !s.sync.key_id.is_empty() {
        return crypt::load(paths, &s.sync.key_id).map(Some).ok_or_else(|| {
            config_error(format!(
                "sync encryption key {} is not on this machine; import it with `kortix-capture sync key import`",
                s.sync.key_id
            ))
        });
    }
    let key = crypt::Key::generate();
    let place = crypt::store(paths, &key)?;
    let mut fresh = Settings::load(paths);
    fresh.sync.key_id = key.id();
    fresh.save(paths)?;
    tracing::info!(key_id = %key.id(), store = place, "sync: generated an encryption key; back it up with `kortix-capture sync key export`");
    Ok(Some(key))
}

/// Plaintext of a downloaded object: decrypted when it carries the `KCE1` header.
pub fn open_blob(paths: &MemoryPaths, bytes: Vec<u8>) -> Result<Vec<u8>> {
    let Some(id) = crypt::key_id_of(&bytes) else {
        return Ok(bytes);
    };
    let key = crypt::load(paths, &id).ok_or_else(|| {
        config_error(format!(
            "object is encrypted with key {id}; import it with `kortix-capture sync key import`"
        ))
    })?;
    crypt::decrypt_bytes(&key, &bytes)
}

/// Full jitter on top of half the exponential step: 5 s doubling to 10 min.
pub fn backoff_ms(attempts: i64) -> i64 {
    let step = (BACKOFF_MIN_MS << attempts.clamp(0, 16)).min(BACKOFF_MAX_MS);
    let r = (uuid::Uuid::new_v4().as_u128() % 1_000_000) as i64;
    step / 2 + step / 2 * r / 1_000_000
}

/// `<device>/<YYYY>/<MM>/<DD>/<start_ms>-<video_id>` (UTC date of the chunk start).
pub fn chunk_rel(device: &str, start_ms: i64, video_id: i64) -> String {
    format!(
        "{device}/{}/{start_ms}-{video_id}",
        utc_day(start_ms, "%Y/%m/%d")
    )
}

fn utc_day(ms: i64, fmt: &str) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
        .format(fmt)
        .to_string()
}

/// `<device>/<YYYY>/<MM>/<DD>/<start_ms>-a<audio_id>` (UTC date of the segment start).
pub fn audio_rel(device: &str, start_ms: i64, audio_id: i64) -> String {
    format!(
        "{device}/{}/{start_ms}-a{audio_id}",
        utc_day(start_ms, "%Y/%m/%d")
    )
}

pub fn index_rel(device: &str, day: &str) -> String {
    format!("{device}/index/{day}.jsonl")
}

/// The part of a full key from `<device>/` on, when the key is this device's.
fn device_rel<'k>(device: &str, key: &'k str) -> Option<&'k str> {
    let at = format!("{device}/");
    if key.starts_with(&at) {
        return Some(key);
    }
    key.find(&format!("/{at}")).map(|i| &key[i + 1..])
}

fn sha256_hex(bytes: &[u8]) -> String {
    target::hex(&Sha256::digest(bytes))
}

/// `sha256-<hex>.<ext>` of an icon file, the name it has in the bucket.
fn asset_name(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    Some(super::actions::asset_name(&bytes, &ext))
}

/// `<device>/<YYYY>/<MM>/<DD>/<start_ms>-x<segment_id>` (UTC date of the segment start).
pub fn actions_rel(device: &str, start_ms: i64, segment_id: i64) -> String {
    format!(
        "{device}/{}/{start_ms}-x{segment_id}",
        utc_day(start_ms, "%Y/%m/%d")
    )
}

/// The manifest's `privacy` object: whether local PII masking applied, and how.
fn privacy_json(redacted: bool, s: &Settings) -> Value {
    json!({
        "redact_pii": redacted,
        "mode": if !redacted { "off" } else if s.privacy.use_local_model { "model" } else { "patterns" },
    })
}

/// A frame line's `display`: its bounds, and since multi-display its id, name,
/// whether it is the main display and whether it held the focused window.
fn frame_display(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut d = json!({"x": r.get::<_, Option<f64>>(8)?, "y": r.get::<_, Option<f64>>(9)?,
                       "w": r.get::<_, Option<f64>>(10)?, "h": r.get::<_, Option<f64>>(11)?});
    if let Some(id) = r.get::<_, Option<i64>>(26)? {
        d["id"] = json!(id);
        d["name"] = json!(r.get::<_, Option<String>>(27)?);
        d["main"] = json!(r.get::<_, Option<i64>>(28)?.map(|v| v != 0));
        d["focused"] = json!(r.get::<_, Option<i64>>(29)?.map(|v| v != 0));
    }
    Ok(d)
}

/// The display a chunk recorded (`{id,name,x,y,w,h,scale,main}`); None for a
/// chunk from before multi-display.
pub fn video_display(conn: &Connection, video_id: i64) -> Option<Value> {
    conn.query_row("SELECT display FROM video WHERE id = ?1", [video_id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str(&s).ok())
}

/// device.json `displays`: the layout the recorder saw last.
pub fn device_displays(paths: &MemoryPaths) -> Value {
    let displays = crate::memory::recorder::RecorderStatus::read(paths)
        .map(|s| s.displays)
        .unwrap_or_default();
    Value::Array(
        displays
            .iter()
            .map(|d| json!({"id": d.id, "name": d.name, "x": d.x, "y": d.y, "w": d.w, "h": d.h, "scale": d.scale, "main": d.main}))
            .collect(),
    )
}

/// One JSON object per frame of the chunk, in video order, plus the icon
/// assets (`(<sha256>.<ext>, file)`) the frames reference.
pub fn frames_jsonl(
    conn: &Connection,
    paths: &MemoryPaths,
    video_id: i64,
) -> Result<(Vec<u8>, Vec<(String, PathBuf)>)> {
    let mut frames = conn.prepare(
        "SELECT f.id, f.timestamp, f.video_index, f.width, f.height, f.title, f.foreground, f.background,
                f.capture_display_x, f.capture_display_y, f.capture_display_width, f.capture_display_height,
                f.capture_reason, f.dhash, f.is_inactive, s.url, a.bundle_id, a.display_name, d.normalized_domain,
                a.version, a.is_user_app, a.icon_path, d.icon_path, f.image_hash, f.segment, f.pii_redacted,
                f.display_id, f.display_name, f.display_main, f.display_focused
         FROM frame f
         LEFT JOIN segment s ON s.id = f.segment
         LEFT JOIN application a ON a.id = s.application
         LEFT JOIN domain d ON d.id = s.domain
         WHERE f.video = ?1 ORDER BY f.video_index",
    )?;
    let mut windows = conn.prepare(
        "SELECT a.bundle_id, w.window_title, w.x, w.y, w.width, w.height, w.z_order, w.is_focussed_window, w.url,
                w.window_layer, a.display_name
         FROM window_bound w LEFT JOIN application a ON a.id = w.application WHERE w.frame = ?1 ORDER BY w.z_order",
    )?;
    let mut boxes = conn.prepare("SELECT x, y, width, height, text_offset, text_length FROM ocr WHERE frame = ?1 ORDER BY id")?;
    let mut ax = conn.prepare(
        "SELECT b.payload, s.is_partial_tree, s.node_count FROM ax_snapshot s JOIN ax_blob b ON b.hash = s.hash WHERE s.frame_id = ?1",
    )?;
    let mut icons: HashMap<String, Option<String>> = HashMap::new();
    let mut assets: Vec<(String, PathBuf)> = Vec::new();
    let mut icon = |stored: Option<String>| -> Option<String> {
        let stored = stored?;
        icons
            .entry(stored.clone())
            .or_insert_with(|| {
                let file = paths.abs(&stored);
                let name = asset_name(&file)?;
                assets.push((name.clone(), file));
                Some(name)
            })
            .clone()
    };
    let rows: Vec<(i64, Value, Option<String>, Option<String>, Option<String>, Option<String>)> = frames
        .query_map([video_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                json!({
                    "frame_index": r.get::<_, Option<i64>>(2)?,
                    "ts_ms": r.get::<_, i64>(1)?,
                    "width": r.get::<_, Option<i64>>(3)?,
                    "height": r.get::<_, Option<i64>>(4)?,
                    "title": r.get::<_, Option<String>>(5)?,
                    "url": r.get::<_, Option<String>>(15)?,
                    "domain": r.get::<_, Option<String>>(18)?,
                    "app": {"bundle_id": r.get::<_, Option<String>>(16)?, "name": r.get::<_, Option<String>>(17)?,
                            "version": r.get::<_, Option<String>>(19)?, "is_user_app": r.get::<_, Option<i64>>(20)?.map(|v| v != 0)},
                    "display": frame_display(r)?,
                    "capture_reason": r.get::<_, Option<String>>(12)?,
                    "dhash": r.get::<_, Option<String>>(13)?,
                    "image_hash": r.get::<_, Option<String>>(23)?,
                    // Segments span chunks; restore joins frames that share this id.
                    "segment": r.get::<_, Option<i64>>(24)?,
                    "inactive": r.get::<_, i64>(14)? != 0,
                    "pii_redacted": r.get::<_, i64>(25)? != 0,
                }),
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(21)?,
                r.get::<_, Option<String>>(22)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for (id, mut frame, fg, bg, app_icon, domain_icon) in rows {
        frame["app"]["icon"] = json!(icon(app_icon));
        frame["domain_icon"] = json!(icon(domain_icon));
        let text: Vec<char> = fg
            .as_deref()
            .unwrap_or("")
            .chars()
            .chain(bg.as_deref().unwrap_or("").chars())
            .collect();
        let lines: Vec<Value> = boxes
            .query_map([id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })?
            .filter_map(|b| b.ok())
            .map(|(x, y, w, h, off, len)| {
                let t: String = text
                    .iter()
                    .skip(off.max(0) as usize)
                    .take(len.max(0) as usize)
                    .collect();
                json!({"text": t, "x": x, "y": y, "w": w, "h": h, "off": off, "len": len})
            })
            .collect();
        frame["ocr"] = json!({"foreground": fg, "background": bg, "lines": lines});
        frame["windows"] = Value::Array(
            windows
                .query_map([id], |r| {
                    Ok(json!({"app": r.get::<_, Option<String>>(0)?, "app_name": r.get::<_, Option<String>>(10)?,
                              "title": r.get::<_, Option<String>>(1)?,
                              "x": r.get::<_, i64>(2)?, "y": r.get::<_, i64>(3)?, "w": r.get::<_, i64>(4)?, "h": r.get::<_, i64>(5)?,
                              "z": r.get::<_, i64>(6)?, "layer": r.get::<_, i64>(9)?, "focused": r.get::<_, Option<i64>>(7)? == Some(1),
                              "url": r.get::<_, Option<String>>(8)?}))
                })?
                .filter_map(|w| w.ok())
                .collect(),
        );
        if frame["pii_redacted"].as_bool() == Some(true) {
            // Applications are shared immutable cache rows. A name recorded
            // before privacy was enabled can still be joined to a new private
            // frame. Never export that older, unfiltered display name.
            frame["app"]["name"] = json!("[redacted]");
            for window in frame["windows"].as_array_mut().into_iter().flatten() {
                window["app_name"] = json!("[redacted]");
            }
        }
        if let Some((payload, partial, nodes)) = ax
            .query_row([id], |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .optional()?
        {
            if let Ok(tree) = zstd::decode_all(payload.as_slice())
                .map_err(anyhow::Error::from)
                .and_then(|b| Ok(serde_json::from_slice::<Value>(&b)?))
            {
                frame["ax_tree"] = tree;
                frame["ax_partial"] = json!(partial != 0);
                frame["ax_nodes"] = json!(nodes);
            }
        }
        serde_json::to_writer(&mut out, &frame)?;
        out.push(b'\n');
    }
    Ok((out, assets))
}

/// What the bucket holds for one object (`key` is relative to the prefix).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ObjInfo {
    pub key: String,
    /// Bytes stored (ciphertext when encrypted).
    pub size: u64,
    /// Hex SHA-256 of the stored bytes; the upload's `x-amz-checksum-sha256`.
    pub sha256: String,
    pub plain_size: u64,
    pub plain_sha256: String,
}

/// Everything an upload needs besides the database.
pub struct Ctx<'a> {
    pub paths: &'a MemoryPaths,
    pub t: &'a dyn UploadTarget,
    pub device: &'a str,
    pub key: Option<&'a crypt::Key>,
    pub stop: &'a AtomicBool,
    /// Effective settings (privacy for the manifests).
    pub settings: &'a Settings,
}

impl Ctx<'_> {
    fn verify_size(&self, key: &str, want: u64) -> Result<()> {
        let got = self.t.head(key)?;
        if got != Some(want) {
            return Err(TargetError::new(
                ErrorClass::Integrity,
                0,
                "SizeMismatch",
                format!("size {got:?}, expected {want}"),
                format!("verify {key}"),
            ));
        }
        Ok(())
    }

    /// The bytes to store for `plain` (encrypted when a key is set) and their description.
    fn seal(&self, rel: &str, plain: &[u8]) -> Result<(Vec<u8>, [u8; 32], ObjInfo)> {
        let stored = match self.key {
            Some(k) => crypt::encrypt_bytes(k, plain)?,
            None => plain.to_vec(),
        };
        let digest: [u8; 32] = Sha256::digest(&stored).into();
        let info = ObjInfo {
            key: rel.into(),
            size: stored.len() as u64,
            sha256: target::hex(&digest),
            plain_size: plain.len() as u64,
            plain_sha256: sha256_hex(plain),
        };
        Ok((stored, digest, info))
    }

    fn put_sealed(
        &self,
        stored: &[u8],
        digest: &[u8; 32],
        info: &ObjInfo,
        content_type: &str,
    ) -> Result<()> {
        let key = self.t.key(&info.key);
        self.t.put_bytes(&key, stored, content_type, digest)?;
        self.verify_size(&key, info.size)
    }

    /// PUT a small object (encrypted when a key is set), checksummed and size-verified.
    pub fn put_blob(&self, rel: &str, plain: &[u8], content_type: &str) -> Result<ObjInfo> {
        let (stored, digest, info) = self.seal(rel, plain)?;
        self.put_sealed(&stored, &digest, &info, content_type)?;
        Ok(info)
    }

    /// Read an object written by [`Ctx::put_blob`]; None when it does not exist.
    pub fn get_blob(&self, rel: &str) -> Result<Option<Vec<u8>>> {
        self.t
            .get_bytes(&self.t.key(rel))?
            .map(|b| open_blob(self.paths, b))
            .transpose()
    }
}

fn tmp_dir(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("sync-tmp")
}

fn encrypted_tmp(paths: &MemoryPaths, video_id: i64) -> PathBuf {
    tmp_dir(paths).join(format!("{video_id}.mp4.kce"))
}

fn encrypted_audio_tmp(paths: &MemoryPaths, audio_id: i64) -> PathBuf {
    tmp_dir(paths).join(format!("a{audio_id}.m4a.kce"))
}

fn encrypted_actions_tmp(paths: &MemoryPaths, segment_id: i64) -> PathBuf {
    tmp_dir(paths).join(format!("x{segment_id}.actions.kce"))
}

/// Upload a file: one streamed PUT up to `t.part_size`, multipart above it.
/// Multipart progress lives in `sync_multipart`/`sync_part`, so a later call
/// for the same key and the same file bytes resumes after the last finished part.
/// `size` and `digest` describe `file` (see [`target::file_digest`]).
pub fn put_file_resumable(
    conn: &Connection,
    ctx: &Ctx,
    key: &str,
    file: &Path,
    size: u64,
    digest: &[u8; 32],
    content_type: &str,
) -> Result<()> {
    let t = ctx.t;
    let part_size = t.part_size();
    if size <= part_size {
        return t.put_file(key, file, size, digest, content_type);
    }
    let sha = target::hex(digest);
    let existing: Option<(String, String, i64, i64)> = conn
        .query_row(
            "SELECT upload_id, sha256, size, part_size FROM sync_multipart WHERE key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let upload_id = match existing {
        Some((id, s, z, p)) if s == sha && z as u64 == size && p as u64 == part_size => id,
        stale => {
            if let Some((old, ..)) = stale {
                // Different bytes or part size (e.g. re-encrypted after a lost temp file): start over.
                conn.execute("INSERT OR IGNORE INTO sync_tombstone(key, upload_id, reason, created_at) VALUES (?1, ?2, 'restart', ?3)", params![key, old, now_ms()])?;
                forget_multipart(conn, key)?;
            }
            let id = t.create_multipart(key, content_type)?;
            conn.execute(
                "INSERT INTO sync_multipart(key, upload_id, sha256, size, part_size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![key, id, sha, size as i64, part_size as i64, now_ms()],
            )?;
            id
        }
    };
    let mut done: HashMap<u16, (String, String)> = conn
        .prepare("SELECT part_number, etag, sha256 FROM sync_part WHERE key = ?1")?
        .query_map([key], |r| Ok((r.get::<_, u16>(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let parts = size.div_ceil(part_size) as u16;
    for n in 1..=parts {
        if done.contains_key(&n) {
            continue;
        }
        if ctx.stop.load(Ordering::SeqCst) {
            bail!("stopped during multipart upload of {key} (resumes at part {n})");
        }
        let offset = (n as u64 - 1) * part_size;
        let len = part_size.min(size - offset);
        let part_digest = target::sha256_range(file, offset, len)?;
        match t.upload_part(key, &upload_id, n, file, offset, len, &part_digest) {
            Ok(etag) => {
                let checksum = target::sha256_b64(&part_digest);
                conn.execute("INSERT OR REPLACE INTO sync_part(key, part_number, etag, sha256) VALUES (?1, ?2, ?3, ?4)", params![key, n, etag, checksum])?;
                done.insert(n, (etag, checksum));
            }
            Err(e) if target::is_not_found(&e) => {
                // The server dropped the upload (lifecycle rule, manual abort): the next attempt starts over.
                forget_multipart(conn, key)?;
                return Err(e.context("multipart upload is gone; restarting it"));
            }
            Err(e) => return Err(e),
        }
    }
    let list: Vec<target::CompletedPart> = (1..=parts)
        .map(|n| target::CompletedPart {
            number: n,
            etag: done[&n].0.clone(),
            sha256_b64: done[&n].1.clone(),
        })
        .collect();
    if let Err(e) = t.complete_multipart(key, &upload_id, &list) {
        // A crash after Complete but before the bookkeeping: the object is already whole.
        if !(target::is_not_found(&e) && t.head(key)? == Some(size)) {
            if target::is_not_found(&e) {
                forget_multipart(conn, key)?;
            }
            return Err(e);
        }
    }
    forget_multipart(conn, key)?;
    Ok(())
}

fn forget_multipart(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM sync_part WHERE key = ?1", [key])?;
    conn.execute("DELETE FROM sync_multipart WHERE key = ?1", [key])?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Pending {
    pub id: i64,
    pub path: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub width: i64,
    pub height: i64,
    pub attempts: i64,
}

pub struct ChunkUpload {
    pub base: String,
    pub video: ObjInfo,
    pub frames: i64,
    pub bytes: u64,
}

/// Upload a content-addressed asset once per bucket key (`sync_asset` holds
/// the full keys already written, so a new device id or prefix uploads again).
fn upload_asset(conn: &Connection, ctx: &Ctx, name: &str, file: &Path) -> Result<()> {
    let rel = format!("{}/assets/{name}", ctx.device);
    let key = ctx.t.key(&rel);
    if conn
        .query_row("SELECT 1 FROM sync_asset WHERE name = ?1", [&key], |_| {
            Ok(())
        })
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    let bytes = std::fs::read(file).with_context(|| format!("read asset {}", file.display()))?;
    let ct = mime_guess::from_path(file)
        .first_or_octet_stream()
        .to_string();
    ctx.put_blob(&rel, &bytes, &ct)?;
    conn.execute(
        "INSERT OR IGNORE INTO sync_asset(name, uploaded_at) VALUES (?1, ?2)",
        params![key, now_ms()],
    )?;
    Ok(())
}

/// Upload one chunk: assets, the sidecar, the video and the manifest last,
/// each verified. A manifest in the bucket means the chunk is complete.
pub fn upload_chunk(conn: &Connection, ctx: &Ctx, v: &Pending) -> Result<ChunkUpload> {
    let base_rel = chunk_rel(ctx.device, v.start_ms, v.id);
    let (jsonl, assets) = frames_jsonl(conn, ctx.paths, v.id)?;
    for (name, file) in &assets {
        if let Err(e) = upload_asset(conn, ctx, name, file) {
            if classify(&e) != ErrorClass::Local {
                return Err(e);
            }
            tracing::debug!("sync: icon {name} skipped: {e:#}");
        }
    }
    let frame_count = jsonl.iter().filter(|b| **b == b'\n').count() as i64;
    let (side_bytes, side_digest, frames_obj) = ctx.seal(
        &format!("{base_rel}.frames.jsonl.zst"),
        &zstd::encode_all(jsonl.as_slice(), 9)?,
    )?;

    let src = ctx.paths.videos_dir().join(&v.path);
    let (plain_size, plain_digest) =
        target::file_digest(&src).with_context(|| format!("read video {}", v.path))?;
    let upload_src = match ctx.key {
        Some(k) => {
            let tmp = encrypted_tmp(ctx.paths, v.id);
            if !tmp.exists() {
                crypt::encrypt_file(k, &src, &tmp)?;
            }
            tmp
        }
        None => src,
    };
    let (size, digest) = if ctx.key.is_some() {
        target::file_digest(&upload_src)?
    } else {
        (plain_size, plain_digest)
    };
    let video = ObjInfo {
        key: format!("{base_rel}.mp4"),
        size,
        sha256: target::hex(&digest),
        plain_size,
        plain_sha256: target::hex(&plain_digest),
    };
    let redacted: bool = conn
        .query_row(
            "SELECT COALESCE(max(pii_redacted), 0) FROM frame WHERE video = ?1",
            [v.id],
            |r| r.get::<_, i64>(0),
        )
        .map(|x| x != 0)
        .unwrap_or(false);
    let manifest = json!({
        "schema": SCHEMA,
        "kind": "chunk",
        "device_id": ctx.device,
        "video_id": v.id,
        "start_ms": v.start_ms,
        "end_ms": v.end_ms,
        "frame_count": frame_count,
        "width": v.width,
        "height": v.height,
        "video_name": v.path,
        "app_version": app_version(),
        "created_at_ms": now_ms(),
        "encryption": ctx.key.map(|k| json!({"alg": crypt::ALG, "key_id": k.id()})),
        "privacy": privacy_json(redacted, ctx.settings),
        "objects": {"video": video, "frames": frames_obj},
    });
    let mut manifest = manifest;
    if let Some(display) = video_display(conn, v.id) {
        manifest["display"] = display;
    }
    let manifest_plain = serde_json::to_vec_pretty(&manifest)?;
    let (man_bytes, man_digest, man_obj) =
        ctx.seal(&format!("{base_rel}.manifest.json"), &manifest_plain)?;

    ctx.put_sealed(
        &side_bytes,
        &side_digest,
        &frames_obj,
        "application/x-ndjson",
    )?;
    let video_key = ctx.t.key(&video.key);
    put_file_resumable(
        conn,
        ctx,
        &video_key,
        &upload_src,
        size,
        &digest,
        "video/mp4",
    )?;
    ctx.verify_size(&video_key, size)?;
    ctx.put_sealed(&man_bytes, &man_digest, &man_obj, "application/json")?;
    Ok(ChunkUpload {
        base: base_rel,
        video,
        frames: frame_count,
        bytes: size + frames_obj.size + man_obj.size,
    })
}

fn journal(conn: &Connection, day_ms: i64, line: &Value) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_journal(day, line) VALUES (?1, ?2)",
        params![utc_day(day_ms, "%Y-%m-%d"), line.to_string()],
    )?;
    Ok(())
}

fn record_success(
    conn: &Connection,
    device: &str,
    v: &Pending,
    up: &ChunkUpload,
    full_base: &str,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE video SET uploaded_at = ?1, remote_key = ?2, remote_sha256 = ?3, upload_error = NULL,
                          upload_error_class = NULL, next_upload_at = NULL WHERE id = ?4",
        params![now_ms(), full_base, up.video.sha256, v.id],
    )?;
    if changed == 0 {
        // Forgotten while it uploaded: the objects just written must go too.
        tombstone_chunk(conn, device, full_base, v.start_ms, "forgotten")?;
        return Ok(());
    }
    journal(
        conn,
        v.start_ms,
        &json!({"op": "put", "kind": "chunk", "base": up.base, "video_id": v.id, "start_ms": v.start_ms, "end_ms": v.end_ms,
                "frames": up.frames, "manifest": true, "at_ms": now_ms()}),
    )?;
    Ok(())
}

/// One audio segment waiting to upload.
#[derive(Debug, Clone)]
pub struct PendingAudio {
    pub id: i64,
    pub path: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub sources: String,
    pub pii_redacted: bool,
    pub attempts: i64,
}

/// The transcript lines of a segment, as they go into its manifest.
fn transcript_json(conn: &Connection, audio_id: i64) -> Result<Vec<Value>> {
    Ok(conn
        .prepare("SELECT start_ms, end_ms, text FROM audio_transcript WHERE audio = ?1 ORDER BY start_ms, id")?
        .query_map([audio_id], |r| {
            Ok(json!({"start_ms": r.get::<_, i64>(0)?, "end_ms": r.get::<_, i64>(1)?, "text": r.get::<_, String>(2)?}))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Upload one audio segment: the audio file (resumable, encrypted when a key
/// is set), then the manifest last.
pub fn upload_audio(conn: &Connection, ctx: &Ctx, a: &PendingAudio) -> Result<ChunkUpload> {
    let base_rel = audio_rel(ctx.device, a.start_ms, a.id);
    let src = ctx.paths.audio_dir().join(&a.path);
    let (plain_size, plain_digest) =
        target::file_digest(&src).with_context(|| format!("read audio {}", a.path))?;
    let upload_src = match ctx.key {
        Some(k) => {
            let tmp = encrypted_audio_tmp(ctx.paths, a.id);
            if !tmp.exists() {
                std::fs::create_dir_all(tmp_dir(ctx.paths))?;
                crypt::encrypt_file(k, &src, &tmp)?;
            }
            tmp
        }
        None => src,
    };
    let (size, digest) = if ctx.key.is_some() {
        target::file_digest(&upload_src)?
    } else {
        (plain_size, plain_digest)
    };
    let audio = ObjInfo {
        key: format!("{base_rel}.m4a"),
        size,
        sha256: target::hex(&digest),
        plain_size,
        plain_sha256: target::hex(&plain_digest),
    };
    let transcript = transcript_json(conn, a.id)?;
    let manifest = json!({
        "schema": SCHEMA,
        "kind": "audio",
        "device_id": ctx.device,
        "audio_id": a.id,
        "start_ms": a.start_ms,
        "end_ms": a.end_ms,
        "duration_ms": a.end_ms - a.start_ms,
        "sources": a.sources.split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>(),
        "content_type": "audio/mp4",
        "codec": "aac",
        "sample_rate": super::audio::RATE,
        "channels": 1,
        "audio_name": a.path,
        "pii_redacted": a.pii_redacted,
        "transcript": transcript,
        "app_version": app_version(),
        "created_at_ms": now_ms(),
        "encryption": ctx.key.map(|k| json!({"alg": crypt::ALG, "key_id": k.id()})),
        "privacy": privacy_json(a.pii_redacted, ctx.settings),
        "objects": {"audio": audio},
    });
    let manifest_plain = serde_json::to_vec_pretty(&manifest)?;
    let (man_bytes, man_digest, man_obj) =
        ctx.seal(&format!("{base_rel}.manifest.json"), &manifest_plain)?;
    let audio_key = ctx.t.key(&audio.key);
    put_file_resumable(
        conn,
        ctx,
        &audio_key,
        &upload_src,
        size,
        &digest,
        "audio/mp4",
    )?;
    ctx.verify_size(&audio_key, size)?;
    ctx.put_sealed(&man_bytes, &man_digest, &man_obj, "application/json")?;
    Ok(ChunkUpload {
        base: base_rel,
        video: audio,
        frames: transcript.len() as i64,
        bytes: size + man_obj.size,
    })
}

fn record_audio_success(
    conn: &Connection,
    device: &str,
    a: &PendingAudio,
    up: &ChunkUpload,
    full_base: &str,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE audio SET uploaded_at = ?1, remote_key = ?2, remote_sha256 = ?3, upload_error = NULL,
                          upload_error_class = NULL, next_upload_at = NULL WHERE id = ?4",
        params![now_ms(), full_base, up.video.sha256, a.id],
    )?;
    if changed == 0 {
        // Forgotten while it uploaded: the objects just written must go too.
        tombstone_audio(conn, device, full_base, a.start_ms, "forgotten")?;
        return Ok(());
    }
    journal(
        conn,
        a.start_ms,
        &json!({"op": "put", "kind": "audio", "base": up.base, "audio_id": a.id, "start_ms": a.start_ms,
                "end_ms": a.end_ms, "transcript_lines": up.frames, "manifest": true, "at_ms": now_ms()}),
    )?;
    Ok(())
}

/// Upload due audio segments (one at a time: each is about 240 KB). A segment
/// waits until its transcript is done so the manifest carries it. Err only for
/// an error that stops the pass.
pub fn upload_pending_audio(conn: &Connection, ctx: &Ctx, s: &SyncSettings) -> Result<UploadStats> {
    let now = now_ms();
    let cutoff = if s.remote_retention_days > 0 {
        now - s.remote_retention_days as i64 * MS_PER_DAY
    } else {
        0
    };
    let pending: Vec<PendingAudio> = conn
        .prepare(
            "SELECT id, path, start_ms, end_ms, sources, pii_redacted, upload_attempts FROM audio
             WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND transcript_status != ?4
               AND COALESCE(next_upload_at, 0) <= ?1 AND (?3 = 0 OR end_ms >= ?3)
             ORDER BY id LIMIT ?2",
        )?
        .query_map(
            params![now, BATCH, cutoff, super::audio::TRANSCRIPT_PENDING],
            |r| {
                Ok(PendingAudio {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    start_ms: r.get(2)?,
                    end_ms: r.get(3)?,
                    sources: r.get(4)?,
                    pii_redacted: r.get::<_, i64>(5)? != 0,
                    attempts: r.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    let mut stats = UploadStats::default();
    let t0 = Instant::now();
    for a in pending {
        if ctx.stop.load(Ordering::SeqCst) {
            break;
        }
        let res = upload_audio(conn, ctx, &a).and_then(|up| {
            let full = ctx.t.key(&up.base);
            record_audio_success(conn, ctx.device, &a, &up, &full)?;
            let _ = std::fs::remove_file(encrypted_audio_tmp(ctx.paths, a.id));
            Ok(up)
        });
        match res {
            Ok(up) => {
                stats.chunks += 1;
                stats.bytes += up.bytes;
            }
            Err(e) => {
                let class = classify(&e);
                if class.halts() {
                    return Err(e);
                }
                stats.failed += 1;
                let msg: String = format!("{e:#}").chars().take(500).collect();
                tracing::warn!(
                    audio = a.id,
                    attempts = a.attempts + 1,
                    class = class.as_str(),
                    "sync audio upload failed: {msg}"
                );
                conn.execute(
                    "UPDATE audio SET upload_attempts = ?1, upload_error = ?2, upload_error_class = ?3, next_upload_at = ?4 WHERE id = ?5",
                    params![a.attempts + 1, msg, class.as_str(), now_ms() + backoff_ms(a.attempts), a.id],
                )?;
            }
        }
    }
    stats.elapsed = t0.elapsed();
    Ok(stats)
}

/// One action segment waiting to upload.
#[derive(Debug, Clone)]
pub struct PendingActions {
    pub id: i64,
    pub path: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub event_count: i64,
    pub screenshots: Vec<String>,
    pub pii_redacted: bool,
    pub attempts: i64,
}

/// Upload one action segment: its screenshots (assets, once per content),
/// the actions file (resumable, encrypted when a key is set), the manifest last.
pub fn upload_actions(conn: &Connection, ctx: &Ctx, a: &PendingActions) -> Result<ChunkUpload> {
    let base_rel = actions_rel(ctx.device, a.start_ms, a.id);
    for name in &a.screenshots {
        upload_asset(
            conn,
            ctx,
            name,
            &super::actions::assets_dir(ctx.paths).join(name),
        )?;
    }
    let src = super::actions::dir(ctx.paths).join(&a.path);
    let (plain_size, plain_digest) =
        target::file_digest(&src).with_context(|| format!("read actions {}", a.path))?;
    let upload_src = match ctx.key {
        Some(k) => {
            let tmp = encrypted_actions_tmp(ctx.paths, a.id);
            if !tmp.exists() {
                std::fs::create_dir_all(tmp_dir(ctx.paths))?;
                crypt::encrypt_file(k, &src, &tmp)?;
            }
            tmp
        }
        None => src,
    };
    let (size, digest) = if ctx.key.is_some() {
        target::file_digest(&upload_src)?
    } else {
        (plain_size, plain_digest)
    };
    let actions = ObjInfo {
        key: format!("{base_rel}.actions.jsonl.zst"),
        size,
        sha256: target::hex(&digest),
        plain_size,
        plain_sha256: target::hex(&plain_digest),
    };
    let manifest = json!({
        "schema": SCHEMA,
        "kind": "actions",
        "device_id": ctx.device,
        "segment_id": a.id,
        "start_ms": a.start_ms,
        "end_ms": a.end_ms,
        "event_count": a.event_count,
        "screenshots": a.screenshots,
        "app_version": app_version(),
        "created_at_ms": now_ms(),
        "encryption": ctx.key.map(|k| json!({"alg": crypt::ALG, "key_id": k.id()})),
        "privacy": privacy_json(a.pii_redacted, ctx.settings),
        "objects": {"actions": actions},
    });
    let manifest_plain = serde_json::to_vec_pretty(&manifest)?;
    let (man_bytes, man_digest, man_obj) =
        ctx.seal(&format!("{base_rel}.manifest.json"), &manifest_plain)?;
    let actions_key = ctx.t.key(&actions.key);
    put_file_resumable(
        conn,
        ctx,
        &actions_key,
        &upload_src,
        size,
        &digest,
        "application/zstd",
    )?;
    ctx.verify_size(&actions_key, size)?;
    ctx.put_sealed(&man_bytes, &man_digest, &man_obj, "application/json")?;
    Ok(ChunkUpload {
        base: base_rel,
        video: actions,
        frames: a.event_count,
        bytes: size + man_obj.size,
    })
}

fn record_actions_success(
    conn: &Connection,
    device: &str,
    a: &PendingActions,
    up: &ChunkUpload,
    full_base: &str,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE action_segment SET uploaded_at = ?1, remote_key = ?2, remote_sha256 = ?3, upload_error = NULL,
                                   upload_error_class = NULL, next_upload_at = NULL WHERE id = ?4",
        params![now_ms(), full_base, up.video.sha256, a.id],
    )?;
    if changed == 0 {
        // Forgotten while it uploaded: the objects just written must go too.
        tombstone_actions(conn, device, full_base, a.start_ms, "forgotten")?;
        tombstone_unreferenced_assets(conn, &a.screenshots, "forgotten")?;
        return Ok(());
    }
    journal(
        conn,
        a.start_ms,
        &json!({"op": "put", "kind": "actions", "base": up.base, "segment_id": a.id, "start_ms": a.start_ms,
                "end_ms": a.end_ms, "events": a.event_count, "manifest": true, "at_ms": now_ms()}),
    )?;
    Ok(())
}

/// Upload due action segments, one at a time. Nothing goes while local PII
/// masking is on (`privacy.redact_pii`): action uploads pause, as they always
/// did; screen chunks and audio keep syncing. Err only for an error that
/// stops the pass.
pub fn upload_pending_actions(
    conn: &Connection,
    ctx: &Ctx,
    s: &SyncSettings,
) -> Result<UploadStats> {
    let mut stats = UploadStats::default();
    if ctx.settings.privacy.redact_pii {
        return Ok(stats);
    }
    let now = now_ms();
    let cutoff = if s.remote_retention_days > 0 {
        now - s.remote_retention_days as i64 * MS_PER_DAY
    } else {
        0
    };
    let pending: Vec<PendingActions> = conn
        .prepare(
            "SELECT id, path, start_ms, end_ms, event_count, screenshots, pii_redacted, upload_attempts FROM action_segment
             WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND COALESCE(next_upload_at, 0) <= ?1
               AND (?3 = 0 OR end_ms >= ?3)
             ORDER BY id LIMIT ?2",
        )?
        .query_map(params![now, BATCH, cutoff], |r| {
            Ok(PendingActions {
                id: r.get(0)?,
                path: r.get(1)?,
                start_ms: r.get(2)?,
                end_ms: r.get(3)?,
                event_count: r.get(4)?,
                screenshots: super::actions::screenshots_of(&r.get::<_, String>(5)?),
                pii_redacted: r.get::<_, i64>(6)? != 0,
                attempts: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let t0 = Instant::now();
    for a in pending {
        if ctx.stop.load(Ordering::SeqCst) {
            break;
        }
        let res = upload_actions(conn, ctx, &a).and_then(|up| {
            let full = ctx.t.key(&up.base);
            record_actions_success(conn, ctx.device, &a, &up, &full)?;
            let _ = std::fs::remove_file(encrypted_actions_tmp(ctx.paths, a.id));
            Ok(up)
        });
        match res {
            Ok(up) => {
                stats.chunks += 1;
                stats.bytes += up.bytes;
            }
            Err(e) => {
                let class = classify(&e);
                if class.halts() {
                    return Err(e);
                }
                stats.failed += 1;
                let msg: String = format!("{e:#}").chars().take(500).collect();
                tracing::warn!(
                    actions = a.id,
                    attempts = a.attempts + 1,
                    class = class.as_str(),
                    "sync actions upload failed: {msg}"
                );
                conn.execute(
                    "UPDATE action_segment SET upload_attempts = ?1, upload_error = ?2, upload_error_class = ?3, next_upload_at = ?4 WHERE id = ?5",
                    params![a.attempts + 1, msg, class.as_str(), now_ms() + backoff_ms(a.attempts), a.id],
                )?;
            }
        }
    }
    stats.elapsed = t0.elapsed();
    Ok(stats)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct UploadStats {
    pub chunks: usize,
    pub failed: usize,
    pub bytes: u64,
    pub elapsed: Duration,
}

/// Upload due chunks with `sync.concurrency` workers. Returns Err only for an
/// error that stops the pass (auth, config, clock skew); per-chunk failures
/// back off in the `video` row.
pub fn upload_pending(conn: &Connection, ctx: &Ctx, s: &SyncSettings) -> Result<UploadStats> {
    let now = now_ms();
    let cutoff = if s.remote_retention_days > 0 {
        now - s.remote_retention_days as i64 * MS_PER_DAY
    } else {
        0
    };
    let pending: Vec<Pending> = conn
        .prepare(
            "SELECT id, path, COALESCE(start_timestamp, 0), COALESCE(end_timestamp, start_timestamp, 0), width, height, upload_attempts
             FROM video
             WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND COALESCE(next_upload_at, 0) <= ?1
               AND (?3 = 0 OR COALESCE(end_timestamp, start_timestamp, 0) >= ?3)
             ORDER BY id LIMIT ?2",
        )?
        .query_map(params![now, BATCH, cutoff], |r| {
            Ok(Pending { id: r.get(0)?, path: r.get(1)?, start_ms: r.get(2)?, end_ms: r.get(3)?, width: r.get(4)?, height: r.get(5)?, attempts: r.get(6)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut stats = UploadStats::default();
    if pending.is_empty() {
        return Ok(stats);
    }
    let t0 = Instant::now();
    let workers = (s.concurrency.clamp(1, 8) as usize).min(pending.len());
    let queue = Mutex::new(pending.into_iter().collect::<VecDeque<_>>());
    let halt: Mutex<Option<anyhow::Error>> = Mutex::new(None);
    let tally = Mutex::new(stats);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let wconn = match store::open(ctx.paths) {
                    Ok(c) => c,
                    Err(e) => {
                        *halt.lock().unwrap() = Some(e);
                        return;
                    }
                };
                loop {
                    if ctx.stop.load(Ordering::SeqCst) || halt.lock().unwrap().is_some() {
                        break;
                    }
                    let Some(v) = queue.lock().unwrap().pop_front() else { break };
                    let res = upload_chunk(&wconn, ctx, &v).and_then(|up| {
                        let full = ctx.t.key(&up.base);
                        record_success(&wconn, ctx.device, &v, &up, &full)?;
                        let _ = std::fs::remove_file(encrypted_tmp(ctx.paths, v.id));
                        Ok(up)
                    });
                    match res {
                        Ok(up) => {
                            let mut t = tally.lock().unwrap();
                            t.chunks += 1;
                            t.bytes += up.bytes;
                        }
                        Err(e) => {
                            let class = classify(&e);
                            if class.halts() {
                                halt.lock().unwrap().get_or_insert(e);
                                break;
                            }
                            tally.lock().unwrap().failed += 1;
                            let attempts = v.attempts + 1;
                            let msg: String = format!("{e:#}").chars().take(500).collect();
                            tracing::warn!(video = v.id, attempts, class = class.as_str(), "sync upload failed: {msg}");
                            let _ = wconn.execute(
                                "UPDATE video SET upload_attempts = ?1, upload_error = ?2, upload_error_class = ?3, next_upload_at = ?4 WHERE id = ?5",
                                params![attempts, msg, class.as_str(), now_ms() + backoff_ms(v.attempts), v.id],
                            );
                        }
                    }
                }
            });
        }
    });
    if let Some(e) = halt.into_inner().unwrap() {
        return Err(e);
    }
    stats = tally.into_inner().unwrap();
    stats.elapsed = t0.elapsed();
    Ok(stats)
}

/// Merge pending journal lines into each day's index object (read, append, write).
/// One device writes its own index, so there is no concurrent writer.
pub fn flush_index(conn: &Connection, ctx: &Ctx) -> Result<usize> {
    let days: Vec<String> = conn
        .prepare("SELECT DISTINCT day FROM sync_journal ORDER BY day")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for day in &days {
        let rows: Vec<(i64, String)> = conn
            .prepare("SELECT id, line FROM sync_journal WHERE day = ?1 ORDER BY id")?
            .query_map([day], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let rel = index_rel(ctx.device, day);
        let mut text = ctx
            .get_blob(&rel)?
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let seen: HashSet<String> = text.lines().map(str::to_string).collect();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        for (_, line) in &rows {
            if !seen.contains(line) {
                text.push_str(line);
                text.push('\n');
            }
        }
        ctx.put_blob(&rel, text.as_bytes(), "application/x-ndjson")?;
        let max_id = rows.last().map(|r| r.0).unwrap_or(0);
        conn.execute(
            "DELETE FROM sync_journal WHERE day = ?1 AND id <= ?2",
            params![day, max_id],
        )?;
    }
    Ok(days.len())
}

/// Queue the remote objects of a chunk for deletion (and abort its multipart
/// upload if one is open). Adds a delete line to this device's index when
/// the chunk is this device's.
pub fn tombstone_chunk(
    conn: &Connection,
    device: &str,
    full_base: &str,
    start_ms: i64,
    reason: &str,
) -> Result<usize> {
    tombstone_objects(
        conn, device, full_base, start_ms, reason, "chunk", &SUFFIXES,
    )
}

/// [`tombstone_chunk`] for an audio segment (`.m4a` and its manifest).
pub fn tombstone_audio(
    conn: &Connection,
    device: &str,
    full_base: &str,
    start_ms: i64,
    reason: &str,
) -> Result<usize> {
    tombstone_objects(
        conn,
        device,
        full_base,
        start_ms,
        reason,
        "audio",
        &AUDIO_SUFFIXES,
    )
}

/// [`tombstone_chunk`] for an action segment. Its screenshots go separately
/// ([`tombstone_unreferenced_assets`]): other segments can share them.
pub fn tombstone_actions(
    conn: &Connection,
    device: &str,
    full_base: &str,
    start_ms: i64,
    reason: &str,
) -> Result<usize> {
    tombstone_objects(
        conn,
        device,
        full_base,
        start_ms,
        reason,
        "actions",
        &ACTION_SUFFIXES,
    )
}

/// `suffixes[0]` is the media object, the one a multipart upload can be open for.
fn tombstone_objects(
    conn: &Connection,
    device: &str,
    full_base: &str,
    start_ms: i64,
    reason: &str,
    kind: &str,
    suffixes: &[&str],
) -> Result<usize> {
    let now = now_ms();
    let mut n = 0;
    for suffix in suffixes {
        n += conn.execute(
            "INSERT OR IGNORE INTO sync_tombstone(key, upload_id, reason, created_at) VALUES (?1, '', ?2, ?3)",
            params![format!("{full_base}{suffix}"), reason, now],
        )?;
    }
    let media = format!("{full_base}{}", suffixes[0]);
    if let Some(upload_id) = conn
        .query_row(
            "SELECT upload_id FROM sync_multipart WHERE key = ?1",
            [&media],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        n += conn.execute(
            "INSERT OR IGNORE INTO sync_tombstone(key, upload_id, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![media, upload_id, reason, now],
        )?;
        forget_multipart(conn, &media)?;
    }
    if let Some(rel) = device_rel(device, full_base) {
        journal(
            conn,
            start_ms,
            &json!({"op": "delete", "kind": kind, "base": rel, "reason": reason, "at_ms": now}),
        )?;
    }
    Ok(n)
}

/// Queue the bucket copies of `candidates` (screenshots of action segments
/// just forgotten or past retention) that no action segment in the bucket or
/// waiting to upload still references. Forgetting a moment removes its
/// screenshots too; icons are never candidates.
pub fn tombstone_unreferenced_assets(
    conn: &Connection,
    candidates: &[String],
    reason: &str,
) -> Result<usize> {
    if candidates.is_empty() {
        return Ok(0);
    }
    let mut live = HashSet::new();
    for list in conn
        .prepare("SELECT screenshots FROM action_segment WHERE remote_key IS NOT NULL OR uploaded_at IS NULL")?
        .query_map([], |r| r.get::<_, String>(0))?
    {
        live.extend(super::actions::screenshots_of(&list?));
    }
    let mut n = 0;
    for name in candidates.iter().filter(|c| !live.contains(*c)) {
        let keys: Vec<String> = conn
            .prepare("SELECT name FROM sync_asset WHERE name LIKE ?1")?
            .query_map([format!("%/assets/{name}")], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for key in keys {
            n += conn.execute(
                "INSERT OR IGNORE INTO sync_tombstone(key, upload_id, reason, created_at) VALUES (?1, '', ?2, ?3)",
                params![key, reason, now_ms()],
            )?;
            conn.execute("DELETE FROM sync_asset WHERE name = ?1", [&key])?;
        }
    }
    Ok(n)
}

/// Delete (or abort) queued remote objects. Returns Err only for an error that stops the pass.
pub fn sweep_tombstones(conn: &Connection, t: &dyn UploadTarget) -> Result<usize> {
    let rows: Vec<(String, String, i64)> = conn
        .prepare("SELECT key, upload_id, attempts FROM sync_tombstone WHERE next_at <= ?1 ORDER BY created_at LIMIT 500")?
        .query_map([now_ms()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut done = 0;
    for (key, upload_id, attempts) in rows {
        let res = if upload_id.is_empty() {
            t.delete(&key)
        } else {
            t.abort_multipart(&key, &upload_id)
        };
        match res {
            Ok(()) => {
                conn.execute(
                    "DELETE FROM sync_tombstone WHERE key = ?1 AND upload_id = ?2",
                    params![key, upload_id],
                )?;
                done += 1;
            }
            Err(e) if classify(&e).halts() => return Err(e),
            Err(e) => {
                conn.execute(
                    "UPDATE sync_tombstone SET attempts = ?1, next_at = ?2, error = ?3 WHERE key = ?4 AND upload_id = ?5",
                    params![attempts + 1, now_ms() + backoff_ms(attempts), format!("{e:#}"), key, upload_id],
                )?;
            }
        }
    }
    Ok(done)
}

/// Cloud-side retention: queue chunks older than `remote_retention_days` for
/// deletion. Local text stays; a chunk with no local video becomes
/// `STATUS_DELETED` (screenshot removed, text searchable).
pub fn remote_retention(
    conn: &Connection,
    s: &SyncSettings,
    device: &str,
    now: i64,
) -> Result<usize> {
    if s.remote_retention_days == 0 {
        return Ok(0);
    }
    let cutoff = now - s.remote_retention_days as i64 * MS_PER_DAY;
    let rows: Vec<(i64, String, i64)> = conn
        .prepare(
            "SELECT id, remote_key, COALESCE(start_timestamp, 0) FROM video
             WHERE remote_key IS NOT NULL AND COALESCE(end_timestamp, start_timestamp, 0) < ?1 ORDER BY id LIMIT 1000",
        )?
        .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let audio: Vec<(i64, String, i64)> = conn
        .prepare(
            "SELECT id, remote_key, start_ms FROM audio
             WHERE remote_key IS NOT NULL AND end_ms < ?1 ORDER BY id LIMIT 1000",
        )?
        .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let actions: Vec<(i64, String, i64, String)> = conn
        .prepare(
            "SELECT id, remote_key, start_ms, screenshots FROM action_segment
             WHERE remote_key IS NOT NULL AND end_ms < ?1 ORDER BY id LIMIT 1000",
        )?
        .query_map([cutoff], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let tx = conn.unchecked_transaction()?;
    for (id, key, start) in &rows {
        tombstone_chunk(&tx, device, key, *start, "retention")?;
        tx.execute(
            "UPDATE video SET remote_key = NULL, remote_sha256 = NULL, status = CASE WHEN status = ?1 THEN ?2 ELSE status END WHERE id = ?3",
            params![STATUS_REMOTE, STATUS_DELETED, id],
        )?;
    }
    for (id, key, start) in &audio {
        tombstone_audio(&tx, device, key, *start, "retention")?;
        tx.execute(
            "UPDATE audio SET remote_key = NULL, remote_sha256 = NULL, status = CASE WHEN status = ?1 THEN ?2 ELSE status END WHERE id = ?3",
            params![STATUS_REMOTE, STATUS_DELETED, id],
        )?;
    }
    // An action segment without a local file has nothing left once its bucket copy goes.
    let mut shots = Vec::new();
    for (id, key, start, list) in &actions {
        tombstone_actions(&tx, device, key, *start, "retention")?;
        shots.extend(super::actions::screenshots_of(list));
        tx.execute(
            "DELETE FROM action_segment WHERE id = ?1 AND status = ?2",
            params![id, STATUS_REMOTE],
        )?;
        tx.execute(
            "UPDATE action_segment SET remote_key = NULL, remote_sha256 = NULL WHERE id = ?1",
            [id],
        )?;
    }
    tombstone_unreferenced_assets(&tx, &shots, "retention")?;
    tx.commit()?;
    Ok(rows.len() + audio.len() + actions.len())
}

/// Delete local videos whose upload is verified and older than `keep_local_hours`.
pub fn release_local(
    conn: &Connection,
    paths: &MemoryPaths,
    s: &SyncSettings,
    now: i64,
) -> Result<usize> {
    let cutoff = now - s.keep_local_hours as i64 * MS_PER_HOUR;
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, path FROM video WHERE status < 2 AND remote_key IS NOT NULL AND uploaded_at IS NOT NULL AND uploaded_at <= ?1")?
        .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, path) in &rows {
        let file = paths.videos_dir().join(path);
        if file.exists() {
            std::fs::remove_file(&file).with_context(|| format!("remove {}", file.display()))?;
        }
        conn.execute(
            "UPDATE video SET status = ?1 WHERE id = ?2",
            params![STATUS_REMOTE, id],
        )?;
    }
    // Audio segments follow the same "Keep on this Mac" window.
    let audio: Vec<(i64, String)> = conn
        .prepare("SELECT id, path FROM audio WHERE status < 2 AND remote_key IS NOT NULL AND uploaded_at IS NOT NULL AND uploaded_at <= ?1")?
        .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, path) in &audio {
        let file = paths.audio_dir().join(path);
        if file.exists() {
            std::fs::remove_file(&file).with_context(|| format!("remove {}", file.display()))?;
        }
        conn.execute(
            "UPDATE audio SET status = ?1 WHERE id = ?2",
            params![STATUS_REMOTE, id],
        )?;
    }
    // Action segments too; their screenshots go once no local segment shows them.
    let actions: Vec<(i64, String)> = conn
        .prepare("SELECT id, path FROM action_segment WHERE status < 2 AND remote_key IS NOT NULL AND uploaded_at IS NOT NULL AND uploaded_at <= ?1")?
        .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, path) in &actions {
        let _ = std::fs::remove_file(super::actions::dir(paths).join(path));
        conn.execute(
            "UPDATE action_segment SET status = ?1 WHERE id = ?2",
            params![STATUS_REMOTE, id],
        )?;
    }
    if !actions.is_empty() {
        super::actions::gc_assets(conn, paths)?;
    }
    Ok(rows.len() + audio.len() + actions.len())
}

#[derive(Debug, Default, Serialize)]
pub struct ForgetReport {
    /// The range actually removed: whole chunks, so it can be wider than asked.
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub chunks: usize,
    pub frames: usize,
    /// Audio segments (and their transcripts) in the range.
    pub audio: usize,
    /// Action segments (and screenshots no other segment shows) in the range.
    pub actions: usize,
    pub remote_objects_queued: usize,
    pub dry_run: bool,
}

/// Delete everything recorded in `range`, locally and (through tombstones) in
/// the bucket. A chunk that overlaps the range goes whole, with all its frames,
/// so no screenshot of a forgotten moment survives inside a video.
pub fn forget(
    conn: &Connection,
    paths: &MemoryPaths,
    s: &Settings,
    device: &str,
    range: TimeRange,
    dry_run: bool,
) -> Result<ForgetReport> {
    let (lo, hi) = (
        range.start.unwrap_or(i64::MIN),
        range.end.unwrap_or(i64::MAX),
    );
    let videos: Vec<(i64, String, i64, i64, Option<String>)> = conn
        .prepare(
            "SELECT id, path, COALESCE(start_timestamp, 0), COALESCE(end_timestamp, start_timestamp, 0), remote_key FROM video
             WHERE COALESCE(end_timestamp, start_timestamp, 0) >= ?1 AND COALESCE(start_timestamp, 0) <= ?2",
        )?
        .query_map(params![lo, hi], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let ids: Vec<i64> = videos.iter().map(|v| v.0).collect();
    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let frame_where =
        format!("(video IN ({id_list}) OR (video IS NULL AND timestamp BETWEEN ?1 AND ?2))");
    let stills: Vec<Option<String>> = conn
        .prepare(&format!("SELECT image_path FROM frame WHERE {frame_where}"))?
        .query_map(params![lo, hi], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    // Audio segments that overlap the range go whole, like chunks.
    let audio: Vec<(i64, String, i64, i64, Option<String>)> = conn
        .prepare(
            "SELECT id, path, start_ms, end_ms, remote_key FROM audio WHERE end_ms >= ?1 AND start_ms <= ?2",
        )?
        .query_map(params![lo, hi], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let actions: Vec<(i64, String, i64, i64, Option<String>, String)> = conn
        .prepare(
            "SELECT id, path, start_ms, end_ms, remote_key, screenshots FROM action_segment WHERE end_ms >= ?1 AND start_ms <= ?2",
        )?
        .query_map(params![lo, hi], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut report = ForgetReport {
        start_ms: videos
            .iter()
            .map(|v| v.2)
            .chain(audio.iter().map(|a| a.2))
            .chain(actions.iter().map(|a| a.2))
            .min()
            .or(range.start),
        end_ms: videos
            .iter()
            .map(|v| v.3)
            .chain(audio.iter().map(|a| a.3))
            .chain(actions.iter().map(|a| a.3))
            .max()
            .or(range.end),
        chunks: videos.len(),
        frames: stills.len(),
        audio: audio.len(),
        actions: actions.len(),
        dry_run,
        ..Default::default()
    };
    if dry_run {
        report.remote_objects_queued = videos.iter().filter(|v| v.4.is_some()).count()
            * SUFFIXES.len()
            + audio.iter().filter(|a| a.4.is_some()).count() * AUDIO_SUFFIXES.len()
            + actions.iter().filter(|a| a.4.is_some()).count() * ACTION_SUFFIXES.len();
        return Ok(report);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS forget_frame(id INTEGER PRIMARY KEY); DELETE FROM forget_frame;")?;
    tx.execute(
        &format!("INSERT INTO forget_frame(id) SELECT id FROM frame WHERE {frame_where}"),
        params![lo, hi],
    )?;
    tx.execute_batch(
        "DELETE FROM ocr WHERE frame IN (SELECT id FROM forget_frame);
         DELETE FROM window_bound WHERE frame IN (SELECT id FROM forget_frame);
         DELETE FROM ax_snapshot WHERE frame_id IN (SELECT id FROM forget_frame);
         DELETE FROM frame WHERE id IN (SELECT id FROM forget_frame);
         DELETE FROM segment WHERE id NOT IN (SELECT segment FROM frame WHERE segment IS NOT NULL);
         DELETE FROM ax_blob WHERE hash NOT IN (SELECT hash FROM ax_snapshot);
         DELETE FROM forget_frame;",
    )?;
    let synced = s.sync.configured();
    let pfx = prefix(paths, s);
    for (id, _, start, _, remote_key) in &videos {
        // Also covers a partial upload (sidecar up, video not yet): those keys are predictable.
        let key = remote_key
            .clone()
            .or_else(|| synced.then(|| prefixed(&pfx, &chunk_rel(device, *start, *id))));
        if let Some(key) = key {
            report.remote_objects_queued += tombstone_chunk(&tx, device, &key, *start, "forget")?;
        }
        tx.execute("DELETE FROM video WHERE id = ?1", [id])?;
    }
    let mut shots = Vec::new();
    for (id, _, start, _, remote_key, list) in &actions {
        let key = remote_key
            .clone()
            .or_else(|| synced.then(|| prefixed(&pfx, &actions_rel(device, *start, *id))));
        if let Some(key) = key {
            report.remote_objects_queued += tombstone_actions(&tx, device, &key, *start, "forget")?;
        }
        shots.extend(super::actions::screenshots_of(list));
        tx.execute("DELETE FROM action_segment WHERE id = ?1", [id])?;
    }
    report.remote_objects_queued += tombstone_unreferenced_assets(&tx, &shots, "forget")?;
    for (id, _, start, _, remote_key) in &audio {
        let key = remote_key
            .clone()
            .or_else(|| synced.then(|| prefixed(&pfx, &audio_rel(device, *start, *id))));
        if let Some(key) = key {
            report.remote_objects_queued += tombstone_audio(&tx, device, &key, *start, "forget")?;
        }
        // Transcript lines and their search rows go with the segment (cascade + trigger).
        tx.execute("DELETE FROM audio_transcript WHERE audio = ?1", [id])?;
        tx.execute("DELETE FROM audio WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    for (id, path, ..) in &audio {
        let _ = std::fs::remove_file(paths.audio_dir().join(path));
        let _ = std::fs::remove_file(audio_cache_dir(paths).join(path));
        let _ = std::fs::remove_file(encrypted_audio_tmp(paths, *id));
    }
    // Segments still staged as PCM (not encoded yet) in the range.
    if let Ok(rd) = std::fs::read_dir(paths.audio_staging_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some((start, _)) =
                super::audio::parse_staging_name(name.trim_end_matches(".part"))
            {
                if start >= lo.saturating_sub(super::audio::SEGMENT_MS) && start <= hi {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    for (id, path, ..) in &videos {
        let _ = std::fs::remove_file(paths.videos_dir().join(path));
        let _ = std::fs::remove_file(cache_dir(paths).join(path));
        let _ = std::fs::remove_file(encrypted_tmp(paths, *id));
    }
    for (id, path, ..) in &actions {
        let _ = std::fs::remove_file(super::actions::dir(paths).join(path));
        let _ = std::fs::remove_file(encrypted_actions_tmp(paths, *id));
    }
    if !actions.is_empty() {
        super::actions::gc_assets(conn, paths)?;
    }
    for still in stills.into_iter().flatten() {
        let _ = std::fs::remove_file(paths.abs(&still));
    }
    Ok(report)
}

fn prefixed(prefix: &str, rel: &str) -> String {
    let p = prefix.trim_matches('/');
    if p.is_empty() {
        rel.to_string()
    } else {
        format!("{p}/{rel}")
    }
}

pub fn cache_dir(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("cache").join("videos")
}

/// Local path of a remote-only chunk, downloading (and decrypting, verifying)
/// it into the cache when needed. None when the chunk is not remote-only.
pub fn fetch_remote(
    conn: &Connection,
    paths: &MemoryPaths,
    video_id: i64,
) -> Result<Option<PathBuf>> {
    let row: Option<(String, Option<String>, i64, Option<String>)> = conn
        .query_row(
            "SELECT path, remote_key, status, remote_sha256 FROM video WHERE id = ?1",
            [video_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((path, Some(key), STATUS_REMOTE, want_sha)) = row else {
        return Ok(None);
    };
    let s = Settings::load(paths);
    fetch_to_cache(
        paths,
        || target(paths, &s),
        &format!("{key}.mp4"),
        want_sha.as_deref(),
        &cache_dir(paths),
        &path,
        s.sync.cache_mb,
    )
    .map(Some)
}

pub fn audio_cache_dir(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("cache").join("audio")
}

/// Local path of a remote-only audio segment, downloading (and decrypting,
/// verifying against the recorded SHA-256) it into `cache/audio/` when needed.
pub fn fetch_remote_audio(
    conn: &Connection,
    paths: &MemoryPaths,
    audio_id: i64,
) -> Result<Option<PathBuf>> {
    let row: Option<(String, Option<String>, i64, Option<String>)> = conn
        .query_row(
            "SELECT path, remote_key, status, remote_sha256 FROM audio WHERE id = ?1",
            [audio_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((path, Some(key), STATUS_REMOTE, want_sha)) = row else {
        return Ok(None);
    };
    let s = Settings::load(paths);
    fetch_to_cache(
        paths,
        || target(paths, &s),
        &format!("{key}.m4a"),
        want_sha.as_deref(),
        &audio_cache_dir(paths),
        &path,
        s.sync.cache_mb,
    )
    .map(Some)
}

/// `dir/name` when it is cached; else download `key` through the target `t`
/// builds, check its SHA-256 against `want`, decrypt it when it is encrypted,
/// and keep the cache under `cache_mb`. A cached file plays without a network.
pub fn fetch_to_cache(
    paths: &MemoryPaths,
    t: impl FnOnce() -> Result<Box<dyn UploadTarget>>,
    key: &str,
    want: Option<&str>,
    dir: &Path,
    name: &str,
    cache_mb: u64,
) -> Result<PathBuf> {
    let out = dir.join(name);
    if out.exists() {
        let _ = std::fs::File::options()
            .append(true)
            .open(&out)
            .and_then(|f| f.set_modified(std::time::SystemTime::now()));
        return Ok(out);
    }
    let dl = out.with_extension("download");
    let (_, digest) = t()?.get_to_file(key, &dl)?;
    if let Some(want) = want.filter(|w| !w.is_empty()) {
        if target::hex(&digest) != want {
            let _ = std::fs::remove_file(&dl);
            bail!(
                "{key}: SHA-256 {} does not match the manifest {want}",
                target::hex(&digest)
            );
        }
    }
    let mut head = [0u8; 32];
    let n = std::io::Read::read(&mut std::fs::File::open(&dl)?, &mut head)?;
    match crypt::key_id_of(&head[..n]) {
        Some(id) => {
            let k = crypt::load(paths, &id).ok_or_else(|| {
                config_error(format!(
                    "{key} is encrypted with key {id}, which is not on this machine"
                ))
            })?;
            let res = crypt::decrypt_file(&k, &dl, &out);
            let _ = std::fs::remove_file(&dl);
            res?;
        }
        None => std::fs::rename(&dl, &out)?,
    }
    evict_cache(dir, cache_mb.saturating_mul(1024 * 1024), Some(&out));
    Ok(out)
}

/// Remove the least recently used cached chunks until the cache fits `cap` bytes.
fn evict_cache(dir: &Path, cap: u64, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| {
                (
                    m.modified().unwrap_or(std::time::UNIX_EPOCH),
                    e.path(),
                    m.len(),
                )
            })
        })
        .collect();
    files.sort_by_key(|f| f.0);
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    for (_, path, len) in files {
        if total <= cap {
            break;
        }
        if Some(path.as_path()) != keep && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// `<library>/sync.json`: what the CLI, tray and UI show.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncState {
    pub enabled: bool,
    /// "off" | "ok" | "error" (a pass-stopping error; see `last_error_class`)
    pub state: String,
    pub device_id: String,
    /// Chunks waiting to upload (queue depth).
    pub pending: i64,
    pub bytes_pending: i64,
    /// Age of the oldest chunk not yet uploaded, in ms.
    pub oldest_unsent_ms: Option<i64>,
    /// Chunks waiting in backoff after a failed attempt.
    pub retrying: i64,
    pub uploaded: i64,
    pub remote_only: i64,
    /// Remote objects queued for deletion.
    pub tombstones: i64,
    pub multipart_in_progress: i64,
    /// Audio segments waiting to upload, uploaded, and kept in the cloud only.
    pub audio_pending: i64,
    pub audio_uploaded: i64,
    pub audio_remote_only: i64,
    /// Action segments waiting to upload, uploaded, and kept in the cloud only.
    pub actions_pending: i64,
    pub actions_uploaded: i64,
    pub actions_remote_only: i64,
    /// `s3` or `kortix`.
    pub provider: String,
    /// The issuer refused this device: sync stopped until the person signs in again.
    pub sign_in_required: bool,
    /// When status.json last reached the bucket (epoch ms).
    pub status_reported_ms: Option<i64>,
    pub last_upload_ms: Option<i64>,
    pub last_error: Option<String>,
    /// auth | config | clock_skew | transient | integrity | local
    pub last_error_class: Option<String>,
    /// When a stopped pass is retried (epoch ms).
    pub next_retry_ms: Option<i64>,
    /// Upload rate of recent passes (exponential moving average), bytes/s.
    pub throughput_bps: Option<u64>,
    /// Bytes uploaded since the recorder started.
    pub bytes_uploaded: u64,
    pub encrypted: bool,
    pub key_id: Option<String>,
    pub clock_offset_ms: i64,
    pub updated_at_ms: i64,
}

pub fn state_path(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("sync.json")
}

pub fn read_state(paths: &MemoryPaths) -> Option<SyncState> {
    serde_json::from_slice(&std::fs::read(state_path(paths)).ok()?).ok()
}

/// What the sync thread knows beyond the database.
#[derive(Debug, Default)]
pub struct Runtime {
    pub error: Option<(String, ErrorClass)>,
    pub halt_attempts: i64,
    pub retry_at: i64,
    pub announced_at: i64,
    /// device.json body last written (rewritten when it changes).
    pub announced: Option<Value>,
    pub status_at: i64,
    pub policy_at: i64,
    pub throughput_bps: Option<f64>,
    pub bytes_uploaded: u64,
    pub clock_offset_ms: i64,
    /// When this computer last woke (or the app started): status.json `host.awakeSinceMs`.
    pub awake_since_ms: i64,
    /// End of the last loop iteration, to see a sleep gap.
    pub last_tick_ms: i64,
}

/// Queue and progress counters from the database plus the runtime state.
pub fn compute_state(
    conn: &Connection,
    paths: &MemoryPaths,
    s: &Settings,
    enabled: bool,
    device: &str,
    rt: &Runtime,
) -> SyncState {
    let q = |sql: &str| {
        conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
    };
    let chunk_error: Option<(String, String)> = conn
        .query_row(
            "SELECT upload_error, COALESCE(upload_error_class, 'transient') FROM video
             WHERE upload_error IS NOT NULL AND uploaded_at IS NULL AND local_only = 0 AND status < 2 ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (last_error, last_error_class) = match (&rt.error, chunk_error) {
        (Some((msg, class)), _) => (Some(msg.clone()), Some(class.as_str().to_string())),
        (None, Some((msg, class))) => (Some(msg), Some(class)),
        (None, None) => (None, None),
    };
    let now = now_ms();
    SyncState {
        enabled,
        state: if !enabled { "off" } else if rt.error.is_some() { "error" } else { "ok" }.into(),
        device_id: device.to_string(),
        pending: q("SELECT count(*) FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0").unwrap_or(0),
        bytes_pending: q("SELECT (SELECT COALESCE(sum(size_bytes), 0) FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0)
                          + (SELECT COALESCE(sum(size_bytes), 0) FROM audio WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0)
                          + (SELECT COALESCE(sum(size_bytes), 0) FROM action_segment WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0)").unwrap_or(0),
        oldest_unsent_ms: q("SELECT min(COALESCE(end_timestamp, start_timestamp)) FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0").map(|t| (now - t).max(0)),
        retrying: q("SELECT count(*) FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND upload_attempts > 0").unwrap_or(0),
        uploaded: q("SELECT count(*) FROM video WHERE uploaded_at IS NOT NULL").unwrap_or(0),
        remote_only: q("SELECT count(*) FROM video WHERE status = 3").unwrap_or(0),
        tombstones: q("SELECT count(*) FROM sync_tombstone").unwrap_or(0),
        multipart_in_progress: q("SELECT count(*) FROM sync_multipart").unwrap_or(0),
        audio_pending: q("SELECT count(*) FROM audio WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0").unwrap_or(0),
        audio_uploaded: q("SELECT count(*) FROM audio WHERE uploaded_at IS NOT NULL").unwrap_or(0),
        audio_remote_only: q("SELECT count(*) FROM audio WHERE status = 3").unwrap_or(0),
        actions_pending: q("SELECT count(*) FROM action_segment WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0").unwrap_or(0),
        actions_uploaded: q("SELECT count(*) FROM action_segment WHERE uploaded_at IS NOT NULL").unwrap_or(0),
        actions_remote_only: q("SELECT count(*) FROM action_segment WHERE status = 3").unwrap_or(0),
        provider: s.sync.provider.clone(),
        sign_in_required: s.sync.provider == "kortix"
            && issuer::registration(paths).is_some_and(|r| r.rejected_at_ms.is_some()),
        status_reported_ms: (rt.status_at > 0).then_some(rt.status_at),
        last_upload_ms: q("SELECT max(t) FROM (SELECT max(uploaded_at) AS t FROM video UNION ALL SELECT max(uploaded_at) FROM audio UNION ALL SELECT max(uploaded_at) FROM action_segment)"),
        last_error,
        last_error_class,
        next_retry_ms: rt.error.as_ref().map(|_| rt.retry_at),
        throughput_bps: rt.throughput_bps.map(|b| b as u64),
        bytes_uploaded: rt.bytes_uploaded,
        encrypted: s.sync.encrypt,
        key_id: (!s.sync.key_id.is_empty()).then(|| s.sync.key_id.clone()),
        clock_offset_ms: rt.clock_offset_ms,
        updated_at_ms: now,
    }
}

pub fn write_state(paths: &MemoryPaths, state: &SyncState) {
    let tmp = state_path(paths).with_extension("json.tmp");
    if serde_json::to_vec_pretty(state)
        .ok()
        .and_then(|b| std::fs::write(&tmp, b).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, state_path(paths));
    }
}

/// `<device>/device.json`, unencrypted so `sync devices` and readers can list
/// machines. With encryption on, or privacy masking on, the host and computer
/// names are null. Returns the body (it is rewritten when it changes).
pub fn device_json(ctx: &Ctx, conn: &Connection) -> Value {
    let q = |sql: &str| {
        conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
    };
    let id = identity(ctx.paths);
    let private = ctx.key.is_some() || ctx.settings.privacy.redact_pii;
    let member = issuer::registration(ctx.paths)
        .filter(|_| ctx.settings.sync.provider == "kortix")
        .and_then(|r| r.member_email)
        .map(|email| json!({"email": email}));
    json!({
        "schema": SCHEMA,
        "device_id": ctx.device,
        "machine_key_sha256": id.machine_key_sha256,
        "hostname": if private { Value::Null } else { json!(id.hostname) },
        "computer_name": if private { Value::Null } else { json!(id.computer_name) },
        "os": id.os,
        "os_version": id.os_version,
        "arch": id.arch,
        "app_version": id.app_version,
        "member": member,
        "encryption": ctx.key.map(|k| json!({"alg": crypt::ALG, "key_id": k.id()})),
        "first_chunk_ms": q("SELECT min(start_timestamp) FROM video WHERE remote_key IS NOT NULL"),
        "last_chunk_ms": q("SELECT max(end_timestamp) FROM video WHERE remote_key IS NOT NULL"),
        "displays": device_displays(ctx.paths),
    })
}

/// Unencrypted JSON (device.json, status.json are for every reader).
fn put_json(ctx: &Ctx, rel: &str, body: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(body)?;
    ctx.t.put_bytes(
        &ctx.t.key(rel),
        &bytes,
        "application/json",
        &Sha256::digest(&bytes).into(),
    )
}

/// The account policy, `<prefix>/policy.json`. Ok(None) when it does not exist.
/// Never a file in the device's own folder: the device can write there, and a
/// policy it wrote must not lift the account's exclusions or pause.
pub fn fetch_policy(t: &dyn UploadTarget) -> Result<Option<super::policy::Cached>> {
    let key = t.key("policy.json");
    let Some(bytes) = t.get_bytes(&key)? else {
        return Ok(None);
    };
    Ok(Some(super::policy::Cached {
        policy: super::policy::parse(&bytes).with_context(|| format!("policy {key}"))?,
        source: key,
        fetched_at_ms: now_ms(),
    }))
}

/// Read the policy into `<library>/policy.json`. A policy the app cannot read
/// (unparsable, a newer schema, or refused by the store) keeps the last one in
/// force; uploads with the same credentials surface a real auth problem.
/// True when the policy in force changed (another source, or new content).
fn refresh_policy(ctx: &Ctx) -> Result<bool> {
    match fetch_policy(ctx.t) {
        Ok(cached) => {
            let key =
                |c: Option<&super::policy::Cached>| c.map(|c| (c.source.clone(), c.policy.clone()));
            let before = super::policy::read(ctx.paths);
            super::policy::write(ctx.paths, cached.as_ref())?;
            Ok(key(before.as_ref()) != key(cached.as_ref()))
        }
        Err(e) if classify(&e).halts() && classify(&e) != ErrorClass::Auth => Err(e),
        Err(e) => {
            tracing::warn!("sync: policy not applied (the last one stays): {e:#}");
            Ok(false)
        }
    }
}

/// Index lines for chunks uploaded before the index existed (they have no
/// manifest; restore reads their sidecar directly).
fn backfill_index(conn: &Connection, device: &str) -> Result<()> {
    let rows: Vec<(i64, String, i64, i64)> = conn
        .prepare("SELECT id, remote_key, COALESCE(start_timestamp, 0), COALESCE(end_timestamp, start_timestamp, 0) FROM video WHERE remote_key IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, key, start, end) in rows {
        if let Some(rel) = device_rel(device, &key) {
            journal(
                conn,
                start,
                &json!({"op": "put", "kind": "chunk", "base": rel, "video_id": id, "start_ms": start, "end_ms": end, "manifest": false}),
            )?;
        }
    }
    Ok(())
}

/// One sync pass. Err only for a pass-stopping error. `s` is the effective
/// settings (the policy applied).
pub fn pass(
    conn: &Connection,
    paths: &MemoryPaths,
    s: &Settings,
    device: &str,
    stop: &AtomicBool,
    rt: &mut Runtime,
) -> Result<()> {
    let t = build_target(paths, s, rt.clock_offset_ms);
    let t = match t {
        Ok(t) => t,
        Err(e) => return Err(e),
    };
    let t = t.as_ref();
    let key = ensure_key(paths, s)?;
    let ctx = Ctx {
        paths,
        t,
        device,
        key: key.as_ref(),
        stop,
        settings: s,
    };
    let res = pass_with(conn, &ctx, s, rt);
    rt.clock_offset_ms = t.clock_offset_ms();
    if res
        .as_ref()
        .err()
        .is_some_and(|e| classify(e) == ErrorClass::Auth)
    {
        // Issued credentials may have been revoked or expired early: fetch new ones next pass.
        issuer::forget_credentials();
    }
    res
}

fn pass_with(conn: &Connection, ctx: &Ctx, s: &Settings, rt: &mut Runtime) -> Result<()> {
    let (t, device) = (ctx.t, ctx.device);
    store::run_once(conn, "sync-index-backfill-v1", |c| {
        backfill_index(c, device)
    })?;
    // The policy first: it can turn a layer off before anything of it uploads.
    if now_ms() - rt.policy_at >= DEVICE_EVERY_MS {
        if refresh_policy(ctx)? && rt.status_at > 0 {
            // Report the change soon, once the recorders followed it (they
            // check every 5 s), not at the next minute.
            rt.status_at = rt
                .status_at
                .min(now_ms() - STATUS_EVERY_MS + POLICY_STATUS_DELAY_MS);
        }
        rt.policy_at = now_ms();
    }
    let mut up = UploadStats::default();
    for kind in ["chunks", "audio", "actions"] {
        let before = t.bytes_sent();
        let res = match kind {
            "chunks" => upload_pending(conn, ctx, &s.sync),
            "audio" => upload_pending_audio(conn, ctx, &s.sync),
            _ => upload_pending_actions(conn, ctx, &s.sync),
        };
        let sent = t.bytes_sent() - before;
        rt.bytes_uploaded += sent;
        let st = res?;
        up.chunks += st.chunks;
        up.failed += st.failed;
        up.bytes += st.bytes;
        up.elapsed += st.elapsed;
        if st.chunks > 0 && !st.elapsed.is_zero() {
            let bps = sent as f64 / st.elapsed.as_secs_f64();
            rt.throughput_bps = Some(rt.throughput_bps.map_or(bps, |old| old * 0.7 + bps * 0.3));
        }
    }
    // After the uploads, so device.json names the newest chunk.
    let body = device_json(ctx, conn);
    let changed = rt.announced.as_ref().map(|b| {
        let strip = |v: &Value| {
            let mut v = v.clone();
            v.as_object_mut().map(|o| {
                o.remove("first_chunk_ms");
                o.remove("last_chunk_ms");
            });
            v
        };
        strip(b) != strip(&body)
    });
    if changed != Some(false)
        || (up.chunks > 0 && rt.announced_at < now_ms() - DEVICE_EVERY_MS)
        || now_ms() - rt.announced_at > ANNOUNCE_EVERY_MS
    {
        let mut out = body.clone();
        out["updated_at_ms"] = json!(now_ms());
        put_json(ctx, &format!("{device}/device.json"), &out)?;
        rt.announced_at = now_ms();
        rt.announced = Some(body);
    }
    if now_ms() - rt.status_at >= STATUS_EVERY_MS {
        let mut status = super::cli::device_status(ctx.paths, app_version());
        status["reportedAtMs"] = json!(now_ms());
        status["host"] = json!({"awakeSinceMs": rt.awake_since_ms});
        put_json(ctx, &format!("{device}/status.json"), &status)?;
        rt.status_at = now_ms();
    }
    remote_retention(conn, &s.sync, device, now_ms())?;
    let swept = sweep_tombstones(conn, t)?;
    if let Err(e) = flush_index(conn, ctx) {
        if classify(&e).halts() {
            return Err(e);
        }
        tracing::warn!("sync index flush failed (retried next pass): {e:#}");
    }
    let freed = release_local(conn, ctx.paths, &s.sync, now_ms())?;
    if up.chunks > 0 || freed > 0 || swept > 0 {
        tracing::info!(
            uploaded = up.chunks,
            failed = up.failed,
            freed,
            deleted_remote = swept,
            "sync"
        );
    }
    Ok(())
}

/// The library's sync lock, held while it lives. Advisory (`flock` / `LockFileEx`):
/// the OS releases it when the holder exits or crashes.
pub struct PassLock(#[allow(dead_code)] std::fs::File);

/// Take the sync lock. `wait`: block until the holder's pass ends; otherwise
/// return None while another process (or thread) holds it.
pub fn lock_passes(paths: &MemoryPaths, wait: bool) -> Result<Option<PassLock>> {
    std::fs::create_dir_all(&paths.root)?;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.sync_lock())
        .with_context(|| format!("open {}", paths.sync_lock().display()))?;
    if wait {
        f.lock()
            .with_context(|| format!("lock {}", paths.sync_lock().display()))?;
        return Ok(Some(PassLock(f)));
    }
    match f.try_lock() {
        Ok(()) => Ok(Some(PassLock(f))),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => {
            Err(e).with_context(|| format!("lock {}", paths.sync_lock().display()))
        }
    }
}

/// The recorder's sync thread.
pub fn run(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
    let conn = store::open(&paths)?;
    let mut rt = Runtime::default();
    let mut last_target: Option<(String, String)> = None;
    while !stop.load(Ordering::SeqCst) {
        note_wake(&mut rt, now_ms());
        let s = Settings::effective(&paths);
        let enabled = s.sync.enabled && !s.airgap;
        let device = device_id(&paths, &s);
        // A new target or device (sign-in, setup) announces itself and reads its policy at once.
        let here = (s.sync.provider.clone(), device.clone());
        if last_target.as_ref() != Some(&here) {
            rt = Runtime {
                bytes_uploaded: rt.bytes_uploaded,
                awake_since_ms: rt.awake_since_ms,
                last_tick_ms: rt.last_tick_ms,
                ..Runtime::default()
            };
            last_target = Some(here);
        }
        if enabled && now_ms() >= rt.retry_at {
            // None: `sync now` in another process holds the lock and uploads; skip this tick.
            let res = lock_passes(&paths, false).and_then(|lock| match lock {
                Some(_lock) => pass(&conn, &paths, &s, &device, &stop, &mut rt).map(|()| true),
                None => Ok(false),
            });
            match res {
                Ok(false) => {}
                Ok(true) => {
                    rt.error = None;
                    rt.halt_attempts = 0;
                }
                Err(e) => {
                    let class = classify(&e);
                    let msg: String = format!("{e:#}").chars().take(500).collect();
                    tracing::warn!(class = class.as_str(), "sync stopped: {msg}");
                    rt.retry_at = now_ms() + backoff_ms(rt.halt_attempts);
                    rt.halt_attempts += 1;
                    rt.error = Some((msg, class));
                }
            }
        } else if !enabled {
            rt.error = None;
            // The operator's policy applies only while this device syncs to their bucket.
            let _ = super::policy::write(&paths, None);
        }
        write_state(
            &paths,
            &compute_state(&conn, &paths, &s, enabled, &device, &rt),
        );
        rt.last_tick_ms = now_ms();
        let until = Instant::now() + TICK;
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    Ok(())
}

/// Start of an awake spell: the app start, or the first tick after a gap longer than
/// [`SLEEP_GAP_MS`]. A tick ends before its sleep, so a long upload is not a gap.
fn note_wake(rt: &mut Runtime, now: i64) {
    if rt.awake_since_ms == 0 || (rt.last_tick_ms > 0 && now - rt.last_tick_ms > SLEEP_GAP_MS) {
        rt.awake_since_ms = now;
    }
}

#[cfg(test)]
mod tests;
