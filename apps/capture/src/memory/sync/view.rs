//! What a person sees about cloud sync: the destination, one status line, and
//! one-sentence errors. Pure functions, shared by the window and the tray.
//!
//! The model: sync is off, or it goes to Kortix, or it goes to the person's own
//! S3 bucket. Off is the default. The raw error (an HTTP body, a stack of
//! causes) goes to the log; the person reads [`humanize`].

use super::SyncState;
use crate::memory::settings::SyncSettings;
use serde::Serialize;

/// The destination switch rule, in one line for the window.
pub const SWITCH_RULE: &str =
    "Only recordings made from now on go to the new destination. Earlier ones stay on this computer.";

/// Where sync sends recordings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Destination {
    Off,
    Kortix,
    S3,
}

/// The identity of an active destination: the same key means "not a switch".
/// Kortix: the issuer and the device's prefix. S3: endpoint, bucket and prefix.
pub fn kortix_key(issuer: &str, prefix: &str) -> String {
    format!("kortix:{}/{}", issuer.trim().trim_end_matches('/'), prefix.trim())
}

pub fn s3_key(endpoint: &str, bucket: &str, prefix: &str) -> String {
    format!(
        "s3:{}/{}/{}",
        endpoint.trim().trim_end_matches('/'),
        bucket.trim(),
        prefix.trim().trim_matches('/')
    )
}

/// True when recordings made so far must stay local: sync was off (`prev` is
/// `None`) or it pointed somewhere else. Signing in again to the same
/// destination (an expired sign-in) is not a switch.
pub fn is_switch(prev: Option<&str>, next: &str) -> bool {
    prev != Some(next)
}

/// The key of the destination sync uses now; `None` when sync is off or the
/// Kortix sign-in is gone.
pub fn active_destination(paths: &crate::memory::paths::MemoryPaths) -> Option<String> {
    let s = crate::memory::settings::Settings::load(paths).sync;
    match destination(&s) {
        Destination::Off => None,
        Destination::Kortix => {
            let r = super::issuer::registration(paths).filter(|r| r.rejected_at_ms.is_none())?;
            Some(kortix_key(&r.issuer, &r.prefix))
        }
        Destination::S3 => Some(s3_key(&s.s3.endpoint, &s.s3.bucket, &s.s3.prefix)),
    }
}

/// Apply the switch rule after a destination is verified and before it turns on:
/// what is not uploaded yet stays on this computer.
pub fn apply_switch(
    paths: &crate::memory::paths::MemoryPaths,
    prev: Option<&str>,
    next: &str,
) -> anyhow::Result<()> {
    if is_switch(prev, next) {
        let n = crate::memory::store::keep_unsent_local(&crate::memory::store::open(paths)?)?;
        tracing::info!("sync destination changed: {n} earlier recordings stay on this computer");
    }
    Ok(())
}

/// Everything the status line reads.
pub struct ViewInput<'a> {
    pub sync: &'a SyncSettings,
    pub airgap: bool,
    pub managed: bool,
    /// The Kortix sign-in: signed in, sign-in refused, organization name.
    pub kortix_signed_in: bool,
    pub sign_in_required: bool,
    pub account_name: Option<&'a str>,
    pub state: Option<&'a SyncState>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncView {
    pub destination: Destination,
    /// "Off", "Kortix · Example Org", "Your S3 bucket · my-bucket".
    pub label: String,
    /// One short sentence: "Synced 2 min ago", "Paused", an error in plain words.
    pub line: String,
    /// `off`, `ok`, `busy`, `paused` or `error`.
    pub tone: &'static str,
}

pub fn destination(s: &SyncSettings) -> Destination {
    match (s.enabled, s.provider.as_str()) {
        (false, _) => Destination::Off,
        (true, "kortix") => Destination::Kortix,
        (true, _) => Destination::S3,
    }
}

pub fn sync_view(i: &ViewInput) -> SyncView {
    let dest = destination(i.sync);
    let label = match dest {
        Destination::Off => "Off".to_string(),
        Destination::Kortix => format!("Kortix · {}", i.account_name.unwrap_or("your account")),
        Destination::S3 => format!("Your S3 bucket · {}", i.sync.s3.bucket),
    };
    let (line, tone) = status_line(i, dest);
    SyncView {
        destination: dest,
        label,
        line,
        tone,
    }
}

/// No upload and no status report for this long while sync is on: the line says so.
const STALE_MS: i64 = 30 * 60_000;

fn status_line(i: &ViewInput, dest: Destination) -> (String, &'static str) {
    if dest == Destination::Off {
        return ("Off. Recordings stay on this computer.".into(), "off");
    }
    if i.airgap {
        return ("Paused. Network access is turned off.".into(), "paused");
    }
    if dest == Destination::Kortix && (i.sign_in_required || !i.kortix_signed_in) {
        return if i.managed {
            // The machine service enrolls it again with the organization's token.
            ("Disconnected from Kortix. Reconnecting.".into(), "error")
        } else {
            ("Disconnected from Kortix. Sign in again to resume.".into(), "error")
        };
    }
    let Some(st) = i.state else {
        return ("Waiting for the recorder to start.".into(), "busy");
    };
    // The last time this computer reached the bucket: an upload or the minute status report.
    let contact = st.last_upload_ms.max(st.status_reported_ms);
    let stale = contact.filter(|t| i.now_ms - t > STALE_MS);
    if st.state == "error" {
        let msg = st.last_error.as_deref().unwrap_or("");
        if msg.contains("capture_disabled") {
            return (
                "Paused. Kortix Capture is turned off for your organization.".into(),
                "paused",
            );
        }
        let m = humanize_text(msg, st.last_error_class.as_deref());
        return match stale {
            Some(t) => (format!("Last synced {}. {m}", ago(i.now_ms - t)), "error"),
            None => (m, "error"),
        };
    }
    if let Some(t) = stale {
        return (format!("Last synced {}. Retrying.", ago(i.now_ms - t)), "error");
    }
    if st.pending > 0 || st.audio_pending > 0 || st.actions_pending > 0 {
        let n = st.pending + st.audio_pending + st.actions_pending;
        return (format!("Uploading. {n} waiting."), "busy");
    }
    match st.last_upload_ms {
        Some(t) => (format!("Synced {}", ago(i.now_ms - t)), "ok"),
        None => ("Connected. Waiting for the next recording.".into(), "ok"),
    }
}

/// "just now", "2 min ago", "3 h ago", "5 days ago".
pub fn ago(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    match s {
        0..=44 => "just now".into(),
        45..=3569 => format!("{} min ago", (s + 30) / 60),
        3570..=86_399 => format!("{} h ago", (s + 1800) / 3600),
        _ => {
            let d = s / 86_400;
            if d == 1 {
                "1 day ago".into()
            } else {
                format!("{d} days ago")
            }
        }
    }
}

/// One short sentence for a person, from the raw error text and its class
/// (`auth`, `config`, `clock_skew`, `transient`, `integrity`, `local`).
/// Never returns an HTTP body, markup or a cause chain.
pub fn humanize_text(raw: &str, class: Option<&str>) -> String {
    let l = raw.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| l.contains(n));
    let msg = if has(&["capture_credentials_unavailable", "http 503"]) {
        "Kortix cannot accept recordings yet, so they are kept here and sync retries."
    } else if has(&["sign-in page is not on"]) {
        "Kortix sent a sign-in page Kortix Capture does not trust."
    } else if has(&["device authorize"]) && has(&["dns error", "failed to lookup", "connection refused", "error sending request", "timed out", "connect error"]) {
        "Could not reach Kortix to start sign-in."
    } else if has(&["device authorize"]) && has(&["http 4", "http 5"]) {
        "Kortix would not start sign-in."
    } else if has(&["<html", "<!doctype", "<body"]) {
        "The address does not lead to a Kortix or S3 server."
    } else if has(&["nosuchbucket", "specified bucket does not exist"]) {
        "That bucket does not exist in this region."
    } else if has(&["invalidaccesskeyid", "signaturedoesnotmatch"]) {
        "The bucket refused these keys."
    } else if has(&["accessdenied", "access denied"]) {
        "These keys cannot write to this bucket."
    } else if has(&["certificate", "tls handshake", "ssl"]) {
        "The secure connection to the server failed."
    } else if has(&["dns error", "failed to lookup", "name or service not known", "no such host", "nodename nor servname"]) {
        "Could not find the server at that address."
    } else if has(&["timed out", "timeout"]) {
        "The server took too long to answer."
    } else if has(&["connection refused", "connection reset", "error sending request", "connect error", "network is unreachable", "tcp connect"]) {
        "Could not reach the server."
    } else if has(&["bad endpoint", "invalid url", "relative url"]) {
        "The endpoint is not a valid address."
    } else if has(&["no kortix url"]) {
        "Enter the Kortix address to sign in."
    } else if has(&["access_denied", "expired_token", "device code"]) {
        "The sign-in was not approved or has expired."
    } else if let Some(plain) = plain_sentence(raw) {
        return plain;
    } else {
        match class {
            Some("auth") => "Kortix did not accept this computer.",
            Some("clock_skew") => "This computer's clock is wrong.",
            Some("config") => "The sync settings are not valid.",
            Some("integrity") => "An upload did not match and will be retried.",
            Some("local") => "A recording file could not be read.",
            Some("transient") => "Could not reach the server.",
            _ => "Something went wrong.",
        }
    };
    msg.to_string()
}

/// Our own short refusals ("enter the secret access key", "sync is off") are already
/// words for a person: keep them, as a capitalized sentence. Anything with a status
/// code, markup, a cause chain, a command or a long text is not.
fn plain_sentence(raw: &str) -> Option<String> {
    // Cut a command-line hint or a cause chain: "sync is off: turn it on with ..." -> "sync is off".
    let head = raw.split([':', '(']).next().unwrap_or("");
    let t = head.trim().trim_end_matches('.');
    let plain = !t.is_empty() && !raw.contains("HTTP")
        && t.chars().count() <= 90
        && !t.contains(['\n', '<', '`', ';', '/']);
    plain.then(|| {
        let mut c = t.chars();
        let first = c.next().map(|f| f.to_uppercase().collect::<String>()).unwrap_or_default();
        format!("{first}{}.", c.as_str())
    })
}

/// The sentence for an error raised by a window action. Logs the detail.
pub fn humanize(e: &anyhow::Error) -> String {
    let raw = format!("{e:#}");
    tracing::warn!("sync action failed: {raw}");
    humanize_text(&raw, super::target::classify_known(e).map(|c| c.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(s: &'a SyncSettings, st: Option<&'a SyncState>) -> ViewInput<'a> {
        ViewInput {
            sync: s,
            airgap: false,
            managed: false,
            kortix_signed_in: true,
            sign_in_required: false,
            account_name: Some("Example Org"),
            state: st,
            now_ms: 10_000_000,
        }
    }

    fn on(provider: &str) -> SyncSettings {
        let mut s = SyncSettings::default();
        s.enabled = true;
        s.provider = provider.into();
        s.s3.bucket = "my-bucket".into();
        s
    }

    #[test]
    fn off_is_the_default_and_says_recordings_stay_here() {
        let s = SyncSettings::default();
        let v = sync_view(&input(&s, None));
        assert_eq!(v.destination, Destination::Off);
        assert_eq!(v.label, "Off");
        assert_eq!(v.line, "Off. Recordings stay on this computer.");
        assert_eq!(v.tone, "off");
    }

    #[test]
    fn the_line_follows_the_sync_state() {
        let s = on("kortix");
        let mut st = SyncState::default();
        st.enabled = true;
        st.state = "ok".into();
        st.last_upload_ms = Some(10_000_000 - 120_000);
        let v = sync_view(&input(&s, Some(&st)));
        assert_eq!(v.label, "Kortix · Example Org");
        assert_eq!((v.line.as_str(), v.tone), ("Synced 2 min ago", "ok"));

        st.pending = 3;
        st.audio_pending = 1;
        let v = sync_view(&input(&s, Some(&st)));
        assert_eq!((v.line.as_str(), v.tone), ("Uploading. 4 waiting.", "busy"));

        st.pending = 0;
        st.audio_pending = 0;
        st.last_upload_ms = None;
        assert_eq!(
            sync_view(&input(&s, Some(&st))).line,
            "Connected. Waiting for the next recording."
        );

        assert_eq!(sync_view(&input(&s, None)).line, "Waiting for the recorder to start.");
    }

    #[test]
    fn s3_names_the_bucket_and_paused_beats_synced() {
        let s = on("s3");
        let mut i = input(&s, None);
        assert_eq!(sync_view(&i).label, "Your S3 bucket · my-bucket");
        i.airgap = true;
        let v = sync_view(&i);
        assert_eq!((v.line.as_str(), v.tone), ("Paused. Network access is turned off.", "paused"));
    }

    #[test]
    fn a_refused_sign_in_asks_for_a_new_one() {
        let s = on("kortix");
        let mut i = input(&s, None);
        i.sign_in_required = true;
        let v = sync_view(&i);
        assert_eq!((v.line.as_str(), v.tone), ("Disconnected from Kortix. Sign in again to resume.", "error"));
        i.managed = true;
        assert_eq!(sync_view(&i).line, "Disconnected from Kortix. Reconnecting.");
        i.managed = false;
    }

    #[test]
    fn a_stall_and_an_organization_switch_say_so() {
        let s = on("kortix");
        let mut st = SyncState::default();
        st.enabled = true;
        st.state = "ok".into();
        st.pending = 2;
        // Nothing reached the bucket for 2 h: not "Uploading", but how long and that it retries.
        st.last_upload_ms = Some(10_000_000 - 2 * 3_600_000);
        st.status_reported_ms = Some(10_000_000 - 2 * 3_600_000 + 60_000);
        let v = sync_view(&input(&s, Some(&st)));
        assert_eq!((v.line.as_str(), v.tone), ("Last synced 2 h ago. Retrying.", "error"));
        st.state = "error".into();
        st.last_error = Some("credentials: http://x: error sending request".into());
        st.last_error_class = Some("transient".into());
        let v = sync_view(&input(&s, Some(&st)));
        assert_eq!(v.line, "Last synced 2 h ago. Could not reach the server.");
        // A recent status report is contact: a quiet computer with nothing to upload is fine.
        st.state = "ok".into();
        st.pending = 0;
        st.status_reported_ms = Some(10_000_000 - 60_000);
        assert_eq!(sync_view(&input(&s, Some(&st))).tone, "ok");
        // The organization switched Capture off: paused, not broken.
        st.state = "error".into();
        st.last_error = Some(r#"credentials: HTTP 403 capture_disabled {"code":"capture_disabled"}"#.into());
        let v = sync_view(&input(&s, Some(&st)));
        assert_eq!((v.line.as_str(), v.tone), ("Paused. Kortix Capture is turned off for your organization.", "paused"));
    }

    #[test]
    fn a_sync_error_is_one_plain_sentence() {
        let s = on("s3");
        let mut st = SyncState::default();
        st.state = "error".into();
        st.last_error = Some("PUT chunk: HTTP 403 AccessDenied <Error><Code>AccessDenied</Code></Error>".into());
        st.last_error_class = Some("auth".into());
        let v = sync_view(&input(&s, Some(&st)));
        assert_eq!(v.line, "These keys cannot write to this bucket.");
        assert_eq!(v.tone, "error");
    }

    #[test]
    fn relative_time_reads_like_a_person() {
        assert_eq!(ago(10_000), "just now");
        assert_eq!(ago(60_000), "1 min ago");
        assert_eq!(ago(125_000), "2 min ago");
        assert_eq!(ago(3_600_000), "1 h ago");
        assert_eq!(ago(5 * 3_600_000), "5 h ago");
        assert_eq!(ago(86_400_000), "1 day ago");
        assert_eq!(ago(3 * 86_400_000), "3 days ago");
        assert_eq!(ago(-5), "just now");
    }

    #[test]
    fn errors_never_show_markup_status_codes_or_chains() {
        let cases = [
            ("Issuer: HTTP 502 <html><body>Bad gateway</body></html>", None, "The address does not lead to a Kortix or S3 server."),
            ("PUT k: HTTP 404 NoSuchBucket The specified bucket does not exist", Some("config"), "That bucket does not exist in this region."),
            ("PUT k: HTTP 403 SignatureDoesNotMatch", Some("auth"), "The bucket refused these keys."),
            ("error sending request: dns error: failed to lookup address", None, "Could not find the server at that address."),
            ("operation timed out", None, "The server took too long to answer."),
            ("S3 probe failed; sync stays off: connection refused", None, "Could not reach the server."),
            ("device authorize: the sign-in page is not on the Kortix address", None, "Kortix sent a sign-in page Kortix Capture does not trust."),
            ("device authorize: error sending request for url (http://localhost:37208): connection refused", None, "Could not reach Kortix to start sign-in."),
            ("device authorize: HTTP 500 oops", None, "Kortix would not start sign-in."),
            ("Issuer: HTTP 503 capture_credentials_unavailable {\"error\":\"x\"}", Some("transient"), "Kortix cannot accept recordings yet, so they are kept here and sync retries."),
            ("bad endpoint nope", None, "The endpoint is not a valid address."),
            ("PUT k: HTTP 401", Some("auth"), "Kortix did not accept this computer."),
            ("PUT k: HTTP 403 RequestTimeTooSkewed", Some("clock_skew"), "This computer's clock is wrong."),
            ("PUT k: HTTP 500", None, "Something went wrong."),
            ("enter the secret access key", None, "Enter the secret access key."),
            ("sync is off", None, "Sync is off."),
        ];
        for (raw, class, want) in cases {
            let got = humanize_text(raw, class);
            assert_eq!(got, want, "{raw}");
            assert!(!got.contains('<') && !got.contains("HTTP"), "{got}");
            assert_eq!(got.matches('.').count(), 1, "one sentence: {got}");
            assert!(got.chars().count() <= 90, "{got}");
        }
    }

    #[test]
    fn the_switch_rule() {
        let a = kortix_key("https://api.kortix.example/", "acct-1/dev-1");
        assert_eq!(a, "kortix:https://api.kortix.example/acct-1/dev-1");
        // Off -> anything is a switch: what was recorded while off stays local.
        assert!(is_switch(None, &a));
        // The same destination again (re-sign-in after an expiry) is not.
        assert!(!is_switch(Some(&a), &a));
        // Another account, another provider, another bucket or prefix is.
        assert!(is_switch(Some(&a), &kortix_key("https://api.kortix.example", "acct-2/dev-9")));
        let b = s3_key("http://127.0.0.1:9000/", "capture", "/kortix-capture/");
        assert_eq!(b, "s3:http://127.0.0.1:9000/capture/kortix-capture");
        assert!(is_switch(Some(&a), &b));
        assert!(is_switch(Some(&b), &s3_key("http://127.0.0.1:9000", "other", "kortix-capture")));
        assert!(!is_switch(Some(&b), &s3_key("http://127.0.0.1:9000", "capture", "kortix-capture")));
    }
}
