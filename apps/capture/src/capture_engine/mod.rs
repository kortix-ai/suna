//! `kortix-capture-engine` for Windows and Linux.
//!
//! Same wire protocol as the macOS Swift sidecar (`native/macos/CaptureEngine.swift`):
//! one JSON request per stdin line, one JSON response per stdout line, `id`
//! echoed, `ok` bool, `error` string on failure. The Rust side
//! (`src/memory/engine.rs`) owns policy, storage and scheduling. This process
//! only touches OS APIs.
//!
//! Commands: ping, permissions, request_permissions, capture, probe, ocr, icon,
//! encode, extract, convert, image_color, transcode, encode_audio,
//! audio_devices, transcribe (macOS only; answers an error here).
//! `kortix-capture-engine audio --source …` streams PCM instead (`audio.rs`).
//!
//! Shared here: the protocol loop, privacy policy, window redaction, image
//! helpers (dhash, crop, resize), OCR word grouping. Per-OS code lives in
//! `win.rs` and `linux.rs`; both export the same free functions, and
//! `unsupported.rs` stubs them on macOS so this module always compiles.
//!
//! `bundle_id` scheme (stable key for the `application` table):
//! * Windows: the AppUserModelID for packaged (UWP/MSIX) processes, else the
//!   lowercase executable file name, for example `chrome.exe`.
//! * Linux: the lowercase X11 `WM_CLASS` class, for example `firefox`.
//!
//! `aliases` hold the app's other identifiers (Windows: executable, package
//! and display names; Linux: `WM_CLASS` instance, process, executable,
//! Flatpak, Snap and AppImage names). App lists match any of them by the one
//! rule, `memory::exclusions::app_matches`: `notepad.exe` names the classic and
//! the packaged Windows 11 Notepad.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use image::{imageops::FilterType, DynamicImage, RgbImage, RgbaImage};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Instant;

pub mod audio;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as os;
#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "windows")]
use win as os;
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
mod unsupported;
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
use unsupported as os;

/// Executables of Kortix itself. Capture skips frames while one is focused and
/// paints their windows black.
const OWN_APPS: &[&str] = &[
    "kortix-capture.exe",
    "kortix-tray.exe",
    "kortix-backend.exe",
    "kortix-capture-engine.exe",
    "kortix-capture",
    "kortix-tray",
    "kortix-backend",
];
/// Lock screen and secure-desktop hosts: never recorded.
const ALWAYS_EXCLUDED: &[&str] = &["logonui.exe", "lockapp.exe", "consent.exe"];

/// Kortix itself, never recorded: its own executables and the app the service
/// runs in (`own`, from the request's `own_bundle_ids`).
pub fn is_own(bundle: &str, aliases: &[String], own: &[String]) -> bool {
    OWN_APPS.iter().any(|o| app_matches(o, bundle, aliases)) || app_listed(own, bundle, aliases)
}

/// The package family and package name of a packaged Windows app's
/// AppUserModelID: `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App` →
/// `Microsoft.WindowsNotepad_8wekyb3d8bbwe`, `Microsoft.WindowsNotepad`.
pub fn packaged_aliases(aumid: &str) -> Vec<String> {
    let Some((family, _)) = aumid.split_once('!') else {
        return Vec::new();
    };
    let mut out = vec![family.to_string()];
    if let Some((name, _)) = family.rsplit_once('_') {
        out.push(name.to_string());
    }
    out
}

/// A Linux process's other names: its executable's file name, its Snap name
/// (`/snap/<name>/…`), its Flatpak app id (the `app-flatpak-<id>-<n>.scope`
/// cgroup) and its AppImage file name (`APPIMAGE` in its environment).
pub fn process_aliases(exe: &str, cgroup: &str, environ: &[u8]) -> Vec<String> {
    let base = |p: &str| p.rsplit('/').next().unwrap_or("").to_string();
    let exe = exe.trim_end_matches(" (deleted)");
    let mut out = vec![base(exe)];
    if let Some(rest) = exe.strip_prefix("/snap/") {
        out.push(rest.split('/').next().unwrap_or("").to_string());
    }
    if let Some(scope) = cgroup
        .split(['/', '\n'])
        .find_map(|seg| seg.strip_prefix("app-flatpak-"))
    {
        let scope = scope.trim_end_matches(".scope");
        out.push(scope.rsplit_once('-').map_or(scope, |(id, _)| id).to_string());
    }
    if let Some(image) = environ
        .split(|&b| b == 0)
        .find_map(|kv| kv.strip_prefix(b"APPIMAGE="))
    {
        out.push(base(&String::from_utf8_lossy(image)));
    }
    out.retain(|a| !a.is_empty());
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        let r = self.right().min(o.right());
        let b = self.bottom().min(o.bottom());
        (r > x && b > y).then_some(Rect {
            x,
            y,
            w: r - x,
            h: b - y,
        })
    }
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
    fn json(&self) -> Value {
        json!({"x": self.x, "y": self.y, "w": self.w, "h": self.h})
    }
}

pub struct Foreground {
    pub id: u64,
    pub pid: u32,
    pub bundle_id: String,
    /// The app's other identifiers (see the module doc).
    pub aliases: Vec<String>,
    pub name: String,
    pub version: String,
    pub title: String,
    pub rect: Option<Rect>,
}

#[derive(Clone)]
pub struct WinInfo {
    pub id: u64,
    pub pid: u32,
    pub bundle_id: String,
    /// The app's other identifiers (see the module doc).
    pub aliases: Vec<String>,
    pub app_name: String,
    pub title: String,
    pub rect: Rect,
    pub focused: bool,
}

pub struct Display {
    pub id: i64,
    pub rect: Rect,
}

/// One connected display: its id (HMONITOR on Windows, RandR monitor index on
/// Linux), bounds in global coordinates, name, whether it is the primary, and scale.
#[derive(Clone, Debug)]
pub struct DisplayInfo {
    pub id: i64,
    pub rect: Rect,
    pub name: String,
    pub main: bool,
    pub scale: f64,
}

/// What every display shows: the windows hidden on every display, the displays
/// a hidden window fully covers (no frame of them), and each display's top
/// visible window (its app, title and URL name the frame).
pub struct DisplayPlan<'a> {
    pub hidden: HashSet<u64>,
    pub covered: HashSet<i64>,
    pub top: HashMap<i64, &'a WinInfo>,
}

/// Record only included apps and websites (`only_included`, `include_bundle_ids`,
/// `include_domains` of the request). Off: everything not excluded is recorded.
#[derive(Default)]
pub struct Include {
    pub on: bool,
    pub apps: Vec<String>,
    pub domains: Vec<String>,
}

impl Include {
    pub fn from_request(req: &Value) -> Self {
        let list = |k: &str| -> Vec<String> {
            req.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_lowercase)).collect())
                .unwrap_or_default()
        };
        Include {
            on: req.get("only_included").and_then(Value::as_bool) == Some(true),
            apps: list("include_bundle_ids"),
            domains: list("include_domains"),
        }
    }

    /// The app is included, or the page's website is. Off: always true.
    pub fn allows(&self, bundle: &str, aliases: &[String], url: Option<&str>) -> bool {
        !self.on
            || app_listed(&self.apps, bundle, aliases)
            || url.is_some_and(|u| url_excluded(u, &self.domains))
    }
}

/// `windows` front to back. A window is hidden when its app is excluded or
/// unknown, its title marks a private window, its URL is on an excluded site,
/// or record only included is on and neither its app nor its website is included.
/// With record only included, a display with no included window writes no frame.
#[allow(clippy::too_many_arguments)]
pub fn plan_displays<'a>(
    windows: &'a [WinInfo],
    displays: &[DisplayInfo],
    url_of: &dyn Fn(&WinInfo) -> Option<String>,
    excluded_app: &dyn Fn(&str, &[String]) -> bool,
    excluded_domains: &[String],
    exclude_private: bool,
    record_unknown: bool,
    include: &Include,
) -> DisplayPlan<'a> {
    let is_hidden = |w: &WinInfo| {
        let bundle = w.bundle_id.to_lowercase();
        if bundle.is_empty() {
            return !record_unknown || include.on;
        }
        let url = url_of(w);
        excluded_app(&bundle, &w.aliases)
            || (exclude_private && looks_private(&w.title))
            || url.as_deref().is_some_and(|u| url_excluded(u, excluded_domains))
            || !include.allows(&bundle, &w.aliases, url.as_deref())
    };
    let hidden: HashSet<u64> = windows
        .iter()
        .filter(|w| is_hidden(w))
        .map(|w| w.id)
        .collect();
    let mut covered = HashSet::new();
    let mut top = HashMap::new();
    for d in displays {
        let area = d.rect.w as i64 * d.rect.h as i64;
        for w in windows {
            let Some(o) = w.rect.intersect(&d.rect) else {
                continue;
            };
            if hidden.contains(&w.id) {
                // Covered only when nothing visible lies in front of it on this display.
                if !top.contains_key(&d.id) && (o.w as i64 * o.h as i64) * 100 >= area * 95 {
                    covered.insert(d.id);
                    break;
                }
                continue;
            }
            top.entry(d.id).or_insert(w);
        }
        if include.on && !top.contains_key(&d.id) {
            covered.insert(d.id);
        }
    }
    DisplayPlan {
        hidden,
        covered,
        top,
    }
}

/// FNV-1a over a 256-pixel-wide grayscale, area-averaged copy: an equal hash
/// means the display did not change.
pub fn content_hash(img: &RgbImage) -> String {
    let h = ((img.height() as f64 * 256.0 / img.width().max(1) as f64).round() as u32).max(1);
    let small = image::imageops::thumbnail(&image::imageops::grayscale(img), 256, h);
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in small.as_raw() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub struct Shot {
    pub image: RgbImage,
    pub display: Display,
}

/// One recognized word in image pixels.
pub struct Word {
    pub rect: Rect,
    pub text: String,
    pub confidence: f64,
}

pub struct AxResult {
    pub tree: Value,
    pub node_count: usize,
    pub partial: bool,
}

pub struct IconResult {
    pub image: RgbaImage,
    pub display_name: String,
}

// ---------------------------------------------------------------- protocol

pub fn run() -> Result<()> {
    if cfg!(target_os = "macos") {
        bail!("kortix-capture-engine (Rust) is for Windows and Linux; macOS uses the Swift engine built by build.rs");
    }
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("audio") {
        std::process::exit(audio::run(&args[2..]));
    }
    os::init();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                emit(&stdout, fail("bad_json"));
                continue;
            }
        };
        let id = req.get("id").cloned();
        let res = match std::panic::catch_unwind(|| handle(&req)) {
            Ok(res) => res,
            Err(_) => fail("engine_panic"),
        };
        let mut res = res;
        if let Some(id) = id {
            res["id"] = id;
        }
        emit(&stdout, res);
    }
    Ok(())
}

fn emit(out: &std::io::Stdout, mut res: Value) {
    if res.get("ok").is_none() {
        res["ok"] = json!(true);
    }
    let mut lock = out.lock();
    let _ = writeln!(lock, "{}", res);
    let _ = lock.flush();
}

fn fail(msg: impl std::fmt::Display) -> Value {
    json!({"ok": false, "error": msg.to_string()})
}

/// Run a command and fold `Err` into a protocol failure. Public for tests.
pub fn handle(req: &Value) -> Value {
    let Some(cmd) = req.get("cmd").and_then(Value::as_str) else {
        return fail("bad_json");
    };
    let res = match cmd {
        "ping" => Ok(json!({"pong": true, "pid": std::process::id(), "os": std::env::consts::OS})),
        "permissions" | "request_permissions" => Ok(os::permissions()),
        "capture" | "capture_private" => capture(req),
        "probe" => probe(req),
        "ocr" => ocr(req),
        "icon" => icon(req),
        "encode" => encode(req),
        "extract" => extract(req),
        "convert" => convert(req),
        "image_color" => image_color(req),
        "transcode" => transcode(req),
        "encode_audio" => encode_audio(req),
        "audio_devices" => os::audio_devices(),
        "transcribe" => Err(anyhow!(
            "transcription_unsupported: on-device transcription is available on macOS"
        )),
        other => Err(anyhow!("unknown_cmd: {other}")),
    };
    res.unwrap_or_else(|e| fail(format!("{e:#}")))
}

fn str_arg<'a>(req: &'a Value, key: &str) -> Result<&'a str> {
    req.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("bad_request: missing {key}"))
}

fn ensure_parent(path: &str) -> Result<()> {
    if let Some(dir) = Path::new(path).parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    Ok(())
}

// ----------------------------------------------------------------- privacy

/// One list for the engine and the action recorder (`memory::exclusions`).
pub use crate::memory::exclusions::{app_listed, app_matches, looks_private, url_excluded};

// ----------------------------------------------------------------- capture

/// Change detector for change-driven capture: foreground app, title and URL only.
/// No screenshot, no AX tree, no window list.
fn probe(_req: &Value) -> Result<Value> {
    let skip = |mut res: Value, why: &str| {
        res["skipped"] = json!(why);
        Ok(res)
    };
    let mut res = json!({});
    if let Some(why) = os::preflight() {
        return skip(res, why);
    }
    if os::session_locked() {
        return skip(res, "locked");
    }
    let Some(fg) = os::foreground() else {
        return skip(res, "no_frontmost_app");
    };
    res["app"] = json!({"pid": fg.pid, "bundle_id": fg.bundle_id, "aliases": fg.aliases, "name": fg.name});
    if is_own(&fg.bundle_id, &fg.aliases, &[]) {
        return skip(res, "self_on_screen");
    }
    res["title"] = json!(fg.title);
    if let Some(u) = os::browser_url(&fg) {
        res["url"] = json!(u);
    }
    Ok(res)
}

fn capture(req: &Value) -> Result<Value> {
    if req.get("all_displays").and_then(Value::as_bool) == Some(true) {
        return capture_all(req);
    }
    if req.get("_test_window_pid").is_some() {
        bail!("synthetic window capture scope is macOS-only");
    }
    let t0 = Instant::now();
    let out = req.get("out").and_then(Value::as_str);
    let (max_width, max_height) = max_size(req);
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.8);
    let mut excluded: Vec<String> = req
        .get("exclude_bundle_ids")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_lowercase))
                .collect()
        })
        .unwrap_or_default();
    excluded.extend(ALWAYS_EXCLUDED.iter().map(|s| s.to_string()));
    let excluded_domains: Vec<String> = req
        .get("exclude_domains")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let exclude_private = req
        .get("exclude_private")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let record_unknown = req
        .get("record_unknown")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include = Include::from_request(req);
    let want_ax = req.get("ax").and_then(Value::as_bool).unwrap_or(false);
    let ax_depth = req
        .get("ax_max_depth")
        .and_then(Value::as_u64)
        .unwrap_or(40) as usize;
    let ax_nodes = req
        .get("ax_max_nodes")
        .and_then(Value::as_u64)
        .unwrap_or(4000) as usize;

    let idle = os::idle_seconds();
    let mut res = json!({"idle_seconds": idle});
    let skip = |mut res: Value, why: &str| {
        res["skipped"] = json!(why);
        Ok(res)
    };
    if let Some(why) = os::preflight() {
        return skip(res, why);
    }
    if os::session_locked() {
        return skip(res, "locked");
    }
    // Input idleness never stops capture (reading and watching record too): it marks the frame.
    if let Some(after) = req
        .get("inactive_after_seconds")
        .or(req.get("max_idle_seconds"))
        .and_then(Value::as_f64)
    {
        if after > 0.0 && idle > after {
            res["inactive"] = json!(true);
        }
    }
    let Some(fg) = os::foreground() else {
        return skip(res, "no_frontmost_app");
    };
    res["app"] = json!({"pid": fg.pid, "bundle_id": fg.bundle_id, "aliases": fg.aliases, "name": fg.name, "version": fg.version});
    let fg_id = fg.bundle_id.to_lowercase();
    if fg_id.is_empty() && !record_unknown {
        return skip(res, "unknown_bundle");
    }
    if app_listed(&excluded, &fg_id, &fg.aliases) {
        return skip(res, "excluded_app");
    }
    if is_own(&fg_id, &fg.aliases, &[]) {
        return skip(res, "self_on_screen");
    }

    let url = os::browser_url(&fg);
    res["title"] = json!(fg.title);
    if let Some(u) = &url {
        res["url"] = json!(u);
    }
    if let Some(r) = fg.rect {
        res["focused_window"] = r.json();
    }
    if exclude_private && looks_private(&fg.title) {
        return skip(res, "private_browsing");
    }
    if url
        .as_deref()
        .is_some_and(|u| url_excluded(u, &excluded_domains))
    {
        return skip(res, "excluded_domain");
    }
    if !include.allows(&fg_id, &fg.aliases, url.as_deref()) {
        return skip(res, "not_included");
    }
    if want_ax {
        if let Some(ax) = os::ax_tree(&fg, ax_depth, ax_nodes) {
            res["ax_tree"] = ax.tree;
            res["ax_node_count"] = json!(ax.node_count);
            res["ax_partial"] = json!(ax.partial);
        }
    }

    let windows = os::windows(&fg);
    let Some(out) = out else {
        res["windows"] = windows_json(&windows);
        return Ok(res);
    };

    let mut shot = os::screenshot(fg.rect).map_err(|e| anyhow!("capture_failed: {e:#}"))?;
    let hide = |w: &WinInfo| {
        app_listed(&excluded, &w.bundle_id, &w.aliases) || is_own(&w.bundle_id, &w.aliases, &[])
    };
    redact(&mut shot.image, &shot.display.rect, &windows, &hide);
    let image = fit(shot.image, max_width, max_height);
    if req.get("cmd").and_then(Value::as_str) == Some("capture_private") {
        let rgba = DynamicImage::ImageRgb8(image.clone()).to_rgba8();
        res["boxes"] = recognize_image("", &rgba, req)?;
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut bytes,
            (quality.clamp(0.0, 1.0) * 100.0) as u8,
        )
        .encode_image(&DynamicImage::ImageRgb8(image.clone()))?;
        res["image_base64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        res["privacy_capture"] = json!(true);
    } else {
        ensure_parent(out)?;
        write_jpeg(&DynamicImage::ImageRgb8(image.clone()), out, quality)?;
    }
    res["windows"] = windows_json(&windows);
    res["path"] = json!(out);
    res["width"] = json!(image.width());
    res["height"] = json!(image.height());
    res["display"] = json!({"id": shot.display.id, "x": shot.display.rect.x, "y": shot.display.rect.y, "w": shot.display.rect.w, "h": shot.display.rect.h});
    res["dhash"] = json!(dhash(&image));
    res["elapsed_ms"] = json!(t0.elapsed().as_millis() as u64);
    Ok(res)
}

/// Every connected display, each tick: the display holding the focused window
/// first; another display only skips encoding while its content hash equals
/// `unchanged[<id>]`. Excluded apps, private windows and excluded websites are
/// painted out window by window on every display; a display a hidden window
/// fully covers writes nothing. Idleness only marks the capture inactive.
/// A browser window's URL is known for the focused window only here: excluded
/// websites in unfocused windows are matched on the focused window alone.
fn capture_all(req: &Value) -> Result<Value> {
    let t0 = Instant::now();
    let out = req.get("out").and_then(Value::as_str).unwrap_or("");
    let (max_width, max_height) = max_size(req);
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.8);
    let strings = |k: &str| -> Vec<String> {
        req.get(k)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_lowercase))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut excluded = strings("exclude_bundle_ids");
    excluded.extend(ALWAYS_EXCLUDED.iter().map(|s| s.to_string()));
    let excluded_domains = strings("exclude_domains");
    let exclude_private = req
        .get("exclude_private")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let record_unknown = req
        .get("record_unknown")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include = Include::from_request(req);
    let want_ax = req.get("ax").and_then(Value::as_bool).unwrap_or(false);
    let private = req.get("cmd").and_then(Value::as_str) == Some("capture_private");
    let unchanged = req.get("unchanged").cloned().unwrap_or(Value::Null);

    let idle = os::idle_seconds();
    let mut res = json!({"idle_seconds": idle});
    if let Some(after) = req.get("inactive_after_seconds").and_then(Value::as_f64) {
        if after > 0.0 && idle > after {
            res["inactive"] = json!(true);
        }
    }
    if let Some(why) = os::preflight() {
        res["skipped"] = json!(why);
        return Ok(res);
    }
    if os::session_locked() {
        res["skipped"] = json!("locked");
        return Ok(res);
    }
    let own = strings("own_bundle_ids");
    let excluded_app =
        |b: &str, aliases: &[String]| app_listed(&excluded, b, aliases) || is_own(b, aliases, &own);
    let fg = os::foreground();
    let fg_url = fg.as_ref().and_then(os::browser_url);
    if let Some(fg) = &fg {
        let id = fg.bundle_id.to_lowercase();
        let hidden = excluded_app(&id, &fg.aliases)
            || (id.is_empty() && !record_unknown)
            || (exclude_private && looks_private(&fg.title))
            || fg_url
                .as_deref()
                .is_some_and(|u| url_excluded(u, &excluded_domains))
            || !include.allows(&id, &fg.aliases, fg_url.as_deref());
        if !hidden {
            res["app"] = json!({"pid": fg.pid, "bundle_id": fg.bundle_id, "aliases": fg.aliases, "name": fg.name, "version": fg.version});
            res["title"] = json!(fg.title);
            if let Some(u) = &fg_url {
                res["url"] = json!(u);
            }
            if let Some(r) = fg.rect {
                res["focused_window"] = r.json();
            }
            if want_ax {
                let depth = req
                    .get("ax_max_depth")
                    .and_then(Value::as_u64)
                    .unwrap_or(40) as usize;
                let nodes = req
                    .get("ax_max_nodes")
                    .and_then(Value::as_u64)
                    .unwrap_or(4000) as usize;
                if let Some(ax) = os::ax_tree(fg, depth, nodes) {
                    res["ax_tree"] = ax.tree;
                    res["ax_node_count"] = json!(ax.node_count);
                    res["ax_partial"] = json!(ax.partial);
                }
            }
        }
    }
    let windows = fg.as_ref().map(os::windows).unwrap_or_default();
    let mut displays = os::displays();
    if displays.is_empty() {
        bail!("capture_failed: no_display");
    }
    // The display holding most of the focused window, else the primary, goes first.
    let overlap = |d: &DisplayInfo| {
        fg.as_ref()
            .and_then(|f| f.rect)
            .and_then(|r| r.intersect(&d.rect))
            .map_or(0, |i| i.w as i64 * i.h as i64)
    };
    let focused_id = displays
        .iter()
        .filter(|d| overlap(d) > 0)
        .max_by_key(|d| overlap(d))
        .or_else(|| displays.iter().find(|d| d.main))
        .map(|d| d.id)
        .unwrap_or(displays[0].id);
    displays.sort_by_key(|d| d.id != focused_id);
    // `only_focused`: a capture a focus change pulled forward records the active display only.
    if req.get("only_focused").and_then(Value::as_bool) == Some(true) {
        displays.truncate(1);
    }
    let fg_window = fg.as_ref().map(|f| f.id);
    let url_of = |w: &WinInfo| (Some(w.id) == fg_window).then(|| fg_url.clone()).flatten();
    let plan = plan_displays(
        &windows,
        &displays,
        &url_of,
        &excluded_app,
        &excluded_domains,
        exclude_private,
        record_unknown,
        &include,
    );
    let visible: Vec<&WinInfo> = windows
        .iter()
        .filter(|w| !plan.hidden.contains(&w.id))
        .collect();
    res["windows"] = windows_json(&visible.iter().map(|w| (*w).clone()).collect::<Vec<_>>());
    let stem = out.strip_suffix(".jpg").unwrap_or(out);
    let mut entries = Vec::new();
    let mut timings = Vec::new();
    for d in &displays {
        let t = Instant::now();
        let mut entry = json!({"display": {
            "id": d.id, "name": d.name, "x": d.rect.x, "y": d.rect.y, "w": d.rect.w, "h": d.rect.h,
            "scale": d.scale, "main": d.main, "focused": d.id == focused_id,
        }});
        if plan.covered.contains(&d.id) {
            entry["skipped"] = json!("excluded");
        } else {
            let mut image =
                os::screenshot_display(d).map_err(|e| anyhow!("capture_failed: {e:#}"))?;
            redact(&mut image, &d.rect, &windows, &|w| {
                plan.hidden.contains(&w.id)
            });
            let image = fit(image, max_width, max_height);
            let hash = content_hash(&image);
            entry["content_hash"] = json!(hash);
            if unchanged.get(d.id.to_string()).and_then(Value::as_str) == Some(hash.as_str()) {
                entry["unchanged"] = json!(true);
            } else {
                let path = format!("{stem}_d{}.jpg", d.id);
                if private {
                    let rgba = DynamicImage::ImageRgb8(image.clone()).to_rgba8();
                    entry["boxes"] = recognize_image("", &rgba, req)?;
                    let mut bytes = Vec::new();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(
                        &mut bytes,
                        (quality.clamp(0.0, 1.0) * 100.0) as u8,
                    )
                    .encode_image(&DynamicImage::ImageRgb8(image.clone()))?;
                    entry["image_base64"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(bytes));
                    entry["privacy_capture"] = json!(true);
                } else {
                    ensure_parent(&path)?;
                    write_jpeg(&DynamicImage::ImageRgb8(image.clone()), &path, quality)?;
                }
                entry["path"] = json!(path);
                entry["width"] = json!(image.width());
                entry["height"] = json!(image.height());
                entry["dhash"] = json!(dhash(&image));
                if let Some(w) = plan.top.get(&d.id) {
                    entry["app"] =
                        json!({"pid": w.pid, "bundle_id": w.bundle_id, "name": w.app_name});
                    entry["title"] = json!(w.title);
                    if let Some(u) = url_of(w) {
                        entry["url"] = json!(u);
                    }
                }
            }
        }
        let ms = t.elapsed().as_millis() as u64;
        entry["elapsed_ms"] = json!(ms);
        timings.push(json!({"id": d.id, "ms": ms}));
        entries.push(entry);
    }
    res["displays"] = Value::Array(entries);
    res["timings"] = Value::Array(timings);
    res["elapsed_ms"] = json!(t0.elapsed().as_millis() as u64);
    Ok(res)
}

fn windows_json(windows: &[WinInfo]) -> Value {
    Value::Array(
        windows
            .iter()
            .enumerate()
            .map(|(z, w)| {
                json!({
                    "pid": w.pid, "bundle_id": w.bundle_id, "app_name": w.app_name, "title": w.title,
                    "x": w.rect.x, "y": w.rect.y, "w": w.rect.w, "h": w.rect.h,
                    "layer": 0, "z": z, "focused": w.focused,
                })
            })
            .collect(),
    )
}

/// `a` minus `cut` as up to four rectangles.
fn subtract(a: Rect, cut: &Rect) -> Vec<Rect> {
    let Some(i) = a.intersect(cut) else {
        return vec![a];
    };
    let mut out = Vec::with_capacity(4);
    if i.y > a.y {
        out.push(Rect {
            x: a.x,
            y: a.y,
            w: a.w,
            h: i.y - a.y,
        });
    }
    if i.bottom() < a.bottom() {
        out.push(Rect {
            x: a.x,
            y: i.bottom(),
            w: a.w,
            h: a.bottom() - i.bottom(),
        });
    }
    if i.x > a.x {
        out.push(Rect {
            x: a.x,
            y: i.y,
            w: i.x - a.x,
            h: i.h,
        });
    }
    if i.right() < a.right() {
        out.push(Rect {
            x: i.right(),
            y: i.y,
            w: a.right() - i.right(),
            h: i.h,
        });
    }
    out
}

/// Paint hidden windows black where they are visible. `windows` is ordered
/// top of the z-order first, so only windows earlier in the list can cover a
/// later one. Window rectangles approximate the visible shape (rounded
/// corners and transparency are not modelled).
pub fn redact(
    image: &mut RgbImage,
    display: &Rect,
    windows: &[WinInfo],
    hide: &dyn Fn(&WinInfo) -> bool,
) {
    for (i, w) in windows.iter().enumerate() {
        if !hide(w) {
            continue;
        }
        let Some(r) = w.rect.intersect(display) else {
            continue;
        };
        let mut visible = vec![r];
        for above in &windows[..i] {
            visible = visible
                .into_iter()
                .flat_map(|v| subtract(v, &above.rect))
                .collect();
            if visible.is_empty() {
                break;
            }
        }
        for v in visible {
            for y in (v.y - display.y)..(v.bottom() - display.y) {
                for x in (v.x - display.x)..(v.right() - display.x) {
                    if (x as u32) < image.width() && (y as u32) < image.height() {
                        image.put_pixel(x as u32, y as u32, image::Rgb([0, 0, 0]));
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------- image

/// The request's `max_width` x `max_height` box (default 2560 x 1440; 0 = no limit).
fn max_size(req: &Value) -> (u32, u32) {
    let get = |k: &str, d: u64| req.get(k).and_then(Value::as_u64).unwrap_or(d) as u32;
    (get("max_width", 2560), get("max_height", 1440))
}

/// Scale `img` down to fit inside `max_width` x `max_height`, keeping its aspect
/// ratio; never enlarge. A 0 limit leaves that dimension unbounded.
pub fn fit(img: RgbImage, max_width: u32, max_height: u32) -> RgbImage {
    let ratio = |max: u32, have: u32| {
        if max == 0 {
            1.0
        } else {
            (max as f64 / have as f64).min(1.0)
        }
    };
    let scale = ratio(max_width, img.width()).min(ratio(max_height, img.height()));
    if scale >= 1.0 {
        return img;
    }
    let w = ((img.width() as f64 * scale).round() as u32).max(2);
    let h = ((img.height() as f64 * scale).round() as u32).max(2);
    image::imageops::resize(&img, w, h, FilterType::Triangle)
}

pub fn write_jpeg(img: &DynamicImage, path: &str, quality: f64) -> Result<()> {
    let q = (quality * 100.0).round().clamp(1.0, 100.0) as u8;
    let file = std::fs::File::create(path).with_context(|| format!("create {path}"))?;
    let mut enc =
        image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), q);
    enc.encode_image(&DynamicImage::ImageRgb8(img.to_rgb8()))
        .context("jpeg_write")
}

fn write_image(img: &DynamicImage, path: &str, quality: f64) -> Result<()> {
    ensure_parent(path)?;
    let l = path.to_lowercase();
    if l.ends_with(".jpg") || l.ends_with(".jpeg") {
        write_jpeg(img, path, quality)
    } else {
        img.save_with_format(path, image::ImageFormat::Png)
            .context("png_write")
    }
}

/// 64-bit difference hash over a 9x8 grayscale thumbnail, hex encoded.
pub fn dhash(img: &RgbImage) -> String {
    let small =
        image::imageops::resize(&image::imageops::grayscale(img), 9, 8, FilterType::Triangle);
    let mut bits: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            bits <<= 1;
            if small.get_pixel(x, y).0[0] > small.get_pixel(x + 1, y).0[0] {
                bits |= 1;
            }
        }
    }
    format!("{bits:016x}")
}

fn crop_arg(req: &Value, img: DynamicImage) -> DynamicImage {
    let c = req.get("crop");
    let g = |k: &str| c.and_then(|c| c.get(k)).and_then(Value::as_i64);
    let (Some(x), Some(y), Some(w), Some(h)) = (g("x"), g("y"), g("w"), g("h")) else {
        return img;
    };
    let x0 = x.clamp(0, img.width() as i64);
    let y0 = y.clamp(0, img.height() as i64);
    let x1 = (x + w).clamp(0, img.width() as i64);
    let y1 = (y + h).clamp(0, img.height() as i64);
    if x1 <= x0 || y1 <= y0 {
        return img;
    }
    img.crop_imm(x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32)
}

fn average_color(img: &RgbaImage) -> i64 {
    let (mut r, mut g, mut b, mut a) = (0u64, 0u64, 0u64, 0u64);
    for p in img.pixels() {
        let al = p.0[3] as u64;
        r += p.0[0] as u64 * al;
        g += p.0[1] as u64 * al;
        b += p.0[2] as u64 * al;
        a += al;
    }
    if a == 0 {
        return 0;
    }
    (((r / a) << 16) | ((g / a) << 8) | (b / a)) as i64
}

// ---------------------------------------------------------------- commands

fn ocr(req: &Value) -> Result<Value> {
    let t0 = Instant::now();
    let path = str_arg(req, "path").map_err(|_| anyhow!("image_not_found"))?;
    let img = image::open(path)
        .map_err(|_| anyhow!("image_not_found"))?
        .to_rgba8();
    let boxes = recognize_image(path, &img, req)?;
    // Incremental OCR is macOS-only; Windows/Linux always run a full pass.
    Ok(
        json!({"boxes": boxes, "mode": "full", "changed_fraction": 1.0, "width": img.width(), "height": img.height(), "elapsed_ms": t0.elapsed().as_millis() as u64}),
    )
}

fn recognize_image(path: &str, img: &RgbaImage, req: &Value) -> Result<Value> {
    let level = req
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or("accurate");
    let langs: Vec<String> = req
        .get("languages")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let words = os::ocr(path, img, level, &langs).map_err(|e| anyhow!("ocr_failed: {e:#}"))?;
    let boxes: Vec<Value> = group_words(words)
        .into_iter()
        .map(|w| json!({"x": w.rect.x, "y": w.rect.y, "w": w.rect.w, "h": w.rect.h, "text": w.text, "confidence": w.confidence}))
        .collect();
    Ok(Value::Array(boxes))
}

/// Merge words into line boxes like the macOS engine's line observations.
/// Words join while they sit on one text line and the gap between them stays
/// below 1.5 line heights, so two columns (or two windows side by side) stay
/// separate boxes and the recorder can place each box in or out of the focused
/// window.
pub fn group_words(mut words: Vec<Word>) -> Vec<Word> {
    words.retain(|w| !w.text.trim().is_empty() && w.rect.w > 0 && w.rect.h > 0);
    let mut out: Vec<Word> = Vec::new();
    // (count, confidence sum) for the box being built.
    let mut cur: Option<(Word, usize, f64)> = None;
    let flush = |cur: &mut Option<(Word, usize, f64)>, out: &mut Vec<Word>| {
        if let Some((mut w, n, sum)) = cur.take() {
            w.confidence = sum / n as f64;
            out.push(w);
        }
    };
    for w in words {
        let joins = match &cur {
            Some((c, _, _)) => {
                let same_line = (w.rect.y + w.rect.h / 2 - (c.rect.y + c.rect.h / 2)).abs()
                    <= c.rect.h.max(w.rect.h) / 2;
                let gap = w.rect.x - c.rect.right();
                same_line
                    && gap >= -(c.rect.h / 2)
                    && gap as f64 <= 1.5 * c.rect.h.max(w.rect.h) as f64
            }
            None => false,
        };
        if joins {
            let (c, n, sum) = cur.as_mut().expect("joins implies cur");
            let x = c.rect.x.min(w.rect.x);
            let y = c.rect.y.min(w.rect.y);
            let r = c.rect.right().max(w.rect.right());
            let b = c.rect.bottom().max(w.rect.bottom());
            c.rect = Rect {
                x,
                y,
                w: r - x,
                h: b - y,
            };
            c.text.push(' ');
            c.text.push_str(w.text.trim());
            *n += 1;
            *sum += w.confidence;
        } else {
            flush(&mut cur, &mut out);
            let conf = w.confidence;
            let mut w = w;
            w.text = w.text.trim().to_string();
            cur = Some((w, 1, conf));
        }
    }
    flush(&mut cur, &mut out);
    out
}

fn icon(req: &Value) -> Result<Value> {
    let bundle_id = str_arg(req, "bundle_id")?;
    let out = str_arg(req, "out")?;
    let size = req.get("size").and_then(Value::as_u64).unwrap_or(64) as u32;
    let icon = os::icon(bundle_id, size)?;
    ensure_parent(out)?;
    DynamicImage::ImageRgba8(icon.image.clone())
        .save_with_format(out, image::ImageFormat::Png)
        .map_err(|_| anyhow!("icon_write"))?;
    Ok(
        json!({"path": out, "dominant_color": average_color(&icon.image), "display_name": icon.display_name}),
    )
}

/// Encode staged frames into one 1 fps MP4 (frame i at t = i s).
fn encode(req: &Value) -> Result<Value> {
    let inputs: Vec<String> = req
        .get("inputs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let out = str_arg(req, "out")?;
    let width = req
        .get("width")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("bad_request"))? as u32;
    let height = req
        .get("height")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("bad_request"))? as u32;
    if inputs.is_empty() {
        bail!("bad_request");
    }
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.5);
    ensure_parent(out)?;
    let _ = std::fs::remove_file(out);
    // H.264 needs even dimensions.
    let frames = os::encode(
        &inputs,
        out,
        (width & !1).max(2),
        (height & !1).max(2),
        quality,
    )
    .map_err(|e| anyhow!("encode_failed: {e:#}"))?;
    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    Ok(json!({"path": out, "frames": frames, "size_bytes": size}))
}

/// Raw PCM (16 kHz mono s16le) -> AAC in M4A.
fn encode_audio(req: &Value) -> Result<Value> {
    let input = str_arg(req, "input")?;
    let out = str_arg(req, "out")?;
    let rate = req
        .get("sample_rate")
        .and_then(Value::as_u64)
        .unwrap_or(16_000) as u32;
    let bitrate = req.get("bitrate").and_then(Value::as_u64).unwrap_or(32_000) as u32;
    ensure_parent(out)?;
    let _ = std::fs::remove_file(out);
    os::encode_audio(input, out, rate, bitrate)
        .map_err(|e| anyhow!("encode_audio_failed: {e:#}"))?;
    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    let pcm = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    Ok(json!({"path": out, "size_bytes": size, "duration_ms": pcm / 2 * 1000 / rate as u64}))
}

fn extract(req: &Value) -> Result<Value> {
    let video = str_arg(req, "video")?;
    let index = req
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("bad_request"))? as usize;
    let out = str_arg(req, "out")?;
    let frame = os::extract_frame(video, index).map_err(|e| anyhow!("extract_failed: {e:#}"))?;
    let img = crop_arg(req, DynamicImage::ImageRgb8(frame));
    write_image(
        &img,
        out,
        req.get("quality").and_then(Value::as_f64).unwrap_or(0.85),
    )?;
    Ok(json!({"path": out, "width": img.width(), "height": img.height()}))
}

fn image_color(req: &Value) -> Result<Value> {
    let path = str_arg(req, "path").map_err(|_| anyhow!("image_not_found"))?;
    let img = image::open(path)
        .map_err(|_| anyhow!("image_not_found"))?
        .to_rgba8();
    Ok(json!({"dominant_color": average_color(&img), "width": img.width(), "height": img.height()}))
}

fn convert(req: &Value) -> Result<Value> {
    let path = str_arg(req, "path")?;
    let out = str_arg(req, "out")?;
    let img = image::open(path).map_err(|_| anyhow!("bad_request"))?;
    let img = crop_arg(req, img);
    write_image(&img, out, 0.85).map_err(|_| anyhow!("convert_failed"))?;
    Ok(json!({"path": out, "width": img.width(), "height": img.height()}))
}

/// Re-encode a chunk at a smaller scale (storage "downscale" action).
fn transcode(req: &Value) -> Result<Value> {
    let video = str_arg(req, "video")?;
    let out = str_arg(req, "out")?;
    let frames = req
        .get("frames")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("bad_request"))? as usize;
    let scale = req.get("scale").and_then(Value::as_f64).unwrap_or(0.5);
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.4);
    let tmp = std::env::temp_dir().join(format!("kce-{}-{}", std::process::id(), rand_tag()));
    std::fs::create_dir_all(&tmp)?;
    let result = (|| -> Result<Value> {
        let paths = os::extract_all(video, frames, &tmp)
            .map_err(|e| anyhow!("transcode_read_failed: {e:#}"))?;
        if paths.len() != frames {
            bail!("transcode_read_failed: {}/{}", paths.len(), frames);
        }
        let first = image::image_dimensions(&paths[0]).context("transcode_read_failed")?;
        let w = (((first.0 as f64 * scale) as u32) & !1).max(2);
        let h = (((first.1 as f64 * scale) as u32) & !1).max(2);
        let inputs: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let _ = std::fs::remove_file(out);
        ensure_parent(out)?;
        let written =
            os::encode(&inputs, out, w, h, quality).map_err(|e| anyhow!("encode_failed: {e:#}"))?;
        let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
        Ok(json!({"path": out, "frames": written, "size_bytes": size, "width": w, "height": h}))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn rand_tag() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Decode `path` and fit it to exactly `w` x `h` (stretch; sizes match in practice).
pub fn load_rgb_fit(path: &str, w: u32, h: u32) -> Result<RgbImage> {
    let img = image::open(path)
        .with_context(|| format!("read {path}"))?
        .to_rgb8();
    if img.width() == w && img.height() == h {
        Ok(img)
    } else {
        Ok(image::imageops::resize(&img, w, h, FilterType::Triangle))
    }
}

/// Shared JSON helper for permission payloads.
pub fn permissions_json(screen: bool, accessibility: bool) -> Value {
    let mut m = Map::new();
    m.insert("screen".into(), json!(screen));
    m.insert("accessibility".into(), json!(accessibility));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    #[test]
    fn fit_keeps_the_aspect_inside_both_limits_and_never_enlarges() {
        let img = |w, h| image::RgbImage::new(w, h);
        let dims = |i: image::RgbImage| (i.width(), i.height());
        // 4K into 1440p: height bound.
        assert_eq!(dims(super::fit(img(3840, 2160), 2560, 1440)), (2560, 1440));
        // Ultrawide 5120x1440: width bound (height alone used to leave it at 5120).
        assert_eq!(dims(super::fit(img(5120, 1440), 2560, 1440)), (2560, 720));
        // Portrait monitor.
        assert_eq!(dims(super::fit(img(1440, 2560), 2560, 1440)), (810, 1440));
        // Smaller than the box, or no limit: unchanged.
        assert_eq!(dims(super::fit(img(1280, 720), 2560, 1440)), (1280, 720));
        assert_eq!(dims(super::fit(img(5120, 1440), 0, 0)), (5120, 1440));
        assert_eq!(dims(super::fit(img(5120, 1440), 0, 720)), (2560, 720));
        assert_eq!(
            super::max_size(&serde_json::json!({"max_width": 1920, "max_height": 1080})),
            (1920, 1080)
        );
        assert_eq!(super::max_size(&serde_json::json!({})), (2560, 1440));
    }

    use super::*;

    fn win(id: u64, bundle: &str, x: i32, y: i32, w: i32, h: i32) -> WinInfo {
        WinInfo {
            id,
            pid: 1,
            bundle_id: bundle.into(),
            aliases: Vec::new(),
            app_name: bundle.into(),
            title: String::new(),
            rect: Rect { x, y, w, h },
            focused: false,
        }
    }

    fn titled(mut w: WinInfo, title: &str) -> WinInfo {
        w.title = title.into();
        w
    }

    #[test]
    fn every_display_plans_its_hidden_windows_coverage_and_top_window() {
        let displays = [
            DisplayInfo {
                id: 1,
                rect: Rect {
                    x: 0,
                    y: 0,
                    w: 1920,
                    h: 1080,
                },
                name: "DISPLAY1".into(),
                main: true,
                scale: 1.0,
            },
            DisplayInfo {
                id: 2,
                rect: Rect {
                    x: 1920,
                    y: 0,
                    w: 2560,
                    h: 1440,
                },
                name: "DISPLAY2".into(),
                main: false,
                scale: 1.0,
            },
        ];
        // Front to back.
        let windows = vec![
            titled(
                win(10, "msedge.exe", 0, 0, 1920, 1080),
                "Notes - InPrivate - Microsoft Edge",
            ),
            titled(win(20, "1password.exe", 2000, 0, 600, 400), "Vault"),
            titled(win(25, "kortix.exe", 2050, 0, 500, 300), "Kortix Capture"),
            titled(win(30, "slack.exe", 2100, 0, 1600, 1400), "general"),
            titled(win(40, "chrome.exe", 1920, 0, 2560, 1440), "Statement"),
        ];
        let url = |w: &WinInfo| (w.id == 40).then(|| "https://login.bank.example/s".to_string());
        let own = vec!["kortix.exe".to_string()];
        let excluded = |bundle: &str, aliases: &[String]| {
            bundle == "1password.exe" || is_own(bundle, aliases, &own)
        };
        let plan = plan_displays(
            &windows,
            &displays,
            &url,
            &excluded,
            &["bank.example".into()],
            true,
            false,
            &Include::default(),
        );
        let mut hidden: Vec<u64> = plan.hidden.iter().copied().collect();
        hidden.sort();
        assert_eq!(
            hidden,
            [10, 20, 25, 40],
            "Kortix's own windows are never recorded"
        );
        assert!(
            plan.covered.contains(&1),
            "a private window filling a display: no frame of it"
        );
        assert!(
            !plan.covered.contains(&2),
            "a hidden window behind a visible one covers nothing"
        );
        assert_eq!(
            plan.top.get(&2).map(|w| w.bundle_id.as_str()),
            Some("slack.exe")
        );

        // Record only included: Slack (an app) and github.com (a website) only.
        let include = Include {
            on: true,
            apps: vec!["slack.exe".into()],
            domains: vec!["github.com".into()],
        };
        let gh = |w: &WinInfo| (w.id == 40).then(|| "https://github.com/kortix-ai".to_string());
        let plan = plan_displays(&windows, &displays, &gh, &excluded, &[], true, false, &include);
        let mut hidden: Vec<u64> = plan.hidden.iter().copied().collect();
        hidden.sort();
        assert_eq!(hidden, [10, 20, 25], "not included, excluded or own: hidden");
        assert!(plan.covered.contains(&1), "no included window on a display: no frame");
        assert_eq!(plan.top.get(&2).map(|w| w.id), Some(30));
        let plan = plan_displays(&windows, &displays, &url, &excluded, &[], true, false, &include);
        assert!(
            plan.hidden.contains(&40),
            "a website not included is hidden, even in a browser"
        );
        let slack_excluded = |b: &str, _: &[String]| b == "slack.exe";
        let plan = plan_displays(&windows, &displays, &gh, &slack_excluded, &[], true, false, &include);
        assert!(plan.hidden.contains(&30), "an exclusion wins over an inclusion");
    }

    /// Per-window masking and inclusion use the same identifiers as the front app:
    /// a packaged Windows 11 Notepad beside the focused window.
    #[test]
    fn a_packaged_windows_app_is_masked_and_included_by_its_exe_name() {
        let display = [DisplayInfo {
            id: 1,
            rect: Rect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            },
            name: "DISPLAY1".into(),
            main: true,
            scale: 1.0,
        }];
        let aumid = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
        let mut edge = win(1, "msedge.exe", 0, 0, 960, 1080);
        edge.aliases = vec!["msedge.exe".into(), "Microsoft Edge".into()];
        edge.focused = true;
        let mut notepad = win(2, aumid, 960, 0, 960, 1080);
        notepad.aliases = packaged_aliases(aumid);
        notepad.aliases.extend(["notepad.exe".into(), "Notepad".into()]);
        let windows = vec![edge, notepad];
        let no_url = |_: &WinInfo| None;
        let listed = vec!["notepad.exe".to_string()];
        let excluded = |b: &str, aliases: &[String]| app_listed(&listed, b, aliases);
        let plan = plan_displays(
            &windows,
            &display,
            &no_url,
            &excluded,
            &[],
            true,
            false,
            &Include::default(),
        );
        assert_eq!(
            plan.hidden.iter().copied().collect::<Vec<_>>(),
            [2],
            "masked while not in front"
        );
        assert_eq!(plan.top.get(&1).map(|w| w.id), Some(1));

        let none = |_: &str, _: &[String]| false;
        for entry in ["notepad.exe", "Microsoft.WindowsNotepad", aumid] {
            let include = Include {
                on: true,
                apps: vec![entry.to_lowercase()],
                domains: vec![],
            };
            let plan = plan_displays(&windows, &display, &no_url, &none, &[], true, false, &include);
            assert_eq!(
                plan.hidden.iter().copied().collect::<Vec<_>>(),
                [1],
                "{entry}: only Notepad"
            );
        }
        // Kortix's own executables, packaged or not.
        assert!(is_own("Kortix.Capture_x!App", &["kortix-capture.exe".into()], &[]));
        assert!(!is_own("msedge.exe", &["msedge.exe".into()], &[]));
    }

    #[test]
    fn a_linux_process_is_also_named_by_its_executable_snap_flatpak_and_appimage() {
        assert_eq!(process_aliases("/usr/bin/gnome-text-editor", "0::/user.slice", b""), ["gnome-text-editor"]);
        assert_eq!(
            process_aliases("/snap/firefox/4793/usr/lib/firefox/firefox", "", b""),
            ["firefox", "firefox"]
        );
        assert_eq!(
            process_aliases(
                "/app/bin/gnome-text-editor",
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-org.gnome.TextEditor-12345.scope\n",
                b""
            ),
            ["gnome-text-editor", "org.gnome.TextEditor"]
        );
        assert_eq!(
            process_aliases(
                "/tmp/.mount_FreeCAD/usr/bin/freecad (deleted)",
                "",
                b"HOME=/home/u\0APPIMAGE=/home/u/Apps/FreeCAD.AppImage\0"
            ),
            ["freecad", "FreeCAD.AppImage"]
        );
        let aliases = process_aliases("/app/bin/x", "0::/app-flatpak-org.gnome.TextEditor-1.scope", b"");
        assert!(app_listed(&["org.gnome.texteditor".into()], "gnome-text-editor", &aliases));
        assert!(app_listed(&["freecad".into()], "", &process_aliases("/x", "", b"APPIMAGE=/a/FreeCAD.AppImage")));
    }

    #[test]
    fn a_packaged_app_is_also_named_by_its_package() {
        assert_eq!(
            packaged_aliases("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"),
            ["Microsoft.WindowsNotepad_8wekyb3d8bbwe", "Microsoft.WindowsNotepad"]
        );
        assert!(packaged_aliases("notepad.exe").is_empty());
    }

    #[test]
    fn the_content_hash_changes_with_any_visible_change_and_only_then() {
        let a = RgbImage::from_pixel(3440, 1440, image::Rgb([20, 20, 20]));
        let mut b = a.clone();
        assert_eq!(content_hash(&a), content_hash(&b));
        // One small line of text changes in a corner of an ultrawide display.
        for x in 3000..3060 {
            for y in 1400..1412 {
                b.put_pixel(x, y, image::Rgb([240, 240, 240]));
            }
        }
        assert_ne!(content_hash(&a), content_hash(&b));
    }

    #[test]
    fn private_markers() {
        assert!(looks_private("New Incognito tab - Google Chrome"));
        assert!(looks_private("Bing - InPrivate - Microsoft Edge"));
        assert!(!looks_private("Quarterly report - Word"));
    }

    #[test]
    fn redact_paints_only_visible_part() {
        // Hidden window 0..100 wide, covered on the right half by a top window.
        let mut img = RgbImage::from_pixel(100, 100, image::Rgb([255, 255, 255]));
        let windows = vec![
            win(1, "top.exe", 50, 0, 50, 100),
            win(2, "secret.exe", 0, 0, 100, 100),
        ];
        redact(
            &mut img,
            &Rect {
                x: 0,
                y: 0,
                w: 100,
                h: 100,
            },
            &windows,
            &|w| w.bundle_id == "secret.exe",
        );
        assert_eq!(img.get_pixel(10, 10).0, [0, 0, 0]);
        assert_eq!(img.get_pixel(90, 90).0, [255, 255, 255]);
    }

    #[test]
    fn words_group_into_columns() {
        let w = |x, text: &str| Word {
            rect: Rect {
                x,
                y: 10,
                w: 40,
                h: 12,
            },
            text: text.into(),
            confidence: 0.9,
        };
        let boxes = group_words(vec![w(0, "hello"), w(45, "world"), w(400, "other")]);
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[0].text, "hello world");
        assert_eq!(boxes[0].rect.w, 85);
    }

    #[test]
    fn dhash_is_stable() {
        let img = RgbImage::from_pixel(64, 64, image::Rgb([10, 10, 10]));
        assert_eq!(dhash(&img), "0000000000000000");
    }

    #[test]
    fn probe_is_a_known_command_and_never_writes_a_screenshot() {
        let res = handle(&json!({"cmd": "probe", "out": "/nonexistent/should-not-be-written.jpg"}));
        assert!(res.get("error").is_none(), "{res}");
        assert!(
            res.get("path").is_none()
                && res.get("windows").is_none()
                && res.get("ax_tree").is_none()
        );
        assert!(!std::path::Path::new("/nonexistent/should-not-be-written.jpg").exists());
    }
}
