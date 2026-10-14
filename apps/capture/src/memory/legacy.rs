//! Leftovers of earlier installs. An old per-user tray agent, a per-user service unit
//! that the system agent now supersedes, or a copy from another app bundle keeps a second
//! recorder or tray alive (and a unit that exits at once restarts every 10 s). The pkg
//! `preinstall` (as root, for every user) and the app at launch (as the person) remove
//! them. The person's library is never touched.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The launchd label of a per-user agent an earlier build installed and this one supersedes:
/// the old tray, and every per-library service unit (the system agent records now).
pub fn is_legacy_agent_label(label: &str) -> bool {
    label == "ai.kortix.capture.tray" || label.starts_with("ai.kortix.capture.service.")
}

/// Processes of a Kortix Capture copy that is not `current_app`: the old tray (`kortix-tray`),
/// and a recorder or service started from another bundle. `ps_output` is `ps -axo pid=,command=`.
pub fn legacy_pids(ps_output: &str, current_app: &str, own_pid: u32) -> Vec<u32> {
    ps_output
        .lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let (pid, cmd) = l.split_once(char::is_whitespace)?;
            let pid: u32 = pid.parse().ok()?;
            let cmd = cmd.trim_start();
            let old_tray = cmd.contains("/Contents/MacOS/kortix-tray");
            let other_bundle = cmd.contains("Kortix Capture")
                && cmd.contains(".app/Contents/MacOS/")
                && !cmd.starts_with(current_app)
                && (cmd.contains(" record --supervised") || cmd.contains(" service run"));
            (pid != own_pid && (old_tray || other_bundle)).then_some(pid)
        })
        .collect()
}

/// Names of `reg query ...\Run` values that belong to an earlier Kortix Capture install:
/// a Kortix name whose command does not run `current_exe`.
pub fn legacy_run_values(reg_query: &str, current_exe: &str) -> Vec<String> {
    let cur = current_exe.to_lowercase();
    reg_query
        .lines()
        .filter_map(|l| {
            // `    <name>    REG_SZ    <data>`: a name may hold spaces, so cut at the type.
            let (i, ty) = [" REG_SZ ", " REG_EXPAND_SZ "]
                .iter()
                .find_map(|t| l.find(t).map(|i| (i, *t)))?;
            let name = l[..i].trim();
            let data = l[i + ty.len()..].trim().to_lowercase();
            let n = name.to_lowercase();
            (!name.is_empty() && (n.contains("kortix") || n.contains("capture")) && !data.contains(&cur))
                .then(|| name.to_string())
        })
        .collect()
}

/// Scheduled task names (`schtasks /Query /FO CSV /NH` first column) of the old tray and service.
pub fn legacy_task_names(csv: &str) -> Vec<String> {
    csv.lines()
        .filter_map(|l| l.split("\",\"").next().map(|f| f.trim_matches('"').trim_start_matches('\\').to_string()))
        .filter(|n| {
            let n = n.to_lowercase();
            n.starts_with("kortix capture tray") || n.starts_with("kortix capture service")
        })
        .collect()
}

/// Keys the retired 0.2.x control-plane sync wrote into `settings.json`.
const LEGACY_SETTINGS_KEYS: [&str; 8] = [
    "control_plane",
    "controlPlane",
    "control_plane_url",
    "dashboard_url",
    "enrolled_url",
    "api_url",
    "memory_api",
    "memory_api_url",
];

/// `settings.json` still carries the retired control-plane sync: one of its keys, or its endpoint.
pub fn has_legacy_sync(raw: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let top = v.as_object();
    let sync = v.get("sync").and_then(Value::as_object);
    [top, sync]
        .into_iter()
        .flatten()
        .any(|o| LEGACY_SETTINGS_KEYS.iter().any(|k| o.contains_key(*k)))
        || raw.contains("/api/agent/memory")
}

/// A library from 0.2.x holds control-plane sync settings and a sign-in at that retired server.
/// Turn sync Off (the recordings stay), drop those keys and forget that sign-in, so nothing
/// calls the retired endpoint and the window does not ask to sign in again. Runs once: the
/// keys are gone after it. Returns true when it changed the library.
pub fn migrate_legacy_settings(paths: &crate::memory::paths::MemoryPaths) -> bool {
    use crate::memory::settings::Settings;
    let Ok(raw) = std::fs::read_to_string(paths.settings()) else {
        return false;
    };
    if !has_legacy_sync(&raw) {
        return false;
    }
    let mut s = Settings::load(paths);
    for k in LEGACY_SETTINGS_KEYS {
        s.extra.remove(k);
    }
    s.sync.enabled = false;
    if s.sync.provider == "kortix" {
        s.sync.provider = "s3".into();
    }
    crate::memory::sync::issuer::sign_out(paths);
    let saved = s.save(paths).is_ok();
    tracing::info!("[legacy] control-plane sync settings replaced by Sync Off ({saved})");
    saved
}

/// Remove what an earlier install left for this person. Returns what it removed.
pub fn remove_legacy() -> Value {
    let mut removed: Vec<String> = Vec::new();
    #[cfg(target_os = "macos")]
    macos_leftovers(&mut removed);
    #[cfg(target_os = "linux")]
    linux_leftovers(&mut removed);
    #[cfg(windows)]
    windows_leftovers(&mut removed);
    if !removed.is_empty() {
        tracing::info!("[legacy] removed {removed:?}");
    }
    json!({ "removed": removed })
}

fn home() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    let o = crate::os_proc::no_window(&mut c).output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn macos_leftovers(removed: &mut Vec<String>) {
    let uid = unsafe { libc::getuid() };
    if let Some(dir) = home().map(|h| h.join("Library/LaunchAgents")) {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(label) = name.strip_suffix(".plist") else { continue };
            if is_legacy_agent_label(label) {
                run("/bin/launchctl", &["bootout", &format!("gui/{uid}/{label}")]);
                if std::fs::remove_file(e.path()).is_ok() {
                    removed.push(name);
                }
            }
        }
    }
    let current = "/Applications/Kortix Capture.app/";
    if let Some(ps) = run("/bin/ps", &["-axo", "pid=,command="]) {
        for pid in legacy_pids(&ps, current, std::process::id()) {
            run("/bin/kill", &[&pid.to_string()]);
            removed.push(format!("process {pid}"));
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_leftovers(removed: &mut Vec<String>) {
    let Some(h) = home() else { return };
    for (dir, ext) in [(h.join(".config/systemd/user"), ".service"), (h.join(".config/autostart"), ".desktop")] {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ours = name.starts_with("kortix-capture") && name.ends_with(ext)
                || name.starts_with("ai.kortix.capture.service.") && name.ends_with(ext);
            if ours {
                if ext == ".service" {
                    run("systemctl", &["--user", "disable", "--now", &name]);
                }
                if std::fs::remove_file(e.path()).is_ok() {
                    removed.push(name);
                }
            }
        }
    }
}

#[cfg(windows)]
fn windows_leftovers(removed: &mut Vec<String>) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if let Some(q) = run("reg.exe", &["query", key]) {
        for name in legacy_run_values(&q, &exe) {
            run("reg.exe", &["delete", key, "/v", &name, "/f"]);
            removed.push(format!("Run: {name}"));
        }
    }
    if let Some(csv) = run("schtasks.exe", &["/Query", "/FO", "CSV", "/NH"]) {
        for name in legacy_task_names(&csv) {
            run("schtasks.exe", &["/End", "/TN", &name]);
            run("schtasks.exe", &["/Delete", "/TN", &name, "/F"]);
            removed.push(format!("task: {name}"));
        }
    }
}

/// A system agent (installed by the pkg or the deb) records in the background for every
/// person; the app starts that agent instead of adding a per-user service beside it.
pub fn system_agent_installed() -> bool {
    Path::new("/Library/LaunchAgents/ai.kortix.capture.agent.plist").exists()
        || Path::new("/usr/lib/systemd/user/kortix-capture.service").exists()
}

/// Start the system agent for this person (a no-op when it already runs).
pub fn start_system_agent() -> bool {
    #[cfg(target_os = "macos")]
    {
        let uid = unsafe { libc::getuid() };
        let target = format!("gui/{uid}/ai.kortix.capture.agent");
        run("/bin/launchctl", &["bootstrap", &format!("gui/{uid}"), "/Library/LaunchAgents/ai.kortix.capture.agent.plist"]);
        run("/bin/launchctl", &["kickstart", &target]);
        true
    }
    #[cfg(target_os = "linux")]
    {
        run("systemctl", &["--user", "start", "kortix-capture.service"]);
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_old_tray_and_service_units_are_legacy_the_system_agent_is_not() {
        assert!(is_legacy_agent_label("ai.kortix.capture.tray"));
        assert!(is_legacy_agent_label("ai.kortix.capture.service.1a2b3c4d"));
        assert!(!is_legacy_agent_label("ai.kortix.capture.agent"));
        assert!(!is_legacy_agent_label("ai.kortix.capture.machine"));
        assert!(!is_legacy_agent_label("com.example.other"));
    }

    #[test]
    fn a_library_from_the_control_plane_era_becomes_sync_off_and_keeps_its_recordings() {
        assert!(has_legacy_sync(r#"{"control_plane":{"url":"http://localhost:3000"}}"#));
        assert!(has_legacy_sync(r#"{"sync":{"enabled":true,"dashboard_url":"x"}}"#));
        assert!(has_legacy_sync(r#"{"sync":{"url":"http://localhost:3000/api/agent/memory/audio"}}"#));
        assert!(!has_legacy_sync(r#"{"sync":{"enabled":true,"provider":"kortix"},"interval_ms":2000}"#));
        assert!(!has_legacy_sync("not json"));
        std::env::set_var(crate::secret_store::STORE_ENV, "file");
        let dir = std::env::temp_dir().join(format!("kcap-legacy-{}", uuid::Uuid::new_v4().simple()));
        let paths = crate::memory::paths::MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        std::fs::write(
            paths.settings(),
            r#"{"interval_ms":3000,"control_plane":{"url":"http://localhost:3000"},"sync":{"enabled":true,"provider":"kortix"}}"#,
        )
        .unwrap();
        std::fs::write(paths.root.join("memory.db-marker"), b"recordings").unwrap();
        assert!(migrate_legacy_settings(&paths));
        let s = crate::memory::settings::Settings::load(&paths);
        assert!(!s.sync.enabled, "Sync Off");
        assert_eq!(s.interval_ms, 3000, "the person's own settings stay");
        assert!(!std::fs::read_to_string(paths.settings()).unwrap().contains("control_plane"));
        assert!(paths.root.join("memory.db-marker").exists(), "recordings stay");
        assert!(!migrate_legacy_settings(&paths), "it runs once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn processes_of_another_bundle_and_the_old_tray_are_found_ours_are_kept() {
        let cur = "/Applications/Kortix Capture.app/";
        let ps = "  101 /Users/p/Applications/Kortix Capture.app/Contents/MacOS/kortix-tray\n\
                  102 /Users/p/Applications/Kortix Capture Test.app/Contents/MacOS/Kortix Capture service run\n\
                  103 /Users/p/Applications/Kortix Capture.app/Contents/MacOS/Kortix Capture record --supervised\n\
                  104 /Applications/Kortix Capture.app/Contents/MacOS/Kortix Capture record --supervised\n\
                  105 /Applications/Kortix Capture.app/Contents/MacOS/Kortix Capture agent\n\
                  106 /Applications/Kortix Capture.app/Contents/MacOS/Kortix Capture tray\n\
                  107 /usr/bin/some-other-tool\n\
                  108 /Applications/Kortix Capture.app/Contents/MacOS/kortix-tray";
        assert_eq!(legacy_pids(ps, cur, 1), vec![101, 102, 103, 108]);
        assert_eq!(legacy_pids(ps, cur, 102), vec![101, 103, 108], "never this process");
    }

    #[test]
    fn old_run_keys_and_tasks_are_found_the_current_one_is_kept() {
        let q = "\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\n\
                 \x20   Kortix Capture tray    REG_SZ    C:\\Old\\Kortix\\kortix-tray.exe\n\
                 \x20   Kortix Capture    REG_SZ    \"C:\\Program Files\\Kortix\\Capture\\kortix-capture.exe\" tray\n\
                 \x20   OneDrive    REG_SZ    C:\\x\\OneDrive.exe\n";
        let cur = "c:\\program files\\kortix\\capture\\kortix-capture.exe";
        let found = legacy_run_values(q, cur);
        assert_eq!(found, vec!["Kortix Capture tray".to_string()], "{found:?}");
        let csv = "\"\\Kortix Capture tray\",\"N/A\",\"Ready\"\n\"\\Kortix Capture service\",\"N/A\",\"Ready\"\n\"\\ai.kortix.capture.service.ab12cd34\",\"N/A\",\"Ready\"\n\"\\Other\",\"N/A\",\"Ready\"\n";
        assert_eq!(legacy_task_names(csv), vec!["Kortix Capture tray", "Kortix Capture service"]);
    }
}
