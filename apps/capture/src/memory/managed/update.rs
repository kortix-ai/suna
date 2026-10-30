//! Self-update of Kortix Capture, run by the machine service (root / SYSTEM).
//!
//! The service checks a signed manifest at start and every 6 hours (jittered).
//! A newer, verified installer for this OS is downloaded to a directory only
//! root can write, installed silently, and then proved healthy. If the new
//! version does not become healthy, the previous installer goes back and the
//! new version is marked bad.
//!
//! Rules, in the order they run:
//!
//! 1. IT can turn updates off (`auto_update`) and pin the channel
//!    (`update_channel`): see [`parse_policy`].
//! 2. No release version or no public key compiled in: no update (logged once).
//! 3. The manifest comes over https. Its Ed25519 signature must verify against
//!    the public key compiled in (`KORTIX_CAPTURE_UPDATE_PUBLIC_KEY`).
//! 4. The manifest channel must be the channel asked for. `paused: true` stops
//!    the roll-out. The version must be newer (semver) than the installed one
//!    and not marked bad. A downgrade is never installed (except the rollback).
//! 5. The installer is checked for size and SHA-256 from the signed manifest,
//!    and for the platform signature (warn only while installers are unsigned).
//! 6. A detached supervisor (`machine update-apply`) installs it, because the
//!    installer stops this very service. It waits for the new service to prove
//!    health ([`person_ok`] for every signed-in person), and rolls back if not.
//!
//! Files live in [`updates_dir`]: `update.json` (state, written by the service
//! only), `job.json` (the order for the supervisor), `result.json` (its answer),
//! `verified.json` (written by the new service), `staging/` and `kept/`.
//!
//! Test builds (CI only) set `KORTIX_CAPTURE_UPDATE_TEST_*` at compile time. A
//! release build never sets them; CI asserts the release binary does not
//! contain the test manifest URL.

use super::machine_dir;
use crate::memory::store::now_ms;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ─── Build-time inputs ──────────────────────────────────────────────────────

/// Base64 of the 32-byte Ed25519 public key that verifies `capture-update.json`.
const PUBLIC_KEY: Option<&str> = option_env!("KORTIX_CAPTURE_UPDATE_PUBLIC_KEY");
/// The release tag baked in by CI (`v0.13.57`, `v0.13.57-dev.12`). Unset on a local build.
const RELEASE_TAG: Option<&str> = option_env!("KORTIX_RELEASE_TAG");
/// CI test builds only: a manifest URL (http on loopback allowed) replacing the channel URL.
const TEST_MANIFEST_URL: Option<&str> = option_env!("KORTIX_CAPTURE_UPDATE_TEST_MANIFEST_URL");
/// CI test builds only: seconds between checks.
const TEST_INTERVAL_SECS: Option<&str> = option_env!("KORTIX_CAPTURE_UPDATE_TEST_INTERVAL_SECS");
/// CI test builds only: seconds the new version has to become healthy.
const TEST_HEALTH_SECS: Option<&str> = option_env!("KORTIX_CAPTURE_UPDATE_TEST_HEALTH_SECS");

pub const STABLE_URL: &str =
    "https://github.com/kortix-ai/suna/releases/latest/download/capture-update.json";
pub const DEV_URL: &str =
    "https://github.com/kortix-ai/suna/releases/download/capture-dev-latest/capture-update.json";

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const RETRY_FIRST: Duration = Duration::from_secs(30 * 60);
const MANIFEST_MAX: u64 = 1 << 20;
const INSTALLER_MAX: u64 = 1 << 30;
/// A new version has this long to prove healthy before the previous one goes back.
const HEALTH_WINDOW: Duration = Duration::from_secs(15 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

fn test_hooks() -> bool {
    TEST_MANIFEST_URL.is_some()
}

fn secs_env(v: Option<&str>) -> Option<Duration> {
    v.and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn check_every() -> Duration {
    secs_env(TEST_INTERVAL_SECS).unwrap_or(CHECK_EVERY)
}

fn health_window() -> Duration {
    secs_env(TEST_HEALTH_SECS).unwrap_or(HEALTH_WINDOW)
}

// ─── Versions ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Ident {
    Num(u64),
    Alpha(String),
}

/// Semantic version `X.Y.Z[-pre.release]`. A pre-release is older than its release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<Ident>,
}

impl Version {
    /// `v0.13.57`, `0.13.57-dev.12`; build metadata (`+…`) is ignored.
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim().trim_start_matches('v');
        let s = s.split('+').next()?;
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let nums: Vec<u64> = core
            .split('.')
            .map(|p| p.parse::<u64>().ok())
            .collect::<Option<_>>()?;
        let core: [u64; 3] = nums.try_into().ok()?;
        let pre = match pre {
            None => Vec::new(),
            Some(p) => p
                .split('.')
                .map(|i| {
                    if i.is_empty() || !i.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                        None
                    } else if i.chars().all(|c| c.is_ascii_digit()) {
                        i.parse().ok().map(Ident::Num)
                    } else {
                        Some(Ident::Alpha(i.to_string()))
                    }
                })
                .collect::<Option<_>>()?,
        };
        Some(Version { core, pre })
    }

    pub fn is_dev(&self) -> bool {
        self.pre.first() == Some(&Ident::Alpha("dev".into()))
    }
}

impl Ord for Version {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        match self.core.cmp(&o.core) {
            Equal => match (self.pre.is_empty(), o.pre.is_empty()) {
                (true, true) => Equal,
                (true, false) => Greater,
                (false, true) => Less,
                (false, false) => self.pre.cmp(&o.pre),
            },
            other => other,
        }
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.core[0], self.core[1], self.core[2])?;
        for (i, p) in self.pre.iter().enumerate() {
            f.write_str(if i == 0 { "-" } else { "." })?;
            match p {
                Ident::Num(n) => write!(f, "{n}")?,
                Ident::Alpha(a) => f.write_str(a)?,
            }
        }
        Ok(())
    }
}

/// The version this build reports, or None on a local build with no release tag.
pub fn installed_version() -> Option<Version> {
    RELEASE_TAG.and_then(Version::parse)
}

// ─── Policy (what IT controls) ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Dev,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Dev => "dev",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub enabled: bool,
    /// None: the channel this build came from.
    pub channel: Option<Channel>,
}

fn truthy(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_i64().map(|n| n != 0),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "0" | "false" | "off" | "no" | "disabled" => Some(false),
            "1" | "true" | "on" | "yes" | "enabled" => Some(true),
            _ => None,
        },
        _ => None,
    }
}

/// The policy from the managed sources, strongest first (macOS: the MDM profile, then
/// `config.json`; Linux: `/etc/kortix/capture.json`; Windows: the policy key values as
/// one object). Keys: `auto_update` / `AutoUpdate`, `update_channel` / `UpdateChannel`.
/// A key unset or unreadable keeps the default: updates on, the build's own channel.
pub fn parse_policy(sources: &[Value]) -> Policy {
    let pick = |names: [&str; 2]| {
        sources
            .iter()
            .flat_map(|s| names.iter().map(move |n| &s[*n]))
            .find(|v| !v.is_null())
            .cloned()
    };
    Policy {
        enabled: pick(["auto_update", "AutoUpdate"])
            .and_then(|v| truthy(&v))
            .unwrap_or(true),
        channel: pick(["update_channel", "UpdateChannel"]).and_then(|v| {
            match v.as_str()?.trim().to_ascii_lowercase().as_str() {
                "stable" => Some(Channel::Stable),
                "dev" => Some(Channel::Dev),
                _ => None,
            }
        }),
    }
}

fn read_policy() -> Policy {
    #[cfg(unix)]
    {
        parse_policy(&super::unix::policy_values())
    }
    #[cfg(all(windows, feature = "capture-engine"))]
    {
        parse_policy(&[super::machine::policy_value()])
    }
    #[cfg(not(any(unix, all(windows, feature = "capture-engine"))))]
    {
        parse_policy(&[])
    }
}

// ─── The signed manifest ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Previous {
    pub version: String,
    pub assets: BTreeMap<String, Asset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub channel: String,
    /// Publish a manifest with `paused: true` to stop a bad release from spreading.
    #[serde(default)]
    pub paused: bool,
    /// The release before this one (stable): lets a device that never kept an
    /// installer roll back.
    #[serde(default)]
    pub previous: Option<Previous>,
    pub assets: BTreeMap<String, Asset>,
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Verify `sig_b64` (Ed25519 over the exact manifest bytes) against `public_keys_b64`, then
/// parse. The build may carry several keys, comma separated (key rotation): any one that
/// verifies is enough.
pub fn verify_manifest(body: &[u8], sig_b64: &str, public_keys_b64: &str) -> Result<Manifest> {
    let sig: [u8; 64] = B64
        .decode(sig_b64.trim())
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| anyhow!("the signature is not 64 bytes of base64"))?;
    let sig = Signature::from_bytes(&sig);
    let mut usable = 0;
    for key in public_keys_b64
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        let Some(key) = B64
            .decode(key)
            .ok()
            .and_then(|k| <[u8; 32]>::try_from(k).ok())
            .and_then(|k| VerifyingKey::from_bytes(&k).ok())
        else {
            continue;
        };
        usable += 1;
        if key.verify_strict(body, &sig).is_ok() {
            return serde_json::from_slice(body).context("the manifest is not valid JSON");
        }
    }
    if usable == 0 {
        bail!("the compiled-in update public key is not 32 bytes of base64");
    }
    bail!("the manifest signature does not verify")
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Install this asset of this version.
    Install(Box<Asset>, String),
    UpToDate,
    Paused,
    Refused(String),
}

/// Whether to install `m`. `os` is the manifest key for this computer (`windows`, `macos`, `linux`).
pub fn decide(
    m: &Manifest,
    current: &Version,
    channel: Channel,
    bad: &[String],
    os: &str,
) -> Decision {
    if m.channel != channel.name() {
        return Decision::Refused(format!(
            "the manifest is for channel {}, this computer follows {}",
            m.channel,
            channel.name()
        ));
    }
    let Some(v) = Version::parse(&m.version) else {
        return Decision::Refused(format!(
            "the manifest version {:?} is not semver",
            m.version
        ));
    };
    if m.paused {
        return Decision::Paused;
    }
    if v <= *current {
        return Decision::UpToDate;
    }
    if bad
        .iter()
        .any(|b| Version::parse(b).is_some_and(|b| b == v))
    {
        return Decision::Refused(format!("{v} is marked bad on this computer"));
    }
    let Some(asset) = m.assets.get(os) else {
        return Decision::Refused(format!("the manifest has no installer for {os}"));
    };
    Decision::Install(Box::new(asset.clone()), v.to_string())
}

// ─── Health (what the new version must show) ────────────────────────────────

/// One signed-in person is fine when their recorder runs, and, while it says it
/// records, it saved a frame after `since_ms` (the install). Paused, a missing
/// permission and a locked screen are the person's state, not the update's.
/// `status` is `kortix-capture --json status` run as that person.
pub fn person_ok(status: &Value, since_ms: i64) -> bool {
    if status["recorder_running"] != true {
        return false;
    }
    if status["state"] != "recording" {
        return true;
    }
    status["counts"]["last_frame_ms"].as_i64().unwrap_or(0) > since_ms
}

// ─── Files ──────────────────────────────────────────────────────────────────

/// Where the updater keeps its files. Windows: outside the MSI's machine folder, since an
/// upgrade or an uninstall removes that folder and the rollback needs these files.
pub fn updates_dir() -> PathBuf {
    #[cfg(unix)]
    {
        machine_dir().join("updates")
    }
    #[cfg(not(unix))]
    {
        let machine = machine_dir();
        machine
            .parent()
            .map(|p| p.join("CaptureUpdate"))
            .unwrap_or_else(|| machine.join("updates"))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644));
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Create a directory only root can write. A pre-made link or a directory somebody
/// else owns is refused (unix: owner root, no group or other write bits).
fn ensure_dir(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        if std::fs::symlink_metadata(path).is_err() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(mode)
                .create(path)?;
        }
        let m = std::fs::symlink_metadata(path)?;
        if !m.is_dir() || m.uid() != 0 || m.mode() & 0o022 != 0 {
            bail!("{} is not a directory only root can write", path.display());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        if let Ok(m) = std::fs::symlink_metadata(path) {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                bail!("{} is a link", path.display());
            }
        }
        std::fs::create_dir_all(path)?;
        #[cfg(feature = "capture-engine")]
        super::machine::require_trusted_owner(path)?;
    }
    Ok(())
}

fn log_line(line: &str) {
    let dir = updates_dir();
    let path = dir.join("update.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512 * 1024) {
        let _ = std::fs::rename(&path, dir.join("update.log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{} {line}", chrono::Utc::now().to_rfc3339());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LastResult {
    pub at_ms: i64,
    pub from: String,
    pub to: String,
    /// `updated`, `rolled_back` or `failed`.
    pub outcome: String,
    pub detail: Option<String>,
}

/// `update.json`: written only by the machine service.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct State {
    pub installed: String,
    pub channel: String,
    pub enabled: bool,
    /// The newest version the last good manifest named.
    pub latest: Option<String>,
    pub last_check_ms: Option<i64>,
    /// What the last check did, in a sentence.
    pub last_check: Option<String>,
    pub last_result: Option<LastResult>,
    /// Versions that failed their health check here; never tried again.
    #[serde(default)]
    pub bad: Vec<String>,
    pub updating_to: Option<String>,
}

fn state_path() -> PathBuf {
    updates_dir().join("update.json")
}

pub fn read_state() -> Option<State> {
    serde_json::from_slice(&std::fs::read(state_path()).ok()?).ok()
}

/// Write the state. `bad` and `last_result` come from the file, not from `s`: another
/// writer (the supervisor's answer, `update-reset`) may have changed them since `s` was read.
fn write_state(s: &State) {
    if ensure_dir(&updates_dir(), 0o755).is_ok() {
        let mut s = s.clone();
        if let Some(disk) = read_state() {
            s.bad = disk.bad;
            s.last_result = disk.last_result;
        }
        let _ = write_atomic(
            &state_path(),
            &serde_json::to_vec_pretty(&s).unwrap_or_default(),
        );
    }
}

/// Like [`write_state`], for the writers that mean to change `bad` or `last_result`.
fn write_state_exact(s: &State) {
    if ensure_dir(&updates_dir(), 0o755).is_ok() {
        let _ = write_atomic(
            &state_path(),
            &serde_json::to_vec_pretty(s).unwrap_or_default(),
        );
    }
}

/// The part of the state devices put in `status.json` and `machine status`, so
/// Kortix can show "behind" and "update failed". Null on a computer with no machine service.
pub fn report() -> Value {
    read_state().map(|s| summarize(&s)).unwrap_or(Value::Null)
}

fn summarize(s: &State) -> Value {
    let ver = |v: &Option<String>| v.as_deref().and_then(Version::parse);
    let behind = ver(&s.latest)
        .zip(Version::parse(&s.installed))
        .is_some_and(|(l, i)| l > i);
    // The newest release did not install here (a later release clears this).
    let failed = s
        .last_result
        .as_ref()
        .is_some_and(|r| r.outcome != "updated" && s.latest.as_deref() == Some(r.to.as_str()));
    let status = if !s.enabled {
        "disabled"
    } else if s.updating_to.is_some() {
        "updating"
    } else if failed {
        "failed"
    } else if behind {
        "behind"
    } else {
        "current"
    };
    json!({
        "status": status,
        "installed": s.installed,
        "channel": s.channel,
        "latest": s.latest,
        "lastCheckMs": s.last_check_ms,
        "lastResult": s.last_result,
        "badVersions": s.bad,
    })
}

/// `kortix-capture machine update-reset` (root): forget the versions marked bad.
pub fn reset() -> Result<()> {
    let mut s = read_state()
        .ok_or_else(|| anyhow!("no update state: the machine service has not run yet"))?;
    s.bad.clear();
    s.last_result = None;
    write_state_exact(&s);
    Ok(())
}

// ─── The order for the supervisor ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Job {
    from: String,
    to: String,
    installer: PathBuf,
    previous: Option<PathBuf>,
    health_secs: u64,
    started_ms: i64,
    #[serde(default)]
    claimed_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JobResult {
    from: String,
    to: String,
    outcome: String,
    detail: Option<String>,
    at_ms: i64,
}

fn job_path() -> PathBuf {
    updates_dir().join("job.json")
}
fn result_path() -> PathBuf {
    updates_dir().join("result.json")
}
fn verified_path() -> PathBuf {
    updates_dir().join("verified.json")
}

fn read_job() -> Option<Job> {
    serde_json::from_slice(&std::fs::read(job_path()).ok()?).ok()
}

/// A job whose supervisor must have died (reboot, kill): older than the install timeout
/// plus two health windows plus a margin.
fn job_stale(j: &Job) -> bool {
    let limit = INSTALL_TIMEOUT + health_window() * 2 + Duration::from_secs(600);
    now_ms() - j.started_ms > limit.as_millis() as i64
}

fn installer_ext() -> &'static str {
    if cfg!(windows) {
        "msi"
    } else if cfg!(target_os = "macos") {
        "pkg"
    } else {
        "deb"
    }
}

/// The key of this computer's installer in the manifest; None where no installer exists.
fn os_key() -> Option<&'static str> {
    if cfg!(windows) {
        Some("windows")
    } else if cfg!(target_os = "macos") {
        Some("macos")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("linux")
    } else {
        None
    }
}

// ─── The service side ───────────────────────────────────────────────────────

/// Owned by the machine service loop; `tick` costs nothing between checks.
pub struct Updater {
    next_check: Instant,
    failures: u32,
    worker: Option<std::thread::JoinHandle<bool>>,
    ok_probes: u32,
    verifying_job: Option<i64>,
}

fn random_u64() -> u64 {
    uuid::Uuid::new_v4().as_u128() as u64
}

impl Updater {
    pub fn new() -> Updater {
        // Not at once: the first minutes belong to enrollment. Spread a fleet over 5 minutes.
        let delay = if test_hooks() {
            Duration::from_secs(3)
        } else {
            Duration::from_secs(60 + random_u64() % 240)
        };
        Updater {
            next_check: Instant::now() + delay,
            failures: 0,
            worker: None,
            ok_probes: 0,
            verifying_job: None,
        }
    }

    /// Whether the service is waiting to prove a freshly installed version healthy,
    /// and since when (ms): the machine loop then probes every person with [`person_ok`].
    pub fn verifying_since(&self) -> Option<i64> {
        self.verifying_job
    }

    /// The machine loop reports one health probe; two good ones in a row verify the update.
    pub fn note_probe(&mut self, ok: bool) {
        let Some(job) = read_job() else {
            return;
        };
        self.ok_probes = if ok { self.ok_probes + 1 } else { 0 };
        if self.ok_probes >= 2 && !test_fail_health() {
            let v = json!({"version": job.to, "at_ms": now_ms(), "pid": std::process::id()});
            let _ = write_atomic(&verified_path(), v.to_string().as_bytes());
            log_line(&format!("{} is healthy", job.to));
        }
    }

    pub fn tick(&mut self) {
        self.ingest_result();
        let current = installed_version();
        // A freshly installed version proves itself before anything else.
        self.verifying_job = None;
        if let (Some(job), Some(cur)) = (read_job(), current.as_ref()) {
            if Version::parse(&job.to).as_ref() == Some(cur) && !verified_for(&job) {
                self.verifying_job = Some(job.started_ms);
            }
        }
        if let Some(w) = &self.worker {
            if !w.is_finished() {
                return;
            }
            let retry = self
                .worker
                .take()
                .map(|w| w.join().unwrap_or(true))
                .unwrap_or(false);
            self.failures = if retry { self.failures + 1 } else { 0 };
            let base = if retry {
                (RETRY_FIRST * 2u32.pow(self.failures.saturating_sub(1).min(4))).min(check_every())
            } else {
                check_every()
            };
            // ±10 % so a fleet does not call at the same second.
            let jitter = (random_u64() % 2001) as i64 - 1000;
            let ms = (base.as_millis() as i64 * (1000 + jitter / 10) / 1000).max(1000);
            self.next_check = Instant::now() + Duration::from_millis(ms as u64);
        }
        if Instant::now() >= self.next_check {
            self.next_check = Instant::now() + Duration::from_secs(3600);
            self.worker = Some(std::thread::spawn(check_once));
        }
    }

    /// Fold the supervisor's answer into the state.
    fn ingest_result(&mut self) {
        let Ok(bytes) = std::fs::read(result_path()) else {
            return;
        };
        let Ok(r) = serde_json::from_slice::<JobResult>(&bytes) else {
            let _ = std::fs::remove_file(result_path());
            return;
        };
        let mut s = read_state().unwrap_or_default();
        // An installer that failed to run says nothing about the release: retry it later.
        let bad = matches!(r.outcome.as_str(), "rolled_back" | "failed");
        if bad && !s.bad.contains(&r.to) {
            s.bad.push(r.to.clone());
        }
        s.last_result = Some(LastResult {
            at_ms: r.at_ms,
            from: r.from,
            to: r.to,
            outcome: r.outcome,
            detail: r.detail,
        });
        s.updating_to = None;
        write_state_exact(&s);
        let _ = std::fs::remove_file(result_path());
    }
}

impl Default for Updater {
    fn default() -> Self {
        Self::new()
    }
}

fn verified_for(job: &Job) -> bool {
    std::fs::read(verified_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| {
            v["version"] == job.to.as_str() && v["at_ms"].as_i64().unwrap_or(0) >= job.started_ms
        })
}

/// Test builds: this file makes the new version report unhealthy (the rollback test).
fn test_fail_health() -> bool {
    test_hooks() && updates_dir().join("test-fail-health").exists()
}

fn http_client() -> Result<reqwest::blocking::Client> {
    let allow_loopback = test_hooks();
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(30))
        .user_agent(crate::memory::sync::user_agent())
        .redirect(reqwest::redirect::Policy::custom(move |a| {
            let u = a.url();
            if a.previous().len() >= 5 {
                a.error("too many redirects")
            } else if u.scheme() == "https" || (allow_loopback && url_ok(u.as_str())) {
                a.follow()
            } else {
                a.error("a redirect left https")
            }
        }))
        .build()
        .context("http client")
}

/// https only; the test build also takes http on loopback.
fn url_ok(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    u.scheme() == "https"
        || (test_hooks()
            && u.scheme() == "http"
            && matches!(
                u.host_str(),
                Some("127.0.0.1") | Some("localhost") | Some("[::1]")
            ))
}

fn get_limited(c: &reqwest::blocking::Client, url: &str, max: u64) -> Result<Vec<u8>> {
    if !url_ok(url) {
        bail!("{url} is not an https URL");
    }
    let r = c.get(url).send().with_context(|| format!("GET {url}"))?;
    if !r.status().is_success() {
        bail!("GET {url}: HTTP {}", r.status());
    }
    let mut out = Vec::new();
    r.take(max + 1).read_to_end(&mut out)?;
    if out.len() as u64 > max {
        bail!("GET {url}: more than {max} bytes");
    }
    Ok(out)
}

/// Download `asset` to `dest`; keep it only if size and SHA-256 match the signed manifest.
fn download(c: &reqwest::blocking::Client, asset: &Asset, dest: &Path) -> Result<()> {
    if !url_ok(&asset.url) {
        bail!("the installer URL is not https");
    }
    if asset.size == 0 || asset.size > INSTALLER_MAX {
        bail!("the installer size {} is out of range", asset.size);
    }
    let part = dest.with_extension("part");
    let _ = std::fs::remove_file(&part);
    let result = (|| -> Result<()> {
        let mut r = c.get(&asset.url).send().context("download")?;
        if !r.status().is_success() {
            bail!("download: HTTP {}", r.status());
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&part)?;
        let (mut hash, mut total) = (Sha256::new(), 0u64);
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = r.read(&mut buf).context("download")?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > asset.size {
                bail!(
                    "the download is larger than the {} bytes the manifest says",
                    asset.size
                );
            }
            hash.update(&buf[..n]);
            f.write_all(&buf[..n])?;
        }
        f.sync_all()?;
        if total != asset.size {
            bail!(
                "the download is {total} bytes, the manifest says {}",
                asset.size
            );
        }
        let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !got.eq_ignore_ascii_case(asset.sha256.trim()) {
            bail!(
                "sha256 mismatch: got {got}, the manifest says {}",
                asset.sha256
            );
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(std::fs::rename(&part, dest)?),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Signed and Bad are only produced where the OS can check (macOS, Windows).
#[derive(Debug, PartialEq)]
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
enum PlatformSig {
    Signed,
    Unsigned,
    Bad(String),
}

/// What the OS says about the installer's own signature. Unsigned is allowed (installers
/// are unsigned until a certificate exists); a signature that is present but wrong is not.
fn platform_signature(path: &Path) -> PlatformSig {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/pkgutil")
            .arg("--check-signature")
            .arg(path)
            .output();
        match out {
            Ok(o) if o.status.success() => PlatformSig::Signed,
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout).to_ascii_lowercase()
                    + &String::from_utf8_lossy(&o.stderr).to_ascii_lowercase();
                if text.contains("no signature") || text.contains("not signed") {
                    PlatformSig::Unsigned
                } else {
                    PlatformSig::Bad(text.trim().chars().take(200).collect())
                }
            }
            Err(_) => PlatformSig::Unsigned,
        }
    }
    #[cfg(windows)]
    {
        let script = format!(
            "(Get-AuthenticodeSignature -LiteralPath '{}').Status",
            path.display().to_string().replace('\'', "''")
        );
        match std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        {
            Ok(o) => match String::from_utf8_lossy(&o.stdout).trim() {
                "Valid" => PlatformSig::Signed,
                "NotSigned" | "" => PlatformSig::Unsigned,
                other => PlatformSig::Bad(other.to_string()),
            },
            Err(_) => PlatformSig::Unsigned,
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        PlatformSig::Unsigned
    }
}

/// One check, in a worker thread. Returns whether to retry sooner than the normal cadence.
fn check_once() -> bool {
    let mut st = read_state().unwrap_or_default();
    let policy = read_policy();
    let current = installed_version();
    st.installed = current.as_ref().map(|v| v.to_string()).unwrap_or_default();
    st.enabled = policy.enabled;
    let build_channel = if current.as_ref().is_some_and(Version::is_dev) {
        Channel::Dev
    } else {
        Channel::Stable
    };
    let channel = policy.channel.unwrap_or(build_channel);
    st.channel = channel.name().into();
    st.last_check_ms = Some(now_ms());
    let outcome = run_check(&mut st, &policy, current.as_ref(), channel);
    let retry = outcome.is_err();
    let msg = match outcome {
        Ok(m) => m,
        Err(e) => format!("{e:#}"),
    };
    if st.last_check.as_deref() != Some(msg.as_str()) || retry {
        log_line(&format!("check: {msg}"));
    }
    st.last_check = Some(msg);
    write_state(&st);
    retry
}

fn run_check(
    st: &mut State,
    policy: &Policy,
    current: Option<&Version>,
    channel: Channel,
) -> Result<String> {
    if !policy.enabled {
        return Ok("updates are turned off by policy".into());
    }
    let Some(current) = current else {
        return Ok("no update: this build has no release version".into());
    };
    let Some(key) = PUBLIC_KEY.map(str::trim).filter(|k| !k.is_empty()) else {
        return Ok("no update: this build has no update public key".into());
    };
    let Some(os) = os_key() else {
        return Ok("no update: no installer exists for this CPU".into());
    };
    if let Some(job) = read_job() {
        if job_stale(&job) {
            log_line(&format!(
                "update to {} did not finish; clearing the job",
                job.to
            ));
            let _ = std::fs::remove_file(job_path());
            st.updating_to = None;
        } else {
            return Ok(format!("an update to {} is running", job.to));
        }
    }
    if let Ok(rd) = std::fs::read_dir(updates_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("supervisor-") || name == "kcap-updater" {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let url = TEST_MANIFEST_URL.unwrap_or(match channel {
        Channel::Stable => STABLE_URL,
        Channel::Dev => DEV_URL,
    });
    let client = http_client()?;
    let body = get_limited(&client, url, MANIFEST_MAX)?;
    let sig = String::from_utf8(get_limited(&client, &format!("{url}.sig"), 4096)?)
        .context("the signature file is not text")?;
    let m = verify_manifest(&body, &sig, key).context("manifest rejected")?;
    if m.channel == channel.name() {
        st.latest = Some(m.version.clone());
    }
    let (asset, version) = match decide(&m, current, channel, &st.bad, os) {
        Decision::UpToDate => {
            return Ok(format!("up to date ({current}; newest is {})", m.version))
        }
        Decision::Paused => return Ok(format!("no update: release {} is paused", m.version)),
        Decision::Refused(why) => bail!("no update: {why}"),
        Decision::Install(a, v) => (a, v),
    };
    ensure_dir(&updates_dir(), 0o755)?;
    let staging = updates_dir().join("staging");
    let kept = updates_dir().join("kept");
    ensure_dir(&staging, 0o700)?;
    ensure_dir(&kept, 0o700)?;
    for d in [&staging, &kept] {
        for e in std::fs::read_dir(d)?.flatten() {
            if e.path().extension().is_some_and(|x| x == "part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let ext = installer_ext();
    let dest = staging.join(format!("{version}.{ext}"));
    log_line(&format!("downloading {version} ({} bytes)", asset.size));
    download(&client, &asset, &dest).context("no update")?;
    match platform_signature(&dest) {
        PlatformSig::Signed => log_line("the installer is signed"),
        PlatformSig::Unsigned => log_line("warning: the installer carries no platform signature; allowed while releases are unsigned"),
        PlatformSig::Bad(why) => {
            let _ = std::fs::remove_file(&dest);
            bail!("no update: the installer's platform signature is wrong ({why})");
        }
    }
    // The installer of the version running now, for the rollback.
    let prev_path = kept.join(format!("{current}.{ext}"));
    let mut previous = prev_path.exists().then_some(prev_path.clone());
    if previous.is_none() {
        if let Some(p) = m
            .previous
            .as_ref()
            .filter(|p| Version::parse(&p.version).as_ref() == Some(current))
        {
            if let Some(a) = p.assets.get(os) {
                match download(&client, a, &prev_path) {
                    Ok(()) => previous = Some(prev_path),
                    Err(e) => log_line(&format!(
                        "warning: no installer for {current} to roll back to: {e:#}"
                    )),
                }
            }
        }
    }
    if previous.is_none() {
        log_line(&format!(
            "warning: no installer for {current} is kept; a failed {version} cannot be rolled back"
        ));
    }
    let job = Job {
        from: current.to_string(),
        to: version.clone(),
        installer: dest,
        previous,
        health_secs: health_window().as_secs(),
        started_ms: now_ms(),
        claimed_ms: None,
    };
    let _ = std::fs::remove_file(verified_path());
    write_atomic(&job_path(), &serde_json::to_vec_pretty(&job)?)?;
    st.updating_to = Some(version.clone());
    write_state(st);
    if let Err(e) = spawn_supervisor() {
        let _ = std::fs::remove_file(job_path());
        st.updating_to = None;
        write_state(st);
        return Err(e);
    }
    Ok(format!("installing {version}"))
}

// ─── The supervisor (survives the service it replaces) ──────────────────────

fn spawn_supervisor() -> Result<()> {
    let exe = std::env::current_exe()?;
    let job = job_path();
    let id = format!("{}", now_ms());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        // A copy under another name: the package's prerm runs `pkill -x kortix-capture`, which would
        // end the supervisor. And a transient unit: the installer restarts this service, and
        // systemd kills the control group of the service.
        let copy = updates_dir().join("kcap-updater");
        let _ = std::fs::remove_file(&copy);
        std::fs::copy(&exe, &copy).context("copy the supervisor")?;
        std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o700))?;
        let unit = format!("kortix-capture-update-{id}");
        let ok = std::process::Command::new("systemd-run")
            .args(["--unit", &unit, "--collect", "--quiet"])
            .arg(&copy)
            .args(["machine", "update-apply", "--job"])
            .arg(&job)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            bail!("systemd-run could not start the update supervisor");
        }
    }
    #[cfg(target_os = "macos")]
    {
        // A launchd job of its own: the installer boots this daemon out.
        let label = format!("ai.kortix.capture.update.{id}");
        let log = updates_dir().join("supervisor.out");
        let ok = std::process::Command::new("/bin/launchctl")
            .args(["submit", "-l", &label, "-o"])
            .arg(&log)
            .arg("-e")
            .arg(&log)
            .arg("--")
            .arg(&exe)
            .args(["machine", "update-apply", "--job"])
            .arg(&job)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            bail!("launchctl submit could not start the update supervisor");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A copy: the MSI replaces kortix-capture.exe while the supervisor still runs.
        let copy = updates_dir().join(format!("supervisor-{id}.exe"));
        std::fs::copy(&exe, &copy).context("copy the supervisor")?;
        const DETACHED_PROCESS: u32 = 0x8;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        std::process::Command::new(&copy)
            .args(["machine", "update-apply", "--job"])
            .arg(&job)
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("start the update supervisor")?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (exe, job, id);
        bail!("no supervisor on this OS");
    }
    Ok(())
}

fn run_with_timeout(mut cmd: std::process::Command, limit: Duration) -> Result<i32> {
    let mut child = cmd.spawn()?;
    let t0 = Instant::now();
    loop {
        if let Some(s) = child.try_wait()? {
            return Ok(s.code().unwrap_or(-1));
        }
        if t0.elapsed() > limit {
            let _ = child.kill();
            bail!("the installer did not finish in {} s", limit.as_secs());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Install `path` silently over what is installed (upgrade or downgrade).
fn run_installer(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("msiexec.exe");
        c.arg("/i")
            .arg(path)
            .args(["/qn", "/norestart", "/l*v"])
            .arg(updates_dir().join("msiexec.log"));
        // IT's URL and token stay: the MSI reads them back from the policy key (SAVED_URL, SAVED_TOKEN).
        let code = run_with_timeout(c, INSTALL_TIMEOUT)?;
        // 3010: done, reboot wanted. 1641: done, the installer restarted the computer.
        if !matches!(code, 0 | 3010 | 1641) {
            bail!("msiexec exited {code}");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("/usr/sbin/installer");
        c.arg("-pkg").arg(path).args(["-target", "/"]);
        let code = run_with_timeout(c, INSTALL_TIMEOUT)?;
        if code != 0 {
            bail!("installer exited {code}");
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let mut c = if which("apt-get") {
            let mut c = std::process::Command::new("apt-get");
            c.args([
                "install",
                "-y",
                "--allow-downgrades",
                "-o",
                "DPkg::Lock::Timeout=600",
                "-o",
                "APT::Sandbox::User=root",
            ])
            .arg(path);
            c
        } else {
            let mut c = std::process::Command::new("dpkg");
            c.arg("-i").arg(path);
            c
        };
        c.env("DEBIAN_FRONTEND", "noninteractive");
        let code = run_with_timeout(c, INSTALL_TIMEOUT)?;
        if code != 0 {
            bail!("the package install exited {code}");
        }
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn which(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}

fn machine_json() -> Option<Value> {
    serde_json::from_slice(&std::fs::read(super::state_path()).ok()?).ok()
}

/// A machine service other than process `not_pid` wrote `machine.json` after `since_ms`.
fn service_restarted(not_pid: Option<u64>, since_ms: i64) -> bool {
    machine_json().is_some_and(|v| {
        v["pid"].as_u64() != not_pid
            && v["updated_at"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .is_some_and(|t| t.timestamp_millis() > since_ms)
    })
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < limit {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    done()
}

fn finish(job: &Job, outcome: &str, detail: Option<String>) -> Result<()> {
    log_line(&format!(
        "{} -> {}: {outcome} {}",
        job.from,
        job.to,
        detail.as_deref().unwrap_or("")
    ));
    let r = JobResult {
        from: job.from.clone(),
        to: job.to.clone(),
        outcome: outcome.into(),
        detail,
        at_ms: now_ms(),
    };
    write_atomic(&result_path(), &serde_json::to_vec_pretty(&r)?)?;
    // Keep only the installer of the version that runs now: it is the next rollback target.
    let running = if outcome == "updated" {
        &job.to
    } else {
        &job.from
    };
    let ext = installer_ext();
    if outcome == "updated" {
        let keep = updates_dir().join("kept").join(format!("{running}.{ext}"));
        let _ = std::fs::rename(&job.installer, &keep);
    }
    let keep_name = format!("{running}.{ext}");
    for dir in ["kept", "staging"] {
        if let Ok(rd) = std::fs::read_dir(updates_dir().join(dir)) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy() != keep_name {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    let _ = std::fs::remove_file(job_path());
    Ok(())
}

/// `kortix-capture machine update-apply --job <file>`: install, prove, roll back. Runs as
/// root, detached from the machine service. Does nothing twice (the job is claimed).
pub fn apply(job_file: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        if unsafe { libc::geteuid() } != 0 {
            bail!("update-apply runs as root");
        }
    }
    if job_file != job_path() {
        bail!("{} is not the update job", job_file.display());
    }
    let mut job = read_job().ok_or_else(|| anyhow!("no update job"))?;
    if job.claimed_ms.is_some() {
        bail!("the update job is already running");
    }
    job.claimed_ms = Some(now_ms());
    write_atomic(&job_path(), &serde_json::to_vec_pretty(&job)?)?;
    log_line(&format!(
        "{} -> {}: installing {}",
        job.from,
        job.to,
        job.installer.display()
    ));
    let window = Duration::from_secs(job.health_secs);
    let installed = run_installer(&job.installer);
    let healthy = installed.is_ok() && wait_until(window, || verified_for(&job));
    if healthy {
        return finish(&job, "updated", None);
    }
    let (why, unhealthy) = match &installed {
        Err(e) => (format!("the installer failed: {e:#}"), false),
        Ok(()) => (
            format!(
                "{} did not report healthy in {} s",
                job.to,
                window.as_secs()
            ),
            true,
        ),
    };
    log_line(&format!("{} -> {}: {why}", job.from, job.to));
    // A release that ran and failed its health check is bad; an installer that could not run is not.
    let (rolled, failed) = if unhealthy {
        ("rolled_back", "failed")
    } else {
        ("install_failed", "install_failed")
    };
    let Some(prev) = job.previous.clone().filter(|p| p.exists()) else {
        return finish(
            &job,
            failed,
            Some(format!(
                "{why}; no installer of {} to roll back to",
                job.from
            )),
        );
    };
    let (pid_before, back_at) = (machine_json().and_then(|v| v["pid"].as_u64()), now_ms());
    log_line(&format!("rolling back to {}", job.from));
    match run_installer(&prev) {
        Err(e) => finish(
            &job,
            failed,
            Some(format!("{why}; the rollback failed: {e:#}")),
        ),
        Ok(()) if wait_until(window, || service_restarted(pid_before, back_at)) => {
            finish(&job, rolled, Some(why))
        }
        Ok(()) => finish(
            &job,
            failed,
            Some(format!(
                "{why}; {} was reinstalled but its service is silent",
                job.from
            )),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn semver_orders_releases_and_prereleases() {
        assert!(v("0.13.57") > v("0.13.56"));
        assert!(v("0.13.57") > v("0.13.57-dev.99"));
        assert!(v("0.13.57-dev.12") > v("0.13.57-dev.9"));
        assert!(v("0.14.0-dev.1") > v("0.13.57"));
        assert!(v("v1.0.0") == v("1.0.0+build5"));
        assert!(v("0.13.57-dev.1") < v("0.13.57-dev.1.1"));
        assert_eq!(v("v0.13.57-dev.12").to_string(), "0.13.57-dev.12");
        assert!(v("0.13.57-dev.1").is_dev() && !v("0.13.57").is_dev());
        for bad in [
            "",
            "1.2",
            "1.2.x",
            "a.b.c",
            "1.2.3-",
            "1.2.3-a..b",
            "1.2.3.4",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad}");
        }
    }

    fn manifest(version: &str, channel: &str, paused: bool) -> String {
        json!({
            "version": version, "channel": channel, "paused": paused,
            "assets": {"linux": {"name": "a.deb", "url": "https://x.test/a.deb", "sha256": "ab", "size": 3}},
        })
        .to_string()
    }

    fn keys() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = B64.encode(sk.verifying_key().to_bytes());
        (sk, pk)
    }

    #[test]
    fn a_manifest_needs_the_right_signature() {
        let (sk, pk) = keys();
        let body = manifest("0.13.58", "stable", false);
        let sig = B64.encode(sk.sign(body.as_bytes()).to_bytes());
        assert_eq!(
            verify_manifest(body.as_bytes(), &sig, &pk).unwrap().version,
            "0.13.58"
        );
        // One changed byte, another key, a signature for other bytes, junk: all refused.
        let tampered = body.replace("0.13.58", "0.13.59");
        assert!(verify_manifest(tampered.as_bytes(), &sig, &pk).is_err());
        let other = B64.encode(
            SigningKey::from_bytes(&[8u8; 32])
                .verifying_key()
                .to_bytes(),
        );
        assert!(verify_manifest(body.as_bytes(), &sig, &other).is_err());
        assert!(verify_manifest(body.as_bytes(), "AAAA", &pk).is_err());
        assert!(verify_manifest(body.as_bytes(), &sig, "not a key").is_err());
        // Key rotation: a build that trusts the old and the new key accepts either.
        assert!(verify_manifest(body.as_bytes(), &sig, &format!("{other},{pk}")).is_ok());
        assert!(verify_manifest(body.as_bytes(), &sig, &format!("{other}, junk")).is_err());
        assert!(verify_manifest(body.as_bytes(), "", &pk).is_err());
    }

    #[test]
    fn decide_never_downgrades_and_honors_pause_channel_and_bad() {
        let cur = v("0.13.57");
        let m =
            |ver, ch, paused| serde_json::from_str::<Manifest>(&manifest(ver, ch, paused)).unwrap();
        let go = |m: &Manifest, bad: &[String]| decide(m, &cur, Channel::Stable, bad, "linux");
        assert!(
            matches!(go(&m("0.13.58", "stable", false), &[]), Decision::Install(_, ref v) if v == "0.13.58")
        );
        assert_eq!(go(&m("0.13.57", "stable", false), &[]), Decision::UpToDate);
        assert_eq!(go(&m("0.13.56", "stable", false), &[]), Decision::UpToDate);
        assert_eq!(
            go(&m("0.13.57-dev.3", "stable", false), &[]),
            Decision::UpToDate
        );
        assert_eq!(go(&m("0.13.58", "stable", true), &[]), Decision::Paused);
        assert!(matches!(
            go(&m("0.13.58", "dev", false), &[]),
            Decision::Refused(_)
        ));
        assert!(matches!(
            go(&m("0.13.58", "stable", false), &["v0.13.58".into()]),
            Decision::Refused(_)
        ));
        assert!(matches!(
            go(&m("nope", "stable", false), &[]),
            Decision::Refused(_)
        ));
        assert!(matches!(
            decide(
                &m("0.13.58", "stable", false),
                &cur,
                Channel::Stable,
                &[],
                "windows"
            ),
            Decision::Refused(_)
        ));
        // A dev computer moves from one dev build to the next, and a stable release beats its dev builds.
        let dev = v("0.13.57-dev.4");
        let d = |ver| decide(&m(ver, "dev", false), &dev, Channel::Dev, &[], "linux");
        assert!(matches!(d("0.13.57-dev.5"), Decision::Install(..)));
        assert_eq!(d("0.13.57-dev.4"), Decision::UpToDate);
        assert!(matches!(
            decide(
                &m("0.13.57", "stable", false),
                &dev,
                Channel::Stable,
                &[],
                "linux"
            ),
            Decision::Install(..)
        ));
    }

    #[test]
    fn it_policy_defaults_on_and_reads_every_source() {
        assert_eq!(
            parse_policy(&[]),
            Policy {
                enabled: true,
                channel: None
            }
        );
        let off = json!({"auto_update": false, "update_channel": "Stable"});
        assert_eq!(
            parse_policy(&[off]),
            Policy {
                enabled: false,
                channel: Some(Channel::Stable)
            }
        );
        // The registry and the profile write strings and CamelCase keys.
        for s in ["0", "false", "OFF", "no", "disabled"] {
            assert!(!parse_policy(&[json!({"AutoUpdate": s})]).enabled, "{s}");
        }
        assert!(parse_policy(&[json!({"AutoUpdate": "1", "UpdateChannel": "dev"})]).enabled);
        assert_eq!(
            parse_policy(&[json!({"UpdateChannel": "dev"})]).channel,
            Some(Channel::Dev)
        );
        assert_eq!(
            parse_policy(&[json!({"UpdateChannel": "beta"})]).channel,
            None
        );
        // The first source that sets a key wins.
        let strong = json!({"auto_update": false});
        let weak = json!({"auto_update": true, "update_channel": "dev"});
        let p = parse_policy(&[strong, weak]);
        assert!(!p.enabled && p.channel == Some(Channel::Dev));
    }

    #[test]
    fn health_needs_a_running_recorder_and_a_new_frame_while_recording() {
        let s = |running, state: &str, frame| json!({"recorder_running": running, "state": state, "counts": {"last_frame_ms": frame}});
        assert!(!person_ok(&s(false, "recording", 2000), 1000));
        assert!(person_ok(&s(true, "recording", 2000), 1000));
        assert!(!person_ok(&s(true, "recording", 900), 1000));
        assert!(person_ok(&s(true, "paused", 0), 1000));
        assert!(person_ok(&s(true, "permission_missing", 0), 1000));
        assert!(!person_ok(&Value::Null, 1000));
    }

    #[test]
    fn report_says_behind_failed_current_updating_and_disabled() {
        let mut s = State {
            installed: "0.13.57".into(),
            latest: Some("0.13.58".into()),
            enabled: true,
            ..Default::default()
        };
        assert_eq!(summarize(&s)["status"], "behind");
        s.last_result = Some(LastResult {
            to: "0.13.58".into(),
            outcome: "rolled_back".into(),
            ..Default::default()
        });
        assert_eq!(summarize(&s)["status"], "failed");
        // A newer release clears the failure of the older one.
        s.latest = Some("0.13.59".into());
        assert_eq!(summarize(&s)["status"], "behind");
        s.updating_to = Some("0.13.59".into());
        assert_eq!(summarize(&s)["status"], "updating");
        s.enabled = false;
        assert_eq!(summarize(&s)["status"], "disabled");
        s = State {
            installed: "0.13.58".into(),
            latest: Some("0.13.58".into()),
            enabled: true,
            ..Default::default()
        };
        assert_eq!(summarize(&s)["status"], "current");
    }
}
