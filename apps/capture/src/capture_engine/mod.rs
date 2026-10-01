//! `kortix-capture-engine` for Windows and Linux.
//!
//! Same wire protocol as the macOS Swift sidecar (`native/macos/CaptureEngine.swift`):
//! one JSON request per stdin line, one JSON response per stdout line, `id`
//! echoed, `ok` bool, `error` string on failure. The Rust side
//! (`src/memory/engine.rs`) owns policy, storage and scheduling. This process
//! only touches OS APIs.
//!
//! Commands: ping, permissions, request_permissions, capture, ocr, icon,
//! encode, extract, convert, image_color, transcode.
//!
//! Shared here: the protocol loop, privacy policy, window redaction, image
//! helpers (dhash, crop, resize), OCR word grouping. Per-OS code lives in
//! `win.rs` and `linux.rs`; both export the same free functions.
//!
//! `bundle_id` scheme (stable key for the `application` table):
//! * Windows: the AppUserModelID for packaged (UWP/MSIX) processes, else the
//!   lowercase executable file name, for example `chrome.exe`.
//! * Linux: the lowercase X11 `WM_CLASS` class, for example `firefox`.

use anyhow::{anyhow, bail, Context, Result};
use image::{imageops::FilterType, DynamicImage, RgbImage, RgbaImage};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Instant;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as os;
#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "windows")]
use win as os;

/// Executables of Kortix itself. Capture skips frames while one is focused and
/// paints their windows black.
const OWN_APPS: &[&str] = &[
    "kortix-capture.exe",
    "kortix-capture-engine.exe",
    "kortix-capture",
];
/// Lock screen and secure-desktop hosts: never recorded.
const ALWAYS_EXCLUDED: &[&str] = &["logonui.exe", "lockapp.exe", "consent.exe"];

const PRIVATE_MARKERS: &[&str] = &[
    "private browsing",
    "incognito",
    "inprivate",
    "— private",
    "- private",
    "(private)",
];

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
        (r > x && b > y).then_some(Rect { x, y, w: r - x, h: b - y })
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
    pub name: String,
    pub version: String,
    pub title: String,
    pub rect: Option<Rect>,
}

pub struct WinInfo {
    pub id: u64,
    pub pid: u32,
    pub bundle_id: String,
    pub app_name: String,
    pub title: String,
    pub rect: Rect,
    pub focused: bool,
}

pub struct Display {
    pub id: i64,
    pub rect: Rect,
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
        "capture" => capture(req),
        "ocr" => ocr(req),
        "icon" => icon(req),
        "encode" => encode(req),
        "extract" => extract(req),
        "convert" => convert(req),
        "image_color" => image_color(req),
        "transcode" => transcode(req),
        other => Err(anyhow!("unknown_cmd: {other}")),
    };
    res.unwrap_or_else(|e| fail(format!("{e:#}")))
}

fn str_arg<'a>(req: &'a Value, key: &str) -> Result<&'a str> {
    req.get(key).and_then(Value::as_str).ok_or_else(|| anyhow!("bad_request: missing {key}"))
}

fn ensure_parent(path: &str) -> Result<()> {
    if let Some(dir) = Path::new(path).parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    Ok(())
}

// ----------------------------------------------------------------- privacy

pub fn looks_private(title: &str) -> bool {
    let t = title.to_lowercase();
    PRIVATE_MARKERS.iter().any(|m| t.contains(m))
}

pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?.to_lowercase();
    let host = host.strip_prefix("www.").map(str::to_string).unwrap_or(host);
    (!host.is_empty()).then_some(host)
}

pub fn domain_matches(host: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        let p = p.trim().to_lowercase();
        // Patterns may carry a path (`proton.me/pass`); match on the host part.
        let p = p.split('/').next().unwrap_or("").to_string();
        !p.is_empty() && (host == p || host.ends_with(&format!(".{p}")))
    })
}

// ----------------------------------------------------------------- capture

fn capture(req: &Value) -> Result<Value> {
    let t0 = Instant::now();
    let out = req.get("out").and_then(Value::as_str);
    let max_height = req.get("max_height").and_then(Value::as_u64).unwrap_or(1440) as u32;
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.8);
    let mut excluded: Vec<String> = req
        .get("exclude_bundle_ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_lowercase)).collect())
        .unwrap_or_default();
    excluded.extend(ALWAYS_EXCLUDED.iter().map(|s| s.to_string()));
    let excluded_domains: Vec<String> = req
        .get("exclude_domains")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let exclude_private = req.get("exclude_private").and_then(Value::as_bool).unwrap_or(true);
    let record_unknown = req.get("record_unknown").and_then(Value::as_bool).unwrap_or(false);
    let want_ax = req.get("ax").and_then(Value::as_bool).unwrap_or(false);
    let ax_depth = req.get("ax_max_depth").and_then(Value::as_u64).unwrap_or(40) as usize;
    let ax_nodes = req.get("ax_max_nodes").and_then(Value::as_u64).unwrap_or(4000) as usize;

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
    if let Some(max_idle) = req.get("max_idle_seconds").and_then(Value::as_f64) {
        if max_idle > 0.0 && idle > max_idle {
            return skip(res, "inactive");
        }
    }
    let Some(fg) = os::foreground() else {
        return skip(res, "no_frontmost_app");
    };
    res["app"] = json!({"pid": fg.pid, "bundle_id": fg.bundle_id, "name": fg.name, "version": fg.version});
    let fg_id = fg.bundle_id.to_lowercase();
    if fg_id.is_empty() && !record_unknown {
        return skip(res, "unknown_bundle");
    }
    if excluded.contains(&fg_id) {
        return skip(res, "excluded_app");
    }
    if OWN_APPS.contains(&fg_id.as_str()) {
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
    if let Some(host) = url.as_deref().and_then(host_of) {
        if domain_matches(&host, &excluded_domains) {
            return skip(res, "excluded_domain");
        }
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
        let id = w.bundle_id.to_lowercase();
        excluded.contains(&id) || OWN_APPS.contains(&id.as_str())
    };
    redact(&mut shot.image, &shot.display.rect, &windows, &hide);
    let image = fit_height(shot.image, max_height);
    ensure_parent(out)?;
    write_jpeg(&DynamicImage::ImageRgb8(image.clone()), out, quality)?;
    res["windows"] = windows_json(&windows);
    res["path"] = json!(out);
    res["width"] = json!(image.width());
    res["height"] = json!(image.height());
    res["display"] = json!({"id": shot.display.id, "x": shot.display.rect.x, "y": shot.display.rect.y, "w": shot.display.rect.w, "h": shot.display.rect.h});
    res["dhash"] = json!(dhash(&image));
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
    let Some(i) = a.intersect(cut) else { return vec![a] };
    let mut out = Vec::with_capacity(4);
    if i.y > a.y {
        out.push(Rect { x: a.x, y: a.y, w: a.w, h: i.y - a.y });
    }
    if i.bottom() < a.bottom() {
        out.push(Rect { x: a.x, y: i.bottom(), w: a.w, h: a.bottom() - i.bottom() });
    }
    if i.x > a.x {
        out.push(Rect { x: a.x, y: i.y, w: i.x - a.x, h: i.h });
    }
    if i.right() < a.right() {
        out.push(Rect { x: i.right(), y: i.y, w: a.right() - i.right(), h: i.h });
    }
    out
}

/// Paint hidden windows black where they are visible. `windows` is ordered
/// top of the z-order first, so only windows earlier in the list can cover a
/// later one. Window rectangles approximate the visible shape (rounded
/// corners and transparency are not modelled).
pub fn redact(image: &mut RgbImage, display: &Rect, windows: &[WinInfo], hide: &dyn Fn(&WinInfo) -> bool) {
    for (i, w) in windows.iter().enumerate() {
        if !hide(w) {
            continue;
        }
        let Some(r) = w.rect.intersect(display) else { continue };
        let mut visible = vec![r];
        for above in &windows[..i] {
            visible = visible.into_iter().flat_map(|v| subtract(v, &above.rect)).collect();
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

pub fn fit_height(img: RgbImage, max_height: u32) -> RgbImage {
    if max_height == 0 || img.height() <= max_height {
        return img;
    }
    let scale = max_height as f64 / img.height() as f64;
    let w = ((img.width() as f64 * scale).round() as u32).max(2);
    image::imageops::resize(&img, w, max_height, FilterType::Triangle)
}

pub fn write_jpeg(img: &DynamicImage, path: &str, quality: f64) -> Result<()> {
    let q = (quality * 100.0).round().clamp(1.0, 100.0) as u8;
    let file = std::fs::File::create(path).with_context(|| format!("create {path}"))?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), q);
    enc.encode_image(&DynamicImage::ImageRgb8(img.to_rgb8())).context("jpeg_write")
}

fn write_image(img: &DynamicImage, path: &str, quality: f64) -> Result<()> {
    ensure_parent(path)?;
    let l = path.to_lowercase();
    if l.ends_with(".jpg") || l.ends_with(".jpeg") {
        write_jpeg(img, path, quality)
    } else {
        img.save_with_format(path, image::ImageFormat::Png).context("png_write")
    }
}

/// 64-bit difference hash over a 9x8 grayscale thumbnail, hex encoded.
pub fn dhash(img: &RgbImage) -> String {
    let small = image::imageops::resize(&image::imageops::grayscale(img), 9, 8, FilterType::Triangle);
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
    let (Some(x), Some(y), Some(w), Some(h)) = (g("x"), g("y"), g("w"), g("h")) else { return img };
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
    let img = image::open(path).map_err(|_| anyhow!("image_not_found"))?.to_rgba8();
    let level = req.get("level").and_then(Value::as_str).unwrap_or("accurate");
    let langs: Vec<String> = req
        .get("languages")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let words = os::ocr(path, &img, level, &langs).map_err(|e| anyhow!("ocr_failed: {e:#}"))?;
    let boxes: Vec<Value> = group_words(words)
        .into_iter()
        .map(|w| json!({"x": w.rect.x, "y": w.rect.y, "w": w.rect.w, "h": w.rect.h, "text": w.text, "confidence": w.confidence}))
        .collect();
    // Incremental OCR (`incremental`, `diff_*`, `region_pad`, `full_every`) is macOS-only; always a full pass.
    Ok(json!({"boxes": boxes, "mode": "full", "changed_fraction": 1.0, "width": img.width(), "height": img.height(), "elapsed_ms": t0.elapsed().as_millis() as u64}))
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
                let same_line = (w.rect.y + w.rect.h / 2 - (c.rect.y + c.rect.h / 2)).abs() <= c.rect.h.max(w.rect.h) / 2;
                let gap = w.rect.x - c.rect.right();
                same_line && gap >= -(c.rect.h / 2) && gap as f64 <= 1.5 * c.rect.h.max(w.rect.h) as f64
            }
            None => false,
        };
        if joins {
            let (c, n, sum) = cur.as_mut().expect("joins implies cur");
            let x = c.rect.x.min(w.rect.x);
            let y = c.rect.y.min(w.rect.y);
            let r = c.rect.right().max(w.rect.right());
            let b = c.rect.bottom().max(w.rect.bottom());
            c.rect = Rect { x, y, w: r - x, h: b - y };
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
    DynamicImage::ImageRgba8(icon.image.clone()).save_with_format(out, image::ImageFormat::Png).map_err(|_| anyhow!("icon_write"))?;
    Ok(json!({"path": out, "dominant_color": average_color(&icon.image), "display_name": icon.display_name}))
}

/// Encode staged frames into one 1 fps MP4 (frame i at t = i s).
fn encode(req: &Value) -> Result<Value> {
    let inputs: Vec<String> = req
        .get("inputs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let out = str_arg(req, "out")?;
    let width = req.get("width").and_then(Value::as_u64).ok_or_else(|| anyhow!("bad_request"))? as u32;
    let height = req.get("height").and_then(Value::as_u64).ok_or_else(|| anyhow!("bad_request"))? as u32;
    if inputs.is_empty() {
        bail!("bad_request");
    }
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.5);
    ensure_parent(out)?;
    let _ = std::fs::remove_file(out);
    // H.264 needs even dimensions.
    let frames = os::encode(&inputs, out, (width & !1).max(2), (height & !1).max(2), quality).map_err(|e| anyhow!("encode_failed: {e:#}"))?;
    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    Ok(json!({"path": out, "frames": frames, "size_bytes": size}))
}

fn extract(req: &Value) -> Result<Value> {
    let video = str_arg(req, "video")?;
    let index = req.get("index").and_then(Value::as_u64).ok_or_else(|| anyhow!("bad_request"))? as usize;
    let out = str_arg(req, "out")?;
    let frame = os::extract_frame(video, index).map_err(|e| anyhow!("extract_failed: {e:#}"))?;
    let img = crop_arg(req, DynamicImage::ImageRgb8(frame));
    write_image(&img, out, req.get("quality").and_then(Value::as_f64).unwrap_or(0.85))?;
    Ok(json!({"path": out, "width": img.width(), "height": img.height()}))
}

fn image_color(req: &Value) -> Result<Value> {
    let path = str_arg(req, "path").map_err(|_| anyhow!("image_not_found"))?;
    let img = image::open(path).map_err(|_| anyhow!("image_not_found"))?.to_rgba8();
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
    let frames = req.get("frames").and_then(Value::as_u64).ok_or_else(|| anyhow!("bad_request"))? as usize;
    let scale = req.get("scale").and_then(Value::as_f64).unwrap_or(0.5);
    let quality = req.get("quality").and_then(Value::as_f64).unwrap_or(0.4);
    let tmp = std::env::temp_dir().join(format!("kce-{}-{}", std::process::id(), rand_tag()));
    std::fs::create_dir_all(&tmp)?;
    let result = (|| -> Result<Value> {
        let paths = os::extract_all(video, frames, &tmp).map_err(|e| anyhow!("transcode_read_failed: {e:#}"))?;
        if paths.len() != frames {
            bail!("transcode_read_failed: {}/{}", paths.len(), frames);
        }
        let first = image::image_dimensions(&paths[0]).context("transcode_read_failed")?;
        let w = (((first.0 as f64 * scale) as u32) & !1).max(2);
        let h = (((first.1 as f64 * scale) as u32) & !1).max(2);
        let inputs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let _ = std::fs::remove_file(out);
        ensure_parent(out)?;
        let written = os::encode(&inputs, out, w, h, quality).map_err(|e| anyhow!("encode_failed: {e:#}"))?;
        let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
        Ok(json!({"path": out, "frames": written, "size_bytes": size, "width": w, "height": h}))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn rand_tag() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Decode `path` and fit it to exactly `w` x `h` (stretch; sizes match in practice).
pub fn load_rgb_fit(path: &str, w: u32, h: u32) -> Result<RgbImage> {
    let img = image::open(path).with_context(|| format!("read {path}"))?.to_rgb8();
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
    use super::*;

    fn win(id: u64, bundle: &str, x: i32, y: i32, w: i32, h: i32) -> WinInfo {
        WinInfo { id, pid: 1, bundle_id: bundle.into(), app_name: bundle.into(), title: String::new(), rect: Rect { x, y, w, h }, focused: false }
    }

    #[test]
    fn private_markers() {
        assert!(looks_private("New Incognito tab - Google Chrome"));
        assert!(looks_private("Bing - InPrivate - Microsoft Edge"));
        assert!(!looks_private("Quarterly report - Word"));
    }

    #[test]
    fn hosts_and_domains() {
        assert_eq!(host_of("https://www.Example.com:8080/a?b#c").as_deref(), Some("example.com"));
        assert_eq!(host_of("mail.google.com/mail").as_deref(), Some("mail.google.com"));
        assert!(domain_matches("vault.bitwarden.com", &["bitwarden.com".into()]));
        assert!(domain_matches("proton.me", &["proton.me/pass".into()]));
        assert!(!domain_matches("notbitwarden.com", &["bitwarden.com".into()]));
    }

    #[test]
    fn redact_paints_only_visible_part() {
        // Hidden window 0..100 wide, covered on the right half by a top window.
        let mut img = RgbImage::from_pixel(100, 100, image::Rgb([255, 255, 255]));
        let windows = vec![win(1, "top.exe", 50, 0, 50, 100), win(2, "secret.exe", 0, 0, 100, 100)];
        redact(&mut img, &Rect { x: 0, y: 0, w: 100, h: 100 }, &windows, &|w| w.bundle_id == "secret.exe");
        assert_eq!(img.get_pixel(10, 10).0, [0, 0, 0]);
        assert_eq!(img.get_pixel(90, 90).0, [255, 255, 255]);
    }

    #[test]
    fn words_group_into_columns() {
        let w = |x, text: &str| Word { rect: Rect { x, y: 10, w: 40, h: 12 }, text: text.into(), confidence: 0.9 };
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
}
