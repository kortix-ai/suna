//! Client for the native capture engine sidecar (`kortix-capture-engine`).
//!
//! One JSON request per line in, one JSON response per line out. A request
//! that exceeds its timeout kills the sidecar; the next request respawns it,
//! so a wedged ScreenCaptureKit or Vision call never stalls the recorder.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

pub const ENGINE_ENV: &str = "KORTIX_CAPTURE_ENGINE";
pub const ENGINE_NAME: &str = "kortix-capture-engine";

/// Engine file name for this platform (`kortix-capture-engine.exe` on Windows).
fn engine_file() -> String {
    format!("{ENGINE_NAME}{}", std::env::consts::EXE_SUFFIX)
}

/// Engine lookup order: $KORTIX_CAPTURE_ENGINE, (macOS only) the Swift engine
/// build.rs baked in, next to the current executable, the bundle's Resources
/// dir, then the baked path.
///
/// On macOS a `cargo build --features native-recorders` also drops the Rust
/// stub of `kortix-capture-engine` next to `kortix-capture`; the baked Swift
/// engine must win over it.
pub fn locate() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(ENGINE_ENV) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let baked = option_env!("KORTIX_CAPTURE_ENGINE_BUILD_PATH").map(PathBuf::from).filter(|p| p.is_file());
    if cfg!(target_os = "macos") {
        if let Some(p) = &baked {
            return Some(p.clone());
        }
    }
    let file = engine_file();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [dir.join(&file), dir.join("../Resources").join(&file)] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    baked
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

pub struct Engine {
    path: PathBuf,
    proc: Option<Proc>,
    next_id: u64,
}

impl Engine {
    pub fn new() -> Result<Self> {
        let path = locate().ok_or_else(|| {
            anyhow!("{ENGINE_NAME} not found; build it with `cargo build --release --features native-recorders --bin {ENGINE_NAME}` (macOS builds it from Swift via build.rs) or set {ENGINE_ENV}")
        })?;
        Ok(Self { path, proc: None, next_id: 1 })
    }

    fn spawn(&mut self) -> Result<&mut Proc> {
        if self.proc.is_none() {
            let mut child = Command::new(&self.path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .with_context(|| format!("spawn {}", self.path.display()))?;
            let stdin = child.stdin.take().context("engine stdin")?;
            let stdout = child.stdout.take().context("engine stdout")?;
            let (tx, rx) = mpsc::channel();
            std::thread::Builder::new()
                .name("capture-engine-reader".into())
                .spawn(move || {
                    for line in BufReader::new(stdout).lines() {
                        let Ok(line) = line else { break };
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                })?;
            self.proc = Some(Proc { child, stdin, lines: rx });
        }
        Ok(self.proc.as_mut().expect("spawned"))
    }

    pub fn kill(&mut self) {
        if let Some(mut p) = self.proc.take() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }

    /// Send one request; returns the response object when `ok` is true.
    pub fn request(&mut self, mut req: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        req["id"] = json!(id);
        let line = serde_json::to_string(&req)? + "\n";
        let write = {
            let p = self.spawn()?;
            p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush())
        };
        if let Err(err) = write {
            self.kill();
            bail!("engine write failed: {err}");
        }
        loop {
            let recv = self.proc.as_ref().expect("spawned").lines.recv_timeout(timeout);
            match recv {
                Ok(text) => {
                    let value: Value = serde_json::from_str(&text).with_context(|| format!("engine sent {text:?}"))?;
                    if value.get("id").and_then(Value::as_u64) != Some(id) {
                        continue; // stale response from a timed-out request
                    }
                    if value.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(value);
                    }
                    bail!(
                        "{}",
                        value.get("error").and_then(Value::as_str).unwrap_or("engine error")
                    );
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill();
                    bail!("engine timed out after {timeout:?}");
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.kill();
                    bail!("engine exited");
                }
            }
        }
    }

    pub fn permissions(&mut self) -> Result<Value> {
        self.request(json!({"cmd": "permissions"}), Duration::from_secs(10))
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.kill();
    }
}
