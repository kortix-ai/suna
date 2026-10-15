# Kortix Capture

Kortix Capture records a computer's screen, actions and, when allowed, audio,
around the clock. It runs in the background on Windows, macOS and Linux, keeps
a searchable timeline on the computer, and syncs it to Kortix, to your own S3
bucket, or nowhere.

It ships with every Kortix release under the same version. The Kortix side
(devices, enrollment, the policy, ingest, fleet health) lives in
`apps/api/src/capture` and `apps/web/src/features/capture`, and organizations
manage it under `/capture` in Kortix.

## How it behaves

- **Always on.** A machine service (root on macOS and Linux, SYSTEM on
  Windows) and a per-user agent run the recorder. Closing the window never
  stops recording. The agent restarts itself. There is no Quit; a person can
  only pause (1 hour, until tomorrow, until resumed).
- **Quiet.** No Dock icon, no taskbar button. The menu-bar / tray icon is the
  recording indicator and opens the window and Settings.
- **Personal install.** Recording starts at install. The first window asks
  the person to sign in with Kortix; signing in turns sync on. Two quiet
  exits: your own S3 bucket, or keep recordings on the computer.
- **Company install.** With an enrollment token the install is silent and
  preconfigured: it records and syncs from the first minute, with no window.
- **Privacy.** Password managers and private browsing windows are skipped by
  default. The other exclusion lists and on-computer personal-data masking
  are behind the experimental "Privacy controls" switch (the organization's
  policy in Kortix, or Advanced → Experimental on a computer without one).

## Install

Downloads: `https://<your Kortix>/download/capture/windows|macos|linux`
(the latest release's `.msi`, `.pkg` and `.deb`).

Company install with an enrollment token (create one in Kortix: `/capture` →
Devices → Company install):

```bash
# Windows (as administrator, or through Intune / Group Policy)
msiexec /i KortixCapture-x64.msi /qn KORTIX_URL=https://api.example.com ENROLLMENT_TOKEN=kortix_enr_...

# macOS (or deploy the .pkg with your MDM and the token in a profile)
echo '{"url":"https://api.example.com","enrollment_token":"kortix_enr_..."}' \
  | sudo tee "/Library/Application Support/Kortix/Capture/config.json" >/dev/null
sudo installer -pkg KortixCapture-universal.pkg -target /

# Linux (X11 desktops)
echo '{"url":"https://api.example.com","enrollment_token":"kortix_enr_..."}' | sudo tee /etc/kortix/capture.json >/dev/null
sudo apt-get install ./kortix-capture_amd64.deb
```

The IT guide is the Kortix docs page `/docs/capture/rollout`. Uninstall:
`msiexec /x KortixCapture-x64.msi /qn`, `sudo "/Applications/Kortix Capture.app/Contents/Resources/uninstall.sh"`,
`sudo apt purge kortix-capture`. Recordings stay on the computer until retention removes them.

## Sync

Sync writes the Kortix Capture bucket format (schema 2) to an S3-compatible
store; it is the app's only contract with any cloud
(`.agents/skills/kortix-capture/references/capture-format.md`, JSON Schemas in
`schemas/`, a fixture bucket in `fixtures/capture-format-v2/`).

- **Kortix:** sign in (RFC 8628 device grant) or enroll; Kortix issues
  short-lived credentials scoped to the device's own folder. On a self-hosted
  Kortix the bundled store makes this work out of the box
  (`.agents/skills/kortix-capture/references/self-host.md`).
- **Your S3 bucket:** endpoint, bucket, region and keys in Settings, or
  `kortix-capture sync setup --endpoint … --bucket …` with
  `KORTIX_CAPTURE_S3_ACCESS_KEY_ID` / `KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY`.
- **Off:** everything stays on the computer.

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

## Develop

Never install or launch the app on a development Mac: the installers register
root services and ask for Screen Recording. CI installs it on real runners.
Run recorder commands with a scratch `KORTIX_CAPTURE_DIR`.

```bash
# Build
cargo build --release --features native-recorders \
  --bin kortix-capture --bin kortix-backend --bin kortix-capture-engine

# Test
cargo test --features capture-engine
KORTIX_CAPTURE_TEST_VERSITYGW=/path/to/versitygw cargo test --features capture-engine --test sync_s3
pnpm --filter @kortix/capture test     # the window's UI tests (node --test)
```

Linux build prerequisites:

```bash
sudo apt-get install -y libxi-dev libxtst-dev libx11-dev libxrandr-dev libxcb1-dev libxdo-dev libgtk-3-dev libayatana-appindicator3-dev
```

`tests/sync_s3.rs` runs sync against a real S3 gateway with a stand-in issuer;
`tests/capture_format.rs` checks the schemas against the fixture bucket. Every
repeatable script is listed in `scripts/README.md`.

## Release

`.github/workflows/capture-build.yml` builds, signs and verifies every
installer on its own OS runner: silent install, onboarding, enrollment,
uploads, the background-always checks, upgrade in place and a clean
uninstall. `capture.yml` (manual dispatch) runs it for a branch and publishes
the `capture-dev-latest` prerelease from `dev`; `deploy-prod.yml` attaches the
installers and `capture-update.json` to every `vX.Y.Z` release. The runbook,
with the secrets and human steps, is
`.agents/skills/kortix-capture/references/release-runbook.md`.

## License

Elastic License 2.0, like the rest of this repository (root `LICENSE`).
Third-party notices: `THIRD_PARTY_NOTICES`.
