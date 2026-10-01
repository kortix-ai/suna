// Compiles the macOS capture engine (native/macos/CaptureEngine.swift)
// into OUT_DIR and exposes its path as KORTIX_CAPTURE_ENGINE_BUILD_PATH so dev
// builds find it without packaging. Release packaging copies the same binary
// next to kortix-capture inside the .app bundle.

use std::{env, path::PathBuf, process::Command};

fn main() {
    let source = "native/macos/CaptureEngine.swift";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-changed=build.rs");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x86_64",
        _ => "arm64",
    };
    let output = out_dir.join("kortix-capture-engine");
    let status = Command::new("xcrun")
        .args(["swiftc", "-O", "-swift-version", "5", "-target"])
        .arg(format!("{arch}-apple-macosx14.0"))
        .arg(source)
        .arg("-o")
        .arg(&output)
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=KORTIX_CAPTURE_ENGINE_BUILD_PATH={}", output.display());
        }
        Ok(s) => println!("cargo:warning=capture engine build failed ({s}); Kortix Capture disabled"),
        Err(err) => println!("cargo:warning=swiftc unavailable ({err}); Kortix Capture disabled"),
    }
}
