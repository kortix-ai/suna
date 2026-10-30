//! The Kortix Capture service: records 24/7, across quits, crashes and reboots.
//!
//! `kortix-capture start` installs one OS service per library and turns it on;
//! `stop` turns it off and keeps it off across logins; `service uninstall`
//! removes it. The supervisor is the OS:
//!
//! - macOS: a LaunchAgent `~/Library/LaunchAgents/<label>.plist` (`KeepAlive`,
//!   `RunAtLoad`); `stop` is `launchctl disable` + `bootout`.
//! - Linux: a systemd user unit `~/.config/systemd/user/<label>.service`
//!   (`Restart=always`); `stop` is `systemctl --user disable --now`.
//! - Windows: a Scheduled Task (logon trigger) running a PowerShell loop;
//!   `stop` is `schtasks /Change /DISABLE` + `/End`.
//!
//! The service runs `kortix-capture service run` ([`run`]): it starts the
//! recorder (`record --supervised`) and the action service (`kortix-backend
//! --service`) as its children while they are wanted, restarts them when they
//! exit, and writes `<library>/service.json` as its heartbeat.
//!
//! **The host.** macOS holds the process launchd starts responsible for Screen
//! Recording, Accessibility and the Microphone, and children inherit it. A
//! bare `kortix-capture` would ask for the grants under its own name. An app
//! that bundles the engine passes itself as the host (`--host <app binary>
//! --host-arg … --host-env KEY=VALUE`): launchd starts the host, which runs
//! `<kortix-capture> service run` as its child, so the grants belong to the
//! app. The host is saved in `<library>/service-host.json` and reused by later
//! `start` calls.

use super::paths::MemoryPaths;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub const LABEL_PREFIX: &str = "ai.kortix.capture.service";
const HOST_FILE: &str = "service-host.json";
const HEARTBEAT_FILE: &str = "service.json";
/// Written while `login` rewrites the library's sync settings; the service waits.
pub const SIGN_IN_MARKER: &str = "sign-in.pending";
const SIGN_IN_MAX: Duration = Duration::from_secs(20 * 60);
/// A heartbeat older than this means the service is not running.
const HEARTBEAT_STALE: Duration = Duration::from_secs(90);
const DESCRIPTION: &str = "Kortix Capture";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Macos,
    Linux,
    Windows,
}

impl Os {
    pub fn current() -> Option<Os> {
        match std::env::consts::OS {
            "macos" => Some(Os::Macos),
            "linux" => Some(Os::Linux),
            "windows" => Some(Os::Windows),
            _ => None,
        }
    }
}

/// The program the OS service starts instead of `kortix-capture` itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Host {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// macOS: the host app's bundle id. Login Items and the "can run in the
    /// background" notice then name the app instead of its executable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

/// What the unit runs: `command args…` with `env`.
#[derive(Debug, Clone, PartialEq)]
pub struct Runner {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub bundle_id: Option<String>,
}

/// `exe service run`, or `host.command host.args… exe service run`; the library is always in the env.
pub fn runner(host: Option<&Host>, exe: &Path, library: &Path) -> Runner {
    let exe = exe.to_string_lossy().into_owned();
    let mut env = host.map(|h| h.env.clone()).unwrap_or_default();
    env.insert(
        super::paths::DATA_DIR_ENV.to_string(),
        library.to_string_lossy().into_owned(),
    );
    match host {
        Some(h) => Runner {
            command: h.command.clone(),
            args: h
                .args
                .iter()
                .cloned()
                .chain([exe, "service".into(), "run".into()])
                .collect(),
            env,
            bundle_id: h.bundle_id.clone(),
        },
        None => Runner {
            // The packaged app's own executable is the host: Login Items and the
            // background-activity notice name the app, not the engine file.
            bundle_id: exe
                .contains(".app/Contents/MacOS/")
                .then(|| super::paths::BUNDLE_ID.to_string()),
            command: exe,
            args: vec!["service".into(), "run".into()],
            env,
        },
    }
}

/// This executable is the standalone app (macOS: inside `Kortix Capture.app`; Windows):
/// its per-user service shows the menu-bar / tray icon, the recording indicator. Linux
/// starts its tray from the desktop's autostart entry.
pub fn standalone(exe: &Path) -> bool {
    cfg!(windows)
        || exe
            .to_string_lossy()
            .contains("Kortix Capture.app/Contents/MacOS/")
}

pub fn read_host(paths: &MemoryPaths) -> Option<Host> {
    serde_json::from_slice(&fs::read(paths.root.join(HOST_FILE)).ok()?).ok()
}

pub fn write_host(paths: &MemoryPaths, host: &Host) -> Result<()> {
    write_private(
        &paths.root.join(HOST_FILE),
        &serde_json::to_string_pretty(host)?,
    )
}

/// One library's service: its label, unit file and log directory.
#[derive(Debug, Clone)]
pub struct Unit {
    pub os: Os,
    pub label: String,
    pub path: PathBuf,
    pub log_dir: PathBuf,
    pub home: PathBuf,
}

pub fn unit(os: Os, library: &Path, home: &Path) -> Unit {
    let digest = Sha256::digest(library.to_string_lossy().as_bytes());
    let sha8: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let label = format!("{LABEL_PREFIX}.{sha8}");
    let path = match os {
        Os::Macos => home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{label}.plist")),
        Os::Linux => home
            .join(".config")
            .join("systemd")
            .join("user")
            .join(format!("{label}.service")),
        Os::Windows => library.join("capture-service.ps1"),
    };
    Unit {
        os,
        label,
        path,
        log_dir: library.join("logs"),
        home: home.to_path_buf(),
    }
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The unit file `install` writes for `runner`.
pub fn render(unit: &Unit, runner: &Runner) -> String {
    let out = unit.log_dir.join("capture-service.out.log");
    let err = unit.log_dir.join("capture-service.err.log");
    match unit.os {
        Os::Macos => {
            let args: String = std::iter::once(&runner.command)
                .chain(&runner.args)
                .map(|a| format!("    <string>{}</string>\n", xml(a)))
                .collect();
            let env: String = runner
                .env
                .iter()
                .map(|(k, v)| {
                    format!(
                        "    <key>{}</key>\n    <string>{}</string>\n",
                        xml(k),
                        xml(v)
                    )
                })
                .collect();
            let associated = runner
                .bundle_id
                .as_deref()
                .map(|id| {
                    format!(
                        "  <key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>{}</string>\n  </array>\n",
                        xml(id)
                    )
                })
                .unwrap_or_default();
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}  </array>
{associated}  <key>EnvironmentVariables</key>
  <dict>
{env}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>WorkingDirectory</key>
  <string>{home}</string>
  <key>StandardOutPath</key>
  <string>{out}</string>
  <key>StandardErrorPath</key>
  <string>{err}</string>
</dict>
</plist>
"#,
                label = xml(&unit.label),
                home = xml(&unit.home.to_string_lossy()),
                out = xml(&out.to_string_lossy()),
                err = xml(&err.to_string_lossy()),
            )
        }
        Os::Linux => {
            let exec: Vec<String> = std::iter::once(&runner.command)
                .chain(&runner.args)
                .map(|a| sh_quote(a))
                .collect();
            let env: String = runner
                .env
                .iter()
                .map(|(k, v)| format!("Environment={}\n", sh_quote(&format!("{k}={v}"))))
                .collect();
            format!(
                "[Unit]\nDescription={DESCRIPTION}\n\n[Service]\nType=simple\nUMask=0077\nExecStart={exec}\n{env}Restart=always\nRestartSec=5\nWorkingDirectory={home}\nStandardOutput=append:{out}\nStandardError=append:{err}\n\n[Install]\nWantedBy=default.target\n",
                exec = exec.join(" "),
                home = unit.home.to_string_lossy(),
                out = out.to_string_lossy(),
                err = err.to_string_lossy(),
            )
        }
        Os::Windows => {
            let env: String = runner
                .env
                .iter()
                .map(|(k, v)| format!("$env:{k} = {}\n", ps_quote(v)))
                .collect();
            let args: Vec<String> = runner.args.iter().map(|a| ps_quote(a)).collect();
            format!(
                "$ErrorActionPreference = 'Continue'\n{env}while ($true) {{\n  # The pipe makes PowerShell wait for a GUI-subsystem host binary.\n  & {cmd} {args} *>> {log} | Out-Null\n  Start-Sleep -Seconds 5\n}}\n",
                cmd = ps_quote(&runner.command),
                args = args.join(" "),
                log = ps_quote(&out.to_string_lossy()),
            )
        }
    }
}

/// Task Scheduler's defaults stop a task on battery and after 72 h; this definition does not.
pub fn windows_task_xml(unit: &Unit, user: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>{DESCRIPTION}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>{args}</Arguments></Exec></Actions>
</Task>
"#,
        user = xml(user),
        args = xml(&format!(
            "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
            unit.path.to_string_lossy()
        )),
    )
}

/// The one place a supervisor command (`launchctl`, `systemctl`, `schtasks`) runs. Tests replace it.
pub trait Sys {
    /// `(ok, stdout + stderr)`.
    fn run(&self, program: &str, args: &[String]) -> (bool, String);
    /// The user's launchd domain, `gui/<uid>`.
    fn launchd_domain(&self, unit: &Unit) -> String {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let uid = fs::metadata(&unit.home).map(|m| m.uid()).unwrap_or(501);
            format!("gui/{uid}")
        }
        #[cfg(not(unix))]
        {
            let _ = unit;
            String::new()
        }
    }
}

pub struct RealSys;

impl Sys for RealSys {
    fn run(&self, program: &str, args: &[String]) -> (bool, String) {
        match crate::os_proc::no_window(&mut std::process::Command::new(program))
            .args(args)
            .output()
        {
            Ok(o) => (
                o.status.success(),
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                )
                .trim()
                .to_string(),
            ),
            Err(e) => (false, e.to_string()),
        }
    }
}

fn a(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn write_private(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).with_context(|| format!("failed to write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

/// Writes the unit and starts it (enabled, survives logins).
pub fn install(sys: &dyn Sys, unit: &Unit, runner: &Runner) -> Result<()> {
    fs::create_dir_all(&unit.log_dir)?;
    write_private(&unit.path, &render(unit, runner))?;
    match unit.os {
        Os::Macos => {
            let domain = sys.launchd_domain(unit);
            let plist = unit.path.to_string_lossy().into_owned();
            sys.run("launchctl", &a(&["bootout", &domain, &plist]));
            start(sys, unit)?;
        }
        Os::Linux => {
            sys.run("systemctl", &a(&["--user", "daemon-reload"]));
            let svc = format!("{}.service", unit.label);
            sys.run("systemctl", &a(&["--user", "enable", &svc]));
            sys.run("systemctl", &a(&["--user", "restart", &svc]));
        }
        Os::Windows => {
            let xml_path = unit.path.with_extension("xml");
            let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
                (Ok(d), Ok(u)) => format!("{d}\\{u}"),
                (_, Ok(u)) => u,
                _ => String::new(),
            };
            let text = windows_task_xml(unit, &user);
            // UTF-16 LE with a BOM, as `schtasks /XML` expects.
            let mut bytes = vec![0xFF, 0xFE];
            bytes.extend(text.encode_utf16().flat_map(|c| c.to_le_bytes()));
            fs::write(&xml_path, bytes)?;
            let x = xml_path.to_string_lossy().into_owned();
            let (ok, detail) = sys.run(
                "schtasks.exe",
                &a(&["/Create", "/TN", &unit.label, "/XML", &x, "/F"]),
            );
            anyhow::ensure!(ok, "schtasks /Create failed: {detail}");
            sys.run("schtasks.exe", &a(&["/End", "/TN", &unit.label]));
            sys.run("schtasks.exe", &a(&["/Run", "/TN", &unit.label]));
        }
    }
    Ok(())
}

/// Turns the installed service on now and at every login.
pub fn start(sys: &dyn Sys, unit: &Unit) -> Result<()> {
    match unit.os {
        Os::Macos => {
            let domain = sys.launchd_domain(unit);
            let target = format!("{domain}/{}", unit.label);
            let plist = unit.path.to_string_lossy().into_owned();
            sys.run("launchctl", &a(&["enable", &target]));
            // `bootstrap` right after a `bootout` can fail while launchd tears the
            // old job down; only `print` proves the job is loaded.
            for attempt in 0..3 {
                if attempt > 0 {
                    std::thread::sleep(Duration::from_millis(sys_retry_ms()));
                }
                sys.run("launchctl", &a(&["bootstrap", &domain, &plist]));
                if sys.run("launchctl", &a(&["print", &target])).0 {
                    return Ok(());
                }
            }
            anyhow::bail!("launchd did not load {}", unit.label)
        }
        Os::Linux => {
            let svc = format!("{}.service", unit.label);
            let (ok, detail) = sys.run("systemctl", &a(&["--user", "enable", "--now", &svc]));
            anyhow::ensure!(ok, "systemctl --user enable --now {svc} failed: {detail}");
            Ok(())
        }
        Os::Windows => {
            sys.run(
                "schtasks.exe",
                &a(&["/Change", "/TN", &unit.label, "/ENABLE"]),
            );
            let (ok, detail) = sys.run("schtasks.exe", &a(&["/Run", "/TN", &unit.label]));
            anyhow::ensure!(ok, "schtasks /Run failed: {detail}");
            Ok(())
        }
    }
}

fn sys_retry_ms() -> u64 {
    if cfg!(test) {
        0
    } else {
        1_000
    }
}

/// Stops the service now and leaves it on at login: the next login or `start` (opening
/// the app) runs it again. `stop` keeps it off.
pub fn quit_now(sys: &dyn Sys, unit: &Unit) {
    match unit.os {
        Os::Macos => {
            let domain = sys.launchd_domain(unit);
            sys.run("launchctl", &a(&["bootout", &format!("{domain}/{}", unit.label)]));
        }
        Os::Linux => {
            sys.run("systemctl", &a(&["--user", "stop", &format!("{}.service", unit.label)]));
        }
        Os::Windows => {
            sys.run("schtasks.exe", &a(&["/End", "/TN", &unit.label]));
        }
    }
}

/// Stops the service and keeps it stopped across logins, until `start`.
pub fn stop(sys: &dyn Sys, unit: &Unit) {
    match unit.os {
        Os::Macos => {
            let domain = sys.launchd_domain(unit);
            sys.run(
                "launchctl",
                &a(&["disable", &format!("{domain}/{}", unit.label)]),
            );
            sys.run(
                "launchctl",
                &a(&["bootout", &domain, &unit.path.to_string_lossy()]),
            );
        }
        Os::Linux => {
            sys.run(
                "systemctl",
                &a(&[
                    "--user",
                    "disable",
                    "--now",
                    &format!("{}.service", unit.label),
                ]),
            );
        }
        Os::Windows => {
            sys.run(
                "schtasks.exe",
                &a(&["/Change", "/TN", &unit.label, "/DISABLE"]),
            );
            sys.run("schtasks.exe", &a(&["/End", "/TN", &unit.label]));
        }
    }
}

/// Stops the service and removes its unit.
pub fn uninstall(sys: &dyn Sys, unit: &Unit) -> Result<()> {
    match unit.os {
        Os::Macos => {
            let domain = sys.launchd_domain(unit);
            sys.run(
                "launchctl",
                &a(&["bootout", &domain, &unit.path.to_string_lossy()]),
            );
        }
        Os::Linux => {
            sys.run(
                "systemctl",
                &a(&[
                    "--user",
                    "disable",
                    "--now",
                    &format!("{}.service", unit.label),
                ]),
            );
        }
        Os::Windows => {
            sys.run("schtasks.exe", &a(&["/End", "/TN", &unit.label]));
            sys.run("schtasks.exe", &a(&["/Delete", "/TN", &unit.label, "/F"]));
            let _ = fs::remove_file(unit.path.with_extension("xml"));
        }
    }
    match fs::remove_file(&unit.path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => {
            if unit.os == Os::Linux {
                sys.run("systemctl", &a(&["--user", "daemon-reload"]));
            }
            Ok(())
        }
    }
}

/// Installed, loaded (`active`), on at login (`enabled`), and whether the unit
/// is exactly what `install` would write now (`up_to_date: false` after the
/// engine or its host moved: `start` rewrites it).
pub fn unit_status(sys: &dyn Sys, unit: &Unit, runner: &Runner) -> Value {
    let on_disk = fs::read_to_string(&unit.path).ok();
    let installed = on_disk.is_some();
    let (active, enabled) = if !installed {
        (false, false)
    } else {
        match unit.os {
            Os::Macos => {
                let domain = sys.launchd_domain(unit);
                let active = sys
                    .run(
                        "launchctl",
                        &a(&["print", &format!("{domain}/{}", unit.label)]),
                    )
                    .0;
                let disabled = sys.run("launchctl", &a(&["print-disabled", &domain])).1;
                let off = disabled.contains(&format!("\"{}\" => disabled", unit.label))
                    || disabled.contains(&format!("\"{}\" => true", unit.label));
                (active, !off)
            }
            Os::Linux => {
                let svc = format!("{}.service", unit.label);
                (
                    sys.run("systemctl", &a(&["--user", "is-active", &svc])).0,
                    sys.run("systemctl", &a(&["--user", "is-enabled", &svc])).0,
                )
            }
            Os::Windows => {
                let (ok, state) = sys.run(
                    "powershell.exe",
                    &a(&[
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "(Get-ScheduledTask -TaskName {} -ErrorAction Stop).State",
                            ps_quote(&unit.label)
                        ),
                    ]),
                );
                let state = if ok {
                    state.trim().to_string()
                } else {
                    String::new()
                };
                (state == "Running", state != "Disabled")
            }
        }
    };
    json!({
        "label": unit.label,
        "path": unit.path,
        "installed": installed,
        "active": active,
        "enabled": enabled,
        "up_to_date": on_disk.as_deref() == Some(render(unit, runner).as_str()),
    })
}

/// `<library>/service.json`, with `running` false when stale.
pub fn heartbeat(paths: &MemoryPaths) -> Value {
    let file = paths.root.join(HEARTBEAT_FILE);
    let fresh = fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < HEARTBEAT_STALE);
    let mut v: Value = fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    v["running"] = json!(fresh);
    v
}

pub fn sign_in_pending(paths: &MemoryPaths) -> bool {
    fs::metadata(paths.root.join(SIGN_IN_MARKER))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < SIGN_IN_MAX)
}

/// What the service runs now. A personal library records while the service is on,
/// whatever its sync does (signed in, signed out, expired, off, S3). The operator
/// policy's `recording.paused` and layers narrow it elsewhere; its `actions` layer
/// decides the action recorder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Want {
    pub recorder: bool,
    pub actions: bool,
}

pub fn want(sync_status: &Value, _pending: bool, have_backend: bool) -> Want {
    // Recording does not depend on sync: a signed-out, expired, or never-connected library
    // records locally, and a sign-in in progress (onboarding) does not pause it. Only a
    // library the organization manages is gated by its enrollment ([`want_managed`]).
    let recorder = true;
    let actions_layer = sync_status["policy"]["policy"]["layers"]["actions"] != false;
    Want {
        recorder,
        actions: recorder && have_backend && actions_layer,
    }
}

/// [`want`] for a library the organization manages (`service run --managed`,
/// started by the machine service): nothing records while its enrollment is
/// missing or refused, whatever its settings say. The tray runs with the recorder.
pub fn want_managed(sync_status: &Value, pending: bool, have_backend: bool) -> Want {
    let enrolled = sync_status["kortix"]["signed_in"] == true
        && sync_status["kortix"]["sign_in_required"] != true;
    if enrolled {
        want(sync_status, pending, have_backend)
    } else {
        Want::default()
    }
}

/// The permission keys macOS reports granted in `permissions --json`.
pub fn granted(permissions: &Value) -> Vec<String> {
    ["screen", "accessibility", "microphone", "input_monitoring"]
        .iter()
        .filter(|k| permissions[**k] == true || permissions[**k] == "granted")
        .map(|k| k.to_string())
        .collect()
}

/// Restart backoff: 2 s doubling to 60 s.
pub fn backoff(crashes: u32) -> Duration {
    Duration::from_secs((2u64 << crashes.min(5)).min(60))
}

// ─── The service process ───────────────────────────────────────────────────

struct Slot {
    name: &'static str,
    child: Option<tokio::process::Child>,
    /// The recorder's stdin: it ends when this process ends (`record --supervised`).
    stdin: Option<tokio::process::ChildStdin>,
    crashes: u32,
    started: Option<Instant>,
    not_before: Option<Instant>,
    last_exit: Option<String>,
}

impl Slot {
    fn new(name: &'static str) -> Self {
        Slot {
            name,
            child: None,
            stdin: None,
            crashes: 0,
            started: None,
            not_before: None,
            last_exit: None,
        }
    }

    fn view(&self) -> Value {
        json!({
            "running": self.child.is_some(),
            "pid": self.child.as_ref().and_then(|c| c.id()),
            "crashes": self.crashes,
            "last_exit": self.last_exit,
        })
    }

    fn reap(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        // Every exit restarts, exit 0 too: macOS quits the tray (exit 0) when a person
        // changes one of its privacy permissions. "Quit" stops this service itself instead.
        if let Ok(Some(status)) = child.try_wait() {
            self.last_exit = Some(status.to_string());
            self.child = None;
            self.stdin = None;
            let ran = self.started.map(|s| s.elapsed()).unwrap_or_default();
            self.crashes = if ran > Duration::from_secs(300) {
                0
            } else {
                self.crashes + 1
            };
            self.not_before = Some(Instant::now() + backoff(self.crashes));
            tracing::warn!("[service] {} exited: {status}", self.name);
        }
    }

    async fn stop(&mut self) {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
            }
            if tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }
    }
}

fn spawn_logged(
    log_dir: &Path,
    name: &str,
    program: &Path,
    args: &[&str],
    stdin_pipe: bool,
) -> Result<tokio::process::Child> {
    fs::create_dir_all(log_dir)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(format!("{name}.log")))?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdout(log.try_clone()?)
        .stderr(log)
        .stdin(if stdin_pipe {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::os_proc::CREATE_NO_WINDOW);
    crate::os_proc::die_with_parent(&mut cmd);
    Ok(cmd.spawn()?)
}

fn self_json(exe: &Path, args: &[&str]) -> Value {
    crate::os_proc::no_window(&mut std::process::Command::new(exe))
        .arg("--json")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or(Value::Null)
}

/// `kortix-capture service run`: the service itself. Returns on SIGTERM / Ctrl-C.
/// `managed`: started by the machine service ([`want_managed`]; Kortix sync
/// stays on; the tray shows the notice while recording).
pub fn run(paths: &MemoryPaths, exe: &Path, managed: bool) -> Result<()> {
    run_with(paths, exe, managed, None).map(|_| ())
}

/// [`run`], and with `watch_config` (the agent) it returns `Ok(true)` when the answer of
/// that function changes: the organization's configuration appeared or went away, so the
/// caller starts the service again in the other mode.
pub fn run_with(
    paths: &MemoryPaths,
    exe: &Path,
    managed: bool,
    watch_config: Option<&dyn Fn() -> bool>,
) -> Result<bool> {
    // A library from the control-plane era becomes Sync Off before anything syncs.
    super::legacy::migrate_legacy_settings(paths);
    // The previous service was killed: its recorder is an orphan that drains and holds the
    // library. End it now so this service's recorder starts at once.
    #[cfg(unix)]
    reap_orphan_recorder(paths);
    // The recorders it starts inherit the class: the person's apps win the CPU.
    crate::os_proc::below_normal_priority();
    fs::create_dir_all(&paths.root)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.root.join("service.lock"))?;
    if lock.try_lock().is_err() {
        println!("another Kortix Capture service runs this library");
        return Ok(false);
    }
    // A hard kill of this supervisor (Task Manager, Stop-Process -Force, the
    // scheduled task ending, kill -9) must take the recorders along: the action
    // recorder's stdin is not tied to this process. Windows: a job object here;
    // Linux: each child gets a parent-death signal (`die_with_parent`).
    crate::os_proc::kill_children_on_exit();
    let tick = Duration::from_secs(30);
    let probe_every = Duration::from_secs(600);
    let backend = exe.with_file_name(if cfg!(windows) {
        "kortix-backend.exe"
    } else {
        "kortix-backend"
    });
    let log_dir = paths.root.join("logs");
    let started_at = chrono::Utc::now().to_rfc3339();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut config_changed = false;
    rt.block_on(async {
        let mut recorder = Slot::new("recorder");
        let mut actions = Slot::new("actions");
        let mut tray = Slot::new("tray");
        let mut last_granted: Option<Vec<String>> = None;
        let mut last_probe: Option<(Instant, Value)> = None;
        let mut shutdown = Box::pin(shutdown_signal());
        loop {
            recorder.reap();
            actions.reap();
            tray.reap();
            if watch_config.is_some_and(|f| f() != managed) {
                config_changed = true;
                break;
            }
            if managed {
                super::managed::keep_sync_on(paths);
            }
            let sync = super::cli::sync_status_value(paths);
            let w = if managed {
                want_managed(&sync, sign_in_pending(paths), backend.exists())
            } else {
                want(&sync, sign_in_pending(paths), backend.exists())
            };
            if cfg!(target_os = "macos") && w.recorder {
                // Once per library: the system prompts for Screen Recording and
                // Accessibility, named for this app. The person approves them
                // (an MDM profile can pre-grant Accessibility and Input Monitoring).
                let asked = paths.root.join("permissions-requested");
                if !asked.exists() {
                    let _ = fs::write(&asked, b"");
                    let _ = std::process::Command::new(exe)
                        .args(["permissions", "--request"])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                }
            }
            if cfg!(target_os = "macos") {
                // macOS applies a new grant only to a process started after it.
                let now = granted(&self_json(exe, &["permissions"]));
                if last_granted
                    .as_ref()
                    .is_some_and(|before| now.iter().any(|k| !before.contains(k)))
                {
                    recorder.stop().await;
                    actions.stop().await;
                }
                last_granted = Some(now);
            }
            for (slot, wanted, program, args, pipe) in [
                (
                    &mut recorder,
                    w.recorder,
                    exe,
                    &["record", "--supervised"][..],
                    true,
                ),
                (
                    &mut actions,
                    w.actions,
                    backend.as_path(),
                    &["--service"][..],
                    false,
                ),
                (
                    &mut tray,
                    super::managed::TRAY_AVAILABLE
                        && if managed { w.recorder } else { standalone(exe) },
                    exe,
                    &["tray"][..],
                    false,
                ),
            ] {
                if !wanted {
                    slot.stop().await;
                    slot.crashes = 0;
                    slot.not_before = None;
                } else if slot.child.is_none()
                    && slot.not_before.is_none_or(|t| Instant::now() >= t)
                {
                    match spawn_logged(&log_dir, slot.name, program, args, pipe) {
                        Ok(mut child) => {
                            slot.stdin = child.stdin.take();
                            slot.child = Some(child);
                            slot.started = Some(Instant::now());
                        }
                        Err(e) => {
                            slot.last_exit = Some(format!("spawn failed: {e}"));
                            slot.crashes += 1;
                            slot.not_before = Some(Instant::now() + backoff(slot.crashes));
                        }
                    }
                }
            }
            // While recording, fetch fresh credentials every 10 min: a revoked
            // device is refused, and the next tick stops the recorder.
            if recorder.child.is_some()
                && last_probe
                    .as_ref()
                    .is_none_or(|(t, _)| t.elapsed() >= probe_every)
            {
                let ok = crate::os_proc::no_window(&mut std::process::Command::new(exe))
                    .args(["sync", "test"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success());
                last_probe = Some((
                    Instant::now(),
                    json!({ "at": chrono::Utc::now().to_rfc3339(), "ok": ok }),
                ));
            }
            // Kortix reads "is this device recording actions" from status.json, which reads this.
            super::actions::write_heartbeat(
                paths,
                actions.child.is_some(),
                (w.recorder && !w.actions).then_some("policy_off"),
            );
            let beat = json!({
                "pid": std::process::id(),
                "started_at": started_at,
                "updated_at": chrono::Utc::now().to_rfc3339(),
                "recorder": recorder.view(),
                "actions": actions.view(),
                "tray": tray.view(),
                "managed": managed,
                "granted": last_granted,
                "last_probe": last_probe.as_ref().map(|(_, v)| v.clone()),
            });
            let _ = write_private(&paths.root.join(HEARTBEAT_FILE), &beat.to_string());
            // A recorder that should run and does not (the agent just restarted while the old
            // recorder drained, or a crash backoff): look again in 3 s, not after the 30 s tick.
            let hurry = (w.recorder && recorder.child.is_none())
                || (w.actions && actions.child.is_none());
            let wait = if hurry { Duration::from_secs(3) } else { tick };
            tokio::select! {
                _ = &mut shutdown => break,
                _ = tokio::time::sleep(wait) => {}
            }
        }
        recorder.stop().await;
        actions.stop().await;
        tray.stop().await;
        let _ = fs::remove_file(paths.root.join(HEARTBEAT_FILE));
        let _ = fs::remove_file(super::actions::heartbeat_path(paths));
    });
    Ok(config_changed)
}

/// An earlier service died (kill -9, a crash): its recorder, reparented to init, is still finishing
/// its last chunk. Ask it to stop and wait a few seconds, so the restarted service records again
/// within seconds, not after the orphan's drain.
#[cfg(unix)]
fn reap_orphan_recorder(paths: &MemoryPaths) {
    let Some(st) = super::recorder::RecorderStatus::read(paths) else { return };
    let pid = st.pid as i32;
    if pid <= 1 || unsafe { libc::kill(pid, 0) } != 0 {
        return;
    }
    let ppid = std::process::Command::new("/bin/ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i32>().ok());
    if ppid != Some(1) {
        return; // it belongs to a live service
    }
    tracing::warn!("[service] ending the orphan recorder {pid} of a killed service");
    unsafe { libc::kill(pid, libc::SIGTERM) };
    for _ in 0..50 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeSys {
        calls: RefCell<Vec<String>>,
        /// `launchctl print` succeeds (the job is loaded).
        loaded: bool,
    }

    impl Sys for FakeSys {
        fn run(&self, program: &str, args: &[String]) -> (bool, String) {
            let line = format!("{program} {}", args.join(" "));
            self.calls.borrow_mut().push(line.clone());
            if line.starts_with("launchctl print-disabled") {
                return (true, String::new());
            }
            if line.starts_with("launchctl print ") {
                return (self.loaded, String::new());
            }
            (true, String::new())
        }
        fn launchd_domain(&self, _unit: &Unit) -> String {
            "gui/501".into()
        }
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-service-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn host() -> Host {
        Host {
            command: "/Applications/Kortix.app/Contents/MacOS/Kortix".into(),
            args: vec!["-e".into(), "require('x')".into()],
            env: BTreeMap::from([("ELECTRON_RUN_AS_NODE".into(), "1".into())]),
            bundle_id: Some("com.kortix.app".into()),
        }
    }

    #[test]
    fn the_host_runs_the_engine_as_its_child_with_the_library_in_the_env() {
        let lib = Path::new("/lib/a");
        let exe = Path::new("/App/Resources/capture/kortix-capture");
        let r = runner(Some(&host()), exe, lib);
        assert_eq!(r.command, "/Applications/Kortix.app/Contents/MacOS/Kortix");
        assert_eq!(
            r.args,
            [
                "-e",
                "require('x')",
                "/App/Resources/capture/kortix-capture",
                "service",
                "run"
            ]
        );
        assert_eq!(r.env["ELECTRON_RUN_AS_NODE"], "1");
        assert_eq!(r.env["KORTIX_CAPTURE_DIR"], "/lib/a");
        let bare = runner(None, exe, lib);
        assert_eq!(bare.command, "/App/Resources/capture/kortix-capture");
        assert_eq!(bare.args, ["service", "run"]);
        assert_eq!(bare.bundle_id, None);
    }

    #[test]
    fn the_packaged_app_is_its_own_host_and_shows_the_tray() {
        let app = Path::new("/Applications/Kortix Capture.app/Contents/MacOS/Kortix Capture");
        let r = runner(None, app, Path::new("/lib/a"));
        assert_eq!(r.command, app.to_string_lossy());
        assert_eq!(r.bundle_id.as_deref(), Some("ai.kortix.capture"));
        assert!(standalone(app));
        assert!(!standalone(Path::new("/usr/bin/kortix-capture")));
        assert!(!standalone(Path::new(
            "/Applications/Kortix.app/Contents/Resources/capture/kortix-capture"
        )));
    }

    #[test]
    fn one_label_per_library() {
        let home = Path::new("/home/u");
        let a = unit(Os::Macos, Path::new("/lib/a"), home);
        let b = unit(Os::Macos, Path::new("/lib/b"), home);
        assert!(a.label.starts_with("ai.kortix.capture.service."));
        assert_ne!(a.label, b.label);
        assert_eq!(
            a.path,
            home.join(format!("Library/LaunchAgents/{}.plist", a.label))
        );
        assert_eq!(
            unit(Os::Linux, Path::new("/lib/a"), home).path,
            home.join(format!(".config/systemd/user/{}.service", a.label))
        );
        assert_eq!(
            unit(Os::Windows, Path::new("/lib/a"), home).path,
            Path::new("/lib/a/capture-service.ps1")
        );
    }

    #[test]
    fn the_launch_agent_runs_the_host_directly_keeps_alive_and_escapes() {
        let u = unit(Os::Macos, Path::new("/lib/a&b"), Path::new("/Users/u"));
        let p = render(
            &u,
            &runner(
                Some(&host()),
                Path::new("/x/kortix-capture"),
                Path::new("/lib/a&b"),
            ),
        );
        assert!(p.contains("<string>/Applications/Kortix.app/Contents/MacOS/Kortix</string>\n    <string>-e</string>\n    <string>require(&apos;x&apos;)</string>\n    <string>/x/kortix-capture</string>\n    <string>service</string>\n    <string>run</string>"));
        assert!(p.contains("<key>KORTIX_CAPTURE_DIR</key>\n    <string>/lib/a&amp;b</string>"));
        assert!(p.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(!p.contains("/bin/sh"));
    }

    #[test]
    fn the_launch_agent_names_the_host_app_in_login_items() {
        let u = unit(Os::Macos, Path::new("/lib/a"), Path::new("/Users/u"));
        let exe = Path::new("/x/kortix-capture");
        let named = render(&u, &runner(Some(&host()), exe, Path::new("/lib/a")));
        assert!(named.contains(
            "<key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>com.kortix.app</string>\n  </array>"
        ));
        let bare = render(&u, &runner(None, exe, Path::new("/lib/a")));
        assert!(!bare.contains("AssociatedBundleIdentifiers"));
        let saved: Host = serde_json::from_str(r#"{"command":"/k"}"#).unwrap();
        assert_eq!(
            saved.bundle_id, None,
            "a host saved before bundle ids still loads"
        );
    }

    #[test]
    fn the_systemd_unit_quotes_every_argument() {
        let u = unit(Os::Linux, Path::new("/lib/it's"), Path::new("/home/u"));
        let s = render(
            &u,
            &runner(
                None,
                Path::new("/opt/kortix capture/kortix-capture"),
                Path::new("/lib/it's"),
            ),
        );
        assert!(s.contains("ExecStart='/opt/kortix capture/kortix-capture' 'service' 'run'"));
        assert!(s.contains(r"Environment='KORTIX_CAPTURE_DIR=/lib/it'\''s'"));
        assert!(s.contains("Restart=always"));
    }

    #[test]
    fn the_windows_loop_restarts_the_host() {
        let u = unit(Os::Windows, Path::new("C:/lib"), Path::new("C:/Users/u"));
        let s = render(
            &u,
            &runner(
                Some(&host()),
                Path::new("C:/k/kortix-capture.exe"),
                Path::new("C:/lib"),
            ),
        );
        assert!(s.contains("$env:ELECTRON_RUN_AS_NODE = '1'"));
        assert!(s.contains("& '/Applications/Kortix.app/Contents/MacOS/Kortix' '-e' 'require(''x'')' 'C:/k/kortix-capture.exe' 'service' 'run'"));
        assert!(windows_task_xml(&u, "DOM\\me").contains("<UserId>DOM\\me</UserId>"));
    }

    #[test]
    fn install_writes_a_private_unit_and_loads_it_start_and_stop_survive_logins() {
        let home = scratch();
        let lib = home.join("lib");
        let u = unit(Os::Macos, &lib, &home);
        let r = runner(Some(&host()), Path::new("/x/kortix-capture"), &lib);
        let sys = FakeSys {
            loaded: true,
            ..Default::default()
        };
        install(&sys, &u, &r).unwrap();
        assert_eq!(fs::read_to_string(&u.path).unwrap(), render(&u, &r));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&u.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let plist = u.path.to_string_lossy().to_string();
        let target = format!("gui/501/{}", u.label);
        assert_eq!(
            *sys.calls.borrow(),
            [
                format!("launchctl bootout gui/501 {plist}"),
                format!("launchctl enable {target}"),
                format!("launchctl bootstrap gui/501 {plist}"),
                format!("launchctl print {target}"),
            ]
        );
        let st = unit_status(&sys, &u, &r);
        assert_eq!(
            (
                st["installed"].clone(),
                st["active"].clone(),
                st["enabled"].clone(),
                st["up_to_date"].clone()
            ),
            (json!(true), json!(true), json!(true), json!(true))
        );
        // The engine moved (an app update): the unit is stale until `start` rewrites it.
        let moved = runner(Some(&host()), Path::new("/y/kortix-capture"), &lib);
        assert_eq!(unit_status(&sys, &u, &moved)["up_to_date"], false);

        sys.calls.borrow_mut().clear();
        stop(&sys, &u);
        assert_eq!(
            *sys.calls.borrow(),
            [
                format!("launchctl disable {target}"),
                format!("launchctl bootout gui/501 {plist}")
            ]
        );

        uninstall(&sys, &u).unwrap();
        assert!(!u.path.exists());
        assert_eq!(unit_status(&sys, &u, &r)["installed"], false);
    }

    #[test]
    fn start_fails_when_launchd_never_loads_the_job() {
        let home = scratch();
        let u = unit(Os::Macos, &home.join("lib"), &home);
        let sys = FakeSys::default();
        assert!(install(
            &sys,
            &u,
            &runner(None, Path::new("/x/kc"), &home.join("lib"))
        )
        .is_err());
        assert_eq!(
            sys.calls
                .borrow()
                .iter()
                .filter(|c| c.starts_with("launchctl bootstrap"))
                .count(),
            3
        );
    }

    #[test]
    fn linux_install_enables_and_restarts_the_user_unit() {
        let home = scratch();
        let u = unit(Os::Linux, &home.join("lib"), &home);
        let sys = FakeSys::default();
        install(
            &sys,
            &u,
            &runner(None, Path::new("/x/kc"), &home.join("lib")),
        )
        .unwrap();
        let svc = format!("{}.service", u.label);
        assert_eq!(
            *sys.calls.borrow(),
            [
                "systemctl --user daemon-reload".to_string(),
                format!("systemctl --user enable {svc}"),
                format!("systemctl --user restart {svc}"),
            ]
        );
    }

    #[test]
    fn a_personal_library_records_whatever_its_sync_does() {
        let signed = json!({ "provider": "kortix", "kortix": { "signed_in": true, "sign_in_required": false } });
        assert_eq!(want(&signed, false, true), Want { recorder: true, actions: true });
        // A sign-in in progress (onboarding) never pauses the recording.
        assert!(want(&signed, true, true).recorder);
        // An expired sign-in, a signed-out library whose provider is still kortix, a fresh one:
        // sync stops or waits, the recording goes on.
        let revoked = json!({ "provider": "kortix", "kortix": { "signed_in": false, "sign_in_required": true } });
        assert!(want(&revoked, false, true).recorder);
        let never = json!({ "provider": "kortix", "kortix": { "signed_in": false, "sign_in_required": false } });
        assert!(want(&never, false, true).recorder);
        let local = json!({ "provider": "s3", "kortix": { "signed_in": false, "sign_in_required": false } });
        assert_eq!(
            want(&local, false, false),
            Want { recorder: true, actions: false },
            "no backend binary, no actions"
        );
        let no_actions = json!({ "provider": "kortix", "kortix": { "signed_in": true }, "policy": { "policy": { "layers": { "actions": false } } } });
        assert_eq!(want(&no_actions, false, true), Want { recorder: true, actions: false });
    }

    #[test]
    fn a_managed_library_records_only_while_its_enrollment_stands() {
        // A fresh library (no settings, local provider) records unmanaged, never managed.
        let fresh = json!({ "provider": "s3", "kortix": { "signed_in": false, "sign_in_required": false } });
        assert!(want(&fresh, false, true).recorder);
        assert_eq!(want_managed(&fresh, false, true), Want::default());
        let refused = json!({ "provider": "kortix", "kortix": { "signed_in": false, "sign_in_required": true } });
        assert_eq!(want_managed(&refused, false, true), Want::default());
        let enrolled = json!({ "provider": "kortix", "kortix": { "signed_in": true, "sign_in_required": false } });
        assert_eq!(
            want_managed(&enrolled, false, true),
            Want {
                recorder: true,
                actions: true
            }
        );
        let off = json!({ "provider": "kortix", "kortix": { "signed_in": true }, "policy": { "policy": { "layers": { "actions": false } } } });
        assert_eq!(
            want_managed(&off, false, true),
            Want {
                recorder: true,
                actions: false
            },
            "the policy still decides the layers"
        );
    }

    #[test]
    fn grants_backoff_and_the_heartbeat() {
        assert_eq!(
            granted(&json!({ "screen": "granted", "accessibility": true, "microphone": "denied" })),
            ["screen", "accessibility"]
        );
        assert_eq!(backoff(0), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(16));
        assert_eq!(backoff(9), Duration::from_secs(60));
        let lib = scratch();
        let paths = MemoryPaths::at(&lib);
        assert_eq!(heartbeat(&paths)["running"], false);
        fs::write(lib.join(HEARTBEAT_FILE), r#"{"pid":7}"#).unwrap();
        assert_eq!(heartbeat(&paths), json!({ "pid": 7, "running": true }));
        assert!(!sign_in_pending(&paths));
        fs::write(lib.join(SIGN_IN_MARKER), "").unwrap();
        assert!(sign_in_pending(&paths));
        write_host(&paths, &host()).unwrap();
        assert_eq!(read_host(&paths), Some(host()));
    }
}
