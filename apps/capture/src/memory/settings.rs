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
    /// Also capture right after the frontmost app, the focused window title,
    /// or the browser URL changes (at most one capture per second). The
    /// change check is a light metadata poll, never a screenshot, and never
    /// reads the keyboard or mouse.
    pub capture_on_change: bool,
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
    /// Deprecated: input idleness never stops screen capture (reading or watching
    /// records too; an unchanged display writes no frame). Accepted and ignored.
    pub pause_on_inactivity: bool,
    /// Frames this long after the last keyboard/mouse input are marked inactive.
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
    /// Record only what is included: a window is recorded only when its app is in
    /// `included_bundle_ids` or its website is in `included_domains`. Exclusions still win.
    /// The organization's policy can turn it on; the person cannot turn that off.
    pub record_only_included: bool,
    pub included_bundle_ids: Vec<String>,
    pub included_domains: Vec<String>,
    pub record_unknown_bundle_ids: bool,
    pub storage: StorageSettings,
    /// Cloud sync of finished chunks (S3-compatible storage or Kortix).
    #[serde(deserialize_with = "sync_compat")]
    pub sync: SyncSettings,
    /// Opt-in local text and screen masking before image and SQLite writes.
    pub privacy: PrivacySettings,
    /// Opt-in 24/7 audio memory (off by default).
    pub audio: AudioSettings,
    /// No network at all: no favicon fetches, no update checks, no telemetry.
    pub airgap: bool,
    /// Start Kortix Capture at login and restart it after a crash (on by
    /// default). The tray installs or removes the OS login entry when it changes.
    pub launch_at_login: bool,
    pub shortcuts: ShortcutSettings,
    pub experimental: ExperimentalSettings,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
    /// The operator's policy, set only by [`Settings::effective`]; never saved.
    #[serde(skip)]
    pub policy: Option<super::policy::Policy>,
    /// The app the service runs in (its bundle id and executable name), set only
    /// by [`Settings::effective`]: never recorded, like every `com.kortix.*` and
    /// `ai.kortix.*` app ([`super::exclusions::is_own_app`]).
    #[serde(skip)]
    pub own_bundle_ids: Vec<String>,
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
    /// Size of the pre-allocated disk-reserve file `<library>/.kortix-storage-reserve`,
    /// in MB (0 turns it off). The recorder deletes it when free disk space falls
    /// below 0.5 GB, so SQLite and the video finalizer can still write while the
    /// user frees space. It is re-created once free space recovers.
    pub reserve_mb: u64,
}

/// Features still being shaped. They are hidden until switched on; hiding a control
/// never changes what applies.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ExperimentalSettings {
    /// Show the Never record controls (exclusion groups, private browsing, own excluded
    /// apps and websites) in Settings. On a computer under a Kortix policy, the policy's
    /// `experimental.privacy_controls` decides instead.
    pub privacy_controls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ShortcutSettings {
    pub open_timeline: String,
    pub open_search: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PrivacySettings {
    /// Experimental, entirely local PII masking. Explicit opt-in; installing
    /// model assets never enables this flag or changes normal sync behavior.
    pub redact_pii: bool,
    /// Local context model plus patterns. Missing/failed model discards frames;
    /// it never silently falls back to the less comprehensive pattern pass.
    pub use_local_model: bool,
}

/// Audio memory. Off until a person turns it on: it records everything the
/// computer hears and plays, including other people on calls.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AudioSettings {
    pub enabled: bool,
    /// Record the input device (your voice and the room).
    pub microphone: bool,
    /// Record what the computer plays (calls, videos, music).
    pub system_audio: bool,
    /// Input device id from `kortix-capture audio devices`; empty follows the system default.
    pub input_device: String,
    /// Transcribe on this device into search (macOS). Off by default.
    pub transcribe: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            microphone: true,
            system_audio: true,
            input_device: String::new(),
            transcribe: false,
        }
    }
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            redact_pii: false,
            use_local_model: true,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recording_enabled: true,
            paused_until_ms: None,
            interval_ms: 2000,
            capture_on_change: true,
            max_height: 1440,
            max_width: 2560,
            staging_quality: 0.8,
            video_quality: 0.5,
            chunk_max_frames: 30,
            pause_on_inactivity: false,
            // Frames 5 s after the last keyboard/mouse input are marked inactive.
            inactivity_seconds: 5,
            ocr_level: "accurate".into(),
            ocr_languages: Vec::new(),
            ax_enabled: true,
            excluded_bundle_ids: Vec::new(),
            excluded_domains: Vec::new(),
            enabled_exclusion_groups: vec!["password_managers".into()],
            exclude_private_browsing: true,
            record_only_included: false,
            included_bundle_ids: Vec::new(),
            included_domains: Vec::new(),
            record_unknown_bundle_ids: false,
            storage: StorageSettings::default(),
            sync: SyncSettings::default(),
            privacy: PrivacySettings::default(),
            audio: AudioSettings::default(),
            airgap: false,
            launch_at_login: true,
            shortcuts: ShortcutSettings::default(),
            experimental: ExperimentalSettings::default(),
            extra: BTreeMap::new(),
            policy: None,
            own_bundle_ids: Vec::new(),
        }
    }
}

/// Cloud sync to an S3-compatible bucket in the Kortix Capture format. `provider`
/// picks where the S3 credentials come from: `s3` (static credentials for your
/// own bucket, settings under `s3`; the keys live in
/// `<library>/sync-credentials.json`, 0600, or the environment, never here) or
/// `kortix` (short-lived credentials from a credential issuer after "Sign in with
/// Kortix"; the issuer URL is `kortix.url`, else the build's default).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SyncSettings {
    pub enabled: bool,
    /// `s3` (default) or `kortix`.
    pub provider: String,
    pub s3: S3SyncSettings,
    pub kortix: IssuerSyncSettings,
    /// Keep the local video this long after a verified upload; 0 deletes it at once.
    pub keep_local_hours: u64,
    /// Cap for remote chunks downloaded back for playback, in MB.
    pub cache_mb: u64,
    /// Chunks uploaded in parallel (1-8).
    pub concurrency: u32,
    /// Upload bandwidth cap in KB/s across all uploads; 0 = unlimited.
    pub max_upload_kbps: u64,
    /// Files larger than this upload as multipart in parts of this size, in MB (min 5).
    pub part_mb: u64,
    /// Delete chunk objects from the cloud once they are this many days old; 0 keeps them.
    pub remote_retention_days: u64,
    /// Encrypt every object with a local AES-256-GCM key before upload.
    pub encrypt: bool,
    /// Fingerprint of the encryption key (the key itself is in the Keychain or `sync-key`).
    pub key_id: String,
}

/// `sync.provider = "s3"`: AWS S3, Cloudflare R2, MinIO, versitygw, ...
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct S3SyncSettings {
    /// e.g. `https://s3.us-east-1.amazonaws.com`, `http://127.0.0.1:9000`.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// Key prefix inside the bucket; objects go under `<prefix>/<device_id>/`.
    pub prefix: String,
    /// Path-style URLs (`<endpoint>/<bucket>/<key>`), needed by MinIO and most self-hosted S3.
    pub path_style: bool,
}

/// `sync.provider = "kortix"`: credentials from an issuer that speaks the
/// Kortix Capture credential protocol (`.agents/skills/kortix-capture/references/capture-format.md`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct IssuerSyncSettings {
    /// Issuer base URL; empty uses the build's default (`KORTIX_DEFAULT_ISSUER_URL`).
    pub url: String,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "s3".into(),
            s3: S3SyncSettings::default(),
            kortix: IssuerSyncSettings::default(),
            keep_local_hours: 0,
            cache_mb: 1024,
            concurrency: 3,
            max_upload_kbps: 0,
            part_mb: 16,
            remote_retention_days: 0,
            encrypt: false,
            key_id: String::new(),
        }
    }
}

impl Default for S3SyncSettings {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            region: "us-east-1".into(),
            bucket: String::new(),
            prefix: "kortix-capture".into(),
            path_style: false,
        }
    }
}

impl SyncSettings {
    /// True once a provider is configured (so local deletions also queue remote deletes).
    pub fn configured(&self) -> bool {
        match self.provider.as_str() {
            "s3" => !self.s3.endpoint.trim().is_empty(),
            _ => true,
        }
    }
}

/// Settings files written before `sync.provider` kept the S3 fields flat in
/// `sync` (`sync.endpoint`, ...). Move them under `sync.s3`; a flat key wins,
/// so `settings sync.endpoint <url>` keeps working.
fn sync_compat<'de, D: serde::Deserializer<'de>>(d: D) -> Result<SyncSettings, D::Error> {
    let mut v = Value::deserialize(d)?;
    if let Some(obj) = v.as_object_mut() {
        let mut s3 = obj
            .remove("s3")
            .and_then(|x| x.as_object().cloned())
            .unwrap_or_default();
        for k in ["endpoint", "region", "bucket", "prefix", "path_style"] {
            if let Some(x) = obj.remove(k) {
                s3.insert(k.into(), x);
            }
        }
        obj.insert("s3".into(), Value::Object(s3));
    }
    serde_json::from_value(v).map_err(serde::de::Error::custom)
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            // "Keep recordings on this computer": 7 days. With sync on, by-age retention
            // never deletes what is not uploaded yet; the size cap still holds.
            management_mode: "retention".into(),
            limit_gb: 50.0,
            cap_action: "delete".into(),
            retention_days: 7,
            retention_action: "delete".into(),
            archived_scale: 0.75,
            min_free_gb: 5.0,
            reserve_mb: 500,
        }
    }
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            open_timeline: "CmdOrCtrl+Shift+Space".into(),
            open_search: "CmdOrCtrl+Shift+F".into(),
        }
    }
}

pub struct ExclusionGroup {
    pub id: &'static str,
    pub name: &'static str,
    /// One line for the settings: what the group covers.
    pub description: &'static str,
    pub bundle_ids: &'static [&'static str],
    pub domains: &'static [&'static str],
}

/// One entry per line; blank lines and `#` comments are skipped, duplicates dropped.
fn parse_list(text: &'static str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

const BANKING_DOMAINS: &str = include_str!("data/banking_domains.txt");
const BANKING_BUNDLE_IDS: &str = include_str!("data/banking_bundle_ids.txt");

pub fn exclusion_groups() -> &'static [ExclusionGroup] {
    static GROUPS: std::sync::OnceLock<Vec<ExclusionGroup>> = std::sync::OnceLock::new();
    GROUPS.get_or_init(|| {
        vec![
            ExclusionGroup {
                id: "password_managers",
                name: "Password managers",
                description:
                    "1Password, Bitwarden, Keychain Access, Passwords and other password managers",
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
                    "pass.proton.me",
                ],
            },
            ExclusionGroup {
                id: "messaging",
                name: "Messaging apps",
                description:
                    "Messages, WhatsApp, Telegram, Signal, Discord and notification banners",
                bundle_ids: &[
                    "com.apple.MobileSMS",
                    "net.whatsapp.WhatsApp",
                    "desktop.WhatsApp",
                    "ru.keepcoder.Telegram",
                    "org.telegram.desktop",
                    "org.whispersystems.signal-desktop",
                    "com.facebook.archon",
                    "com.hnc.Discord",
                    "com.tencent.xinwechat",
                    // Notification banners would leak excluded messages.
                    "com.apple.notificationcenterui",
                    "whatsapp.exe",
                    "telegram.exe",
                    "signal.exe",
                    "discord.exe",
                    "wechat.exe",
                    "weixin.exe",
                    // Windows toast banners.
                    "shellexperiencehost.exe",
                    "whatsapp",
                    "telegram-desktop",
                    "signal",
                    "discord",
                    "wechat",
                ],
                domains: &[
                    "web.whatsapp.com",
                    "web.telegram.org",
                    "messenger.com",
                    "messages.google.com",
                    "web.wechat.com",
                    "wx.qq.com",
                ],
            },
            ExclusionGroup {
                id: "banking",
                name: "Banking and finance",
                description: "Banking apps and the websites of banks, neobanks and fintech",
                bundle_ids: Box::leak(parse_list(BANKING_BUNDLE_IDS).into_boxed_slice()),
                domains: Box::leak(parse_list(BANKING_DOMAINS).into_boxed_slice()),
            },
        ]
    })
}

/// Named resolution presets: (name, max_width, max_height). A still is scaled
/// to fit inside the box and never enlarged.
pub const RESOLUTION_PRESETS: &[(&str, u32, u32)] = &[
    ("720p", 1280, 720),
    ("1080p", 1920, 1080),
    ("1440p", 2560, 1440),
    ("4k", 3840, 2160),
];

/// `720p` | `1080p` | `1440p` | `4k` (alias `2160p`), case-insensitive.
pub fn resolution_preset(name: &str) -> Option<(u32, u32)> {
    let n = name.trim().to_ascii_lowercase();
    let n = if n == "2160p" { "4k" } else { n.as_str() };
    RESOLUTION_PRESETS
        .iter()
        .find(|(p, _, _)| *p == n)
        .map(|(_, w, h)| (*w, *h))
}

impl Settings {
    pub fn load(paths: &MemoryPaths) -> Self {
        std::fs::read(paths.settings())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// What the recorder, audio, actions and sync obey: the person's settings
    /// narrowed by the operator's policy while sync is on (see `policy.rs`).
    pub fn effective(paths: &MemoryPaths) -> Self {
        let mut s = Self::load(paths);
        s.apply_policy(paths);
        s.apply_host(paths);
        s
    }

    /// The app the service runs in, never recorded: its bundle id and executable name.
    pub fn apply_host(&mut self, paths: &MemoryPaths) {
        self.own_bundle_ids = super::service::read_host(paths)
            .map(|h| {
                let exe = std::path::Path::new(&h.command)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase());
                h.bundle_id
                    .map(|b| b.to_lowercase())
                    .into_iter()
                    .chain(exe)
                    .collect()
            })
            .unwrap_or_default();
    }

    /// Apply the cached policy to settings read from `paths` (no-op while sync is off).
    pub fn apply_policy(&mut self, paths: &MemoryPaths) {
        if self.sync.enabled && !self.airgap {
            if let Some(cached) = super::policy::read(paths) {
                cached.policy.apply(self);
            }
        }
    }

    /// Why action recording must not run now, if the policy says so.
    pub fn actions_blocked(&self, now_ms: i64) -> Option<&'static str> {
        let p = self.policy.as_ref()?;
        if !p.layers.actions {
            return Some("policy_off");
        }
        p.paused_at(now_ms).then_some("policy_paused")
    }

    pub fn save(&self, paths: &MemoryPaths) -> anyhow::Result<()> {
        // Effective settings carry the operator's limits; saving them would make
        // the policy permanent in the person's own settings.
        anyhow::ensure!(
            self.policy.is_none(),
            "refusing to save settings narrowed by the policy"
        );
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

    /// Explicit exclusions plus enabled groups, normalized by the one domain rule
    /// (`exclusions::normalize_domain_input`): every matcher receives bare hosts.
    pub fn effective_excluded_domains(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .excluded_domains
            .iter()
            .map(String::as_str)
            .chain(
                exclusion_groups()
                    .iter()
                    .filter(|g| self.enabled_exclusion_groups.iter().any(|id| id == g.id))
                    .flat_map(|g| g.domains.iter().copied()),
            )
            .filter_map(super::exclusions::normalize_domain_input)
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// The included websites as bare hosts (the one domain rule), sorted.
    pub fn effective_included_domains(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .included_domains
            .iter()
            .filter_map(|d| super::exclusions::normalize_domain_input(d))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Why recording is not active right now, if it is not.
    pub fn inactive_reason(&self, now_ms: i64) -> Option<&'static str> {
        if let Some(p) = &self.policy {
            if !p.layers.screen {
                return Some("policy_off");
            }
            if p.paused_at(now_ms) {
                return Some("policy_paused");
            }
        }
        if !self.recording_enabled {
            return Some("disabled");
        }
        if matches!(self.paused_until_ms, Some(until) if until > now_ms) {
            return Some("paused");
        }
        None
    }

    /// Every gate the recorder itself decides, in priority order:
    /// `disabled`, `paused`, `low_disk`, `sync_backlog`. The engine adds its own
    /// skips (`self_on_screen`, `locked`, `inactive`, `excluded_*`).
    pub fn recording_gate(
        &self,
        now_ms: i64,
        free_gb: Option<f64>,
        sync_pending_bytes: i64,
    ) -> Option<(&'static str, Option<String>)> {
        if let Some(reason) = self.inactive_reason(now_ms) {
            return Some((reason, None));
        }
        if free_gb.is_some_and(|gb| gb < self.storage.min_free_gb) {
            return Some((
                "low_disk",
                Some(format!("less than {} GB free", self.storage.min_free_gb)),
            ));
        }
        let limit = (self.storage.limit_gb * 1e9) as i64;
        if self.sync.enabled && limit > 0 && sync_pending_bytes >= limit {
            return Some((
                "sync_backlog",
                Some(format!(
                    "{:.1} GB waiting to upload, over the {} GB storage limit",
                    sync_pending_bytes as f64 / 1e9,
                    self.storage.limit_gb
                )),
            ));
        }
        None
    }

    /// Refuse values the recorder cannot use. Every writer that takes input from a
    /// person (`settings <key> <value>`, `sync setup`, the settings window) calls it
    /// before saving, so the CLI and the window accept exactly the same values.
    pub fn validate(&self) -> anyhow::Result<()> {
        use anyhow::bail;
        let one_of = |key: &str, v: &str, ok: &[&str]| -> anyhow::Result<()> {
            if !ok.contains(&v) {
                bail!("{key} must be one of {} (got {v:?})", ok.join(", "));
            }
            Ok(())
        };
        let unit = |key: &str, v: f64| -> anyhow::Result<()> {
            if !(v > 0.0 && v <= 1.0) {
                bail!("{key} must be above 0 and at most 1 (got {v})");
            }
            Ok(())
        };
        if self.interval_ms < 500 {
            bail!(
                "interval_ms must be at least 500 (got {})",
                self.interval_ms
            );
        }
        if self.max_width == 0 || self.max_height == 0 {
            bail!("max_width and max_height must be above 0");
        }
        unit("staging_quality", self.staging_quality)?;
        unit("video_quality", self.video_quality)?;
        unit("storage.archived_scale", self.storage.archived_scale)?;
        if self.chunk_max_frames == 0 {
            bail!("chunk_max_frames must be at least 1");
        }
        if self.inactivity_seconds == 0 {
            bail!("inactivity_seconds must be at least 1");
        }
        one_of("ocr_level", &self.ocr_level, &["accurate", "fast"])?;
        for g in &self.enabled_exclusion_groups {
            let ids: Vec<&str> = exclusion_groups().iter().map(|x| x.id).collect();
            one_of("enabled_exclusion_groups", g, &ids)?;
        }
        let st = &self.storage;
        one_of(
            "storage.management_mode",
            &st.management_mode,
            &["storage_cap", "retention", "keep_all"],
        )?;
        one_of(
            "storage.cap_action",
            &st.cap_action,
            &["delete", "downscale"],
        )?;
        one_of(
            "storage.retention_action",
            &st.retention_action,
            &["delete", "downscale"],
        )?;
        if !(st.limit_gb > 0.0 && st.limit_gb.is_finite()) {
            bail!("storage.limit_gb must be above 0 (got {})", st.limit_gb);
        }
        if st.retention_days == 0 {
            bail!("storage.retention_days must be at least 1");
        }
        if !(st.min_free_gb >= 0.0 && st.min_free_gb.is_finite()) {
            bail!(
                "storage.min_free_gb must be 0 or more (got {})",
                st.min_free_gb
            );
        }
        let sy = &self.sync;
        one_of("sync.provider", &sy.provider, &["s3", "kortix"])?;
        if !(1..=8).contains(&sy.concurrency) {
            bail!("sync.concurrency must be 1 to 8 (got {})", sy.concurrency);
        }
        if sy.part_mb < 5 {
            bail!("sync.part_mb must be at least 5 (got {})", sy.part_mb);
        }
        if self.audio.enabled && !self.audio.microphone && !self.audio.system_audio {
            bail!("audio.enabled needs audio.microphone or audio.system_audio");
        }
        if sy.encrypt && sy.provider == "kortix" {
            bail!("sync.encrypt is not supported with the kortix provider: Kortix reads the bucket to index it for your organization");
        }
        Ok(())
    }

    /// `720p` | `1080p` | `1440p` | `4k`, or `custom` when max_width/max_height match no preset.
    pub fn resolution_name(&self) -> &'static str {
        RESOLUTION_PRESETS
            .iter()
            .find(|(_, w, h)| *w == self.max_width && *h == self.max_height)
            .map(|(n, _, _)| *n)
            .unwrap_or("custom")
    }

    pub fn set_resolution(&mut self, name: &str) -> anyhow::Result<()> {
        let (w, h) = resolution_preset(name)
            .ok_or_else(|| anyhow::anyhow!("unknown resolution {name:?} (use 720p, 1080p, 1440p or 4k; or set max_width and max_height)"))?;
        self.max_width = w;
        self.max_height = h;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_recordings_defaults_to_seven_days() {
        let st = Settings::default().storage;
        assert_eq!(
            (st.management_mode.as_str(), st.retention_days, st.retention_action.as_str()),
            ("retention", 7, "delete")
        );
    }

    #[test]
    fn partial_file_fills_defaults_and_keeps_unknown_keys() {
        let s: Settings =
            serde_json::from_str(r#"{"interval_ms": 5000, "future_knob": 7}"#).unwrap();
        assert_eq!(s.interval_ms, 5000);
        assert_eq!(s.max_height, 1440);
        assert!(!s.privacy.redact_pii);
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

    fn enabled(group: &str) -> Settings {
        let mut s = Settings::default();
        s.enabled_exclusion_groups = vec![group.into()];
        s
    }

    #[cfg(feature = "capture-engine")]
    fn domain_excluded(s: &Settings, url: &str) -> bool {
        crate::memory::exclusions::url_excluded(url, &s.effective_excluded_domains())
    }

    #[test]
    fn banking_list_is_large_clean_and_deduplicated() {
        let group = exclusion_groups()
            .iter()
            .find(|g| g.id == "banking")
            .unwrap();
        assert!(
            group.domains.len() >= 300,
            "{} domains",
            group.domains.len()
        );
        for d in group.domains {
            assert_eq!(*d, d.to_ascii_lowercase(), "{d} must be lowercase");
            assert!(
                !d.contains("://") && !d.contains('/') && !d.contains(' ') && d.contains('.'),
                "{d} must be a bare domain"
            );
            assert!(!d.starts_with("www."), "{d}: a pattern already covers www.");
        }
        let mut sorted = group.domains.to_vec();
        sorted.dedup();
        assert_eq!(sorted.len(), group.domains.len());
        assert!(group.bundle_ids.contains(&"com.apple.stocks"));
    }

    #[cfg(feature = "capture-engine")]
    #[test]
    fn banking_matches_registrable_domain_and_subdomains_case_insensitively() {
        let s = enabled("banking");
        for url in [
            "https://chase.com/",
            "https://www.chase.com/personal",
            "https://SECURE.Chase.COM/web/auth?x=1",
            "https://online.bankofamerica.com/login",
            "https://app.revolut.com/home",
            "https://login.hdfcbank.com/",
            "https://netbanking.hdfcbank.com/netbanking",
            "https://www.nubank.com.br/",
            "https://internetbanking.dbs.com.sg/",
            "https://secure.lloydsbank.com/",
            "https://www.commbank.com.au/",
            "https://www.paypal.com/myaccount",
        ] {
            assert!(domain_excluded(&s, url), "{url} must be excluded");
        }
        for url in [
            "https://notchase.com/",
            "https://chase.com.evil.example/",
            "https://example.com/chase.com",
            "https://github.com/",
            "https://news.ycombinator.com/",
        ] {
            assert!(!domain_excluded(&s, url), "{url} must not be excluded");
        }
        // The group is off by default.
        assert!(!domain_excluded(
            &Settings::default(),
            "https://www.chase.com/"
        ));
    }

    #[test]
    fn wechat_is_in_the_messaging_group() {
        let ids = enabled("messaging").effective_excluded_bundle_ids();
        assert!(ids
            .iter()
            .any(|i| i.eq_ignore_ascii_case("com.tencent.xinWeChat")));
    }

    #[test]
    fn login_window_and_lock_screen_never_record() {
        // macOS: the Swift engine skips `locked` sessions and always excludes these apps.
        let swift = include_str!("../../native/macos/CaptureEngine.swift");
        assert!(swift.contains(r#"alwaysExcluded: Set<String> = ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"]"#));
        assert!(swift.contains(r#"if screenLocked() { res["skipped"] = "locked"; return res }"#));
        // Windows: the Rust engine excludes the logon UI and lock app.
        let rust = include_str!("../capture_engine/mod.rs");
        assert!(rust.contains(
            r#"ALWAYS_EXCLUDED: &[&str] = &["logonui.exe", "lockapp.exe", "consent.exe"]"#
        ));
        assert!(rust.contains(r#"return skip(res, "locked")"#));
    }

    #[test]
    fn storage_defaults() {
        let st = StorageSettings::default();
        assert_eq!(st.archived_scale, 0.75);
        assert_eq!(st.reserve_mb, 500);
        assert!(Settings::default().capture_on_change);
        // An older settings file without the new keys picks up the defaults.
        let s: Settings = serde_json::from_str(r#"{"storage": {"limit_gb": 10}}"#).unwrap();
        assert_eq!(s.storage.archived_scale, 0.75);
        assert!(s.capture_on_change);
    }

    #[test]
    fn audio_is_off_by_default_and_needs_a_source() {
        let a = Settings::default().audio;
        assert!(!a.enabled, "audio is opt-in");
        assert!(!a.transcribe, "transcription is opt-in");
        assert!(a.microphone && a.system_audio && a.input_device.is_empty());
        // A settings file from before audio existed loads with audio off.
        let s: Settings = serde_json::from_str(r#"{"interval_ms": 3000}"#).unwrap();
        assert!(!s.audio.enabled);
        let mut s = Settings::default();
        s.audio.enabled = true;
        s.audio.microphone = false;
        s.audio.system_audio = false;
        assert!(s.validate().unwrap_err().to_string().contains("audio"));
        s.audio.system_audio = true;
        s.validate().unwrap();
    }

    #[test]
    fn resolution_presets_map_and_custom_survives() {
        let mut s = Settings::default();
        assert_eq!(s.resolution_name(), "1440p");
        s.set_resolution("1080P").unwrap();
        assert_eq!((s.max_width, s.max_height), (1920, 1080));
        assert_eq!(s.resolution_name(), "1080p");
        s.set_resolution("4k").unwrap();
        assert_eq!((s.max_width, s.max_height), (3840, 2160));
        s.set_resolution("2160p").unwrap();
        assert_eq!(s.resolution_name(), "4k");
        s.set_resolution("720p").unwrap();
        assert_eq!((s.max_width, s.max_height), (1280, 720));
        assert!(s.set_resolution("8k").is_err());
        assert_eq!(
            s.resolution_name(),
            "720p",
            "a bad name leaves the settings alone"
        );
        s.max_width = 1600;
        s.max_height = 900;
        assert_eq!(s.resolution_name(), "custom");
    }

    #[test]
    fn recording_gate_orders_every_recorder_reason() {
        let mut s = Settings::default();
        s.storage.limit_gb = 10.0;
        let now = 1_000;
        assert_eq!(s.recording_gate(now, Some(100.0), 0), None);
        assert_eq!(
            s.recording_gate(now, None, 0),
            None,
            "unknown free space does not block"
        );
        assert_eq!(s.recording_gate(now, Some(1.0), 0).unwrap().0, "low_disk");
        // Sync backlog gates only when sync is on and the unsent bytes reach the storage limit.
        assert_eq!(s.recording_gate(now, Some(100.0), 50_000_000_000), None);
        s.sync.enabled = true;
        assert_eq!(s.recording_gate(now, Some(100.0), 9_000_000_000), None);
        assert_eq!(
            s.recording_gate(now, Some(100.0), 10_000_000_000)
                .unwrap()
                .0,
            "sync_backlog"
        );
        // Priority: paused beats low disk beats sync backlog.
        assert_eq!(
            s.recording_gate(now, Some(1.0), 10_000_000_000).unwrap().0,
            "low_disk"
        );
        s.paused_until_ms = Some(5_000);
        assert_eq!(
            s.recording_gate(now, Some(1.0), 10_000_000_000).unwrap().0,
            "paused"
        );
    }

    #[test]
    fn flat_s3_sync_settings_from_older_files_still_load() {
        let old = r#"{"sync": {"enabled": true, "endpoint": "http://127.0.0.1:9000", "bucket": "b", "prefix": "p", "path_style": true, "keep_local_hours": 2}}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(
            (
                s.sync.provider.as_str(),
                s.sync.s3.endpoint.as_str(),
                s.sync.s3.bucket.as_str()
            ),
            ("s3", "http://127.0.0.1:9000", "b")
        );
        assert_eq!(
            (
                s.sync.s3.prefix.as_str(),
                s.sync.s3.path_style,
                s.sync.s3.region.as_str()
            ),
            ("p", true, "us-east-1")
        );
        assert_eq!(s.sync.keep_local_hours, 2);
        // The saved shape is nested and reloads to the same value.
        let saved = serde_json::to_value(&s).unwrap();
        assert!(
            saved["sync"].get("endpoint").is_none()
                && saved["sync"]["s3"]["endpoint"] == "http://127.0.0.1:9000"
        );
        assert_eq!(
            serde_json::from_value::<Settings>(saved).unwrap().sync,
            s.sync
        );
        // A flat key written onto a nested file wins; the issuer URL round-trips.
        let mixed = r#"{"sync": {"provider": "kortix", "s3": {"endpoint": "old"}, "endpoint": "new", "kortix": {"url": "https://issuer.example"}}}"#;
        let m: Settings = serde_json::from_str(mixed).unwrap();
        assert_eq!(
            (m.sync.provider.as_str(), m.sync.s3.endpoint.as_str()),
            ("kortix", "new")
        );
        assert_eq!(m.sync.kortix.url, "https://issuer.example");
        assert_eq!(Settings::default().sync.s3.prefix, "kortix-capture");
        assert!(!Settings::default().sync.configured());
    }

    /// The web shows what each category covers from a copy of these groups. Refresh it with
    /// `KORTIX_CAPTURE_WRITE_FIXTURES=1 cargo test --lib exclusion_groups_match_the_web_copy`.
    #[test]
    fn exclusion_groups_match_the_web_copy() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../web/src/features/capture/settings/exclusion-groups.json");
        let groups: Vec<serde_json::Value> = exclusion_groups()
            .iter()
            .map(|g| serde_json::json!({"id": g.id, "apps": g.bundle_ids, "domains": g.domains}))
            .collect();
        let want = serde_json::to_string_pretty(&serde_json::json!({ "groups": groups })).unwrap() + "\n";
        if std::env::var("KORTIX_CAPTURE_WRITE_FIXTURES").as_deref() == Ok("1") {
            std::fs::write(&path, &want).unwrap();
        }
        let have = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            have == want,
            "{} is stale: KORTIX_CAPTURE_WRITE_FIXTURES=1 cargo test --lib exclusion_groups_match_the_web_copy",
            path.display()
        );
    }
}
