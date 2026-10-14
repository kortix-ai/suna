//! `kortix-backend --service`: the action recorder of Kortix Capture.
//!
//! `kortix-capture service run` starts it while actions are on for the
//! library, and restarts it when it exits. It records back-to-back action
//! segments into the capture library (`daemon::run_service`); the recorder's
//! sync uploads them.

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use kortix_backend::{
    config::{self, Config},
    daemon::{self, ServiceOptions},
};
use std::env;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
kortix-backend: the Kortix Capture action recorder.

Usage: kortix-backend --service [OPTIONS]

`kortix-capture service run` starts it; it is not meant to be run by hand.
It records back-to-back action segments into the capture library while the
policy allows actions.

Options:
  --service                 Record action segments until SIGINT/SIGTERM
  --segment-seconds <n>     Segment length (default 60, at least 5)
  --save-raw                Keep raw native events
  -h, --help                Print this help
";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if !has_flag(&args, "--service") || has_flag(&args, "--help") || has_flag(&args, "-h") {
        print!("{USAGE}");
        return Ok(());
    }
    let _log_guard = init_tracing()?;
    kortix_backend::os_proc::below_normal_priority();
    let segment_seconds = arg_value(&args, "--segment-seconds")
        .map(|v| v.parse::<u64>())
        .transpose()
        .map_err(|err| anyhow::anyhow!("invalid --segment-seconds: {err}"))?
        .unwrap_or(60)
        .max(5);
    daemon::run_service(
        Config::load(),
        ServiceOptions {
            segment_seconds,
            save_raw_data: has_flag(&args, "--save-raw"),
        },
    )
    .await
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn init_tracing() -> anyhow::Result<Option<WorkerGuard>> {
    let filter = EnvFilter::from_default_env().add_directive("info".parse()?);
    let log_dir = config::log_directory()?;
    if let Err(err) = std::fs::create_dir_all(&log_dir) {
        eprintln!(
            "failed to create log directory {}; falling back to stderr logging: {err}",
            log_dir.display()
        );
        tracing_subscriber::fmt().with_env_filter(filter).init();
        return Ok(None);
    }
    let file_appender = tracing_appender::rolling::never(log_dir, "kortix-backend.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(non_blocking)
        .init();
    Ok(Some(guard))
}
