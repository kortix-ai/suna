//! Kortix Capture on computers an organization rolls out (Windows MSI, macOS
//! pkg, Linux deb).
//!
//! On macOS and Linux the same flow runs with a root machine service that only
//! enrolls (see [`unix`]); a global launchd agent / systemd user unit runs
//! `kortix-capture agent` in every session and records.
//!
//! On Windows, IT installs one per-machine package. It registers the machine service
//! `KortixCapture` (LocalSystem) and writes the managed configuration to
//! `HKLM\SOFTWARE\Policies\Kortix\Capture` (`Url`, `EnrollmentToken`), a key
//! only SYSTEM and Administrators can read. For every person who signs in to
//! the computer, the machine service ([`machine_run`]):
//!
//! 1. reads who signed in from the session's token (user principal name and
//!    login name), never from anything the person can type;
//! 2. asks the person's library (`kortix-capture --json sync status`, run as
//!    the person) whether it is enrolled with the configured Kortix;
//! 3. if not, enrolls over HTTP with the enrollment token itself
//!    (`issuer::enroll`) and hands only the resulting device token to the
//!    person's process (`kortix-capture sync adopt`, JSON on stdin), so the
//!    person never sees the enrollment token;
//! 4. keeps one `kortix-capture service run --managed` running as the person
//!    in that session; it records, uploads and shows the tray notice
//!    ([`tray`]). Killed processes come back; stopping the machine service
//!    stops them all (a job object).
//!
//! A pending or refused enrollment records nothing and retries on the
//! contract's cadence (`issuer::refusal_retry`). The per-user service
//! (`kortix-capture start`) stays for unmanaged installs; on a managed
//! computer `start` reports `managed` and `stop`/`logout` refuse.
//!
//! Machine-side state and the log live in `%ProgramData%\Kortix\Capture\`
//! (`machine.json`, `logs\\machine.log`); neither holds a secret.

use super::paths::MemoryPaths;
use super::settings::Settings;
use super::sync::issuer::{self, EnrollUser, Enrollment};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

#[cfg(all(windows, feature = "capture-engine"))]
mod machine;

#[cfg(unix)]
pub mod unix;

pub mod notify;

/// Self-update: the signed manifest, the installer, the health check and the rollback.
pub mod update;

/// The tray runs on Windows and macOS always, and on Linux with `memory-ui`
/// (its gtk + appindicator system libraries).
#[cfg(any(
    target_os = "windows",
    target_os = "macos",
    all(target_os = "linux", feature = "tray-linux")
))]
mod tray;

/// The Windows service name the MSI registers.
pub const SERVICE_NAME: &str = "KortixCapture";
/// `HKLM\<POLICY_KEY>` holds the managed configuration.
pub const POLICY_KEY: &str = r"SOFTWARE\Policies\Kortix\Capture";
/// How often the machine service looks at the sessions (and at once on a logon).
pub const TICK: Duration = Duration::from_secs(10);
/// How often a running session's enrollment is checked again.
pub const RECHECK: Duration = Duration::from_secs(300);

/// What IT configured: the Kortix API origin and the enrollment token.
#[derive(Clone, PartialEq)]
pub struct ManagedConfig {
    pub url: String,
    pub enrollment_token: String,
}

impl std::fmt::Debug for ManagedConfig {
    // Never print the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedConfig")
            .field("url", &self.url)
            .field("enrollment_token", &"<set>")
            .finish()
    }
}

impl ManagedConfig {
    /// A config from the two registry values; None unless both are usable.
    pub fn from_values(url: Option<String>, token: Option<String>) -> Option<Self> {
        let url = issuer::issuer_url(url.as_deref().unwrap_or(""))?;
        let url = url.strip_suffix("/v1").unwrap_or(&url).to_string();
        let token = token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())?;
        Some(ManagedConfig {
            url,
            enrollment_token: token,
        })
    }
}

/// The managed configuration: the registry (Windows), the MDM profile or the
/// root-only config file (macOS), `/etc/kortix/capture.json` (Linux). None when
/// unset, or when this user cannot read it.
pub fn read_config() -> Option<ManagedConfig> {
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        machine::read_config()
    }
    #[cfg(unix)]
    {
        unix::read_config()
    }
    #[cfg(not(any(all(windows, feature = "capture-engine"), unix)))]
    {
        None
    }
}

/// The organization manages this computer: the machine service is installed and IT
/// configured it (Windows), or a managed configuration exists (macOS profile or config file,
/// Linux `/etc/kortix/capture.json`; readable or not). Recording is the organization's.
pub fn machine_service_installed() -> bool {
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        // The MSI installs the service on every computer; it manages only once IT has
        // configured it (its public state says so).
        machine::service_installed() && machine_state_configured()
    }
    #[cfg(unix)]
    {
        unix::config_present()
    }
    #[cfg(not(any(all(windows, feature = "capture-engine"), unix)))]
    {
        false
    }
}

/// `machine.json` (readable by every user) says the machine service has IT's configuration.
#[cfg(all(windows, feature = "capture-engine"))]
fn machine_state_configured() -> bool {
    std::fs::read(state_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["configured"] == true)
}

/// The OS user running this process, for `sync enroll`.
pub fn current_user() -> EnrollUser {
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        machine::current_user()
    }
    #[cfg(unix)]
    {
        unix::current_user()
    }
    #[cfg(not(any(all(windows, feature = "capture-engine"), unix)))]
    {
        let name = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default();
        EnrollUser {
            principal_name: None,
            account_name: name,
        }
    }
}

/// The person's library is enrolled with `url` and its token stands (from `--json sync status`).
pub fn library_enrolled(sync_status: &Value, url: &str) -> bool {
    let k = &sync_status["kortix"];
    let same = |a: &str| {
        a.trim_end_matches('/')
            .eq_ignore_ascii_case(url.trim_end_matches('/'))
    };
    sync_status["provider"] == "kortix"
        && k["signed_in"] == true
        && k["sign_in_required"] != true
        && k["issuer"].as_str().is_some_and(same)
}

/// A managed library keeps Kortix sync on: the person cannot turn uploads off
/// on a computer the organization records. Called every tick of `service run --managed`.
pub fn keep_sync_on(paths: &MemoryPaths) {
    let Some(r) = issuer::registration(paths) else {
        return;
    };
    if !r.managed {
        return;
    }
    let mut s = Settings::load(paths);
    if s.sync.enabled && !s.airgap && s.sync.provider == "kortix" && s.sync.kortix.url == r.issuer {
        return;
    }
    tracing::warn!("[managed] Kortix sync was changed on a managed library; turning it back on");
    s.sync.enabled = true;
    s.airgap = false;
    s.sync.provider = "kortix".into();
    s.sync.kortix.url = r.issuer;
    s.sync.encrypt = false;
    if let Err(e) = s.save(paths) {
        tracing::warn!("[managed] could not save settings: {e:#}");
    }
}

// ─── The person's view of the enrollment ────────────────────────────────────

/// `<library>/managed.json`: the last enrollment answer the machine service
/// got for this person (the Kortix desktop app and `status` show it). No secrets.
pub const ENROLLMENT_FILE: &str = "managed.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EnrollmentState {
    /// `enrolled`, `pending`, `refused`, `error`.
    pub state: String,
    /// `pending`: `approval_required`; `error`: what failed.
    pub reason: Option<String>,
    /// `refused`: the issuer's code (`enrollment_denied`, `capture_disabled`, …).
    pub code: Option<String>,
    pub next_attempt_at_ms: Option<i64>,
    pub updated_at_ms: i64,
}

impl EnrollmentState {
    /// The state from the machine service's view of one answer.
    pub fn from_answer(
        state: &str,
        detail: Option<String>,
        next_attempt_at_ms: Option<i64>,
    ) -> Self {
        let (reason, code) = match state {
            "refused" => (None, detail),
            _ => (detail, None),
        };
        EnrollmentState {
            state: state.into(),
            reason,
            code,
            next_attempt_at_ms,
            updated_at_ms: super::store::now_ms(),
        }
    }
}

pub fn write_enrollment_state(paths: &MemoryPaths, st: &EnrollmentState) -> Result<()> {
    paths.ensure()?;
    super::sync::write_private(
        &paths.root.join(ENROLLMENT_FILE),
        &serde_json::to_vec_pretty(st)?,
    )
}

fn read_enrollment_state(paths: &MemoryPaths) -> Option<EnrollmentState> {
    serde_json::from_slice(&std::fs::read(paths.root.join(ENROLLMENT_FILE)).ok()?).ok()
}

/// `(managed, enrollment)` for `status` and `sync status`. Managed: the
/// organization enrolled this library, the machine service wrote its state, or
/// the machine service is installed. `enrollment.state`: `enrolled`,
/// `pending` (+ `reason`), `refused` (+ `code`), `error` (+ `reason`), or
/// `enrolling` (the machine service has not answered for this person yet).
pub fn enrollment_value(paths: &MemoryPaths) -> (bool, Value) {
    let reg = issuer::registration(paths);
    let file = read_enrollment_state(paths);
    let managed =
        reg.as_ref().is_some_and(|r| r.managed) || file.is_some() || machine_service_installed();
    if !managed {
        return (false, Value::Null);
    }
    let enrolled = reg
        .as_ref()
        .is_some_and(|r| r.managed && r.rejected_at_ms.is_none());
    let since = reg
        .as_ref()
        .filter(|r| r.managed)
        .map(|r| r.rejected_at_ms.unwrap_or(r.signed_in_at_ms))
        .unwrap_or(0);
    let st = if enrolled {
        EnrollmentState {
            state: "enrolled".into(),
            updated_at_ms: reg.as_ref().map(|r| r.signed_in_at_ms).unwrap_or(0),
            ..Default::default()
        }
    } else {
        file.filter(|f| f.state != "enrolled" && f.updated_at_ms >= since)
            .unwrap_or(EnrollmentState {
                state: "enrolling".into(),
                ..Default::default()
            })
    };
    let mut v = serde_json::to_value(&st).unwrap_or(Value::Null);
    v["account_name"] = json!(reg.and_then(|r| r.account_name));
    (true, v)
}

// ─── One session's schedule ─────────────────────────────────────────────────

/// What the machine service knows about one signed-in person. Serialized into
/// `machine.json` for `kortix-capture machine status`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionState {
    pub session_id: u32,
    pub user: EnrollUser,
    /// `checking`, `enrolled`, `pending`, `refused`, `error`, `not_configured`, `recording`.
    pub state: String,
    pub detail: Option<String>,
    pub device_id: Option<String>,
    pub next_attempt_at_ms: Option<i64>,
    pub child_pid: Option<u32>,
    pub restarts: u32,
}

/// The sessions as `machine.json` lists them. Every local user can read that file, so
/// it never carries a person's user principal name (an email address).
pub fn public_sessions(sessions: impl Iterator<Item = SessionState>) -> Vec<SessionState> {
    sessions
        .map(|mut s| {
            s.user.principal_name = None;
            s
        })
        .collect()
}

/// Who may own the machine folder on Windows: SYSTEM and the Administrators group.
const TRUSTED_FOLDER_OWNERS: [&str; 2] = ["S-1-5-18", "S-1-5-32-544"];

/// The SYSTEM service writes `%ProgramData%\Kortix\Capture`. It uses the folder only when
/// an administrator-level account owns it and it is a plain directory: a standard user
/// can create folders under ProgramData, and a junction there would redirect SYSTEM's
/// writes. `owner_sid` is the owner's SID string; `reparse_point` is a junction or symlink.
pub fn machine_dir_trusted(owner_sid: &str, reparse_point: bool) -> bool {
    !reparse_point && TRUSTED_FOLDER_OWNERS.contains(&owner_sid.trim())
}

/// The next step for a session from what its library said.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Enrolled: keep `service run --managed` alive.
    Run,
    /// Not enrolled with this Kortix: enroll now.
    Enroll,
}

pub fn step(sync_status: &Value, cfg: &ManagedConfig) -> Step {
    if library_enrolled(sync_status, &cfg.url) {
        Step::Run
    } else {
        Step::Enroll
    }
}

/// The session state and the wait after an enrollment answer.
pub fn after_enrollment(answer: &Result<Enrollment>) -> (String, Option<String>, Duration) {
    match answer {
        Ok(Enrollment::Enrolled(a)) => {
            ("enrolled".into(), Some(a.device_id.clone()), Duration::ZERO)
        }
        Ok(Enrollment::Pending {
            reason,
            retry_after,
            ..
        }) => ("pending".into(), Some(reason.clone()), *retry_after),
        Ok(Enrollment::Refused { code, retry_after }) => {
            ("refused".into(), Some(code.clone()), *retry_after)
        }
        Err(e) => (
            "error".into(),
            Some(format!("{e:#}").chars().take(300).collect()),
            issuer::TRANSIENT_RETRY,
        ),
    }
}

// ─── Machine-side files ────────────────────────────────────────────────────

/// `%ProgramData%\Kortix\Capture` (SYSTEM writes it; no secrets); on macOS
/// `/Library/Application Support/Kortix/Capture`, on Linux `/var/lib/kortix/capture`.
pub fn machine_dir() -> PathBuf {
    #[cfg(unix)]
    {
        unix::dir()
    }
    #[cfg(not(unix))]
    {
        windows_machine_dir()
    }
}

#[cfg(not(unix))]
fn windows_machine_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("Kortix").join("Capture")
}

pub fn state_path() -> PathBuf {
    machine_dir().join("machine.json")
}

/// `kortix-capture machine status`: the config (never the token), the service and the sessions.
pub fn machine_status() -> Value {
    let cfg = read_config();
    let state: Value = std::fs::read(state_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    #[cfg(all(windows, feature = "capture-engine"))]
    let service = machine::service_state_name();
    #[cfg(unix)]
    let service = unix::service_state_name();
    #[cfg(not(any(all(windows, feature = "capture-engine"), unix)))]
    let service: Option<String> = None;
    json!({
        "service": service.unwrap_or_else(|| "not installed".into()),
        "config": {
            "url": cfg.as_ref().map(|c| c.url.clone()),
            "enrollment_token": cfg.is_some(),
        },
        "state": state,
        "version": super::sync::app_version(),
        "update": update::report(),
    })
}

/// `kortix-capture machine configure --token …` (the MSI's custom action on
/// Windows). On macOS and Linux, as root: write the config file from `--url` and the token.
pub fn machine_configure(url: Option<&str>, token: &str) -> Result<()> {
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        let _ = url;
        machine::configure_token(token)
    }
    #[cfg(unix)]
    {
        unix::configure(url, token)
    }
    #[cfg(not(any(all(windows, feature = "capture-engine"), unix)))]
    {
        let _ = (url, token);
        anyhow::bail!("the machine configuration needs Windows, macOS or Linux")
    }
}

/// `kortix-capture machine run`.
pub fn machine_run() -> Result<()> {
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        machine::run()
    }
    #[cfg(unix)]
    {
        unix::run()
    }
    #[cfg(not(any(all(windows, feature = "capture-engine"), unix)))]
    {
        anyhow::bail!("the machine service runs on Windows (a build with the capture engine), macOS and Linux")
    }
}

/// `kortix-capture agent`: what the global launchd agent / systemd user unit
/// runs in each person's session (macOS, Linux).
pub fn agent(paths: &MemoryPaths) -> Result<()> {
    #[cfg(unix)]
    {
        unix::agent(paths)
    }
    #[cfg(not(unix))]
    {
        let _ = paths;
        anyhow::bail!("the agent runs on macOS and Linux; Windows uses the machine service")
    }
}

// ─── The tray text and the organization's notice ───────────────────────────

/// What the tray shows.
#[derive(Debug, Clone, PartialEq)]
pub struct TrayText {
    /// Hover text (Windows keeps 127 characters).
    pub tip: String,
    /// The first menu line.
    pub status: String,
}

/// The tray's words for this library now. `recording`: the service's recorder runs.
pub fn tray_text(paths: &MemoryPaths, recording: bool) -> TrayText {
    let account = issuer::registration(paths).and_then(|r| r.account_name);
    let reason = Settings::effective(paths).inactive_reason(super::store::now_ms());
    tray_words(account.as_deref(), recording, reason)
}

/// Labels and status only. The account is named when it is known.
pub fn tray_words(account: Option<&str>, recording: bool, reason: Option<&str>) -> TrayText {
    let status = match (reason, recording) {
        (Some("policy_paused"), _) => account.map_or("Paused by policy".into(), |a| format!("Paused by {a}")),
        (Some("policy_off"), _) => account.map_or("Screen recording is off by policy".into(), |a| format!("Screen recording is off for {a}")),
        (Some(_), _) => "Paused".to_string(),
        (None, true) => account.map_or("Recording".into(), |a| format!("Recording for {a}")),
        (None, false) => "Not recording".to_string(),
    };
    let tip: String = format!("Kortix Capture — {}", status.to_lowercase_first())
        .chars()
        .take(127)
        .collect();
    TrayText { tip, status }
}

/// The organization's notice, shown once per person per notice text: `(title, body, hash)`.
/// Nothing when the organization set none, or when `shown_hash` is this text's hash.
/// The title is the account name, else the app name. No placeholder sentence.
pub fn notice_to_show(
    notice: Option<&str>,
    account: Option<&str>,
    shown_hash: &str,
) -> Option<(String, String, String)> {
    use sha2::{Digest, Sha256};
    let text = notice.map(str::trim).filter(|n| !n.is_empty())?;
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    (hash != shown_hash.trim()).then(|| {
        (
            account
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .unwrap_or("Kortix Capture")
                .to_string(),
            text.chars().take(255).collect(),
            hash,
        )
    })
}

fn notice_marker(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("notice-shown")
}

/// The notice this library has not shown yet, if the organization's policy has one.
pub fn pending_notice(paths: &MemoryPaths) -> Option<(String, String, String)> {
    let policy = super::policy::read(paths)?;
    let account = issuer::registration(paths).and_then(|r| r.account_name);
    let shown = std::fs::read_to_string(notice_marker(paths)).unwrap_or_default();
    notice_to_show(policy.policy.notice(), account.as_deref(), &shown)
}

pub fn mark_notice_shown(paths: &MemoryPaths, hash: &str) {
    let _ = std::fs::write(notice_marker(paths), hash);
}

trait LowerFirst {
    fn to_lowercase_first(&self) -> String;
}

impl LowerFirst for String {
    fn to_lowercase_first(&self) -> String {
        let mut c = self.chars();
        match c.next() {
            Some(f) => f.to_lowercase().chain(c).collect(),
            None => String::new(),
        }
    }
}

/// What the tray menu offers besides "Open Kortix Capture".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// "Pause for 1 hour" (`kortix-capture pause 1h`).
    Pause,
    /// "Pause until tomorrow" (`kortix-capture pause tomorrow`).
    PauseTomorrow,
    /// "Pause until I resume" (`kortix-capture pause forever`).
    PauseForever,
    /// "Resume" while paused (`kortix-capture resume`).
    Resume,
}

/// A managed computer offers none of them: the organization runs the recording.
/// A computer the person set up offers the pauses (or "Resume" while paused). There is no
/// Quit: nothing in the menu stops the background recorder, only a pause does.
pub fn tray_actions(managed: bool, paused: bool) -> Vec<TrayAction> {
    if managed {
        return vec![];
    }
    if paused {
        vec![TrayAction::Resume]
    } else {
        vec![TrayAction::Pause, TrayAction::PauseTomorrow, TrayAction::PauseForever]
    }
}

/// The tray's status line. A managed computer uses the organization's words; a
/// computer the person set up says what it does: `state` is the app's one word
/// (`recording`, `paused`, `permission_missing`, `not_recording`).
pub fn tray_status(
    text: &TrayText,
    managed: bool,
    state: &str,
    paused_until_ms: Option<i64>,
) -> String {
    match (state, managed) {
        ("permission_missing", _) => "Needs Screen Recording permission".into(),
        (_, true) => text.status.clone(),
        ("recording", false) => "Recording".into(),
        ("paused", false) => match paused_until_ms.and_then(|t| {
            chrono::TimeZone::timestamp_millis_opt(&chrono::Local, t).single()
        }) {
            Some(t) => format!("Paused until {}", t.format("%-I:%M %p")),
            None => "Paused".into(),
        },
        _ => "Not recording".into(),
    }
}

/// `kortix-capture tray`. `autostart`: started by the desktop's autostart entry;
/// a managed computer runs its tray from the agent, so this one exits.
pub fn tray(paths: &MemoryPaths, autostart: bool) -> Result<()> {
    if autostart && machine_service_installed() {
        return Ok(());
    }
    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        all(target_os = "linux", feature = "tray-linux")
    ))]
    {
        tray::run(paths)
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        all(target_os = "linux", feature = "tray-linux")
    )))]
    {
        let _ = paths;
        anyhow::bail!("the tray needs the tray-linux feature on this platform")
    }
}

/// This build can show the tray.
pub const TRAY_AVAILABLE: bool = cfg!(any(
    target_os = "windows",
    target_os = "macos",
    all(target_os = "linux", feature = "tray-linux")
));

/// A tray already runs for this library (it holds `tray.lock`).
pub fn tray_running(paths: &MemoryPaths) -> bool {
    match tray_lock(paths) {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(_) => false,
    }
}

/// The single-instance lock of the tray: `Some(file)` when this process got it.
pub fn tray_lock(paths: &MemoryPaths) -> std::io::Result<Option<std::fs::File>> {
    std::fs::create_dir_all(&paths.root)?;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.root.join("tray.lock"))?;
    Ok(f.try_lock().is_ok().then_some(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ManagedConfig {
        ManagedConfig::from_values(
            Some("https://api.kortix.example/".into()),
            Some(" kortix_enr_x ".into()),
        )
        .unwrap()
    }

    #[test]
    fn the_config_needs_both_values_and_never_prints_the_token() {
        let c = cfg();
        assert_eq!(c.url, "https://api.kortix.example");
        assert_eq!(c.enrollment_token, "kortix_enr_x");
        assert!(!format!("{c:?}").contains("kortix_enr_x"));
        // IT may paste the API URL with /v1; the issuer adds it itself.
        assert_eq!(
            ManagedConfig::from_values(
                Some("https://api.kortix.example/v1".into()),
                Some("t".into())
            )
            .unwrap()
            .url,
            "https://api.kortix.example"
        );
        assert!(
            ManagedConfig::from_values(None, Some("t".into())).is_none()
                || issuer::DEFAULT_ISSUER.is_some()
        );
        assert!(ManagedConfig::from_values(Some("https://x".into()), Some("  ".into())).is_none());
    }

    #[test]
    fn a_library_is_enrolled_only_with_the_configured_kortix_and_a_standing_token() {
        let c = cfg();
        let ok = json!({"provider": "kortix", "kortix": {"signed_in": true, "sign_in_required": false, "issuer": "https://API.kortix.example/"}});
        assert_eq!(step(&ok, &c), Step::Run);
        let other = json!({"provider": "kortix", "kortix": {"signed_in": true, "issuer": "https://other.example"}});
        assert_eq!(
            step(&other, &c),
            Step::Enroll,
            "a library signed in elsewhere is enrolled again"
        );
        let refused = json!({"provider": "kortix", "kortix": {"signed_in": false, "sign_in_required": true, "issuer": "https://api.kortix.example"}});
        assert_eq!(
            step(&refused, &c),
            Step::Enroll,
            "a revoked token enrolls again"
        );
        let local = json!({"provider": "s3", "kortix": {"signed_in": false}});
        assert_eq!(step(&local, &c), Step::Enroll);
        assert_eq!(
            step(&Value::Null, &c),
            Step::Enroll,
            "an unreadable library enrolls"
        );
    }

    #[test]
    fn enrollment_answers_set_the_state_and_the_wait() {
        let pending: Result<Enrollment> = Ok(Enrollment::Pending {
            reason: "approval_required".into(),
            enrollment_id: None,
            retry_after: Duration::from_secs(60),
        });
        assert_eq!(
            after_enrollment(&pending),
            (
                "pending".into(),
                Some("approval_required".into()),
                Duration::from_secs(60)
            )
        );
        let denied: Result<Enrollment> = Ok(Enrollment::Refused {
            code: "enrollment_denied".into(),
            retry_after: issuer::refusal_retry("enrollment_denied"),
        });
        assert_eq!(after_enrollment(&denied).2, Duration::from_secs(6 * 3600));
        let down: Result<Enrollment> = Err(anyhow::anyhow!("connection refused"));
        assert_eq!(after_enrollment(&down).0, "error");
        assert_eq!(after_enrollment(&down).2, Duration::from_secs(60));
    }

    #[test]
    fn the_tray_says_status_only_and_names_the_account_when_known() {
        let t = tray_words(Some("Example Org"), true, None);
        assert_eq!(t.tip, "Kortix Capture — recording for Example Org");
        assert_eq!(t.status, "Recording for Example Org");
        assert_eq!(tray_words(None, true, None).status, "Recording");
        assert_eq!(tray_words(None, false, None).status, "Not recording");
        assert_eq!(tray_words(Some("Example Org"), true, Some("policy_paused")).status, "Paused by Example Org");
        assert_eq!(tray_words(None, true, Some("policy_paused")).status, "Paused by policy");
        for t in [tray_words(None, true, Some("policy_off")), tray_words(None, false, None)] {
            assert!(!t.status.to_lowercase().contains("your organization"), "{}", t.status);
        }
        let long = "x".repeat(400);
        assert_eq!(tray_words(Some(&long), true, None).tip.chars().count(), 127);
    }

    #[test]
    fn the_person_sees_pending_refused_and_enrolled() {
        std::env::set_var(crate::secret_store::STORE_ENV, "file");
        let dir =
            std::env::temp_dir().join(format!("kcap-state-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        if !machine_service_installed() {
            assert_eq!(
                enrollment_value(&paths),
                (false, Value::Null),
                "an unmanaged library"
            );
        }
        write_enrollment_state(
            &paths,
            &EnrollmentState::from_answer("pending", Some("approval_required".into()), Some(1)),
        )
        .unwrap();
        let (managed, v) = enrollment_value(&paths);
        assert!(managed);
        assert_eq!(
            (v["state"].as_str(), v["reason"].as_str()),
            (Some("pending"), Some("approval_required"))
        );
        write_enrollment_state(
            &paths,
            &EnrollmentState::from_answer("refused", Some("enrollment_denied".into()), None),
        )
        .unwrap();
        let (_, v) = enrollment_value(&paths);
        assert_eq!(
            (v["state"].as_str(), v["code"].as_str()),
            (Some("refused"), Some("enrollment_denied"))
        );
        issuer::adopt(
            &paths,
            &issuer::Adoption {
                issuer: "https://api.kortix.example".into(),
                device_token: "kortix_cap_synthetic".into(),
                prefix: "orgs/o1".into(),
                device_id: "d1".into(),
                member_email: None,
                account_name: Some("Example Org".into()),
            },
        )
        .unwrap();
        let (_, v) = enrollment_value(&paths);
        assert_eq!(
            (v["state"].as_str(), v["account_name"].as_str()),
            (Some("enrolled"), Some("Example Org"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_organizations_notice_shows_once_per_text_and_never_as_a_placeholder() {
        // No notice set: nothing, whoever the account is.
        assert_eq!(notice_to_show(None, Some("Example Org"), ""), None);
        assert_eq!(notice_to_show(Some("   "), Some("Example Org"), ""), None);
        let (title, body, hash) =
            notice_to_show(Some("  Recorded for process analysis.  "), Some("Example Org"), "").unwrap();
        assert_eq!((title.as_str(), body.as_str()), ("Example Org", "Recorded for process analysis."));
        // Shown once: the same text with its hash stored is not shown again.
        assert_eq!(notice_to_show(Some("Recorded for process analysis."), Some("Example Org"), &hash), None);
        // A changed text shows again; no account name falls back to the app name.
        let (title, _, h2) = notice_to_show(Some("New text."), None, &hash).unwrap();
        assert_eq!(title, "Kortix Capture");
        assert_ne!(h2, hash);
        let long = "y".repeat(400);
        assert_eq!(notice_to_show(Some(&long), None, "").unwrap().1.chars().count(), 255);
    }

    #[test]
    fn the_machine_folder_is_used_only_when_an_admin_account_owns_a_plain_directory() {
        assert!(machine_dir_trusted("S-1-5-18", false), "SYSTEM");
        assert!(machine_dir_trusted("S-1-5-32-544", false), "Administrators");
        assert!(!machine_dir_trusted("S-1-5-21-1111-2222-3333-1001", false), "a standard user");
        assert!(!machine_dir_trusted("S-1-5-32-545", false), "the Users group");
        assert!(!machine_dir_trusted("S-1-5-18", true), "a junction, even to a SYSTEM folder");
        assert!(!machine_dir_trusted("", false));
    }

    #[test]
    fn machine_json_does_not_list_user_principal_names() {
        let s = SessionState {
            session_id: 1,
            user: EnrollUser {
                principal_name: Some("jane@corp.example".into()),
                account_name: "CORP\\jane".into(),
            },
            state: "recording".into(),
            ..Default::default()
        };
        let shown = public_sessions([s.clone()].into_iter());
        assert_eq!(shown[0].user.principal_name, None);
        assert_eq!(shown[0].user.account_name, s.user.account_name);
        assert!(!serde_json::to_string(&shown).unwrap().contains("corp.example"));
    }

    #[test]
    fn the_tray_offers_pauses_and_nothing_when_managed() {
        assert_eq!(tray_actions(true, false), vec![]);
        assert_eq!(tray_actions(true, true), vec![]);
        assert_eq!(
            tray_actions(false, false),
            vec![TrayAction::Pause, TrayAction::PauseTomorrow, TrayAction::PauseForever],
            "pauses only, never a Quit"
        );
        assert_eq!(tray_actions(false, true), vec![TrayAction::Resume]);
        let t = tray_words(Some("Example Org"), true, None);
        assert_eq!(tray_status(&t, false, "recording", None), "Recording");
        assert_eq!(tray_status(&t, false, "not_recording", None), "Not recording");
        assert_eq!(
            tray_status(&t, false, "permission_missing", None),
            "Needs Screen Recording permission"
        );
        assert_eq!(tray_status(&t, false, "paused", None), "Paused");
        assert!(tray_status(&t, false, "paused", Some(1_800_000_000_000))
            .starts_with("Paused until "));
        assert_eq!(
            tray_status(&t, true, "recording", None),
            "Recording for Example Org"
        );
    }

    #[test]
    fn keep_sync_on_restores_a_managed_library_and_leaves_others() {
        let dir =
            std::env::temp_dir().join(format!("kcap-managed-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        std::env::set_var(crate::secret_store::STORE_ENV, "file");
        // Unmanaged: nothing changes.
        keep_sync_on(&paths);
        assert!(!Settings::load(&paths).sync.enabled);
        issuer::adopt(
            &paths,
            &issuer::Adoption {
                issuer: "https://api.kortix.example".into(),
                device_token: "kortix_cap_synthetic".into(),
                prefix: "orgs/o1".into(),
                device_id: "d1".into(),
                member_email: Some("person@example.com".into()),
                account_name: Some("Example Org".into()),
            },
        )
        .unwrap();
        let mut s = Settings::load(&paths);
        s.sync.enabled = false;
        s.save(&paths).unwrap();
        keep_sync_on(&paths);
        let s = Settings::load(&paths);
        assert!(s.sync.enabled && s.sync.provider == "kortix");
        assert_eq!(s.sync.kortix.url, "https://api.kortix.example");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
