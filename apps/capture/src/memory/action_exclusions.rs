//! Exclusions for the action recorder: clicks, key presses, typed text and
//! action screenshots happen in front of some app, website or private window,
//! and an excluded one must leave nothing behind, exactly like a screen frame.
//!
//! [`ActionExclusions::admit`] runs where every native source converges
//! (`recording_service::guarded_action_callback`), before the raw writer and
//! the processor, so a dropped event is never written. It decides against the
//! window in front at event time, read from a [`FrontSource`]:
//!
//! - every event: the latest front window (never blocks: key events arrive on
//!   the macOS event tap, which must answer at once);
//! - a screenshot: also a front window read after it was taken, so a frame
//!   captured just as the person switches into an excluded app is dropped too.
//!
//! The effective exclusions (the person's plus the organization's) are re-read
//! when settings.json or the cached policy changes, checked every 500 ms.
//! Dropped events are counted in `<library>/actions-excluded.json`, which
//! `kortix-capture status` reports as `actions.excluded_events`.

use super::{
    exclusions::{excluded_reason, Front},
    paths::MemoryPaths,
    settings::Settings,
    store::now_ms,
};
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};

/// Where the window in front comes from.
pub trait FrontSource: Send + Sync {
    /// The latest known front window; None when unknown. Never blocks.
    fn latest(&self) -> Option<Front>;
    /// A front window read after this call began, waiting up to `max`.
    fn fresh(&self, max: Duration) -> Option<Front>;
}

/// How long a screenshot waits for a second front-window read.
const SCREENSHOT_RECHECK: Duration = Duration::from_millis(600);
/// How often the effective exclusions are checked for a change.
const SETTINGS_CHECK: Duration = Duration::from_millis(500);
/// How often the counter file is written while events are dropped.
const COUNT_WRITE: Duration = Duration::from_secs(1);

/// `<library>/actions-excluded.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Count {
    pub excluded_events: u64,
    pub last_excluded_at_ms: Option<i64>,
    pub last_reason: Option<String>,
}

fn count_path(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("actions-excluded.json")
}

fn read_count(paths: &MemoryPaths) -> Count {
    std::fs::read(count_path(paths))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

type Stamp = (Option<(SystemTime, u64)>, Option<(SystemTime, u64)>);

struct Effective {
    checked: Instant,
    stamp: Stamp,
    settings: Settings,
}

struct Counter {
    count: Count,
    written: Option<Instant>,
    dirty: bool,
}

/// The gate. One per recording session.
pub struct ActionExclusions {
    paths: MemoryPaths,
    source: Arc<dyn FrontSource>,
    effective: Mutex<Effective>,
    counter: Mutex<Counter>,
}

fn stamp(paths: &MemoryPaths) -> Stamp {
    let m = |p: std::path::PathBuf| std::fs::metadata(p).and_then(|m| Ok((m.modified()?, m.len()))).ok();
    (m(paths.settings()), m(super::policy::path(paths)))
}

fn is_screenshot(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("screenshot" | "a11y+screenshot")
    )
}

impl ActionExclusions {
    pub fn new(paths: &MemoryPaths, source: Arc<dyn FrontSource>) -> Self {
        Self {
            paths: paths.clone(),
            source,
            effective: Mutex::new(Effective {
                checked: Instant::now(),
                stamp: stamp(paths),
                settings: Settings::effective(paths),
            }),
            counter: Mutex::new(Counter {
                count: read_count(paths),
                written: None,
                dirty: false,
            }),
        }
    }

    /// The effective settings, re-read when settings.json or the policy changed.
    fn settings(&self) -> Settings {
        let mut e = self.effective.lock();
        if e.checked.elapsed() >= SETTINGS_CHECK {
            e.checked = Instant::now();
            let now = stamp(&self.paths);
            if now != e.stamp {
                e.stamp = now;
                e.settings = Settings::effective(&self.paths);
            }
        }
        e.settings.clone()
    }

    /// Keep `event` (true) or drop it unwritten (false).
    pub fn admit(&self, event: &Value) -> bool {
        let s = self.settings();
        let latest = self.source.latest();
        // Record only included fails closed: an unknown front window is not included.
        let unknown = (latest.is_none() && s.record_only_included).then_some("not_included");
        let reason = latest
            .and_then(|f| excluded_reason(&s, &f))
            .or(unknown)
            .or_else(|| {
                // The frame may show what came to front while it was taken.
                is_screenshot(event)
                    .then(|| self.source.fresh(SCREENSHOT_RECHECK))
                    .flatten()
                    .and_then(|f| excluded_reason(&s, &f))
            });
        match reason {
            None => true,
            Some(reason) => {
                self.count(reason);
                false
            }
        }
    }

    fn count(&self, reason: &str) {
        let mut c = self.counter.lock();
        c.count.excluded_events += 1;
        c.count.last_excluded_at_ms = Some(now_ms());
        c.count.last_reason = Some(reason.to_string());
        c.dirty = true;
        if c.written.is_none_or(|w| w.elapsed() >= COUNT_WRITE) {
            self.write(&mut c);
        }
    }

    fn write(&self, c: &mut Counter) {
        let path = count_path(&self.paths);
        let tmp = path.with_extension("json.tmp");
        if std::fs::create_dir_all(&self.paths.root).is_ok()
            && serde_json::to_vec(&c.count)
                .ok()
                .and_then(|b| std::fs::write(&tmp, b).ok())
                .is_some()
            && std::fs::rename(&tmp, &path).is_ok()
        {
            c.dirty = false;
            c.written = Some(Instant::now());
        }
    }

    /// Persist the counter now (it is written at most once a second otherwise).
    pub fn flush(&self) {
        let mut c = self.counter.lock();
        if c.dirty {
            self.write(&mut c);
        }
    }

    #[cfg(test)]
    fn settings_for_test(&self) -> Settings {
        self.settings()
    }
}

impl Drop for ActionExclusions {
    fn drop(&mut self) {
        self.flush();
    }
}

/// `actions` in `kortix-capture status`: events dropped because an excluded
/// app, website or private window was in front.
pub fn status(paths: &MemoryPaths) -> Value {
    let c = read_count(paths);
    json!({
        "excluded_events": c.excluded_events,
        "last_excluded_at_ms": c.last_excluded_at_ms,
        "last_reason": c.last_reason,
    })
}

/// A front window older than this is unknown (the probe stalled).
const STALE: Duration = Duration::from_secs(2);
/// Probe cadence.
const PROBE_EVERY: Duration = Duration::from_millis(150);

#[derive(Default)]
struct Reading {
    front: Option<Front>,
    at: Option<Instant>,
    generation: u64,
}

/// The front window from the capture engine's `probe` (app, page URL, title),
/// read every 150 ms on its own thread while the session runs.
pub struct ProbeFront {
    reading: Arc<(Mutex<Reading>, Condvar)>,
    stop: Arc<AtomicBool>,
}

impl ProbeFront {
    pub fn start() -> Arc<Self> {
        let reading = Arc::new((Mutex::new(Reading::default()), Condvar::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (r, s) = (reading.clone(), stop.clone());
        let spawned = std::thread::Builder::new()
            .name("kortix-actions-front".into())
            .spawn(move || probe_loop(&r, &s));
        if let Err(err) = spawned {
            tracing::warn!("action exclusions: no front-window thread: {err}");
        }
        Arc::new(Self { reading, stop })
    }
}

fn front_of(resp: &Value) -> Option<Front> {
    let app = resp.get("app")?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(Front {
        bundle_id: s(app, "bundle_id"),
        url: resp.get("url").and_then(Value::as_str).map(str::to_string),
        title: s(resp, "title"),
    })
}

fn probe_loop(reading: &(Mutex<Reading>, Condvar), stop: &AtomicBool) {
    let mut engine: Option<super::engine::Engine> = None;
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        if engine.is_none() {
            engine = super::engine::Engine::new()
                .map_err(|err| tracing::warn!("action exclusions: no capture engine: {err:#}"))
                .ok();
        }
        let front = engine.as_mut().and_then(|e| {
            e.request(
                json!({"cmd": "probe", "max_idle_seconds": 0.0}),
                Duration::from_secs(1),
            )
            .ok()
            .and_then(|resp| front_of(&resp))
        });
        {
            let mut r = reading.0.lock();
            r.front = front;
            r.at = Some(Instant::now());
            r.generation += 1;
        }
        reading.1.notify_all();
        let wait = if engine.is_some() {
            PROBE_EVERY
        } else {
            Duration::from_secs(5)
        };
        std::thread::sleep(wait.saturating_sub(started.elapsed()));
    }
}

impl FrontSource for ProbeFront {
    fn latest(&self) -> Option<Front> {
        let r = self.reading.0.lock();
        r.front
            .clone()
            .filter(|_| r.at.is_some_and(|at| at.elapsed() < STALE))
    }

    fn fresh(&self, max: Duration) -> Option<Front> {
        let deadline = Instant::now() + max;
        let mut r = self.reading.0.lock();
        let seen = r.generation;
        while r.generation == seen {
            if self.reading.1.wait_until(&mut r, deadline).timed_out() {
                return None;
            }
        }
        r.front.clone()
    }
}

impl Drop for ProbeFront {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::Arc;

    /// A front window a test sets; `fresh` returns `then` once set, else the current one.
    #[derive(Default)]
    pub struct FakeFront {
        pub now: Mutex<Option<Front>>,
        pub then: Mutex<Option<Front>>,
    }

    impl FrontSource for FakeFront {
        fn latest(&self) -> Option<Front> {
            self.now.lock().clone()
        }
        fn fresh(&self, _max: Duration) -> Option<Front> {
            self.then.lock().clone().or_else(|| self.now.lock().clone())
        }
    }

    pub fn front(bundle_id: &str, url: Option<&str>, title: &str) -> Front {
        Front {
            bundle_id: bundle_id.into(),
            url: url.map(str::to_string),
            title: title.into(),
        }
    }

    pub fn library(settings: &Settings) -> MemoryPaths {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kortix-actx-{}", uuid::Uuid::new_v4())),
        );
        settings.save(&paths).unwrap();
        paths
    }

    fn key(c: &str) -> Value {
        json!({"type": "key_down", "timestamp": 1.0, "data": {"key": c, "native_key_code": 0}})
    }

    #[test]
    fn events_in_front_of_anything_excluded_are_dropped_and_counted() {
        let mut s = Settings::default();
        s.excluded_bundle_ids = vec!["com.example.Secret".into()];
        s.excluded_domains = vec!["bank.example".into()];
        let paths = library(&s);
        let fake = Arc::new(FakeFront::default());
        let gate = ActionExclusions::new(&paths, fake.clone());
        for (f, keep) in [
            (front("com.example.secret", None, "Vault"), false),
            (front("com.1password.1password", None, "1Password"), false), // group, on by default
            (
                front(
                    "com.google.Chrome",
                    Some("https://login.bank.example/x"),
                    "Bank",
                ),
                false,
            ),
            (
                front(
                    "com.google.Chrome",
                    Some("https://news.example/"),
                    "Private Browsing — News",
                ),
                false,
            ),
            (
                front("com.google.Chrome", Some("https://news.example/"), "News"),
                true,
            ),
            (front("com.apple.TextEdit", None, "Notes"), true),
        ] {
            *fake.now.lock() = Some(f.clone());
            assert_eq!(gate.admit(&key("a")), keep, "{f:?}");
        }
        gate.flush();
        assert_eq!(status(&paths)["excluded_events"], json!(4));
        assert_eq!(status(&paths)["last_reason"], json!("private_browsing"));
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn an_unknown_front_window_keeps_the_event() {
        let paths = library(&Settings::default());
        let gate = ActionExclusions::new(&paths, Arc::new(FakeFront::default()));
        assert!(gate.admit(&key("a")));
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn record_only_included_keeps_actions_in_included_apps_and_sites_only() {
        let mut s = Settings::default();
        s.record_only_included = true;
        s.included_bundle_ids = vec!["com.tinyspeck.slackmacgap".into()];
        s.included_domains = vec!["github.com".into()];
        let paths = library(&s);
        let fake = Arc::new(FakeFront::default());
        let gate = ActionExclusions::new(&paths, fake.clone());
        assert!(!gate.admit(&key("a")), "an unknown front window is not included");
        for (f, keep) in [
            (front("com.tinyspeck.slackmacgap", None, "general"), true),
            (front("com.google.Chrome", Some("https://github.com/kortix-ai"), "PR"), true),
            (front("com.google.Chrome", Some("https://youtube.com/"), "Video"), false),
            (front("com.spotify.client", None, "Spotify"), false),
        ] {
            *fake.now.lock() = Some(f.clone());
            assert_eq!(gate.admit(&key("a")), keep, "{f:?}");
        }
        gate.flush();
        assert_eq!(status(&paths)["last_reason"], json!("not_included"));
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn a_screenshot_taken_while_switching_into_an_excluded_app_is_dropped() {
        let mut s = Settings::default();
        s.excluded_bundle_ids = vec!["com.example.Secret".into()];
        let paths = library(&s);
        let fake = Arc::new(FakeFront::default());
        *fake.now.lock() = Some(front("com.apple.TextEdit", None, "Notes"));
        *fake.then.lock() = Some(front("com.example.Secret", None, "Vault"));
        let gate = ActionExclusions::new(&paths, fake.clone());
        let shot = json!({"type": "screenshot", "timestamp": 1.0, "data": {"image": "x"}});
        let ax = json!({"type": "a11y+screenshot", "timestamp": 1.0, "data": {"image": "x"}});
        assert!(!gate.admit(&shot));
        assert!(!gate.admit(&ax));
        // A key event is decided by the latest front window alone (it never waits).
        assert!(gate.admit(&key("a")));
        *fake.then.lock() = None;
        assert!(gate.admit(&shot));
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn a_new_exclusion_applies_without_a_new_session() {
        let paths = library(&Settings::default());
        let fake = Arc::new(FakeFront::default());
        *fake.now.lock() = Some(front("com.example.Late", None, "Late"));
        let gate = ActionExclusions::new(&paths, fake);
        assert!(gate.admit(&key("a")));
        super::super::exclusions::set(
            &paths,
            &super::super::exclusions::Target::App("com.example.Late".into()),
            true,
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert!(gate
            .settings_for_test()
            .excluded_bundle_ids
            .contains(&"com.example.Late".to_string()));
        assert!(!gate.admit(&key("a")));
        let _ = std::fs::remove_dir_all(&paths.root);
    }
}
