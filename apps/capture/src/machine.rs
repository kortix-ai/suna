//! Who this computer is: a stable machine key, the real hostname, and the name
//! the person gave the computer.
//!
//! The machine key is a one-way hash of the OS machine id (macOS
//! `IOPlatformUUID`, Windows `MachineGuid`, Linux `/etc/machine-id`). The raw id
//! never leaves this module. The sync engine derives the device id from the key
//! and the bucket prefix, and `device.json` carries only the key hashed once
//! more (`memory::sync::identity`), so neither leaves the machine.

use sha2::{Digest, Sha256};
use std::{env, fs, process::Command};

/// Domain separator: the key is useless to any other app that hashes the same id.
const KEY_DOMAIN: &str = "kortix-capture/machine/v1\n";

/// Hex SHA-256 of the OS machine id, or None when the OS gives none.
pub fn machine_key() -> Option<String> {
    os_machine_id().map(|raw| key_for(&raw))
}

fn key_for(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(KEY_DOMAIN.as_bytes());
    hasher.update(raw.trim().to_ascii_lowercase().as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(target_os = "macos")]
fn os_machine_id() -> Option<String> {
    let out = Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    parse_ioreg_uuid(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "windows")]
fn os_machine_id() -> Option<String> {
    let mut cmd = Command::new("reg.exe");
    cmd.args([
        "query",
        r"HKLM\SOFTWARE\Microsoft\Cryptography",
        "/v",
        "MachineGuid",
        "/reg:64",
    ]);
    crate::os_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    parse_reg_machine_guid(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_machine_id() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|p| fs::read_to_string(p).ok().and_then(non_empty))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_ioreg_uuid(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let value = line.split('=').nth(1)?.trim().trim_matches('"');
    non_empty(value)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_machine_guid(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("MachineGuid"))?;
    line.split_whitespace().last().and_then(non_empty)
}

/// The network hostname (`MacBook-Pro.local`). macOS GUI apps get no
/// `HOSTNAME` variable, so the OS is asked before the placeholder.
pub fn hostname() -> String {
    env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .ok()
        .and_then(non_empty)
        .or_else(|| command_output("hostname", &[]))
        .or_else(|| fs::read_to_string("/etc/hostname").ok().and_then(non_empty))
        .unwrap_or_else(|| "kortix-device".to_string())
}

/// The name the person sees for this computer ("MacBook Pro (4)" in System
/// Settings on macOS, the pretty hostname on Linux). Falls back to the hostname.
pub fn computer_name() -> String {
    let named = if cfg!(target_os = "macos") {
        command_output("/usr/sbin/scutil", &["--get", "ComputerName"])
    } else if cfg!(target_os = "linux") {
        command_output("hostnamectl", &["--pretty"])
    } else {
        None
    };
    named.unwrap_or_else(hostname)
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    crate::os_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    non_empty(String::from_utf8_lossy(&out.stdout))
}

fn non_empty(value: impl AsRef<str>) -> Option<String> {
    let value = value.as_ref().trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_a_stable_one_way_hash_of_the_normalized_id() {
        let a = key_for("4C4C4544-0042-3510-8058-B4C04F4E4B32");
        assert_eq!(a, key_for(" 4c4c4544-0042-3510-8058-b4c04f4e4b32\n"));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!a.contains("4c4c4544"));
        assert_ne!(a, key_for("4C4C4544-0042-3510-8058-B4C04F4E4B33"));
    }

    #[test]
    fn parses_the_platform_uuid_from_ioreg() {
        let text = r#"+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000202>
    {
      "IOPlatformSerialNumber" = "SYNTHETIC0001"
      "IOPlatformUUID" = "00000000-1111-2222-3333-444444444444"
    }"#;
        assert_eq!(
            parse_ioreg_uuid(text).as_deref(),
            Some("00000000-1111-2222-3333-444444444444")
        );
        assert_eq!(parse_ioreg_uuid("no uuid here"), None);
    }

    #[test]
    fn parses_machine_guid_from_reg_query() {
        let text = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0a1b2c3d-0000-1111-2222-333344445555\r\n\r\n";
        assert_eq!(
            parse_reg_machine_guid(text).as_deref(),
            Some("0a1b2c3d-0000-1111-2222-333344445555")
        );
    }

    #[test]
    fn this_host_has_a_machine_key_and_a_real_name() {
        // macOS and Windows always expose a machine id. A Linux container may
        // have no /etc/machine-id: then the device sends no key and is never merged.
        if cfg!(not(target_os = "linux")) || os_machine_id().is_some() {
            assert!(machine_key().is_some_and(|k| k.len() == 64));
        }
        assert_ne!(hostname(), "kortix-device");
        assert!(!computer_name().is_empty());
    }
}
