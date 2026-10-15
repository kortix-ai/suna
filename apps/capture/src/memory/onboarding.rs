//! First-run onboarding for a personal install with nothing connected.
//!
//! The window opens on onboarding (not the timeline) right after the install, and on any
//! later open until the person connects, skips, or the computer is managed. Steps: allow
//! Screen Recording (macOS, if missing), sign in with Kortix (the primary action), or use an
//! S3 bucket, or skip. Done and skipped are remembered. Signing out brings it back on the
//! next open, but never forces a window at login.

use super::paths::MemoryPaths;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Nothing decided yet: the installer or the first login opens the window once.
    Fresh,
    /// The person signed out: onboarding shows on the next open, not at login.
    SignedOut,
    Done,
    Skipped,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            State::Fresh => "fresh",
            State::SignedOut => "signed_out",
            State::Done => "done",
            State::Skipped => "skipped",
        }
    }
    pub fn parse(s: &str) -> Option<State> {
        match s {
            "fresh" => Some(State::Fresh),
            "signed_out" => Some(State::SignedOut),
            "done" => Some(State::Done),
            "skipped" => Some(State::Skipped),
            _ => None,
        }
    }
}

fn file(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("onboarding.json")
}

pub fn state(paths: &MemoryPaths) -> State {
    std::fs::read(file(paths))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["state"].as_str().and_then(State::parse))
        .unwrap_or(State::Fresh)
}

pub fn set(paths: &MemoryPaths, st: State) {
    let _ = paths.ensure();
    let _ = std::fs::write(file(paths), json!({"state": st.name()}).to_string());
}

/// Onboarding shows only on a personal install with nothing connected: not managed, no IT
/// configuration, sync not on, and not finished or skipped.
pub fn needed(st: State, managed: bool, it_configured: bool, synced: bool) -> bool {
    !managed && !it_configured && !synced && matches!(st, State::Fresh | State::SignedOut)
}

pub fn needed_now(paths: &MemoryPaths) -> bool {
    let (managed, _) = super::managed::enrollment_value(paths);
    needed(
        state(paths),
        managed,
        super::managed::machine_service_installed(),
        super::settings::Settings::load(paths).sync.enabled,
    )
}

/// The installer or the first login asks to open the window once: true the first time only,
/// and only while onboarding is needed and was never decided.
pub fn force_open_once(paths: &MemoryPaths) -> bool {
    let marker = paths.root.join("onboarding-opened");
    if marker.exists() || state(paths) != State::Fresh || !needed_now(paths) {
        return false;
    }
    let _ = paths.ensure();
    let _ = std::fs::write(marker, b"1");
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboarding_is_for_a_personal_install_with_nothing_connected() {
        assert!(needed(State::Fresh, false, false, false));
        assert!(needed(State::SignedOut, false, false, false));
        assert!(!needed(State::Done, false, false, false), "done stays done");
        assert!(!needed(State::Skipped, false, false, false), "skip stays skipped");
        assert!(!needed(State::Fresh, true, false, false), "a managed computer has none");
        assert!(!needed(State::Fresh, false, true, false), "IT configured: preconfigured, silent");
        assert!(!needed(State::Fresh, false, false, true), "something is connected");
    }

    #[test]
    fn state_is_remembered_and_the_first_open_is_forced_once() {
        let dir = std::env::temp_dir().join(format!("kcap-onb-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        assert_eq!(state(&paths), State::Fresh);
        set(&paths, State::Skipped);
        assert_eq!(state(&paths), State::Skipped);
        set(&paths, State::SignedOut);
        assert_eq!(state(&paths), State::SignedOut);
        assert!(!force_open_once(&paths), "never forced at login after a sign-out");
        set(&paths, State::Fresh);
        if !super::super::managed::machine_service_installed() {
            assert!(force_open_once(&paths));
            assert!(!force_open_once(&paths), "once");
        }
        assert_eq!(State::parse("nope"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
