# Backend Scripts

These scripts are the durable entrypoints distilled from the Rust port and
verification work. Run them from `apps/capture/` unless the command says
otherwise.

## Quick Recording Review

Use this on a Mac when you just want to record, stop, process, render, and open
the HTML viewer without creating a manual contract test fixture:

```bash
cd apps/capture
scripts/run_recording_review.sh review
```

The script starts recording immediately. Do the actions you want to inspect,
then press Enter in the terminal. Output is written under ignored local storage:

```text
artifacts/recording-review/recordings/review/
```

Use a different scratch name when you want a separate review folder:

```bash
scripts/run_recording_review.sh keyboard_nav_try
```

On a new Mac, grant the terminal app Screen Recording, Accessibility, and Input
Monitoring permissions in System Settings.

## Local Verification

### On-device PII: native screen-to-upload test

This manual development command opens a synthetic window for the duration of
verification. It is never launched by the app, CI, login startup, or a release.
No sample executable, fixture, dataset, or benchmark report is included in the
release packages. Run it only when a visible desktop test is wanted.

From `apps/capture/` on macOS:

```bash
python3 scripts/verify_pii_local.py
python3 scripts/verify_pii_local.py --skip-build --out artifacts/pii-local/my-run
```

Requires Xcode command-line tools (`xcrun swiftc`), `ffmpeg`, `zstd`, and Screen
Recording + Accessibility permission for the launching terminal. The script
builds the release recorder and Swift capture engine, opens a native
synthetic support task window, and runs the real recorder in isolated libraries. Every
fixture value is synthetic. A test-only native window filter captures only that
fixture window, independently of focus and during macOS Space transitions; background window
metadata is excluded from evidence. No production library or cloud credentials
are used. The existing library/engine environment overrides are test harness
isolation, not new user configuration requirements.

It verifies:

- Flag disabled: original OCR, searchable values and visible video pixels.
- Flag enabled: placeholders, corrected OCR offsets, no raw values in SQLite or
  its WAL, no sensitive FTS hits, and covered regions in **every video frame**.
- Actual S3 PUT/HEAD verification against an ephemeral localhost server, with
  masked sidecars and uploaded video bytes identical to the inspected video.
- Live enabled → invalid settings reload → disabled → enabled transitions,
  preserving each frame's capture policy and the byte-identical copy path.
- Rejected private OCR: no image, frame or video write and no native error text
  containing the synthetic email in recorder logs/status.
- The native `capture_private` request returns pixels/OCR only over the local
  process pipe and does not create its requested output file.

Output lives under ignored `artifacts/pii-local/<run>/`: `summary.json`,
`report.html`, enabled/disabled PNGs extracted from real encoded video, playable
MP4s, uploaded sidecars, isolated databases and recorder logs. Open `report.html`
for the visual comparison. Reuse `--skip-build` only after rebuilding changes.
The deterministic Rust suite runs on every platform:

```bash
cargo test --release --features native-recorders --lib memory
```

To exercise the local model as well, install it into an isolated library and
pass its directory to the same verifier:

```bash
KORTIX_CAPTURE_DIR="$PWD/artifacts/pii-local/model-library" target/release/kortix-capture privacy-model --install
python3 scripts/verify_pii_local.py --skip-build --model artifacts/pii-local/model-library/privacy-model --out artifacts/pii-local/model-run
```

The environment override above isolates the test library. Normal users use the
Privacy settings download button. Inference runs in Rust with the bundled CPU
ONNX runtime; Python is only a verification/build helper.

Independent synthetic text evaluation (Gretel Apache-2.0 dataset; explicit first
download, then cached/offline runs):

```bash
python3 scripts/verify_pii_dataset.py --download
python3 scripts/verify_pii_dataset.py --skip-build --model artifacts/pii-local/model-library/privacy-model --penalty 2 --limit 256
```

The 5,000-document patterns report and the 256-document model development report
measure full annotated-span coverage, with synthetic positive/negative controls.
They are not universal PII guarantees or an image benchmark. Reports include
misses and all entity types; the model development subset is not a held-out
quality claim. A generated synthetic screenshot dataset/viewer is deferred.

Keyboard/mouse privacy is also verified through the real callback and both event
writers/processor, including flag-off passthrough:

```bash
cargo test --release --features native-recorders --lib privacy_callback_filters_before_raw_and_processed_writes_and_switches_off
```

Action-recorder input events keep activity and coordinates, conceal typed characters, key
codes and accessibility payloads, and replace action screenshots with black
images. Action uploads pause while privacy is enabled. The memory timeline keeps
its finer OCR/model masks and can sync. No native desktop input automation is
required by this repeatable unit integration check.

Run the full local gate:

```bash
scripts/verify_rust_backend.sh
```

It runs:

- `cargo fmt --check`
- `cargo check --all-targets`
- `cargo check --all-targets --features native-recorders`
- `cargo test`
- screenshot sync checker self-test
- trace artifact comparator self-test
- exact Python/Rust processor parity
- 75k event processor resource stress

Useful overrides:

```bash
STRESS_EVENTS=10000 scripts/verify_rust_backend.sh
STRESS_ITERATIONS=5 scripts/verify_rust_backend.sh
PYTHON=python3.12 CARGO=$HOME/.cargo/bin/cargo scripts/verify_rust_backend.sh
```

Check the timeline and settings window (`ui/memory/`) headlessly. The pure
tests need only Node; the window's API is `memory::ui::api::Ctx::handle`, which
`examples/memory_ui_server.rs` serves over HTTP on 127.0.0.1 for a headless
browser. Point it at a scratch library and a scratch `HOME`, and keep the sync
key and the device token out of the OS secret store:

```bash
node ui/memory/timeline.test.mjs && node ui/memory/settings.test.mjs
SCR=$(mktemp -d); mkdir -p "$SCR/lib" "$SCR/home"
KORTIX_CAPTURE_DIR="$SCR/lib" HOME="$SCR/home" KORTIX_CAPTURE_KEY_STORE=file \
  cargo run --example memory_ui_server -- "$SCR/lib" 8765
agent-browser --headed false open 'http://127.0.0.1:8765/#%7B%22view%22%3A%22settings%22%7D'
```

The server never opens the Kortix approval page; the window shows its link and
code. To see the signed-in and policy states, write a synthetic
`$SCR/lib/sync-issuer.json` and `$SCR/lib/policy.json` (shapes in
`src/memory/sync/issuer.rs` and `src/memory/policy.rs`).
For the experimental local privacy controls, run the repeatable headless UI
check (requires Node and the `agent-browser` CLI):

```bash
cargo build --example memory_ui_server
node scripts/verify_privacy_settings_ui.mjs
# Optional: --server /path/to/memory_ui_server --out /path/to/evidence
```

This manual development script starts its own loopback server and scratch
library, uses the real Settings API, and simulates model download/status
responses. It never starts capture, downloads a model, changes the installed
app's settings, or opens a visible sample window. It verifies the collapsed/off
default, download and verification gates, reopening progress, explicit opt-in,
failure/retry states, status recovery, patterns-only messaging, narrow-window
layout and accessibility. Screenshots and `evidence.json` go under
`artifacts/privacy-settings-ui/`. Nothing schedules this script or includes it
in the installed app. Run `node ui/memory/settings.test.mjs` for the fast
readiness checks without a browser.

Settings-window flows against a real S3 gateway run in `tests/sync_s3.rs`
(`settings_window_sets_up_syncs_restores_and_forgets_like_the_cli`).

## Sync engine and format checks (local, no cloud)

`tests/sync_s3.rs` drives the real sync engine against versitygw (an S3 gateway
that verifies SigV4 and checksums) started per test on a free port:

```bash
KORTIX_CAPTURE_TEST_VERSITYGW=/path/to/versitygw cargo test --features capture-engine --test sync_s3
```

It covers checksums, multipart resume after a gateway kill, wrong credentials,
clock skew, restore equality (screen, audio and action segments with shared
screenshots), encryption, forget and retention, device.json/status.json and the
operator's policy, diagnostics to the bucket, and a mock credential issuer
(`issuer_device_grant_credentials_refresh_and_revocation`: RFC 8628 sign-in,
credential refresh 5 minutes before expiry, a 401 stops sync without further
requests, sign-in again resumes). Without the variable every test passes
without doing anything and says so.

`tests/enrollment.rs` runs the enrollment client against a mock issuer on any
OS (no gateway needed): `enrolled` stores the device like a sign-in, `pending`
and refusals store nothing, the retry cadence matches the contract, and `sync
adopt` validates what the machine service hands over:

```bash
cargo test --test enrollment
```

### Windows organization rollout (MSI)

Build the MSI from staged release binaries (WiX v5; installs the `wix` dotnet
tool on first use):

```powershell
cargo build --release --features native-recorders --bin kortix-capture --bin kortix-capture-engine --bin kortix-backend
python scripts/install_privacy_runtime.py --platform windows-x86_64 --destination target/release
./installer/windows/build-msi.ps1 -Stage target/release -Version v0.0.1 -Out dist/KortixCapture.msi
msiexec /i dist\KortixCapture.msi /qn /l*v install.log KORTIX_URL=https://api.kortix.com ENROLLMENT_TOKEN=kortix_enr_...
"C:\Program Files\Kortix\Capture\kortix-capture.exe" machine status
```

The `windows-msi` job of `capture-build.yml` runs the whole rollout on a
GitHub Windows runner: `gh workflow run capture-build.yml --ref <branch> -f
only=windows-msi`. It starts MinIO and `scripts/ci_fake_issuer.py` (the
enrollment and credential contract; the first enrollment answers `pending`),
installs silently, and asserts the service account, the policy key's ACL (a
standard user's `reg query` is denied), that the token never reaches the MSI
log, the signed-in person's enrollment from their session token, frames in
their library, the tray, uploads under the device folder, a restart within 30 s
after a kill, an in-place upgrade that keeps the configuration, that stopping
the service leaves no recorder, and a clean uninstall. With `-f
issuer_url=<https URL> -f enrollment_token=<token>` it enrolls against a real
Kortix API instead (a short-lived, one-device token; for example a tunnel to a
local stack).

### macOS organization rollout (pkg)

Build, sign and package on a Mac (arm64 and x86_64, joined with `lipo`; `ARCHS=arm64`
builds Apple silicon only). `APPLE_CODESIGN_IDENTITY=-` signs ad hoc; a Developer ID
identity signs with the hardened runtime, and `MACOS_NOTARIZE=1` (with
`APPLE_NOTARY_KEY_P8_BASE64`, `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`)
notarizes and staples the app. The `.pkg` is signed when a Developer ID Installer
identity is in the keychain (`APPLE_INSTALLER_IDENTITY`):

```bash
APPLE_CODESIGN_IDENTITY=- installer/macos/build-pkg.sh v0.0.1 dist/KortixCapture-v0.0.1-universal.pkg
```

Do not install the pkg on a development Mac: it registers a LaunchDaemon and an agent
and asks for Screen Recording. The `macos-pkg` job of `capture-build.yml` does it on
a GitHub macOS runner: `gh workflow run capture-build.yml --ref <branch> -f
only=macos-pkg`. It starts versitygw and `scripts/ci_fake_issuer.py`, writes a root-only
`config.json`, runs `sudo installer -pkg`, and asserts the app's architectures and
Info.plist, the running LaunchDaemon and agent, the console user's enrollment (pending,
then enrolled; the token redacted in the stand-in's log, unreadable to the person, absent
from their library), that an MDM profile's managed preferences win over `config.json`,
`start`/`stop` reporting `managed`, the agent heartbeat and tray, the logon notice in the
tray log, frames and uploads (the runner has SIP off, so the job writes the app's Screen
Recording, Accessibility and Input Monitoring grants into the system TCC database;
if a grant is refused the job asserts the exact blocker instead), a restart after a kill, a reinstall that keeps the
configuration, and a clean uninstall (`Contents/Resources/uninstall.sh`). With `-f
macos_sign=true` the `macos-pkg-signed` job builds with the Developer ID secrets,
notarizes, and asks Gatekeeper (`spctl`, `stapler validate`).

### Linux organization rollout (deb)

```bash
cargo build --release --features native-recorders,memory-ui,tray-linux --bin kortix-capture --bin kortix-capture-engine --bin kortix-backend
python3 scripts/install_privacy_runtime.py --platform linux-x86_64 --destination target/release
installer/linux/build-deb.sh v0.0.1 target/release dist/kortix-capture_v0.0.1_amd64.deb
```

Build libraries: `libgtk-3-dev libayatana-appindicator3-dev libwebkit2gtk-4.1-dev
libsoup-3.0-dev libxi-dev libxtst-dev libx11-dev libxrandr-dev libxcb1-dev libxdo-dev libxss-dev`.
Install it on a Linux VM (not on a development laptop: the package starts a root
service) with `sudo apt install ./kortix-capture_v0.0.1_amd64.deb`. The `linux-deb`
job of `capture-build.yml` (`-f only=linux-deb`) runs the rollout on a GitHub Ubuntu
runner whose desktop is a real logind session: a system unit with `PAMName=login` runs
Xvfb, openbox, dunst and a clock as the runner user. It asserts the session is
`Type=x11`, the machine service and the globally enabled user unit, the enrollment
(pending, then enrolled), `config.json` unreadable to other users, frames, the upload
under the device folder, the logon notice as a `Notify` call on the session bus, a
restart after a kill, a reinstall, and that `apt purge` removes the binaries, units,
configuration, machine state and processes while the person's library stays.

The format's JSON Schemas (`schemas/`) and the fixture bucket
(`fixtures/capture-format-v2/`) are checked by `cargo test --test
capture_format`. After a format change, regenerate the fixtures through the real
upload code and commit them with the spec:

```bash
KORTIX_CAPTURE_WRITE_FIXTURES=1 cargo test --test capture_format the_engine_writes_what_the_schemas_describe
cargo test --test capture_format
```

Run the deterministic local macOS trace verifier on a permissioned Mac:

```bash
scripts/macos_trace_simulation_verify.sh
MACOS_TRACE_A11Y_ENABLED=1 scripts/macos_trace_simulation_verify.sh
```

The default run verifies screenshots, keyboard, mouse, drag, scroll, processed
actions, and that A11y stays off by default. The `MACOS_TRACE_A11Y_ENABLED=1`
run writes a temporary config with `a11y_recorder.enabled: true` and requires a
nonempty A11y `windows_data` snapshot. Both runs require Screen Recording,
Accessibility, and Input Monitoring permissions for the launching terminal or
backend binary.

## Processor Tools

Processor behaviour is specified by the Rust rule tests in `tests/processor_rules.rs`
and the fixtures in `fixtures/processor/` (`cargo test`). The live comparison against the
legacy Python processor was retired on 2026-10-02 together with the archived Python code.

Check bounded resource use and training-data-ready sequencing:

```bash
python3 scripts/stress_processor_resources.py --events 75000
python3 scripts/stress_processor_resources.py --events 75000 --iterations 5 --skip-build
python3 scripts/stress_processor_resources.py --events 75000 --summary-json artifacts/resource-soak/stress-summary.json
```

Run a repeated processor/writer soak with aggregate CPU/RSS reporting:

```bash
scripts/soak_processor_resources.sh
SOAK_EVENTS=100000 SOAK_ITERATIONS=100 scripts/soak_processor_resources.sh
```

The soak wrapper builds `kortix-process-raw` once, then runs the stress harness
with `--skip-build` and writes a JSON summary. Defaults are 100k events, 20
iterations, max RSS 180 MiB, max RSS growth 24 MiB, and minimum 5k events per
CPU-second.

Latest local soak result on 2026-05-01:

- command: `SOAK_EVENTS=100000 SOAK_ITERATIONS=100 scripts/soak_processor_resources.sh`
- synthetic raw events processed: 10,000,000 total
- max per-iteration RSS: 4.55 MiB
- max estimated per-iteration RSS growth: 0.37 MiB
- slowest iteration throughput: 238,095 events per CPU-second
- summary: `artifacts/resource-soak/processor-soak-summary.json`

This is a batch post-processing and streaming-writer proxy for bounded resource
state. It is not a full 24/7 native recorder daemon soak with OS permissions.

Process an existing raw JSONL recording with Rust:

```bash
cargo run --bin kortix-process-raw -- --file path/to/recording_raw.jsonl --output path/to/preprocessed.jsonl
```

Process raw JSONL and generate the Rust local HTML viewer in one pass:

```bash
cargo run --bin kortix-process-raw --features native-recorders -- \
  --file path/to/recording_raw.jsonl \
  --output path/to/preprocessed.jsonl \
  --html-output path/to/recording_visualization.html
```

Render the Rust local HTML viewer from an existing processed JSONL:

```bash
cargo run --bin kortix-process-raw --features native-recorders -- \
  --preprocessed \
  --file path/to/preprocessed.jsonl \
  --html-output path/to/recording_visualization.html
```

Render a single processed trace for visual screenshot/action review:

```bash
python3 scripts/render_processed_trace_review_sheet.py path/to/preprocessed.jsonl
```

Generate a standalone HTML viewer for a processed trace:

```bash
python3 scripts/render_processed_trace_html.py path/to/preprocessed.jsonl
```

Pass the raw JSONL too when it is available so the viewer can show recorder
cadence and missing raw frames:

```bash
python3 scripts/render_processed_trace_html.py path/to/preprocessed.jsonl --raw-jsonl path/to/recording_raw.jsonl
```

## Manual Recorder Contracts

These are one-at-a-time local recorder checks derived from the archived Python
processor scenarios. They are intended for manual macOS capture feedback, not
CI. Numbered scripts and recording directories keep the current contract order
explicit:

- `1_basic`: confirmed keyboard, hotkey, scroll, screenshot sync, and display
  mapping run based mainly on legacy `test_1_typewrite_hotkey_recording.py`.
- `2_mouse_clicks`: confirmed right/middle/double/triple/quadruple click run
  based on legacy `test_2_mouse_clicks_recording.py`.
- `3_modifiers`: frozen multi-monitor modifier/click/drag/backspace run based
  on legacy `test_3_modifiers_click_recording.py` and
  `test_4_modifiers_drag_recording.py`.
- `4_special_keys`: frozen first function/media-key slice based on legacy
  `test_5_function_keys_recording.py`, covering Esc, backtick, Tab, Caps Lock
  press capture, and F1/Fn+F1 plus F2/Fn+F2 inversion.
- `5_other_keys`: freeform named recording bucket for the remaining
  function/navigation/media keys before freezing the next contract.

Legacy `test_0_basic_recording.py` and `test_7_sleep_screenshots_ts_recording.py`
already have Rust processor coverage, so these manual recorder scripts do not
repeat them as standalone recorder runs yet.

`1_basic` actions:

1. Start a recording with raw data enabled.
2. Leave the visible app idle briefly.
3. Type `h`, then press Backspace.
4. Perform one left click in the app.
5. Type `hello worl`, then press Backspace twice.
6. Press Ctrl+Space, then Backspace.
7. Type `world`, Space, Shift+1, Space. This should process as separate
   `typewrite "world "` and `typewrite "! "` actions.
8. Press Command+Tab, Alt+2, Alt+1.
9. Scroll down once, then scroll down again farther.
10. Press Alt+4, perform one left click, then return to the terminal.
11. Press Enter or Return in the terminal to stop the recording.

The easiest local macOS path is the wrapper below. It starts a local backend,
starts the recording, waits for you to press Enter in the terminal, stops the
recording, runs the ignored Rust contract, renders the standalone HTML viewer,
and opens it. The contract validates the confirmed action sequence, exact
processed timestamps, and screenshot/action/screenshot neighbors for the raw
trace. The wrapper builds a release backend by default so screenshot cadence
matches the shipped app rather than debug-build JPEG performance:

```bash
scripts/run_manual_1_basic_recording_contract.sh
```

To validate the saved local raw trace as-is, without starting a new recording:

```bash
MANUAL_BASIC_VALIDATE_EXISTING=1 scripts/run_manual_1_basic_recording_contract.sh
```

By default this overwrites the same local `1_basic` dataset each time, so
there is one active capture for the basic test. The wrapper removes the previous
local `1_basic` recording directory before starting. To preserve a specific
run, set `MANUAL_BASIC_RECORDING_NAME`:

```bash
MANUAL_BASIC_RECORDING_NAME=1_basic_$(date +%Y%m%d_%H%M%S) \
scripts/run_manual_1_basic_recording_contract.sh
```

Force a debug build only when debugging the backend itself:

```bash
MANUAL_BASIC_BUILD_PROFILE=debug scripts/run_manual_1_basic_recording_contract.sh
```

The raw recordings, generated preprocessed JSONL, logs, and HTML viewers are
written under ignored local storage:

```text
tests/manual_recording_contracts/raw_data/
```

For a review-only run that uses the same recorder setup but does not write into
the manual contract test folder, run:

```bash
scripts/run_recording_review.sh review
```

This writes ignored local artifacts under `artifacts/recording-review/`,
processes the raw JSONL, renders the HTML viewer, and opens it automatically
when you press Enter to stop recording.

Validate the captured raw JSONL with the ignored Rust contract:

```bash
MANUAL_BASIC_RAW_JSONL=path/to/recording_raw.jsonl \
cargo test --test manual_recording_contracts manual_1_basic_recording_capture_matches_contract -- --ignored --nocapture
```

The test writes `*_preprocessed.jsonl` beside the raw file unless
`MANUAL_BASIC_PREPROCESSED_JSONL` is set. Render that file as HTML to inspect
event order and screenshot/action/screenshot synchronization:

```bash
python3 scripts/render_processed_trace_html.py path/to/recording_preprocessed.jsonl --raw-jsonl path/to/recording_raw.jsonl
```

`2_mouse_clicks` validates native button capture and click grouping for one
right click, one middle click, a double left click, a triple left click, and a
quadruple left click:

```bash
scripts/run_manual_2_mouse_clicks_recording_contract.sh
```

Keep the pointer stable during each repeated click group, and pause about one
second between the double, triple, and quadruple groups so the processor flushes
them separately. This wrapper overwrites the stable local
`2_mouse_clicks` dataset each time and opens the generated HTML viewer at
the end. To validate the saved local raw trace as-is:

```bash
MANUAL_MOUSE_CLICKS_VALIDATE_EXISTING=1 scripts/run_manual_2_mouse_clicks_recording_contract.sh
```

`3_modifiers` is now a frozen local raw-trace regression. It checks
multi-monitor click/drag sync, Ctrl/Command/Shift modified mouse actions,
delayed page-transition screenshots, a double-click, long key input, and a
held Backspace auto-repeat rendered as `press backspace x10`:

```bash
scripts/run_manual_3_modifiers_recording_contract.sh
```

The preferred regression path is validating the saved local raw trace as-is:

```bash
MANUAL_MODIFIERS_VALIDATE_EXISTING=1 scripts/run_manual_3_modifiers_recording_contract.sh
```

The contract asserts exact raw event counts, exact processed actions, exact
timestamps, and exact screenshot positions. Capturing a new trace with
`scripts/run_manual_3_modifiers_recording_contract.sh` is useful for
exploration, but it overwrites the stable local `3_modifiers` dataset and will
only pass after the exact Rust contract is intentionally updated.

For multi-monitor captures, the HTML viewer selects the action/current display
from screenshot metadata. New captures include display bounds so action markers
can be remapped from virtual desktop coordinates onto the selected display.
The sync diagnostics section shows processed action timestamps, raw screenshot
cadence, and warnings when no raw screenshot exists between adjacent actions.
The wrapper renders and opens the HTML even when the contract assertion fails,
so failed manual runs can still be inspected visually.

`4_special_keys` is now a frozen local raw-trace regression for the confirmed
first special-key slice. It validates the exact processed actions and
screenshot/action/screenshot alignment for setup clicks/shortcuts, Esc,
backtick, Tab, Caps Lock presses, F1/Fn+F1 as brightness_down/f1 on this Mac,
and F2/Fn+F2 as brightness_up/f2:

```bash
scripts/run_manual_4_special_keys_recording_contract.sh
```

The preferred regression path is validating the saved local raw trace as-is:

```bash
MANUAL_SPECIAL_KEYS_VALIDATE_EXISTING=1 scripts/run_manual_4_special_keys_recording_contract.sh
```

Capturing a new trace with `scripts/run_manual_4_special_keys_recording_contract.sh`
is useful for exploration, but it overwrites the stable local `4_special_keys`
dataset and will only pass after the exact Rust contract is intentionally
updated.

`5_other_keys` is the freeform bucket for the remaining macOS keys from the
legacy function-key coverage. No scenario is enforced by the script; perform the
keys/actions you want to inspect, then press Enter in the terminal to stop,
process, render, and open the HTML:

```bash
scripts/run_manual_5_other_keys_recording.sh
```

The same script can record any numbered name:

```bash
scripts/run_manual_named_recording.sh 5_other_keys
```

Remaining `5_other_keys` coverage targets and meanings:

- `Caps Lock`: toggles uppercase lock. New raw events should include observed
  OS state as `lock_on`/`lock_state`; old raw traces should not guess it.
- `F3` and `Fn+F3`: Mission Control versus standard F3 on this Mac.
- `F4` and `Fn+F4`: Spotlight/Search versus standard F4 on this Mac.
- `F5` and `Fn+F5`: Dictation/voice command versus standard F5 on this Mac.
- `F6` and `Fn+F6`: Do Not Disturb/Focus versus standard F6 on this Mac.
- `Fn` or `Globe/Fn`: the physical function-key modifier path.
- `F8` and `Fn+F8`: standard F8 versus media Play/Pause, depending on macOS
  keyboard settings.
- `Home` or `Fn+Left`: jump to the start/top of text or a scrollable page.
- `End` or `Fn+Right`: jump to the end/bottom of text or a scrollable page.
- `Page Up` or `Fn+Up`: scroll or move up by roughly one page.
- `Page Down` or `Fn+Down`: scroll or move down by roughly one page.
- `Forward Delete` or `Fn+Delete`: delete the character to the right of the
  cursor.
- `Insert/Help` or `Fn+Return`: Insert/Help key path; many Mac apps show no
  visible effect.
- `Shift+Command+3`: macOS full-screen screenshot shortcut, equivalent to Print
  Screen.
- `Volume Mute`: toggle system audio mute.
- `Volume Down`: lower system output volume.
- `Volume Up`: raise system output volume.

Measure real-machine screenshot cadence without doing the full action scenario:

```bash
scripts/run_manual_screenshot_fps_probe.sh --seconds 30
```

The FPS probe overwrites the stable local `manual_fps_probe` dataset, keeps the
target screenshot rate constant for the whole run, prints raw/processed
screenshot FPS plus capture, queue, and encode timings, renders the same HTML
viewer, and opens it. It also uses a release backend by default. Override the
target rate for stress checks with:

```bash
MANUAL_FPS_TARGET_FPS=12 scripts/run_manual_screenshot_fps_probe.sh --seconds 30
```

## Windows Binary Build

Build Windows GNU binaries locally:

```bash
scripts/build_windows_gnu.sh
```

If MinGW is missing on Ubuntu/Debian:

```bash
sudo apt-get update && sudo apt-get install -y mingw-w64
```

The binaries land in `target/x86_64-pc-windows-gnu/release`.
The build includes the optional visible tray controller, `kortix-tray.exe`.
When the tray starts, it starts the embedded local backend if needed, starts recording
once if idle, and registers itself in the current user's login startup. Set
`KORTIX_TRAY_AUTO_START_RECORDING=0` or `KORTIX_TRAY_AUTO_LAUNCH=0` to suppress
those defaults. The Windows tray release package is one file:
`kortix-tray.exe` hosts the local backend API internally.
The release manifest lists the raw Windows executable, never the install
package ZIP. The updater rejects ZIP bytes before staging or probing because
Windows reports those mis-staged files as unsupported 16-bit applications.

## macOS Binary Build

Build native macOS binaries on a macOS host or GitHub Actions `macos-latest`:

```bash
scripts/build_macos.sh
```

For release packaging, compile with the same release tag you package so the
app reports the correct version (manifests, device.json, update checks):

```bash
KORTIX_RELEASE_TAG=v0.12.0 scripts/build_macos.sh
```

Optional target override:

```bash
MACOS_RUST_TARGET=aarch64-apple-darwin scripts/build_macos.sh
MACOS_RUST_TARGET=x86_64-apple-darwin scripts/build_macos.sh
```

Real capture on macOS needs user-granted Screen Recording, Accessibility, and
Input Monitoring permissions. The build script only builds; it does not grant
OS permissions, sign, or notarize.
The build includes the optional visible menu-bar controller, `kortix-tray`.
When the tray starts, it starts the local backend if needed, starts recording
once if idle, and installs a per-user LaunchAgent for login startup. Set
`KORTIX_TRAY_AUTO_START_RECORDING=0` or `KORTIX_TRAY_AUTO_LAUNCH=0` to suppress
those defaults. The macOS tray app hosts the local backend API internally, so
the app bundle does not need a separate backend helper. The signed macOS `.app`
does not apply binary-only tray updates in place; replacing
`Contents/MacOS/kortix-tray` breaks the app signature and invalidates macOS TCC
permissions. Ship a full `.app` package update instead.

For quick local testing without app-bundle permission churn, run the unbundled
tray from Terminal:

```bash
scripts/run_macos_tray_dev.sh
```

Grant Screen Recording, Accessibility, and Input Monitoring to the launching
terminal app once. The runner disables tray auto-update and login auto-launch by
default, but still auto-starts recording unless overridden.

Package, Developer ID sign, and optionally notarize the built macOS artifacts:

```bash
APPLE_CODESIGN_IDENTITY="Developer ID Application: Your Company (TEAMID)" \
MACOS_NOTARIZE=1 \
APPLE_NOTARY_KEY_PATH="$HOME/private/AuthKey_XXXXXXXXXX.p8" \
APPLE_NOTARY_KEY_ID="XXXXXXXXXX" \
APPLE_NOTARY_ISSUER_ID="00000000-0000-0000-0000-000000000000" \
scripts/package_macos_release.sh v0.11.0-test.1
```

For local notarization, `APPLE_NOTARY_PROFILE` from
`xcrun notarytool store-credentials` may be used instead of the key path/key
ID/issuer values. Set `MACOS_NOTARIZE=0` to create signed-only local packages.

GitHub Actions macOS release packaging uses these repository or organization
secrets:

```text
APPLE_DEVELOPER_ID_P12_BASE64
APPLE_DEVELOPER_ID_P12_PASSWORD
APPLE_KEYCHAIN_PASSWORD
APPLE_CODESIGN_IDENTITY
APPLE_NOTARY_KEY_P8_BASE64
APPLE_NOTARY_KEY_ID
APPLE_NOTARY_ISSUER_ID
```

The workflow imports the `.p12` into a temporary keychain, signs the macOS
binaries with hardened runtime, notarizes `Kortix Capture.app`, staples the ticket,
and publishes the resulting zip. The app bundle contains a single tray binary
that hosts the local backend API internally. The optional updater `.sig` sidecar
still uses `KORTIX_RELEASE_SIGNING_PRIVATE_KEY_PEM` from the release-signing flow
above. Do not commit certificate, key, or password material.

Run a local macOS capture smoke test after granting permissions:

```bash
scripts/macos_local_recording_smoke.sh
```

The smoke test builds or uses `KORTIX_BACKEND_BIN`, starts the local HTTP
backend, records a short TextEdit flow with raw data enabled, and fails unless
raw native input, processed actions, screenshots, and nonempty
`a11y+screenshot` `windows_data` are all present. It points debug upload at
localhost so the test recording is not uploaded.

## Linux Binary Build

Build native Linux binaries:

```bash
scripts/build_linux.sh
```

Ubuntu/Debian prerequisites:

```bash
sudo apt-get update && sudo apt-get install -y build-essential pkg-config libxi-dev libxtst-dev libx11-dev libxrandr-dev libxcb1-dev libxdo-dev libgtk-3-dev libayatana-appindicator3-dev
```

The build includes the optional visible tray controller, `kortix-tray`. When
the tray starts, it starts the local backend if needed, starts recording once if
idle, and writes an XDG autostart desktop entry for login startup. Set
`KORTIX_TRAY_AUTO_START_RECORDING=0` or `KORTIX_TRAY_AUTO_LAUNCH=0` to suppress
those defaults. The Linux tray release package is one binary:
`kortix-tray` hosts the local backend API internally when no backend is already
running.

Linux builds the .deb; see "Linux organization rollout (deb)".

## Archives

The old Python/Electron implementation and the legacy Python backend were removed from
the repo on 2026-10-02 after the Rust port reached parity (30 of 30 Windows trace
comparisons passed). They remain in git history before that date; do not add legacy
runtime scripts back under `scripts/`.

