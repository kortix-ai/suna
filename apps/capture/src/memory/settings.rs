//! User settings for Kortix Capture, persisted as JSON and hot-reloaded.
//!
//! Every field has a default so an absent or partial file is valid; unknown
//! keys are preserved by round-tripping through `extra`.

use super::paths::MemoryPaths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// Master switch ("Screen Recording" toggle).
    pub recording_enabled: bool,
    /// Epoch ms; recording is paused until then ("Pause for 1 hour").
    pub paused_until_ms: Option<i64>,
    /// Capture cadence.
    pub interval_ms: u64,
    /// Longest edge budget: stills are scaled so height <= this many pixels.
    pub max_height: u32,
    /// Stills fit inside max_width x max_height.
    pub max_width: u32,
    /// JPEG quality for staged stills (0..1).
    pub staging_quality: f64,
    /// HEVC quality for finalized chunks (0..1). Higher = sharper, bigger.
    pub video_quality: f64,
    /// Frames per video chunk (1 fps playback, so also seconds per chunk).
    pub chunk_max_frames: usize,
    /// Suspend capture when there is no keyboard/mouse input for this long.
    pub pause_on_inactivity: bool,
    pub inactivity_seconds: u64,
    /// "accurate" or "fast".
    pub ocr_level: String,
    /// BCP-47 languages for OCR; empty = automatic.
    pub ocr_languages: Vec<String>,
    /// Record the focused app's accessibility tree with each frame.
    pub ax_enabled: bool,
    pub excluded_bundle_ids: Vec<String>,
    pub excluded_domains: Vec<String>,
    /// Built-in groups, see `exclusion_groups()`.
    pub enabled_exclusion_groups: Vec<String>,
    pub exclude_private_browsing: bool,
    pub record_unknown_bundle_ids: bool,
    pub storage: StorageSettings,
    pub upload: UploadSettings,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StorageSettings {
    /// "storage_cap" | "retention" | "keep_all"
    pub management_mode: String,
    pub limit_gb: f64,
    /// "delete" | "downscale"
    pub cap_action: String,
    pub retention_days: u32,
    /// "delete" | "downscale"
    pub retention_action: String,
    /// Scale applied when downscaling archived video (0..1).
    pub archived_scale: f64,
    /// Stop recording when free disk space drops below this.
    pub min_free_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct UploadSettings {
    /// Hours a video stays on disk after its upload commits.
    pub keep_local_hours: u64,
    /// Days OCR text stays in the local index after its upload commits.
    pub text_keep_days: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recording_enabled: true,
            paused_until_ms: None,
            interval_ms: 2000,
            max_height: 1440,
            max_width: 2560,
            staging_quality: 0.8,
            video_quality: 0.5,
            chunk_max_frames: 30,
            pause_on_inactivity: true,
            // Recording suspends 5 s after the last keyboard/mouse input.
            inactivity_seconds: 5,
            ocr_level: "accurate".into(),
            ocr_languages: Vec::new(),
            ax_enabled: true,
            excluded_bundle_ids: Vec::new(),
            excluded_domains: Vec::new(),
            enabled_exclusion_groups: vec!["password_managers".into()],
            exclude_private_browsing: true,
            record_unknown_bundle_ids: false,
            storage: StorageSettings::default(),
            upload: UploadSettings::default(),
            extra: BTreeMap::new(),
        }
    }
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            management_mode: "storage_cap".into(),
            limit_gb: 50.0,
            cap_action: "delete".into(),
            retention_days: 90,
            retention_action: "downscale".into(),
            archived_scale: 0.5,
            min_free_gb: 5.0,
        }
    }
}

impl Default for UploadSettings {
    fn default() -> Self {
        Self { keep_local_hours: 24, text_keep_days: 7 }
    }
}

pub struct ExclusionGroup {
    pub id: &'static str,
    pub name: &'static str,
    pub bundle_ids: &'static [&'static str],
    pub domains: &'static [&'static str],
}

pub fn exclusion_groups() -> &'static [ExclusionGroup] {
    &[
        ExclusionGroup {
            id: "password_managers",
            name: "Password managers",
            bundle_ids: &[
                "com.1password.1password",
                "com.agilebits.onepassword7",
                "com.agilebits.onepassword-osx",
                "com.bitwarden.desktop",
                "com.lastpass.LastPass",
                "com.dashlane.Dashlane",
                "org.keepassxc.keepassxc",
                "com.apple.keychainaccess",
                "com.apple.Passwords",
                "in.sinew.Enpass-Desktop",
                "com.nordpass.macos.NordPass",
                "com.proton.pass",
                // Windows (lowercase exe) and Linux (lowercase WM_CLASS); matched case-insensitively.
                "1password.exe",
                "bitwarden.exe",
                "keepassxc.exe",
                "keepass.exe",
                "lastpass.exe",
                "dashlane.exe",
                "enpass.exe",
                "nordpass.exe",
                "proton pass.exe",
                "1password",
                "bitwarden",
                "keepassxc",
                "enpass",
            ],
            domains: &[
                "1password.com",
                "bitwarden.com",
                "vault.bitwarden.com",
                "lastpass.com",
                "dashlane.com",
                "proton.me/pass",
            ],
        },
        ExclusionGroup {
            id: "messaging",
            name: "Messaging apps",
            bundle_ids: &[
                "com.apple.MobileSMS",
                "net.whatsapp.WhatsApp",
                "desktop.WhatsApp",
                "ru.keepcoder.Telegram",
                "org.telegram.desktop",
                "org.whispersystems.signal-desktop",
                "com.facebook.archon",
                "com.hnc.Discord",
                // Notification banners would leak excluded messages.
                "com.apple.notificationcenterui",
                "whatsapp.exe",
                "telegram.exe",
                "signal.exe",
                "discord.exe",
                // Windows toast banners.
                "shellexperiencehost.exe",
                "whatsapp",
                "telegram-desktop",
                "signal",
                "discord",
            ],
            domains: &["web.whatsapp.com", "web.telegram.org", "messenger.com", "messages.google.com"],
        },
        ExclusionGroup {
            id: "banking",
            name: "Banking and finance",
            bundle_ids: &[],
            domains: &["paypal.com", "wise.com", "revolut.com", "chase.com", "bankofamerica.com", "wellsfargo.com"],
        },
    ]
}

impl Settings {
    pub fn load(paths: &MemoryPaths) -> Self {
        std::fs::read(paths.settings())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, paths: &MemoryPaths) -> anyhow::Result<()> {
        std::fs::create_dir_all(&paths.root)?;
        let tmp = paths.settings().with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, paths.settings())?;
        Ok(())
    }

    /// Explicit exclusions plus enabled groups.
    pub fn effective_excluded_bundle_ids(&self) -> Vec<String> {
        let mut out: Vec<String> = self.excluded_bundle_ids.clone();
        for g in exclusion_groups() {
            if self.enabled_exclusion_groups.iter().any(|id| id == g.id) {
                out.extend(g.bundle_ids.iter().map(|s| s.to_string()));
            }
        }
        out.sort();
        out.dedup();
        out
    }

    pub fn effective_excluded_domains(&self) -> Vec<String> {
        let mut out: Vec<String> = self.excluded_domains.clone();
        for g in exclusion_groups() {
            if self.enabled_exclusion_groups.iter().any(|id| id == g.id) {
                out.extend(g.domains.iter().map(|s| s.to_string()));
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// Why recording is not active right now, if it is not.
    pub fn inactive_reason(&self, now_ms: i64) -> Option<&'static str> {
        if !self.recording_enabled {
            return Some("disabled");
        }
        if matches!(self.paused_until_ms, Some(until) if until > now_ms) {
            return Some("paused");
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_file_fills_defaults_and_keeps_unknown_keys() {
        let s: Settings = serde_json::from_str(r#"{"interval_ms": 5000, "future_knob": 7}"#).unwrap();
        assert_eq!(s.interval_ms, 5000);
        assert_eq!(s.max_height, 1440);
        assert_eq!(s.extra.get("future_knob"), Some(&serde_json::json!(7)));
        let round: Value = serde_json::to_value(&s).unwrap();
        assert_eq!(round["future_knob"], 7);
    }

    #[test]
    fn groups_expand_into_exclusions() {
        let mut s = Settings::default();
        s.enabled_exclusion_groups = vec!["messaging".into()];
        s.excluded_bundle_ids = vec!["com.example.secret".into()];
        let ids = s.effective_excluded_bundle_ids();
        assert!(ids.contains(&"com.apple.MobileSMS".to_string()));
        assert!(ids.contains(&"com.apple.notificationcenterui".to_string()));
        assert!(ids.contains(&"com.example.secret".to_string()));
        assert!(!ids.contains(&"com.1password.1password".to_string()));
    }

    #[test]
    fn pause_window_is_respected() {
        let mut s = Settings::default();
        assert_eq!(s.inactive_reason(1000), None);
        s.paused_until_ms = Some(2000);
        assert_eq!(s.inactive_reason(1000), Some("paused"));
        assert_eq!(s.inactive_reason(3000), None);
        s.recording_enabled = false;
        assert_eq!(s.inactive_reason(3000), Some("disabled"));
    }
}
