//! The logon notice: one desktop notification at the start of each session, with
//! the organization's notice (or a sentence naming the account). Best effort: a
//! computer without a notification service shows nothing, and the tray's hover
//! text and menu still carry the notice.
//!
//! - Windows: a toast through PowerShell's WinRT bridge (PowerShell's own app id).
//! - macOS: `osascript` (`display notification`). The notification shows under
//!   Script Editor's name; a native `UNUserNotificationCenter` call needs the
//!   app's own notification permission and is a follow-up.
//! - Linux: `org.freedesktop.Notifications.Notify` over the session D-Bus
//!   (`gdbus`), else `notify-send`.

use std::process::{Command, Stdio};

/// Show the notice. Never blocks and never fails.
pub fn show(title: &str, body: &str) {
    let (title, body) = (title.to_string(), body.to_string());
    tracing::info!("[notify] logon notice: {title}");
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
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/osascript");
        c.args(osascript_args(title, body));
        vec![c]
    } else {
        let mut gdbus = Command::new("gdbus");
        gdbus.args(gdbus_args(title, body));
        let mut send = Command::new("notify-send");
        send.args(["--app-name=Kortix Capture", title, body]);
        vec![gdbus, send]
    }
}

/// The title and body travel as script arguments, never inside the script text.
pub fn osascript_args(title: &str, body: &str) -> Vec<String> {
    [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
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
        "''",
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
    fn the_text_never_enters_a_script() {
        let a = osascript_args("T \" x", "B ' \\ y");
        assert_eq!(&a[a.len() - 2..], ["T \" x", "B ' \\ y"]);
        assert!(a[..a.len() - 2].iter().all(|s| !s.contains("B '")));
    }

    #[test]
    fn gvariant_strings_escape_quotes_and_backslashes() {
        assert_eq!(gvariant_string("it's a \\ b"), r"'it\'s a \\ b'");
        let a = gdbus_args(
            "Kortix Capture — Example Org",
            "Recorded for it's analysis.",
        );
        assert_eq!(a[8], "'Kortix Capture'");
        assert_eq!(a[11], "'Kortix Capture — Example Org'");
        assert_eq!(a[12], r"'Recorded for it\'s analysis.'");
        assert_eq!(&a[13..], ["[]", "{}", "15000"]);
    }

    #[test]
    fn this_os_has_a_command() {
        assert!(!commands("t", "b").is_empty());
    }
}
