//! What this computer is made of, for `device.json` `machine`: the OS name and
//! build, CPU, memory, free disk on the library volume, GPUs, boot time,
//! timezone and locale. Support reads it in Kortix ("Device details").
//!
//! Every field is optional: a value the OS does not give cheaply is null. Nothing
//! here names the person or the computer (the hostname rules stay in
//! `memory::sync::device_json`). The sync thread calls [`cached`] on every tick, so
//! the collection runs at most once an hour and never on the recording path.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one collection is reused. `device.json` goes out at least hourly.
const REFRESH: Duration = Duration::from_secs(3600);

// replica-local: one cached collection per process.
static CACHE: Mutex<Option<(Instant, PathBuf, Value)>> = Mutex::new(None);

/// The machine object for `device.json`, at most an hour old. `library` is the
/// folder whose volume the free disk space is measured on.
pub fn cached(library: &Path) -> Value {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, path, v)) = cache.as_ref() {
        if at.elapsed() < REFRESH && path == library {
            return v.clone();
        }
    }
    let v = collect(library);
    *cache = Some((Instant::now(), library.to_path_buf(), v.clone()));
    v
}

/// One collection, uncached.
pub fn collect(library: &Path) -> Value {
    let os = os::read();
    let (free, total) = disk_space(library).unzip();
    json!({
        "os_name": os.name,
        "os_build": os.build,
        "cpu": os.cpu,
        "cpu_cores": std::thread::available_parallelism().ok().map(|n| n.get()),
        "memory_bytes": os.memory_bytes,
        "disk_free_bytes": free,
        "disk_total_bytes": total,
        "gpus": os.gpus,
        // To the minute, so the hourly device.json does not change for a clock tick.
        "booted_at_ms": os.booted_at_ms.map(|t| t - t % 60_000),
        "timezone": os.timezone,
        "utc_offset": chrono::Local::now().format("%:z").to_string(),
        "locale": os.locale.or_else(env_locale),
    })
}

#[derive(Default)]
struct OsInfo {
    name: Option<String>,
    build: Option<String>,
    cpu: Option<String>,
    memory_bytes: Option<u64>,
    gpus: Vec<String>,
    booted_at_ms: Option<i64>,
    timezone: Option<String>,
    locale: Option<String>,
}

fn non_empty(s: impl AsRef<str>) -> Option<String> {
    let s = s.as_ref().trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// `de_DE.UTF-8` → `de-DE`; `C` and `POSIX` say nothing.
pub fn locale_tag(raw: &str) -> Option<String> {
    let tag = raw.split(['.', '@']).next()?.trim().replace('_', "-");
    (!tag.is_empty() && tag != "C" && tag != "POSIX").then_some(tag)
}

fn env_locale() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().as_deref().and_then(locale_tag))
}

/// `/usr/share/zoneinfo/Europe/Berlin` (the target of `/etc/localtime`) → `Europe/Berlin`.
pub fn zone_from_link(target: &str) -> Option<String> {
    target
        .split_once("zoneinfo/")
        .and_then(|(_, zone)| non_empty(zone))
}

#[cfg_attr(not(unix), allow(dead_code))]
fn unix_timezone() -> Option<String> {
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|t| zone_from_link(&t.to_string_lossy()))
        .or_else(|| {
            std::fs::read_to_string("/etc/timezone")
                .ok()
                .and_then(non_empty)
        })
}

/// Free and total bytes of the volume that holds `path`.
#[cfg(unix)]
fn disk_space(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let unit = s.f_frsize as u64;
    Some((s.f_bavail as u64 * unit, s.f_blocks as u64 * unit))
}

#[cfg(all(windows, feature = "capture-engine"))]
fn disk_space(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let (mut free, mut total) = (0u64, 0u64);
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free as *mut u64),
            Some(&mut total as *mut u64),
            None,
        )
    }
    .ok()?;
    Some((free, total))
}

#[cfg(not(any(unix, all(windows, feature = "capture-engine"))))]
fn disk_space(_path: &Path) -> Option<(u64, u64)> {
    None
}

// ─── Parsers (pure, tested on every OS) ─────────────────────────────────────

/// `cmd /C ver` → `10.0.26200.9448`.
pub fn windows_ver_number(text: &str) -> Option<String> {
    let start = text.find("[Version ")? + "[Version ".len();
    let rest = &text[start..];
    non_empty(&rest[..rest.find(']')?])
}

/// The name Windows itself shows. `ProductName` still says "Windows 10" on Windows 11
/// (build 22000 and up), so the build decides. `DisplayVersion` (`24H2`) follows.
pub fn windows_name(
    product: Option<&str>,
    build: Option<u32>,
    display: Option<&str>,
) -> Option<String> {
    let base = match (product.and_then(non_empty), build) {
        (Some(p), Some(b)) if b >= 22000 => p.replacen("Windows 10", "Windows 11", 1),
        (Some(p), _) => p,
        (None, Some(b)) if b >= 22000 => "Windows 11".into(),
        (None, Some(_)) => "Windows 10".into(),
        (None, None) => return None,
    };
    Some(match display.and_then(non_empty) {
        Some(d) => format!("{base} {d}"),
        None => base,
    })
}

/// The values of one `reg query <key>` (or `/s /v <name>`): `(name, data)` in order.
/// `REG_DWORD` data is given as a decimal string.
pub fn reg_values(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            let (name, rest) = l.split_once(" REG_")?;
            let (kind, data) = rest
                .trim_start()
                .split_once(char::is_whitespace)
                .unwrap_or((rest, ""));
            let data = data.trim();
            let data = if kind == "DWORD" || kind == "QWORD" {
                u64::from_str_radix(data.trim_start_matches("0x"), 16)
                    .ok()?
                    .to_string()
            } else {
                data.to_string()
            };
            Some((name.trim().to_string(), data))
        })
        .collect()
}

/// `PRETTY_NAME="Ubuntu 24.04.1 LTS"` from `/etc/os-release`.
pub fn os_release_pretty(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        l.strip_prefix("PRETTY_NAME=")
            .and_then(|v| non_empty(v.trim_matches('"')))
    })
}

/// `model name : Intel(R) Core(TM) i7…` from `/proc/cpuinfo` (`Model` on ARM boards).
pub fn cpuinfo_model(text: &str) -> Option<String> {
    ["model name", "Model", "Hardware"].iter().find_map(|key| {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim() == *key).then(|| non_empty(v)).flatten()
        })
    })
}

/// `MemTotal: 16318412 kB` from `/proc/meminfo`, in bytes.
pub fn meminfo_total(text: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/// `btime 1730700000` from `/proc/stat`, in ms.
pub fn proc_stat_btime(text: &str) -> Option<i64> {
    let line = text.lines().find(|l| l.starts_with("btime "))?;
    line[6..].trim().parse::<i64>().ok().map(|s| s * 1000)
}

// ─── Per OS ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod os {
    use super::*;

    pub(super) fn read() -> OsInfo {
        let read = |p: &str| std::fs::read_to_string(p).ok();
        OsInfo {
            name: read("/etc/os-release").and_then(|t| os_release_pretty(&t)),
            build: read("/proc/sys/kernel/osrelease").and_then(non_empty),
            cpu: read("/proc/cpuinfo").and_then(|t| cpuinfo_model(&t)),
            memory_bytes: read("/proc/meminfo").and_then(|t| meminfo_total(&t)),
            gpus: Vec::new(),
            booted_at_ms: read("/proc/stat").and_then(|t| proc_stat_btime(&t)),
            timezone: unix_timezone(),
            locale: None,
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;

    fn sysctl_bytes(name: &str) -> Option<Vec<u8>> {
        let c = std::ffi::CString::new(name).ok()?;
        let mut len: libc::size_t = 0;
        let rc = unsafe {
            libc::sysctlbyname(
                c.as_ptr(),
                std::ptr::null_mut(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len];
        let rc = unsafe {
            libc::sysctlbyname(
                c.as_ptr(),
                buf.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (rc == 0).then(|| {
            buf.truncate(len);
            buf
        })
    }

    fn command(prog: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new(prog).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
            .and_then(non_empty)
    }

    pub(super) fn read() -> OsInfo {
        let cpu = sysctl_bytes("machdep.cpu.brand_string")
            .map(|b| {
                String::from_utf8_lossy(&b)
                    .trim_end_matches('\0')
                    .to_string()
            })
            .and_then(non_empty);
        let memory_bytes = sysctl_bytes("hw.memsize")
            .and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok())
            .map(u64::from_ne_bytes);
        // struct timeval { tv_sec: i64, tv_usec: i32 }: the seconds come first.
        let booted_at_ms = sysctl_bytes("kern.boottime")
            .and_then(|b| b.get(..8).and_then(|s| <[u8; 8]>::try_from(s).ok()))
            .map(|s| i64::from_ne_bytes(s) * 1000);
        let version = command("/usr/bin/sw_vers", &["-productVersion"]);
        OsInfo {
            name: Some(match version {
                Some(v) => format!("macOS {v}"),
                None => "macOS".into(),
            }),
            build: command("/usr/bin/sw_vers", &["-buildVersion"]),
            cpu,
            memory_bytes,
            // Apple silicon has one GPU, named by the chip (`cpu`). Asking system_profiler takes seconds.
            gpus: Vec::new(),
            booted_at_ms,
            timezone: unix_timezone(),
            locale: command("/usr/bin/defaults", &["read", "-g", "AppleLocale"])
                .as_deref()
                .and_then(locale_tag),
        }
    }
}

#[cfg(windows)]
mod os {
    use super::*;

    /// `reg.exe query <key> [args]`: the same tool `machine::os_machine_id` uses.
    fn reg(key: &str, args: &[&str]) -> Vec<(String, String)> {
        let mut c = std::process::Command::new("reg.exe");
        c.arg("query").arg(key).args(args);
        crate::os_proc::no_window(&mut c);
        c.output()
            .ok()
            .map(|o| reg_values(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }

    fn pick(values: &[(String, String)], name: &str) -> Option<String> {
        values
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .and_then(|(_, v)| non_empty(v))
    }

    pub(super) fn read() -> OsInfo {
        let cv = reg(
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            &["/reg:64"],
        );
        let build_num = pick(&cv, "CurrentBuildNumber").or_else(|| pick(&cv, "CurrentBuild"));
        let build = match (build_num.as_deref(), pick(&cv, "UBR")) {
            (Some(b), Some(u)) => Some(format!("{b}.{u}")),
            (b, _) => b.map(str::to_string),
        };
        let mut gpus: Vec<String> = Vec::new();
        for (_, desc) in reg(
            r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}",
            &["/s", "/v", "DriverDesc", "/reg:64"],
        ) {
            if !desc.is_empty() && !gpus.contains(&desc) {
                gpus.push(desc);
            }
        }
        OsInfo {
            name: windows_name(
                pick(&cv, "ProductName").as_deref(),
                build_num.as_deref().and_then(|b| b.parse().ok()),
                pick(&cv, "DisplayVersion").as_deref(),
            ),
            build,
            cpu: pick(
                &reg(
                    r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                    &["/v", "ProcessorNameString"],
                ),
                "ProcessorNameString",
            ),
            memory_bytes: memory_bytes(),
            gpus,
            booted_at_ms: uptime_ms().map(|up| crate::memory::store::now_ms() - up),
            timezone: pick(
                &reg(
                    r"HKLM\SYSTEM\CurrentControlSet\Control\TimeZoneInformation",
                    &["/v", "TimeZoneKeyName"],
                ),
                "TimeZoneKeyName",
            ),
            locale: pick(
                &reg(r"HKCU\Control Panel\International", &["/v", "LocaleName"]),
                "LocaleName",
            ),
        }
    }

    #[cfg(feature = "capture-engine")]
    fn memory_bytes() -> Option<u64> {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
        Some(m.ullTotalPhys)
    }

    #[cfg(feature = "capture-engine")]
    fn uptime_ms() -> Option<i64> {
        Some(unsafe { windows::Win32::System::SystemInformation::GetTickCount64() } as i64)
    }

    #[cfg(not(feature = "capture-engine"))]
    fn memory_bytes() -> Option<u64> {
        None
    }

    #[cfg(not(feature = "capture-engine"))]
    fn uptime_ms() -> Option<i64> {
        None
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod os {
    use super::*;

    pub(super) fn read() -> OsInfo {
        OsInfo {
            timezone: unix_timezone(),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_names_follow_the_build_not_the_product_name() {
        assert_eq!(
            windows_ver_number("\r\nMicrosoft Windows [Version 10.0.26200.9448]\r\n").as_deref(),
            Some("10.0.26200.9448")
        );
        assert_eq!(windows_ver_number("no version here"), None);
        assert_eq!(
            windows_name(Some("Windows 10 Pro"), Some(26200), Some("24H2")).as_deref(),
            Some("Windows 11 Pro 24H2")
        );
        assert_eq!(
            windows_name(Some("Windows 10 Enterprise"), Some(19045), Some("22H2")).as_deref(),
            Some("Windows 10 Enterprise 22H2")
        );
        assert_eq!(
            windows_name(None, Some(22631), None).as_deref(),
            Some("Windows 11")
        );
        assert_eq!(windows_name(None, None, None), None);
    }

    #[test]
    fn reg_query_output_parses_strings_and_dwords() {
        let text = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    ProductName    REG_SZ    Windows 10 Pro\r\n    UBR    REG_DWORD    0x24f0\r\n    CurrentBuildNumber    REG_SZ    26200\r\n    Empty    REG_SZ\r\n\r\nEnd of search: 3 match(es) found.\r\n";
        assert_eq!(
            reg_values(text),
            vec![
                ("ProductName".to_string(), "Windows 10 Pro".to_string()),
                ("UBR".into(), "9456".into()),
                ("CurrentBuildNumber".into(), "26200".into()),
                ("Empty".into(), "".into()),
            ]
        );
    }

    #[test]
    fn linux_files_parse() {
        assert_eq!(
            os_release_pretty("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n").as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
        assert_eq!(
            cpuinfo_model("processor\t: 0\nmodel name\t: AMD EPYC 9454P 48-Core Processor\n")
                .as_deref(),
            Some("AMD EPYC 9454P 48-Core Processor")
        );
        assert_eq!(
            meminfo_total("MemTotal:       16318412 kB\nMemFree: 1 kB\n"),
            Some(16_710_053_888)
        );
        assert_eq!(
            proc_stat_btime("cpu 1 2 3\nbtime 1730700000\n"),
            Some(1_730_700_000_000)
        );
        assert_eq!(
            zone_from_link("/usr/share/zoneinfo/Europe/Berlin").as_deref(),
            Some("Europe/Berlin")
        );
        assert_eq!(
            zone_from_link("/var/db/timezone/zoneinfo/America/New_York").as_deref(),
            Some("America/New_York")
        );
        assert_eq!(locale_tag("de_DE.UTF-8").as_deref(), Some("de-DE"));
        assert_eq!(locale_tag("en_US"), Some("en-US".into()));
        assert_eq!(locale_tag("C.UTF-8"), None);
    }

    #[test]
    fn a_collection_has_every_key_and_is_reused() {
        let dir = std::env::temp_dir();
        let v = collect(&dir);
        for key in [
            "os_name",
            "os_build",
            "cpu",
            "cpu_cores",
            "memory_bytes",
            "disk_free_bytes",
            "disk_total_bytes",
            "gpus",
            "booted_at_ms",
            "timezone",
            "utc_offset",
            "locale",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
        assert!(v["cpu_cores"].as_u64().is_some_and(|n| n > 0));
        assert!(v["gpus"].is_array());
        assert_eq!(cached(&dir), cached(&dir));
    }
}
