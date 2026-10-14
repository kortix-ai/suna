//! `kortix-capture`: capture recorder and agent CLI.

use clap::Parser;
use kortix_backend::memory::cli::{self, Cli};

fn main() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn,kortix_backend=info".into());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_writer(std::io::stderr)
        .try_init();
    // Opened from Finder (no arguments) inside `Kortix Capture.app`: the menu-bar app.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app_launch = cfg!(target_os = "macos")
        && args.iter().all(|a| a.starts_with("-psn_"))
        && std::env::current_exe()
            .is_ok_and(|e| e.to_string_lossy().contains(".app/Contents/MacOS/"));
    let result = if app_launch {
        cli::app(&kortix_backend::memory::paths::MemoryPaths::resolve())
    } else {
        cli::run(Cli::parse())
    };
    if let Err(err) = result {
        eprintln!("Error: {err:#}");
        std::process::exit(1);
    }
}
