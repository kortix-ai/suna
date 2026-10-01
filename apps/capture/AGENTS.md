# apps/capture

Rust crate `kortix-capture`. It records the screen of one machine (a frame about every 2 seconds, OCR text, 1 fps HEVC chunks) and uploads the chunks to the user's Kortix account. The web app is the UI. The crate has no window.

Bins:
- `kortix-capture`: `record` plus local read commands (`status`, `query`, `usage`, `now`, `grab-screen`, `install-skill`) for debugging and agents.
- `kortix-capture-engine`: Windows and Linux engine. macOS uses the Swift engine in `native/macos/CaptureEngine.swift`. `build.rs` compiles it into `OUT_DIR`.

Module map: `src/memory/mod.rs`. Upload protocol and gate: `src/memory/uploader.rs`.

## Build and test

```
cd apps/capture
cargo build --release
cargo test                      # unit tests, uploader tests against an in-process mock API
scripts/build-macos-universal.sh   # release binaries, needs both Apple Rust targets
KORTIX_CAPTURE_REAL_LIB=<library dir> cargo test real_library -- --ignored --nocapture   # upload a real library to the mock
```

Manual run without the API gate: `KORTIX_CAPTURE_DIR=<scratch dir> target/release/kortix-capture record --local --duration 60`. Never commit a recorded library.

## Behavior

- Without `--local`, capture runs only while `GET /v1/capture/agent/config` returns `capture_allowed: true`. No credential, or `capture_allowed: false`, gives state `off` in `recorder.json` and no frames.
- Each finalized video uploads once: `POST /v1/capture/agent/chunks`, `PUT` to the returned URL, `POST .../commit`. Failures back off 5 s to 10 min per video.
- After the upload commits, the local video is deleted after `upload.keep_local_hours` (24) and the text rows after `upload.text_keep_days` (7). Both are keys in `settings.json`.
- `recorder.json` has `upload: { pending, last_success_at, last_error }`. `kortix-capture status` prints it.

## Environment variables

| Variable | Use |
|---|---|
| `KORTIX_CAPTURE_DIR` | Library directory. Default: `ai.kortix.capture` under the platform data dir. |
| `KORTIX_CAPTURE_API_URL` | API origin. Default: `apiUrl` from the agent-tunnel config. |
| `AGENT_TUNNEL_HOME` | Directory of the agent-tunnel `config.json` (`token`, `tunnelId`, `apiUrl`). Default `~/.agent-tunnel`. |
| `KORTIX_CAPTURE_PARENT_PID` | Supervisor pid. `record` exits when this process is gone. |
| `KORTIX_CAPTURE_ENGINE` | Path of an engine binary. Default: next to the executable. |

## Rules

- Never name a third-party screen-recording product in code, tests, or text.
- Test data is synthetic. Real recordings stay in scratch directories.
