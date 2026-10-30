//! `sync.provider = "kortix"`: S3 credentials from a credential issuer.
//!
//! Kortix is one issuer; any server that speaks this protocol is another
//! (`.agents/skills/kortix-capture/references/capture-format.md`, "Credentials"). Every request body and response
//! is JSON.
//!
//! 1. Sign in, an OAuth 2.0 device authorization grant (RFC 8628):
//!    `POST <issuer>/v1/capture/device/authorize` returns a user code and a
//!    verification URL; the person approves in a browser while the device polls
//!    `POST <issuer>/v1/capture/device/token` (`authorization_pending`,
//!    `slow_down`, `access_denied`, `expired_token`) until it returns the device
//!    token, the prefix and the device id. The token goes to the OS secret store
//!    (`crate::secret_store`, service `ai.kortix.capture.device`); the rest to
//!    `<library>/sync-issuer.json`.
//! 2. Credentials: `POST <issuer>/v1/capture/credentials` with
//!    `Authorization: Bearer <device_token>` returns S3 credentials scoped to
//!    the device's prefix and their expiry. They live in this process only and
//!    are fetched again 5 minutes before they expire.
//! 3. A 401 or 403 from the issuer means the token is revoked: the registration
//!    is marked rejected, sync stops without further requests, and the tray and
//!    settings window ask the person to sign in again.
//!
//! Enrollment ([`enroll`]) replaces step 1 on computers IT rolls out: `POST
//! <issuer>/v1/capture/device/enroll` with the organization's enrollment token,
//! the machine key and the signed-in Windows user. The issuer answers with the
//! same device token as a sign-in, or "pending" until an admin assigns the
//! person. [`adopt`] stores the result exactly like a sign-in. On Windows the
//! machine service (SYSTEM) enrolls and hands the result to the person's own
//! process (`sync adopt`), so the person never sees the enrollment token.

use super::{config_error, ErrorClass, TargetError};
use crate::memory::{paths::MemoryPaths, store::now_ms};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{atomic::AtomicBool, atomic::Ordering, Mutex},
    time::{Duration, Instant},
};

pub const TOKEN_SERVICE: &str = "ai.kortix.capture.device";
pub const AUTHORIZE_PATH: &str = "/v1/capture/device/authorize";
pub const TOKEN_PATH: &str = "/v1/capture/device/token";
pub const CREDENTIALS_PATH: &str = "/v1/capture/credentials";
pub const ENROLL_PATH: &str = "/v1/capture/device/enroll";
pub const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
pub const CLIENT_ID: &str = "kortix-capture";
/// Credentials are fetched again this long before they expire.
pub const REFRESH_BEFORE_MS: i64 = 5 * 60_000;
/// The issuer a release build signs in to when settings name none. Unset in
/// development builds: the person enters the issuer URL in Settings.
pub const DEFAULT_ISSUER: Option<&str> = option_env!("KORTIX_DEFAULT_ISSUER_URL");

/// `<library>/sync-issuer.json`: who this device is at its issuer. No secrets.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Registration {
    pub issuer: String,
    pub prefix: String,
    pub device_id: String,
    pub member_email: Option<String>,
    pub signed_in_at_ms: i64,
    /// The issuer refused the device token (401/403) at this time. Sync stops
    /// until the next sign-in.
    pub rejected_at_ms: Option<i64>,
    /// The organization's name, from an enrollment (the tray names it).
    pub account_name: Option<String>,
    /// Enrolled by the organization (machine service), not signed in by the person.
    pub managed: bool,
}

fn registration_path(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("sync-issuer.json")
}

fn token_file(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("sync-device-token")
}

/// The device token this library holds for `issuer`, when the sign-in is still valid.
pub fn held_device_token(paths: &MemoryPaths, issuer: &str) -> Option<String> {
    let r = registration(paths).filter(|r| r.rejected_at_ms.is_none())?;
    (r.issuer.trim_end_matches('/') == issuer.trim().trim_end_matches('/'))
        .then(|| token(paths, &r))
        .flatten()
}

pub fn registration(paths: &MemoryPaths) -> Option<Registration> {
    serde_json::from_slice(&std::fs::read(registration_path(paths)).ok()?).ok()
}

fn save_registration(paths: &MemoryPaths, r: &Registration) -> Result<()> {
    paths.ensure()?;
    super::write_private(&registration_path(paths), &serde_json::to_vec_pretty(r)?)
}

fn token(paths: &MemoryPaths, r: &Registration) -> Option<String> {
    crate::secret_store::get(TOKEN_SERVICE, &r.device_id, &token_file(paths))
}

/// The issuer URL: `sync.kortix.url`, else the build's default.
pub fn issuer_url(configured: &str) -> Option<String> {
    let url = configured.trim();
    let url = if url.is_empty() {
        DEFAULT_ISSUER.unwrap_or("").trim()
    } else {
        url
    };
    (!url.is_empty() && issuer_allowed(url)).then(|| url.trim_end_matches('/').to_string())
}

/// True for a loopback host: the only place plain http is allowed.
fn is_loopback(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1"
}

/// An issuer speaks https. Plain http is for a loopback issuer in development and tests:
/// the device token, the enrollment token and the credentials cross this connection.
pub fn issuer_allowed(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url.trim()) else {
        return false;
    };
    match u.scheme() {
        "https" => u.host_str().is_some(),
        "http" => u.host_str().is_some_and(is_loopback),
        _ => false,
    }
}

/// A page the browser may open for the sign-in. With a loopback issuer (development): a
/// loopback page on any port. Otherwise https on the issuer's host or on its parent domain,
/// where the web app usually sits (`api.kortix.com` -> `kortix.com`, `app.kortix.com`).
pub fn approval_url_ok(url: &str, issuer: &str) -> bool {
    let (Ok(u), Ok(i)) = (url::Url::parse(url.trim()), url::Url::parse(issuer.trim())) else {
        return false;
    };
    let (Some(page), Some(api)) = (u.host_str(), i.host_str()) else {
        return false;
    };
    if !issuer_allowed(issuer) {
        return false;
    }
    if is_loopback(api) {
        return is_loopback(page) && matches!(u.scheme(), "http" | "https");
    }
    if u.scheme() != "https" {
        return false;
    }
    // The parent domain only when it still has two labels: never widen to a TLD.
    let site = match api.split_once('.') {
        Some((_, parent)) if parent.contains('.') => parent,
        _ => api,
    };
    page == api || page == site || page.ends_with(&format!(".{site}"))
}

/// Forget the registration and the token; drop cached credentials.
pub fn sign_out(paths: &MemoryPaths) {
    if let Some(r) = registration(paths) {
        crate::secret_store::delete(TOKEN_SERVICE, &r.device_id, &token_file(paths));
    }
    let _ = std::fs::remove_file(registration_path(paths));
    forget_credentials();
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent(super::user_agent())
        .build()
        .expect("issuer HTTP client")
}

/// An issuer error with an ErrorClass: 401/403 auth, other 4xx config, 5xx/429 transient.
/// The issuer's refusal of this device token (`POST /v1/capture/credentials`, 401). Only this
/// answer signs a device out: a 401/403 without it comes from something in between (a proxy,
/// a firewall, a load balancer) or names a state that passes, and sync retries.
pub const DEVICE_REFUSED: &str = "capture_device_unauthorized";

fn issuer_error(status: u16, body: &str, op: &str) -> anyhow::Error {
    let code = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["code"].as_str().map(str::to_string));
    let class = match (status, code.as_deref()) {
        (401, Some(DEVICE_REFUSED)) => ErrorClass::Auth,
        (401 | 403 | 408 | 429 | 500..=599, _) => ErrorClass::Transient,
        _ => ErrorClass::Config,
    };
    let msg: String = body.chars().take(300).collect();
    TargetError::new(class, status, code.unwrap_or_else(|| "Issuer".into()), msg, op)
}

/// POST JSON. A non-2xx answer is an error, except an OAuth error body
/// (`{"error": ...}`) when `oauth` is set: then the caller reads it.
fn post(
    url: &str,
    bearer: Option<&str>,
    body: &Value,
    op: &str,
    oauth: bool,
) -> Result<(u16, Value)> {
    let mut req = http().post(url).json(body);
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .map_err(|e| anyhow::Error::from(e.without_url()).context(format!("{op}: {url}")))?;
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !(200..300).contains(&status) && !(oauth && value.get("error").is_some()) {
        return Err(issuer_error(status, &text, op));
    }
    Ok((status, value))
}

/// What the device tells the issuer about itself when it asks to sign in.
pub fn device_info(paths: &MemoryPaths) -> Value {
    let d = super::identity(paths);
    json!({
        "device_id": super::device_id_for(paths, ""),
        "machine_key_sha256": d.machine_key_sha256,
        "hostname": d.hostname,
        "computer_name": d.computer_name,
        "os": d.os,
        "os_version": d.os_version,
        "arch": d.arch,
        "app_version": d.app_version,
    })
}

/// Open the approval page in the default browser. Only on an explicit sign-in.
pub fn open_browser(url: &str) -> Result<()> {
    let u = url::Url::parse(url.trim()).context("the sign-in page address is not valid")?;
    if !(u.scheme() == "https" || (u.scheme() == "http" && u.host_str().is_some_and(is_loopback))) {
        bail!("the sign-in page must open over https");
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(url).spawn()?;
    // `cmd /C start` treats `&` in the query as a separator; the shell URL handler does not.
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(url).spawn()?;
    Ok(())
}

/// RFC 8628 §3.2 device authorization response.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    #[serde(default)]
    pub verification_uri: Option<String>,
    pub verification_uri_complete: String,
    /// Seconds between polls; default 5.
    #[serde(default = "five")]
    pub interval: u64,
    pub expires_in: u64,
}

fn five() -> u64 {
    5
}

/// Successful token response.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceToken {
    pub device_token: String,
    pub prefix: String,
    pub device_id: String,
    #[serde(default)]
    pub member: Option<Member>,
    #[serde(default)]
    pub account: Option<Account>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Account {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Member {
    #[serde(default)]
    pub email: Option<String>,
}

pub fn authorize(paths: &MemoryPaths, issuer: &str) -> Result<DeviceAuthorization> {
    let (status, v) = post(
        &format!("{issuer}{AUTHORIZE_PATH}"),
        None,
        &json!({"client_id": CLIENT_ID, "device": device_info(paths)}),
        "device authorize",
        true,
    )?;
    if !(200..300).contains(&status) {
        bail!(
            "device authorize: {}",
            v["error"].as_str().unwrap_or("refused")
        );
    }
    let mut auth: DeviceAuthorization =
        serde_json::from_value(v).context("device authorize: unexpected response")?;
    // A page given as a path belongs to the issuer itself.
    if auth.verification_uri_complete.starts_with('/') {
        auth.verification_uri_complete = format!("{issuer}{}", auth.verification_uri_complete);
    }
    // The page the person is sent to must be on the address they chose to trust.
    if !approval_url_ok(&auth.verification_uri_complete, issuer) {
        bail!("device authorize: the sign-in page is not on the Kortix address");
    }
    Ok(auth)
}

/// One poll of the token endpoint.
pub enum Poll {
    Pending,
    SlowDown,
    Approved(DeviceToken),
}

pub fn poll(issuer: &str, device_code: &str) -> Result<Poll> {
    let (status, v) = post(
        &format!("{issuer}{TOKEN_PATH}"),
        None,
        &json!({"grant_type": DEVICE_CODE_GRANT, "device_code": device_code, "client_id": CLIENT_ID}),
        "device token",
        true,
    )?;
    if (200..300).contains(&status) {
        return Ok(Poll::Approved(
            serde_json::from_value(v).context("device token: unexpected response")?,
        ));
    }
    // Refusals are config errors: the sign-in stops instead of polling on.
    match v["error"].as_str().unwrap_or_default() {
        "authorization_pending" => Ok(Poll::Pending),
        "slow_down" => Ok(Poll::SlowDown),
        "access_denied" => Err(config_error("the sign-in was denied")),
        "expired_token" => Err(config_error("the sign-in code expired; start again")),
        other => Err(config_error(format!("device token: {other}"))),
    }
}

/// The whole sign-in: authorize, hand the code and URL to `show` (print it,
/// open the browser), poll until approved, then store the token and the
/// registration. Returns the registration. `stop` cancels it.
pub fn sign_in(
    paths: &MemoryPaths,
    issuer: &str,
    show: &mut dyn FnMut(&DeviceAuthorization),
    stop: &AtomicBool,
) -> Result<Registration> {
    let issuer = issuer.trim_end_matches('/');
    let auth = authorize(paths, issuer)?;
    show(&auth);
    let deadline = Instant::now() + Duration::from_secs(auth.expires_in.max(1));
    let mut interval = Duration::from_secs(auth.interval.max(1));
    loop {
        let until = Instant::now() + interval;
        while Instant::now() < until {
            if stop.load(Ordering::SeqCst) {
                bail!("sign-in cancelled");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if Instant::now() >= deadline {
            bail!("the sign-in code expired; start again");
        }
        match poll(issuer, &auth.device_code) {
            Ok(Poll::Pending) => {}
            // RFC 8628 §3.5: every slow_down adds 5 seconds.
            Ok(Poll::SlowDown) => interval += Duration::from_secs(5),
            Ok(Poll::Approved(t)) => return complete_sign_in(paths, issuer, t),
            Err(e) if super::classify(&e) == ErrorClass::Transient => {
                tracing::warn!("sign-in poll failed (retrying): {e:#}")
            }
            Err(e) => return Err(e),
        }
    }
}

fn complete_sign_in(paths: &MemoryPaths, issuer: &str, t: DeviceToken) -> Result<Registration> {
    store_token(
        paths,
        Registration {
            issuer: issuer.to_string(),
            prefix: t.prefix,
            device_id: t.device_id,
            member_email: t.member.and_then(|m| m.email),
            account_name: t.account.and_then(|a| a.name).filter(|n| !n.trim().is_empty()),
            ..Default::default()
        },
        &t.device_token,
    )
}

/// Replace this library's sign-in with `r` and its token.
fn store_token(paths: &MemoryPaths, mut r: Registration, token: &str) -> Result<Registration> {
    if r.device_id.is_empty() || r.device_id.contains('/') || r.device_id.contains('\\') {
        bail!(
            "the issuer returned an unusable device id {:?}",
            r.device_id
        );
    }
    if token.trim().is_empty() {
        bail!("the issuer returned no device token");
    }
    sign_out(paths);
    r.issuer = r.issuer.trim_end_matches('/').to_string();
    r.prefix = r.prefix.trim_matches('/').to_string();
    r.member_email = r.member_email.filter(|e| !e.is_empty());
    r.account_name = r.account_name.filter(|n| !n.trim().is_empty());
    r.signed_in_at_ms = now_ms();
    r.rejected_at_ms = None;
    crate::secret_store::put(
        TOKEN_SERVICE,
        &r.device_id,
        "Kortix Capture device token",
        token.trim(),
        &token_file(paths),
    )?;
    save_registration(paths, &r)?;
    Ok(r)
}

// ─── Enrollment ──────────────────────────────────────────────────────────────

/// The signed-in Windows user the enrollment is for.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct EnrollUser {
    /// The user principal name (`jane@corp.example`); None for local accounts.
    pub principal_name: Option<String>,
    /// The login name (`CORP\\jane`).
    pub account_name: String,
}

/// A successful enrollment: what the person's library stores (`sync adopt` reads it as JSON).
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Adoption {
    pub issuer: String,
    pub device_token: String,
    pub prefix: String,
    pub device_id: String,
    #[serde(default)]
    pub member_email: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
}

impl std::fmt::Debug for Adoption {
    // Never print the device token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Adoption")
            .field("issuer", &self.issuer)
            .field("device_token", &"<redacted>")
            .field("prefix", &self.prefix)
            .field("device_id", &self.device_id)
            .field("member_email", &self.member_email)
            .field("account_name", &self.account_name)
            .finish()
    }
}

/// What the issuer answered an enrollment.
#[derive(Debug, Clone, PartialEq)]
pub enum Enrollment {
    Enrolled(Adoption),
    /// Waiting for an admin (`approval_required`); nothing records meanwhile.
    Pending {
        reason: String,
        enrollment_id: Option<String>,
        retry_after: Duration,
    },
    /// Refused (`enrollment_token_invalid`, `enrollment_denied`, `capture_disabled`,
    /// `enrollment_domain_not_allowed`, `enrollment_limit_reached`, `invalid_request`).
    Refused {
        code: String,
        retry_after: Duration,
    },
}

impl Enrollment {
    /// How long to wait before the next attempt; zero once enrolled.
    pub fn retry_after(&self) -> Duration {
        match self {
            Enrollment::Enrolled(_) => Duration::ZERO,
            Enrollment::Pending { retry_after, .. } | Enrollment::Refused { retry_after, .. } => {
                *retry_after
            }
        }
    }
}

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3_600);

/// The retry cadence for a refusal code (the contract's table): fixable by IT
/// within the hour, or an admin decision that rarely changes.
pub fn refusal_retry(code: &str) -> Duration {
    match code {
        "enrollment_denied" | "enrollment_domain_not_allowed" => 6 * HOUR,
        _ => HOUR,
    }
}

/// `POST <issuer>/v1/capture/device/enroll`. `Err` only for a transport or
/// server failure (retry in a minute); every answer of the contract is `Ok`.
pub fn enroll(
    issuer: &str,
    enrollment_token: &str,
    user: &EnrollUser,
    device: &super::Identity,
    device_token: Option<&str>,
) -> Result<Enrollment> {
    let issuer = issuer.trim().trim_end_matches('/');
    let body = json!({
        "enrollment_token": enrollment_token.trim(),
        "machine_key_sha256": device.machine_key_sha256,
        "user": user,
        "device": {
            "hostname": device.hostname,
            "computer_name": device.computer_name,
            "os": device.os,
            "os_version": device.os_version,
            "arch": device.arch,
            "app_version": device.app_version,
        },
    });
    let url = format!("{issuer}{ENROLL_PATH}");
    // A computer that already holds a device token proves it: the issuer re-mints a
    // token for an existing device only for the token's holder.
    let mut req = http().post(&url).json(&body);
    if let Some(t) = device_token.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .map_err(|e| anyhow::Error::from(e.without_url()).context(format!("enroll: {url}")))?;
    let status = resp.status().as_u16();
    let v: Value = serde_json::from_str(&resp.text().unwrap_or_default()).unwrap_or(Value::Null);
    enrollment_answer(issuer, status, &v)
}

/// The contract's answer table, separate from the transport so it is tested alone.
pub fn enrollment_answer(issuer: &str, status: u16, v: &Value) -> Result<Enrollment> {
    let code = v["code"]
        .as_str()
        .or_else(|| v["error"].as_str())
        .unwrap_or("")
        .to_string();
    match status {
        200 if v["status"] == "enrolled" => {
            let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
            Ok(Enrollment::Enrolled(Adoption {
                issuer: issuer.to_string(),
                device_token: s("device_token"),
                prefix: s("prefix"),
                device_id: s("device_id"),
                member_email: v["member"]["email"].as_str().map(str::to_string),
                account_name: v["account"]["name"].as_str().map(str::to_string),
            }))
        }
        202 => Ok(Enrollment::Pending {
            reason: v["reason"].as_str().unwrap_or("pending").to_string(),
            enrollment_id: v["enrollment_id"].as_str().map(str::to_string),
            retry_after: Duration::from_secs(
                v["retry_after_s"].as_u64().unwrap_or(60).clamp(10, 3_600),
            ),
        }),
        400 | 401 | 403 => {
            let code = if code.is_empty() {
                format!("http_{status}")
            } else {
                code
            };
            let retry_after = refusal_retry(&code);
            Ok(Enrollment::Refused { code, retry_after })
        }
        429 | 500..=599 => Err(issuer_error(status, &v.to_string(), "enroll")),
        _ => Err(config_error(format!(
            "enroll: unexpected answer {status} {}",
            v.to_string().chars().take(200).collect::<String>()
        ))),
    }
}

/// The wait after a failed attempt (transport, 429, 5xx): one minute.
pub const TRANSIENT_RETRY: Duration = MINUTE;

/// Store an enrollment in this library like a sign-in, set Kortix sync to the
/// issuer and turn it on. The library is then "managed": the organization
/// enrolled it, and the machine service keeps it recording.
pub fn adopt(paths: &MemoryPaths, a: &Adoption) -> Result<Registration> {
    let issuer = a.issuer.trim().trim_end_matches('/');
    if !issuer_allowed(issuer) {
        bail!("adopt: the issuer must be an https URL (http only for a loopback address)");
    }
    let prev = super::view::active_destination(paths);
    let r = store_token(
        paths,
        Registration {
            issuer: issuer.to_string(),
            prefix: a.prefix.clone(),
            device_id: a.device_id.clone(),
            member_email: a.member_email.clone(),
            account_name: a.account_name.clone(),
            managed: true,
            ..Default::default()
        },
        &a.device_token,
    )?;
    let mut s = crate::memory::settings::Settings::load(paths);
    super::view::apply_switch(paths, prev.as_deref(), &super::view::kortix_key(&r.issuer, &r.prefix))?;
    s.sync.provider = "kortix".into();
    s.sync.kortix.url = issuer.to_string();
    s.sync.encrypt = false;
    s.sync.enabled = true;
    s.airgap = false;
    s.validate()?;
    s.save(paths)?;
    forget_credentials();
    crate::memory::managed::write_enrollment_state(
        paths,
        &crate::memory::managed::EnrollmentState::from_answer("enrolled", None, None),
    )?;
    Ok(r)
}

/// S3 credentials from the issuer.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct IssuedCredentials {
    pub endpoint: String,
    pub bucket: String,
    #[serde(default = "us_east_1")]
    pub region: String,
    pub prefix: String,
    pub device_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
    pub expires_at_ms: i64,
    /// Path-style URLs (most self-hosted S3); default false.
    #[serde(default)]
    pub path_style: bool,
}

fn us_east_1() -> String {
    "us-east-1".into()
}

/// The credentials of this process, by issuer and device.
static CACHE: Mutex<Option<(String, IssuedCredentials)>> = Mutex::new(None);
/// When this process last asked the issuer about a refused registration (epoch ms).
static RECHECKED_AT: Mutex<i64> = Mutex::new(0);
/// A refused device asks again this often: an admin who restores it, or a person added back
/// to the account, reconnects it without a new sign-in.
const RECHECK_REFUSED_MS: i64 = 15 * 60_000;

/// Tests: ask about a refused registration on the next call.
#[doc(hidden)]
pub fn recheck_refused_now() {
    *RECHECKED_AT.lock().unwrap() = 0;
}

/// Drop cached credentials (after the store refused them, or on sign-out).
pub fn forget_credentials() {
    *CACHE.lock().unwrap() = None;
}

/// Valid credentials for this device: cached, or fetched when there are none
/// or they expire within 5 minutes. A 401/403 marks the registration rejected.
pub fn credentials(paths: &MemoryPaths) -> Result<IssuedCredentials> {
    let r = registration(paths).ok_or_else(|| {
        config_error("not signed in: choose \"Sign in with Kortix\" in the tray or Settings")
    })?;
    if r.rejected_at_ms.is_some() {
        // Refused: ask again every 15 min (and once per process start, after an update or a
        // reboot) with the token this computer still holds, instead of giving up for good.
        let mut at = RECHECKED_AT.lock().unwrap();
        if now_ms() - *at < RECHECK_REFUSED_MS {
            return Err(TargetError::new(
                ErrorClass::Auth,
                401,
                "SignInRequired",
                "the issuer refused this device; sign in again",
                "credentials",
            ));
        }
        *at = now_ms();
    }
    let who = format!("{}|{}", r.issuer, r.device_id);
    if let Some((k, c)) = CACHE.lock().unwrap().as_ref() {
        if *k == who && now_ms() < c.expires_at_ms - REFRESH_BEFORE_MS {
            return Ok(c.clone());
        }
    }
    let token = token(paths, &r).ok_or_else(|| {
        config_error("the device token is missing from this computer's secret store; sign in again")
    })?;
    let res = post(
        &format!("{}{CREDENTIALS_PATH}", r.issuer),
        Some(&token),
        &json!({"device_id": r.device_id, "app_version": env!("CARGO_PKG_VERSION")}),
        "credentials",
        false,
    );
    let (status, v) = match res {
        Ok(x) => x,
        Err(e) => {
            // The organization switched Capture off: a computer it manages stops recording
            // (refused here); the machine service enrolls it again once Capture is back on.
            // A personal one keeps its sign-in and retries.
            let org_off = r.managed && format!("{e:#}").contains("capture_disabled");
            if super::classify(&e) == ErrorClass::Auth || org_off {
                if r.rejected_at_ms.is_none() {
                    let mut rejected = r.clone();
                    rejected.rejected_at_ms = Some(now_ms());
                    save_registration(paths, &rejected)?;
                    *RECHECKED_AT.lock().unwrap() = now_ms();
                    tracing::warn!("sync: the issuer refused this device; it asks again every 15 min");
                }
                forget_credentials();
                return Err(e.context("the issuer refused this device; sign in again"));
            }
            return Err(e);
        }
    };
    debug_assert!((200..300).contains(&status));
    let c: IssuedCredentials = serde_json::from_value(v)
        .map_err(|e| config_error(format!("credentials: unexpected response: {e}")))?;
    if c.device_id != r.device_id {
        return Err(config_error(format!(
            "credentials name device {:?}, this device signed in as {:?}",
            c.device_id, r.device_id
        )));
    }
    if r.rejected_at_ms.is_some() {
        let mut back = r.clone();
        back.rejected_at_ms = None;
        save_registration(paths, &back)?;
        tracing::info!("sync: the issuer accepts this device again; sync resumes");
    }
    *CACHE.lock().unwrap() = Some((who, c.clone()));
    Ok(c)
}

/// The registration's state for the tray and the settings window.
pub fn status(paths: &MemoryPaths, configured_url: &str) -> Value {
    let r = registration(paths);
    json!({
        "issuer_url": issuer_url(configured_url),
        "default_issuer_url": DEFAULT_ISSUER,
        "signed_in": r.as_ref().is_some_and(|r| r.rejected_at_ms.is_none()),
        "sign_in_required": r.as_ref().is_some_and(|r| r.rejected_at_ms.is_some()),
        "issuer": r.as_ref().map(|r| r.issuer.clone()),
        "device_id": r.as_ref().map(|r| r.device_id.clone()),
        "prefix": r.as_ref().map(|r| r.prefix.clone()),
        "member_email": r.as_ref().and_then(|r| r.member_email.clone()),
        "account_name": r.as_ref().and_then(|r| r.account_name.clone()),
        "managed": r.as_ref().is_some_and(|r| r.managed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cloudflare in front of Kortix answers 403 to a request without a User-Agent.
    #[test]
    fn every_issuer_request_names_the_app_in_its_user_agent() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = c.read(&mut buf).unwrap();
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        let _ = http().post(format!("http://{addr}/v1/capture/device/authorize")).body("{}").send();
        let request = seen.join().unwrap();
        assert!(
            request.contains("user-agent: kortix-capture/"),
            "{request}"
        );
    }

    #[test]
    fn issuer_url_prefers_settings_and_trims() {
        assert_eq!(
            issuer_url(" https://issuer.example/ ").as_deref(),
            Some("https://issuer.example")
        );
        if DEFAULT_ISSUER.is_none() {
            assert_eq!(issuer_url(""), None);
        }
    }

    #[test]
    fn an_issuer_is_https_or_loopback() {
        assert!(issuer_allowed("https://api.kortix.example"));
        assert!(issuer_allowed("http://127.0.0.1:8787"));
        assert!(issuer_allowed("http://localhost:8008"));
        assert!(issuer_allowed("http://[::1]:8008"));
        assert!(!issuer_allowed("http://api.kortix.example"));
        assert!(!issuer_allowed("http://127.0.0.1.evil.example"));
        assert!(!issuer_allowed("ftp://api.kortix.example"));
        assert!(!issuer_allowed("file:///etc/passwd"));
        assert!(!issuer_allowed("api.kortix.example"));
        assert_eq!(issuer_url("http://api.kortix.example"), None);
        assert_eq!(
            issuer_url("https://api.kortix.example/").as_deref(),
            Some("https://api.kortix.example")
        );
    }

    #[test]
    fn the_approval_page_is_on_the_issuers_site() {
        let i = "https://api.kortix.example";
        assert!(approval_url_ok("https://api.kortix.example/device?code=A", i));
        assert!(!approval_url_ok("https://evil.example/device", i));
        assert!(!approval_url_ok("https://api.kortix.example.evil.example/", i));
        assert!(!approval_url_ok("http://api.kortix.example/device", i), "scheme must match");
        assert!(approval_url_ok("https://api.kortix.example:8443/", i), "same host, another port");
        assert!(!approval_url_ok("javascript:alert(1)", i));
        assert!(!approval_url_ok("file:///etc/passwd", i));
        assert!(approval_url_ok("http://127.0.0.1:8787/approve", "http://127.0.0.1:8787"));
        assert!(!approval_url_ok("http://127.0.0.1:8787/approve", "http://example.com"));
        // The web app may sit on the API's parent domain (api.kortix.com -> kortix.com), always https.
        assert!(approval_url_ok("https://kortix.example/capture/authorize?user_code=A", i));
        assert!(approval_url_ok("https://app.kortix.example/capture/authorize", i));
        assert!(!approval_url_ok("http://kortix.example/capture/authorize", i), "https only");
        assert!(!approval_url_ok("https://notkortix.example/", i));
        assert!(!approval_url_ok("https://example/", "https://kortix.example"), "never widen to a TLD");
        // Local development: the API and the web app on this computer, on different ports.
        assert!(approval_url_ok(
            "http://localhost:37200/capture/authorize?user_code=A",
            "http://localhost:37208"
        ));
        assert!(!approval_url_ok("http://evil.example/approve", "http://localhost:37208"));
        assert!(open_browser("file:///etc/passwd").is_err());
        assert!(open_browser("http://evil.example/").is_err());
    }

    #[test]
    fn the_adoption_never_prints_its_token() {
        let a = Adoption {
            issuer: "https://api.kortix.example".into(),
            device_token: "kortix_cap_synthetic_secret".into(),
            prefix: "p".into(),
            device_id: "d".into(),
            member_email: None,
            account_name: None,
        };
        assert!(!format!("{a:?}").contains("synthetic_secret"));
        assert!(!format!("{:?}", Enrollment::Enrolled(a)).contains("synthetic_secret"));
    }

    #[test]
    fn issuer_errors_have_classes() {
        let c = |s| super::super::classify(&issuer_error(s, "", "x"));
        // Only the issuer's own refusal signs a device out.
        let refused = r#"{"error":"Invalid or revoked device token; sign in again","code":"capture_device_unauthorized"}"#;
        assert_eq!(super::super::classify(&issuer_error(401, refused, "x")), ErrorClass::Auth);
        // A proxy's or firewall's 401/403, or the organization switching Capture off, passes.
        assert_eq!(c(401), ErrorClass::Transient);
        assert_eq!(c(403), ErrorClass::Transient);
        let disabled = r#"{"error":"Kortix Capture is off for this organization","code":"capture_disabled"}"#;
        let e = issuer_error(403, disabled, "credentials");
        assert_eq!(super::super::classify(&e), ErrorClass::Transient);
        assert!(format!("{e:#}").contains("capture_disabled"), "{e:#}");
        assert_eq!(super::super::classify(&issuer_error(403, refused, "x")), ErrorClass::Transient);
        assert_eq!(c(503), ErrorClass::Transient);
        assert_eq!(c(429), ErrorClass::Transient);
        assert_eq!(c(400), ErrorClass::Config);
    }

    #[test]
    fn credentials_without_sign_in_are_a_config_error() {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kcap-issuer-{}", uuid::Uuid::new_v4().simple())),
        );
        let e = credentials(&paths).unwrap_err();
        assert_eq!(super::super::classify(&e), ErrorClass::Config);
        let _ = std::fs::remove_dir_all(&paths.root);
    }
}
