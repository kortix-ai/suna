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
published unsigned, the job warns, and no installed app updates from it.
`scripts/ci_update_tool.mjs` builds and signs the manifest (CI and the updater test
use the same code). Optional manifest fields: `paused` (bool) and `previous`
(`{version, assets}` of the release before; `collect` adds it on `stable`, from the
newest earlier release whose signature verifies).

## Updater

The machine service (`apps/capture/src/memory/managed/update.rs`) updates the
app. One page for how it works, what IT controls and how to stop a bad release.

Rules, in order:

1. Policy: IT turns updates off (`auto_update`) or pins the channel (`update_channel`).
2. No release version baked in (a local build), or no public key compiled in:
   no update; `update.json` says which.
3. Check at start (60 s to 5 min after, random) and every 6 h, jittered 10 %. A failed
   check retries after 30 min, doubling, up to 6 h.
4. GET the manifest and `.sig` over https (redirects stay on https; manifest at most
   1 MiB). The signature must verify against a compiled-in key.
5. The manifest `channel` must be the channel asked for. `paused: true` stops. The
   version must be semver-newer than the installed one (`X.Y.Z-dev.N` is older than
   `X.Y.Z`): never a downgrade. A version marked bad is skipped.
6. Download this OS's installer to the root-only `updates/staging/`. Size and SHA-256
   must match the manifest. Platform signature: `pkgutil --check-signature` (macOS),
   `Get-AuthenticodeSignature` (Windows). Unsigned is allowed while releases are
   unsigned (the log says so); a signature that is present and wrong is refused.
7. A detached supervisor (`machine update-apply`: systemd transient unit, launchd
   `submit` job, detached process) installs it silently: `msiexec /i … /qn /norestart`
   (the MSI keeps IT's URL and token), `installer -pkg … -target /`, `apt-get install`
   (`dpkg -i` without apt). The installer restarts the service.
8. The new service must prove health: for every signed-in person the recorder runs
   and, while it says "recording", saves a frame newer than the install; two good
   probes in a row, within 15 min. Then the installer is kept in `updates/kept/`.
9. Not healthy, or the installer failed: the installer of the previous version goes
   back (the one it kept, else `previous` from the manifest). A release that ran and
   failed is marked bad (`update.json` `bad`) and never retried. An installer that
   could not run is retried at the next check.

Files in `updates/` (macOS, Linux: `<machine dir>/updates`; Windows:
`%ProgramData%\Kortix\CaptureUpdate`, outside the MSI's folder): `update.json`
(state, readable by everyone, no secrets), `update.log`, `job.json`, `result.json`,
`verified.json`, `staging/`, `kept/`.

The device reports `update` in `status.json`: `{status, installed, channel, latest,
lastCheckMs, lastResult, badVersions}`. `status` is `current`, `behind`, `updating`,
`failed` or `disabled`. Kortix shows "behind" and "update failed" from it.

IT controls:

| Setting | Windows (policy key, string) | macOS (`config.json`, or profile key) | Linux (`/etc/kortix/capture.json`) |
|---|---|---|---|
| Updates off | `AutoUpdate` = `0` | `auto_update`: `false` (`AutoUpdate`) | `auto_update`: `false` |
| Channel | `UpdateChannel` = `stable`/`dev` | `update_channel` (`UpdateChannel`) | `update_channel` |

Stop a bad release: publish a new `capture-update.json` for the same version with
`"paused": true`, signed (re-run `collect` logic: `ci_update_tool.mjs manifest … --paused`
then `sign`), and replace the two assets on the release. Devices that have not
installed it stop; devices that have keep it (publish a fixed higher version).
After a rollback on a device, `kortix-capture machine update-reset` (root) clears the
bad list so the next check tries the newest release again.

Key (human step, once):

```bash
apps/capture/scripts/create_update_key.sh
```

It stores the private key in `kortix-ci-env` as `CAPTURE_UPDATE_SIGNING_KEY` and writes
the public key to `apps/capture/update-public-key.txt`. Commit that file: every build
compiles it in (`KORTIX_CAPTURE_UPDATE_PUBLIC_KEY`). Only builds made after that commit
can verify; devices installed before it never update, so install a build that has it first.

Rotation: `create_update_key.sh --rotate` stores the new key as
`CAPTURE_UPDATE_SIGNING_KEY_NEXT` and makes the public key file `old,new`. Releases keep
signing with the old key. When every device runs a build that trusts both, run
`create_update_key.sh --promote`: releases sign with the new key and the file keeps only it.

CI (`capture-build.yml`, per OS, `scripts/ci_update_test.py`): builds test versions N
and N+1 (`X.Y.Z-dev.7000001`/`2`) with a throwaway key pair, a local manifest server
and a 15 s check interval (compile-time `KORTIX_CAPTURE_UPDATE_TEST_*`, never set for
a release; each release build is checked not to contain the test URL). It installs N and
asserts: up to date; tampered signature, older version, corrupted download and a paused
release install nothing; an N+1 that never reports healthy is rolled back to N, marked
bad and not retried; after `update-reset` N+1 installs, the service restarts, recording
continues, `status.json` in the bucket reports N+1; a manifest naming N does not
downgrade N+1.

## Signing

- macOS: the same Apple secrets as the desktop app, read from `kortix-ci-env`
  through `aws-env`: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`,
  then the notary credentials: `APPLE_API_KEY_P8` + `APPLE_API_KEY` +
  `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
  The app is signed with the Developer ID Application identity in the .p12 and
  notarized. The `.pkg` is signed (`productsign`), notarized and stapled with the
  Developer ID Installer identity in `APPLE_INSTALLER_CERTIFICATE` (base64 .p12) +
  `APPLE_INSTALLER_CERTIFICATE_PASSWORD`. It is a separate secret, so the desktop
  app's `APPLE_CERTIFICATE` stays unchanged. The `Gatekeeper accepts the installed app`
  step asserts `spctl --assess --type install` says `source=Notarized Developer ID`
  for the pkg, and `stapler validate` passes.
- An unsigned pkg is refused by macOS on download: "Apple could not verify
  KortixCapture-universal.pkg is free of malware". So a `stable` build fails when the
  Apple certificate, the notary credentials or the Installer identity is missing. A
  `dev` build warns and publishes an unsigned pkg.
- Create the Installer certificate (Account Holder only, developer.apple.com →
  Certificates → + → Developer ID Installer, upload a CSR). Bundle the issued `.cer`
  with its private key: `openssl pkcs12 -export -legacy -inkey installer.key -in
  installer.pem -out installer.p12`, then store the base64 of the .p12 and its
  password in `kortix-ci-env`.
- Windows: unsigned. No Windows code-signing certificate exists in `kortix-ci-env`.
- Linux: the .deb is unsigned (no apt repository).

## Human steps

1. Create the Developer ID Installer certificate and store it as
   `APPLE_INSTALLER_CERTIFICATE` + `APPLE_INSTALLER_CERTIFICATE_PASSWORD` (section
   "Signing"). Until then no stable release can attach Capture installers.
2. Add a Windows code-signing certificate and a signing step to `windows-msi`
   to remove the SmartScreen warning.
3. Create the update signing key: `apps/capture/scripts/create_update_key.sh`, then commit
   `apps/capture/update-public-key.txt` (section "Updater").
4. Remove the old `CAPTURE_RELEASES_TOKEN` secret from `kortix-ci-env`; nothing reads it.

## Sign-in against the real Kortix

The CI stand-in issuer is local, so each OS job also starts a sign-in at
`https://dev-api.kortix.com` with the installed binary ("Sign-in reaches the real Kortix
through Cloudflare"). Cloudflare there refuses a request without a User-Agent (403); the
check needs no secret and approves nothing.

The full flow, by hand, with any build: `python3 -I apps/capture/scripts/dev_signin_e2e.py
<kortix-capture binary>`. It signs in through Cloudflare, approves as the owner of a
throwaway account (the Kortix CLI's `dev` host token), connects, uploads a probe object,
checks Kortix lists the computer, and cleans up.

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
