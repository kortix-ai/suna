//! Timeline and search window (`kortix-capture ui`, `kortix-capture open <url>`).
//!
//! A `wry` WebView (WKWebView / WebView2 / WebKitGTK) in a `tao` window shows
//! the embedded app from `backend/ui/memory/`. Everything is served through the
//! `kmem://` custom protocol into [`api::Ctx::handle`]; no TCP port is opened.
//!
//! Single instance: the running window touches `ui.lock` every second and polls
//! `ui-request.json`. A second `ui` / `open` process sees a fresh lock, writes
//! the request file, waits for it to be consumed, and exits. Plain files work
//! the same on macOS, Linux and Windows.

pub mod api;

use super::cli::{parse_duration_ms, UiArgs};
use super::paths::MemoryPaths;
use super::store::now_ms;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub const SCHEME: &str = "kortix-capture";
const LOCK_STALE: Duration = Duration::from_secs(4);

/// What the window should show.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Target {
    /// `timeline` | `search` | `settings`
    pub view: String,
    pub t_ms: Option<i64>,
    pub q: Option<String>,
    /// Settings only: the sync destination to show first (`off`, `kortix` or `s3`).
    pub sync: Option<String>,
    /// Settings only: the section to scroll to (`recording`, `sync`, `never`, `storage`, `about`).
    pub section: Option<String>,
}

impl Target {
    fn to_json(&self) -> Value {
        json!({"view": self.view, "t": self.t_ms, "q": self.q, "sync": self.sync, "section": self.section})
    }
}

/// `kortix-capture://timeline?t=<epoch s>` | `…://search?q=…` | `…://settings`.
pub fn parse_link(url: &str) -> Result<Target> {
    let rest = url
        .strip_prefix(&format!("{SCHEME}://"))
        .ok_or_else(|| anyhow!("not a {SCHEME}:// link: {url}"))?;
    let (view, query) = rest.split_once('?').unwrap_or((rest, ""));
    let view = view.trim_matches('/');
    if !["timeline", "search", "settings", ""].contains(&view) {
        bail!("unknown link target {view:?} (expected timeline, search or settings)");
    }
    let mut t = Target {
        view: if view.is_empty() {
            "timeline".into()
        } else {
            view.into()
        },
        ..Default::default()
    };
    for kv in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        let v = urlencoding::decode(&v.replace('+', " "))
            .map(|c| c.into_owned())
            .unwrap_or_default();
        match k {
            "t" => {
                let n: f64 = v.parse().with_context(|| format!("bad t={v:?}"))?;
                // Epoch seconds; tolerate milliseconds.
                t.t_ms = Some(if n > 1e11 {
                    n as i64
                } else {
                    (n * 1000.0) as i64
                });
            }
            "q" => t.q = Some(v),
            "sync" if ["off", "kortix", "s3"].contains(&v.as_str()) => t.sync = Some(v),
            "section" if ["recording", "sync", "never", "storage", "about"].contains(&v.as_str()) => {
                t.section = Some(v)
            }
            _ => {}
        }
    }
    Ok(t)
}

/// 'now', '20m', '-2h', '3d ago', epoch seconds, or `2026-01-15T09:30` (local).
pub fn parse_moment(s: &str, now: i64) -> Result<i64> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("now") {
        return Ok(now);
    }
    let rel = s.trim_start_matches('-').trim_end_matches("ago").trim();
    if let Some(ms) = parse_duration_ms(rel) {
        return Ok(now - ms);
    }
    if let Ok(n) = s.parse::<f64>() {
        return Ok(if n > 1e11 {
            n as i64
        } else {
            (n * 1000.0) as i64
        });
    }
    use chrono::TimeZone;
    for fmt in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ] {
        let naive = chrono::NaiveDateTime::parse_from_str(s, fmt).or_else(|_| {
            chrono::NaiveDate::parse_from_str(s, fmt)
                .map(|d| d.and_hms_opt(0, 0, 0).expect("midnight"))
        });
        if let Ok(n) = naive {
            if let chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) =
                chrono::Local.from_local_datetime(&n)
            {
                return Ok(dt.timestamp_millis());
            }
        }
    }
    bail!("cannot parse moment {s:?} (examples: now, 20m, -2h, 3d ago, 2026-01-15T09:30)")
}

fn lock_path(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("ui.lock")
}
fn request_path(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("ui-request.json")
}

fn lock_is_fresh(paths: &MemoryPaths) -> bool {
    std::fs::metadata(lock_path(paths))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age < LOCK_STALE)
        .unwrap_or(false)
}

/// Hand the target to the running window. `Ok(false)` = no window is running.
fn forward(paths: &MemoryPaths, target: &Target) -> Result<bool> {
    if !lock_is_fresh(paths) {
        return Ok(false);
    }
    let tmp = paths.root.join("ui-request.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&target.to_json())?)?;
    std::fs::rename(&tmp, request_path(paths))?;
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if !request_path(paths).exists() {
            return Ok(true);
        }
    }
    let _ = std::fs::remove_file(request_path(paths));
    Ok(false)
}

pub fn run(paths: &MemoryPaths, a: UiArgs) -> Result<()> {
    let target = if let Some(at) = a.at {
        Target {
            view: "timeline".into(),
            t_ms: Some(parse_moment(&at, now_ms())?),
            q: None,
            sync: None,
            section: None,
        }
    } else if a.search {
        Target {
            view: "search".into(),
            ..Default::default()
        }
    } else {
        Target {
            view: "timeline".into(),
            ..Default::default()
        }
    };
    launch(paths, target)
}

/// A window that did not open, from the Start menu or the tray, has no console to print
/// to: `logs/ui.log`, and on Windows a message box the person sees.
pub fn report_failure(paths: &MemoryPaths, err: &anyhow::Error) {
    use std::io::Write as _;
    let _ = std::fs::create_dir_all(paths.logs_dir());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.logs_dir().join("ui.log"))
    {
        let _ = writeln!(
            f,
            "{} the window did not open: {err:#}",
            chrono::Utc::now().to_rfc3339()
        );
    }
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text = format!(
            "Kortix Capture could not open its window.\n\n{err:#}\n\nThe window needs the Microsoft Edge WebView2 Runtime. If it is missing, install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and open Kortix Capture again.\n\nRecording is not affected. Log: {}",
            paths.logs_dir().join("ui.log").display()
        );
        unsafe {
            MessageBoxW(
                HWND::default(),
                &HSTRING::from(text),
                &HSTRING::from("Kortix Capture"),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

pub fn open_url(paths: &MemoryPaths, url: &str) -> Result<()> {
    launch(paths, parse_link(url)?)
}

fn launch(paths: &MemoryPaths, target: Target) -> Result<()> {
    paths.ensure()?;
    super::legacy::migrate_legacy_settings(paths);
    if forward(paths, &target)? {
        return Ok(());
    }
    window::run(paths, target)
}

#[cfg(any(target_os = "macos", target_os = "windows", feature = "memory-ui"))]
mod window {
    use super::*;
    use std::sync::Arc;
    use tao::dpi::LogicalSize;
    use tao::event::{Event, StartCause, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use wry::http::{header, Response};
    use wry::WebViewBuilder;

    enum UiEvent {
        Navigate(Value),
        Close,
        /// Clipboard text for the field in focus (the window has no Edit menu).
        Paste(String),
        /// The window stops floating (it took focus, or enough time passed).
        Unfloat,
    }

    /// `kmem://localhost/` on macOS and Linux, `http://kmem.localhost/` on Windows.
    #[cfg(windows)]
    const ORIGIN: &str = "http://kmem.localhost/";
    #[cfg(not(windows))]
    const ORIGIN: &str = "kmem://localhost/";

    pub fn run(paths: &MemoryPaths, target: Target) -> Result<()> {
        let ctx = Arc::new(api::Ctx::new(paths.clone()));
        #[allow(unused_mut)]
        let mut event_loop = EventLoopBuilder::<UiEvent>::with_user_event().build();
        // No Dock icon and no Cmd-Tab entry, even while the window is open: the window is a
        // guest of the menu-bar app and holds no recording state.
        #[cfg(target_os = "macos")]
        {
            use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
            event_loop.set_activation_policy(ActivationPolicy::Accessory);
        }
        let proxy = event_loop.create_proxy();

        // Lock heartbeat + request mailbox.
        {
            let paths = paths.clone();
            let proxy = proxy.clone();
            let _ = std::fs::write(lock_path(&paths), std::process::id().to_string());
            std::thread::spawn(move || loop {
                let _ = std::fs::write(lock_path(&paths), std::process::id().to_string());
                for _ in 0..5 {
                    if let Ok(bytes) = std::fs::read(request_path(&paths)) {
                        let _ = std::fs::remove_file(request_path(&paths));
                        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                            let _ = proxy.send_event(UiEvent::Navigate(v));
                        }
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            });
        }

        // The title-bar and taskbar icon (Windows, Linux); macOS uses the app bundle's.
        #[cfg(windows)]
        const WINDOW_ICON: &[u8] = include_bytes!("../../assets/icons/windows/app-256.png");
        #[cfg(not(windows))]
        const WINDOW_ICON: &[u8] = include_bytes!("../../assets/icons/app-256.png");
        let window_icon = image::load_from_memory_with_format(
            WINDOW_ICON,
            image::ImageFormat::Png,
        )
        .ok()
        .and_then(|i| {
            let i = i.to_rgba8();
            let (w, h) = i.dimensions();
            tao::window::Icon::from_rgba(i.into_raw(), w, h).ok()
        });
        let window = WindowBuilder::new()
            .with_window_icon(window_icon)
            .with_title("Kortix Capture")
            .with_inner_size(LogicalSize::new(1240.0, 800.0))
            .with_min_inner_size(LogicalSize::new(720.0, 480.0))
            .build(&event_loop)?;
        // An accessory app starts behind the others: bring the window forward.
        window.set_focus();

        let handler_ctx = ctx.clone();
        let ipc_ctx = ctx.clone();
        let close_proxy = proxy.clone();
        let float_proxy = proxy.clone();
        let hash = format!("#{}", urlencoding::encode(&target.to_json().to_string()));
        // WebView2 keeps its profile next to the exe unless told otherwise. A person cannot
        // write to Program Files, so the window of an MSI install failed to open.
        #[cfg(windows)]
        let mut web_context = wry::WebContext::new(Some(paths.root.join("webview2")));
        #[cfg(windows)]
        let builder = WebViewBuilder::new_with_web_context(&mut web_context);
        #[cfg(not(windows))]
        let builder = WebViewBuilder::new();
        let builder = builder
            .with_asynchronous_custom_protocol("kmem".into(), move |_id, request, responder| {
                let ctx = handler_ctx.clone();
                std::thread::spawn(move || {
                    let uri = request.uri();
                    let path_query = uri
                        .path_and_query()
                        .map(|p| p.as_str())
                        .unwrap_or("/")
                        .to_string();
                    let range = request
                        .headers()
                        .get(header::RANGE)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    let r = ctx.handle(
                        request.method().as_str(),
                        &path_query,
                        range.as_deref(),
                        request.body(),
                    );
                    let mut b = Response::builder()
                        .status(r.status)
                        .header(header::CONTENT_TYPE, r.content_type.as_str());
                    b = b.header(header::CONTENT_LENGTH, r.body.len());
                    for (k, v) in &r.headers {
                        b = b.header(k.as_str(), v.as_str());
                    }
                    if let Ok(resp) = b.body(r.body) {
                        responder.respond(resp);
                    }
                });
            })
            // The window shows only its own pages. A link or a script cannot send it to the web.
            .with_navigation_handler(|url| same_origin(&url))
            .with_ipc_handler(move |req| {
                if let Ok(v) = serde_json::from_str::<Value>(req.body()) {
                    if v["cmd"] == "close" {
                        let _ = close_proxy.send_event(UiEvent::Close);
                    }
                    handle_ipc(&ipc_ctx, &v, &close_proxy);
                }
            })
            // Audio memory: the next segment starts playing while the playhead
            // moves, after the person pressed play; no gesture per segment.
            .with_autoplay(true)
            .with_url(format!("{ORIGIN}{hash}"));

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let webview = builder.build(&window)?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            builder.build_gtk(
                window
                    .default_vbox()
                    .ok_or_else(|| anyhow!("no gtk vbox"))?,
            )?
        };

        event_loop.run(move |event, _, control_flow| {
            // The WebView2 profile lives as long as the window.
            #[cfg(windows)]
            let _ = &web_context;
            *control_flow = ControlFlow::Wait;
            match event {
                Event::UserEvent(UiEvent::Close)
                | Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    let _ = std::fs::remove_file(lock_path(&ctx.paths));
                    *control_flow = ControlFlow::Exit;
                }
                // Opening the app while this window is its registered instance.
                // An accessory app launched by another process starts behind the others, and a
                // focus request before the loop runs is ignored: ask again once it runs.
                Event::NewEvents(StartCause::Init) => {
                    raise(&window, &float_proxy);
                }
                Event::Reopen { .. } => {
                    raise(&window, &float_proxy);
                }
                // A kortix-capture:// link LaunchServices delivered to this process.
                Event::Opened { urls } => {
                    for url in urls {
                        if let Ok(target) = parse_link(url.as_str()) {
                            let _ = webview.evaluate_script(&format!(
                                "window.kmemNavigate && window.kmemNavigate({})",
                                target.to_json()
                            ));
                            raise(&window, &float_proxy);
                        }
                    }
                }
                Event::UserEvent(UiEvent::Unfloat)
                | Event::WindowEvent {
                    event: WindowEvent::Focused(true),
                    ..
                } => {
                    window.set_always_on_top(false);
                }
                Event::UserEvent(UiEvent::Paste(text)) => {
                    let _ = webview.evaluate_script(&format!(
                        "window.kmemPaste && window.kmemPaste({})",
                        Value::String(text)
                    ));
                }
                Event::UserEvent(UiEvent::Navigate(v)) => {
                    let _ = webview.evaluate_script(&format!(
                        "window.kmemNavigate && window.kmemNavigate({v})"
                    ));
                    raise(&window, &float_proxy);
                }
                _ => {}
            }
        });
    }

    const MIC_SETTINGS_URL: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

    /// Bring the window in front of every other app's windows. An accessory app is not activated
    /// by a launch from a script, and macOS 14 ignores a plain activation request: the window
    /// orders itself to the front regardless of the active app.
    fn raise(window: &tao::window::Window, proxy: &tao::event_loop::EventLoopProxy<UiEvent>) {
        window.set_minimized(false);
        // Above the other apps' windows until the person focuses it (or 20 s pass): an inactive
        // app's window otherwise sits behind the active app's windows.
        window.set_always_on_top(true);
        let p = proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(20));
            let _ = p.send_event(UiEvent::Unfloat);
        });
        window.set_focus();
        #[cfg(target_os = "macos")]
        #[allow(unexpected_cfgs)]
        unsafe {
            use objc::runtime::{Class, Object};
            use objc::{msg_send, sel, sel_impl};
            use tao::platform::macos::WindowExtMacOS;
            let w = window.ns_window() as *mut Object;
            if let Some(cls) = Class::get("NSApplication") {
                let app: *mut Object = msg_send![cls, sharedApplication];
                let _: () = msg_send![app, activateIgnoringOtherApps: true];
            }
            let _: () = msg_send![w, orderFrontRegardless];
            let _: () = msg_send![w, makeKeyAndOrderFront: std::ptr::null_mut::<Object>()];
        }
    }

    fn handle_ipc(ctx: &api::Ctx, v: &Value, proxy: &tao::event_loop::EventLoopProxy<UiEvent>) {
        match v["cmd"].as_str() {
            Some("open_url") => {
                if let Some(url) = v["url"]
                    .as_str()
                    // "Open settings" when the microphone is turned off for the app.
                    .filter(|u| *u == MIC_SETTINGS_URL || openable_url(u))
                {
                    open_in_browser(url);
                }
            }
            // A page the person recorded and chose to reopen: http or https, nothing else.
            Some("open_page") => {
                if let Some(url) = v["url"]
                    .as_str()
                    .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                {
                    open_in_browser(url);
                }
            }
            // An accessory app has no Edit menu, so the window pastes by itself.
            Some("paste") => {
                if let Ok(text) = arboard::Clipboard::new().and_then(|mut cb| cb.get_text()) {
                    let _ = proxy.send_event(UiEvent::Paste(text));
                }
            }
            Some("copy_text") => {
                if let (Some(text), Ok(mut cb)) = (v["text"].as_str(), arboard::Clipboard::new()) {
                    let _ = cb.set_text(text.to_string());
                }
            }
            Some("copy_image") => {
                if let Some(id) = v["id"].as_i64() {
                    if let Err(err) = copy_image(ctx, id) {
                        tracing::warn!("copy frame {id}: {err:#}");
                    }
                }
            }
            _ => {}
        }
    }

    fn copy_image(ctx: &api::Ctx, id: i64) -> Result<()> {
        let png = ctx.export_png(id)?;
        let rgba = image::open(&png)?.to_rgba8();
        let (w, h) = rgba.dimensions();
        arboard::Clipboard::new()?.set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: rgba.into_raw().into(),
        })?;
        let _ = std::fs::remove_file(png);
        Ok(())
    }

    fn open_in_browser(url: &str) {
        #[cfg(target_os = "macos")]
        let mut cmd = std::process::Command::new("open");
        #[cfg(target_os = "windows")]
        // `cmd /c start` treats `&` in the query as a separator and flashes a console.
        let mut cmd = {
            let mut c = std::process::Command::new("rundll32");
            c.arg("url.dll,FileProtocolHandler");
            c
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut cmd = std::process::Command::new("xdg-open");
        let _ = cmd.arg(url).spawn();
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", feature = "memory-ui")))]
mod window {
    use super::*;
    pub fn run(_paths: &MemoryPaths, _target: Target) -> Result<()> {
        bail!("this build has no window; rebuild with `--features memory-ui` (needs WebKitGTK)")
    }
}

/// The window's own origin: `kmem://localhost/` (macOS, Linux), `http://kmem.localhost/` (Windows).
fn same_origin(url: &str) -> bool {
    url.starts_with("kmem://localhost/")
        || url.starts_with("http://kmem.localhost/")
        || url == "about:blank"
}

/// A link the window may hand to the browser: https, or http to this computer only.
fn openable_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => match u.scheme() {
            "https" => u.host_str().is_some(),
            "http" => matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
            _ => false,
        },
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_stays_on_its_own_pages_and_opens_only_safe_links() {
        assert!(same_origin("kmem://localhost/"));
        assert!(same_origin("kmem://localhost/#%7B%7D"));
        assert!(same_origin("http://kmem.localhost/app.js"));
        assert!(!same_origin("https://evil.example/"));
        assert!(!same_origin("http://kmem.localhost.evil.example/"));
        assert!(!same_origin("file:///etc/passwd"));
        assert!(!same_origin("javascript:alert(1)"));
        assert!(openable_url("https://docs.example/page"));
        assert!(openable_url("http://127.0.0.1:8787/approve"));
        assert!(!openable_url("http://evil.example/"));
        assert!(!openable_url("file:///etc/passwd"));
        assert!(!openable_url("x-apple.systempreferences:com.apple.preference.security"));
        assert!(!openable_url("javascript:alert(1)"));
        assert!(!openable_url("--help"));
    }

    #[test]
    fn a_settings_link_names_the_sync_destination() {
        let t = parse_link("kortix-capture://settings?sync=s3").unwrap();
        assert_eq!((t.view.as_str(), t.sync.as_deref()), ("settings", Some("s3")));
        assert_eq!(parse_link("kortix-capture://settings?sync=nope").unwrap().sync, None);
        let t = parse_link("kortix-capture://settings?section=never").unwrap();
        assert_eq!(t.section.as_deref(), Some("never"));
        assert_eq!(parse_link("kortix-capture://settings?section=x").unwrap().section, None);
    }

    #[test]
    fn links_parse() {
        let t = parse_link("kortix-capture://timeline?t=1767225600").unwrap();
        assert_eq!(
            (t.view.as_str(), t.t_ms),
            ("timeline", Some(1_767_225_600_000))
        );
        assert_eq!(
            parse_link("kortix-capture://timeline?t=1767225600123")
                .unwrap()
                .t_ms,
            Some(1_767_225_600_123)
        );
        let s = parse_link("kortix-capture://search?q=web%20hook+sig").unwrap();
        assert_eq!(
            (s.view.as_str(), s.q.as_deref()),
            ("search", Some("web hook sig"))
        );
        assert!(parse_link("https://example.com").is_err());
        assert!(parse_link("kortix-capture://nope").is_err());
    }

    #[test]
    fn moments_parse() {
        let now = 10_000_000_000;
        assert_eq!(parse_moment("now", now).unwrap(), now);
        assert_eq!(parse_moment("20m", now).unwrap(), now - 1_200_000);
        assert_eq!(parse_moment("-2h", now).unwrap(), now - 7_200_000);
        assert_eq!(parse_moment("3d ago", now).unwrap(), now - 259_200_000);
        assert_eq!(parse_moment("1767225600", now).unwrap(), 1_767_225_600_000);
        assert!(parse_moment("2026-01-15T09:30", now).unwrap() > 1_700_000_000_000);
        assert!(parse_moment("garbage", now).is_err());
    }

    #[test]
    fn second_launch_forwards_to_fresh_lock_only() {
        let root = std::env::temp_dir().join(format!("kmem-ui-lock-{}", std::process::id()));
        let paths = MemoryPaths::at(&root);
        paths.ensure().unwrap();
        let target = Target {
            view: "search".into(),
            q: Some("x".into()),
            t_ms: None,
            sync: None,
            section: None,
        };
        assert!(
            !forward(&paths, &target).unwrap(),
            "no lock: no window running"
        );
        std::fs::write(lock_path(&paths), "1").unwrap();
        // Simulate the window consuming the request.
        let p2 = paths.clone();
        let consumer = std::thread::spawn(move || loop {
            if let Ok(b) = std::fs::read(request_path(&p2)) {
                let _ = std::fs::remove_file(request_path(&p2));
                return serde_json::from_slice::<Value>(&b).unwrap();
            }
            std::thread::sleep(Duration::from_millis(20));
        });
        assert!(forward(&paths, &target).unwrap());
        assert_eq!(consumer.join().unwrap()["q"], "x");
        let _ = std::fs::remove_dir_all(root);
    }
}
