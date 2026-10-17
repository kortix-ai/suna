//! What Kortix Capture never records: apps, websites, built-in groups and
//! private browser windows.
//!
//! Two sources add up. The person's own exclusions live in their settings
//! (`excluded_bundle_ids`, `excluded_domains`, `enabled_exclusion_groups`,
//! `exclude_private_browsing`). The organization's come with its policy
//! (`policy.rs`, `privacy.*`) and are joined in by `Policy::apply`; the person
//! cannot remove them. `kortix-capture exclude|include` edits the person's own
//! settings only, and the recorder, audio and the action service re-read them
//! within one tick (≤ 2 s), so a change needs no restart.

use super::{
    paths::MemoryPaths,
    policy::PolicyPrivacy,
    settings::{exclusion_groups, Settings},
};
use anyhow::{bail, Result};
use serde_json::{json, Value};

/// The window in front when something is recorded: app, page URL, title.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Front {
    pub bundle_id: String,
    pub url: Option<String>,
    pub title: String,
}

/// Window-title markers of private browser windows (the capture engine's list).
pub const PRIVATE_MARKERS: &[&str] = &[
    "private browsing",
    "incognito",
    "inprivate",
    "— private",
    "- private",
    "(private)",
];

/// The window title says it is a private browser window.
pub fn looks_private(title: &str) -> bool {
    let t = title.to_lowercase();
    PRIVATE_MARKERS.iter().any(|m| t.contains(m))
}

/// Kortix itself: every `com.kortix.*` and `ai.kortix.*` app, and the app the
/// service runs in (`own`: its bundle id and executable name). Never recorded.
pub fn is_own_app(bundle_id: &str, own: &[String]) -> bool {
    let b = bundle_id.to_ascii_lowercase();
    b.starts_with("com.kortix.")
        || b.starts_with("ai.kortix.")
        || b == "com.kortix"
        || contains_ci(own, &b)
}

/// With `record_only_included` on: the app is included, or the page's website is.
/// With it off, everything is included.
pub fn included(s: &Settings, bundle_id: &str, url: Option<&str>) -> bool {
    if !s.record_only_included {
        return true;
    }
    contains_ci(&s.included_bundle_ids, bundle_id)
        || url.and_then(super::store::normalize_domain).is_some_and(|host| {
            s.effective_included_domains()
                .iter()
                .any(|d| domain_covers(d, &host))
        })
}

/// Why nothing in front of `front` may be recorded under the effective
/// settings `s`: `own_app` (Kortix itself), `excluded_app`, `private_browsing`,
/// `excluded_domain` (the screen recorder's skip reasons, in its order) or
/// `not_included` (record only included apps and websites is on).
pub fn excluded_reason(s: &Settings, front: &Front) -> Option<&'static str> {
    excluded_by_list(s, front).or_else(|| {
        (!included(s, &front.bundle_id, front.url.as_deref())).then_some("not_included")
    })
}

fn excluded_by_list(s: &Settings, front: &Front) -> Option<&'static str> {
    if is_own_app(&front.bundle_id, &s.own_bundle_ids) {
        return Some("own_app");
    }
    if contains_ci(&s.effective_excluded_bundle_ids(), &front.bundle_id) {
        return Some("excluded_app");
    }
    if s.exclude_private_browsing && looks_private(&front.title) {
        return Some("private_browsing");
    }
    let host = front
        .url
        .as_deref()
        .and_then(super::store::normalize_domain)?;
    s.effective_excluded_domains()
        .iter()
        .any(|d| domain_covers(&d.to_ascii_lowercase(), &host))
        .then_some("excluded_domain")
}

/// One thing to exclude or record again.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    App(String),
    Domain(String),
    Group(String),
    PrivateBrowsing,
}

/// `https://www.Example.com/a`, `www.example.com`, `Example.com/x` -> `example.com`.
pub fn normalize_domain_input(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let url = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let domain = super::store::normalize_domain(&url)?;
    let label = |l: &str| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    (domain.contains('.') && domain.split('.').all(label)).then_some(domain)
}

/// `host` is `domain` or one of its subdomains (the engine's own rule).
/// Whether the page at `url` is on an excluded site. `patterns` are normalized
/// (`normalize_domain_input`); a pattern covers its host and every subdomain.
/// An address bar may show the URL without its scheme: that reads as https.
pub fn url_excluded(url: &str, patterns: &[String]) -> bool {
    let url = url.trim();
    let url = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    super::store::normalize_domain(&url)
        .is_some_and(|host| patterns.iter().any(|p| domain_covers(p, &host)))
}

fn domain_covers(domain: &str, host: &str) -> bool {
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

fn contains_ci(list: &[String], item: &str) -> bool {
    list.iter().any(|x| x.eq_ignore_ascii_case(item))
}

fn group_name(id: &str) -> Option<&'static str> {
    exclusion_groups()
        .iter()
        .find(|g| g.id == id)
        .map(|g| g.name)
}

/// Exclude (`excluded = true`) or record again one target in the person's
/// settings `s`. `org` is the organization's part, which an include cannot undo.
pub fn change(
    s: &mut Settings,
    org: &PolicyPrivacy,
    target: &Target,
    excluded: bool,
) -> Result<()> {
    let by_org = |what: &str| anyhow::anyhow!("{what} is excluded by your organization");
    match target {
        Target::App(raw) => {
            let id = raw.trim();
            if id.is_empty() || id.contains(char::is_whitespace) && !id.ends_with(".exe") {
                bail!("{raw:?} is not an app bundle id (com.example.App, app.exe or a WM_CLASS)");
            }
            if excluded {
                if !contains_ci(&s.excluded_bundle_ids, id) {
                    s.excluded_bundle_ids.push(id.to_string());
                }
                return Ok(());
            }
            if contains_ci(&org.excluded_bundle_ids, id) {
                return Err(by_org(id));
            }
            for g in exclusion_groups() {
                if g.bundle_ids.iter().any(|b| b.eq_ignore_ascii_case(id)) {
                    if org.exclusion_groups.iter().any(|x| x == g.id) {
                        return Err(by_org(id));
                    }
                    if s.enabled_exclusion_groups.iter().any(|x| x == g.id) {
                        bail!(
                            "{id} is excluded by the {} group; record that group again first",
                            g.name
                        );
                    }
                }
            }
            s.excluded_bundle_ids
                .retain(|x| !x.eq_ignore_ascii_case(id));
        }
        Target::Domain(raw) => {
            let Some(domain) = normalize_domain_input(raw) else {
                bail!("{raw:?} is not a website (example.com)");
            };
            if excluded {
                if !contains_ci(&s.excluded_domains, &domain) {
                    s.excluded_domains.push(domain);
                }
                return Ok(());
            }
            let org_domains: Vec<String> = org
                .excluded_domains
                .iter()
                .filter_map(|d| normalize_domain_input(d))
                .collect();
            if let Some(d) = org_domains.iter().find(|d| domain_covers(d, &domain)) {
                return Err(by_org(if *d == domain { &domain } else { d }));
            }
            s.excluded_domains
                .retain(|x| !x.eq_ignore_ascii_case(&domain));
        }
        Target::Group(id) => {
            let Some(name) = group_name(id) else {
                let ids: Vec<&str> = exclusion_groups().iter().map(|g| g.id).collect();
                bail!("unknown group {id} (one of {})", ids.join(", "));
            };
            if excluded {
                if !s.enabled_exclusion_groups.iter().any(|x| x == id) {
                    s.enabled_exclusion_groups.push(id.clone());
                }
                return Ok(());
            }
            if org.exclusion_groups.iter().any(|x| x == id) {
                return Err(by_org(name));
            }
            s.enabled_exclusion_groups.retain(|x| x != id);
        }
        Target::PrivateBrowsing => {
            if !excluded && org.exclude_private_browsing {
                return Err(by_org("Private browsing"));
            }
            s.exclude_private_browsing = excluded;
        }
    }
    Ok(())
}

/// A recorded app: bundle id, display name, epoch ms of its latest segment.
pub struct RecentApp {
    pub bundle_id: String,
    pub name: String,
    pub last_seen_ms: i64,
}

/// A recorded website: normalized domain, epoch ms of its latest segment.
pub struct RecentDomain {
    pub domain: String,
    pub last_seen_ms: i64,
}

/// The organization's exclusions in effect here: the policy's privacy part.
fn org_of(effective: &Settings) -> PolicyPrivacy {
    effective
        .policy
        .as_ref()
        .map(|p| p.privacy.clone())
        .unwrap_or_default()
}

/// The `exclusions --json` document from the person's settings, the effective
/// ones (with the policy), what was recorded lately and the app in front.
pub fn report_from(
    member: &Settings,
    effective: &Settings,
    recent_apps: &[RecentApp],
    recent_domains: &[RecentDomain],
    frontmost: Option<(String, String)>,
) -> Value {
    let org = org_of(effective);
    let groups: Vec<Value> = exclusion_groups()
        .iter()
        .map(|g| {
            json!({
                "id": g.id, "name": g.name, "description": g.description,
                "apps": g.bundle_ids.len(), "domains": g.domains.len(),
                "enabled": effective.enabled_exclusion_groups.iter().any(|x| x == g.id),
                "by_org": org.exclusion_groups.iter().any(|x| x == g.id),
            })
        })
        .collect();
    let name_of = |id: &str| {
        recent_apps
            .iter()
            .find(|a| a.bundle_id.eq_ignore_ascii_case(id))
            .map(|a| a.name.clone())
            .or_else(|| {
                frontmost
                    .as_ref()
                    .filter(|(f, _)| f.eq_ignore_ascii_case(id))
                    .map(|(_, n)| n.clone())
            })
            .unwrap_or_else(|| id.to_string())
    };
    let mut apps: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for id in member
        .excluded_bundle_ids
        .iter()
        .chain(&org.excluded_bundle_ids)
    {
        if contains_ci(&seen, id) {
            continue;
        }
        seen.push(id.clone());
        apps.push(json!({"bundle_id": id, "name": name_of(id), "by_org": contains_ci(&org.excluded_bundle_ids, id)}));
    }
    let org_domains: Vec<String> = org
        .excluded_domains
        .iter()
        .filter_map(|d| normalize_domain_input(d))
        .collect();
    let mut domains: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for d in member.excluded_domains.iter().chain(&org_domains) {
        if contains_ci(&seen, d) {
            continue;
        }
        seen.push(d.clone());
        domains.push(json!({"domain": d, "by_org": contains_ci(&org_domains, d)}));
    }
    let excluded_ids = effective.effective_excluded_bundle_ids();
    let excluded_domains = effective.effective_excluded_domains();
    json!({
        "groups": groups,
        "excluded_apps": apps,
        "excluded_domains": domains,
        "private_browsing": {"excluded": effective.exclude_private_browsing, "by_org": org.exclude_private_browsing},
        "recent_apps": recent_apps.iter().map(|a| json!({
            "bundle_id": a.bundle_id, "name": a.name, "last_seen_ms": a.last_seen_ms,
            "excluded": contains_ci(&excluded_ids, &a.bundle_id),
        })).collect::<Vec<_>>(),
        "recent_domains": recent_domains.iter().map(|d| json!({
            "domain": d.domain, "last_seen_ms": d.last_seen_ms,
            "excluded": excluded_domains.iter().any(|e| domain_covers(e, &d.domain)),
        })).collect::<Vec<_>>(),
        "frontmost": frontmost.map(|(bundle_id, name)| json!({"bundle_id": bundle_id, "name": name})),
    })
}

/// At most this many recent apps and websites in the report.
const RECENT: i64 = 50;

/// Recorded apps and websites, newest first, from the library (empty without one).
fn recent(paths: &MemoryPaths) -> (Vec<RecentApp>, Vec<RecentDomain>) {
    let Ok(conn) = super::store::open_readonly(paths) else {
        return (Vec::new(), Vec::new());
    };
    // A segment is one focus run; its first frame dates it. Grouping segments,
    // not frames, keeps this cheap on a library with millions of frames.
    let apps = conn
        .prepare(
            "SELECT x.bundle_id, x.name, f.timestamp FROM (
               SELECT a.bundle_id, MAX(COALESCE(a.display_name, a.bundle_id)) AS name, MAX(s.start_frame_id) AS last
               FROM segment s JOIN application a ON a.id = s.application GROUP BY a.bundle_id
             ) x JOIN frame f ON f.id = x.last ORDER BY f.timestamp DESC LIMIT ?1",
        )
        .and_then(|mut st| {
            st.query_map([RECENT], |r| {
                let name: String = r.get(1)?;
                Ok(RecentApp { bundle_id: r.get(0)?, name: clean_name(&name), last_seen_ms: r.get(2)? })
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    let domains = conn
        .prepare(
            "SELECT x.domain, f.timestamp FROM (
               SELECT d.normalized_domain AS domain, MAX(s.start_frame_id) AS last
               FROM segment s JOIN domain d ON d.id = s.domain GROUP BY d.normalized_domain
             ) x JOIN frame f ON f.id = x.last ORDER BY f.timestamp DESC LIMIT ?1",
        )
        .and_then(|mut st| {
            st.query_map([RECENT], |r| {
                Ok(RecentDomain {
                    domain: r.get(0)?,
                    last_seen_ms: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    (apps, domains)
}

/// A display name without the invisible direction marks some apps carry
/// (WhatsApp's is U+200E + "WhatsApp").
fn clean_name(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// The app in front right now: (bundle id, name). macOS only; None elsewhere.
pub fn frontmost() -> Option<(String, String)> {
    #[cfg(target_os = "macos")]
    {
        let run = |args: &[&str]| {
            std::process::Command::new("/usr/bin/lsappinfo")
                .args(args)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        };
        let asn = run(&["front"]).filter(|a| !a.is_empty())?;
        let info = run(&["info", "-only", "bundleid", "-only", "name", &asn])?;
        let field = |key: &str| {
            info.lines()
                .find_map(|l| l.trim().strip_prefix(&format!("\"{key}\"=")))
                .map(|v| v.trim_matches('"').to_string())
                .filter(|v| !v.is_empty() && v != "[ NULL ]")
        };
        let id = field("CFBundleIdentifier")?;
        let name = field("LSDisplayName")
            .map(|n| clean_name(&n))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.clone());
        Some((id, name))
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// `kortix-capture exclusions`: the report for this library.
pub fn report(paths: &MemoryPaths) -> Value {
    let (apps, domains) = recent(paths);
    report_from(
        &Settings::load(paths),
        &Settings::effective(paths),
        &apps,
        &domains,
        frontmost(),
    )
}

/// `kortix-capture exclude|include`: change the person's settings and save them.
pub fn set(paths: &MemoryPaths, target: &Target, excluded: bool) -> Result<()> {
    let org = org_of(&Settings::effective(paths));
    let mut s = Settings::load(paths);
    change(&mut s, &org, target, excluded)?;
    s.validate()?;
    s.save(paths)
}

/// The frontmost app as a target. Refuses Kortix itself (the app the person is
/// using to exclude, or the host the service runs in).
pub fn frontmost_target(paths: &MemoryPaths) -> Result<Target> {
    let Some((id, name)) = frontmost() else {
        bail!("no app is in front (or this OS does not say which)");
    };
    if is_own_app(&id, &Settings::effective(paths).own_bundle_ids) {
        bail!("Kortix ({name}) is in front; bring the app to exclude to the front first");
    }
    Ok(Target::App(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/capture-format-v2/domains.json"
        );
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// The one domain rule: the shared vectors every matcher runs.
    #[test]
    fn domains_follow_the_shared_vectors() {
        let v = vectors();
        for c in v["patterns"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            assert_eq!(
                normalize_domain_input(input).as_deref(),
                c["pattern"].as_str(),
                "pattern {input:?}"
            );
        }
        for c in v["matches"].as_array().unwrap() {
            let (url, pattern) = (c["url"].as_str().unwrap(), c["pattern"].as_str().unwrap());
            assert_eq!(
                url_excluded(url, &[pattern.to_string()]),
                c["match"].as_bool().unwrap(),
                "{url} vs {pattern}"
            );
        }
    }

    /// Every pattern a matcher receives is already normalized, whatever wrote it.
    #[test]
    fn effective_domains_are_normalized_and_the_proton_entry_is_a_host() {
        let mut s = crate::memory::settings::Settings::default();
        s.excluded_domains = vec!["https://www.Bank.example/login".into(), "notadomain".into()];
        s.enabled_exclusion_groups = vec!["password_managers".into()];
        let d = s.effective_excluded_domains();
        assert!(d.contains(&"bank.example".to_string()));
        assert!(!d
            .iter()
            .any(|p| p == "notadomain" || p.contains('/') || p.starts_with("www.")));
        assert!(d.contains(&"pass.proton.me".to_string()));
    }

    fn front_of(bundle_id: &str) -> Front {
        Front {
            bundle_id: bundle_id.into(),
            url: None,
            title: "Kortix Capture".into(),
        }
    }

    #[test]
    fn kortix_never_records_its_own_windows() {
        let mut s = Settings::default();
        s.own_bundle_ids = vec!["com.example.Host".into()];
        for own in [
            "com.kortix.desktop",
            "com.kortix.desktop.capturetest",
            "ai.kortix.capture",
            "COM.EXAMPLE.HOST",
        ] {
            assert_eq!(
                excluded_reason(&s, &front_of(own)),
                Some("own_app"),
                "{own}"
            );
            assert!(is_own_app(own, &s.own_bundle_ids), "{own}");
        }
        assert_eq!(excluded_reason(&s, &front_of("com.apple.Safari")), None);
        assert!(!is_own_app("com.kortixfan.app", &s.own_bundle_ids));
    }

    #[test]
    fn the_effective_settings_know_the_service_host() {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kx-own-{}", uuid::Uuid::new_v4().simple())),
        );
        paths.ensure().unwrap();
        super::super::service::write_host(
            &paths,
            &super::super::service::Host {
                command: "/Applications/Kortix Capture Test.app/Contents/MacOS/Kortix Capture Test"
                    .into(),
                bundle_id: Some("com.kortix.desktop.capturetest".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let own = Settings::effective(&paths).own_bundle_ids;
        assert!(own.contains(&"com.kortix.desktop.capturetest".to_string()));
        assert!(
            own.contains(&"kortix capture test".to_string()),
            "the host executable (Windows and Linux name apps by it)"
        );
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    fn org(apps: &[&str], domains: &[&str], groups: &[&str], private: bool) -> PolicyPrivacy {
        PolicyPrivacy {
            excluded_bundle_ids: apps.iter().map(|s| s.to_string()).collect(),
            excluded_domains: domains.iter().map(|s| s.to_string()).collect(),
            exclusion_groups: groups.iter().map(|s| s.to_string()).collect(),
            exclude_private_browsing: private,
            ..Default::default()
        }
    }

    #[test]
    fn recent_apps_and_websites_come_newest_first_from_the_library() {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kortix-excl-{}", uuid::Uuid::new_v4())),
        );
        assert!(recent(&paths).0.is_empty(), "no library, no rows, no error");
        let conn = super::super::store::open(&paths).unwrap();
        conn.execute_batch(
            "INSERT INTO application (id, bundle_id, display_name) VALUES (1, 'com.old', 'Old'), (2, 'com.new', '\u{200e}New');
             INSERT INTO domain (id, normalized_domain) VALUES (1, 'old.example'), (2, 'new.example');
             INSERT INTO frame (id, timestamp) VALUES (10, 1000), (11, 2000), (12, 3000);
             INSERT INTO segment (id, start_frame_id, application, domain) VALUES
               (1, 10, 1, 1), (2, 11, 2, NULL), (3, 12, 1, 2);",
        )
        .unwrap();
        drop(conn);
        let (apps, domains) = recent(&paths);
        let apps: Vec<(&str, &str, i64)> = apps
            .iter()
            .map(|a| (a.bundle_id.as_str(), a.name.as_str(), a.last_seen_ms))
            .collect();
        assert_eq!(
            apps,
            vec![("com.old", "Old", 3000), ("com.new", "New", 2000)]
        );
        let domains: Vec<(&str, i64)> = domains
            .iter()
            .map(|d| (d.domain.as_str(), d.last_seen_ms))
            .collect();
        assert_eq!(domains, vec![("new.example", 3000), ("old.example", 1000)]);
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn an_excluded_app_in_front_is_named_by_the_app() {
        let mut s = Settings::default();
        s.excluded_bundle_ids = vec!["com.front".into()];
        let v = report_from(&s, &s, &[], &[], Some(("com.front".into(), "Front".into())));
        assert_eq!(v["excluded_apps"][0]["name"], json!("Front"));
    }

    #[test]
    fn app_names_drop_invisible_direction_marks() {
        assert_eq!(clean_name("\u{200e}WhatsApp"), "WhatsApp");
        assert_eq!(clean_name(" Ghostty\u{feff}"), "Ghostty");
    }

    #[test]
    fn domains_normalize_from_anything_a_person_types() {
        for (raw, want) in [
            ("https://www.Example.com/a?b#c", Some("example.com")),
            ("www.example.com", Some("example.com")),
            ("Example.com/path", Some("example.com")),
            ("  mail.Example.com.  ", Some("mail.example.com")),
            ("http://user@host.example:8080/", Some("host.example")),
            ("", None),
            ("   ", None),
            ("ftp://example.com", None),
            ("not a domain", None),
        ] {
            assert_eq!(normalize_domain_input(raw).as_deref(), want, "{raw:?}");
        }
    }

    #[test]
    fn exclude_and_include_edit_the_persons_lists() {
        let mut s = Settings::default();
        let none = PolicyPrivacy::default();
        change(
            &mut s,
            &none,
            &Target::App("com.example.Secret".into()),
            true,
        )
        .unwrap();
        change(
            &mut s,
            &none,
            &Target::App("com.example.secret".into()),
            true,
        )
        .unwrap();
        assert_eq!(s.excluded_bundle_ids, vec!["com.example.Secret"]);
        change(
            &mut s,
            &none,
            &Target::Domain("https://www.Bank.example/x".into()),
            true,
        )
        .unwrap();
        assert_eq!(s.excluded_domains, vec!["bank.example"]);
        change(&mut s, &none, &Target::Group("banking".into()), true).unwrap();
        assert!(s.enabled_exclusion_groups.contains(&"banking".to_string()));
        change(&mut s, &none, &Target::PrivateBrowsing, false).unwrap();
        assert!(!s.exclude_private_browsing);

        change(
            &mut s,
            &none,
            &Target::App("COM.EXAMPLE.SECRET".into()),
            false,
        )
        .unwrap();
        change(&mut s, &none, &Target::Domain("bank.example".into()), false).unwrap();
        change(&mut s, &none, &Target::Group("banking".into()), false).unwrap();
        change(&mut s, &none, &Target::PrivateBrowsing, true).unwrap();
        assert!(s.excluded_bundle_ids.is_empty() && s.excluded_domains.is_empty());
        assert!(!s.enabled_exclusion_groups.contains(&"banking".to_string()));
        assert!(s.exclude_private_browsing);
        s.validate().unwrap();
    }

    #[test]
    fn bad_input_is_refused_with_its_reason() {
        let mut s = Settings::default();
        let none = PolicyPrivacy::default();
        let err = |t: Target| {
            change(&mut s.clone(), &none, &t, true)
                .unwrap_err()
                .to_string()
        };
        assert!(err(Target::Group("nope".into())).contains("unknown group nope"));
        assert!(err(Target::Domain("not a domain".into())).contains("not a website"));
        assert!(err(Target::App("  ".into())).contains("bundle id"));
        // Recording again an app a group of the person's own still excludes says which group.
        s.enabled_exclusion_groups = vec!["password_managers".into()];
        let e = change(
            &mut s,
            &none,
            &Target::App("com.1password.1password".into()),
            false,
        )
        .unwrap_err();
        assert!(e.to_string().contains("Password managers"), "{e}");
    }

    #[test]
    fn what_the_organization_excludes_cannot_be_recorded_again() {
        let o = org(
            &["com.example.Secret"],
            &["bank.example"],
            &["banking"],
            true,
        );
        let mut s = Settings::default();
        for (t, what) in [
            (
                Target::App("com.example.secret".into()),
                "com.example.secret",
            ),
            (Target::Domain("www.bank.example".into()), "bank.example"),
            (Target::Group("banking".into()), "Banking and finance"),
            (Target::PrivateBrowsing, "Private browsing"),
        ] {
            let e = change(&mut s, &o, &t, false).unwrap_err().to_string();
            assert_eq!(e, format!("{what} is excluded by your organization"));
        }
        // A website under an organization domain is covered by it too.
        let e = change(
            &mut s,
            &o,
            &Target::Domain("login.bank.example".into()),
            false,
        )
        .unwrap_err();
        assert!(e.to_string().ends_with("is excluded by your organization"));
        // Excluding more is always allowed.
        change(&mut s, &o, &Target::App("com.example.Secret".into()), true).unwrap();
    }

    #[test]
    fn the_report_names_each_exclusion_and_who_owns_it() {
        let mut member = Settings::default();
        member.excluded_bundle_ids = vec!["com.mine.app".into()];
        member.excluded_domains = vec!["mine.example".into()];
        member.enabled_exclusion_groups = vec!["password_managers".into()];
        member.exclude_private_browsing = false;
        let mut effective = member.clone();
        let policy = super::super::policy::Policy {
            privacy: org(&["com.org.app"], &["org.example"], &["banking"], true),
            ..Default::default()
        };
        policy.apply(&mut effective);
        let apps = [
            RecentApp {
                bundle_id: "com.mine.app".into(),
                name: "Mine".into(),
                last_seen_ms: 30,
            },
            RecentApp {
                bundle_id: "com.other".into(),
                name: "Other".into(),
                last_seen_ms: 20,
            },
            RecentApp {
                bundle_id: "com.1password.1password".into(),
                name: "1Password".into(),
                last_seen_ms: 10,
            },
        ];
        let domains = [
            RecentDomain {
                domain: "sub.org.example".into(),
                last_seen_ms: 5,
            },
            RecentDomain {
                domain: "news.example".into(),
                last_seen_ms: 4,
            },
        ];
        let v = report_from(
            &member,
            &effective,
            &apps,
            &domains,
            Some(("com.other".into(), "Other".into())),
        );

        let groups = v["groups"].as_array().unwrap();
        let ids: Vec<&str> = groups.iter().map(|g| g["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["password_managers", "messaging", "banking"]);
        let pm = &groups[0];
        assert_eq!(
            (pm["enabled"].as_bool(), pm["by_org"].as_bool()),
            (Some(true), Some(false))
        );
        assert!(pm["apps"].as_u64().unwrap() > 0 && pm["description"].as_str().unwrap().len() > 10);
        assert_eq!(
            (
                groups[2]["enabled"].as_bool(),
                groups[2]["by_org"].as_bool()
            ),
            (Some(true), Some(true))
        );
        assert_eq!(groups[1]["enabled"], json!(false));

        assert_eq!(
            v["excluded_apps"],
            json!([
                {"bundle_id": "com.mine.app", "name": "Mine", "by_org": false},
                {"bundle_id": "com.org.app", "name": "com.org.app", "by_org": true},
            ])
        );
        assert_eq!(
            v["excluded_domains"],
            json!([{"domain": "mine.example", "by_org": false}, {"domain": "org.example", "by_org": true}])
        );
        assert_eq!(
            v["private_browsing"],
            json!({"excluded": true, "by_org": true})
        );
        assert_eq!(
            v["recent_apps"],
            json!([
                {"bundle_id": "com.mine.app", "name": "Mine", "last_seen_ms": 30, "excluded": true},
                {"bundle_id": "com.other", "name": "Other", "last_seen_ms": 20, "excluded": false},
                {"bundle_id": "com.1password.1password", "name": "1Password", "last_seen_ms": 10, "excluded": true},
            ])
        );
        assert_eq!(
            v["recent_domains"],
            json!([
                {"domain": "sub.org.example", "last_seen_ms": 5, "excluded": true},
                {"domain": "news.example", "last_seen_ms": 4, "excluded": false},
            ])
        );
        assert_eq!(
            v["frontmost"],
            json!({"bundle_id": "com.other", "name": "Other"})
        );
        assert_eq!(
            report_from(&member, &member, &[], &[], None)["frontmost"],
            Value::Null
        );
    }

    #[test]
    fn record_only_included_records_included_apps_and_sites_and_exclusions_win() {
        let mut s = Settings::default();
        let front = |b: &str, url: Option<&str>| Front {
            bundle_id: b.into(),
            url: url.map(str::to_string),
            title: String::new(),
        };
        assert_eq!(excluded_reason(&s, &front("com.spotify.client", None)), None, "off: everything");
        s.record_only_included = true;
        s.included_bundle_ids = vec!["com.tinyspeck.slackmacgap".into()];
        s.included_domains = vec!["https://www.GitHub.com/x".into()];
        assert_eq!(excluded_reason(&s, &front("com.spotify.client", None)), Some("not_included"));
        assert_eq!(excluded_reason(&s, &front("com.tinyspeck.slackmacgap", None)), None);
        assert_eq!(excluded_reason(&s, &front("com.google.chrome", Some("https://docs.github.com/a"))), None);
        assert_eq!(
            excluded_reason(&s, &front("com.google.chrome", Some("https://youtube.com/watch"))),
            Some("not_included")
        );
        s.excluded_bundle_ids = vec!["com.tinyspeck.slackmacgap".into()];
        assert_eq!(
            excluded_reason(&s, &front("com.tinyspeck.slackmacgap", None)),
            Some("excluded_app"),
            "an exclusion wins"
        );
    }

}
