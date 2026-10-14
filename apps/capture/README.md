# Kortix Capture (Rust)

The desktop app: screen memory, the action recorder, the tray, and sync. Product
behaviour is in `.agents/skills/kortix-capture/references/app-behavior.md`; the bucket format, the app's only
contract with any cloud, is in `.agents/skills/kortix-capture/references/capture-format.md` (JSON Schemas in
`schemas/`, a fixture bucket in `fixtures/capture-format-v2/`).

## Run the tray (macOS)

```bash
scripts/run_macos_tray_dev.sh            # build, then run the tray
scripts/run_macos_tray_dev.sh --no-build # rerun
```

The tray runs screen memory (`kortix-capture record`, supervised) and the action
recorder (its local API, in-process). If macOS blocks capture, grant your
terminal Accessibility, Input Monitoring and Screen Recording.

## Sync

Nothing leaves the computer until sync is on. Two ways, same S3 format:

```bash
# Your own S3-compatible bucket (static credentials):
KORTIX_CAPTURE_S3_ACCESS_KEY_ID=... KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY=... \
  kortix-capture sync setup --endpoint https://s3.us-east-1.amazonaws.com --bucket my-bucket

# Sign in with Kortix (RFC 8628 device grant; short-lived credentials):
kortix-capture sync setup --provider kortix --issuer https://kortix.example.com
```

The tray ("Sign in with Kortix...") and the settings window ("Sync to") do the
same. Screen chunks, audio and action segments upload with checksums, resumable
multipart and optional client-side encryption; `kortix-capture sync restore`
rebuilds a library from the bucket. The operator's `policy.json` in the bucket
narrows what records.

## Local API and headless service

```bash
cargo run --bin kortix-backend                     # local API on 127.0.0.1:16193
cargo run --bin kortix-backend -- --service        # headless: segments + sync
cargo run --bin kortix-backend -- send-diagnostics # bundle to the bucket, or <library>/diagnostics/
```

`POST /recording/start` with `{"segmented": true}` records 60 s segments; each
finished segment goes into the capture library as an action segment and syncs
from there. `--auto-start-recording` starts one local recording at launch.

`kortix-capture start` installs the 24/7 service.

## Releases

Kortix Capture is versioned with Kortix. `.github/workflows/capture-build.yml`
builds, signs and installs every installer (Windows .msi, macOS .pkg, Linux
.deb) on its own OS runner. `deploy-prod.yml` attaches them to the vX.Y.Z
release and `capture.yml` (dispatch) publishes the `capture-dev-latest`
prerelease. The runbook is `.agents/skills/kortix-capture/references/release-runbook.md`.

## Updates

The machine service updates the app by itself, in the background, from each
Kortix release. It checks at start and every 6 hours (jittered), on the channel
the build came from: `stable` for `X.Y.Z`, `dev` for `X.Y.Z-dev.N`. It installs
only a newer version whose manifest carries a valid Ed25519 signature, and the
installer's size and SHA-256 match the manifest. A new version that does not
report healthy (recorder running, new frame) is rolled back and never tried
again. `kortix-capture --json machine status` shows `version` and `update`; the
same `update` object goes into the device's `status.json`.

IT controls (the same places as the enrollment settings):

| Setting | Windows (policy key, string value) | macOS (`config.json` or profile) | Linux (`/etc/kortix/capture.json`) |
|---|---|---|---|
| Updates off | `AutoUpdate` = `0` | `auto_update`: `false` / `AutoUpdate` | `auto_update`: `false` |
| Pin the channel | `UpdateChannel` = `stable` or `dev` | `update_channel` / `UpdateChannel` | `update_channel` |

The rules, the files and the release steps are in
`.agents/skills/kortix-capture/references/release-runbook.md` (section "Updater").

## Build

```bash
cargo build --release --features native-recorders \
  --bin kortix-capture --bin kortix-backend --bin kortix-capture-engine
```

Linux native prerequisites:

```bash
sudo apt-get install -y libxi-dev libxtst-dev libx11-dev libxrandr-dev libxcb1-dev libxdo-dev libgtk-3-dev libayatana-appindicator3-dev
```

## Test

```bash
cargo fmt --check
cargo check --all-targets --features native-recorders
cargo test --features capture-engine
KORTIX_CAPTURE_TEST_VERSITYGW=/path/to/versitygw cargo test --features capture-engine --test sync_s3
scripts/verify_rust_backend.sh
```

`tests/sync_s3.rs` runs the sync engine against a real S3 gateway (versitygw),
including a mock credential issuer; `tests/capture_format.rs` checks the
schemas against the fixture bucket. The real-OS installer checks run in
`.github/workflows/capture-build.yml`; every repeatable command is in
`scripts/README.md`.
