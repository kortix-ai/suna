//! The machine service on macOS and Linux (`kortix-capture machine run`, root):
//! it enrolls each person who uses the graphical session of this computer, with
//! the enrollment token only root can read.
//!
//! - macOS: the LaunchDaemon `ai.kortix.capture.machine`. The person is the
//!   console user (the owner of `/dev/console`; root means the login window).
//!   The configuration is the MDM profile (`/Library/Managed Preferences/ai.kortix.capture.plist`,
//!   keys `Url` and `EnrollmentToken`) or `/Library/Application Support/Kortix/Capture/config.json`.
//! - Linux: the system service `kortix-capture-machine.service`. The people are
//!   the users of logind sessions of class `user` and type `x11`, `wayland` or
//!   `mir` (not remote). The configuration is `/etc/kortix/capture.json`.
//!
//! The config file is `{"url": "...", "enrollment_token": "..."}`, mode 0600,
//! owned by root. A file that another user owns or can write is ignored.
//!
//! Unlike the Windows service, this one does not start the recorder. A global
//! launchd agent / systemd user unit runs `kortix-capture agent` in every
//! person's session; it starts `service run --managed` once a config exists, and
//! the recorder starts once the library is enrolled. This service only
//! enrolls (`issuer::enroll`) and hands the device token to the person's own
//! process (`sync adopt`, JSON on stdin), so the person never sees the
//! enrollment token. Machine state and the log live in [`machine_dir`]; neither
//! holds a secret.

use super::{
    public_sessions,
    after_enrollment, issuer, machine_dir, state_path, step, EnrollmentState, ManagedConfig,
    SessionState, Step, RECHECK, TICK,
};
use crate::memory::paths::MemoryPaths;
use crate::memory::store::now_ms;
use crate::memory::sync::issuer::{EnrollUser, Enrollment};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::CStr;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A helper run as the person (`sync status`, `sync adopt`) gets this long.
const HELPER_TIMEOUT: Duration = Duration::from_secs(90);

pub const DAEMON_LABEL: &str = "ai.kortix.capture.machine";
pub const SYSTEMD_UNIT: &str = "kortix-capture-machine.service";

// ─── Where the configuration lives ──────────────────────────────────────────

pub fn config_file() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/Kortix/Capture/config.json")
    } else {
        PathBuf::from("/etc/kortix/capture.json")
    }
}

/// The MDM configuration profile's managed preferences (macOS). Every local user can
/// read this file, token included: the root-only `config.json` is the recommended route.
pub fn profile_file() -> PathBuf {
    PathBuf::from("/Library/Managed Preferences/ai.kortix.capture.plist")
}

pub fn dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/Kortix/Capture")
    } else {
        PathBuf::from("/var/lib/kortix/capture")
    }
}

/// A root-owned file nobody else can write may carry the configuration.
pub fn trusted(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

fn read_trusted(path: &Path, require_root: bool) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || (require_root && !trusted(meta.uid(), meta.mode())) {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// `{"url": …, "enrollment_token": …}`.
pub fn parse_config_json(text: &str) -> Option<ManagedConfig> {
    let v: Value = serde_json::from_str(text).ok()?;
    ManagedConfig::from_values(
        v["url"].as_str().map(str::to_string),
        v["enrollment_token"].as_str().map(str::to_string),
    )
}

/// The profile as `plutil -convert json` prints it: `{"Url": …, "EnrollmentToken": …}`.
pub fn parse_profile_json(text: &str) -> Option<ManagedConfig> {
    let v: Value = serde_json::from_str(text).ok()?;
    ManagedConfig::from_values(
        v["Url"].as_str().map(str::to_string),
        v["EnrollmentToken"].as_str().map(str::to_string),
    )
}

fn read_profile(path: &Path) -> Option<ManagedConfig> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(path)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    parse_profile_json(&String::from_utf8_lossy(&out.stdout))
}

/// The MDM profile first, then the config file.
pub fn read_config() -> Option<ManagedConfig> {
    read_profile(&profile_file())
        .or_else(|| parse_config_json(&read_trusted(&config_file(), true)?))
}

/// The sources of IT's update settings (`auto_update`, `update_channel`), strongest first:
/// the MDM profile, then the root-owned config file. Neither needs the enrollment keys.
pub fn policy_values() -> Vec<Value> {
    let profile = cfg!(target_os = "macos")
        .then(|| {
            Command::new("/usr/bin/plutil")
                .args(["-convert", "json", "-o", "-"])
                .arg(profile_file())
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        })
        .flatten();
    let file = read_trusted(&config_file(), true).and_then(|t| serde_json::from_str::<Value>(&t).ok());
    profile.into_iter().chain(file).collect()
}

/// A configuration source exists on this computer (readable or not): the
/// organization manages it.
pub fn config_present() -> bool {
    config_file().exists() || (cfg!(target_os = "macos") && profile_file().exists())
}

/// `kortix-capture machine configure --url … --token …`, as root: the config file, 0600.
pub fn configure(url: Option<&str>, token: &str) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        bail!("machine configure: empty token");
    }
    let url = url.unwrap_or("").trim();
    let Some(cfg) = ManagedConfig::from_values(Some(url.to_string()), Some(token.to_string()))
    else {
        bail!("machine configure: pass --url <the Kortix API origin>");
    };
    let path = config_file();
    let parent = path.parent().context("config path has no parent")?;
    std::fs::create_dir_all(parent).with_context(|| {
        format!(
            "create {} (run this as root: sudo kortix-capture machine configure …)",
            parent.display()
        )
    })?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755))?;
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_vec_pretty(
        &json!({"url": cfg.url, "enrollment_token": cfg.enrollment_token}),
    )?;
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&body)?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ─── The service, as the OS reports it ──────────────────────────────────────

fn output(program: &str, args: &[&str]) -> Option<(bool, String)> {
    let o = Command::new(program).args(args).output().ok()?;
    Some((
        o.status.success(),
        String::from_utf8_lossy(&o.stdout).into_owned(),
    ))
}

/// `running`, `loaded` (macOS, not running) or `active` / `inactive` (systemd); None when not installed.
pub fn service_state_name() -> Option<String> {
    if cfg!(target_os = "macos") {
        let (ok, text) = output(
            "/bin/launchctl",
            &["print", &format!("system/{DAEMON_LABEL}")],
        )?;
        if !ok {
            return None;
        }
        let running = text.lines().any(|l| l.trim() == "state = running");
        Some(if running { "running" } else { "loaded" }.into())
    } else {
        let (_, text) = output("systemctl", &["is-active", SYSTEMD_UNIT])?;
        let t = text.trim();
        (t != "unknown" && !t.is_empty()).then(|| t.to_string())
    }
}

// ─── The people ─────────────────────────────────────────────────────────────

/// A person who uses this computer's graphical session.
#[derive(Debug, Clone, PartialEq)]
pub struct Person {
    pub uid: u32,
    pub name: String,
    pub home: PathBuf,
}

/// `(login name, home)` of `uid`.
pub fn passwd(uid: u32) -> Option<(String, PathBuf)> {
    let mut buf = vec![0u8; 16 * 1024];
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut res: *mut libc::passwd = std::ptr::null_mut();
    let rc =
        unsafe { libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut res) };
    if rc != 0 || res.is_null() {
        return None;
    }
    let name = unsafe { CStr::from_ptr(pw.pw_name) }
        .to_str()
        .ok()?
        .to_string();
    let home = unsafe { CStr::from_ptr(pw.pw_dir) }.to_str().ok()?;
    Some((name, PathBuf::from(home)))
}

fn person(uid: u32) -> Option<Person> {
    let (name, home) = passwd(uid)?;
    Some(Person { uid, name, home })
}

/// One `loginctl show-session` answer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoginSession {
    pub uid: u32,
    pub name: String,
    pub kind: String,
    pub class: String,
    pub state: String,
    pub remote: bool,
    pub display: String,
}

/// `Key=Value` lines.
pub fn parse_props(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

pub fn parse_login_session(text: &str) -> Option<LoginSession> {
    let p = parse_props(text);
    let get = |k: &str| p.get(k).cloned().unwrap_or_default();
    Some(LoginSession {
        uid: get("User").parse().ok()?,
        name: get("Name"),
        kind: get("Type"),
        class: get("Class"),
        state: get("State"),
        remote: get("Remote") == "yes",
        display: get("Display"),
    })
}

/// Someone sits at a screen: a local `user` session of a graphical type that is in use.
pub fn graphical(s: &LoginSession) -> bool {
    s.class == "user"
        && matches!(s.kind.as_str(), "x11" | "wayland" | "mir")
        && !s.remote
        && matches!(s.state.as_str(), "active" | "online")
}

fn linux_people() -> Vec<Person> {
    let Some((_, list)) = output("loginctl", &["list-sessions", "--no-legend", "--no-pager"])
    else {
        return Vec::new();
    };
    let mut people: BTreeMap<u32, Person> = BTreeMap::new();
    for id in list.lines().filter_map(|l| l.split_whitespace().next()) {
        let Some((_, text)) = output(
            "loginctl",
            &[
                "show-session",
                id,
                "-p",
                "User",
                "-p",
                "Name",
                "-p",
                "Type",
                "-p",
                "Class",
                "-p",
                "State",
                "-p",
                "Remote",
                "-p",
                "Display",
            ],
        ) else {
            continue;
        };
        if let Some(s) = parse_login_session(&text).filter(graphical) {
            if let Some(p) = person(s.uid) {
                people.insert(s.uid, p);
            }
        }
    }
    people.into_values().collect()
}

/// The console user (the owner of `/dev/console`); root is the login window.
fn macos_people() -> Vec<Person> {
    std::fs::metadata("/dev/console")
        .ok()
        .map(|m| m.uid())
        .filter(|uid| *uid != 0)
        .and_then(person)
        .into_iter()
        .collect()
}

pub fn people() -> Vec<Person> {
    if cfg!(target_os = "macos") {
        macos_people()
    } else {
        linux_people()
    }
}

/// `EMailAddress: jane@corp.example` (or the value on the next line) from `dscl -read`.
pub fn parse_dscl_email(text: &str) -> Option<String> {
    let mut lines = text.lines();
    let first = lines.next()?;
    let inline = first.strip_prefix("EMailAddress:").map(str::trim)?;
    let value = if inline.is_empty() {
        lines.next().map(str::trim).unwrap_or("")
    } else {
        inline
    };
    plausible_email(value)
}

fn plausible_email(s: &str) -> Option<String> {
    let s = s.trim();
    let (local, domain) = s.split_once('@')?;
    (!local.is_empty() && domain.contains('.') && !s.contains(char::is_whitespace))
        .then(|| s.to_string())
}

/// The user principal name is the account record's email (macOS) or the login
/// name when it is one (`jane@corp.example` from SSSD); the account name is the login name.
pub fn enroll_user(name: &str) -> EnrollUser {
    let principal_name = if cfg!(target_os = "macos") {
        output(
            "/usr/bin/dscl",
            &[".", "-read", &format!("/Users/{name}"), "EMailAddress"],
        )
        .filter(|(ok, _)| *ok)
        .and_then(|(_, t)| parse_dscl_email(&t))
    } else {
        plausible_email(name)
    };
    EnrollUser {
        principal_name,
        account_name: name.to_string(),
    }
}

/// The user running this process, for `sync enroll`.
pub fn current_user() -> EnrollUser {
    let uid = unsafe { libc::getuid() };
    enroll_user(&passwd(uid).map(|p| p.0).unwrap_or_default())
}

// ─── Processes as the person ────────────────────────────────────────────────

/// The command that runs `exe args…` as `p`, in the person's own session.
///
/// - macOS: `launchctl asuser <uid> sudo -u <name> -H exe args…`. `asuser` puts the
///   process in the person's login session, so the login Keychain opens for the device token.
/// - Linux: `runuser -u <name> -- env -i … exe args…` with the file key store: the
///   person's Secret Service has no session bus here.
pub fn as_person(p: &Person, exe: &Path, args: &[&str]) -> Command {
    let exe = exe.to_string_lossy().into_owned();
    if cfg!(target_os = "macos") {
        let mut c = Command::new("/bin/launchctl");
        c.args([
            "asuser",
            &p.uid.to_string(),
            "/usr/bin/sudo",
            "-u",
            &p.name,
            "-H",
        ])
        .arg(exe)
        .args(args);
        c
    } else {
        let mut c = Command::new("runuser");
        c.args(["-u", &p.name, "--", "env", "-i"])
            .arg(format!("HOME={}", p.home.display()))
            .arg("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            .arg(format!("USER={}", p.name))
            .arg(format!("LOGNAME={}", p.name))
            .arg(format!("{}=file", crate::secret_store::STORE_ENV))
            .arg(exe)
            .args(args);
        c
    }
}

/// Run `exe args…` as the person, feed `stdin`, return (exit code, stdout + stderr).
fn run_as(p: &Person, exe: &Path, args: &[&str], stdin: &[u8]) -> Result<(i32, String)> {
    let mut child = as_person(p, exe, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start `{}` as {}", args.join(" "), p.name))?;
    let mut input = child.stdin.take().context("stdin")?;
    let mut out = child.stdout.take().context("stdout")?;
    let mut err = child.stderr.take().context("stderr")?;
    // Read on threads so a chatty child never blocks on a full pipe.
    let o = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = (&mut out).take(4 << 20).read_to_string(&mut s);
        s
    });
    let e = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = (&mut err).take(1 << 20).read_to_string(&mut s);
        s
    });
    let _ = input.write_all(stdin);
    drop(input);
    let t0 = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code().unwrap_or(-1);
        }
        if t0.elapsed() > HELPER_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "`{}` did not finish in {} s",
                args.join(" "),
                HELPER_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let stdout = o.join().unwrap_or_default();
    let stderr = e.join().unwrap_or_default();
    Ok((code, format!("{stdout}{stderr}")))
}

/// Start the person's agent now (a configuration that arrived after their login
/// did not start it): macOS loads and kicks the launchd agent, Linux starts the user unit.
fn kick_agent(p: &Person) {
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", p.uid);
        let _ = output(
            "/bin/launchctl",
            &[
                "bootstrap",
                &domain,
                "/Library/LaunchAgents/ai.kortix.capture.agent.plist",
            ],
        );
        let _ = output(
            "/bin/launchctl",
            &["kickstart", &format!("{domain}/ai.kortix.capture.agent")],
        );
    } else {
        let _ = output(
            "systemctl",
            &[
                &format!("--machine={}@.host", p.name),
                "--user",
                "start",
                "kortix-capture.service",
            ],
        );
    }
}

// ─── The loop ───────────────────────────────────────────────────────────────

struct Session {
    state: SessionState,
    next_attempt: Option<Instant>,
    last_check: Option<Instant>,
}

struct Machine {
    exe: PathBuf,
    sessions: BTreeMap<u32, Session>,
    log: Option<std::fs::File>,
    updater: super::update::Updater,
}

impl Machine {
    fn log(&mut self, line: &str) {
        if let Some(f) = self.log.as_mut() {
            let _ = writeln!(f, "{} {line}", chrono::Utc::now().to_rfc3339());
        }
    }

    fn tick(&mut self) {
        let cfg = super::read_config();
        let live = people();
        self.sessions
            .retain(|uid, _| live.iter().any(|p| p.uid == *uid));
        for p in &live {
            if let Err(e) = self.tick_person(p, cfg.as_ref()) {
                let msg = format!("{e:#}");
                self.log(&format!("{}: {msg}", p.name));
                if let Some(s) = self.sessions.get_mut(&p.uid) {
                    s.state.state = "error".into();
                    s.state.detail = Some(msg.chars().take(300).collect());
                    s.next_attempt = Some(Instant::now() + issuer::TRANSIENT_RETRY);
                }
            }
        }
        self.write_state(cfg.as_ref());
        self.updater.tick();
        if let Some(since) = self.updater.verifying_since() {
            let ok = self.healthy_since(&live, since);
            self.updater.note_probe(ok);
        }
    }

    /// Every signed-in person's recorder runs and saves frames (see `update::person_ok`).
    fn healthy_since(&mut self, live: &[Person], since_ms: i64) -> bool {
        let exe = self.exe.clone();
        live.iter().all(|p| {
            run_as(p, &exe, &["--json", "status"], b"")
                .ok()
                .and_then(|(_, out)| serde_json::from_str::<Value>(&out).ok())
                .is_some_and(|st| super::update::person_ok(&st, since_ms))
        })
    }

    fn tick_person(&mut self, p: &Person, cfg: Option<&ManagedConfig>) -> Result<()> {
        let user = enroll_user(&p.name);
        let entry = self.sessions.entry(p.uid).or_insert_with(|| Session {
            state: SessionState {
                session_id: p.uid,
                ..Default::default()
            },
            next_attempt: None,
            last_check: None,
        });
        entry.state.user = user.clone();
        let Some(cfg) = cfg else {
            entry.state.state = "not_configured".into();
            entry.state.detail = Some(format!(
                "{} has no readable url and enrollment_token",
                config_file().display()
            ));
            return Ok(());
        };
        let enrolled = entry.state.state == "enrolled";
        if enrolled && entry.last_check.is_some_and(|t| t.elapsed() < RECHECK) {
            return Ok(());
        }
        if !enrolled && entry.next_attempt.is_some_and(|t| Instant::now() < t) {
            return Ok(());
        }
        let exe = self.exe.clone();
        let (_, status) = run_as(p, &exe, &["--json", "sync", "status"], b"")?;
        let status: Value = serde_json::from_str(&status).unwrap_or(Value::Null);
        let entry = self.sessions.get_mut(&p.uid).context("session")?;
        entry.last_check = Some(Instant::now());
        if step(&status, cfg) == Step::Run {
            // The first look at an enrolled person (the service just started, or the
            // package was upgraded and stopped their agent): make sure the agent runs.
            if entry.state.state != "enrolled" {
                kick_agent(p);
            }
            let entry = self.sessions.get_mut(&p.uid).context("session")?;
            entry.state.state = "enrolled".into();
            entry.state.device_id = status["kortix"]["device_id"].as_str().map(str::to_string);
            return Ok(());
        }
        let identity = crate::memory::sync::identity(&MemoryPaths::at(machine_dir()));
        let held = run_as(p, &exe, &["sync", "device-token", "--issuer", &cfg.url], b"")
            .ok()
            .map(|(_, out)| out.trim().to_string())
            .filter(|t| !t.is_empty());
        let answer = issuer::enroll(&cfg.url, &cfg.enrollment_token, &user, &identity, held.as_deref());
        let (state, detail, wait) = after_enrollment(&answer);
        entry.state.state = state.clone();
        entry.state.detail = detail.clone();
        let line = format!(
            "{} ({}): enroll → {state} {}",
            p.name,
            user.principal_name.as_deref().unwrap_or("no email"),
            detail.as_deref().unwrap_or("")
        );
        match answer {
            Ok(Enrollment::Enrolled(adoption)) => {
                let json = serde_json::to_vec(&adoption)?;
                let (code, out) = run_as(p, &exe, &["--json", "sync", "adopt"], &json)?;
                if code != 0 {
                    bail!("sync adopt failed ({code}): {}", out.trim());
                }
                let entry = self.sessions.get_mut(&p.uid).context("session")?;
                entry.state.device_id = Some(adoption.device_id);
                entry.state.next_attempt_at_ms = None;
                entry.next_attempt = None;
                kick_agent(p);
            }
            _ => {
                let next = now_ms() + wait.as_millis() as i64;
                entry.next_attempt = Some(Instant::now() + wait);
                entry.state.next_attempt_at_ms = Some(next);
                // The person (and the tray) sees why nothing records yet.
                let st = EnrollmentState::from_answer(&state, detail, Some(next));
                if let Err(e) = run_as(
                    p,
                    &exe,
                    &["--json", "sync", "enrollment-state"],
                    &serde_json::to_vec(&st)?,
                ) {
                    self.log(&format!("{}: could not record the state: {e:#}", p.name));
                }
            }
        }
        self.log(&line);
        Ok(())
    }

    fn write_state(&self, cfg: Option<&ManagedConfig>) {
        let v = json!({
            "updated_at": chrono::Utc::now().to_rfc3339(),
            "pid": std::process::id(),
            "url": cfg.map(|c| c.url.clone()),
            "configured": cfg.is_some(),
            "sessions": public_sessions(self.sessions.values().map(|s| s.state.clone())),
        });
        let _ = std::fs::create_dir_all(machine_dir());
        let _ = std::fs::set_permissions(machine_dir(), std::fs::Permissions::from_mode(0o755));
        let tmp = state_path().with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&v).unwrap_or_default()).is_ok() {
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644));
            let _ = std::fs::rename(&tmp, state_path());
        }
    }
}

/// `kortix-capture machine run`: a tick every 10 s until the OS stops the service (SIGTERM).
pub fn run() -> Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        bail!("the machine service runs as root (launchd / systemd start it)");
    }
    let logs = machine_dir().join("logs");
    std::fs::create_dir_all(&logs)?;
    let mut m = Machine {
        exe: std::env::current_exe()?,
        sessions: BTreeMap::new(),
        log: std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("machine.log"))
            .ok(),
        updater: super::update::Updater::new(),
    };
    m.log(&format!(
        "machine service started ({} {})",
        env!("CARGO_PKG_VERSION"),
        m.exe.display()
    ));
    loop {
        m.tick();
        std::thread::sleep(TICK);
    }
}

// ─── The person's agent ─────────────────────────────────────────────────────

/// A graphical session's X11 display for this user (Linux): `DISPLAY` and, on
/// Wayland, `XDG_SESSION_TYPE` from logind, since a user unit does not inherit
/// them. Values already in the environment win.
pub fn session_env_from(props: &BTreeMap<String, String>) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if let Some(d) = props.get("Display").filter(|d| !d.is_empty()) {
        out.push(("DISPLAY", d.clone()));
    }
    if let Some(t) = props.get("Type").filter(|t| !t.is_empty()) {
        out.push(("XDG_SESSION_TYPE", t.clone()));
    }
    out
}

/// `:99` from the X11 socket name `X99`.
pub fn display_of_socket(name: &str) -> Option<String> {
    let n = name.strip_prefix('X')?;
    (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then(|| format!(":{n}"))
}

fn export_session_env() {
    if cfg!(target_os = "macos") {
        return;
    }
    let uid = unsafe { libc::getuid() }.to_string();
    let primary = output("loginctl", &["show-user", &uid, "-p", "Display", "--value"])
        .map(|(_, t)| t.trim().to_string())
        .filter(|id| !id.is_empty());
    let props = primary
        .and_then(|id| {
            output(
                "loginctl",
                &["show-session", &id, "-p", "Type", "-p", "Display"],
            )
        })
        .map(|(_, t)| parse_props(&t))
        .unwrap_or_default();
    for (k, v) in session_env_from(&props) {
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
    if std::env::var_os("DISPLAY").is_none() {
        let mine = unsafe { libc::getuid() };
        let socket = std::fs::read_dir("/tmp/.X11-unix")
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.metadata().is_ok_and(|m| m.uid() == mine))
            .filter_map(|e| display_of_socket(&e.file_name().to_string_lossy()))
            .min();
        if let Some(d) = socket {
            std::env::set_var("DISPLAY", d);
        }
    }
    if std::env::var_os("XAUTHORITY").is_none() {
        let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        if let Some(x) = [
            format!("{runtime}/gdm/Xauthority"),
            format!("{home}/.Xauthority"),
        ]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        {
            std::env::set_var("XAUTHORITY", x);
        }
    }
}

/// `kortix-capture agent`: what the global launchd agent / systemd user unit
/// runs in every graphical session. It is `service run --managed` (the recorder follows the library's enrollment;
/// the tray shows the notice) when IT configured the computer, else `service run`:
/// the recorder starts at once and records locally, silently.
pub fn agent(paths: &MemoryPaths) -> Result<()> {
    let exe = std::env::current_exe()?;
    export_session_env();
    loop {
        // IT's configuration present: the recorder follows the enrollment. Without it
        // the computer records locally with sync Off, until the person connects.
        let managed = super::machine_service_installed();
        let changed = crate::memory::service::run_with(
            paths,
            &exe,
            managed,
            Some(&super::machine_service_installed),
        )?;
        if !changed {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_config_file_needs_a_url_and_a_token() {
        let c = parse_config_json(
            r#"{"url":"https://api.kortix.example/v1","enrollment_token":" kortix_enr_x "}"#,
        )
        .unwrap();
        assert_eq!(c.url, "https://api.kortix.example");
        assert_eq!(c.enrollment_token, "kortix_enr_x");
        assert!(parse_config_json(r#"{"url":"https://api.kortix.example"}"#).is_none());
        assert!(parse_config_json(r#"{"url":"https://x","enrollment_token":"  "}"#).is_none());
        assert!(parse_config_json("not json").is_none());
    }

    #[test]
    fn the_profile_uses_the_capitalized_keys() {
        let c = parse_profile_json(r#"{"Url":"https://api.kortix.example","EnrollmentToken":"t","PayloadType":"ai.kortix.capture"}"#)
            .unwrap();
        assert_eq!(
            (c.url.as_str(), c.enrollment_token.as_str()),
            ("https://api.kortix.example", "t")
        );
        assert!(parse_profile_json(r#"{"url":"https://x","enrollment_token":"t"}"#).is_none());
    }

    #[test]
    fn only_a_root_owned_file_nobody_else_writes_is_trusted() {
        assert!(trusted(0, 0o100600));
        assert!(trusted(0, 0o100644));
        assert!(!trusted(0, 0o100666));
        assert!(!trusted(0, 0o100620));
        assert!(!trusted(501, 0o100600));
    }

    #[test]
    fn a_config_file_is_read_only_when_trusted() {
        let dir = std::env::temp_dir().join(format!("kcap-unix-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("capture.json");
        std::fs::write(&f, r#"{"url":"https://x.example","enrollment_token":"t"}"#).unwrap();
        // This test runs as an ordinary user: the file is ours, not root's.
        if unsafe { libc::geteuid() } != 0 {
            assert!(read_trusted(&f, true).is_none());
        }
        assert!(read_trusted(&f, false).is_some());
        assert!(
            read_trusted(&dir, false).is_none(),
            "a directory is no config"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_logind_session_counts_when_local_graphical_and_in_use() {
        let show =
            "User=1000\nName=jane\nType=x11\nClass=user\nState=active\nRemote=no\nDisplay=:0\n";
        let s = parse_login_session(show).unwrap();
        assert_eq!(
            (s.uid, s.name.as_str(), s.display.as_str()),
            (1000, "jane", ":0")
        );
        assert!(graphical(&s));
        let wayland = parse_login_session(&show.replace("x11", "wayland")).unwrap();
        assert!(
            graphical(&wayland),
            "Wayland users are enrolled; the recorder says it cannot capture"
        );
        for (from, to) in [
            ("Type=x11", "Type=tty"),
            ("Type=x11", "Type=unspecified"),
            ("Class=user", "Class=greeter"),
            ("Remote=no", "Remote=yes"),
            ("State=active", "State=closing"),
        ] {
            let s = parse_login_session(&show.replace(from, to)).unwrap();
            assert!(!graphical(&s), "{to}");
        }
        assert!(parse_login_session("Name=x\n").is_none());
    }

    #[test]
    fn the_email_comes_from_the_account_record() {
        assert_eq!(
            parse_dscl_email("EMailAddress: jane@corp.example\n").as_deref(),
            Some("jane@corp.example")
        );
        assert_eq!(
            parse_dscl_email("EMailAddress:\n jane@corp.example\n").as_deref(),
            Some("jane@corp.example")
        );
        assert_eq!(parse_dscl_email("No such key: EMailAddress"), None);
        assert_eq!(parse_dscl_email("EMailAddress: not an email"), None);
        assert_eq!(
            plausible_email("jane@corp.example").as_deref(),
            Some("jane@corp.example")
        );
        assert_eq!(plausible_email("jane"), None);
        assert_eq!(plausible_email("a@localhost"), None);
    }

    #[test]
    fn a_helper_runs_as_the_person_in_their_session() {
        let p = Person {
            uid: 501,
            name: "jane".into(),
            home: PathBuf::from("/Users/jane"),
        };
        let exe = Path::new("/usr/bin/kortix-capture");
        let c = as_person(&p, exe, &["--json", "sync", "adopt"]);
        let line: Vec<String> = std::iter::once(c.get_program())
            .chain(c.get_args())
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        if cfg!(target_os = "macos") {
            assert_eq!(
                line.join(" "),
                "/bin/launchctl asuser 501 /usr/bin/sudo -u jane -H /usr/bin/kortix-capture --json sync adopt"
            );
        } else {
            let j = line.join(" ");
            assert!(
                j.starts_with("runuser -u jane -- env -i HOME=/Users/jane "),
                "{j}"
            );
            assert!(j.contains("KORTIX_CAPTURE_KEY_STORE=file"), "{j}");
            assert!(
                j.ends_with("/usr/bin/kortix-capture --json sync adopt"),
                "{j}"
            );
        }
    }

    #[test]
    fn the_agent_finds_the_display_of_the_session() {
        let props = parse_props("Type=x11\nDisplay=:99\n");
        assert_eq!(
            session_env_from(&props),
            vec![
                ("DISPLAY", ":99".to_string()),
                ("XDG_SESSION_TYPE", "x11".to_string())
            ]
        );
        assert!(session_env_from(&parse_props("Type=\nDisplay=\n")).is_empty());
        assert_eq!(display_of_socket("X99").as_deref(), Some(":99"));
        assert_eq!(display_of_socket("X"), None);
        assert_eq!(display_of_socket("ssh-1"), None);
    }

    #[test]
    fn the_enroll_user_is_the_login_name_and_an_email_when_there_is_one() {
        if cfg!(target_os = "linux") {
            let u = enroll_user("jane@corp.example");
            assert_eq!(u.principal_name.as_deref(), Some("jane@corp.example"));
            assert_eq!(enroll_user("jane").principal_name, None);
        }
        assert_eq!(enroll_user("jane").account_name, "jane");
    }
}
