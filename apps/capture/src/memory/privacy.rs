//! Shared policy for privacy-safe keyboard/mouse activity in the combined app.
//! Action text and visuals are concealed; screen memory uses finer PII masks.
use super::{paths::MemoryPaths, settings::Settings};
use parking_lot::Mutex;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::SystemTime,
};

pub struct ActionPrivacyGate {
    paths: MemoryPaths,
    settings: PathBuf,
    cached: Mutex<CachedPolicy>,
}

#[derive(Default)]
struct CachedPolicy {
    /// settings.json (mtime, size) and the cached operator policy's mtime.
    stamp: Option<((SystemTime, u64), Option<SystemTime>)>,
    initialized: bool,
    blocked: bool,
}

impl ActionPrivacyGate {
    pub fn new(paths: &MemoryPaths) -> Self {
        Self {
            paths: paths.clone(),
            settings: paths.settings(),
            cached: Mutex::new(CachedPolicy::default()),
        }
    }

    /// A missing initial file preserves the opt-in default. A malformed initial
    /// file blocks actions; failed reloads retain the last valid policy. The
    /// operator's policy (`policy.rs`) can turn masking on, never off.
    pub fn blocked(&self) -> bool {
        let mut cached = self.cached.lock();
        let policy_mtime = fs::metadata(super::policy::path(&self.paths))
            .and_then(|m| m.modified())
            .ok();
        match fs::metadata(&self.settings) {
            Ok(meta) => {
                let stamp = meta
                    .modified()
                    .ok()
                    .map(|time| ((time, meta.len()), policy_mtime));
                if !cached.initialized || stamp.is_none() || stamp != cached.stamp {
                    match fs::read(&self.settings)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
                    {
                        Some(mut settings) => {
                            settings.apply_policy(&self.paths);
                            cached.blocked = settings.privacy.redact_pii;
                        }
                        None if !cached.initialized => cached.blocked = true,
                        None => {}
                    }
                    cached.stamp = stamp;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) if !cached.initialized => cached.blocked = true,
            Err(_) => {}
        }
        cached.initialized = true;
        cached.blocked
    }
}

pub fn action_gate() -> &'static Arc<ActionPrivacyGate> {
    static GATE: OnceLock<Arc<ActionPrivacyGate>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(ActionPrivacyGate::new(&MemoryPaths::resolve())))
}

/// Every callback reads the same persisted opt-in policy before either writer.
pub struct ActionSessionPolicy {
    gate: Arc<ActionPrivacyGate>,
}

impl ActionSessionPolicy {
    pub fn new(gate: Arc<ActionPrivacyGate>) -> Self {
        Self { gate }
    }
    pub fn private_mode(&self) -> bool {
        self.gate.blocked()
    }

    pub fn sanitize(&self, event: serde_json::Value) -> Option<serde_json::Value> {
        if !self.private_mode() {
            return Some(event);
        }
        sanitize_activity(event)
    }
}

/// Preserve the existing event/processor contract through an explicit allowlist.
/// Unknown event payloads are dropped, never passed through optimistically.
fn sanitize_activity(event: serde_json::Value) -> Option<serde_json::Value> {
    use base64::Engine as _;
    use serde_json::{json, Map, Value};
    let kind = event.get("type")?.as_str()?;
    let timestamp = event.get("timestamp")?.as_f64()?;
    if !timestamp.is_finite() {
        return None;
    }
    let source = event.get("data")?.as_object()?;
    let mut data = Map::new();
    let numeric = |key: &str| {
        source
            .get(key)
            .filter(|v| v.as_f64().is_some_and(f64::is_finite))
            .cloned()
    };
    match kind {
        "key_down" | "key_up" => {
            let key = source.get("key").and_then(Value::as_str).unwrap_or("");
            let safe = [
                "shift",
                "ctrl",
                "control",
                "alt",
                "option",
                "cmd",
                "command",
                "meta",
                "enter",
                "return",
                "tab",
                "escape",
                "esc",
                "backspace",
                "delete",
                "home",
                "end",
                "pageup",
                "pagedown",
                "up",
                "down",
                "left",
                "right",
                "capslock",
                "space",
                "f1",
                "f2",
                "f3",
                "f4",
                "f5",
                "f6",
                "f7",
                "f8",
                "f9",
                "f10",
                "f11",
                "f12",
            ];
            data.insert(
                "key".into(),
                json!(if safe.contains(&key) {
                    key
                } else {
                    "[redacted]"
                }),
            );
            if let Some(duration) = numeric("hold_duration") {
                data.insert("hold_duration".into(), duration);
            }
            let modifiers: Vec<&str> = source
                .get("active_modifiers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|key| safe[..8].contains(key))
                .collect();
            data.insert("active_modifiers".into(), json!(modifiers));
        }
        "mouse_move" | "mouse_down" | "mouse_up" | "mouse_scroll" => {
            for key in [
                "x",
                "y",
                "dx",
                "dy",
                "delta_x",
                "delta_y",
                "clicks",
                "click_count",
                "hold_duration",
                "display_id",
            ] {
                if let Some(value) = numeric(key) {
                    data.insert(key.into(), value);
                }
            }
            if let Some(dragging) = source.get("is_dragging").and_then(Value::as_bool) {
                data.insert("is_dragging".into(), json!(dragging));
            }
            let modifiers: Vec<&str> = source
                .get("active_modifiers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|key| {
                    [
                        "shift", "ctrl", "control", "alt", "option", "cmd", "command", "meta",
                    ]
                    .contains(key)
                })
                .collect();
            data.insert("active_modifiers".into(), json!(modifiers));
            if let Some(position) = source.get("position").and_then(Value::as_object) {
                let filtered: Map<String, Value> = position
                    .iter()
                    .filter(|(key, value)| {
                        ["x", "y"].contains(&key.as_str())
                            && value.as_f64().is_some_and(f64::is_finite)
                    })
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                data.insert("position".into(), Value::Object(filtered));
            }
            if let Some(button) = source
                .get("button")
                .and_then(Value::as_str)
                .filter(|button| ["left", "right", "middle", "button4", "button5"].contains(button))
            {
                data.insert("button".into(), json!(button));
            }
        }
        "screenshot" | "a11y+screenshot" => {
            // Action-recorder screenshots lack OCR boxes. Keep action/screenshot alignment with
            // a fully covered image; the memory timeline has detailed masks.
            let screenshot = if kind == "a11y+screenshot" {
                source.get("screenshot")?.as_object()?
            } else {
                source
            };
            let width = screenshot.get("width")?.as_u64()?;
            let height = screenshot.get("height")?.as_u64()?;
            if width == 0
                || height == 0
                || width > 8192
                || height > 8192
                || width * height > 32_000_000
            {
                return None;
            }
            let image =
                image::RgbImage::from_pixel(width as u32, height as u32, image::Rgb([0, 0, 0]));
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 30)
                .encode_image(&image)
                .ok()?;
            data.insert(
                "image".into(),
                json!(base64::engine::general_purpose::STANDARD.encode(jpeg)),
            );
            data.insert("width".into(), json!(width));
            data.insert("height".into(), json!(height));
            data.insert("encoding".into(), json!("jpg"));
            for key in [
                "active_display_id",
                "current_display_id",
                "pointer_display_id",
                "focused_display_id",
            ] {
                if let Some(id) = screenshot.get(key).and_then(Value::as_u64) {
                    data.insert(key.into(), json!(id));
                }
            }
            if kind == "a11y+screenshot" {
                data = serde_json::from_value(
                    json!({"screenshot": data, "a11y": {"privacy_redacted": true}}),
                )
                .ok()?;
            }
        }
        _ => return None,
    }
    data.insert("privacy_redacted".into(), json!(true));
    let mut sanitized = json!({"type": kind, "timestamp": timestamp, "data": data});
    if kind == "a11y+screenshot" {
        if let Some(end) = event
            .get("end_timestamp")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            sanitized["end_timestamp"] = json!(end);
        }
    }
    Some(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_activity_keeps_input_timing_and_coordinates_but_no_characters_codes_or_visuals() {
        use base64::Engine as _;
        use serde_json::json;
        let key = sanitize_activity(json!({"type":"key_down", "timestamp":1.0, "data":{"key":"a", "key_code":0, "text":"alice@example.com", "active_modifiers":["command", "alice@example.com"]}, "window_title":"alice@example.com"})).unwrap();
        assert_eq!(key["data"]["key"], "[redacted]");
        assert_eq!(key["data"]["active_modifiers"], json!(["command"]));
        assert!(!key.to_string().contains("alice"));
        assert!(!key.to_string().contains("key_code"));
        let mouse = sanitize_activity(json!({"type":"mouse_scroll", "timestamp":2.0, "data":{"x":0.25, "y":0.75,"clicks":-2,"display_id":3,"url":"alice@example.com"}})).unwrap();
        assert_eq!(mouse["data"]["clicks"], -2);
        assert_eq!(mouse["data"]["x"], 0.25);
        assert!(!mouse.to_string().contains("alice"));
        for kind in ["screenshot", "a11y+screenshot"] {
            let image = json!({"image":"raw-synthetic-image", "width":16,"height":12,"window":"alice@example.com"});
            let data = if kind == "screenshot" {
                image
            } else {
                json!({"screenshot":image,"a11y":{"value":"alice@example.com"}})
            };
            let event =
                sanitize_activity(json!({"type":kind,"timestamp":3.0,"data":data})).unwrap();
            let screenshot = if kind == "screenshot" {
                &event["data"]
            } else {
                &event["data"]["screenshot"]
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(screenshot["image"].as_str().unwrap())
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
            assert!(image
                .pixels()
                .all(|pixel| pixel.0.iter().all(|value| *value < 3)));
            assert!(!event.to_string().contains("alice"));
            assert!(!event.to_string().contains("raw-synthetic"));
        }
        assert!(sanitize_activity(
            json!({"type":"unknown", "timestamp":1.0,"data":{"text":"alice@example.com"}})
        )
        .is_none());
    }

    #[test]
    fn action_policy_is_opt_in_and_failed_reloads_do_not_unblock_it() {
        let root =
            std::env::temp_dir().join(format!("kortix-action-privacy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let paths = MemoryPaths::at(&root);
        let gate = Arc::new(ActionPrivacyGate::new(&paths));
        assert!(!gate.blocked());
        let mut settings = Settings::default();
        settings.privacy.redact_pii = true;
        settings.save(&paths).unwrap();
        assert!(gate.blocked());
        let session = ActionSessionPolicy::new(gate.clone());
        assert!(session.private_mode());
        fs::write(paths.settings(), "invalid").unwrap();
        assert!(gate.blocked());
        fs::remove_file(paths.settings()).unwrap();
        assert!(gate.blocked());
        settings.privacy.redact_pii = false;
        settings.save(&paths).unwrap();
        assert!(!gate.blocked());
        assert!(!session.private_mode());
        assert!(!ActionSessionPolicy::new(gate).private_mode());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_operators_policy_turns_action_masking_on_while_sync_is_on() {
        let paths = MemoryPaths::at(std::env::temp_dir().join(format!(
            "kcap-gate-policy-{}",
            uuid::Uuid::new_v4().simple()
        )));
        std::fs::create_dir_all(&paths.root).unwrap();
        let mut s = Settings::default();
        s.sync.enabled = true;
        s.save(&paths).unwrap();
        let gate = ActionPrivacyGate::new(&paths);
        assert!(!gate.blocked());
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(
            super::super::policy::path(&paths),
            r#"{"source": "p/policy.json", "fetched_at_ms": 1, "policy": {"privacy": {"redact_pii": true}}}"#,
        )
        .unwrap();
        assert!(gate.blocked(), "the policy masks actions within one check");
        std::fs::remove_file(super::super::policy::path(&paths)).unwrap();
        assert!(
            !gate.blocked(),
            "without the policy the person's setting applies"
        );
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn invalid_initial_policy_conceals_activity_and_pauses_uploads() {
        let root =
            std::env::temp_dir().join(format!("kortix-action-privacy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let paths = MemoryPaths::at(&root);
        fs::write(paths.settings(), "{").unwrap();
        assert!(ActionPrivacyGate::new(&paths).blocked());
        fs::remove_dir_all(root).unwrap();
    }
}
