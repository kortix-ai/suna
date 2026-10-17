//! The operator's policy (`policy.json` in the bucket, format schema 2).
//!
//! The sync thread reads `<prefix>/<device_id>/policy.json`, else
//! `<prefix>/policy.json`, at start and every 60 s, and keeps the result in
//! `<library>/policy.json`. [`Settings::effective`] applies that copy on top of
//! the person's settings, and every part that records reads the effective
//! settings, so a change lands within one poll. A policy narrows privacy and
//! retention: a layer the policy turns off stops even when the person turned it
//! on, and a layer the policy allows still needs the person's own switch. The
//! capture rate and size (`recording.interval_ms`, `recording.max_height`) are
//! the one exception: when present, they set the value on every device.
//!
//! The policy applies while sync is on. Turning sync off (or airgap) drops it.
//! Without a reachable bucket the last copy keeps applying.

use super::{paths::MemoryPaths, settings::Settings};
use serde::{Deserialize, Serialize};

pub const SCHEMA: i64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Policy {
    pub schema: i64,
    pub layers: Layers,
    pub privacy: PolicyPrivacy,
    pub retention: PolicyRetention,
    pub recording: PolicyRecording,
    /// Shown to the person on the device (tray menu and settings window).
    pub notice: Option<String>,
    pub experimental: PolicyExperimental,
    pub updated_at_ms: i64,
}

/// Features the organization switches on for its devices. All default off.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PolicyExperimental {
    /// Show the Never record controls in Settings. What is set applies either way.
    pub privacy_controls: bool,
}

/// `false` turns a layer off. An absent layer is allowed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Layers {
    pub screen: bool,
    pub actions: bool,
    pub audio: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PolicyPrivacy {
    /// `true` turns local PII masking on (`privacy.redact_pii`).
    pub redact_pii: bool,
    /// Apps, websites and groups the organization never records, added to the
    /// person's own exclusions. The person cannot remove them.
    pub excluded_bundle_ids: Vec<String>,
    pub excluded_domains: Vec<String>,
    /// Ids of `settings::exclusion_groups()`; an id this build does not know is ignored.
    pub exclusion_groups: Vec<String>,
    /// `true` leaves private browser windows out, whatever the person chose.
    pub exclude_private_browsing: bool,
    /// `true` records only included apps and websites; the person cannot turn it off.
    pub record_only_included: bool,
    /// Added to the person's own included apps and websites.
    pub included_bundle_ids: Vec<String>,
    pub included_domains: Vec<String>,
}

/// 0 = no limit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PolicyRetention {
    /// Upper bound on `sync.keep_local_hours`: local media goes at most this
    /// long after its verified upload.
    pub local_hours: u64,
    /// Upper bound on `sync.remote_retention_days`.
    pub remote_days: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PolicyRecording {
    pub paused: bool,
    /// With `paused`: until then (epoch ms); null pauses until the operator resumes.
    pub paused_until_ms: Option<i64>,
    /// One screen frame per display every this many ms (500..=10000, clamped).
    /// Sets `interval_ms` on every device; null keeps the device's own value.
    pub interval_ms: Option<u64>,
    /// Frame height cap: 720, 1080, 1440 or 2160 (the width follows the preset).
    /// Sets `max_height`/`max_width`; null or another value keeps the device's own.
    pub max_height: Option<u32>,
}

/// The range `recording.interval_ms` is clamped to.
pub const INTERVAL_MS_RANGE: std::ops::RangeInclusive<u64> = 500..=10_000;

impl Default for Layers {
    fn default() -> Self {
        Self {
            screen: true,
            actions: true,
            audio: true,
        }
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            schema: SCHEMA,
            layers: Layers::default(),
            privacy: PolicyPrivacy::default(),
            retention: PolicyRetention::default(),
            recording: PolicyRecording::default(),
            notice: None,
            experimental: PolicyExperimental::default(),
            updated_at_ms: 0,
        }
    }
}

impl Policy {
    /// Recording is paused by the operator at `now`.
    pub fn paused_at(&self, now_ms: i64) -> bool {
        self.recording.paused && self.recording.paused_until_ms.is_none_or(|t| t > now_ms)
    }

    /// Narrow `s` (never widen it), and set the capture rate and size when the
    /// policy names them. Layers and pause are read through [`Settings::policy`]
    /// by the gates; the knobs with a number are capped here.
    pub fn apply(&self, s: &mut Settings) {
        if let Some(ms) = self.recording.interval_ms {
            s.interval_ms = ms.clamp(*INTERVAL_MS_RANGE.start(), *INTERVAL_MS_RANGE.end());
        }
        if let Some((w, h)) = self
            .recording
            .max_height
            .filter(|h| matches!(h, 720 | 1080 | 1440 | 2160))
            .and_then(|h| super::settings::resolution_preset(&format!("{h}p")))
        {
            (s.max_width, s.max_height) = (w, h);
        }
        if !self.layers.audio {
            s.audio.enabled = false;
        }
        if self.privacy.redact_pii {
            s.privacy.redact_pii = true;
        }
        let privacy = &self.privacy;
        union_ci(&mut s.excluded_bundle_ids, &privacy.excluded_bundle_ids);
        let domains: Vec<String> = privacy
            .excluded_domains
            .iter()
            .filter_map(|d| super::exclusions::normalize_domain_input(d))
            .collect();
        union_ci(&mut s.excluded_domains, &domains);
        let known: Vec<String> = privacy
            .exclusion_groups
            .iter()
            .filter(|id| {
                super::settings::exclusion_groups()
                    .iter()
                    .any(|g| g.id == id.as_str())
            })
            .cloned()
            .collect();
        union_ci(&mut s.enabled_exclusion_groups, &known);
        if privacy.exclude_private_browsing {
            s.exclude_private_browsing = true;
        }
        if privacy.record_only_included {
            s.record_only_included = true;
        }
        union_ci(&mut s.included_bundle_ids, &privacy.included_bundle_ids);
        let included: Vec<String> = privacy
            .included_domains
            .iter()
            .filter_map(|d| super::exclusions::normalize_domain_input(d))
            .collect();
        union_ci(&mut s.included_domains, &included);
        let r = &self.retention;
        if r.local_hours > 0 {
            s.sync.keep_local_hours = s.sync.keep_local_hours.min(r.local_hours);
        }
        if r.remote_days > 0 {
            s.sync.remote_retention_days = match s.sync.remote_retention_days {
                0 => r.remote_days,
                d => d.min(r.remote_days),
            };
        }
        s.policy = Some(self.clone());
    }

    /// The notice, trimmed; None when empty.
    pub fn notice(&self) -> Option<&str> {
        self.notice
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
    }
}

/// Append every item of `add` that `list` lacks (case-insensitive), keeping order.
fn union_ci(list: &mut Vec<String>, add: &[String]) {
    for item in add {
        if !list.iter().any(|x| x.eq_ignore_ascii_case(item)) {
            list.push(item.clone());
        }
    }
}

/// `<library>/policy.json`: the policy the sync thread last read, and from where.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Cached {
    /// Bucket key the policy came from: `<prefix>/policy.json`.
    pub source: String,
    pub fetched_at_ms: i64,
    pub policy: Policy,
}

pub fn path(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("policy.json")
}

pub fn read(paths: &MemoryPaths) -> Option<Cached> {
    serde_json::from_slice(&std::fs::read(path(paths)).ok()?).ok()
}

/// Keep `cached`, or remove the local copy when the bucket has no policy.
pub fn write(paths: &MemoryPaths, cached: Option<&Cached>) -> anyhow::Result<()> {
    match cached {
        Some(c) => {
            if read(paths).as_ref() != Some(c) {
                let tmp = path(paths).with_extension("json.tmp");
                std::fs::write(&tmp, serde_json::to_vec_pretty(c)?)?;
                std::fs::rename(tmp, path(paths))?;
            }
        }
        None => match std::fs::remove_file(path(paths)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        },
    }
    Ok(())
}

/// Parse a policy object. A schema newer than this build is refused (the
/// last known policy keeps applying).
pub fn parse(bytes: &[u8]) -> anyhow::Result<Policy> {
    let p: Policy = serde_json::from_slice(bytes)?;
    anyhow::ensure!(
        p.schema <= SCHEMA,
        "policy schema {} is newer than this app understands ({SCHEMA})",
        p.schema
    );
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_exclusions_join_the_persons_and_never_drop_theirs() {
        let p: Policy = serde_json::from_str(
            r#"{"schema": 2, "privacy": {"excluded_bundle_ids": ["com.example.Secret", "com.tinyspeck.slackmacgap"],
                "excluded_domains": ["https://www.Bank.example/login"], "exclusion_groups": ["banking", "nope"],
                "exclude_private_browsing": true}}"#,
        )
        .unwrap();
        let mut s = Settings::default();
        s.excluded_bundle_ids = vec!["com.tinyspeck.SlackMacGap".into(), "com.mine.app".into()];
        s.excluded_domains = vec!["mine.example".into()];
        s.enabled_exclusion_groups = vec!["password_managers".into()];
        s.exclude_private_browsing = false;
        p.apply(&mut s);
        assert_eq!(
            s.excluded_bundle_ids,
            vec![
                "com.tinyspeck.SlackMacGap",
                "com.mine.app",
                "com.example.Secret"
            ]
        );
        assert_eq!(s.excluded_domains, vec!["mine.example", "bank.example"]);
        // An id this build does not know is left out, so validation keeps passing.
        assert_eq!(
            s.enabled_exclusion_groups,
            vec!["password_managers", "banking"]
        );
        assert!(s.exclude_private_browsing);
        s.policy = None;
        s.validate().unwrap();
    }

    #[test]
    fn org_record_only_included_turns_it_on_and_joins_the_persons_lists() {
        let p: Policy = serde_json::from_str(
            r#"{"schema": 2, "privacy": {"record_only_included": true,
                "included_bundle_ids": ["com.tinyspeck.slackmacgap"], "included_domains": ["https://www.GitHub.com/x"]}}"#,
        )
        .unwrap();
        let mut s = Settings::default();
        s.included_bundle_ids = vec!["com.mine.editor".into()];
        p.apply(&mut s);
        assert!(s.record_only_included);
        assert_eq!(s.included_bundle_ids, vec!["com.mine.editor", "com.tinyspeck.slackmacgap"]);
        assert_eq!(s.included_domains, vec!["github.com"]);
        // A policy without it leaves the person's choice alone.
        let mut mine = Settings::default();
        mine.record_only_included = true;
        parse(br#"{"schema": 2}"#).unwrap().apply(&mut mine);
        assert!(mine.record_only_included);
    }

    #[test]
    fn privacy_controls_are_hidden_unless_the_policy_says_so_and_hiding_changes_nothing() {
        let off: Policy = serde_json::from_str(r#"{"schema":2,"privacy":{"exclusion_groups":["banking"]}}"#).unwrap();
        assert!(!off.experimental.privacy_controls, "default off");
        let on: Policy = serde_json::from_str(r#"{"schema":2,"experimental":{"privacy_controls":true},"recording":{"interval_ms":null}}"#).unwrap();
        assert!(on.experimental.privacy_controls);
        // The flag only shows or hides controls: exclusions apply with it off.
        let mut s = Settings::default();
        off.apply(&mut s);
        assert!(s.enabled_exclusion_groups.iter().any(|g| g == "banking"));
        assert!(!Settings::default().experimental.privacy_controls);
    }

    #[test]
    fn a_policy_without_exclusions_parses_and_changes_none() {
        let p = parse(br#"{"schema": 2, "privacy": {"redact_pii": false}}"#).unwrap();
        assert!(p.privacy.excluded_bundle_ids.is_empty() && !p.privacy.exclude_private_browsing);
        let mut s = Settings::default();
        let before = (
            s.excluded_bundle_ids.clone(),
            s.enabled_exclusion_groups.clone(),
            s.exclude_private_browsing,
        );
        p.apply(&mut s);
        assert_eq!(
            before,
            (
                s.excluded_bundle_ids.clone(),
                s.enabled_exclusion_groups.clone(),
                s.exclude_private_browsing
            )
        );
    }

    #[test]
    fn a_policy_only_narrows() {
        let p: Policy = serde_json::from_str(
            r#"{"schema": 2, "layers": {"audio": false}, "privacy": {"redact_pii": true},
                "retention": {"local_hours": 4, "remote_days": 30}, "notice": " Recorded for support "}"#,
        )
        .unwrap();
        assert!(p.layers.screen && p.layers.actions && !p.layers.audio);
        let mut s = Settings::default();
        s.audio.enabled = true;
        s.sync.keep_local_hours = 24;
        p.apply(&mut s);
        assert!(!s.audio.enabled && s.privacy.redact_pii);
        assert_eq!(
            (s.sync.keep_local_hours, s.sync.remote_retention_days),
            (4, 30)
        );
        assert_eq!(p.notice(), Some("Recorded for support"));

        // Allowing a layer never turns it on; a larger limit never raises a smaller one.
        let open: Policy =
            serde_json::from_str(r#"{"retention": {"local_hours": 48, "remote_days": 90}}"#)
                .unwrap();
        let mut s = Settings::default();
        s.sync.remote_retention_days = 7;
        open.apply(&mut s);
        assert!(!s.audio.enabled && !s.privacy.redact_pii);
        assert_eq!(
            (s.sync.keep_local_hours, s.sync.remote_retention_days),
            (0, 7)
        );
    }

    #[test]
    fn the_policy_sets_the_capture_rate_and_size_in_both_directions() {
        let mut s = Settings::default();
        s.interval_ms = 5000;
        s.max_width = 1280;
        s.max_height = 720;
        let p = parse(br#"{"schema": 2, "recording": {"interval_ms": 1000, "max_height": 2160}}"#)
            .unwrap();
        p.apply(&mut s);
        assert_eq!(
            (s.interval_ms, s.max_width, s.max_height),
            (1000, 3840, 2160)
        );
        // Lower than the person's own value works too: the policy sets, it does not cap.
        let p = parse(br#"{"recording": {"interval_ms": 8000, "max_height": 1080}}"#).unwrap();
        p.apply(&mut s);
        assert_eq!(
            (s.interval_ms, s.max_width, s.max_height),
            (8000, 1920, 1080)
        );
        // Out of range is clamped; an unknown height is ignored.
        let p = parse(br#"{"recording": {"interval_ms": 50, "max_height": 999}}"#).unwrap();
        p.apply(&mut s);
        assert_eq!((s.interval_ms, s.max_height), (500, 1080));
        let p = parse(br#"{"recording": {"interval_ms": 600000}}"#).unwrap();
        p.apply(&mut s);
        assert_eq!(s.interval_ms, 10_000);
        s.policy = None;
        s.validate().unwrap();
        // Absent: the device keeps its own values.
        let mut own = Settings::default();
        own.interval_ms = 3000;
        Policy::default().apply(&mut own);
        assert_eq!((own.interval_ms, own.max_height), (3000, 1440));
    }

    #[test]
    fn pause_has_an_optional_end_and_newer_schemas_are_refused() {
        let mut p = Policy::default();
        assert!(!p.paused_at(10));
        p.recording.paused = true;
        assert!(p.paused_at(10));
        p.recording.paused_until_ms = Some(20);
        assert!(p.paused_at(10) && !p.paused_at(20));
        assert!(parse(br#"{"schema": 3}"#).is_err());
        assert_eq!(parse(b"{}").unwrap(), Policy::default());
    }
}
