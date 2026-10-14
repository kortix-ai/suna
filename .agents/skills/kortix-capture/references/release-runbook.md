# Kortix Capture release runbook

Kortix Capture ships with Kortix. Its version is the Kortix release version.

| Channel | Tag baked into the app | Where the assets live |
|---|---|---|
| Release | `vX.Y.Z` (the `VERSION` file at promote time) | the `vX.Y.Z` GitHub release |
| Dev | `vX.Y.Z-dev.<run_number>` | the mutable `capture-dev-latest` prerelease |

## What builds and verifies it

`.github/workflows/capture-build.yml` (reusable, `workflow_call`). Inputs: `tag`,
`channel`, `issuer_url`, `release_tag`. It publishes nothing. Jobs:

1. `test` (Linux, macOS, Windows): UI node tests; `cargo test --release` for the
   library, the engine protocol, enrollment and the format schemas; on Linux
   also the AppIndicator tray and the S3 sync suite against versitygw.
2. `windows-msi`: builds the `.msi`, installs it silently with a made-up
   enrollment token, and asserts: service running as LocalSystem, policy key
   ACL, token absent from the MSI log, enrollment against a local stand-in
   issuer (`scripts/ci_fake_issuer.py`), frames recorded, uploads in the local
   S3 bucket, tray notice, recovery after a kill, in-place upgrade to the next
   patch version, clean uninstall.
3. `macos-pkg`: builds the universal `.pkg` (arm64 + x86_64), signs and
   notarizes the app, then runs the same checks with a LaunchDaemon, a
   LaunchAgent, an MDM-profile override, a reinstall and `uninstall.sh`. When
   the app is notarized, Gatekeeper must accept the installed app and the
   ticket must validate.
4. `linux-deb`: builds the `.deb`, installs it into a real logind X11 session,
   runs the same checks, then `apt purge`.
5. `collect`: names, checksums and the update manifest (below).

Each OS job uploads its evidence as `capture-evidence-<os>` (14 days).

## Triggers

- Dev: `gh workflow run capture.yml --repo kortix-ai/suna --ref dev`. Dispatch
  only: macOS bills at 10x and Windows at 2x. Any other ref builds and
  verifies without publishing. The `dev` ref also publishes `capture-dev-latest`.
- Release: `deploy-prod.yml` runs `build-capture` with `https://api.kortix.com`.
  `attach-capture` runs after the release exists and uploads the installers. A
  Capture failure never blocks a release (best-effort, like `attach-desktop`).
  If it failed, re-run the failed jobs of that run, or download the
  `capture-installers` artifact and `gh release upload vX.Y.Z <files> --clobber`.

## Assets on a release

- `KortixCapture-x64.msi`, `KortixCapture-universal.pkg`,
  `kortix-capture_amd64.deb`: stable names for install commands and docs.
- The same files with the tag in the name (`KortixCapture-vX.Y.Z-x64.msi`, ...).
- `CAPTURE-SHA256SUMS` (the CLI keeps `SHA256SUMS`).
- `capture-update.json` and, when the key exists, `capture-update.json.sig`.

`/download/capture/<windows|macos|linux>` (apps/web) redirects to the stable
asset of the newest published `vX.Y.Z` release that carries Capture installers.
Dev builds are not served there; use the `capture-dev-latest` prerelease.

## Update manifest (for the updater)

`capture-update.json`:

```json
{ "version": "X.Y.Z", "channel": "stable|dev", "released_at": "<ISO time>",
  "assets": { "windows|macos|linux": { "name": "...", "url": "...", "sha256": "...", "size": 0 } } }
```

URLs the app polls:

- stable: `https://github.com/kortix-ai/suna/releases/latest/download/capture-update.json`
- dev: `https://github.com/kortix-ai/suna/releases/download/capture-dev-latest/capture-update.json`

The signature is Ed25519 over the exact bytes of `capture-update.json`, base64,
in `capture-update.json.sig`. `collect` signs when `CAPTURE_UPDATE_SIGNING_KEY`
(a PKCS#8 PEM private key) is in `kortix-ci-env`. Without it the manifest is
published unsigned and the job logs a warning. The app has no self-updater yet
(retired in the old repository); a new installer upgrades in place today.

Create the key once (human step):

```bash
openssl genpkey -algorithm ed25519 -out capture-update.pem
openssl pkey -in capture-update.pem -pubout -outform DER | tail -c 32 | base64   # public key to bake into the app
```

Store the PEM in AWS Secrets Manager `kortix-ci-env` as `CAPTURE_UPDATE_SIGNING_KEY`
(the only reader is `.github/actions/aws-env`). Bake the public key into the
updater build. Never commit either.

## Signing

- macOS: the same Apple secrets as the desktop app, read from `kortix-ci-env`
  through `aws-env`: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`,
  then the notary credentials: `APPLE_API_KEY_P8` + `APPLE_API_KEY` +
  `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
  The app is signed with the Developer ID Application identity in the .p12 and
  notarized. The `.pkg` is signed (`productsign`) and notarized only if the .p12
  also holds a Developer ID Installer identity; otherwise it is unsigned and the
  job log says so. Missing certificate: ad-hoc signed, unsigned pkg, a warning.
- Windows: unsigned. No Windows code-signing certificate exists in `kortix-ci-env`.
- Linux: the .deb is unsigned (no apt repository).

## Human steps

1. Add a Developer ID Installer certificate to the .p12 in `kortix-ci-env`
   (`APPLE_CERTIFICATE`) to sign the `.pkg` itself.
2. Add a Windows code-signing certificate and a signing step to `windows-msi`
   to remove the SmartScreen warning.
3. Create `CAPTURE_UPDATE_SIGNING_KEY` (above).
4. Remove the old `CAPTURE_RELEASES_TOKEN` secret from `kortix-ci-env`; nothing reads it.

## When a verification fails

Download `capture-evidence-<os>` from the run. `Assert` prints the failing line
and the files it read. Reproduce a Rust failure with a scratch library:
`KORTIX_CAPTURE_DIR=$(mktemp -d) cargo test --release --features capture-engine`
in `apps/capture`. Never install the packages on a development machine.

## Known red (not hidden)

- `cargo test --test sync_s3` on Linux has two failures at app commit 828f658e7b:
  `device_status_and_policy_files` (the device policy source path) and
  `settings_window_sets_up_syncs_restores_and_forgets_like_the_cli`
  ("The bucket refused these keys"). The step is `continue-on-error` in
  `capture-build.yml` and prints a warning. Delete `continue-on-error` when the
  app lane fixes them.
- Windows runs the protocol, `managed`, enrollment and format suites, not the
  whole library: `service::tests::the_packaged_app_is_its_own_host_and_shows_the_tray`
  asserts macOS paths.

## Syncing the app from the old repository

`apps/capture` was imported as a file copy (no history) from `kortix-ai/capture`
`apps/recorder` at `origin/capture-standalone`. The only edits the move needed
are path, doc and CI glue. Edits to app code: `Cargo.toml` license, the WiX folder
ACL (`PermissionEx`, fixed component GUIDs), the pkg `postinstall` bootstrap retry,
the settings stamp in `action_exclusions.rs`, and a split test token in `redaction.rs`.
