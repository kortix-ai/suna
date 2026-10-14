//! The organization's notice, as a plain desktop notification, only when the
//! organization's policy set one. Best effort: a computer without a notification
//! service shows nothing, and the menu still shows the status.
//!
//! - Windows: a toast through PowerShell's WinRT bridge.
//! - macOS: the app's own notification (`NSUserNotificationCenter`), so it carries the
//!   app icon and name. Never `osascript`, which shows a script icon.
//! - Linux: `org.freedesktop.Notifications.Notify` over the session D-Bus (`gdbus`) with
//!   the app icon name, else `notify-send`.

use std::process::{Command, Stdio};

/// Show the notice. Never blocks and never fails.
pub fn show(title: &str, body: &str) {
    tracing::info!("[notify] notice: {title}");
    #[cfg(target_os = "macos")]
    {
        if macos::deliver(title, body) {
            tracing::info!("[notify] delivered by the app");
        } else {
            tracing::warn!("[notify] the notification center took no notice");
        }
        return;
    }
    #[cfg(not(target_os = "macos"))]
    show_with_commands(title, body);
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod macos {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::CString;

    unsafe fn ns_string(s: &str) -> *mut Object {
        let c = CString::new(s.replace('\0', "")).unwrap_or_default();
        let cls = Class::get("NSString").expect("NSString");
        let o: *mut Object = msg_send![cls, alloc];
        msg_send![o, initWithUTF8String: c.as_ptr()]
    }

    /// `NSUserNotification` from the app bundle: app icon, app name, no permission prompt.
    pub fn deliver(title: &str, body: &str) -> bool {
        unsafe {
            let Some(note_cls) = Class::get("NSUserNotification") else { return false };
            let Some(center_cls) = Class::get("NSUserNotificationCenter") else { return false };
            let pool: *mut Object = msg_send![Class::get("NSAutoreleasePool").expect("pool"), new];
            let note: *mut Object = msg_send![note_cls, new];
            let () = msg_send![note, setTitle: ns_string(title)];
            let () = msg_send![note, setInformativeText: ns_string(body)];
            let center: *mut Object = msg_send![center_cls, defaultUserNotificationCenter];
            let ok = !center.is_null();
            if ok {
                let () = msg_send![center, deliverNotification: note];
            }
            let () = msg_send![pool, drain];
            ok
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn show_with_commands(title: &str, body: &str) {
    let (title, body) = (title.to_string(), body.to_string());
    let _ = std::thread::Builder::new()
        .name("logon-notice".into())
        .spawn(move || {
            for mut cmd in commands(&title, &body) {
                let program = cmd.get_program().to_string_lossy().into_owned();
                let ok = crate::os_proc::no_window(&mut cmd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success());
                if ok {
                    tracing::info!("[notify] delivered by {program}");
                    return;
                }
            }
            tracing::warn!("[notify] no notification service took the notice");
        });
}

/// The commands to try, in order, until one succeeds.
pub fn commands(title: &str, body: &str) -> Vec<Command> {
    if cfg!(windows) {
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_TOAST,
        ])
        .env("KC_TITLE", title)
        .env("KC_BODY", body);
        vec![c]
    } else {
        let mut gdbus = Command::new("gdbus");
        gdbus.args(gdbus_args(title, body));
        let mut send = Command::new("notify-send");
        send.args(["--app-name=Kortix Capture", title, body]);
        vec![gdbus, send]
    }
}

/// A GVariant text string: single quotes, `\` and `'` escaped.
pub fn gvariant_string(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub fn gdbus_args(title: &str, body: &str) -> Vec<String> {
    [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.Notify",
        "'Kortix Capture'",
        "0",
        "'kortix-capture'",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([
        gvariant_string(title),
        gvariant_string(body),
        "[]".to_string(),
        "{}".to_string(),
        "15000".to_string(),
    ])
    .collect()
}

const WINDOWS_TOAST: &str = r#"
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02')
$text = $xml.GetElementsByTagName('text')
[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:KC_TITLE))
[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:KC_BODY))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gvariant_strings_escape_quotes_and_backslashes() {
        assert_eq!(gvariant_string("it's a \\ b"), r"'it\'s a \\ b'");
        let a = gdbus_args(
            "Kortix Capture — Example Org",
            "Recorded for it's analysis.",
        );
        assert_eq!(a[8], "'Kortix Capture'");
        assert_eq!(a[10], "'kortix-capture'", "the app icon, by name");
        assert_eq!(a[11], "'Kortix Capture — Example Org'");
        assert_eq!(a[12], r"'Recorded for it\'s analysis.'");
        assert_eq!(&a[13..], ["[]", "{}", "15000"]);
    }

    #[test]
    fn this_os_has_a_command() {
        assert!(!commands("t", "b").is_empty());
    }
}
