// Compiles the macOS capture engine (native/macos/CaptureEngine.swift)
// into OUT_DIR and exposes its path as KORTIX_CAPTURE_ENGINE_BUILD_PATH so dev
// builds find it without packaging. Release packaging copies the same binary
// next to kortix-capture inside the .app bundle.

use std::{env, path::PathBuf, process::Command};

fn main() {
    let source = "native/macos/CaptureEngine.swift";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-changed=build.rs");

    // Windows: the app icon in every exe (Explorer, the taskbar, a pinned shortcut).
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=assets/icons/windows/app.rc");
        println!("cargo:rerun-if-changed=assets/icons/windows/app.ico");
        embed_resource::compile("assets/icons/windows/app.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("embed the Windows icon");
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x86_64",
        _ => "arm64",
    };
    let output = out_dir.join("kortix-capture-engine");
    // The engine is a background helper: an embedded Info.plist with LSUIElement keeps it out
    // of the Dock from its first instant. It keeps the app's bundle id, so macOS attributes
    // its permissions to Kortix Capture as before.
    let plist = out_dir.join("engine-info.plist");
    std::fs::write(
        &plist,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.kortix.capture</string>
<key>CFBundleName</key><string>Kortix Capture</string>
<key>CFBundleExecutable</key><string>kortix-capture-engine</string>
<key>LSUIElement</key><true/>
</dict></plist>
"#,
    )
    .expect("write engine-info.plist");
    let status = Command::new("xcrun")
        .args(["swiftc", "-O", "-swift-version", "5", "-target"])
        .arg(format!("{arch}-apple-macosx14.0"))
        .arg(source)
        .args(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker"])
        .arg(&plist)
        .arg("-o")
        .arg(&output)
        .status();
    match status {
        Ok(s) if s.success() => {
            println!(
                "cargo:rustc-env=KORTIX_CAPTURE_ENGINE_BUILD_PATH={}",
                output.display()
            );
        }
        Ok(s) => {
            println!("cargo:warning=capture engine build failed ({s}); Kortix Capture disabled")
        }
        Err(err) => println!("cargo:warning=swiftc unavailable ({err}); Kortix Capture disabled"),
    }
}
