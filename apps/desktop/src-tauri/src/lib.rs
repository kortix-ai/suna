use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
#[allow(deprecated)]
use tauri_plugin_shell::ShellExt;

/// Set the webview zoom factor (browser-style Cmd+/Cmd-/Cmd0). Clamped to
/// [0.5, 3.0] — same range Chrome/Safari use. The web app persists the
/// chosen value in localStorage and reapplies it on each launch.
#[tauri::command]
fn set_zoom(window: WebviewWindow, scale: f64) -> Result<(), String> {
    window
        .set_zoom(scale.clamp(0.5, 3.0))
        .map_err(|e| e.to_string())
}

/// Open a URL in the user's default external browser. Used by the JS
/// shim that overrides `window.open` and intercepts `target="_blank"`
/// clicks so they never spawn a second Tauri window.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if url.is_empty() {
        return Ok(());
    }
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// JS shim injected into every page load. Two responsibilities:
///   1. Override `window.open` and `target="_blank"|"_new"` clicks so they
///      route through `open_external` (system browser) — no second Tauri
///      window can ever be created.
///   2. Wire window-drag zones via mousedown → `startDragging()`. CSS
///      `-webkit-app-region: drag` is not reliably honored in Tauri's
///      WKWebView, so we drive dragging explicitly. Drag fires only when
///      the mousedown target lives inside a designated zone (tab bar,
///      sidebar headers, sidebar wrappers, the 6px top-edge strip) AND
///      no ancestor up to that zone is interactive.
const WINDOW_OPEN_SHIM: &str = r#"
(function() {
  if (window.__kortixWindowShim) return;
  window.__kortixWindowShim = true;

  /* ─── window.open / target=_blank → open_external ─────────────────── */
  /* These ALWAYS route to the system browser — even for internal hosts.
     The webview itself can navigate to product/preview URLs freely (handled by
     the host/path checks in the Rust on_navigation callback so iframes load), but
     "open in a new tab/window" intent should always pop out to the user's
     real browser. Tauri can't open a real second browser tab, so the only
     sensible target is the OS default. */
  var openExternal = function(url) {
    try {
      var t = window.__TAURI__;
      if (t && t.core && typeof t.core.invoke === 'function') {
        t.core.invoke('open_external', { url: String(url) });
      }
    } catch (e) {}
  };
  window.open = function(url) {
    if (url) openExternal(url);
    return null;
  };
  document.addEventListener('click', function(e) {
    if (e.defaultPrevented) return;
    var node = e.target;
    while (node && node.nodeType === 1 && node.tagName !== 'A') node = node.parentNode;
    if (!node || node.tagName !== 'A') return;
    var target = node.getAttribute('target');
    if (target !== '_blank' && target !== '_new') return;
    var href = node.href;
    if (!href) return;
    e.preventDefault();
    openExternal(href);
  }, true);

  /* ─── window dragging ─────────────────────────────────────────────── */
  var DRAG_ZONES = [
    '[role="tablist"]',
    '[data-sidebar="header"]',
    '[data-sidebar="sidebar"]',
    '.kx-desktop-drag',
    '.kx-desktop-chrome'
  ].join(',');
  var INTERACTIVE_TAGS = {
    BUTTON: 1, A: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1,
    VIDEO: 1, AUDIO: 1, IFRAME: 1, LABEL: 1, SUMMARY: 1
  };
  var startDrag = function() {
    try {
      var t = window.__TAURI__;
      if (t && t.window && typeof t.window.getCurrentWindow === 'function') {
        t.window.getCurrentWindow().startDragging();
      }
    } catch (e) {}
  };
  /* Page-agnostic top strip: ANY mousedown in the top 32px of the window
     is a drag candidate, so users can grab the title-bar zone on pages
     with no sidebar/tablist (e.g. /instances, /auth). */
  var TOP_STRIP_PX = 32;
  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var target = e.target;
    if (!target || target.nodeType !== 1) return;
    var inTopStrip = e.clientY <= TOP_STRIP_PX;
    var zone = target.closest && target.closest(DRAG_ZONES);
    if (!zone && !inTopStrip) return;
    /* Walk from target up to (but not past) the drag zone (or document
       body when only the top-strip rule matched). If any ancestor along
       the way is interactive, let the click happen. */
    var stopAt = zone || document.body;
    var node = target;
    while (node && node !== stopAt) {
      if (INTERACTIVE_TAGS[node.tagName]) return;
      if (node.matches) {
        if (node.matches('[role="button"]')) return;
        if (node.matches('[role="tab"]')) return;
        if (node.matches('[role="link"]')) return;
        if (node.matches('[role="menuitem"]')) return;
        if (node.matches('[role="textbox"]')) return;
        if (node.matches('[contenteditable]')) return;
        if (node.matches('[data-no-drag]')) return;
      }
      node = node.parentNode;
    }
    startDrag();
  });
})();
"#;

#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};

const DEFAULT_URL: &str = match option_env!("KORTIX_DESKTOP_DEFAULT_URL") {
    Some(url) => url,
    None => "http://localhost:3000/projects",
};

/// The compile-time / env base URL, ignoring any user override. Precedence:
/// `KORTIX_DESKTOP_URL` env var → `KORTIX_DESKTOP_DEFAULT_URL` baked at build →
/// localhost fallback.
fn app_url() -> String {
    std::env::var("KORTIX_DESKTOP_URL").unwrap_or_else(|_| DEFAULT_URL.to_string())
}

/// Path to the persisted frontend-URL override (one line, in the app config
/// dir). Present only when the user has explicitly chosen a non-default URL.
fn url_override_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("frontend_url"))
}

fn read_url_override(app: &AppHandle) -> Option<String> {
    let raw = std::fs::read_to_string(url_override_path(app)?).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn write_url_override(app: &AppHandle, url: &str) -> Result<(), String> {
    let path = url_override_path(app).ok_or("no config dir available")?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, url).map_err(|e| e.to_string())
}

fn clear_url_override(app: &AppHandle) {
    if let Some(path) = url_override_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// The effective frontend URL the desktop window should load. A persisted user
/// override (set via the native menu or `set_frontend_url`) wins over the
/// env/compile-time `app_url()`.
fn resolve_app_url(app: &AppHandle) -> String {
    read_url_override(app).unwrap_or_else(app_url)
}

/// Navigate the main window to `url` (a full page load via `location.replace`).
fn navigate_main_window(app: &AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(encoded) = serde_json::to_string(url) {
            let _ = window.eval(&format!("window.location.replace({encoded})"));
        }
        let _ = window.set_focus();
    }
}

/// Preset frontend URLs offered in the hidden, nested "Frontend URL" menu so the
/// backend the desktop app points at can be switched without a rebuild.
const PRESET_PROD: &str = "https://kortix.com/projects";
const PRESET_DEV: &str = "https://dev.kortix.com/projects";
const PRESET_LOCAL: &str = "http://localhost:3000/projects";

/// Effective frontend URL (so the "Custom URL…" dialog can prefill it).
#[tauri::command]
fn get_frontend_url(app: AppHandle) -> String {
    resolve_app_url(&app)
}

/// Persist a custom frontend URL (for self-hosting) and reload the window onto
/// it. Stored locally in the app config dir so it survives relaunches. Validated
/// as http(s) so a typo can't strand the window on an unloadable scheme.
#[tauri::command]
fn set_frontend_url(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".into());
    }
    // Be lenient for self-hosters who type a bare host (e.g. "kortix.acme.com"
    // or "localhost:3000"): assume https when no scheme is given.
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = candidate
        .parse::<url::Url>()
        .map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("URL must use http or https".into());
    }
    if parsed.host_str().is_none() {
        return Err("URL is missing a host".into());
    }
    write_url_override(&app, &candidate)?;
    navigate_main_window(&app, &candidate);
    Ok(())
}

/// Hosts that serve user/sandbox content — sandbox preview subdomains and
/// tunnels. These ALWAYS load inside the webview; they're product surfaces,
/// not marketing.
///
/// `*.localhost` is critical: sandbox preview URLs use the pattern
/// `http://p{port}-{sandboxId}.localhost:{backendPort}/...`. Without the
/// suffix match these would be punted to the user's system browser instead of
/// loading in the in-app Browser tab. Note `localhost` itself (the dev app
/// shell) does NOT match `.localhost`, so it's handled by `is_main_app_host`.
fn is_preview_host(host: &str) -> bool {
    host.ends_with(".localhost")
        || host == "kortix.cloud"
        || host.ends_with(".kortix.cloud")
        || host == "justavps.com"
        || host.ends_with(".justavps.com")
}

/// The app-shell hosts that serve BOTH the product and the marketing site.
/// On these we only allow product/auth paths to render in-app (see
/// `is_app_path`); everything else (marketing homepage, docs, blog, legal,
/// help, …) is opened in the user's real browser.
fn is_main_app_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "kortix.com") || host.ends_with(".kortix.com")
}

/// Product + auth route prefixes allowed to render inside the desktop window.
/// The desktop app is a pure logged-in surface — anything not listed here
/// (marketing, docs, blog, legal, help, share, …) opens in the user's browser.
///
/// MUST stay in sync with `DESKTOP_ALLOWED_ROUTES` in
/// `apps/web/src/middleware.ts`, which is the server-side authority.
fn is_app_path(path: &str) -> bool {
    if path == "/auth" || path.starts_with("/auth/") {
        return true;
    }
    const ALLOWED: &[&str] = &[
        "/projects",
        "/accounts",
        "/invites",
        "/admin",
        "/setup",
        "/connectors",
        "/oauth",
        "/checkout",
        "/tunnel",
        "/github",
        "/cli",
        "/templates",
        "/maintenance",
        "/countryerror",
        "/debug",
    ];
    ALLOWED.iter().any(|prefix| {
        path == *prefix
            || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance MUST be the first plugin. When the OS dispatches a
        // `kortix://...` deep link (typically after OAuth completes in the
        // user's browser), without this guard macOS LaunchServices may spawn
        // a fresh copy of the dev binary instead of routing to the running
        // one — leaving the original window stuck on its loading state and
        // a new window booting from scratch.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        // Persist ONLY the maximized flag between launches. We deliberately
        // do NOT persist position or size — both have caused real problems:
        //   - Stale size restored a tiny ~548×344 window.
        //   - Stale position restored a Y of -990 (window off-screen on a
        //     disconnected monitor → "white screen" because there was no
        //     visible window at all).
        // Every launch re-centers at the forced launch size below; any
        // post-launch resize/move the user does is ephemeral, which is
        // a perfectly fine trade for never starting in a broken state.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            set_zoom,
            open_external,
            get_frontend_url,
            set_frontend_url
        ])
        .setup(|app| {
            // Honor a persisted frontend-URL override (native menu / settings)
            // before falling back to the env/compile-time default.
            let url = resolve_app_url(app.handle())
                .parse::<url::Url>()
                .expect("valid frontend URL");
            let app_handle = app.handle().clone();

            // Hidden, nested "Frontend URL" menu so the backend the app points at
            // can be switched without a rebuild — tucked INSIDE the first app menu
            // ("Kortix" on macOS) rather than shown as a top-level menu. Built on
            // the default menu so the standard items (copy/paste/⌘Q/…) survive.
            {
                let h = app.handle();
                let menu = Menu::default(h)?;
                let frontend_menu = Submenu::with_items(
                    h,
                    "Frontend URL",
                    true,
                    &[
                        &MenuItem::with_id(h, "frontend_prod", "Production (kortix.com)", true, None::<&str>)?,
                        &MenuItem::with_id(h, "frontend_dev", "Dev (dev.kortix.com)", true, None::<&str>)?,
                        &MenuItem::with_id(h, "frontend_local", "Local (localhost:3000)", true, None::<&str>)?,
                        &PredefinedMenuItem::separator(h)?,
                        &MenuItem::with_id(h, "frontend_custom", "Custom URL…", true, None::<&str>)?,
                        &MenuItem::with_id(h, "frontend_reset", "Reset to Default", true, None::<&str>)?,
                    ],
                )?;
                // Nest under the first top-level submenu (the "Kortix" app menu on
                // macOS); fall back to a top-level entry if there isn't one.
                let nested = menu.items()?.into_iter().find_map(|item| match item {
                    MenuItemKind::Submenu(sub) => Some(sub),
                    _ => None,
                });
                match nested {
                    Some(parent) => {
                        parent.append(&PredefinedMenuItem::separator(h)?)?;
                        parent.append(&frontend_menu)?;
                    }
                    None => menu.append(&frontend_menu)?,
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| match event.id().0.as_str() {
                    "frontend_prod" => {
                        let _ = write_url_override(app, PRESET_PROD);
                        navigate_main_window(app, PRESET_PROD);
                    }
                    "frontend_dev" => {
                        let _ = write_url_override(app, PRESET_DEV);
                        navigate_main_window(app, PRESET_DEV);
                    }
                    "frontend_local" => {
                        let _ = write_url_override(app, PRESET_LOCAL);
                        navigate_main_window(app, PRESET_LOCAL);
                    }
                    "frontend_custom" => {
                        // Native menus can't take text input — ask the web layer to
                        // pop a tiny prompt, which calls back via `set_frontend_url`.
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w
                                .eval("window.dispatchEvent(new CustomEvent('kortix-open-frontend-url'))");
                            let _ = w.set_focus();
                        }
                    }
                    "frontend_reset" => {
                        clear_url_override(app);
                        let target = app_url();
                        navigate_main_window(app, &target);
                    }
                    _ => {}
                });
            }

            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url),
            )
            .title("Kortix")
            .inner_size(1440.0, 920.0)
            .min_inner_size(720.0, 480.0)
            .center()
            .resizable(true)
            .decorations(true)
            .visible(false)
            // Browser-like user agent so server-side and 3rd-party libs that
            // sniff for `Mozilla/Safari` don't treat the desktop webview as a
            // bot/non-browser. We keep the `KortixDesktop/0.1.0` token
            // appended so middleware/`isDesktop()` checks still match.
            .user_agent(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                 AppleWebKit/605.1.15 (KHTML, like Gecko) \
                 Version/17.0 Safari/605.1.15 KortixDesktop/0.1.0",
            )
            // Disable Tauri's native OS drag-drop interceptor so HTML5
            // dragenter/dragover/drop events reach the webview. Without this
            // the chat input (and any other dropzone) never sees a file drop
            // — the OS hands the drop to Tauri's handler and the page is
            // none the wiser.
            .disable_drag_drop_handler()
            // Opaque window. We previously used transparent(true) + vibrancy,
            // but in the bundled .app (where this MUST run on macOS so the
            // OS dispatches `kortix://` to it) the layering renders the
            // webview as a blank white surface. Opaque + a subtle dark
            // background (set on <body> in CSS for desktop) is reliable.
            .initialization_script(WINDOW_OPEN_SHIM)
            .on_navigation(move |url| {
                // Deep-link callbacks (kortix://) are translated + loaded by the
                // deep-link handler below; allow them through.
                if url.scheme() == "kortix" {
                    return true;
                }
                let host = url.host_str().unwrap_or("");

                // Sandbox previews / tunnels: user content, always in-app.
                if is_preview_host(host) {
                    return true;
                }

                // App-shell host: ONLY the logged-in product + auth pages render
                // in the desktop window. Marketing (homepage, blog, pricing,
                // careers, legal, …), docs, help and share pages open in the
                // user's real browser — the desktop app is a pure product
                // surface. Docs links therefore open "in a new tab".
                if is_main_app_host(host) && is_app_path(url.path()) {
                    return true;
                }

                // Everything else — marketing/docs on the app host, or any truly
                // external URL (OAuth providers like Google reject embedded
                // webviews; outbound links) — opens in the user's default
                // browser instead of inside the app window.
                #[allow(deprecated)]
                let _ = app_handle.shell().open(url.to_string(), None);
                false
            });

            #[cfg(target_os = "macos")]
            {
                // Push the OS traffic lights down so they sit at the vertical
                // center of our 40px tab bar. wry's `inset_traffic_lights`
                // treats y as extra title-bar height ABOVE the button cluster
                // (the buttons stay anchored near the top of the title-bar
                // view), so getting visible movement requires a chunkier y.
                builder = builder
                    .title_bar_style(TitleBarStyle::Overlay)
                    .hidden_title(true)
                    // Center the ~52px traffic-light cluster horizontally within
                    // the 72px collapsed sidebar rail so it lines up with the
                    // centered sidebar logo/icon column ((72-52)/2 = 10). On the
                    // expanded sidebar this reads as a normal left inset.
                    .traffic_light_position(LogicalPosition::new(10.0, 22.0));
            }

            let window = builder.build()?;

            // Force a sensible launch size on EVERY startup. The
            // window-state plugin restores prior size before this runs;
            // we override unconditionally to ~85% of the primary monitor
            // (logical pixels), clamped to [1280, 1700] × [820, 1080], or
            // a safe 1440×920 fallback if the monitor can't be queried.
            // Any manual resize the user does after launch is still
            // persisted by the plugin — but we always reset on next open
            // so the app never starts in a tiny window.
            let (launch_w, launch_h) = window
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| {
                    let s = m.scale_factor().max(1.0);
                    let w = (m.size().width as f64 / s) * 0.85;
                    let h = (m.size().height as f64 / s) * 0.85;
                    (w.clamp(1280.0, 1700.0), h.clamp(820.0, 1080.0))
                })
                .unwrap_or((1440.0, 920.0));
            let _ = window.set_size(tauri::LogicalSize::new(launch_w, launch_h));
            let _ = window.center();

            // Deep links: when the OS hands us a `kortix://...` URL (auth
            // callback after OAuth completes in the system browser, magic
            // links from email, etc.), translate the path onto the app's
            // origin and navigate the webview there. The web app then runs
            // its existing /auth/callback flow inside the desktop session.
            let dl_window = window.clone();
            let dl_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for incoming in event.urls() {
                    if incoming.scheme() != "kortix" {
                        continue;
                    }
                    let mut target = match resolve_app_url(&dl_handle).parse::<url::Url>() {
                        Ok(u) => u,
                        Err(_) => continue,
                    };
                    // kortix://auth/callback?code=...  →  <app_url>/auth/callback?code=...
                    let path = format!(
                        "/{}{}",
                        incoming.host_str().unwrap_or(""),
                        incoming.path()
                    );
                    let path = path.trim_end_matches('/').to_string();
                    target.set_path(if path.is_empty() { "/" } else { &path });
                    target.set_query(incoming.query());
                    let nav = serde_json::to_string(&target.to_string()).unwrap();
                    let _ = dl_window.eval(&format!("window.location.replace({nav})"));
                    let _ = dl_window.set_focus();
                }
            });

            // Register the kortix:// scheme at runtime on platforms that need
            // it (Linux dev mode). macOS + Windows bake it into the bundle via
            // `plugins.deep-link.schemes` in tauri.conf.json.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                let _ = app.deep_link().register("kortix");
            }

            // Last-line defense: any time Tauri internally creates a new
            // webview window, close it unless its label is "main". Catches
            // anything the JS `window.open` shim missed.
            let close_handle = app.handle().clone();
            app.listen_any("tauri://webview-created", move |event| {
                #[derive(serde::Deserialize)]
                struct Payload { label: String }
                if let Ok(p) = serde_json::from_str::<Payload>(event.payload()) {
                    if p.label != "main" {
                        if let Some(w) = close_handle.get_webview_window(&p.label) {
                            let _ = w.close();
                        }
                        if let Some(main) = close_handle.get_webview_window("main") {
                            let _ = main.set_focus();
                        }
                    }
                }
            });

            let _ = window.show();
            let _ = window.set_focus();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
