//! `kortix-capture` command surface.
//!
//! Read commands (list, usage, query, now, link, grab-screen, install-skill)
//! serve people and agents; recorder commands (record, status, pause, resume,
//! settings, storage, permissions, ui, ask) control the recorder.

use super::engine::Engine;
use super::paths::MemoryPaths;
use super::recorder::{self, RecorderStatus};
use super::settings::Settings;
use super::store::{self, now_ms};
use super::{ask, query, retention, ui};
use anyhow::{bail, Context, Result};
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
link (timeline links), grab-screen, install-skill. Recorder: record, status, pause, resume, settings, storage, permissions, ui, ask. \
Kortix 24/7: login, start, stop, logout, service.\n\n\
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
    /// Mint a kortix-capture:// link that reopens a moment in the timeline.
    #[command(subcommand)]
    Link(LinkCommand),
    /// Capture the current screen immediately.
    GrabScreen(GrabScreenArgs),
    /// Install the Kortix Capture skill for AI coding agents.
    InstallSkill(InstallSkillArgs),
    /// Print the version.
    Version,

    /// Run the recorder in the foreground (the tray and LaunchAgent run this).
    Record(RecordArgs),
    /// Recorder state, permissions, library size.
    Status,
    /// Check (or request) Screen Recording, Accessibility and Microphone permissions.
    Permissions(PermissionsArgs),
    /// Audio memory: input devices and the recorded segments.
    #[command(subcommand)]
    Audio(AudioCommand),
    /// Pause recording (default: 1 hour; `tomorrow` = 6:00 tomorrow; `forever` = until `resume`).
    Pause(PauseArgs),
    /// Resume recording.
    Resume,
    /// Show or change settings.
    Settings(SettingsArgs),
    /// What this computer never records, and the apps and websites it recorded lately.
    Exclusions,
    /// Never record an app, a website, a group of apps or private browser windows.
    #[command(subcommand)]
    Exclude(ExclusionCommand),
    /// Record an app, a website, a group or private browser windows again.
    #[command(subcommand)]
    Include(ExclusionCommand),
    /// Install the local PII model (one asset download), or inspect its status.
    PrivacyModel {
        #[arg(long)]
        install: bool,
    },
    /// Storage usage and retention.
    #[command(subcommand)]
    Storage(StorageCommand),
    /// Cloud sync to S3-compatible storage.
    #[command(subcommand)]
    Sync(SyncCommand),
    /// Open the timeline / search window.
    Ui(UiArgs),
    /// Open a kortix-capture:// link.
    Open { url: String },
    /// Hand a prompt to a coding agent (Claude Code, Codex, Cursor, Kortix) in a terminal.
    Ask(AskArgs),

    /// Sign this computer in to your Kortix organization (`sync setup --provider kortix`).
    /// With --json, prints one JSON line per event: `challenge`, then `signed_in`.
    Login(LoginArgs),
    /// Record 24/7: install the background service if needed and turn it on (survives reboots).
    Start(ServiceHostArgs),
    /// Stop recording 24/7: turn the background service off until `start`.
    Stop,
    /// Quit Kortix Capture: recording, actions and the menu-bar icon stop until you open
    /// the app again or log in again.
    Quit,
    /// Restart Kortix Capture: the background service starts again within ~10 s.
    Restart,
    /// Sign out of Kortix and remove the background service. Recordings stay on this computer.
    Logout,
    /// The background service: install, uninstall, status, run (what the OS starts), render.
    #[command(subcommand)]
    Service(ServiceCommand),
    /// The machine service IT installs (Windows MSI, macOS pkg, Linux deb). It
    /// enrolls each person who uses this computer with the organization's token.
    #[command(subcommand)]
    Machine(MachineCommand),
    /// The menu-bar / notification-area icon: status, the organization's notice,
    /// "Open Kortix Capture", and on a computer the person set up, "Sign in with Kortix…".
    #[command(hide = true)]
    Tray(TrayArgs),
    /// macOS and Linux: what the global launchd agent / systemd user unit runs in
    /// every session. Records for the organization once the machine is configured.
    #[command(hide = true)]
    Agent,
    /// The installer's or the first login's one-time request: open the window on onboarding,
    /// only on a personal install with nothing connected, and only once.
    #[command(hide = true)]
    Onboard(OnboardArgs),
    /// What the Start menu entry, the desktop entry and Finder open: the Kortix
    /// Capture window, with the tray and (once signed in) the 24/7 service behind it.
    #[command(hide = true)]
    App(AppArgs),
}

#[derive(Args, Debug, Default)]
pub struct OnboardArgs {
    /// Print whether onboarding is needed and in which state; open nothing.
    #[arg(long)]
    pub status: bool,
    /// Skip onboarding: keep recordings on this computer, never ask again.
    #[arg(long)]
    pub skip: bool,
}

#[derive(Args, Debug, Default)]
pub struct AppArgs {
    /// Windows: already detached from the console the Start menu shortcut opened.
    #[arg(long)]
    pub detached: bool,
}

#[derive(Args, Debug, Default)]
pub struct TrayArgs {
    /// Started by the desktop's autostart entry: exit when the organization
    /// manages this computer (its agent runs the tray).
    #[arg(long)]
    pub autostart: bool,
}

#[derive(Subcommand, Debug)]
pub enum MachineCommand {
    /// The service itself (the Service Control Manager starts this; from a
    /// console it runs in the foreground until Ctrl-C).
    Run,
    /// The managed configuration (never the token), the service and each session.
    Status,
    /// Windows: write the enrollment token into the policy key (the MSI runs
    /// this). macOS and Linux, as root: write the config file from `--url` and
    /// the token (`--token`, else stdin).
    #[command(hide = true)]
    Configure {
        #[arg(long)]
        token: Option<String>,
        /// The Kortix API origin (macOS and Linux).
        #[arg(long)]
        url: Option<String>,
    },
    /// The update supervisor the machine service starts (installs, proves, rolls back).
    #[command(hide = true)]
    UpdateApply {
        #[arg(long)]
        job: std::path::PathBuf,
    },
    /// As root: forget the versions marked bad, so the service tries the newest release again.
    UpdateReset,
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// Kortix API origin (default: the saved one, then the built-in one).
    #[arg(long)]
    pub issuer: Option<String>,
    /// Do not open the browser; print the approval link instead.
    #[arg(long)]
    pub no_browser: bool,
    /// Hours a device keeps media after its upload (0 = delete at once).
    #[arg(long)]
    pub keep_local_hours: Option<u64>,
}

/// The program the OS service starts. An app that bundles the engine passes
/// itself, so macOS attributes Screen Recording to the app; saved and reused.
#[derive(Args, Debug, Default)]
pub struct ServiceHostArgs {
    /// Host program; the service runs `<host> <host-args…> <this binary> service run`.
    #[arg(long)]
    pub host: Option<String>,
    /// An argument for the host (repeat).
    #[arg(long = "host-arg", allow_hyphen_values = true)]
    pub host_args: Vec<String>,
    /// KEY=VALUE in the service's environment (repeat).
    #[arg(long = "host-env")]
    pub host_env: Vec<String>,
    /// macOS: the host app's bundle id, so Login Items names the app.
    #[arg(long = "host-bundle-id", requires = "host")]
    pub host_bundle_id: Option<String>,
    /// Run the bare binary again, forgetting a saved host.
    #[arg(long, conflicts_with = "host")]
    pub no_host: bool,
}

#[derive(Subcommand, Debug)]
pub enum ServiceCommand {
    /// Write the OS service and turn it on.
    Install(ServiceHostArgs),
    /// Turn the OS service off and remove it.
    Uninstall,
    /// The OS service and the supervisor heartbeat.
    Status,
    /// The supervisor itself (the OS service runs this): keeps the recorder and
    /// the action service running while this library may record.
    Run(ServiceRunArgs),
    /// Print the unit file `install` would write.
    Render(ServiceHostArgs),
}

#[derive(Args, Debug, Default)]
pub struct ServiceRunArgs {
    /// Started by the machine service: record only while the organization's
    /// enrollment stands, keep Kortix sync on, and show the tray notice.
    #[arg(long, hide = true)]
    pub managed: bool,
}

#[derive(Args, Debug)]
pub struct SyncEnrollArgs {
    /// Kortix API origin (default: the saved one, then the built-in one).
    #[arg(long)]
    pub issuer: Option<String>,
    /// The person's user principal name (default: the signed-in OS user's, when it has one).
    #[arg(long)]
    pub principal: Option<String>,
    /// The person's login name (default: the signed-in OS user).
    #[arg(long = "account-name")]
    pub account_name: Option<String>,
}

#[derive(Args, Debug)]
pub struct AskArgs {
    /// The prompt.
    pub prompt: Vec<String>,
    /// claude | codex | cursor | kortix | auto (default: settings agent_routing.agent, else auto).
    #[arg(long)]
    pub agent: Option<String>,
    /// Terminal app to open (default: settings agent_routing.terminal, else the system default).
    #[arg(long)]
    pub terminal: Option<String>,
    /// Print the command instead of launching it.
    #[arg(long = "dry-run")]
    pub dry_run: bool,
    /// List detected agents and suggested prompts.
    #[arg(long)]
    pub list: bool,
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
    /// Stratified sample: one representative frame per activity segment. Requires --tr.
    Sample {
        #[command(flatten)]
        filters: Filters,
        /// Minimum frames to count a segment as relevant.
        #[arg(long = "min-seg-len", default_value_t = 10)]
        min_seg_len: i64,
    },
    /// Chronological frames spaced apart in both time and OCR content (requires --tr; keep it short, ~30 min).
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
    /// Audit which accessibility attribute keys the stored snapshots contain: each key with the
    /// number of tree nodes that carry it. Requires --tr; scans the newest --limit snapshots.
    Axattrs {
        #[command(flatten)]
        filters: Filters,
        /// Maximum snapshots to scan, newest first.
        #[arg(long, default_value_t = 2000)]
        limit: usize,
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

#[derive(Subcommand, Debug)]
pub enum LinkCommand {
    /// Link to this instant.
    Now,
    /// Link to a moment: 'now', '20m', '-2h', '3d ago', or 2026-01-15T09:30.
    At { moment: Vec<String> },
}

#[derive(Args, Debug)]
pub struct GrabScreenArgs {
    /// Run OCR on the captured image and include the text.
    #[arg(long = "show-ocr")]
    pub show_ocr: bool,
}

#[derive(Args, Debug)]
pub struct InstallSkillArgs {
    /// claude | codex | cursor | openclaw | all
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
    /// Stop when stdin closes. The tray holds the other end, so a tray that dies
    /// (crash, force quit) never leaves an invisible recorder behind.
    #[arg(long)]
    pub supervised: bool,
}

#[derive(Args, Debug)]
pub struct PermissionsArgs {
    /// Show the macOS permission prompts.
    #[arg(long)]
    pub request: bool,
    /// With --request: also ask for the Microphone (audio memory).
    #[arg(long)]
    pub microphone: bool,
    /// With --request: ask only for these (screen, accessibility,
    /// input_monitoring, microphone), comma-separated.
    #[arg(long, value_delimiter = ',', value_parser = ["screen", "accessibility", "input_monitoring", "microphone"])]
    pub only: Vec<String>,
}

#[derive(Subcommand, Debug)]
pub enum AudioCommand {
    /// Input devices; pass an id to `settings audio.input_device <id>`.
    Devices,
    /// Recorded audio segments in a timerange, with their transcripts.
    List {
        #[arg(long = "tr", visible_alias = "timerange", help = TIMERANGE_HELP)]
        tr: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
}

#[derive(Args, Debug)]
pub struct PauseArgs {
    /// Duration: 15m, 1h, 8h, 1d, or 'forever' (same as disabling recording).
    #[arg(long = "for", default_value = "1h")]
    pub duration: String,
}

#[derive(Subcommand, Debug)]
pub enum ExclusionCommand {
    /// An app: its bundle id (macOS), executable (Windows) or WM_CLASS (Linux).
    App {
        #[arg(required_unless_present = "frontmost")]
        bundle_id: Option<String>,
        /// The app in front right now (never Kortix itself).
        #[arg(long, conflicts_with = "bundle_id")]
        frontmost: bool,
    },
    /// A website and its subdomains (example.com).
    Domain { domain: String },
    /// A built-in group: password_managers, messaging, banking.
    Group { id: String },
    /// Private and incognito browser windows.
    PrivateBrowsing,
}

#[derive(Args, Debug)]
pub struct SettingsArgs {
    /// Dotted key to read or set, e.g. storage.limit_gb. `resolution` takes 720p, 1080p, 1440p or 4k
    /// (sets max_width and max_height) and reads back `custom` for any other size.
    pub key: Option<String>,
    /// New value (JSON literal or plain string).
    pub value: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum SyncCommand {
    /// Save the S3 target and credentials, verify them, and turn sync on.
    Setup(SyncSetupArgs),
    /// PUT, HEAD and DELETE a probe object.
    Test,
    /// Sync state: queue depth, bytes pending, oldest unsent, throughput, last error and its class.
    Status,
    /// Upload every finished chunk and send queued deletes now, until the queue is empty.
    /// Safe while the recorder runs: one uploader per library, so this waits for the
    /// recorder's current sync pass to finish, then uploads while the recorder skips.
    Now,
    /// Turn sync on (after setup).
    On,
    /// Turn sync off; nothing is deleted.
    Off,
    /// Rebuild this library from the bucket: frames, OCR text, windows, apps, domains, icons.
    /// Videos stay in the bucket and stream on demand. Safe to re-run; present chunks are skipped.
    Restore(SyncRestoreArgs),
    /// List the devices under the bucket prefix.
    Devices,
    /// Forget the Kortix sign-in (the device token and registration) and turn
    /// Kortix sync off. Recordings stay on this computer and in the bucket.
    SignOut,
    /// Enroll this computer with an organization's enrollment token (read from
    /// stdin) instead of a sign-in. Prints `enrolled`, or `pending` until an
    /// admin assigns the person in Kortix.
    Enroll(SyncEnrollArgs),
    /// Store an enrollment the machine service made (JSON on stdin).
    #[command(hide = true)]
    Adopt,
    /// Record the machine service's last enrollment answer for this person (JSON on stdin).
    #[command(hide = true)]
    EnrollmentState,
    /// Print the device token this library holds for the issuer (empty if none). The
    /// machine service sends it as proof when it enrolls an existing device again.
    #[command(hide = true)]
    DeviceToken {
        #[arg(long)]
        issuer: String,
    },
    /// Export or import the client-side encryption key.
    #[command(subcommand)]
    Key(SyncKeyCommand),
}

#[derive(Args, Debug)]
pub struct SyncRestoreArgs {
    /// Restore chunks that end at or after this moment (2026-01-15, 2026-01-15T09:30). Default: everything.
    #[arg(long)]
    pub from: Option<String>,
    /// Device to restore (see `sync devices`). Default: this machine, else the only device in the bucket.
    #[arg(long)]
    pub device: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum SyncKeyCommand {
    /// Print the encryption key (base64). Store it in a password manager: without it, encrypted objects are unreadable.
    Export,
    /// Install an exported key on this machine (needed to restore or play encrypted objects) and turn encryption on.
    Import {
        /// The base64 key printed by `sync key export`.
        key: String,
    },
}

#[derive(Args, Debug)]
pub struct SyncSetupArgs {
    /// `s3`: your own S3-compatible bucket with static credentials. `kortix`: sign in
    /// with Kortix (or any credential issuer) in the browser; the issuer hands out
    /// short-lived credentials for its bucket.
    #[arg(long, default_value = "s3", value_parser = ["s3", "kortix"])]
    pub provider: String,
    /// kortix only: the issuer URL (default: `sync.kortix.url`, else the build's default).
    #[arg(long)]
    pub issuer: Option<String>,
    /// kortix only: print the approval link instead of opening the browser.
    #[arg(long)]
    pub no_browser: bool,
    /// s3: e.g. https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://127.0.0.1:9000
    #[arg(long)]
    pub endpoint: Option<String>,
    /// s3: the bucket.
    #[arg(long)]
    pub bucket: Option<String>,
    #[arg(long, default_value = "us-east-1")]
    pub region: String,
    #[arg(long, default_value = "kortix-capture")]
    pub prefix: String,
    /// Path-style URLs (MinIO and most self-hosted S3).
    #[arg(long)]
    pub path_style: bool,
    /// Keep local video this long after a verified upload (default 0: delete at once).
    #[arg(long)]
    pub keep_local_hours: Option<u64>,
    /// Defaults to KORTIX_CAPTURE_S3_ACCESS_KEY_ID.
    #[arg(long)]
    pub access_key_id: Option<String>,
    /// Defaults to KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY.
    #[arg(long)]
    pub secret_access_key: Option<String>,
    /// Defaults to KORTIX_CAPTURE_S3_SESSION_TOKEN.
    #[arg(long)]
    pub session_token: Option<String>,
    /// Encrypt every object with a local AES-256-GCM key before upload (see `sync key export`).
    #[arg(long)]
    pub encrypt: bool,
}

#[derive(Subcommand, Debug)]
pub enum StorageCommand {
    /// Bytes used by the library.
    Usage,
    /// What the current storage policy would affect.
    Preview,
    /// Apply the storage policy now.
    Enforce,
    /// Delete everything recorded in a timerange: frames, text, video, and (with sync) the
    /// bucket's copies. Whole chunks go, so the removed range can be wider. Dry run without --yes.
    Forget {
        #[arg(long = "tr", visible_alias = "timerange", help = TIMERANGE_HELP)]
        tr: String,
        /// Delete for real.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Args, Debug)]
pub struct UiArgs {
    /// Open straight into search.
    #[arg(long)]
    pub search: bool,
    /// Open the timeline at this moment (same formats as `link at`).
    #[arg(long)]
    pub at: Option<String>,
}

pub fn print(value: &Value, json_out: bool, compact: impl FnOnce(&Value) -> String) {
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_default()
        );
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
        Command::Link(c) => query::link(&paths, c, json_out),
        Command::GrabScreen(a) => query::grab_screen(&paths, a, json_out),
        Command::InstallSkill(a) => query::install_skill(a, json_out),
        Command::Version => {
            println!("kortix-capture {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Command::Record(a) => record(paths, a),
        Command::Status => status(&paths, json_out),
        Command::Permissions(a) => permissions(a, json_out),
        Command::Audio(c) => audio_cmd(&paths, c, json_out),
        Command::Pause(a) => pause(&paths, a, json_out),
        Command::Resume => resume(&paths, json_out),
        Command::Settings(a) => settings(&paths, a, json_out),
        Command::Exclusions => {
            let v = super::exclusions::report(&paths);
            print(&v, json_out, exclusions_text);
            Ok(())
        }
        Command::Exclude(c) => exclusion_cmd(&paths, c, true, json_out),
        Command::Include(c) => exclusion_cmd(&paths, c, false, json_out),
        Command::PrivacyModel { install } => {
            if install {
                super::privacy_model::install_blocking(&paths)?;
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&super::privacy_model::status(&paths))?
            );
            Ok(())
        }
        Command::Storage(c) => storage(&paths, c, json_out),
        Command::Sync(c) => sync_cmd(&paths, c, json_out),
        Command::Ui(a) => ui::run(&paths, a),
        Command::Open { url } => ui::open_url(&paths, &url),
        Command::Ask(a) => ask_cmd(&paths, a, json_out),
        Command::Login(a) => login(&paths, a, json_out),
        Command::Start(a) => {
            let v = service_start(&paths, &a)?;
            print(&v, json_out, |v| {
                if v["managed"] == true {
                    return "recording 24/7 (managed by your organization)".into();
                }
                format!(
                    "recording 24/7 ({})",
                    v["service"]["label"].as_str().unwrap_or("")
                )
            });
            Ok(())
        }
        Command::Stop => {
            let v = service_stop(&paths)?;
            print(&v, json_out, |_| {
                "stopped; stays off until `kortix-capture start`".into()
            });
            Ok(())
        }
        Command::Quit => {
            let v = quit(&paths)?;
            print(&v, json_out, |_| {
                "quit; opening Kortix Capture or the next login starts it again".into()
            });
            Ok(())
        }
        Command::Restart => {
            let v = restart(&paths)?;
            print(&v, json_out, |_| "restarting; recording resumes within ~10 s".into());
            Ok(())
        }
        Command::Logout => {
            let v = logout(&paths)?;
            print(&v, json_out, |_| {
                "signed out; the background service is removed".into()
            });
            Ok(())
        }
        Command::Service(c) => service_cmd(&paths, c, json_out),
        Command::Machine(c) => machine_cmd(c, json_out),
        Command::Tray(a) => super::managed::tray(&paths, a.autostart),
        Command::Onboard(a) => {
            if a.skip {
                super::onboarding::set(&paths, super::onboarding::State::Skipped);
            }
            if a.status || a.skip {
                print(
                    &json!({"needed": super::onboarding::needed_now(&paths), "state": format!("{:?}", super::onboarding::state(&paths)).to_lowercase()}),
                    json_out,
                    |v| format!("onboarding needed: {}", v["needed"]),
                );
                return Ok(());
            }
            if super::onboarding::force_open_once(&paths) {
                super::ui::open_url(&paths, "kortix-capture://timeline")?;
            }
            Ok(())
        }
        Command::Agent => super::managed::agent(&paths),
        Command::App(a) => {
            // A shortcut to a console program opens a console: run again without one.
            if cfg!(windows) && !a.detached {
                let exe = std::env::current_exe()?;
                crate::os_proc::no_window(&mut std::process::Command::new(exe))
                    .args(["app", "--detached"])
                    .spawn()?;
                return Ok(());
            }
            app(&paths)
        }
    }
}

/// Kortix Capture opened from Finder, the Dock, Spotlight, the Start menu or the
/// desktop. It opens the window (the timeline). Behind the window the app is the
/// menu-bar / tray app: the 24/7 service is installed and started at once (the app is
/// its host) and the tray always runs; "Quit" in the tray stops the service until the app opens again. Signing in to Kortix is optional, in Settings. Closing the window leaves the recording and the tray running.
/// On a computer the organization manages, or with a tray already running, it only
/// opens the window (the agent runs the recording and the tray).
pub fn app(paths: &MemoryPaths) -> Result<()> {
    let exe = std::env::current_exe()?;
    let open_window = || {
        crate::os_proc::no_window(&mut std::process::Command::new(&exe))
            .arg("ui")
            .spawn()
    };
    // Earlier installs left agents and processes that fight this one: remove them first.
    super::legacy::remove_legacy();
    super::legacy::migrate_legacy_settings(paths);
    // Something else already records (IT's agent, or a tray that runs): this process only shows
    // the window. It shows it itself, not in a child: macOS lets the process the person
    // launched take focus, and a child of it would open behind the other apps. It holds no
    // recording state, so closing it changes nothing for the recorder.
    let hosted = super::managed::machine_service_installed() || super::managed::tray_running(paths);
    let agent = !hosted && super::legacy::system_agent_installed() && super::legacy::start_system_agent();
    if hosted || agent {
        return super::ui::run(paths, UiArgs { search: false, at: None });
    }
    // Opened by the person and not recording yet: start recording in the background at once.
    service_start(paths, &ServiceHostArgs::default())?;
    let mut window = open_window()?;
    if !super::managed::TRAY_AVAILABLE {
        // No tray on this build: the app lives as long as its window.
        window.wait()?;
        return Ok(());
    }
    super::managed::tray(paths, false)
}

fn machine_cmd(c: MachineCommand, json_out: bool) -> Result<()> {
    match c {
        MachineCommand::Run => super::managed::machine_run(),
        MachineCommand::Configure { token, url } => {
            let token = match token {
                Some(t) => t,
                None => {
                    let mut t = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut t)?;
                    t
                }
            };
            super::managed::machine_configure(url.as_deref(), &token)
        }
        MachineCommand::UpdateApply { job } => super::managed::update::apply(&job),
        MachineCommand::UpdateReset => super::managed::update::reset(),
        MachineCommand::Status => {
            let v = super::managed::machine_status();
            print(&v, json_out, |v| {
                format!(
                    "machine service  {}\nkortix url       {}\nenrollment token {}\nsessions         {}",
                    v["service"].as_str().unwrap_or("not installed"),
                    v["config"]["url"].as_str().unwrap_or("-"),
                    if v["config"]["enrollment_token"] == true { "set" } else { "missing" },
                    v["state"]["sessions"].as_array().map(|a| a.len()).unwrap_or(0),
                )
            });
            Ok(())
        }
    }
}

// ─── Exclusions ──────────────────────────────────────────────────────────────

fn exclusion_cmd(
    paths: &MemoryPaths,
    c: ExclusionCommand,
    excluded: bool,
    json_out: bool,
) -> Result<()> {
    use super::exclusions::Target;
    let target = match c {
        ExclusionCommand::App {
            frontmost: true, ..
        } => super::exclusions::frontmost_target(paths)?,
        ExclusionCommand::App { bundle_id, .. } => Target::App(bundle_id.unwrap_or_default()),
        ExclusionCommand::Domain { domain } => Target::Domain(domain),
        ExclusionCommand::Group { id } => Target::Group(id),
        ExclusionCommand::PrivateBrowsing => Target::PrivateBrowsing,
    };
    super::exclusions::set(paths, &target, excluded)?;
    let what = match &target {
        Target::App(id) => id.clone(),
        Target::Domain(d) => {
            super::exclusions::normalize_domain_input(d).unwrap_or_else(|| d.clone())
        }
        Target::Group(id) => format!("group {id}"),
        Target::PrivateBrowsing => "private browsing".into(),
    };
    print(&json!({"ok": true}), json_out, |_| {
        format!(
            "{what} {}",
            if excluded {
                "excluded"
            } else {
                "recorded again"
            }
        )
    });
    Ok(())
}

fn exclusions_text(v: &Value) -> String {
    let mark = |on: bool, org: bool| match (on, org) {
        (true, true) => "excluded (organization)",
        (true, false) => "excluded",
        _ => "recorded",
    };
    let mut lines = Vec::new();
    for g in v["groups"].as_array().into_iter().flatten() {
        lines.push(format!(
            "group {}\t{}",
            g["id"].as_str().unwrap_or(""),
            mark(
                g["enabled"].as_bool().unwrap_or(false),
                g["by_org"].as_bool().unwrap_or(false)
            )
        ));
    }
    let pb = &v["private_browsing"];
    lines.push(format!(
        "private browsing\t{}",
        mark(
            pb["excluded"].as_bool().unwrap_or(false),
            pb["by_org"].as_bool().unwrap_or(false)
        )
    ));
    for a in v["excluded_apps"].as_array().into_iter().flatten() {
        lines.push(format!(
            "app {}\t{}",
            a["bundle_id"].as_str().unwrap_or(""),
            mark(true, a["by_org"].as_bool().unwrap_or(false))
        ));
    }
    for d in v["excluded_domains"].as_array().into_iter().flatten() {
        lines.push(format!(
            "website {}\t{}",
            d["domain"].as_str().unwrap_or(""),
            mark(true, d["by_org"].as_bool().unwrap_or(false))
        ));
    }
    lines.join("\n")
}

// ─── Kortix 24/7: login, start, stop, service ──────────────────────────────

fn login(paths: &MemoryPaths, a: LoginArgs, json_out: bool) -> Result<()> {
    let marker = paths.root.join(super::service::SIGN_IN_MARKER);
    std::fs::create_dir_all(&paths.root)?;
    std::fs::write(&marker, b"")?;
    let open = !a.no_browser && !json_out;
    let mut show = |auth: &super::sync::issuer::DeviceAuthorization| {
        if json_out {
            println!(
                "{}",
                json!({"event": "challenge", "user_code": auth.user_code, "verification_uri_complete": auth.verification_uri_complete})
            );
        } else {
            eprintln!(
                "Approve this computer in your browser:\n  {}\nCode: {}",
                auth.verification_uri_complete, auth.user_code
            );
        }
        if open {
            let _ = super::sync::issuer::open_browser(&auth.verification_uri_complete);
        }
    };
    let stop = AtomicBool::new(false);
    let result = sync_setup_kortix(
        paths,
        a.issuer.as_deref(),
        a.keep_local_hours,
        &mut show,
        &stop,
    );
    let _ = std::fs::remove_file(&marker);
    let mut v = result?;
    if json_out {
        v["event"] = json!("signed_in");
        println!("{v}");
    } else {
        println!(
            "Signed in to {} as device {}. Run `kortix-capture start` to record 24/7.",
            v["issuer"].as_str().unwrap_or(""),
            v["device_id"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

/// The service of this library. `host_args` with a host (or `--no-host`) replaces
/// the saved host when `save`; without one, the saved host applies.
fn service_unit(
    paths: &MemoryPaths,
    host_args: Option<&ServiceHostArgs>,
    save: bool,
) -> Result<(
    super::service::RealSys,
    super::service::Unit,
    super::service::Runner,
)> {
    use super::service as svc;
    let os =
        svc::Os::current().context("the background service runs on macOS, Linux and Windows")?;
    let library = std::path::absolute(&paths.root)?;
    let home = directories::BaseDirs::new()
        .map(|b| b.home_dir().to_path_buf())
        .context("no home directory")?;
    let exe = std::env::current_exe()?;
    let host = match host_args {
        Some(h) if h.no_host => {
            if save {
                let _ = std::fs::remove_file(paths.root.join("service-host.json"));
            }
            None
        }
        Some(h) if h.host.is_some() => {
            let mut env = std::collections::BTreeMap::new();
            for pair in &h.host_env {
                let (k, v) = pair
                    .split_once('=')
                    .with_context(|| format!("--host-env {pair}: expected KEY=VALUE"))?;
                env.insert(k.to_string(), v.to_string());
            }
            let host = svc::Host {
                command: h.host.clone().unwrap_or_default(),
                args: h.host_args.clone(),
                env,
                bundle_id: h.host_bundle_id.clone(),
            };
            if save {
                std::fs::create_dir_all(&paths.root)?;
                svc::write_host(paths, &host)?;
            }
            Some(host)
        }
        _ => svc::read_host(paths),
    };
    let runner = svc::runner(host.as_ref(), &exe, &library);
    Ok((svc::RealSys, svc::unit(os, &library, &home), runner))
}

/// The machine service owns recording on this computer: the person cannot stop it or sign it out.
fn refuse_when_managed(what: &str) -> Result<()> {
    if super::managed::machine_service_installed() {
        bail!("`{what}`: your organization manages Kortix Capture on this computer (the Kortix Capture machine service); ask IT");
    }
    Ok(())
}

pub fn service_status_value(paths: &MemoryPaths) -> Value {
    match service_unit(paths, None, false) {
        Ok((sys, unit, runner)) => {
            let mut v = super::service::unit_status(&sys, &unit, &runner);
            v["heartbeat"] = super::service::heartbeat(paths);
            v
        }
        Err(e) => json!({ "error": format!("{e:#}") }),
    }
}

/// Install (or rewrite a stale unit) and turn the service on.
pub fn service_start(paths: &MemoryPaths, a: &ServiceHostArgs) -> Result<Value> {
    if super::managed::machine_service_installed() {
        // The machine service already records every person who signs in here.
        return Ok(json!({ "ok": true, "managed": true, "service": service_status_value(paths) }));
    }
    // The pkg and the deb install a system agent that records in the background for every
    // person. Start that one; a per-user unit beside it would only race it for the library.
    if super::legacy::system_agent_installed() && super::legacy::start_system_agent() {
        return Ok(json!({ "ok": true, "agent": true, "service": service_status_value(paths) }));
    }
    let (sys, unit, runner) = service_unit(paths, Some(a), true)?;
    let st = super::service::unit_status(&sys, &unit, &runner);
    if st["installed"] == true && st["up_to_date"] == true {
        super::service::start(&sys, &unit)?;
    } else {
        super::service::install(&sys, &unit, &runner)?;
    }
    Ok(json!({ "ok": true, "service": service_status_value(paths) }))
}

/// `logout`: remove the background service and sign out of Kortix. A managed
/// computer refuses.
pub fn logout(paths: &MemoryPaths) -> Result<Value> {
    refuse_when_managed("logout")?;
    let (sys, unit, _) = service_unit(paths, None, false)?;
    super::service::uninstall(&sys, &unit)?;
    sync_sign_out(paths)
}

/// The window's "Sign out": Kortix sync goes off, the recordings stay, and the
/// recording goes on. (`logout` is the command line's: it also removes the service.)
pub fn sign_out_keep_recording(paths: &MemoryPaths) -> Result<Value> {
    refuse_when_managed("sign out")?;
    sync_sign_out(paths)
}

pub fn service_stop(paths: &MemoryPaths) -> Result<Value> {
    refuse_when_managed("stop")?;
    let (sys, unit, _) = service_unit(paths, None, false)?;
    super::service::stop(&sys, &unit);
    Ok(json!({ "ok": true, "service": service_status_value(paths) }))
}

/// `quit`: stop the background service, its recorders and the menu-bar icon until the app
/// opens again or the next login. It stays installed and on at login. A managed computer
/// refuses: the organization runs the recording.
pub fn quit(paths: &MemoryPaths) -> Result<Value> {
    refuse_when_managed("quit")?;
    if super::legacy::system_agent_installed() && super::legacy::stop_system_agent() {
        return Ok(json!({ "ok": true, "agent": true }));
    }
    let (sys, unit, _) = service_unit(paths, None, false)?;
    super::service::quit_now(&sys, &unit);
    // Ending the Windows task ends its loop, not the supervisor it started: end that too
    // (with its recorders). Elsewhere the OS already took it down.
    if let Some(pid) = super::service::heartbeat(paths)["pid"].as_u64().map(|p| p as u32) {
        if crate::os_proc::pid_alive(pid) {
            terminate(pid);
        }
    }
    Ok(json!({ "ok": true }))
}

/// `restart`: end the supervisor; the OS starts it again (launchd `KeepAlive`, systemd
/// `Restart=always`, the Windows task's loop), and with it the recorders and the icon.
/// With no supervisor running, start one.
pub fn restart(paths: &MemoryPaths) -> Result<Value> {
    refuse_when_managed("restart")?;
    let pid = super::service::heartbeat(paths)["pid"].as_u64().map(|p| p as u32);
    if let Some(pid) = pid.filter(|p| crate::os_proc::pid_alive(*p)) {
        terminate(pid);
        return Ok(json!({ "ok": true, "restarted_pid": pid }));
    }
    service_start(paths, &ServiceHostArgs::default())
}

fn terminate(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = crate::os_proc::no_window(&mut std::process::Command::new("taskkill.exe"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

fn service_cmd(paths: &MemoryPaths, c: ServiceCommand, json_out: bool) -> Result<()> {
    match c {
        ServiceCommand::Install(a) => {
            let (sys, unit, runner) = service_unit(paths, Some(&a), true)?;
            super::service::install(&sys, &unit, &runner)?;
            let v = service_status_value(paths);
            print(&v, json_out, |v| {
                format!("installed {}", v["path"].as_str().unwrap_or(""))
            });
        }
        ServiceCommand::Uninstall => {
            let (sys, unit, _) = service_unit(paths, None, false)?;
            super::service::uninstall(&sys, &unit)?;
            print(&json!({ "ok": true }), json_out, |_| "removed".into());
        }
        ServiceCommand::Status => {
            let v = service_status_value(paths);
            print(&v, json_out, |v| {
                format!(
                    "service   {} (installed {}, on at login {}, up to date {})\nrecorder  {}",
                    if v["active"] == true {
                        "running"
                    } else {
                        "not running"
                    },
                    v["installed"],
                    v["enabled"],
                    v["up_to_date"],
                    if v["heartbeat"]["recorder"]["running"] == true {
                        "running"
                    } else {
                        "not running"
                    },
                )
            });
        }
        ServiceCommand::Run(a) => super::service::run(paths, &std::env::current_exe()?, a.managed)?,
        ServiceCommand::Render(a) => {
            let (_, unit, runner) = service_unit(paths, Some(&a), false)?;
            print!("{}", super::service::render(&unit, &runner));
        }
    }
    Ok(())
}

fn ask_cmd(paths: &MemoryPaths, a: AskArgs, json_out: bool) -> Result<()> {
    if a.list {
        let suggestions: Vec<Value> = ask::SUGGESTIONS
            .iter()
            .map(|(t, p)| json!({"title": t, "prompt": p}))
            .collect();
        let v = json!({"agents": ask::detected(), "suggestions": suggestions});
        print(&v, json_out, |v| {
            let mut out: Vec<String> = v["agents"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| {
                    format!(
                        "{}\t{}",
                        a["id"].as_str().unwrap_or(""),
                        if a["installed"] == true {
                            "installed"
                        } else {
                            "missing"
                        }
                    )
                })
                .collect();
            out.extend(
                ask::SUGGESTIONS
                    .iter()
                    .map(|(t, _)| format!("suggestion\t{t}")),
            );
            out.join("\n")
        });
        return Ok(());
    }
    let v = ask::ask(
        paths,
        &a.prompt.join(" "),
        a.agent.as_deref(),
        a.terminal.as_deref(),
        a.dry_run,
    )?;
    print(&v, json_out, |v| {
        format!(
            "{} {} in {}",
            if a.dry_run { "would run" } else { "opened" },
            v["label"].as_str().unwrap_or(""),
            v["terminal"].as_str().unwrap_or("")
        ) + if a.dry_run {
            format!("\n{}", v["command"].as_str().unwrap_or(""))
        } else {
            String::new()
        }
        .as_str()
    });
    Ok(())
}

fn record(paths: MemoryPaths, a: RecordArgs) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let _ = ctrlc_wait();
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    if a.supervised {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    if let Some(secs) = a.duration {
        let stop = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    eprintln!("kortix-capture: recording into {}", paths.root.display());
    crate::os_proc::below_normal_priority();
    recorder::run(paths, stop)
}

/// Block until SIGINT or SIGTERM.
fn ctrlc_wait() -> Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await?;
        Ok::<_, anyhow::Error>(())
    })
}

fn human_bytes(b: u64) -> String {
    let gb = b as f64 / 1e9;
    if gb >= 1.0 {
        format!("{gb:.2} GB")
    } else {
        format!("{:.1} MB", b as f64 / 1e6)
    }
}

/// The one reason recording is not happening, or None while it is. The settings
/// gates come first so a pause shows at once, before the recorder's next tick; then
/// `not_running`; then whatever the live recorder last reported (`low_disk`,
/// `sync_backlog`, `self_on_screen`, `locked`, `inactive`, `excluded_*`, ...).
pub fn inactive_reason(
    settings: &Settings,
    st: Option<&RecorderStatus>,
    live: bool,
    now: i64,
) -> Option<String> {
    if let Some(r) = settings.inactive_reason(now) {
        return Some(r.to_string());
    }
    if !live {
        return Some("not_running".to_string());
    }
    st.and_then(|s| s.inactive_reason.clone())
}

/// Reasons the recorder pauses on its own and resumes without help.
const AUTO_PAUSE_REASONS: &[&str] = &[
    "paused",
    "inactive",
    "locked",
    "self_on_screen",
    "excluded_app",
    "excluded_domain",
    "not_included",
    "private_browsing",
    "unknown_bundle",
    "no_frontmost_app",
];

/// The live status a device writes to `status.json` every 60 s, for readers: is it
/// recording right now, and if not why; audio on or off; sync queue and error
/// class; the newest frame. Reads only the small status files the recorder
/// writes (no database), so the sync thread can report it every minute.
pub fn device_status(paths: &MemoryPaths, app_version: &str) -> Value {
    let st = RecorderStatus::read(paths);
    let live = st.as_ref().is_some_and(RecorderStatus::is_live);
    let mut v = summarize_device_status(
        &Settings::effective(paths),
        st.as_ref(),
        live,
        super::audio::AudioStatus::read(paths).as_ref(),
        super::sync::read_state(paths).as_ref(),
        now_ms(),
        app_version,
        super::actions::read_heartbeat(paths).is_some_and(|h| h.recording),
    );
    // Which policy the device obeys, so an operator sees a change land.
    // Installed version and last update result, from the machine service's update.json.
    v["update"] = super::managed::update::report();
    v["policy"] = super::policy::read(paths)
        .map(|c| json!({"source": c.source, "updatedAtMs": c.policy.updated_at_ms, "fetchedAtMs": c.fetched_at_ms}))
        .unwrap_or(Value::Null);
    v
}

#[allow(clippy::too_many_arguments)]
pub fn summarize_device_status(
    settings: &Settings,
    st: Option<&RecorderStatus>,
    live: bool,
    audio: Option<&super::audio::AudioStatus>,
    sync: Option<&super::sync::SyncState>,
    now: i64,
    app_version: &str,
    actions_recording: bool,
) -> Value {
    let reason = inactive_reason(settings, st, live, now);
    let missing: Vec<&str> = st
        .filter(|_| live)
        .and_then(|s| s.permissions.as_ref())
        .map(|p| {
            [
                ("screen", "screen_recording"),
                ("accessibility", "accessibility"),
            ]
            .into_iter()
            .filter(|(key, _)| p[key].as_bool() == Some(false))
            .map(|(_, name)| name)
            .collect()
        })
        .unwrap_or_default();
    let errored = live && st.is_some_and(|s| s.state == "error");
    let needs_permission = live && st.is_some_and(|s| s.state == "permission_missing");
    let recording = if (errored || needs_permission) && !missing.is_empty() {
        "permission_missing"
    } else if live && reason.is_none() && st.is_some_and(|s| s.state == "recording") {
        "recording"
    } else if reason
        .as_deref()
        .is_some_and(|r| AUTO_PAUSE_REASONS.contains(&r))
    {
        "paused"
    } else {
        "not_recording"
    };
    let reason = match recording {
        "recording" => None,
        "permission_missing" => Some("permission_missing".to_string()),
        _ if errored => Some("error".to_string()),
        _ => reason.or_else(|| st.map(|s| s.state.clone())),
    };
    let sync = match sync {
        _ if !settings.sync.enabled || settings.airgap => json!({"state": "off"}),
        None => json!({"state": "ok", "pending": 0}),
        Some(s) => json!({
            "state": if s.state == "error" { "error" } else if s.pending > 0 { "queued" } else { "ok" },
            "pending": s.pending,
            "errorClass": (s.state == "error").then(|| s.last_error_class.clone()).flatten(),
            "lastUploadMs": s.last_upload_ms,
        }),
    };
    json!({
        "recording": recording,
        "reason": reason,
        "missingPermissions": missing,
        "pausedUntilMs": settings.paused_until_ms.filter(|t| *t > now),
        "audio": {
            "enabled": settings.audio.enabled,
            "state": audio.filter(|a| settings.audio.enabled && a.is_fresh(now)).map(|a| a.state.clone()),
        },
        "sync": sync,
        "lastFrameMs": st.and_then(|s| s.last_capture_ms),
        "displays": st.map(|s| s.displays.iter().map(|d| json!({
            "id": d.id, "name": d.name, "main": d.main, "focused": d.focused, "lastFrameMs": d.last_frame_ms,
        })).collect::<Vec<_>>()).unwrap_or_default(),
        "actionsRecording": actions_recording,
        "capture": {"intervalMs": settings.interval_ms, "maxHeight": settings.max_height},
        "appVersion": app_version,
        "reportedAtMs": now,
    })
}

/// The one word for what this computer does now: `recording`, `paused`,
/// `permission_missing` or `not_recording` (the app window, the menu bar and
/// `status.json` say the same). Cheaper than [`status_value`]: no disk usage walk.
pub fn recording_state(paths: &MemoryPaths) -> String {
    let st = RecorderStatus::read(paths);
    let live = st.as_ref().map(RecorderStatus::is_live).unwrap_or(false);
    summarize_device_status(
        &Settings::load(paths),
        st.as_ref(),
        live,
        None,
        None,
        now_ms(),
        "",
        false,
    )["recording"]
        .as_str()
        .unwrap_or("not_recording")
        .to_string()
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
            "ocr_pending": q("SELECT count(*) FROM frame WHERE ocr_status = 0"),
            "first_frame_ms": q("SELECT COALESCE(min(timestamp), 0) FROM frame"),
            "last_frame_ms": q("SELECT COALESCE(max(timestamp), 0) FROM frame"),
        })
    });
    let audio = super::audio::AudioStatus::read(paths)
        .filter(|a| live && a.is_fresh(now_ms()))
        .map(|a| serde_json::to_value(a).unwrap_or(Value::Null));
    let audio_counts = store::open_readonly(paths).ok().map(|c| {
        let q = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        json!({
            "segments": q("SELECT count(*) FROM audio WHERE status != 2"),
            "seconds": q("SELECT COALESCE(sum(end_ms - start_ms), 0) / 1000 FROM audio WHERE status != 2"),
            "transcript_lines": q("SELECT count(*) FROM audio_transcript"),
        })
    });
    // The four words of status.json: one state for the app, the menu bar and Kortix.
    let summary = summarize_device_status(
        &settings,
        st.as_ref(),
        live,
        None,
        None,
        now_ms(),
        "",
        false,
    );
    json!({
        "library": paths.root,
        "state": summary["recording"],
        "missing_permissions": summary["missingPermissions"],
        "recorder_running": live,
        "audio_enabled": settings.audio.enabled,
        "audio": audio,
        "audio_counts": audio_counts,
        "recorder": st,
        "effective_state": if live { st.as_ref().map(|s| s.state.clone()) } else { Some("not_running".to_string()) },
        "inactive_reason": inactive_reason(&settings, st.as_ref(), live, now_ms()),
        "resolution": settings.resolution_name(),
        "recording_enabled": settings.recording_enabled,
        "paused_until_ms": settings.paused_until_ms.filter(|t| *t > now_ms()),
        "usage": usage,
        "usage_total_bytes": usage.total(),
        "limit_bytes": (settings.storage.limit_gb * 1e9) as i64,
        "counts": counts,
    })
}

fn status(paths: &MemoryPaths, json_out: bool) -> Result<()> {
    let mut v = status_value(paths);
    let s = Settings::load(paths);
    v["kortix"] = super::sync::issuer::status(paths, &s.sync.kortix.url);
    v["service"] = service_status_value(paths);
    let mut actions = super::action_exclusions::status(paths);
    actions["recording"] =
        json!(super::actions::read_heartbeat(paths).is_some_and(|h| h.recording));
    v["actions"] = actions;
    let (managed, enrollment) = super::managed::enrollment_value(paths);
    v["managed"] = json!(managed);
    v["enrollment"] = enrollment;
    print(&v, json_out, |v| {
        let mut out = vec![
            format!("library   {}", v["library"].as_str().unwrap_or("")),
            format!(
                "recorder  {}",
                v["effective_state"].as_str().unwrap_or("unknown")
            ),
        ];
        if let Some(r) = v["inactive_reason"].as_str() {
            out.push(format!("inactive  {r}"));
        }
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
        let audio = if v["audio_enabled"] != true {
            "off".to_string()
        } else {
            let state = v["audio"]["state"].as_str().unwrap_or("not running");
            let sources: Vec<String> = v["audio"]["sources"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, s)| format!("{k} {}", s["state"].as_str().unwrap_or("?")))
                .collect();
            if sources.is_empty() {
                state.replace('_', " ")
            } else {
                format!("{} ({})", state.replace('_', " "), sources.join(", "))
            }
        };
        out.push(format!("audio     {audio}"));
        if let Some(c) = v
            .get("audio_counts")
            .filter(|c| c["segments"].as_i64() > Some(0))
        {
            out.push(format!(
                "          {} segments, {} min, {} transcript lines",
                c["segments"],
                c["seconds"].as_i64().unwrap_or(0) / 60,
                c["transcript_lines"]
            ));
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

/// The System Settings pane (macOS) of the first permission still missing, from what macOS
/// granted (`granted` is the service's list) and whether capture itself fails.
pub fn missing_permission_pane(granted: &[String], screen_failing: bool) -> Option<&'static str> {
    let has = |k: &str| granted.iter().any(|g| g == k);
    if screen_failing || !has("screen") {
        Some("Privacy_ScreenCapture")
    } else if !has("accessibility") {
        Some("Privacy_Accessibility")
    } else if !has("input_monitoring") {
        Some("Privacy_ListenEvent")
    } else {
        None
    }
}

/// "Grant": ask macOS for the permissions (the system dialog shows once per permission, ever),
/// and open the System Settings pane of the first one still missing, which is where a person
/// turns it on after that first dialog. On the other systems there is nothing to grant.
pub fn grant_permissions(paths: &MemoryPaths) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = crate::os_proc::no_window(&mut std::process::Command::new(exe))
            .args(["permissions", "--request"])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let granted: Vec<String> = super::service::heartbeat(paths)["granted"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let failing = recording_state(paths) == "permission_missing";
        if let Some(pane) = missing_permission_pane(&granted, failing) {
            let _ = std::process::Command::new("/usr/bin/open")
                .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
                .spawn();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = paths;
}

fn permissions(a: PermissionsArgs, json_out: bool) -> Result<()> {
    let mut engine = Engine::new()?;
    let cmd = if a.request {
        "request_permissions"
    } else {
        "permissions"
    };
    let mut req = json!({"cmd": cmd, "microphone": a.request && a.microphone});
    if a.request && !a.only.is_empty() {
        req["only"] = json!(a.only);
    }
    let v = engine.request(req, Duration::from_secs(60))?;
    print(&v, json_out, |v| {
        let mut lines = vec![
            format!(
                "screen recording  {}",
                if v["screen"].as_bool() == Some(true) {
                    "granted"
                } else {
                    "missing"
                }
            ),
            format!(
                "accessibility     {}",
                if v["accessibility"].as_bool() == Some(true) {
                    "granted"
                } else {
                    "missing"
                }
            ),
        ];
        // macOS only; the action recorder's keyboard and mouse listener.
        if let Some(granted) = v["input_monitoring"].as_bool() {
            lines.push(format!(
                "input monitoring  {}",
                if granted { "granted" } else { "missing" }
            ));
        }
        // macOS only; needed for audio memory's microphone source.
        if let Some(m) = v["microphone"].as_str() {
            lines.push(format!("microphone        {}", m.replace('_', " ")));
        }
        lines.join("\n")
    });
    Ok(())
}

fn audio_cmd(paths: &MemoryPaths, c: AudioCommand, json_out: bool) -> Result<()> {
    match c {
        AudioCommand::Devices => {
            let mut engine = Engine::new()?;
            let v = engine.request(json!({"cmd": "audio_devices"}), Duration::from_secs(10))?;
            let current = Settings::load(paths).audio.input_device;
            print(&v, json_out, |v| {
                let mut lines = vec![format!(
                    "{}  system default (follows the system setting)",
                    if current.is_empty() { "*" } else { " " }
                )];
                for d in v["devices"].as_array().into_iter().flatten() {
                    let id = d["id"].as_str().unwrap_or_default();
                    lines.push(format!(
                        "{}  {}{}\t{id}",
                        if id == current { "*" } else { " " },
                        d["name"].as_str().unwrap_or(id),
                        if d["default"] == true {
                            " (default)"
                        } else {
                            ""
                        }
                    ));
                }
                lines.join("\n")
            });
        }
        AudioCommand::List { tr, limit } => {
            let conn = store::open_readonly(paths)?;
            let range = match tr.as_deref() {
                Some(t) => super::timerange::parse_range(t)?,
                None => super::timerange::TimeRange::default(),
            };
            let segs = super::audio::segments(
                &conn,
                range.start.unwrap_or(0),
                range.end.unwrap_or(i64::MAX),
            )?;
            let mut lines_stmt = conn.prepare(
                "SELECT start_ms, end_ms, text FROM audio_transcript WHERE audio = ?1 ORDER BY start_ms, id",
            )?;
            let mut out = Vec::new();
            for sgm in segs.into_iter().rev().take(limit).rev() {
                let transcript: Vec<Value> = lines_stmt
                    .query_map([sgm.id], |r| {
                        Ok(json!({"start_ms": r.get::<_, i64>(0)?, "end_ms": r.get::<_, i64>(1)?, "text": r.get::<_, String>(2)?}))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                let mut v = serde_json::to_value(&sgm)?;
                v["transcript"] = json!(transcript);
                out.push(v);
            }
            let v = Value::Array(out);
            print(&v, json_out, |v| {
                let rows = v.as_array().cloned().unwrap_or_default();
                if rows.is_empty() {
                    return "No audio recorded in this range.".into();
                }
                rows.iter()
                    .map(|a| {
                        let words: Vec<&str> = a["transcript"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|l| l["text"].as_str())
                            .collect();
                        format!(
                            "{}  {:>3} s  {}{}",
                            super::timerange::iso(a["start_ms"].as_i64().unwrap_or(0)),
                            (a["end_ms"].as_i64().unwrap_or(0)
                                - a["start_ms"].as_i64().unwrap_or(0))
                                / 1000,
                            a["sources"].as_str().unwrap_or(""),
                            if words.is_empty() {
                                String::new()
                            } else {
                                format!("  “{}”", words.join(" ").trim())
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
    }
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
    } else if a.duration == "tomorrow" {
        s.recording_enabled = true;
        s.paused_until_ms = Some(tomorrow_6am_ms(now_ms()));
    } else {
        let Some(ms) = parse_duration_ms(&a.duration) else {
            bail!("invalid duration {:?} (examples: 15m, 1h, 1d)", a.duration)
        };
        s.paused_until_ms = Some(now_ms() + ms);
    }
    s.save(paths)?;
    let v = json!({"recording_enabled": s.recording_enabled, "paused_until_ms": s.paused_until_ms});
    print(&v, json_out, |_| match s.paused_until_ms {
        Some(t) => format!(
            "paused until {}",
            chrono::DateTime::from_timestamp_millis(t)
                .map(|d| d
                    .with_timezone(&chrono::Local)
                    .format("%Y-%m-%dT%H:%M")
                    .to_string())
                .unwrap_or_default()
        ),
        None => "recording disabled".into(),
    });
    Ok(())
}

/// 6:00 local time tomorrow, in epoch ms: "Pause until tomorrow".
pub fn tomorrow_6am_ms(now: i64) -> i64 {
    use chrono::{Duration as D, Local, TimeZone};
    let local = Local.timestamp_millis_opt(now).single().unwrap_or_else(Local::now);
    let next = (local.date_naive() + D::days(1)).and_hms_opt(6, 0, 0).unwrap_or_default();
    Local
        .from_local_datetime(&next)
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now + 86_400_000)
}

fn resume(paths: &MemoryPaths, json_out: bool) -> Result<()> {
    let mut s = Settings::load(paths);
    s.recording_enabled = true;
    s.paused_until_ms = None;
    s.save(paths)?;
    print(&json!({"recording_enabled": true}), json_out, |_| {
        "recording resumed".into()
    });
    Ok(())
}

fn settings(paths: &MemoryPaths, a: SettingsArgs, json_out: bool) -> Result<()> {
    let s = Settings::load(paths);
    let mut v = serde_json::to_value(&s)?;
    let Some(key) = a.key else {
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    };
    if key == "resolution" {
        match a.value {
            None => print(&json!(s.resolution_name()), json_out, |c| {
                c.as_str().unwrap_or("").to_string()
            }),
            Some(name) => {
                let mut updated = s;
                updated.set_resolution(name.trim_matches('"'))?;
                updated.save(paths)?;
                let (w, h) = (updated.max_width, updated.max_height);
                print(
                    &json!({"ok": true, "resolution": updated.resolution_name(), "max_width": w, "max_height": h}),
                    json_out,
                    |_| format!("resolution {} ({w}x{h} max)", updated.resolution_name()),
                );
            }
        }
        return Ok(());
    }
    let parts: Vec<&str> = key.split('.').collect();
    match a.value {
        None => {
            let mut cur = &v;
            for p in &parts {
                cur = cur
                    .get(p)
                    .ok_or_else(|| anyhow::anyhow!("unknown setting {key}"))?;
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
                cur = cur
                    .get_mut(*p)
                    .ok_or_else(|| anyhow::anyhow!("unknown setting {key}"))?;
            }
            let last = parts[parts.len() - 1];
            if cur.get(last).is_none() {
                bail!("unknown setting {key}");
            }
            cur[last] = new;
            let updated: Settings = serde_json::from_value(v)
                .map_err(|e| anyhow::anyhow!("invalid value for {key}: {e}"))?;
            updated.validate()?;
            updated.save(paths)?;
            print(&json!({"ok": true}), json_out, |_| format!("{key} updated"));
        }
    }
    Ok(())
}

/// `sync setup --provider s3` input. The settings window posts the same fields.
pub struct S3Setup {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub path_style: bool,
    pub keep_local_hours: Option<u64>,
    pub creds: super::sync::SyncCredentials,
    pub encrypt: bool,
}

/// Probe the S3 target, then save it and the credentials and turn sync on.
pub fn sync_setup_s3(paths: &MemoryPaths, a: S3Setup) -> Result<Value> {
    use super::sync::{self, UploadTarget as _};
    if a.endpoint.trim().is_empty() || a.bucket.trim().is_empty() {
        bail!("--provider s3 needs --endpoint and --bucket (Kortix sync mode: --provider kortix)");
    }
    let prev = sync::view::active_destination(paths);
    let mut s = Settings::load(paths);
    s.sync.provider = "s3".into();
    s.sync.s3.endpoint = a.endpoint.trim().into();
    s.sync.s3.bucket = a.bucket.trim().into();
    s.sync.s3.region = a.region.trim().into();
    s.sync.s3.prefix = a.prefix.trim().into();
    s.sync.s3.path_style = a.path_style;
    if let Some(h) = a.keep_local_hours {
        s.sync.keep_local_hours = h;
    }
    s.validate()?;
    let elapsed = sync::target_for(&s.sync, &a.creds)?
        .probe(&sync::device_id(paths, &s))
        .context("S3 probe failed; sync stays off")?;
    sync::view::apply_switch(
        paths,
        prev.as_deref(),
        &sync::view::s3_key(&s.sync.s3.endpoint, &s.sync.s3.bucket, &s.sync.s3.prefix),
    )?;
    sync::save_credentials(paths, &a.creds)?;
    s.sync.enabled = true;
    super::onboarding::set(paths, super::onboarding::State::Done);
    s.sync.encrypt = s.sync.encrypt || a.encrypt;
    s.save(paths)?;
    let key = sync::ensure_key(paths, &s)?;
    Ok(
        json!({"ok": true, "enabled": true, "provider": "s3", "probe_ms": elapsed.as_millis() as u64, "bucket": s.sync.s3.bucket, "prefix": s.sync.s3.prefix,
               "encryption_key_id": key.as_ref().map(|k| k.id())}),
    )
}

/// Sign in to the issuer (RFC 8628 device grant: `show` gets the code and the
/// approval URL), probe the bucket with the issued credentials, then turn
/// Kortix sync on. `issuer` overrides `sync.kortix.url` and is saved.
pub fn sync_setup_kortix(
    paths: &MemoryPaths,
    issuer: Option<&str>,
    keep_local_hours: Option<u64>,
    show: &mut dyn FnMut(&super::sync::issuer::DeviceAuthorization),
    stop: &AtomicBool,
) -> Result<Value> {
    use super::sync::{self, issuer as iss};
    let prev = sync::view::active_destination(paths);
    let mut s = Settings::load(paths);
    if let Some(url) = issuer.map(str::trim).filter(|u| !u.is_empty()) {
        s.sync.kortix.url = url.trim_end_matches('/').to_string();
    }
    let url = iss::issuer_url(&s.sync.kortix.url)
        .context("no Kortix URL: pass --issuer <url> or set it in Settings, Cloud sync")?;
    if let Some(h) = keep_local_hours {
        s.sync.keep_local_hours = h;
    }
    s.sync.provider = "kortix".into();
    s.sync.encrypt = false;
    s.validate()?;
    // The sign-in's progress is shared state: the window shows the code whoever started it.
    let started = now_ms();
    let progress = |a: &iss::DeviceAuthorization| {
        write_connect_state(paths, &json!({"running": true, "started_ms": started, "progress": {"user_code": a.user_code, "approve_url": a.verification_uri_complete}}));
    };
    let mut show_and_record = |a: &iss::DeviceAuthorization| {
        progress(a);
        show(a);
    };
    let reg = match iss::sign_in(paths, &url, &mut show_and_record, stop) {
        Ok(r) => r,
        Err(e) => {
            write_connect_state(paths, &json!({"running": false, "ok": false, "started_ms": started, "finished_ms": now_ms(), "error": super::sync::view::humanize(&e)}));
            return Err(e);
        }
    };
    iss::forget_credentials();
    // Signed in means syncing. A server that cannot hand out credentials yet (a 503) does not
    // undo the sign-in: sync turns on, keeps the recordings, and retries. A refusal does.
    let probe = sync::target(paths, &s).and_then(|t| t.probe(&reg.device_id));
    let probe_ms = match probe {
        Ok(d) => Some(d.as_millis() as u64),
        Err(e) if sync::classify(&e) == sync::ErrorClass::Transient => {
            tracing::warn!("sign-in succeeded; credentials are not available yet: {e:#}");
            None
        }
        Err(e) => {
            write_connect_state(paths, &json!({"running": false, "ok": false, "started_ms": started, "finished_ms": now_ms(), "error": super::sync::view::humanize(&e)}));
            return Err(e.context("the issued credentials do not reach the bucket; sync stays off"));
        }
    };
    sync::view::apply_switch(paths, prev.as_deref(), &sync::view::kortix_key(&reg.issuer, &reg.prefix))?;
    s.sync.enabled = true;
    s.save(paths)?;
    super::onboarding::set(paths, super::onboarding::State::Done);
    write_connect_state(paths, &json!({"running": false, "ok": true, "started_ms": started, "finished_ms": now_ms()}));
    Ok(
        json!({"ok": true, "enabled": true, "provider": "kortix", "issuer": url, "device_id": reg.device_id,
              "prefix": reg.prefix, "member_email": reg.member_email, "probe_ms": probe_ms,
              "keep_local_hours": s.sync.keep_local_hours}),
    )
}

/// `<library>/connect.json`: the sign-in in progress or just finished (user code, approval
/// page, result). No secrets. The window reads it, so a sign-in started from the command
/// line shows up there too.
pub fn connect_state_path(paths: &MemoryPaths) -> std::path::PathBuf {
    paths.root.join("connect.json")
}

fn write_connect_state(paths: &MemoryPaths, v: &Value) {
    let _ = paths.ensure();
    let _ = std::fs::write(connect_state_path(paths), v.to_string());
}

pub fn read_connect_state(paths: &MemoryPaths) -> Option<Value> {
    let v: Value = serde_json::from_slice(&std::fs::read(connect_state_path(paths)).ok()?).ok()?;
    // A sign-in lasts at most 15 minutes: an older "running" file belongs to a process that died.
    let fresh = now_ms() - v["started_ms"].as_i64().unwrap_or(0) < 15 * 60_000;
    (fresh || v["running"] != true).then_some(v)
}

/// `sync enroll`: enroll with an enrollment token as the OS user (or the given
/// names), and on success store the enrollment like a sign-in.
pub fn sync_enroll(paths: &MemoryPaths, a: &SyncEnrollArgs, token: &str) -> Result<Value> {
    use super::sync::issuer::{self as iss, Enrollment};
    if token.is_empty() {
        bail!("sync enroll: pass the enrollment token on stdin");
    }
    let s = Settings::load(paths);
    let configured = a
        .issuer
        .clone()
        .unwrap_or_else(|| s.sync.kortix.url.clone());
    let url = iss::issuer_url(&configured).context("no Kortix URL: pass --issuer <url>")?;
    let os_user = super::managed::current_user();
    let user = iss::EnrollUser {
        principal_name: a.principal.clone().or(os_user.principal_name),
        account_name: a.account_name.clone().unwrap_or(os_user.account_name),
    };
    let held = iss::held_device_token(paths, &url);
    let answer = iss::enroll(&url, token, &user, &super::sync::identity(paths), held.as_deref())?;
    let retry = answer.retry_after().as_secs();
    Ok(match answer {
        Enrollment::Enrolled(adoption) => {
            let r = iss::adopt(paths, &adoption)?;
            json!({"status": "enrolled", "issuer": r.issuer, "device_id": r.device_id, "prefix": r.prefix,
                   "member_email": r.member_email, "account_name": r.account_name})
        }
        Enrollment::Pending {
            reason,
            enrollment_id,
            ..
        } => {
            json!({"status": "pending", "reason": reason, "enrollment_id": enrollment_id, "retry_after_s": retry})
        }
        Enrollment::Refused { code, .. } => {
            json!({"status": "refused", "code": code, "retry_after_s": retry})
        }
    })
}

/// `sync sign-out`: forget the device token and the registration; Kortix sync goes off.
pub fn sync_sign_out(paths: &MemoryPaths) -> Result<Value> {
    super::sync::issuer::sign_out(paths);
    let mut s = Settings::load(paths);
    if s.sync.provider == "kortix" {
        s.sync.enabled = false;
        // Back to Off: not a "kortix" provider with no sign-in.
        s.sync.provider = "s3".into();
        s.save(paths)?;
    }
    // Back to onboarding on the next open (never forced at login).
    super::onboarding::set(paths, super::onboarding::State::SignedOut);
    Ok(json!({"signed_out": true, "enabled": s.sync.enabled}))
}

/// `sync test`: PUT, HEAD and DELETE a probe object on the saved target.
pub fn sync_test(paths: &MemoryPaths) -> Result<Value> {
    use super::sync;
    let s = Settings::load(paths);
    let elapsed = sync::target(paths, &s)?.probe(&sync::device_id(paths, &s))?;
    Ok(json!({"ok": true, "probe_ms": elapsed.as_millis() as u64}))
}

/// `sync on` (probes first; sync stays off when the probe fails) and `sync off`.
pub fn sync_set_enabled(paths: &MemoryPaths, on: bool) -> Result<Value> {
    if on {
        sync_test(paths).context("sync probe failed; sync stays off")?;
    }
    let mut s = Settings::load(paths);
    if on && !s.sync.enabled {
        // Recordings made while sync was off stay on this computer.
        super::sync::view::apply_switch(paths, None, "resume")?;
    }
    s.sync.enabled = on;
    s.save(paths)?;
    Ok(json!({"enabled": on}))
}

/// `sync status --json`.
pub fn sync_status_value(paths: &MemoryPaths) -> Value {
    use super::sync;
    let s = Settings::load(paths);
    let device = sync::device_id(paths, &s);
    let (managed, enrollment) = super::managed::enrollment_value(paths);
    // The recorder's sync thread writes sync.json; without a recorder, compute it from the library.
    let state = sync::read_state(paths).or_else(|| {
        let conn = store::open(paths).ok()?;
        Some(sync::compute_state(
            &conn,
            paths,
            &Settings::effective(paths),
            s.sync.enabled && !s.airgap,
            &device,
            &Default::default(),
        ))
    });
    json!({
        "enabled": s.sync.enabled,
        "provider": s.sync.provider,
        "endpoint": s.sync.s3.endpoint, "bucket": s.sync.s3.bucket, "prefix": s.sync.s3.prefix, "region": s.sync.s3.region,
        "keep_local_hours": s.sync.keep_local_hours,
        "concurrency": s.sync.concurrency, "max_upload_kbps": s.sync.max_upload_kbps, "part_mb": s.sync.part_mb,
        "remote_retention_days": s.sync.remote_retention_days, "encrypt": s.sync.encrypt,
        "credentials": sync::load_credentials(paths).is_some(),
        "device_id": device,
        "kortix": sync::issuer::status(paths, &s.sync.kortix.url),
        "policy": super::policy::read(paths),
        "state": state,
        "managed": managed,
        "enrollment": enrollment,
    })
}

/// What a person reads about sync: destination, one status line, tone. The window and
/// the menu bar show the same words. Reads `sync.json`, which the recorder writes.
pub fn sync_view(paths: &MemoryPaths) -> super::sync::view::SyncView {
    use super::sync::{self, view};
    let s = Settings::load(paths);
    let k = sync::issuer::registration(paths);
    let state = sync::read_state(paths);
    view::sync_view(&view::ViewInput {
        sync: &s.sync,
        airgap: s.airgap,
        managed: super::managed::enrollment_value(paths).0,
        kortix_signed_in: k.as_ref().is_some_and(|r| r.rejected_at_ms.is_none()),
        sign_in_required: k.as_ref().is_some_and(|r| r.rejected_at_ms.is_some()),
        account_name: k.as_ref().and_then(|r| r.account_name.as_deref()),
        state: state.as_ref(),
        now_ms: now_ms(),
    })
}

/// What `sync now` did: the sync state after it, and how long it waited for
/// another process's pass (the recorder's) to release the library's sync lock.
#[derive(Debug, serde::Serialize)]
pub struct SyncNow {
    #[serde(flatten)]
    pub state: super::sync::SyncState,
    pub waited_ms: u64,
}

/// `sync now`: upload every finished chunk and send queued deletes until the queue is empty.
/// Holds the library's sync lock throughout, so no other process uploads meanwhile.
pub fn sync_now(paths: &MemoryPaths) -> Result<SyncNow> {
    use super::sync;
    let s = Settings::load(paths);
    if !s.sync.enabled || s.airgap {
        bail!(
            "sync is off: turn it on with `kortix-capture sync setup` or `kortix-capture sync on`"
        );
    }
    let (_lock, waited_ms) = match sync::lock_passes(paths, false)? {
        Some(lock) => (lock, 0),
        None => {
            eprintln!(
                "kortix-capture: the recorder is uploading; waiting for its sync pass to finish"
            );
            let t0 = std::time::Instant::now();
            let lock = sync::lock_passes(paths, true)?.context("sync lock")?;
            (lock, t0.elapsed().as_millis().max(1) as u64)
        }
    };
    let conn = store::open(paths)?;
    let stop = AtomicBool::new(false);
    let s = Settings::effective(paths);
    let device = sync::device_id(paths, &s);
    let mut rt = sync::Runtime::default();
    let due = |c: &rusqlite::Connection| -> Result<i64> {
        Ok(c.query_row(
            "SELECT (SELECT count(*) FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0)
                  + (SELECT count(*) FROM audio WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND transcript_status != ?1)
                  + (SELECT count(*) FROM action_segment WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND ?2 = 0)
                  + (SELECT count(*) FROM sync_tombstone)",
            rusqlite::params![super::audio::TRANSCRIPT_PENDING, s.privacy.redact_pii as i64],
            |r| r.get(0),
        )?)
    };
    for _ in 0..50 {
        // A chunk in backoff is retried now: the person asked for it.
        for table in ["video", "audio", "action_segment"] {
            conn.execute(
                &format!("UPDATE {table} SET next_upload_at = NULL WHERE uploaded_at IS NULL"),
                [],
            )?;
        }
        conn.execute("UPDATE sync_tombstone SET next_at = 0", [])?;
        sync::pass(&conn, paths, &s, &device, &stop, &mut rt)?;
        if due(&conn)? == 0 {
            break;
        }
    }
    let st = sync::compute_state(&conn, paths, &s, true, &device, &rt);
    // `sync status` reads sync.json; without a running recorder nothing else refreshes it.
    sync::write_state(paths, &st);
    Ok(SyncNow {
        state: st,
        waited_ms,
    })
}

/// `sync devices`: the devices under the bucket prefix.
pub fn sync_devices(paths: &MemoryPaths) -> Result<Vec<super::sync::restore::Device>> {
    use super::sync;
    let t = sync::target(paths, &Settings::load(paths))?;
    sync::restore::devices(t.as_ref())
}

/// `sync restore`. `from` takes the `--from` formats; `device` defaults to this
/// machine, else the only device in the bucket. Per-chunk failures are in `errors`.
pub fn sync_restore(
    paths: &MemoryPaths,
    from: Option<&str>,
    device: Option<String>,
    progress: &mut dyn FnMut(&super::sync::restore::Report),
) -> Result<super::sync::restore::Report> {
    use super::sync::{self, restore};
    let s = Settings::load(paths);
    let t = sync::target(paths, &s)?;
    let from = from
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(|f| super::timerange::parse_range(&format!("since:{f}")).map(|r| r.start))
        .transpose()?
        .flatten();
    let device = match device.filter(|d| !d.trim().is_empty()) {
        Some(d) => d,
        // Issued credentials are scoped to this device: no listing of the prefix.
        None if s.sync.provider == "kortix" => sync::device_id(paths, &s),
        None => {
            let list = restore::devices(t.as_ref())?;
            let me = sync::device_id(paths, &s);
            if list.iter().any(|d| d.device_id == me) {
                me
            } else if list.len() == 1 {
                list[0].device_id.clone()
            } else {
                let ids: Vec<&str> = list.iter().map(|d| d.device_id.as_str()).collect();
                bail!(
                    "pick a device with --device (bucket has: {})",
                    if ids.is_empty() {
                        "none".into()
                    } else {
                        ids.join(", ")
                    }
                );
            }
        }
    };
    restore::restore(paths, t.as_ref(), &device, from, progress)
}

/// `sync key export`: the encryption key, base64.
pub fn sync_key_export(paths: &MemoryPaths) -> Result<Value> {
    let s = Settings::load(paths);
    if s.sync.key_id.is_empty() {
        bail!("no encryption key yet (turn it on with `kortix-capture settings sync.encrypt true` or `sync setup --encrypt`)");
    }
    let key = super::sync::crypt::load(paths, &s.sync.key_id)
        .with_context(|| format!("key {} is not on this machine", s.sync.key_id))?;
    Ok(json!({"key_id": key.id(), "key": key.to_b64()}))
}

/// `sync key import`: install an exported key and turn encryption on.
pub fn sync_key_import(paths: &MemoryPaths, key: &str) -> Result<Value> {
    use super::sync::crypt;
    let mut s = Settings::load(paths);
    if s.sync.provider == "kortix" {
        bail!("encryption is not supported with the kortix provider: Kortix reads the bucket to index it for your organization");
    }
    let key = crypt::Key::from_b64(key.trim())?;
    let place = crypt::store(paths, &key)?;
    s.sync.key_id = key.id();
    s.sync.encrypt = true;
    s.save(paths)?;
    Ok(json!({"key_id": key.id(), "stored_in": place}))
}

/// `settings sync.encrypt true|false`, plus the key at once when it turns on (the
/// engine would make it on its next pass), so it can be exported right away.
pub fn sync_set_encrypt(paths: &MemoryPaths, on: bool) -> Result<Value> {
    let mut s = Settings::load(paths);
    s.sync.encrypt = on;
    s.validate()?;
    s.save(paths)?;
    let key = super::sync::ensure_key(paths, &s)?;
    Ok(
        json!({"encrypt": on, "key_id": key.map(|k| k.id()).or_else(|| Some(Settings::load(paths).sync.key_id).filter(|k| !k.is_empty()))}),
    )
}

/// `storage forget`: delete a bounded timerange locally and in the cloud. Dry run unless `yes`.
pub fn storage_forget(
    paths: &MemoryPaths,
    tr: &str,
    yes: bool,
) -> Result<super::sync::ForgetReport> {
    let range = super::timerange::parse_range(tr)?;
    if range.start.is_none() && range.end.is_none() {
        bail!("forget needs a bounded timerange");
    }
    let conn = store::open(paths)?;
    let s = Settings::load(paths);
    super::sync::forget(
        &conn,
        paths,
        &s,
        &super::sync::device_id(paths, &s),
        range,
        !yes,
    )
}

fn sync_cmd(paths: &MemoryPaths, c: SyncCommand, json_out: bool) -> Result<()> {
    use super::sync::{self, SyncCredentials};
    match c {
        SyncCommand::Setup(a) if a.provider == "kortix" => {
            if a.encrypt {
                bail!("--encrypt is not supported with --provider kortix: Kortix reads the bucket to index it for your organization");
            }
            let open = !a.no_browser;
            let mut show = |auth: &super::sync::issuer::DeviceAuthorization| {
                eprintln!(
                    "Approve this computer in your browser:\n  {}\nCode: {}",
                    auth.verification_uri_complete, auth.user_code
                );
                if open {
                    let _ = super::sync::issuer::open_browser(&auth.verification_uri_complete);
                }
            };
            let stop = AtomicBool::new(false);
            let v = sync_setup_kortix(
                paths,
                a.issuer.as_deref(),
                a.keep_local_hours,
                &mut show,
                &stop,
            )?;
            print(&v, json_out, |v| {
                let keep = v["keep_local_hours"].as_u64().unwrap_or(0);
                format!(
                    "Kortix sync on: {} as device {}{} (probe {} ms)\nEach item uploads in the Kortix Capture format, then the local copy is {}.",
                    v["issuer"].as_str().unwrap_or(""),
                    v["device_id"].as_str().unwrap_or(""),
                    v["member_email"].as_str().map(|e| format!(" ({e})")).unwrap_or_default(),
                    v["probe_ms"],
                    if keep == 0 { "deleted".to_string() } else { format!("deleted after {keep} h") }
                )
            });
        }
        SyncCommand::Enroll(a) => {
            let mut token = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut token)?;
            let v = sync_enroll(paths, &a, token.trim())?;
            print(&v, json_out, |v| match v["status"].as_str() {
                Some("enrolled") => {
                    format!(
                    "Enrolled with {} as device {}{}. Run `kortix-capture start` to record 24/7.",
                    v["issuer"].as_str().unwrap_or(""),
                    v["device_id"].as_str().unwrap_or(""),
                    v["member_email"].as_str().map(|e| format!(" ({e})")).unwrap_or_default(),
                )
                }
                Some("pending") => format!(
                    "Waiting for an admin ({}); try again in {} s.",
                    v["reason"].as_str().unwrap_or(""),
                    v["retry_after_s"]
                ),
                _ => format!("Refused: {}", v["code"].as_str().unwrap_or("")),
            });
            if v["status"] == "refused" {
                std::process::exit(2);
            }
        }
        SyncCommand::Adopt => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)?;
            let a: super::sync::issuer::Adoption = serde_json::from_str(&text)
                .context("sync adopt: expected the enrollment JSON on stdin")?;
            let r = super::sync::issuer::adopt(paths, &a)?;
            print(
                &json!({"ok": true, "issuer": r.issuer, "device_id": r.device_id, "managed": true}),
                json_out,
                |v| format!("adopted device {}", v["device_id"].as_str().unwrap_or("")),
            );
        }
        SyncCommand::DeviceToken { issuer } => {
            if let Some(t) = super::sync::issuer::held_device_token(paths, &issuer) {
                println!("{t}");
            }
        }
        SyncCommand::EnrollmentState => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)?;
            let st: super::managed::EnrollmentState = serde_json::from_str(&text)
                .context("sync enrollment-state: expected the state JSON on stdin")?;
            super::managed::write_enrollment_state(paths, &st)?;
            print(&json!({"ok": true}), json_out, |_| "ok".into());
        }
        SyncCommand::SignOut => {
            refuse_when_managed("sync sign-out")?;
            let v = sync_sign_out(paths)?;
            print(&v, json_out, |_| "signed out; Kortix sync off".into());
        }
        SyncCommand::Setup(a) => {
            let (Some(endpoint), Some(bucket)) = (a.endpoint.clone(), a.bucket.clone()) else {
                bail!("--provider s3 needs --endpoint and --bucket (Kortix sync mode: --provider kortix)");
            };
            let env = |k: &str| std::env::var(k).ok();
            let creds = SyncCredentials {
                access_key_id: a
                    .access_key_id
                    .or_else(|| env("KORTIX_CAPTURE_S3_ACCESS_KEY_ID"))
                    .context("--access-key-id or KORTIX_CAPTURE_S3_ACCESS_KEY_ID")?,
                secret_access_key: a
                    .secret_access_key
                    .or_else(|| env("KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY"))
                    .context("--secret-access-key or KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY")?,
                session_token: a
                    .session_token
                    .or_else(|| env("KORTIX_CAPTURE_S3_SESSION_TOKEN")),
            };
            let v = sync_setup_s3(
                paths,
                S3Setup {
                    endpoint,
                    bucket,
                    region: a.region,
                    prefix: a.prefix,
                    path_style: a.path_style,
                    keep_local_hours: a.keep_local_hours,
                    creds,
                    encrypt: a.encrypt,
                },
            )?;
            print(&v, json_out, |v| {
                let mut out = format!(
                    "sync on: s3://{}/{} (probe {} ms)",
                    v["bucket"].as_str().unwrap_or(""),
                    v["prefix"].as_str().unwrap_or(""),
                    v["probe_ms"]
                );
                if let Some(k) = v["encryption_key_id"].as_str() {
                    out.push_str(&format!(
                        "\nencryption on, key {k}. Back it up now with `kortix-capture sync key export`: without it the bucket is unreadable."
                    ));
                }
                out
            });
        }
        SyncCommand::Test => {
            let v = sync_test(paths)?;
            print(&v, json_out, |v| format!("ok ({} ms)", v["probe_ms"]));
        }
        SyncCommand::Status => {
            let v = sync_status_value(paths);
            print(&v, json_out, |v| {
                let st = &v["state"];
                let n = |k: &str| st[k].as_i64().unwrap_or(0);
                let age = st["oldest_unsent_ms"]
                    .as_i64()
                    .map(|ms| format!("{} min", ms / 60_000))
                    .unwrap_or_else(|| "-".into());
                let rate = st["throughput_bps"]
                    .as_u64()
                    .map(|b| format!("{}/s", human_bytes(b)))
                    .unwrap_or_else(|| "-".into());
                let err = match (st["last_error"].as_str(), st["last_error_class"].as_str()) {
                    (Some(e), Some(c)) => format!("{c}: {e}"),
                    (Some(e), None) => e.to_string(),
                    _ => "-".into(),
                };
                let k = &v["kortix"];
                let target = if v["provider"] == "kortix" {
                    match (k["signed_in"].as_bool(), k["sign_in_required"].as_bool()) {
                        (_, Some(true)) => {
                            "kortix: the issuer refused this device; sign in again".to_string()
                        }
                        (Some(true), _) => format!(
                            "kortix {} as {}{}",
                            k["issuer"].as_str().unwrap_or(""),
                            k["device_id"].as_str().unwrap_or(""),
                            k["member_email"]
                                .as_str()
                                .map(|e| format!(" ({e})"))
                                .unwrap_or_default()
                        ),
                        _ => "kortix: not signed in (kortix-capture sync setup --provider kortix)"
                            .to_string(),
                    }
                } else {
                    format!(
                        "s3://{}/{}/{}",
                        v["bucket"].as_str().unwrap_or(""),
                        v["prefix"].as_str().unwrap_or(""),
                        v["device_id"].as_str().unwrap_or("")
                    )
                };
                let policy = v["policy"]["policy"]["notice"]
                    .as_str()
                    .map(|n| {
                        format!(
                            "\npolicy      {} ({n})",
                            v["policy"]["source"].as_str().unwrap_or("")
                        )
                    })
                    .or_else(|| {
                        v["policy"]["source"]
                            .as_str()
                            .map(|src| format!("\npolicy      {src}"))
                    })
                    .unwrap_or_default();
                format!(
                    "sync        {}\ntarget      {}\nqueue       {} chunks, {} audio, {} action segments, {} ({} retrying, oldest {})\nuploaded    {} chunks, {} audio, {} action segments\nremote      {} (local copy removed)\ndeletes     {} queued\nmultipart   {} in progress\nthroughput  {}\nencryption  {}\nerror       {}{policy}",
                    if v["enabled"].as_bool() == Some(true) { st["state"].as_str().unwrap_or("starting") } else { "off" },
                    target,
                    n("pending"), n("audio_pending"), n("actions_pending"), human_bytes(n("bytes_pending").max(0) as u64), n("retrying"), age,
                    n("uploaded"), n("audio_uploaded"), n("actions_uploaded"), n("remote_only"), n("tombstones"), n("multipart_in_progress"), rate,
                    st["key_id"].as_str().map(|k| format!("on (key {k})")).unwrap_or_else(|| "off".into()),
                    err,
                )
            });
        }
        SyncCommand::Now => {
            let now = sync_now(paths)?;
            let st = &now.state;
            print(&serde_json::to_value(&now)?, json_out, |_| {
                format!(
                    "{}synced: {} chunks uploaded, {} remote-only, {} pending, {} deletes queued{}",
                    if now.waited_ms > 0 {
                        format!(
                            "waited {:.1} s for the recorder's sync pass\n",
                            now.waited_ms as f64 / 1000.0
                        )
                    } else {
                        String::new()
                    },
                    st.uploaded,
                    st.remote_only,
                    st.pending,
                    st.tombstones,
                    st.last_error
                        .as_deref()
                        .map(|e| format!("\nerror: {e}"))
                        .unwrap_or_default()
                )
            });
        }
        SyncCommand::On => {
            let v = sync_set_enabled(paths, true)?;
            print(&v, json_out, |_| "sync on".into());
        }
        SyncCommand::Off => {
            let v = sync_set_enabled(paths, false)?;
            print(&v, json_out, |_| "sync off".into());
        }
        SyncCommand::Devices => {
            let list = sync_devices(paths)?;
            let me = sync::device_id(paths, &Settings::load(paths));
            print(&serde_json::to_value(&list)?, json_out, |_| {
                let mut out = String::new();
                for d in &list {
                    let when = |ms: Option<i64>| {
                        ms.and_then(chrono::DateTime::from_timestamp_millis)
                            .map(|t| {
                                t.with_timezone(&chrono::Local)
                                    .format("%Y-%m-%d %H:%M")
                                    .to_string()
                            })
                            .unwrap_or_else(|| "-".into())
                    };
                    out.push_str(&format!(
                        "{}{}  {}  {}  {} .. {}{}\n",
                        d.device_id,
                        if d.device_id == me {
                            " (this machine)"
                        } else {
                            ""
                        },
                        d.hostname.as_deref().unwrap_or("-"),
                        d.os.as_deref().unwrap_or("-"),
                        when(d.first_chunk_ms),
                        when(d.last_chunk_ms),
                        d.encryption_key_id
                            .as_deref()
                            .map(|k| format!("  encrypted (key {k})"))
                            .unwrap_or_default(),
                    ));
                }
                if out.is_empty() {
                    "no devices under this prefix".into()
                } else {
                    out.trim_end().to_string()
                }
            });
        }
        SyncCommand::Restore(a) => {
            let t0 = std::time::Instant::now();
            let mut last = std::time::Instant::now();
            let report = sync_restore(paths, a.from.as_deref(), a.device, &mut |r| {
                if !json_out && last.elapsed() > Duration::from_secs(2) {
                    last = std::time::Instant::now();
                    eprintln!(
                        "restoring {}: {}/{} chunks, {} frames",
                        r.device_id,
                        r.chunks_restored + r.chunks_already_present,
                        r.chunks_listed,
                        r.frames
                    );
                }
            })?;
            print(&serde_json::to_value(&report)?, json_out, |_| {
                let mut out = format!(
                    "restored {} chunks ({} frames, {} icons, {}) from {} via its {} in {:.1} s\nalready present {}, gone from the bucket {}",
                    report.chunks_restored, report.frames, report.icons, human_bytes(report.bytes_downloaded), report.device_id,
                    report.source, t0.elapsed().as_secs_f64(), report.chunks_already_present, report.chunks_missing,
                );
                if report.audio_restored + report.audio_already_present > 0 {
                    out.push_str(&format!(
                        "\naudio: restored {} segments, already present {}",
                        report.audio_restored, report.audio_already_present
                    ));
                }
                for e in report.errors.iter().take(10) {
                    out.push_str(&format!("\nerror: {e}"));
                }
                out
            });
            if !report.errors.is_empty() {
                bail!(
                    "{} chunks failed to restore; run restore again to retry them",
                    report.errors.len()
                );
            }
        }
        SyncCommand::Key(SyncKeyCommand::Export) => {
            let v = sync_key_export(paths)?;
            print(&v, json_out, |v| {
                v["key"].as_str().unwrap_or("").to_string()
            });
        }
        SyncCommand::Key(SyncKeyCommand::Import { key }) => {
            let v = sync_key_import(paths, &key)?;
            print(&v, json_out, |v| {
                format!(
                    "key {} stored in the {}; encryption on",
                    v["key_id"].as_str().unwrap_or(""),
                    v["stored_in"].as_str().unwrap_or("")
                )
            });
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
                    "database {}\nvideos   {}\naudio    {}\nstaged   {}\ntotal    {} of {}",
                    human_bytes(u.db_bytes),
                    human_bytes(u.video_bytes),
                    human_bytes(u.audio_bytes),
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
        StorageCommand::Forget { tr, yes } => {
            let r = storage_forget(paths, &tr, yes)?;
            let fmt = |ms: Option<i64>| {
                ms.and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|t| {
                        t.with_timezone(&chrono::Local)
                            .format("%Y-%m-%dT%H:%M:%S")
                            .to_string()
                    })
                    .unwrap_or_else(|| "-".into())
            };
            print(&serde_json::to_value(&r)?, json_out, |_| {
                format!(
                    "{} {} chunks, {} frames, {} audio segments ({} .. {}); {} remote objects {}{}",
                    if r.dry_run { "would delete" } else { "deleted" },
                    r.chunks,
                    r.frames,
                    r.audio,
                    fmt(r.start_ms),
                    fmt(r.end_ms),
                    r.remote_objects_queued,
                    if r.dry_run {
                        "would be deleted"
                    } else {
                        "queued for deletion"
                    },
                    if r.dry_run {
                        "
run again with --yes to delete"
                    } else {
                        ""
                    },
                )
            });
        }
        StorageCommand::Enforce => {
            let conn = store::open(paths)?;
            let mut engine = Engine::new()?;
            retention::enforce(&conn, paths, &mut engine, &s)?;
            let u = retention::usage(paths);
            print(&json!({"total_bytes": u.total()}), json_out, |_| {
                format!("total {}", human_bytes(u.total()))
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_opens_the_settings_pane_of_the_first_missing_permission() {
        let g = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(missing_permission_pane(&g(&[]), false), Some("Privacy_ScreenCapture"));
        assert_eq!(missing_permission_pane(&g(&["screen", "accessibility", "input_monitoring"]), true), Some("Privacy_ScreenCapture"), "capture fails although macOS lists it");
        assert_eq!(missing_permission_pane(&g(&["screen"]), false), Some("Privacy_Accessibility"));
        assert_eq!(missing_permission_pane(&g(&["screen", "accessibility"]), false), Some("Privacy_ListenEvent"));
        assert_eq!(missing_permission_pane(&g(&["screen", "accessibility", "input_monitoring"]), false), None);
    }


    #[test]
    fn pause_until_tomorrow_ends_at_six_local_the_next_day() {
        use chrono::{Local, TimeZone, Timelike};
        let now = Local.with_ymd_and_hms(2026, 10, 14, 23, 50, 0).unwrap().timestamp_millis();
        let t = Local.timestamp_millis_opt(tomorrow_6am_ms(now)).unwrap();
        assert_eq!((t.format("%Y-%m-%d").to_string(), t.hour(), t.minute()), ("2026-10-15".to_string(), 6, 0));
        let morning = Local.with_ymd_and_hms(2026, 10, 14, 5, 0, 0).unwrap().timestamp_millis();
        let t = Local.timestamp_millis_opt(tomorrow_6am_ms(morning)).unwrap();
        assert_eq!(t.format("%Y-%m-%d").to_string(), "2026-10-15", "always the next day");
    }


    #[test]
    fn durations_parse() {
        assert_eq!(parse_duration_ms("15m"), Some(900_000));
        assert_eq!(parse_duration_ms("1h"), Some(3_600_000));
        assert_eq!(parse_duration_ms("1.5h"), Some(5_400_000));
        assert_eq!(parse_duration_ms("2d"), Some(172_800_000));
        assert_eq!(parse_duration_ms("soon"), None);
    }

    #[test]
    fn sync_setup_needs_a_bucket_only_for_s3() {
        let c = Cli::try_parse_from(["kortix-capture", "sync", "setup", "--provider", "kortix"])
            .unwrap();
        match c.command {
            Command::Sync(SyncCommand::Setup(a)) => {
                assert_eq!((a.provider.as_str(), a.endpoint), ("kortix", None))
            }
            _ => panic!(),
        }
        assert!(Cli::try_parse_from([
            "kortix-capture",
            "sync",
            "setup",
            "--endpoint",
            "http://127.0.0.1:9000",
            "--bucket",
            "b"
        ])
        .is_ok());
        assert!(
            Cli::try_parse_from(["kortix-capture", "sync", "setup", "--provider", "ftp"]).is_err()
        );
        assert!(Cli::try_parse_from(["kortix-capture", "sync", "now"]).is_ok());
    }

    #[test]
    fn cli_parses_query_shapes() {
        let c = Cli::try_parse_from([
            "kortix-capture",
            "--json",
            "query",
            "fts",
            "webhook",
            "--tr",
            "2026-01-15",
            "--app-filter",
            "safari",
            "--limit",
            "5",
        ])
        .unwrap();
        assert!(c.json);
        let c = Cli::try_parse_from([
            "kortix-capture",
            "query",
            "axtree",
            "--id",
            "12",
            "--role",
            "AXButton",
            "AXLink",
        ])
        .unwrap();
        match c.command {
            Command::Query(QueryCommand::Axtree { role, .. }) => {
                assert_eq!(role, vec!["AXButton", "AXLink"])
            }
            _ => panic!(),
        }
        assert!(Cli::try_parse_from(["kortix-capture", "link", "at", "3d", "ago"]).is_ok());
        assert!(Cli::try_parse_from([
            "kortix-capture",
            "usage",
            "sessions",
            "--gap",
            "10",
            "--domain-filter",
            "github.com"
        ])
        .is_ok());
    }

    fn live_status(state: &str, reason: Option<&str>) -> RecorderStatus {
        RecorderStatus {
            pid: std::process::id(),
            state: state.into(),
            inactive_reason: reason.map(str::to_string),
            updated_at_ms: now_ms(),
            ..Default::default()
        }
    }

    #[test]
    fn the_tray_the_window_and_status_json_read_one_state() {
        let dir = std::env::temp_dir().join(format!("kcap-state-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let write = |st: &RecorderStatus| std::fs::write(paths.status(), serde_json::to_vec(st).unwrap()).unwrap();
        let three = || {
            (
                recording_state(&paths),                             // the tray and /api/app
                status_value(&paths)["state"].as_str().unwrap().to_string(), // `status --json`
                device_status(&paths, "t")["recording"].as_str().unwrap().to_string(), // status.json
            )
        };
        // The recorder records: all three say recording.
        write(&live_status("recording", None));
        let r = ("recording".to_string(), "recording".to_string(), "recording".to_string());
        assert_eq!(three(), r);
        // It waits for Screen Recording (capture fails): all three say so, together.
        let mut st = live_status("permission_missing", None);
        st.permissions = Some(serde_json::json!({"screen": false, "accessibility": true}));
        write(&st);
        let p = ("permission_missing".to_string(), "permission_missing".to_string(), "permission_missing".to_string());
        assert_eq!(three(), p);
        // A privacy pause of its own is "paused" for all three, never "not recording".
        write(&live_status("inactive", Some("excluded_app")));
        let (a, b, c) = three();
        assert!(a == "paused" && b == "paused" && c == "paused", "{a} {b} {c}");
        // A stale status (the recorder died) is "not recording" for all three.
        let mut old = live_status("recording", None);
        old.updated_at_ms = now_ms() - 60_000;
        write(&old);
        assert_eq!(three(), ("not_recording".to_string(), "not_recording".to_string(), "not_recording".to_string()));
        // A sign-in that went away does not stop the recording (the sync is a separate matter).
        write(&live_status("recording", None));
        let mut s = Settings::load(&paths);
        s.sync.provider = "kortix".into();
        s.sync.enabled = false;
        s.save(&paths).unwrap();
        assert_eq!(three(), r);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inactive_reason_is_one_vocabulary_for_every_gate() {
        let now = 10_000;
        let on = Settings::default();
        // Recording: no reason. Not running: say so.
        assert_eq!(
            inactive_reason(&on, Some(&live_status("recording", None)), true, now),
            None
        );
        assert_eq!(
            inactive_reason(&on, None, false, now).as_deref(),
            Some("not_running")
        );
        // The recorder's own gates and the engine's skips pass through unchanged.
        for r in [
            "low_disk",
            "sync_backlog",
            "self_on_screen",
            "locked",
            "inactive",
            "excluded_app",
            "excluded_domain",
            "not_included",
            "private_browsing",
            "error",
        ] {
            assert_eq!(
                inactive_reason(&on, Some(&live_status(r, Some(r))), true, now).as_deref(),
                Some(r)
            );
        }
        // Settings gates win and show at once, even while the recorder is down or has not ticked.
        let mut paused = Settings::default();
        paused.paused_until_ms = Some(now + 1);
        assert_eq!(
            inactive_reason(&paused, Some(&live_status("recording", None)), true, now).as_deref(),
            Some("paused")
        );
        assert_eq!(
            inactive_reason(&paused, None, false, now).as_deref(),
            Some("paused")
        );
        assert_eq!(
            inactive_reason(&paused, None, false, now + 2).as_deref(),
            Some("not_running"),
            "an expired pause is over"
        );
        let mut off = Settings::default();
        off.recording_enabled = false;
        assert_eq!(
            inactive_reason(&off, None, false, now).as_deref(),
            Some("disabled")
        );
    }

    fn scratch(tag: &str) -> MemoryPaths {
        let dir = std::env::temp_dir().join(format!("kmem-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        MemoryPaths::at(dir)
    }

    #[test]
    fn status_json_reports_the_frame_rate_and_size_the_policy_set() {
        let paths = scratch("policy-rate");
        std::fs::create_dir_all(&paths.root).unwrap();
        std::fs::write(paths.settings(), r#"{"sync": {"enabled": true}}"#).unwrap();
        std::fs::write(
            super::super::policy::path(&paths),
            r#"{"source": "orgs/a/policy.json", "fetched_at_ms": 1,
                "policy": {"schema": 2, "recording": {"interval_ms": 1000, "max_height": 2160}}}"#,
        )
        .unwrap();
        let v = device_status(&paths, "v1");
        assert_eq!(v["capture"], json!({"intervalMs": 1000, "maxHeight": 2160}));
        // With sync off the device follows no policy: its own settings apply.
        std::fs::write(paths.settings(), r#"{"sync": {"enabled": false}}"#).unwrap();
        let v = device_status(&paths, "v1");
        assert_eq!(v["capture"], json!({"intervalMs": 2000, "maxHeight": 1440}));
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn device_status_names_each_display_and_its_last_frame() {
        let now = 10_000_000;
        let rec = RecorderStatus {
            state: "recording".into(),
            updated_at_ms: now,
            last_capture_ms: Some(now - 2_000),
            displays: vec![
                recorder::DisplayStatus {
                    id: 1,
                    name: Some("Built-in Retina Display".into()),
                    main: true,
                    focused: true,
                    x: 0.0,
                    y: 0.0,
                    w: 1728.0,
                    h: 1117.0,
                    scale: 2.0,
                    last_frame_ms: Some(now - 2_000),
                },
                recorder::DisplayStatus {
                    id: 2,
                    name: Some("LG ULTRAWIDE".into()),
                    main: false,
                    focused: false,
                    x: 1728.0,
                    y: 0.0,
                    w: 3440.0,
                    h: 1440.0,
                    scale: 1.0,
                    last_frame_ms: Some(now - 20_000),
                },
            ],
            ..Default::default()
        };
        let v = summarize_device_status(
            &Settings::default(),
            Some(&rec),
            true,
            None,
            None,
            now,
            "v1",
            true,
        );
        assert_eq!(
            v["displays"],
            json!([
                {"id": 1, "name": "Built-in Retina Display", "main": true, "focused": true, "lastFrameMs": now - 2_000},
                {"id": 2, "name": "LG ULTRAWIDE", "main": false, "focused": false, "lastFrameMs": now - 20_000},
            ])
        );
    }

    #[test]
    fn device_status_names_what_readers_show() {
        use super::super::sync::SyncState;
        let now = 10_000_000;
        let s = Settings::default();
        let rec = |state: &str| RecorderStatus {
            state: state.into(),
            updated_at_ms: now,
            last_capture_ms: Some(now - 2_000),
            ..Default::default()
        };
        let v = summarize_device_status(
            &s,
            Some(&rec("recording")),
            true,
            None,
            None,
            now,
            "v1",
            true,
        );
        assert_eq!(v["recording"], "recording");
        assert_eq!(v["reason"], Value::Null);
        assert_eq!(v["lastFrameMs"], now - 2_000);
        assert_eq!(v["appVersion"], "v1");
        assert_eq!(v["audio"]["enabled"], false);
        assert_eq!(v["capture"], json!({"intervalMs": 2000, "maxHeight": 1440}));

        let mut idle = rec("inactive");
        idle.inactive_reason = Some("inactive".into());
        let v = summarize_device_status(&s, Some(&idle), true, None, None, now, "v1", false);
        assert_eq!(
            (v["recording"].as_str(), v["reason"].as_str()),
            (Some("paused"), Some("inactive"))
        );

        let mut denied = rec("error");
        denied.permissions = Some(json!({"screen": false, "accessibility": true}));
        let v = summarize_device_status(&s, Some(&denied), true, None, None, now, "v1", false);
        assert_eq!(v["recording"], "permission_missing");
        assert_eq!(v["missingPermissions"], json!(["screen_recording"]));

        // The recorder's own "permission_missing" idle reads the same way.
        let mut waiting = rec("permission_missing");
        waiting.inactive_reason = Some("permission_missing".into());
        waiting.permissions = Some(json!({"screen": false, "accessibility": true}));
        let v = summarize_device_status(&s, Some(&waiting), true, None, None, now, "v1", false);
        assert_eq!(v["recording"], "permission_missing");
        assert_eq!(v["reason"], "permission_missing");

        let v = summarize_device_status(
            &s,
            Some(&rec("recording")),
            false,
            None,
            None,
            now,
            "v1",
            false,
        );
        assert_eq!(
            (v["recording"].as_str(), v["reason"].as_str()),
            (Some("not_recording"), Some("not_running"))
        );

        let mut off = Settings::default();
        off.recording_enabled = false;
        let v = summarize_device_status(
            &off,
            Some(&rec("disabled")),
            true,
            None,
            None,
            now,
            "v1",
            false,
        );
        assert_eq!(
            (v["recording"].as_str(), v["reason"].as_str()),
            (Some("not_recording"), Some("disabled"))
        );

        let mut paused = Settings::default();
        paused.paused_until_ms = Some(now + 60_000);
        let v = summarize_device_status(
            &paused,
            Some(&rec("paused")),
            true,
            None,
            None,
            now,
            "v1",
            false,
        );
        assert_eq!(v["recording"], "paused");
        assert_eq!(v["pausedUntilMs"], now + 60_000);

        let mut synced = Settings::default();
        synced.sync.enabled = true;
        let queued = SyncState {
            state: "ok".into(),
            pending: 3,
            ..Default::default()
        };
        let v = summarize_device_status(
            &synced,
            Some(&rec("recording")),
            true,
            None,
            Some(&queued),
            now,
            "v1",
            false,
        );
        assert_eq!(
            v["sync"],
            json!({"state": "queued", "pending": 3, "errorClass": null, "lastUploadMs": null})
        );
        let failing = SyncState {
            state: "error".into(),
            last_error_class: Some("auth".into()),
            ..Default::default()
        };
        let v = summarize_device_status(
            &synced,
            Some(&rec("recording")),
            true,
            None,
            Some(&failing),
            now,
            "v1",
            false,
        );
        assert_eq!(
            (
                v["sync"]["state"].as_str(),
                v["sync"]["errorClass"].as_str()
            ),
            (Some("error"), Some("auth"))
        );
        let v = summarize_device_status(&s, None, false, None, Some(&failing), now, "v1", false);
        assert_eq!(v["sync"], json!({"state": "off"}));
    }

    #[test]
    fn status_reports_inactive_reason_from_a_library() {
        let paths = scratch("status");
        paths.ensure().unwrap();
        let mut st = live_status("low_disk", Some("low_disk"));
        st.reason = Some("less than 5 GB free".into());
        std::fs::write(paths.status(), serde_json::to_vec(&st).unwrap()).unwrap();
        let v = status_value(&paths);
        assert_eq!(v["inactive_reason"], "low_disk");
        assert_eq!(v["effective_state"], "low_disk");
        assert_eq!(v["resolution"], "1440p");
        let mut s = Settings::default();
        s.paused_until_ms = Some(now_ms() + 60_000);
        s.save(&paths).unwrap();
        assert_eq!(status_value(&paths)["inactive_reason"], "paused");
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    /// `status --json` carries the same four words as status.json, so the app,
    /// the menu bar and Kortix show one state.
    #[test]
    fn status_carries_the_four_word_state() {
        let paths = scratch("status-state");
        paths.ensure().unwrap();
        let write = |st: &RecorderStatus| {
            std::fs::write(paths.status(), serde_json::to_vec(st).unwrap()).unwrap()
        };
        write(&live_status("recording", None));
        assert_eq!(status_value(&paths)["state"], "recording");
        write(&live_status("locked", Some("locked")));
        assert_eq!(status_value(&paths)["state"], "paused");
        let mut st = live_status("permission_missing", Some("permission_missing"));
        st.permissions = Some(json!({"screen": false, "accessibility": true}));
        write(&st);
        let v = status_value(&paths);
        assert_eq!(v["state"], "permission_missing");
        assert_eq!(v["effective_state"], "permission_missing");
        let _ = std::fs::remove_dir_all(&paths.root);
        assert_eq!(status_value(&paths)["state"], "not_recording");
    }

    #[test]
    fn settings_resolution_sets_reads_and_keeps_custom() {
        let paths = scratch("res");
        let run = |key: &str, value: Option<&str>| {
            settings(
                &paths,
                SettingsArgs {
                    key: Some(key.into()),
                    value: value.map(str::to_string),
                },
                true,
            )
        };
        run("resolution", Some("1080p")).unwrap();
        let s = Settings::load(&paths);
        assert_eq!((s.max_width, s.max_height), (1920, 1080));
        run("resolution", Some("4K")).unwrap();
        assert_eq!(Settings::load(&paths).resolution_name(), "4k");
        assert!(run("resolution", Some("8k"))
            .unwrap_err()
            .to_string()
            .contains("unknown resolution"));
        assert_eq!(Settings::load(&paths).resolution_name(), "4k");
        // Custom sizes still work through the plain keys.
        run("max_width", Some("1600")).unwrap();
        run("max_height", Some("900")).unwrap();
        assert_eq!(Settings::load(&paths).resolution_name(), "custom");
        // New settings are reachable by key.
        run("capture_on_change", Some("false")).unwrap();
        run("storage.reserve_mb", Some("250")).unwrap();
        let s = Settings::load(&paths);
        assert!(!s.capture_on_change);
        assert_eq!(s.storage.reserve_mb, 250);
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn settings_refuses_what_the_settings_window_refuses() {
        let paths = scratch("validate");
        let run = |key: &str, value: &str| {
            settings(
                &paths,
                SettingsArgs {
                    key: Some(key.into()),
                    value: Some(value.into()),
                },
                true,
            )
        };
        for (key, value) in [
            ("sync.concurrency", "9"),
            ("sync.part_mb", "4"),
            ("sync.provider", "ftp"),
            ("ocr_level", "best"),
            ("staging_quality", "0"),
            ("interval_ms", "100"),
            ("storage.management_mode", "never"),
        ] {
            let err = run(key, value).unwrap_err().to_string();
            assert!(err.contains(key), "{key}={value}: {err}");
        }
        run("sync.provider", "kortix").unwrap();
        assert!(run("sync.encrypt", "true")
            .unwrap_err()
            .to_string()
            .contains("kortix provider"));
        assert_eq!(Settings::load(&paths).sync.concurrency, 3);
        run("sync.concurrency", "8").unwrap();
        assert_eq!(Settings::load(&paths).sync.concurrency, 8);
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn cli_parses_axattrs_and_requires_tr_at_run_time() {
        let c = Cli::try_parse_from([
            "kortix-capture",
            "--json",
            "query",
            "axattrs",
            "--tr",
            "since:2026-01-01",
            "--app-filter",
            "safari",
            "--limit",
            "50",
        ])
        .unwrap();
        assert!(c.json);
        match c.command {
            Command::Query(QueryCommand::Axattrs { filters, limit }) => {
                assert_eq!(filters.tr.as_deref(), Some("since:2026-01-01"));
                assert_eq!(limit, 50);
            }
            _ => panic!(),
        }
        assert!(
            Cli::try_parse_from(["kortix-capture", "query", "axattrs"]).is_ok(),
            "--tr is checked when the command runs, with an example"
        );
        assert!(Cli::try_parse_from([
            "kortix-capture",
            "query",
            "sample",
            "--tr",
            "before:2026-06-01"
        ])
        .is_ok());
        assert!(Cli::try_parse_from(["kortix-capture", "settings", "resolution", "1080p"]).is_ok());
    }
}
