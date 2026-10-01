//! `kortix-capture`: capture recorder and agent CLI.

use clap::Parser;
use kortix_capture::memory::cli::{self, Cli};

fn main() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn,kortix_capture=info".into());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_writer(std::io::stderr)
        .try_init();
    if let Err(err) = cli::run(Cli::parse()) {
        eprintln!("Error: {err:#}");
        std::process::exit(1);
    }
}
