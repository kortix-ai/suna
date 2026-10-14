//! Client for the native capture engine sidecar (`kortix-capture-engine`).
//!
//! One JSON request per line in, one JSON response per line out. A request
//! that exceeds its timeout kills the sidecar; the next request respawns it,
//! so a wedged ScreenCaptureKit or Vision call never stalls the recorder.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

pub const ENGINE_ENV: &str = "KORTIX_CAPTURE_ENGINE";
pub const ENGINE_NAME: &str = "kortix-capture-engine";

/// Engine file name for this platform (`kortix-capture-engine.exe` on Windows).
fn engine_file() -> String {
    format!("{ENGINE_NAME}{}", std::env::consts::EXE_SUFFIX)
}

/// Engine lookup order: $KORTIX_CAPTURE_ENGINE; inside an installed app bundle
/// (`.app/Contents/`), the engine next to this binary or in the bundle's
/// Resources, which the app signs and ships; otherwise (macOS) the Swift engine
/// build.rs baked in, then next to this binary, then the baked path.
///
/// Outside an app bundle on macOS, a `cargo build --features native-recorders`
/// drops the Rust stub of `kortix-capture-engine` next to `kortix-capture`; the
/// baked Swift engine must win over it. Inside an app bundle the baked path
/// points into the build machine's tree and must never win over the bundled engine.
pub fn locate() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(ENGINE_ENV) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok();
    locate_from(
        exe.as_deref(),
        option_env!("KORTIX_CAPTURE_ENGINE_BUILD_PATH").map(Path::new),
        cfg!(target_os = "macos"),
    )
}

fn locate_from(exe: Option<&Path>, baked: Option<&Path>, macos: bool) -> Option<PathBuf> {
    let baked = baked.filter(|p| p.is_file()).map(Path::to_path_buf);
    let file = engine_file();
    let beside: Vec<PathBuf> = exe
        .and_then(Path::parent)
        .map(|dir| vec![dir.join(&file), dir.join("../Resources").join(&file)])
        .unwrap_or_default();
    let bundled = exe.is_some_and(|e| e.to_string_lossy().contains(".app/Contents/"));
    if macos && !bundled {
        if let Some(p) = &baked {
            return Some(p.clone());
        }
    }
    beside.into_iter().find(|p| p.is_file()).or(baked)
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
    #[cfg(test)]
    pub(crate) fn without_process_for_test() -> Self {
        Self {
            path: PathBuf::from("missing-synthetic-capture-engine"),
            proc: None,
            next_id: 1,
        }
    }

    pub fn new() -> Result<Self> {
        let path = locate().ok_or_else(|| {
            anyhow!("{ENGINE_NAME} not found; build it with `cargo build --release --features native-recorders --bin {ENGINE_NAME}` (macOS builds it from Swift via build.rs) or set {ENGINE_ENV}")
        })?;
        Ok(Self {
            path,
            proc: None,
            next_id: 1,
        })
    }

    fn spawn(&mut self) -> Result<&mut Proc> {
        if self.proc.is_none() {
            let mut child = crate::os_proc::no_window(&mut Command::new(&self.path))
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
            self.proc = Some(Proc {
                child,
                stdin,
                lines: rx,
            });
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
        let private = req.get("cmd").and_then(Value::as_str) == Some("capture_private");
        let id = self.next_id;
        self.next_id += 1;
        req["id"] = json!(id);
        let line = serde_json::to_string(&req)? + "\n";
        let write = {
            let p = self.spawn()?;
            p.stdin
                .write_all(line.as_bytes())
                .and_then(|_| p.stdin.flush())
        };
        if let Err(err) = write {
            self.kill();
            bail!("engine write failed: {err}");
        }
        loop {
            let recv = self
                .proc
                .as_ref()
                .expect("spawned")
                .lines
                .recv_timeout(timeout);
            match recv {
                Ok(text) => {
                    // Engine replies can include raw private pixels/text in RAM.
                    // Never echo a malformed reply into persisted recorder logs.
                    let value: Value =
                        serde_json::from_str(&text).context("engine sent invalid JSON")?;
                    if value.get("id").and_then(Value::as_u64) != Some(id) {
                        continue; // stale response from a timed-out request
                    }
                    if value.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(value);
                    }
                    if private {
                        // Native errors may quote OCR inputs. They must not
                        // reach status files or logs for private captures.
                        bail!("private capture rejected by native engine");
                    }
                    bail!(
                        "{}",
                        value
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("engine error")
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

#[cfg(test)]
mod locate_tests {
    use super::*;

    #[test]
    fn an_installed_app_runs_its_bundled_engine_never_the_build_tree() {
        let root =
            std::env::temp_dir().join(format!("kce-locate-{}", uuid::Uuid::new_v4().simple()));
        let app = root.join("Kortix.app/Contents/Resources/capture");
        let tree = root.join("target/release");
        let baked = root.join("out/kortix-capture-engine-swift");
        for d in [&app, &tree, &baked.parent().unwrap().to_path_buf()] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(app.join(engine_file()), b"bundled").unwrap();
        std::fs::write(tree.join(engine_file()), b"rust stub").unwrap();
        std::fs::write(&baked, b"swift").unwrap();
        // Installed app: the bundled engine, even though the build tree exists on this machine.
        assert_eq!(
            locate_from(Some(&app.join("kortix-capture")), Some(&baked), true),
            Some(app.join(engine_file()))
        );
        // Build tree on macOS: the baked Swift engine wins over the Rust stub beside it.
        assert_eq!(
            locate_from(Some(&tree.join("kortix-capture")), Some(&baked), true),
            Some(baked.clone())
        );
        // Windows/Linux: the engine beside the binary.
        assert_eq!(
            locate_from(Some(&tree.join("kortix-capture")), Some(&baked), false),
            Some(tree.join(engine_file()))
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
