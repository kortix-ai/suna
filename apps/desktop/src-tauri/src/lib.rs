use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};
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

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

const DEFAULT_URL: &str = "http://localhost:3000/dashboard";

fn app_url() -> String {
    std::env::var("KORTIX_DESKTOP_URL").unwrap_or_else(|_| DEFAULT_URL.to_string())
}

/// True if a URL belongs to the app itself — internal navigation that should
/// stay inside the webview (Supabase callbacks, page nav, etc.).
fn is_internal(url: &url::Url) -> bool {
    if url.scheme() == "kortix" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1")
        || host == "kortix.com"
        || host.ends_with(".kortix.com")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![set_zoom])
        .setup(|app| {
            let url = app_url().parse::<url::Url>().expect("valid KORTIX_DESKTOP_URL");
            let app_handle = app.handle().clone();

            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url),
            )
            .title("Kortix")
            .inner_size(1280.0, 820.0)
            .min_inner_size(720.0, 480.0)
            .center()
            .resizable(true)
            .decorations(true)
            .transparent(true)
            .visible(false)
            .user_agent("KortixDesktop/0.1.0")
            .on_navigation(move |url| {
                if is_internal(url) {
                    return true;
                }
                // External — open in the user's default browser. OAuth providers
                // (Google in particular) reject embedded webviews, and isolating
                // those flows means cookies stay in the user's primary browser.
                #[allow(deprecated)]
                let _ = app_handle.shell().open(url.to_string(), None);
                false
            });

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            let window = builder.build()?;

            #[cfg(target_os = "macos")]
            {
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Sidebar,
                    Some(NSVisualEffectState::Active),
                    None,
                );
            }

            // Deep links: when the OS hands us a `kortix://...` URL (auth
            // callback after OAuth completes in the system browser, magic
            // links from email, etc.), translate the path onto the app's
            // origin and navigate the webview there. The web app then runs
            // its existing /auth/callback flow inside the desktop session.
            let dl_window = window.clone();
            app.deep_link().on_open_url(move |event| {
                for incoming in event.urls() {
                    if incoming.scheme() != "kortix" {
                        continue;
                    }
                    let mut target = match app_url().parse::<url::Url>() {
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

            let _ = window.show();
            let _ = window.set_focus();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
