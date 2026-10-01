//! `kortix-capture` command surface.
//!
//! Read commands (list, usage, query, now, grab-screen, install-skill)
//! serve people and agents; recorder commands (record, status, pause, resume,
//! settings, storage, permissions) control the recorder.

use super::engine::Engine;
use super::paths::MemoryPaths;
use super::recorder::{self, RecorderStatus};
use super::settings::Settings;
use super::store::{self, now_ms};
use super::{query, retention};
use anyhow::{bail, Result};
use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

pub const TIMERANGE_HELP: &str = "Restrict to a timerange (default: all time). Accepts: ISO dates (2026-01-15 = whole day), \
ISO date ranges (2026-01-01|2026-01-31), ISO datetimes (2026-01-01T09:00|2026-01-31T17:00), or since:/before: bounds \
(since:2026-01-01, before:2026-06-01), combinable with |";

#[derive(Parser, Debug)]
#[command(
    name = "kortix-capture",
    version,
    about = "Kortix Capture: everything on your screen, searchable by you and your agents.",
    long_about = "Kortix Capture captures a screenshot about every 2 seconds, extracts its text, and keeps a \
local searchable library.\n\nCommands: list (identifiers), usage (aggregates), query (data points), now (context bundle), \
grab-screen, install-skill. Recorder: record, status, pause, resume, settings, storage, permissions.\n\n\
Timestamps are ISO-8601 in local time (2026-01-15T09:30 or 2026-01-15T09:30:45)."
)]
pub struct Cli {
    /// Output JSON instead of the compact format.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Retrieve available identifiers (application bundle IDs, domains) for use as filters.
    #[command(subcommand)]
    List(ListCommand),
    /// Compute aggregate screen-time statistics.
    #[command(subcommand)]
    Usage(UsageCommand),
    /// Search frames, retrieve frame metadata/OCR/images, and sample activity.
    #[command(subcommand)]
    Query(QueryCommand),
    /// What's on screen right now plus the last few minutes of activity — a context bundle for AI agents.
    Now(NowArgs),
    /// Capture the current screen immediately.
    GrabScreen(GrabScreenArgs),
    /// Install the Kortix Capture skill for AI coding agents.
    InstallSkill(InstallSkillArgs),
    /// Print the version.
    Version,

    /// Run the recorder in the foreground. Records only while the Kortix API allows it (see --local).
    Record(RecordArgs),
    /// Recorder state, permissions, library size.
    Status,
    /// Check (or request) Screen Recording and Accessibility permissions.
    Permissions(PermissionsArgs),
    /// Pause recording (default: 1 hour).
    Pause(PauseArgs),
    /// Resume recording.
    Resume,
    /// Show or change settings.
    Settings(SettingsArgs),
    /// Storage usage and retention.
    #[command(subcommand)]
    Storage(StorageCommand),
}

#[derive(Args, Debug, Clone, Default)]
pub struct Filters {
    #[arg(long = "tr", visible_alias = "timerange", help = TIMERANGE_HELP)]
    pub tr: Option<String>,
    /// Filter by application bundle ID (repeatable, OR logic). Automatches: safari -> com.apple.Safari.
    #[arg(long = "app-filter")]
    pub app_filter: Vec<String>,
    /// Filter by domain (repeatable, OR logic).
    #[arg(long = "domain-filter")]
    pub domain_filter: Vec<String>,
}

#[derive(Args, Debug, Clone, Default)]
pub struct TrOnly {
    #[arg(long = "tr", visible_alias = "timerange", help = TIMERANGE_HELP)]
    pub tr: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum ListCommand {
    /// All recorded application bundle IDs with display names.
    Applications,
    /// All recorded web domains (normalized).
    Domains,
}

#[derive(Subcommand, Debug)]
pub enum UsageCommand {
    /// Total recorded screen time.
    Time(Filters),
    /// Rank applications by recorded time.
    TopApplications {
        #[command(flatten)]
        tr: TrOnly,
        /// Maximum number of results.
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// Rank web domains by recorded time.
    TopDomains {
        #[command(flatten)]
        tr: TrOnly,
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// Screen time for one application.
    Application {
        bundle_id: String,
        #[command(flatten)]
        tr: TrOnly,
    },
    /// Screen time for one domain.
    Domain {
        domain: String,
        #[command(flatten)]
        tr: TrOnly,
    },
    /// Continuous recording blocks split at gaps. --gap 10 surfaces breaks, --gap 300 day boundaries.
    Sessions {
        #[command(flatten)]
        filters: Filters,
        /// Minimum gap between sessions in minutes (minimum 1).
        #[arg(long, default_value_t = 5)]
        gap: u64,
    },
}

#[derive(Args, Debug, Clone)]
pub struct FrameSelector {
    /// Point-in-time ISO-8601 timestamp(s), comma-separated.
    #[arg(long = "ts", visible_alias = "timestamp", conflicts_with = "id")]
    pub ts: Option<String>,
    /// Frame ID(s), comma-separated.
    #[arg(long = "id", visible_alias = "frame-id")]
    pub id: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum QueryCommand {
    /// FTS5 search over OCR text and titles: AND (implicit), OR, NOT, "phrase", prefix*, parentheses.
    Fts {
        query: String,
        #[command(flatten)]
        filters: Filters,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Stratified sample: one representative frame per activity segment.
    Sample {
        #[command(flatten)]
        filters: Filters,
        /// Minimum frames to count a segment as relevant.
        #[arg(long = "min-seg-len", default_value_t = 10)]
        min_seg_len: i64,
    },
    /// Chronological frames spaced apart in both time and OCR content (keep --tr short, ~30 min).
    Cover {
        #[command(flatten)]
        filters: Filters,
        /// Minimum TF-IDF cosine distance from the last 5 selected frames [0, 1].
        #[arg(long = "min-difference-text", default_value_t = 0.2)]
        min_difference_text: f64,
        /// Minimum seconds between consecutive selected frames.
        #[arg(long = "min-difference-seconds", default_value_t = 10.0)]
        min_difference_seconds: f64,
    },
    /// Frame metadata by timestamp or ID; --show-ocr adds OCR text grouped by window.
    Frame {
        #[command(flatten)]
        sel: FrameSelector,
        #[arg(long = "show-ocr")]
        show_ocr: bool,
    },
    /// OCR boxes with text and pixel coordinates.
    Ocrboxes {
        #[command(flatten)]
        sel: FrameSelector,
    },
    /// Export frame screenshots as PNG to the temp dir; prints paths.
    Image {
        #[command(flatten)]
        sel: FrameSelector,
        /// Crop to the focused window.
        #[arg(long)]
        crop: bool,
    },
    /// Captured accessibility tree of the focused app (XML by default).
    Axtree {
        #[command(flatten)]
        sel: FrameSelector,
        #[arg(long)]
        raw: bool,
        #[arg(long)]
        human: bool,
        #[arg(long = "include-hidden")]
        include_hidden: bool,
        #[arg(long)]
        coords: bool,
        #[arg(long = "no-collapse")]
        no_collapse: bool,
        #[arg(long = "text-only")]
        text_only: bool,
        #[arg(long = "max-depth")]
        max_depth: Option<usize>,
        #[arg(long = "role", num_args = 1..)]
        role: Vec<String>,
    },
}

#[derive(Args, Debug)]
pub struct NowArgs {
    /// Minutes of activity to include (1–240).
    #[arg(long, default_value_t = 10)]
    pub minutes: u64,
    /// Cap on compact output in UTF-8 bytes; oldest segments dropped first. JSON is never capped.
    #[arg(long = "max-chars", default_value_t = 6000)]
    pub max_chars: usize,
    /// Seconds to wait on each query (0.5–60).
    #[arg(long, default_value_t = 3.0)]
    pub timeout: f64,
}

#[derive(Args, Debug)]
pub struct GrabScreenArgs {
    /// Run OCR on the captured image and include the text.
    #[arg(long = "show-ocr")]
    pub show_ocr: bool,
}

#[derive(Args, Debug)]
pub struct InstallSkillArgs {
    /// claude | codex | cursor | all
    pub agent: String,
    /// Install into this directory instead of the agent's default.
    #[arg(long)]
    pub directory: Option<String>,
}

#[derive(Args, Debug)]
pub struct RecordArgs {
    /// Stop after this many seconds (testing).
    #[arg(long)]
    pub duration: Option<u64>,
    /// Development: record without the Kortix API gate and without uploads.
    #[arg(long)]
    pub local: bool,
}

#[derive(Args, Debug)]
pub struct PermissionsArgs {
    /// Show the macOS permission prompts.
    #[arg(long)]
    pub request: bool,
}

#[derive(Args, Debug)]
pub struct PauseArgs {
    /// Duration: 15m, 1h, 8h, 1d, or 'forever' (same as disabling recording).
    #[arg(long = "for", default_value = "1h")]
    pub duration: String,
}

#[derive(Args, Debug)]
pub struct SettingsArgs {
    /// Dotted key to read or set, e.g. storage.limit_gb.
    pub key: Option<String>,
    /// New value (JSON literal or plain string).
    pub value: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum StorageCommand {
    /// Bytes used by the library.
    Usage,
    /// What the current storage policy would affect.
    Preview,
    /// Apply the storage policy now.
    Enforce,
}


pub fn print(value: &Value, json_out: bool, compact: impl FnOnce(&Value) -> String) {
    if json_out {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
    } else {
        let text = compact(value);
        if !text.is_empty() {
            println!("{text}");
        }
    }
}

pub fn run(cli: Cli) -> Result<()> {
    let paths = MemoryPaths::resolve();
    let json_out = cli.json;
    match cli.command {
        Command::List(c) => query::list(&paths, c, json_out),
        Command::Usage(c) => query::usage(&paths, c, json_out),
        Command::Query(c) => query::query(&paths, c, json_out),
        Command::Now(a) => query::now(&paths, a, json_out),
        Command::GrabScreen(a) => query::grab_screen(&paths, a, json_out),
        Command::InstallSkill(a) => query::install_skill(a, json_out),
        Command::Version => {
            println!("kortix-capture {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Command::Record(a) => record(paths, a),
        Command::Status => status(&paths, json_out),
        Command::Permissions(a) => permissions(a, json_out),
        Command::Pause(a) => pause(&paths, a, json_out),
        Command::Resume => resume(&paths, json_out),
        Command::Settings(a) => settings(&paths, a, json_out),
        Command::Storage(c) => storage(&paths, c, json_out),
    }
}

fn record(paths: MemoryPaths, a: RecordArgs) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        ctrlc::set_handler(move || stop.store(true, std::sync::atomic::Ordering::SeqCst))?;
    }
    if let Some(secs) = a.duration {
        let stop = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    if let Some(pid) = std::env::var(recorder::PARENT_PID_ENV).ok().and_then(|v| v.trim().parse::<u32>().ok()) {
        let stop = stop.clone();
        std::thread::spawn(move || recorder::stop_when_gone(pid, stop, Duration::from_secs(2)));
    }
    eprintln!("kortix-capture: recording into {}", paths.root.display());
    recorder::run(paths, stop, a.local)
}

fn human_bytes(b: u64) -> String {
    let gb = b as f64 / 1e9;
    if gb >= 1.0 {
        format!("{gb:.2} GB")
    } else {
        format!("{:.1} MB", b as f64 / 1e6)
    }
}

pub fn status_value(paths: &MemoryPaths) -> Value {
    let st = RecorderStatus::read(paths);
    let live = st.as_ref().map(RecorderStatus::is_live).unwrap_or(false);
    let settings = Settings::load(paths);
    let usage = retention::usage(paths);
    let counts = store::open_readonly(paths).ok().map(|c| {
        let q = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        json!({
            "frames": q("SELECT count(*) FROM frame"),
            "videos": q("SELECT count(*) FROM video WHERE status < 2"),
            "uploads_pending": q("SELECT count(*) FROM video WHERE status < 2 AND uploaded_at IS NULL"),
            "uploaded": q("SELECT count(*) FROM video WHERE uploaded_at IS NOT NULL"),
            "ocr_pending": q("SELECT count(*) FROM frame WHERE ocr_status = 0"),
            "first_frame_ms": q("SELECT COALESCE(min(timestamp), 0) FROM frame"),
            "last_frame_ms": q("SELECT COALESCE(max(timestamp), 0) FROM frame"),
        })
    });
    json!({
        "library": paths.root,
        "recorder_running": live,
        "recorder": st,
        "upload": st.as_ref().and_then(|s| s.upload.clone()),
        "effective_state": if live { st.as_ref().map(|s| s.state.clone()) } else { Some("not_running".to_string()) },
        "recording_enabled": settings.recording_enabled,
        "paused_until_ms": settings.paused_until_ms.filter(|t| *t > now_ms()),
        "usage": usage,
        "usage_total_bytes": usage.total(),
        "limit_bytes": (settings.storage.limit_gb * 1e9) as i64,
        "counts": counts,
    })
}

fn status(paths: &MemoryPaths, json_out: bool) -> Result<()> {
    let v = status_value(paths);
    print(&v, json_out, |v| {
        let mut out = vec![
            format!("library   {}", v["library"].as_str().unwrap_or("")),
            format!("recorder  {}", v["effective_state"].as_str().unwrap_or("unknown")),
        ];
        if let Some(r) = v["recorder"]["reason"].as_str() {
            out.push(format!("reason    {r}"));
        }
        if let Some(e) = v["recorder"]["last_error"].as_str() {
            out.push(format!("error     {e}"));
        }
        if let Some(c) = v.get("counts").filter(|c| !c.is_null()) {
            out.push(format!(
                "frames    {} ({} videos, {} awaiting OCR)",
                c["frames"], c["videos"], c["ocr_pending"]
            ));
        }
        if let Some(u) = v.get("upload").filter(|u| !u.is_null()) {
            out.push(format!(
                "upload    {} pending, last ok {}",
                u["pending"],
                u["last_success_at"].as_str().unwrap_or("never")
            ));
            if let Some(e) = u["last_error"].as_str() {
                out.push(format!("upload error  {e}"));
            }
        }
        out.push(format!(
            "storage   {} of {}",
            human_bytes(v["usage_total_bytes"].as_u64().unwrap_or(0)),
            human_bytes(v["limit_bytes"].as_u64().unwrap_or(0))
        ));
        out.join("\n")
    });
    Ok(())
}

fn permissions(a: PermissionsArgs, json_out: bool) -> Result<()> {
    let mut engine = Engine::new()?;
    let cmd = if a.request { "request_permissions" } else { "permissions" };
    let v = engine.request(json!({"cmd": cmd}), Duration::from_secs(60))?;
    print(&v, json_out, |v| {
        format!(
            "screen recording  {}\naccessibility     {}",
            if v["screen"].as_bool() == Some(true) { "granted" } else { "missing" },
            if v["accessibility"].as_bool() == Some(true) { "granted" } else { "missing" }
        )
    });
    Ok(())
}

/// "15m" | "1h" | "8h" | "1d" | "90s" -> milliseconds.
pub fn parse_duration_ms(s: &str) -> Option<i64> {
    let s = s.trim().to_ascii_lowercase();
    let split = s.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult = match unit.trim() {
        "s" | "sec" | "secs" | "second" | "seconds" => 1_000.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000.0,
        "d" | "day" | "days" => 86_400_000.0,
        _ => return None,
    };
    Some((n * mult) as i64)
}

fn pause(paths: &MemoryPaths, a: PauseArgs, json_out: bool) -> Result<()> {
    let mut s = Settings::load(paths);
    if a.duration == "forever" {
        s.recording_enabled = false;
        s.paused_until_ms = None;
    } else {
        let Some(ms) = parse_duration_ms(&a.duration) else { bail!("invalid duration {:?} (examples: 15m, 1h, 1d)", a.duration) };
        s.paused_until_ms = Some(now_ms() + ms);
    }
    s.save(paths)?;
    let v = json!({"recording_enabled": s.recording_enabled, "paused_until_ms": s.paused_until_ms});
    print(&v, json_out, |_| match s.paused_until_ms {
        Some(t) => format!("paused until {}", chrono::DateTime::from_timestamp_millis(t).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%dT%H:%M").to_string()).unwrap_or_default()),
        None => "recording disabled".into(),
    });
    Ok(())
}

fn resume(paths: &MemoryPaths, json_out: bool) -> Result<()> {
    let mut s = Settings::load(paths);
    s.recording_enabled = true;
    s.paused_until_ms = None;
    s.save(paths)?;
    print(&json!({"recording_enabled": true}), json_out, |_| "recording resumed".into());
    Ok(())
}

fn settings(paths: &MemoryPaths, a: SettingsArgs, json_out: bool) -> Result<()> {
    let s = Settings::load(paths);
    let mut v = serde_json::to_value(&s)?;
    let Some(key) = a.key else {
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    };
    let parts: Vec<&str> = key.split('.').collect();
    match a.value {
        None => {
            let mut cur = &v;
            for p in &parts {
                cur = cur.get(p).ok_or_else(|| anyhow::anyhow!("unknown setting {key}"))?;
            }
            print(cur, json_out, |c| match c {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
        }
        Some(raw) => {
            let new: Value = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
            let mut cur = &mut v;
            for p in &parts[..parts.len() - 1] {
                cur = cur.get_mut(*p).ok_or_else(|| anyhow::anyhow!("unknown setting {key}"))?;
            }
            let last = parts[parts.len() - 1];
            if cur.get(last).is_none() {
                bail!("unknown setting {key}");
            }
            cur[last] = new;
            let updated: Settings = serde_json::from_value(v).map_err(|e| anyhow::anyhow!("invalid value for {key}: {e}"))?;
            updated.save(paths)?;
            print(&json!({"ok": true}), json_out, |_| format!("{key} updated"));
        }
    }
    Ok(())
}

fn storage(paths: &MemoryPaths, c: StorageCommand, json_out: bool) -> Result<()> {
    let s = Settings::load(paths);
    match c {
        StorageCommand::Usage => {
            let u = retention::usage(paths);
            let v = json!({"usage": u, "total_bytes": u.total(), "limit_bytes": (s.storage.limit_gb * 1e9) as i64});
            print(&v, json_out, |_| {
                format!(
                    "database {}\nvideos   {}\nstaged   {}\ntotal    {} of {}",
                    human_bytes(u.db_bytes),
                    human_bytes(u.video_bytes),
                    human_bytes(u.staged_bytes),
                    human_bytes(u.total()),
                    human_bytes((s.storage.limit_gb * 1e9) as u64)
                )
            });
        }
        StorageCommand::Preview => {
            let conn = store::open_readonly(paths)?;
            let v = retention::preview(&conn, paths, &s)?;
            print(&v, true, |_| String::new());
        }
        StorageCommand::Enforce => {
            let conn = store::open(paths)?;
            let mut engine = Engine::new()?;
            retention::enforce(&conn, paths, &mut engine, &s)?;
            let u = retention::usage(paths);
            print(&json!({"total_bytes": u.total()}), json_out, |_| format!("total {}", human_bytes(u.total())));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_parse() {
        assert_eq!(parse_duration_ms("15m"), Some(900_000));
        assert_eq!(parse_duration_ms("1h"), Some(3_600_000));
        assert_eq!(parse_duration_ms("1.5h"), Some(5_400_000));
        assert_eq!(parse_duration_ms("2d"), Some(172_800_000));
        assert_eq!(parse_duration_ms("soon"), None);
    }

    #[test]
    fn cli_parses_query_shapes() {
        let c = Cli::try_parse_from(["kortix-capture", "--json", "query", "fts", "webhook", "--tr", "2026-01-15", "--app-filter", "safari", "--limit", "5"]).unwrap();
        assert!(c.json);
        let c = Cli::try_parse_from(["kortix-capture", "query", "axtree", "--id", "12", "--role", "AXButton", "AXLink"]).unwrap();
        match c.command {
            Command::Query(QueryCommand::Axtree { role, .. }) => assert_eq!(role, vec!["AXButton", "AXLink"]),
            _ => panic!(),
        }
        assert!(Cli::try_parse_from(["kortix-capture", "usage", "sessions", "--gap", "10", "--domain-filter", "github.com"]).is_ok());
    }
}
