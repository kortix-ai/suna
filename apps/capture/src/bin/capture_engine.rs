//! `kortix-capture-engine` entrypoint for Windows and Linux. macOS ships the
//! Swift engine instead (see `build.rs`); this binary exits with an error there.

fn main() {
    if let Err(err) = kortix_backend::capture_engine::run() {
        eprintln!("Error: {err:#}");
        std::process::exit(1);
    }
}
