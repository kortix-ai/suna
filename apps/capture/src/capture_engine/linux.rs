//! Linux (X11) implementation of the capture engine.
//!
//! * Screen, focus, windows, idle: X11 through `x11rb` (pure Rust, no libX11
//!   at build time). `_NET_ACTIVE_WINDOW`, `_NET_CLIENT_LIST_STACKING`,
//!   `WM_CLASS`, `_NET_WM_NAME`, XScreenSaver idle, RandR monitors.
//! * OCR: `tesseract` CLI. Video: `ffmpeg` CLI (libx264). Both are optional
//!   and reported as `*_unavailable` errors when missing.
//! * Wayland: unsupported. Portal capture needs a user consent dialog per
//!   session and PipeWire, so `capture` answers `skipped: "wayland_unsupported"`.
//! * Not available on X11: browser URL and AX tree (would need AT-SPI).

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::screensaver::ConnectionExt as _;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt as _, ImageFormat, MapState, Window};
use x11rb::rust_connection::RustConnection;

pub fn init() {}

pub fn permissions() -> Value {
    // X11 has no consent gate; report whether a session we can capture exists.
    permissions_json(preflight().is_none(), false)
}

pub fn preflight() -> Option<&'static str> {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let wayland = session == "wayland" || (std::env::var_os("WAYLAND_DISPLAY").is_some() && session != "x11");
    if wayland {
        return Some("wayland_unsupported");
    }
    if std::env::var_os("DISPLAY").is_none() {
        return Some("no_display");
    }
    None
}

struct Conn {
    c: RustConnection,
    root: Window,
}

thread_local! {
    static CONN: RefCell<Option<Conn>> = const { RefCell::new(None) };
}

fn with_conn<T>(f: impl Fn(&Conn) -> Result<T>) -> Result<T> {
    CONN.with(|cell| {
        for attempt in 0..2 {
            if cell.borrow().is_none() {
                let (c, n) = x11rb::connect(None).context("connect to X11 display")?;
                let root = c.setup().roots[n].root;
                *cell.borrow_mut() = Some(Conn { c, root });
            }
            let res = f(cell.borrow().as_ref().expect("connected"));
            if res.is_err() && attempt == 0 {
                *cell.borrow_mut() = None; // stale connection: reconnect once
                continue;
            }
            return res;
        }
        unreachable!()
    })
}

fn atom(c: &RustConnection, name: &str) -> Result<Atom> {
    Ok(c.intern_atom(false, name.as_bytes())?.reply()?.atom)
}

fn prop32(k: &Conn, w: Window, name: &str, ty: impl Into<Atom>) -> Option<Vec<u32>> {
    let a = atom(&k.c, name).ok()?;
    let r = k.c.get_property(false, w, a, ty, 0, 65536).ok()?.reply().ok()?;
    r.value32().map(|v| v.collect())
}

fn prop_bytes(k: &Conn, w: Window, name: &str, ty: impl Into<Atom>) -> Option<Vec<u8>> {
    let a = atom(&k.c, name).ok()?;
    let r = k.c.get_property(false, w, a, ty, 0, 4096).ok()?.reply().ok()?;
    (r.value_len > 0).then_some(r.value)
}

pub fn idle_seconds() -> f64 {
    with_conn(|k| Ok(k.c.screensaver_query_info(k.root)?.reply()?.ms_since_user_input as f64 / 1000.0)).unwrap_or(0.0)
}

/// The X screensaver being active is the closest signal for a locked screen.
pub fn session_locked() -> bool {
    with_conn(|k| Ok(k.c.screensaver_query_info(k.root)?.reply()?.state == u8::from(x11rb::protocol::screensaver::State::ON))).unwrap_or(false)
}

fn window_title(k: &Conn, w: Window) -> String {
    let utf8 = atom(&k.c, "UTF8_STRING").ok();
    utf8.and_then(|t| prop_bytes(k, w, "_NET_WM_NAME", t))
        .or_else(|| prop_bytes(k, w, "WM_NAME", AtomEnum::ANY))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn window_rect(k: &Conn, w: Window) -> Option<Rect> {
    let g = k.c.get_geometry(w).ok()?.reply().ok()?;
    let t = k.c.translate_coordinates(w, k.root, 0, 0).ok()?.reply().ok()?;
    let (mut x, mut y, mut width, mut height) = (t.dst_x as i32, t.dst_y as i32, g.width as i32, g.height as i32);
    // Include the window manager frame so the rect matches what is on screen.
    if let Some(e) = prop32(k, w, "_NET_FRAME_EXTENTS", AtomEnum::CARDINAL) {
        if e.len() == 4 {
            x -= e[0] as i32;
            y -= e[2] as i32;
            width += (e[0] + e[1]) as i32;
            height += (e[2] + e[3]) as i32;
        }
    }
    Some(Rect { x, y, w: width, h: height })
}

#[derive(Clone, Default)]
struct AppMeta {
    bundle_id: String,
    name: String,
    pid: u32,
}

fn desktop_dirs() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let data_home = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{home}/.local/share"));
    let mut dirs = vec![PathBuf::from(data_home)];
    for d in std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into()).split(':') {
        dirs.push(PathBuf::from(d));
    }
    dirs.push("/var/lib/flatpak/exports/share".into());
    dirs.push("/var/lib/snapd/desktop".into());
    dirs
}

#[derive(Clone, Default)]
struct DesktopEntry {
    name: String,
    icon: String,
}

fn parse_desktop(path: &Path) -> Option<(DesktopEntry, String)> {
    let text = std::fs::read_to_string(path).ok()?;
    let (mut e, mut wm) = (DesktopEntry::default(), String::new());
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Name=") {
            if e.name.is_empty() {
                e.name = v.trim().to_string();
            }
        } else if let Some(v) = line.strip_prefix("Icon=") {
            e.icon = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("StartupWMClass=") {
            wm = v.trim().to_lowercase();
        }
    }
    Some((e, wm))
}

/// Desktop entry for a WM class: `<class>.desktop` or a `StartupWMClass` match.
fn desktop_entry(class_lower: &str) -> Option<DesktopEntry> {
    thread_local! {
        static CACHE: RefCell<HashMap<String, Option<DesktopEntry>>> = RefCell::new(HashMap::new());
    }
    if let Some(hit) = CACHE.with(|c| c.borrow().get(class_lower).cloned()) {
        return hit;
    }
    let mut found = None;
    'outer: for dir in desktop_dirs() {
        let apps = dir.join("applications");
        let direct = apps.join(format!("{class_lower}.desktop"));
        if let Some((e, _)) = parse_desktop(&direct) {
            found = Some(e);
            break;
        }
        let Ok(rd) = std::fs::read_dir(&apps) else { continue };
        for f in rd.flatten() {
            if f.path().extension().map(|x| x == "desktop").unwrap_or(false) {
                if let Some((e, wm)) = parse_desktop(&f.path()) {
                    if wm == class_lower {
                        found = Some(e);
                        break 'outer;
                    }
                }
            }
        }
    }
    CACHE.with(|c| c.borrow_mut().insert(class_lower.to_string(), found.clone()));
    found
}

fn app_meta(k: &Conn, w: Window) -> AppMeta {
    let pid = prop32(k, w, "_NET_WM_PID", AtomEnum::CARDINAL).and_then(|v| v.first().copied()).unwrap_or(0);
    // WM_CLASS is "instance\0Class\0"; the class part is the stable identity.
    let class = prop_bytes(k, w, "WM_CLASS", AtomEnum::STRING)
        .map(|b| {
            let parts: Vec<&[u8]> = b.split(|&c| c == 0).filter(|p| !p.is_empty()).collect();
            String::from_utf8_lossy(parts.get(1).or(parts.first()).copied().unwrap_or(b"")).to_lowercase()
        })
        .unwrap_or_default();
    let bundle_id = if class.is_empty() && pid != 0 {
        std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|s| s.trim().to_lowercase()).unwrap_or_default()
    } else {
        class
    };
    let name = desktop_entry(&bundle_id).map(|e| e.name).filter(|n| !n.is_empty()).unwrap_or_else(|| bundle_id.clone());
    AppMeta { bundle_id, name, pid }
}

pub fn foreground() -> Option<Foreground> {
    with_conn(|k| {
        // Some window managers leave focus unset; fall back to the topmost client window.
        let active = prop32(k, k.root, "_NET_ACTIVE_WINDOW", AtomEnum::WINDOW)
            .and_then(|v| v.first().copied())
            .filter(|&w| w != 0)
            .or_else(|| prop32(k, k.root, "_NET_CLIENT_LIST_STACKING", AtomEnum::WINDOW).and_then(|v| v.last().copied()))
            .unwrap_or(0);
        if active == 0 {
            bail!("no active window");
        }
        let m = app_meta(k, active);
        Ok(Foreground {
            id: active as u64,
            pid: m.pid,
            bundle_id: m.bundle_id,
            name: m.name,
            version: String::new(),
            title: window_title(k, active),
            rect: window_rect(k, active),
        })
    })
    .ok()
}

pub fn browser_url(_: &Foreground) -> Option<String> {
    None
}

pub fn ax_tree(_: &Foreground, _: usize, _: usize) -> Option<AxResult> {
    None
}

pub fn windows(fg: &Foreground) -> Vec<WinInfo> {
    with_conn(|k| {
        let mut stack = prop32(k, k.root, "_NET_CLIENT_LIST_STACKING", AtomEnum::WINDOW).unwrap_or_default();
        stack.reverse(); // bottom-to-top -> top first
        let hidden = atom(&k.c, "_NET_WM_STATE_HIDDEN")?;
        let dock = atom(&k.c, "_NET_WM_WINDOW_TYPE_DOCK")?;
        let desktop = atom(&k.c, "_NET_WM_WINDOW_TYPE_DESKTOP")?;
        let mut out = Vec::new();
        for w in stack {
            let Ok(Ok(attrs)) = k.c.get_window_attributes(w).map(|c| c.reply()) else { continue };
            if attrs.map_state != MapState::VIEWABLE {
                continue;
            }
            if prop32(k, w, "_NET_WM_STATE", AtomEnum::ATOM).map(|s| s.contains(&hidden)).unwrap_or(false) {
                continue;
            }
            if prop32(k, w, "_NET_WM_WINDOW_TYPE", AtomEnum::ATOM).map(|t| t.contains(&dock) || t.contains(&desktop)).unwrap_or(false) {
                continue;
            }
            let Some(rect) = window_rect(k, w) else { continue };
            if rect.w < 2 || rect.h < 2 {
                continue;
            }
            let m = app_meta(k, w);
            out.push(WinInfo { id: w as u64, pid: m.pid, bundle_id: m.bundle_id, app_name: m.name, title: window_title(k, w), rect, focused: w as u64 == fg.id });
        }
        Ok(out)
    })
    .unwrap_or_default()
}

pub fn screenshot(focus: Option<Rect>) -> Result<Shot> {
    with_conn(|k| {
        let root_geo = k.c.get_geometry(k.root)?.reply()?;
        let root_rect = Rect { x: 0, y: 0, w: root_geo.width as i32, h: root_geo.height as i32 };
        // Monitor holding the focused window's center; RandR may be missing.
        let monitors: Vec<(i64, Rect)> = k
            .c
            .randr_get_monitors(k.root, true)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.monitors.iter().enumerate().map(|(i, m)| (i as i64, Rect { x: m.x as i32, y: m.y as i32, w: m.width as i32, h: m.height as i32 })).collect())
            .unwrap_or_default();
        let (id, rect) = focus
            .and_then(|f| monitors.iter().find(|(_, r)| r.contains(f.x + f.w / 2, f.y + f.h / 2)).copied())
            .or_else(|| monitors.first().copied())
            .unwrap_or((0, root_rect));
        let rect = rect.intersect(&root_rect).unwrap_or(root_rect);
        let img = k.c.get_image(ImageFormat::Z_PIXMAP, k.root, rect.x as i16, rect.y as i16, rect.w as u16, rect.h as u16, !0)?.reply()?;
        let bpp = k.c.setup().pixmap_formats.iter().find(|f| f.depth == img.depth).map(|f| f.bits_per_pixel).unwrap_or(0);
        if bpp != 32 {
            bail!("unsupported X11 pixel format: depth {} bpp {}", img.depth, bpp);
        }
        let mut rgb = Vec::with_capacity(rect.w as usize * rect.h as usize * 3);
        for px in img.data.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        let image = RgbImage::from_raw(rect.w as u32, rect.h as u32, rgb).ok_or_else(|| anyhow!("frame buffer size"))?;
        Ok(Shot { image, display: Display { id, rect } })
    })
}

// --------------------------------------------------------------------- OCR

fn tesseract_lang(tag: &str) -> Option<&'static str> {
    let l = tag.to_lowercase();
    let base = l.split(['-', '_']).next().unwrap_or("");
    Some(match (l.as_str(), base) {
        ("zh-hans" | "zh-cn", _) => "chi_sim",
        ("zh-hant" | "zh-tw", _) => "chi_tra",
        (_, "en") => "eng",
        (_, "de") => "deu",
        (_, "fr") => "fra",
        (_, "es") => "spa",
        (_, "it") => "ita",
        (_, "pt") => "por",
        (_, "nl") => "nld",
        (_, "ru") => "rus",
        (_, "ja") => "jpn",
        (_, "ko") => "kor",
        (_, "sv") => "swe",
        (_, "pl") => "pol",
        (_, "tr") => "tur",
        _ => return None,
    })
}

fn run_tesseract(path: &str, lang: &str, psm: &str) -> Result<std::process::Output> {
    Command::new("tesseract")
        .args([path, "stdout", "-l", lang, "--psm", psm, "tsv"])
        .env("OMP_THREAD_LIMIT", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow!("ocr_unavailable: tesseract is not installed (apt install tesseract-ocr)")
            } else {
                anyhow!("tesseract: {e}")
            }
        })
}

pub fn ocr(path: &str, _img: &RgbaImage, level: &str, langs: &[String]) -> Result<Vec<Word>> {
    let mut mapped: Vec<&str> = langs.iter().filter_map(|l| tesseract_lang(l)).collect();
    mapped.dedup();
    let lang = if mapped.is_empty() { "eng".to_string() } else { mapped.join("+") };
    // psm 11 (sparse text) suits scattered UI text; 3 (auto layout) suits documents.
    let psm = if level == "fast" { "11" } else { "3" };
    let mut out = run_tesseract(path, &lang, psm)?;
    if !out.status.success() && lang != "eng" {
        out = run_tesseract(path, "eng", psm)?; // requested language pack missing
    }
    if !out.status.success() {
        bail!("tesseract exited {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(parse_tsv(&String::from_utf8_lossy(&out.stdout)))
}

/// Word rows (level 5) of Tesseract TSV output.
fn parse_tsv(tsv: &str) -> Vec<Word> {
    tsv.lines()
        .skip(1)
        .filter_map(|line| {
            let c: Vec<&str> = line.splitn(12, '\t').collect();
            if c.len() < 12 || c[0] != "5" {
                return None;
            }
            let conf: f64 = c[10].parse().ok()?;
            if conf < 0.0 {
                return None;
            }
            Some(Word {
                rect: Rect { x: c[6].parse().ok()?, y: c[7].parse().ok()?, w: c[8].parse().ok()?, h: c[9].parse().ok()? },
                text: c[11].trim().to_string(),
                confidence: (conf / 100.0).clamp(0.0, 1.0),
            })
        })
        .collect()
}

// ------------------------------------------------------------------- icons

pub fn icon(bundle_id: &str, size: u32) -> Result<IconResult> {
    let entry = desktop_entry(&bundle_id.to_lowercase()).ok_or_else(|| anyhow!("app_not_found"))?;
    let path = if Path::new(&entry.icon).is_absolute() {
        Some(PathBuf::from(&entry.icon))
    } else {
        let mut candidates = Vec::new();
        for dir in desktop_dirs() {
            for s in ["256x256", "128x128", "96x96", "64x64", "48x48", "512x512", "32x32"] {
                candidates.push(dir.join(format!("icons/hicolor/{s}/apps/{}.png", entry.icon)));
            }
            candidates.push(dir.join(format!("pixmaps/{}.png", entry.icon)));
        }
        candidates.push(PathBuf::from(format!("/usr/share/pixmaps/{}.png", entry.icon)));
        candidates.into_iter().find(|p| p.is_file())
    };
    let path = path.ok_or_else(|| anyhow!("icon_render: no PNG icon for {}", entry.icon))?;
    let img = image::open(&path).map_err(|_| anyhow!("icon_render: unreadable {}", path.display()))?.to_rgba8();
    let image = image::imageops::resize(&img, size, size, FilterType::Lanczos3);
    Ok(IconResult { image, display_name: entry.name })
}

// ------------------------------------------------------------------ ffmpeg

fn ffmpeg() -> Command {
    let mut c = Command::new("ffmpeg");
    c.args(["-y", "-hide_banner", "-loglevel", "error", "-nostdin"]);
    c
}

fn run_ffmpeg(mut cmd: Command) -> Result<std::process::Output> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            anyhow!("ffmpeg_unavailable: ffmpeg is not installed (apt install ffmpeg)")
        } else {
            anyhow!("ffmpeg: {e}")
        }
    })?;
    if !out.status.success() {
        bail!("ffmpeg exited {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out)
}

pub fn encode(inputs: &[String], out: &str, w: u32, h: u32, quality: f64) -> Result<usize> {
    let existing: Vec<&String> = inputs.iter().filter(|p| Path::new(p.as_str()).is_file()).collect();
    if existing.is_empty() {
        bail!("no readable input frames");
    }
    let tmp = std::env::temp_dir().join(format!("kce-enc-{}-{}", std::process::id(), rand_tag()));
    std::fs::create_dir_all(&tmp)?;
    let result = (|| {
        for (i, p) in existing.iter().enumerate() {
            std::os::unix::fs::symlink(p, tmp.join(format!("{i:05}.jpg")))?;
        }
        let crf = (38.0 - 20.0 * quality.clamp(0.0, 1.0)).round().to_string();
        let mut cmd = ffmpeg();
        cmd.args(["-framerate", "1", "-i"])
            .arg(tmp.join("%05d.jpg"))
            .args(["-vf", &format!("scale={w}:{h}:flags=lanczos,format=yuv420p")])
            .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", &crf, "-g", "30", "-r", "1", "-movflags", "+faststart"])
            .arg(out);
        run_ffmpeg(cmd)?;
        Ok(existing.len())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

pub fn extract_frame(video: &str, index: usize) -> Result<RgbImage> {
    let mut cmd = ffmpeg();
    cmd.args(["-ss", &index.to_string(), "-i", video, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]);
    let out = run_ffmpeg(cmd)?;
    if out.stdout.is_empty() {
        bail!("frame {index} not in {video}");
    }
    Ok(image::load_from_memory(&out.stdout)?.to_rgb8())
}

pub fn extract_all(video: &str, frames: usize, dir: &Path) -> Result<Vec<PathBuf>> {
    let mut cmd = ffmpeg();
    cmd.args(["-i", video, "-vsync", "0", "-q:v", "2", "-start_number", "0"]).arg(dir.join("%05d.jpg"));
    run_ffmpeg(cmd)?;
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)?.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "jpg").unwrap_or(false)).collect();
    paths.sort();
    paths.truncate(frames);
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsv_words() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
                   4\t1\t1\t1\t1\t0\t10\t10\t90\t20\t-1\t\n\
                   5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t96.5\thello\n\
                   5\t1\t1\t1\t1\t2\t60\t10\t40\t20\t-1\t\n";
        let w = parse_tsv(tsv);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].text, "hello");
        assert!((w[0].confidence - 0.965).abs() < 1e-9);
    }

    #[test]
    fn languages() {
        assert_eq!(tesseract_lang("en-US"), Some("eng"));
        assert_eq!(tesseract_lang("zh-Hans"), Some("chi_sim"));
        assert_eq!(tesseract_lang("xx"), None);
    }
}
