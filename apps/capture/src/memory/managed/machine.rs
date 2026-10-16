//! The Windows machine service (`kortix-capture machine run`, LocalSystem):
//! one recorder per signed-in person, enrolled with the organization's token.
//! The module doc of `managed` describes the flow.

use super::{
    machine_dir_trusted, public_sessions,
    after_enrollment, issuer, machine_dir, state_path, step, ManagedConfig, SessionState, Step,
    POLICY_KEY, RECHECK, SERVICE_NAME, TICK,
};
use crate::memory::store::now_ms;
use crate::memory::sync::issuer::{EnrollUser, Enrollment};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::{c_void, OsString};
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, SetHandleInformation, BOOL, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL,
    WAIT_OBJECT_0,
};
use windows::Win32::Security::Authentication::Identity::{
    GetUserNameExW, NameSamCompatible, NameUserPrincipal, EXTENDED_NAME_FORMAT,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    GetTokenInformation, ImpersonateLoggedOnUser, RevertToSelf, TokenUser, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_USER,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Registry::{
    RegCloseKey, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE,
    KEY_SET_VALUE, KEY_WOW64_64KEY, REG_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::System::RemoteDesktop::{
    WTSActive, WTSEnumerateSessionsW, WTSFreeMemory, WTSQueryUserToken, WTS_CURRENT_SERVER_HANDLE,
    WTS_SESSION_INFOW,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState,
    ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

const STILL_ACTIVE: u32 = 259;
/// A helper run as the person (`sync status`, `sync adopt`) gets this long.
const HELPER_TIMEOUT: Duration = Duration::from_secs(90);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

// ─── Configuration and installation ─────────────────────────────────────────

fn reg_string(key: &str, value: &str) -> Option<String> {
    let (k, v) = (wide(key), wide(value));
    let mut len: u32 = 0;
    unsafe {
        let probe = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(k.as_ptr()),
            PCWSTR(v.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut len),
        );
        if probe.is_err() || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        let read = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(k.as_ptr()),
            PCWSTR(v.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        );
        if read.is_err() {
            return None;
        }
        Some(from_wide(&buf)).filter(|s| !s.trim().is_empty())
    }
}

/// `HKLM\SOFTWARE\Policies\Kortix\Capture` `Url` + `EnrollmentToken`. Only
/// SYSTEM and Administrators can read the key; for anyone else this is None.
pub fn read_config() -> Option<ManagedConfig> {
    ManagedConfig::from_values(
        reg_string(POLICY_KEY, "Url"),
        reg_string(POLICY_KEY, "EnrollmentToken"),
    )
}

/// IT's update settings from the policy key: `AutoUpdate` (`0`/`off` turns updates off)
/// and `UpdateChannel` (`stable` or `dev`), both string values.
pub(super) fn policy_value() -> Value {
    json!({
        "AutoUpdate": reg_string(POLICY_KEY, "AutoUpdate"),
        "UpdateChannel": reg_string(POLICY_KEY, "UpdateChannel"),
    })
}

/// Refuse a folder SYSTEM or Administrators do not own, or a link (the updater's folder).
pub(super) fn require_trusted_owner(dir: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(dir)?;
    let owner = owner_sid(dir)?;
    if !machine_dir_trusted(&owner, meta.file_attributes() & 0x400 != 0) {
        bail!("{} is not used: it is a link or an account other than SYSTEM or Administrators owns it ({owner})", dir.display());
    }
    Ok(())
}

/// Write `EnrollmentToken` into the policy key the MSI created (with its
/// SYSTEM + Administrators ACL). The MSI runs this as a deferred custom action
/// that hides its command line: Windows Installer logs every Registry-table
/// value, hidden property or not. The key must exist: a token never lands in a
/// key with the default (readable) ACL.
pub fn configure_token(token: &str) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        bail!("machine configure: empty token");
    }
    let key = wide(POLICY_KEY);
    let mut h = HKEY::default();
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            0,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            &mut h,
        )
    };
    if opened.is_err() {
        bail!(r"HKLM\{POLICY_KEY} does not exist (or is not writable): {opened:?}");
    }
    let data: Vec<u8> = wide(token).iter().flat_map(|c| c.to_le_bytes()).collect();
    let name = wide("EnrollmentToken");
    let set = unsafe { RegSetValueExW(h, PCWSTR(name.as_ptr()), 0, REG_SZ, Some(&data)) };
    unsafe {
        let _ = RegCloseKey(h);
    }
    if set.is_err() {
        bail!("writing EnrollmentToken failed: {set:?}");
    }
    Ok(())
}

/// The Service Control Manager knows `KortixCapture` (any user may ask).
pub fn service_installed() -> bool {
    service_state().is_some()
}

/// `running`, `stopped`, … or None when not installed.
pub fn service_state_name() -> Option<String> {
    service_state().map(|s| format!("{s:?}").to_lowercase())
}

fn service_state() -> Option<ServiceState> {
    let manager =
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .ok()?;
    service.query_status().ok().map(|s| s.current_state)
}

fn name_ex(format: EXTENDED_NAME_FORMAT) -> Option<String> {
    let mut buf = vec![0u16; 512];
    let mut len = buf.len() as u32;
    let ok = unsafe { GetUserNameExW(format, PWSTR(buf.as_mut_ptr()), &mut len) };
    ok.as_bool()
        .then(|| from_wide(&buf))
        .filter(|s| !s.trim().is_empty())
}

/// The user running this process (`sync enroll` by hand).
pub fn current_user() -> EnrollUser {
    EnrollUser {
        principal_name: name_ex(NameUserPrincipal),
        account_name: name_ex(NameSamCompatible)
            .or_else(|| std::env::var("USERNAME").ok())
            .unwrap_or_default(),
    }
}

// ─── The person behind a session ────────────────────────────────────────────

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn session_token(session: u32) -> Result<Token> {
    let mut h = HANDLE::default();
    unsafe { WTSQueryUserToken(session, &mut h) }
        .with_context(|| format!("WTSQueryUserToken({session})"))?;
    Ok(Token(h))
}

fn sid_string(token: &Token) -> Option<String> {
    unsafe {
        let mut len = 0u32;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            len,
            &mut len,
        )
        .ok()?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut s).ok()?;
        let out = s.to_string().ok();
        let _ = LocalFree(HLOCAL(s.0.cast()));
        out
    }
}

/// Who signed in to the session, read from its token: the user principal name
/// (domain and Entra ID accounts) and the login name. Entra ID accounts keep
/// the UPN in the identity store when `GetUserNameEx` has none.
fn session_user(token: &Token) -> Result<(EnrollUser, String)> {
    unsafe { ImpersonateLoggedOnUser(token.0) }.context("ImpersonateLoggedOnUser")?;
    let upn = name_ex(NameUserPrincipal);
    let sam = name_ex(NameSamCompatible);
    unsafe { RevertToSelf() }.context("RevertToSelf")?;
    let sid = sid_string(token).context("the session token has no user SID")?;
    let upn = upn.or_else(|| {
        reg_string(
            &format!(r"SOFTWARE\Microsoft\IdentityStore\Cache\{sid}\IdentityCache\{sid}"),
            "UserName",
        )
        .filter(|u| u.contains('@'))
    });
    Ok((
        EnrollUser {
            principal_name: upn,
            account_name: sam.unwrap_or_else(|| sid.clone()),
        },
        sid,
    ))
}

// ─── Processes as the person ────────────────────────────────────────────────

struct Env(*mut c_void);

impl Drop for Env {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyEnvironmentBlock(self.0);
        }
    }
}

fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

/// A process of the person's: their token, their environment (their
/// `%APPDATA%`, so their library), their desktop, no window.
struct Child {
    process: HANDLE,
    pid: u32,
    /// The kill-on-close job the long-lived child runs in: dropping the Child
    /// (or this service ending in any way) ends it and everything it started.
    job: Option<HANDLE>,
}

impl Child {
    fn exited(&self) -> Option<u32> {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.process, &mut code) }.ok()?;
        (code != STILL_ACTIVE).then_some(code)
    }

    fn wait(&self, timeout: Duration) -> Option<u32> {
        let w = unsafe { WaitForSingleObject(self.process, timeout.as_millis() as u32) };
        if w == WAIT_OBJECT_0 {
            self.exited()
        } else {
            None
        }
    }

    fn kill(&self) {
        unsafe {
            let _ = TerminateProcess(self.process, 1);
        }
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        unsafe {
            if let Some(job) = self.job.take() {
                let _ = CloseHandle(job);
            }
            let _ = CloseHandle(self.process);
        }
    }
}

/// The ends a helper gets: stdin to write, stdout to read.
struct Pipes {
    stdin_write: HANDLE,
    stdout_read: HANDLE,
}

/// Start `exe args…` as the person. A helper gets `pipes`; the long-lived
/// recorder service (`pipes: None`) starts suspended, goes into its own
/// kill-on-close job, then runs.
fn spawn_as(token: &Token, exe: &Path, args: &[&str], pipes: Option<&mut Pipes>) -> Result<Child> {
    let long_lived = pipes.is_none();
    let mut env = std::ptr::null_mut();
    unsafe { CreateEnvironmentBlock(&mut env, token.0, BOOL(0)) }
        .context("CreateEnvironmentBlock")?;
    let env = Env(env);
    let mut line: Vec<u16> = wide(
        &std::iter::once(exe.to_string_lossy().into_owned())
            .chain(args.iter().map(|a| a.to_string()))
            .map(|a| quote(&a))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut desktop = wide("winsta0\\default");
    let mut si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    // The child's ends of the pipes, closed here once the child has its copies.
    let mut child_ends: Vec<HANDLE> = Vec::new();
    if let Some(p) = pipes {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: BOOL(1),
        };
        let (mut in_r, mut in_w, mut out_r, mut out_w) = (
            HANDLE::default(),
            HANDLE::default(),
            HANDLE::default(),
            HANDLE::default(),
        );
        unsafe {
            CreatePipe(&mut in_r, &mut in_w, Some(&sa), 0).context("CreatePipe stdin")?;
            CreatePipe(&mut out_r, &mut out_w, Some(&sa), 0).context("CreatePipe stdout")?;
            // Only the child's ends are inherited.
            SetHandleInformation(in_w, HANDLE_FLAG_INHERIT.0, Default::default())?;
            SetHandleInformation(out_r, HANDLE_FLAG_INHERIT.0, Default::default())?;
        }
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = in_r;
        si.hStdOutput = out_w;
        si.hStdError = out_w;
        child_ends = vec![in_r, out_w];
        p.stdin_write = in_w;
        p.stdout_read = out_r;
    }
    let mut pi = PROCESS_INFORMATION::default();
    let dir = wide(&exe.parent().unwrap_or(Path::new("C:\\")).to_string_lossy());
    let created = unsafe {
        CreateProcessAsUserW(
            token.0,
            PCWSTR::null(),
            PWSTR(line.as_mut_ptr()),
            None,
            None,
            BOOL(!child_ends.is_empty() as i32),
            CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | if long_lived {
                    CREATE_SUSPENDED
                } else {
                    Default::default()
                },
            Some(env.0),
            PCWSTR(dir.as_ptr()),
            &si,
            &mut pi,
        )
    };
    for h in child_ends {
        unsafe {
            let _ = CloseHandle(h);
        }
    }
    created.context("CreateProcessAsUserW")?;
    let job = if long_lived {
        let job = crate::os_proc::kill_on_close_job(pi.hProcess.0).map(HANDLE);
        unsafe {
            ResumeThread(pi.hThread);
        }
        job
    } else {
        None
    };
    unsafe {
        let _ = CloseHandle(pi.hThread);
    }
    Ok(Child {
        process: pi.hProcess,
        pid: pi.dwProcessId,
        job,
    })
}

/// Run `exe args…` as the person, feed `stdin`, return (exit code, stdout).
fn run_as(token: &Token, exe: &Path, args: &[&str], stdin: &[u8]) -> Result<(u32, String)> {
    let mut pipes = Pipes {
        stdin_write: HANDLE::default(),
        stdout_read: HANDLE::default(),
    };
    let child = spawn_as(token, exe, args, Some(&mut pipes))?;
    let mut input = unsafe { std::fs::File::from_raw_handle(pipes.stdin_write.0 as _) };
    let output = unsafe { std::fs::File::from_raw_handle(pipes.stdout_read.0 as _) };
    // Read on a thread so a chatty child never blocks on a full pipe.
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = output.take(4 << 20).read_to_string(&mut text);
        text
    });
    let _ = input.write_all(stdin);
    drop(input);
    let Some(code) = child.wait(HELPER_TIMEOUT) else {
        child.kill();
        bail!(
            "`{}` did not finish in {} s",
            args.join(" "),
            HELPER_TIMEOUT.as_secs()
        );
    };
    let text = reader.join().unwrap_or_default();
    Ok((code, text))
}

// ─── The sessions ───────────────────────────────────────────────────────────

/// The sessions someone is signed in to: `(session id, active)`. Session 0 (services) never.
fn sessions() -> Vec<(u32, bool)> {
    let mut list: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    if unsafe { WTSEnumerateSessionsW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut list, &mut count) }
        .is_err()
    {
        return Vec::new();
    }
    let out = unsafe { std::slice::from_raw_parts(list, count as usize) }
        .iter()
        .filter(|s| s.SessionId != 0)
        .map(|s| (s.SessionId, s.State == WTSActive))
        .collect();
    unsafe { WTSFreeMemory(list.cast()) };
    out
}

struct Session {
    state: SessionState,
    sid: String,
    child: Option<Child>,
    next_attempt: Option<Instant>,
    last_check: Option<Instant>,
    crashes: u32,
    started: Option<Instant>,
    /// The recorder is the local one (`service run`, no configuration from IT).
    local: bool,
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

    /// One look at every session.
    fn tick(&mut self) {
        let cfg = super::read_config();
        let live = sessions();
        // A session that ended took its processes along (logoff).
        let gone: Vec<u32> = self
            .sessions
            .keys()
            .filter(|id| !live.iter().any(|(l, _)| l == *id))
            .copied()
            .collect();
        for id in gone {
            self.log(&format!("session {id}: ended"));
            self.sessions.remove(&id);
        }
        // Every session with a person behind it, connected or not: a disconnected
        // session (switched user, closed remote desktop) keeps its recorder,
        // which skips a locked screen by itself.
        for (id, _active) in live {
            if let Err(e) = self.tick_session(id, cfg.as_ref()) {
                let msg = format!("{e:#}");
                self.log(&format!("session {id}: {msg}"));
                if let Some(s) = self.sessions.get_mut(&id) {
                    s.state.state = "error".into();
                    s.state.detail = Some(msg.chars().take(300).collect());
                    s.next_attempt = Some(Instant::now() + issuer::TRANSIENT_RETRY);
                }
            }
        }
        self.write_state(cfg.as_ref());
        self.updater.tick();
        if let Some(since) = self.updater.verifying_since() {
            let ok = self.healthy_since(since);
            self.updater.note_probe(ok);
        }
    }

    /// Every signed-in person's recorder runs and saves frames (see `update::person_ok`).
    fn healthy_since(&mut self, since_ms: i64) -> bool {
        let exe = self.exe.clone();
        sessions().into_iter().all(|(id, _)| {
            let Ok(token) = session_token(id) else {
                return true;
            };
            run_as(&token, &exe, &["--json", "status"], b"")
                .ok()
                .and_then(|(_, out)| serde_json::from_str::<Value>(&out).ok())
                .is_some_and(|st| super::update::person_ok(&st, since_ms))
        })
    }

    fn tick_session(&mut self, id: u32, cfg: Option<&ManagedConfig>) -> Result<()> {
        // The recorder already runs: reap it, and look again at its enrollment now and then.
        if let Some(s) = self.sessions.get_mut(&id) {
            if let Some(code) = s.child.as_ref().and_then(Child::exited) {
                let ran = s.started.map(|t| t.elapsed()).unwrap_or_default();
                s.crashes = if ran > Duration::from_secs(300) {
                    0
                } else {
                    s.crashes + 1
                };
                s.state.restarts += 1;
                s.child = None;
                s.state.child_pid = None;
                s.next_attempt = Some(Instant::now() + crate::memory::service::backoff(s.crashes));
                let line =
                    format!("session {id}: the recorder service exited ({code}); restarting");
                self.log(&line);
                return Ok(());
            }
        }
        let due = |s: &Session| s.next_attempt.is_none_or(|t| Instant::now() >= t);
        let token = match session_token(id) {
            Ok(t) => t,
            // No user token (a locked-out or half-open session): try again next tick.
            Err(_) => return Ok(()),
        };
        let (user, sid) = session_user(&token)?;
        let entry = self.sessions.entry(id).or_insert_with(|| Session {
            state: SessionState {
                session_id: id,
                ..Default::default()
            },
            sid: sid.clone(),
            child: None,
            next_attempt: None,
            last_check: None,
            crashes: 0,
            started: None,
            local: false,
        });
        if entry.sid != sid {
            // Someone else signed in to this session id.
            entry.child = None;
            entry.sid = sid.clone();
            entry.next_attempt = None;
            entry.last_check = None;
            entry.state = SessionState {
                session_id: id,
                ..Default::default()
            };
        }
        entry.state.user = user.clone();
        let Some(cfg) = cfg else {
            // No configuration from IT: a personal install. The recorder starts at once,
            // silently, records locally, and syncs only after the person connects.
            if entry.child.is_none() && due(entry) {
                let exe = self.exe.clone();
                let child = spawn_as(&token, &exe, &["service", "run"], None)?;
                let entry = self.sessions.get_mut(&id).unwrap();
                entry.state.child_pid = Some(child.pid);
                entry.child = Some(child);
                entry.started = Some(Instant::now());
                entry.local = true;
                entry.state.detail = None;
            }
            let entry = self.sessions.get_mut(&id).unwrap();
            entry.state.state = "recording".into();
            return Ok(());
        };
        if entry.local {
            // IT's configuration arrived: replace the local recorder with the managed one.
            if let Some(c) = entry.child.take() {
                c.kill();
            }
            entry.local = false;
            entry.state.child_pid = None;
            entry.next_attempt = None;
        }
        let running = entry.child.is_some();
        if running && entry.last_check.is_some_and(|t| t.elapsed() < RECHECK) {
            return Ok(());
        }
        if !running && !due(entry) {
            return Ok(());
        }
        let exe = self.exe.clone();
        let (_, status) = run_as(&token, &exe, &["--json", "sync", "status"], b"")?;
        let status: Value = serde_json::from_str(&status).unwrap_or(Value::Null);
        let entry = self.sessions.get_mut(&id).unwrap();
        entry.last_check = Some(Instant::now());
        if step(&status, cfg) == Step::Enroll {
            let identity = crate::memory::sync::identity(&crate::memory::paths::MemoryPaths::at(
                machine_dir(),
            ));
            let held = run_as(&token, &exe, &["sync", "device-token", "--issuer", &cfg.url], b"")
                .ok()
                .map(|(_, out)| out.trim().to_string())
                .filter(|t| !t.is_empty());
            let answer = issuer::enroll(&cfg.url, &cfg.enrollment_token, &user, &identity, held.as_deref());
            let (state, detail, wait) = after_enrollment(&answer);
            entry.state.state = state.clone();
            entry.state.detail = detail.clone();
            let line = format!(
                "session {id} ({}): enroll → {state} {}",
                user.principal_name.as_deref().unwrap_or(&user.account_name),
                detail.as_deref().unwrap_or("")
            );
            match answer {
                Ok(Enrollment::Enrolled(adoption)) => {
                    let json = serde_json::to_vec(&adoption)?;
                    let (code, out) = run_as(&token, &exe, &["--json", "sync", "adopt"], &json)?;
                    if code != 0 {
                        bail!("sync adopt failed ({code}): {}", out.trim());
                    }
                    let entry = self.sessions.get_mut(&id).unwrap();
                    entry.state.device_id = Some(adoption.device_id);
                    entry.state.next_attempt_at_ms = None;
                    entry.next_attempt = None;
                    self.log(&line);
                }
                _ => {
                    let next = now_ms() + wait.as_millis() as i64;
                    entry.next_attempt = Some(Instant::now() + wait);
                    entry.state.next_attempt_at_ms = Some(next);
                    self.log(&line);
                    // The person (and the Kortix app) sees why nothing records yet.
                    let st = super::EnrollmentState::from_answer(&state, detail, Some(next));
                    if let Err(e) = run_as(
                        &token,
                        &exe,
                        &["--json", "sync", "enrollment-state"],
                        &serde_json::to_vec(&st)?,
                    ) {
                        self.log(&format!("session {id}: could not record the state: {e:#}"));
                    }
                    return Ok(());
                }
            }
        } else {
            entry.state.device_id = status["kortix"]["device_id"].as_str().map(str::to_string);
        }
        let entry = self.sessions.get_mut(&id).unwrap();
        if entry.child.is_none() {
            let child = spawn_as(&token, &exe, &["service", "run", "--managed"], None)?;
            entry.state.child_pid = Some(child.pid);
            entry.child = Some(child);
            entry.started = Some(Instant::now());
            entry.state.state = "recording".into();
            entry.state.detail = None;
            let line = format!(
                "session {id}: recorder service started as {}",
                user.account_name
            );
            self.log(&line);
        } else {
            entry.state.state = "recording".into();
        }
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
        let tmp = state_path().with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&v).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, state_path());
        }
    }
}

/// The owner of `path` as a SID string.
fn owner_sid(path: &Path) -> Result<String> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut owner = PSID::default();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let err = GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut sd,
        );
        if err.0 != 0 {
            bail!("read the owner of {}: error {}", path.display(), err.0);
        }
        let mut s = PWSTR::null();
        let converted = ConvertSidToStringSidW(owner, &mut s);
        let out = if converted.is_ok() { s.to_string().ok() } else { None };
        if !s.is_null() {
            let _ = LocalFree(HLOCAL(s.0.cast()));
        }
        let _ = LocalFree(HLOCAL(sd.0));
        out.context("convert the owner SID")
    }
}

/// Create `%ProgramData%\Kortix\Capture` if it is missing, then refuse to use it (an `Err`)
/// unless SYSTEM or the Administrators group owns it and it is no junction or symlink.
/// The MSI creates both folders with a locked ACL; this check covers a folder a standard
/// user made first, and a repair that never ran.
fn secure_machine_dir() -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    let dir = machine_dir();
    let parent = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone());
    for d in [&parent, &dir] {
        if std::fs::symlink_metadata(d).is_err() {
            std::fs::create_dir(d).with_context(|| format!("create {}", d.display()))?;
        }
        let meta = std::fs::symlink_metadata(d)?;
        let owner = owner_sid(d)?;
        if !machine_dir_trusted(&owner, meta.file_attributes() & REPARSE_POINT != 0) {
            bail!(
                "{} is not used: it is a link or an account other than SYSTEM or Administrators owns it ({owner})",
                d.display()
            );
        }
    }
    Ok(())
}

/// The loop: a tick every 10 s and at once on a logon, until `stop` fires.
fn serve(wake: mpsc::Receiver<bool>) -> Result<()> {
    // Each session's recorder service runs in a kill-on-close job this process
    // holds (`spawn_as`): stopping, uninstalling or killing the service stops
    // recording. Not one job for this process: a job spans one session only.
    let folder_ok = secure_machine_dir();
    if let Err(e) = &folder_ok {
        tracing::error!("machine service: {e:#}");
    } else {
        let _ = std::fs::create_dir_all(machine_dir().join("logs"));
    }
    let mut m = Machine {
        exe: std::env::current_exe()?,
        sessions: BTreeMap::new(),
        log: if folder_ok.is_ok() {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(machine_dir().join("logs").join("machine.log"))
                .ok()
        } else {
            None
        },
        updater: super::update::Updater::new(),
    };
    m.log(&format!(
        "machine service started ({} {})",
        env!("CARGO_PKG_VERSION"),
        m.exe.display()
    ));
    loop {
        // A folder someone else controls can redirect this service's writes: do nothing until it is safe.
        match secure_machine_dir() {
            Ok(()) => m.tick(),
            Err(e) => tracing::error!("machine service: {e:#}"),
        }
        match wake.recv_timeout(TICK) {
            Ok(true) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(false) | Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    for s in m.sessions.values() {
        if let Some(c) = &s.child {
            c.kill();
        }
    }
    m.log("machine service stopped");
    Ok(())
}

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    let (tx, rx) = mpsc::channel::<bool>();
    let handler = move |event| match event {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = tx.send(true);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::SessionChange(_) => {
            let _ = tx.send(false);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let Ok(status) = service_control_handler::register(SERVICE_NAME, handler) else {
        return;
    };
    let report = |state: ServiceState, code: u32| {
        let _ = status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running {
                ServiceControlAccept::STOP
                    | ServiceControlAccept::SHUTDOWN
                    | ServiceControlAccept::SESSION_CHANGE
            } else {
                ServiceControlAccept::empty()
            },
            exit_code: ServiceExitCode::Win32(code),
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        });
    };
    report(ServiceState::Running, 0);
    let code = match serve(rx) {
        Ok(()) => 0,
        Err(_) => 1,
    };
    report(ServiceState::Stopped, code);
}

/// `kortix-capture machine run`: under the Service Control Manager, the
/// service; from a console, the same loop in the foreground until Ctrl-C.
pub fn run() -> Result<()> {
    match service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
        Ok(()) => Ok(()),
        Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1063) => {
            // ERROR_FAILED_SERVICE_CONTROLLER_CONNECT: started from a console.
            let (tx, rx) = mpsc::channel::<bool>();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("runtime");
                rt.block_on(async {
                    let _ = tokio::signal::ctrl_c().await;
                });
                let _ = tx.send(true);
            });
            serve(rx)
        }
        Err(e) => Err(anyhow!("service dispatcher: {e}")),
    }
}
