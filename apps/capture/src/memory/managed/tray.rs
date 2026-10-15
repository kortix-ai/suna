//! `kortix-capture tray`: the notification-area / menu-bar icon, the same code
//! on Windows (notification area), macOS (menu bar) and Linux
//! (AppIndicator/StatusNotifier, built only with the `memory-ui` feature, which
//! brings the gtk and appindicator system libraries).
//!
//! The menu: the recording status, the sync status, "Open Kortix Capture", and on a
//! computer the person set up, the pauses and "Resume". There is no Quit. Signing in
//! to Kortix lives in the window, under Sync. On a managed computer the menu names
//! the organization and has no Pause: the person cannot end a recording
//! the organization runs; the machine service's `service run --managed` owns it and
//! stops it.
//!
//! The icon is a ring with a dot while recording and a plain ring otherwise.
//! macOS gets a template image (black on transparent) that follows the light or
//! dark menu bar; Windows and Linux get a white glyph on a dark tile.
//!
//! Built on `tray-icon` + `tao`'s event loop, so one code path serves all three
//! platforms instead of per-OS tray APIs.
//!
//! One tray runs per library (`tray.lock`); a second one exits at once. At the
//! start of each session the tray shows the organization's notice, only if its policy
//! set one, once per notice text ([`super::notify`]). The tray never ends the recorder.

use super::{mark_notice_shown, notify, pending_notice, tray_text, TrayAction};
use crate::memory::paths::MemoryPaths;
use crate::memory::settings::Settings;
use anyhow::{Context, Result};
use std::time::{Duration, Instant};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

#[cfg(target_os = "macos")]
const ICON_RECORDING: &[u8] = include_bytes!("../../../assets/icons/trayTemplate@2x.png");
#[cfg(target_os = "macos")]
const ICON_IDLE: &[u8] = include_bytes!("../../../assets/icons/trayIdleTemplate@2x.png");
#[cfg(not(target_os = "macos"))]
const ICON_RECORDING: &[u8] = include_bytes!("../../../assets/icons/tray.png");
#[cfg(not(target_os = "macos"))]
const ICON_IDLE: &[u8] = include_bytes!("../../../assets/icons/trayIdle.png");
/// macOS draws a template image in the menu bar's own color.
const TEMPLATE: bool = cfg!(target_os = "macos");
const OPEN: &str = "kortix.open";
const SETTINGS: &str = "kortix.settings";
const STATUS: &str = "kortix.status";
const PAUSE: &str = "kortix.pause";
const RESUME: &str = "kortix.resume";
const PAUSE_TOMORROW: &str = "kortix.pause.tomorrow";
const PAUSE_FOREVER: &str = "kortix.pause.forever";
/// How often the tray looks for a notice it has not shown yet.
const NOTICE_POLL: Duration = Duration::from_secs(5);
/// How long sync stays broken before the tray notifies.
const SYNC_ALERT_AFTER: Duration = Duration::from_secs(5 * 60);

/// The icon for a state: the PNG decoded to the RGBA a tray icon takes.
fn icon(recording: bool) -> Result<Icon> {
    let bytes = if recording { ICON_RECORDING } else { ICON_IDLE };
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .context("decode the tray icon")?
        .to_rgba8();
    let (w, h) = image.dimensions();
    Icon::from_rgba(image.into_raw(), w, h).context("build the tray icon")
}

fn recording(paths: &MemoryPaths) -> bool {
    crate::memory::service::heartbeat(paths)["recorder"]["running"] == true
}

/// What the tray shows now.
#[derive(PartialEq)]
struct View {
    recording: bool,
    paused: bool,
    status: String,
    /// The sync line: "Synced 2 min ago", "Off. Recordings stay on this computer."
    sync: String,
    /// Sync is on and broken: disconnected, refused, or nothing reached the bucket for 30 min.
    sync_broken: bool,
    tooltip: String,
    managed: bool,
    /// Screen Recording is missing: the status line asks for it when clicked.
    needs_permission: bool,
}

/// A Wayland session: the recorder cannot capture it (X11 only). The engine's own test.
fn wayland() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_lowercase();
    cfg!(target_os = "linux")
        && (session == "wayland"
            || (std::env::var_os("WAYLAND_DISPLAY").is_some() && session != "x11"))
}

fn view(paths: &MemoryPaths) -> View {
    let rec = recording(paths);
    let text = tray_text(paths, rec);
    let (managed, _) = super::enrollment_value(paths);
    let signed_in = crate::memory::sync::issuer::registration(paths)
        .is_some_and(|r| r.rejected_at_ms.is_none());
    let state = crate::memory::cli::recording_state(paths);
    let paused_until = Settings::load(paths)
        .paused_until_ms
        .filter(|t| *t > crate::memory::store::now_ms());
    let mut status = super::tray_status(&text, managed, &state, paused_until);
    if wayland() && state != "paused" {
        status = "Not recording: a Wayland session (Kortix Capture records X11 sessions)".into();
    }
    let sync = crate::memory::cli::sync_view(paths);
    View {
        recording: state == "recording",
        sync_broken: sync.tone == "error",
        paused: paused_until.is_some() || !Settings::load(paths).recording_enabled,
        tooltip: if sync.tone == "error" {
            format!("Kortix Capture — {}", sync.line)
        } else if managed || signed_in {
            text.tip
        } else {
            format!("Kortix Capture — {}", status.to_lowercase_first_char())
        },
        needs_permission: state == "permission_missing",
        status,
        managed,
        sync: sync.line,
    }
}

trait LowerFirstChar {
    fn to_lowercase_first_char(&self) -> String;
}

impl LowerFirstChar for String {
    fn to_lowercase_first_char(&self) -> String {
        let mut c = self.chars();
        match c.next() {
            Some(f) => f.to_lowercase().chain(c).collect(),
            None => String::new(),
        }
    }
}

/// The menu for `v`, and its status item (updated in place every refresh).
fn menu(v: &View) -> (Menu, MenuItem, MenuItem) {
    let menu = Menu::new();
    // The status line is a plain label, except while Screen Recording is missing: then a click asks.
    let status = MenuItem::with_id(STATUS, &v.status, v.needs_permission, None);
    let sync = MenuItem::new(&v.sync, false, None);
    let _ = menu.append(&status);
    let _ = menu.append(&sync);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&MenuItem::with_id(OPEN, "Open Kortix Capture", true, None));
    let _ = menu.append(&MenuItem::with_id(SETTINGS, "Settings…", true, None));
    for action in super::tray_actions(v.managed, v.paused) {
        match action {
            TrayAction::Pause => {
                let _ = menu.append(&MenuItem::with_id(PAUSE, "Pause for 1 hour", true, None));
            }
            TrayAction::PauseTomorrow => {
                let _ = menu.append(&MenuItem::with_id(PAUSE_TOMORROW, "Pause until tomorrow", true, None));
            }
            TrayAction::PauseForever => {
                let _ = menu.append(&MenuItem::with_id(PAUSE_FOREVER, "Pause until I resume", true, None));
            }
            TrayAction::Resume => {
                let _ = menu.append(&MenuItem::with_id(RESUME, "Resume", true, None));
            }
        }
    }
    (menu, status, sync)
}

/// Start the window. On macOS a window is started through LaunchServices (`open -n`): the
/// click on the menu-bar icon then counts as the person's launch, and the new accessory window
/// comes to the front. A plain child process would open behind the other apps.
fn spawn_window(args: &[&str]) {
    #[cfg(target_os = "macos")]
    if let Ok(exe) = std::env::current_exe() {
        // `<bundle>.app/Contents/MacOS/<exe>` -> `<bundle>.app`
        if let Some(bundle) = exe.ancestors().nth(3).filter(|b| b.extension().is_some_and(|e| e == "app")) {
            let _ = std::process::Command::new("/usr/bin/open")
                .args(["-n", "-a"])
                .arg(bundle)
                .arg("--args")
                .args(args)
                .spawn();
            return;
        }
    }
    spawn_self(args);
}

fn spawn_self(args: &[&str]) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = crate::os_proc::no_window(&mut std::process::Command::new(exe))
            .args(args)
            .spawn();
    }
}

/// Set the tray's icon for the state (and, on macOS, keep it a template image).
fn show_icon(tray: &TrayIcon, recording: bool) {
    match icon(recording) {
        Ok(i) => {
            let _ = tray.set_icon(Some(i));
            #[cfg(target_os = "macos")]
            tray.set_icon_as_template(TEMPLATE);
            tracing::info!(
                "[tray] icon template={TEMPLATE} state={}",
                if recording { "recording" } else { "idle" }
            );
        }
        Err(e) => tracing::error!("tray icon: {e:#}"),
    }
}

pub fn run(paths: &MemoryPaths) -> Result<()> {
    // One tray per library: the second one has nothing to add.
    let Some(_lock) = super::tray_lock(paths).context("tray.lock")? else {
        return Ok(());
    };
    let paths = paths.clone();
    // Fail at once on a broken icon, not at the first state change.
    icon(false)?;
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<()>::with_user_event().build();
    // A one-second heartbeat wakes the loop: the refresh, the notice and the
    // menu clicks (muda's channel does not wake it) do not wait on a platform timer.
    let proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        while proxy.send_event(()).is_ok() {
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    // A menu-bar item without a Dock icon.
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }

    // The tray is created after the event loop starts: macOS and Linux need a
    // running loop first. Held here so it lives as long as the loop.
    let mut tray: Option<TrayIcon> = None;
    let mut status_item: Option<(MenuItem, MenuItem)> = None;
    let mut shown = view(&paths);
    let mut next_refresh = Instant::now() + NOTICE_POLL;
    // Sync broken since (this process saw it), and whether the person was told.
    let mut broken_since: Option<Instant> = None;
    let mut told = false;

    event_loop.run(move |event, _target, control_flow| {
        // The event loop owns the lock for the life of the process.
        let _ = &_lock;
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                tracing::info!("[tray] started");
                let (m, status, sync) = menu(&shown);
                let builder = TrayIconBuilder::new()
                    .with_icon(icon(shown.recording).expect("tray icon"))
                    .with_icon_as_template(TEMPLATE)
                    .with_tooltip(&shown.tooltip)
                    .with_menu(Box::new(m));
                match builder.build() {
                    Ok(t) => {
                        tracing::info!(
                            "[tray] icon template={TEMPLATE} state={}",
                            if shown.recording { "recording" } else { "idle" }
                        );
                        tray = Some(t);
                        status_item = Some((status, sync));
                    }
                    Err(e) => {
                        tracing::error!("tray: {e}");
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            // The app's Dock or Finder icon, clicked while it runs: show the window.
            Event::Reopen { .. } => spawn_window(&["ui"]),
            Event::UserEvent(()) if Instant::now() >= next_refresh => {
                next_refresh = Instant::now() + NOTICE_POLL;
                let v = view(&paths);
                // The organization's notice, if its policy set one: once per notice text.
                if let Some((title, body, hash)) = pending_notice(&paths) {
                    mark_notice_shown(&paths, &hash);
                    notify::show(&title, &body);
                }
                // Sync broken for 5 min (not a wake-up blip): say so once, and once when it is back.
                if v.sync_broken {
                    let since = *broken_since.get_or_insert_with(Instant::now);
                    if !told && since.elapsed() >= SYNC_ALERT_AFTER {
                        notify::show("Kortix Capture is not syncing", &v.sync);
                        told = true;
                    }
                } else {
                    if told {
                        notify::show("Kortix Capture is syncing again", &v.sync);
                    }
                    broken_since = None;
                    told = false;
                }
                if let Some(t) = &tray {
                    if v.recording != shown.recording {
                        show_icon(t, v.recording);
                    }
                    if (v.managed, v.paused, v.needs_permission)
                        != (shown.managed, shown.paused, shown.needs_permission)
                    {
                        // Enrolled or paused since: the menu changes, not just its words.
                        let (m, status, sync) = menu(&v);
                        t.set_menu(Some(Box::new(m)));
                        status_item = Some((status, sync));
                    } else if let Some((status, sync)) = &status_item {
                        status.set_text(&v.status);
                        sync.set_text(&v.sync);
                    }
                    let _ = t.set_tooltip(Some(&v.tooltip));
                }
                shown = v;
            }
            _ => {}
        }

        // Menu clicks arrive on muda's channel, drained every wake-up.
        while let Ok(menu_event) = MenuEvent::receiver().try_recv() {
            match menu_event.id.as_ref() {
                OPEN => spawn_window(&["ui"]),
                SETTINGS => spawn_window(&["open", "kortix-capture://settings"]),
                STATUS => crate::memory::cli::grant_permissions(&paths),
                PAUSE | PAUSE_TOMORROW | PAUSE_FOREVER | RESUME => {
                    spawn_self(match menu_event.id.as_ref() {
                        PAUSE => &["pause", "--for", "1h"],
                        PAUSE_TOMORROW => &["pause", "--for", "tomorrow"],
                        PAUSE_FOREVER => &["pause", "--for", "forever"],
                        _ => &["resume"],
                    });
                    next_refresh = Instant::now() + Duration::from_secs(2);
                }
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_tray_icons_decode() {
        for recording in [true, false] {
            let i = icon(recording);
            assert!(i.is_ok(), "{i:?}");
        }
    }
}
