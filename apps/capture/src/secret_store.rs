//! Small secrets (the sync encryption key, the device token) in the OS store:
//!
//! - macOS: the login Keychain, through the `security` tool;
//! - Windows: Credential Manager (generic credential `<service>/<account>`);
//! - Linux: the Secret Service (GNOME Keyring, KWallet), through `secret-tool`.
//!
//! When the OS store is unavailable or refuses, or `KORTIX_CAPTURE_KEY_STORE=file`,
//! the secret goes to a caller-chosen file, mode 0600 (Windows: the per-user
//! app-data ACL applies). One file holds one secret.

use anyhow::{bail, Context, Result};
use std::path::Path;

/// `file` forces the file store (test harnesses and headless machines).
pub const STORE_ENV: &str = "KORTIX_CAPTURE_KEY_STORE";

fn os_store_enabled() -> bool {
    std::env::var(STORE_ENV)
        .map(|v| v != "file")
        .unwrap_or(true)
}

/// Store `secret`; returns where it went: `keychain`, `credential_manager`,
/// `secret_service` or `file`.
pub fn put(
    service: &str,
    account: &str,
    label: &str,
    secret: &str,
    fallback: &Path,
) -> Result<&'static str> {
    if os_store_enabled() {
        match os::put(service, account, label, secret) {
            Ok(Some(place)) if os::get(service, account).as_deref() == Some(secret) => {
                // A stale copy in the file would shadow nothing, but it is a secret on disk.
                let _ = std::fs::remove_file(fallback);
                return Ok(place);
            }
            Ok(Some(place)) => {
                tracing::warn!("{place} did not return the secret it stored; using a file")
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("OS secret store refused {service}: {e:#}; using a file"),
        }
    }
    crate::memory::sync::write_private(fallback, format!("{secret}\n").as_bytes())?;
    Ok("file")
}

/// The secret, from the OS store or the file.
pub fn get(service: &str, account: &str, fallback: &Path) -> Option<String> {
    if os_store_enabled() {
        if let Some(s) = os::get(service, account) {
            return Some(s);
        }
    }
    let text = std::fs::read_to_string(fallback).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Remove the secret from the OS store and the file. Missing is not an error.
pub fn delete(service: &str, account: &str, fallback: &Path) {
    if os_store_enabled() {
        os::delete(service, account);
    }
    let _ = std::fs::remove_file(fallback);
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn get(service: &str, account: &str) -> Option<String> {
        let out = Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    }

    /// `security -i` reads the command from stdin, so the secret never appears in argv.
    pub fn put(
        service: &str,
        account: &str,
        label: &str,
        secret: &str,
    ) -> Result<Option<&'static str>> {
        for v in [service, account, label, secret] {
            if v.contains(['"', '\n', '\\']) {
                bail!("value cannot be passed to the Keychain safely");
            }
        }
        let mut child = Command::new("security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("run security")?;
        let cmd = format!(
            "add-generic-password -U -s \"{service}\" -a \"{account}\" -l \"{label}\" -w \"{secret}\"\n"
        );
        child
            .stdin
            .take()
            .context("security stdin")?
            .write_all(cmd.as_bytes())?;
        let out = child.wait_with_output()?;
        if !out.status.success() {
            bail!("Keychain: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(Some("keychain"))
    }

    pub fn delete(service: &str, account: &str) {
        let _ = Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// `secret-tool` (libsecret) talks to whatever Secret Service runs: GNOME
    /// Keyring, KWallet. Without it or without a session bus, the file is used.
    pub fn get(service: &str, account: &str) -> Option<String> {
        let out = Command::new("secret-tool")
            .args(["lookup", "service", service, "account", account])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    }

    /// The secret goes through stdin, never argv.
    pub fn put(
        service: &str,
        account: &str,
        label: &str,
        secret: &str,
    ) -> Result<Option<&'static str>> {
        let mut child = match Command::new("secret-tool")
            .args([
                "store", "--label", label, "service", service, "account", account,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            // No libsecret tools on this machine: the file store, quietly.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).context("run secret-tool"),
        };
        child
            .stdin
            .take()
            .context("secret-tool stdin")?
            .write_all(secret.as_bytes())?;
        let out = child.wait_with_output()?;
        if !out.status.success() {
            bail!(
                "Secret Service: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(Some("secret_service"))
    }

    pub fn delete(service: &str, account: &str) {
        let _ = Command::new("secret-tool")
            .args(["clear", "service", service, "account", account])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(all(target_os = "windows", feature = "capture-engine"))]
mod os {
    use super::*;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn target(service: &str, account: &str) -> HSTRING {
        HSTRING::from(format!("{service}/{account}"))
    }

    pub fn get(service: &str, account: &str) -> Option<String> {
        let name = target(service, account);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            CredReadW(&name, CRED_TYPE_GENERIC, 0, &mut cred).ok()?;
            let c = &*cred;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
                .to_vec();
            CredFree(cred as *const _);
            String::from_utf8(bytes).ok().filter(|s| !s.is_empty())
        }
    }

    pub fn put(
        service: &str,
        account: &str,
        label: &str,
        secret: &str,
    ) -> Result<Option<&'static str>> {
        let mut name: Vec<u16> = format!("{service}/{account}")
            .encode_utf16()
            .chain([0])
            .collect();
        let mut comment: Vec<u16> = label.encode_utf16().chain([0]).collect();
        let mut user: Vec<u16> = account.encode_utf16().chain([0]).collect();
        let mut blob = secret.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            Comment: PWSTR(comment.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        unsafe { CredWriteW(&cred, 0) }.context("Credential Manager")?;
        Ok(Some("credential_manager"))
    }

    pub fn delete(service: &str, account: &str) {
        let _ = unsafe { CredDeleteW(&target(service, account), CRED_TYPE_GENERIC, 0) };
    }
}

/// No OS store in this build: the file only.
#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    all(target_os = "windows", feature = "capture-engine")
)))]
mod os {
    use super::*;
    pub fn get(_: &str, _: &str) -> Option<String> {
        None
    }
    pub fn put(_: &str, _: &str, _: &str, _: &str) -> Result<Option<&'static str>> {
        Ok(None)
    }
    pub fn delete(_: &str, _: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_round_trips_and_deletes() {
        std::env::set_var(STORE_ENV, "file");
        let dir = std::env::temp_dir().join(format!("kcap-secret-{}", uuid::Uuid::new_v4()));
        let file = dir.join("token");
        assert_eq!(get("svc", "acct", &file), None);
        assert_eq!(
            put("svc", "acct", "label", "s3cr3t", &file).unwrap(),
            "file"
        );
        assert_eq!(get("svc", "acct", &file).as_deref(), Some("s3cr3t"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        delete("svc", "acct", &file);
        assert_eq!(get("svc", "acct", &file), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
