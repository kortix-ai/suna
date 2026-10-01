//! `kortix-capture-engine` entrypoint for Windows and Linux. macOS ships the
//! Swift engine instead (see `build.rs`); this binary exits with an error there.

fn main() {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    if let Err(err) = kortix_capture::capture_engine::run() {
        eprintln!("Error: {err:#}");
        std::process::exit(1);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        eprintln!("Error: kortix-capture-engine is not built for this OS; macOS uses the Swift engine");
        std::process::exit(1);
    }
}
